import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import { resetDbForTests } from '../../src/main/services/db';
import { syncVirtualStorage, getStorageDetails } from '../../src/main/services/virtualMirrorService';
import { VirtualStorageConfig, VirtualPhotoMetadata } from '../../src/types';

// Regression coverage for two bugs found against a real library after the
// pipeline redesign shipped:
//
// 1. processOneMirrorFile's "already up to date, skip" fast path used to
//    return no `sidecar` at all, so syncVirtualStorage's face-detection step
//    (gated on `result.sidecar` being present) silently never ran for any
//    file whose thumbnail was already cached — which, after the very first
//    sync of any storage, is every file on every subsequent sync. Thumbnails
//    would show 100% while faces stayed at 0% forever.
//
// 2. The face-detection step wrote photo/face rows via getDb() (whatever
//    library happens to be "active" in the renderer at that moment), while
//    the storage's own status card reads via getDbForLibraryPath(mirrorFolder)
//    — a different database file for virtual storages. Even when detection
//    DID run, its results were invisible to the UI because they landed in
//    the wrong database.
describe('unified sync pipeline: correct database targeting across re-syncs', () => {
  let tempDir: string;
  let networkSourcePath: string;
  let localMirrorRoot: string;
  let storage: VirtualStorageConfig;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gphotos_dbscoping_test_'));
    process.env.GPHOTOS_TEST_DB_DIR = tempDir;
    resetDbForTests();

    networkSourcePath = path.join(tempDir, 'NetworkSource');
    localMirrorRoot = path.join(tempDir, 'Mirrors');
    fs.mkdirSync(networkSourcePath, { recursive: true });
    fs.mkdirSync(localMirrorRoot, { recursive: true });

    for (let i = 0; i < 3; i++) {
      await sharp({
        create: { width: 100, height: 100, channels: 3, background: { r: i * 20, g: 10, b: 10 } },
      })
        .jpeg()
        .toFile(path.join(networkSourcePath, `IMG_${i}.jpg`));
    }

    storage = {
      id: 'storage_dbscope',
      name: 'DbScopeStorage',
      networkSourcePath,
      localMirrorRoot,
    };
  }, 30000);

  afterEach(() => {
    resetDbForTests();
    delete process.env.GPHOTOS_TEST_DB_DIR;
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('runs face detection and reports it in getStorageDetails on the FIRST sync', async () => {
    const result = await syncVirtualStorage(storage);
    expect(result.totalSynced).toBe(3);

    const details = getStorageDetails(storage.name, localMirrorRoot);
    expect(details.totalPhotos).toBe(3);
    // All 3 are faceless synthetic images, so each locks itself immediately
    // (trivially — nothing to confirm) once detection runs on it.
    expect(details.faceScannedCount).toBe(3);
  });

  it('still runs (and correctly reports) face detection on a RE-sync where every thumbnail is already cached', async () => {
    // First pass: thumbnails + faces for all 3 files.
    await syncVirtualStorage(storage);
    const firstPassDetails = getStorageDetails(storage.name, localMirrorRoot);
    expect(firstPassDetails.faceScannedCount).toBe(3);

    // Second pass: every file's thumbnail+sidecar is already up to date, so
    // processOneMirrorFile takes the "skipped" fast path for all of them —
    // this is exactly the bug scenario (a storage that was already fully
    // thumbnailed before, e.g. from an earlier version of the app, or just a
    // routine re-sync/rescan).
    const secondPassResult = await syncVirtualStorage(storage);
    expect(secondPassResult.totalSynced).toBe(3);

    const secondPassDetails = getStorageDetails(storage.name, localMirrorRoot);
    // The critical assertion: face data must still be visible via the same
    // status read the UI uses — not silently stuck at 0 because detection
    // either didn't run (bug 1) or ran against the wrong database (bug 2).
    expect(secondPassDetails.totalPhotos).toBe(3);
    expect(secondPassDetails.faceScannedCount).toBe(3);
  });

  // Bug 3: getStorageDetails()'s live sidecar-count used to exclude ANY
  // sidecar whose filename starts with "_" — meant to skip the two
  // housekeeping files (_sync_checkpoint.json, _mirror_summary.json), but
  // real camera JPEGs commonly use that exact naming convention (Sony/Nikon
  // bodies write "_DSC1234.JPG" for Adobe RGB shots), so any such photo's
  // sidecar silently vanished from the count — found against a real 105-
  // photo library where 81 files used this naming pattern, showing "24/24
  // (100%)" instead of "105/105".
  it('counts underscore-prefixed real photo filenames correctly, excluding only the known housekeeping files', async () => {
    await sharp({ create: { width: 100, height: 100, channels: 3, background: { r: 50, g: 50, b: 50 } } })
      .jpeg()
      .toFile(path.join(networkSourcePath, '_DSC0030.jpg'));

    await syncVirtualStorage(storage);

    const details = getStorageDetails(storage.name, localMirrorRoot);
    // 3 from beforeEach + 1 underscore-prefixed = 4 real photos.
    expect(details.totalPhotos).toBe(4);
    expect(details.thumbnailCachedCount).toBe(4);
  });

  // Regression: found against a real 105-photo library where the background
  // daemon was re-running full face detection on every unlocked photo on
  // every sync cycle — including photos a user had just manually detected
  // faces on seconds earlier — because sourceMtimeMs (needed for
  // detectFacesForPhoto's "file genuinely unchanged, skip re-detection"
  // check) was never present on a sidecar written before that check existed.
  // The thumbnail step's own "already cached, skip" fast path must backfill
  // it using the stat() it already does, so an existing library converges
  // onto the skip within one more sync instead of never.
  it("backfills sourceMtimeMs onto a sidecar written before that field existed, so a later sync's skip check can activate", async () => {
    await syncVirtualStorage(storage);
    const mirrorFolder = path.join(localMirrorRoot, storage.name);
    const sidecarPath = path.join(mirrorFolder, 'IMG_0.json');

    // Simulate a sidecar from before this fix shipped: strip the field.
    const sidecar: VirtualPhotoMetadata = JSON.parse(fs.readFileSync(sidecarPath, 'utf-8'));
    delete (sidecar as any).sourceMtimeMs;
    fs.writeFileSync(sidecarPath, JSON.stringify(sidecar, null, 2), 'utf-8');
    expect(JSON.parse(fs.readFileSync(sidecarPath, 'utf-8')).sourceMtimeMs).toBeUndefined();

    // A re-sync of the same, unchanged source files takes the thumbnail
    // "already cached" skip path — which must backfill the field.
    await syncVirtualStorage(storage);

    const backfilled = JSON.parse(fs.readFileSync(sidecarPath, 'utf-8'));
    expect(typeof backfilled.sourceMtimeMs).toBe('number');
  });

  // Regression: the "already cached, skip" fast path used to compare the
  // LOCAL sidecar file's own mtime against the remote file's mtime — a
  // proxy for "has the source changed", not an actual comparison of the
  // source's current size+mtime against what was persisted the last time it
  // was synced. A source file edited in place with its mtime deliberately
  // preserved (common with some backup/restore and sync tools) has an
  // unchanged mtime but a different size, and the proxy check couldn't tell
  // the two apart — it would skip re-syncing a genuinely changed file.
  it('detects a changed source file via size even when its mtime is unchanged, and re-syncs it', async () => {
    await syncVirtualStorage(storage);
    const mirrorFolder = path.join(localMirrorRoot, storage.name);
    const sourcePath = path.join(networkSourcePath, 'IMG_0.jpg');
    const sidecarPath = path.join(mirrorFolder, 'IMG_0.json');

    const beforeSidecar: VirtualPhotoMetadata = JSON.parse(fs.readFileSync(sidecarPath, 'utf-8'));
    const originalMtime = fs.statSync(sourcePath).mtime;

    // Overwrite with different (larger) content, then force the mtime back
    // to its original value — simulating a same-mtime, different-content
    // edit. Written to a temp path and renamed over the original — sharp
    // can't reliably overwrite a file it doesn't already have open (Windows).
    const tmpPath = `${sourcePath}.tmp`;
    await sharp({ create: { width: 400, height: 400, channels: 3, background: { r: 200, g: 5, b: 5 } } })
      .jpeg()
      .toFile(tmpPath);
    fs.renameSync(tmpPath, sourcePath);
    fs.utimesSync(sourcePath, originalMtime, originalMtime);
    expect(fs.statSync(sourcePath).mtime.getTime()).toBe(originalMtime.getTime());
    expect(fs.statSync(sourcePath).size).not.toBe(beforeSidecar.originalFileSize);

    await syncVirtualStorage(storage);

    const afterSidecar: VirtualPhotoMetadata = JSON.parse(fs.readFileSync(sidecarPath, 'utf-8'));
    expect(afterSidecar.originalFileSize).toBe(fs.statSync(sourcePath).size);
    expect(afterSidecar.originalFileSize).not.toBe(beforeSidecar.originalFileSize);
  });
});
