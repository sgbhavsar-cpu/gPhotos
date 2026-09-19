import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import { resetDbForTests, getDbForLibraryPath } from '../../src/main/services/db';
import { syncVirtualStorage } from '../../src/main/services/virtualMirrorService';
import { upsertPhoto } from '../../src/main/services/libraryRepository';
import { VirtualStorageConfig } from '../../src/types';

// "Rescan / Refresh" should mirror the source folder's current state
// exactly: new files get added, and files removed from the source since
// the last sync should have their cached thumbnail/sidecar AND their
// catalog row (photo + faces) removed too — previously only the on-disk
// mirror files were cleaned up, leaving a stale, unreachable catalog row
// (and any face/person tags) behind forever.
describe('rescan removes photos deleted from the source, adds new ones', () => {
  let tempDir: string;
  let networkSourcePath: string;
  let localMirrorRoot: string;
  let storage: VirtualStorageConfig;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gphotos_prune_test_'));
    process.env.GPHOTOS_TEST_DB_DIR = tempDir;
    resetDbForTests();

    networkSourcePath = path.join(tempDir, 'NetworkSource');
    localMirrorRoot = path.join(tempDir, 'Mirrors');
    fs.mkdirSync(networkSourcePath, { recursive: true });
    fs.mkdirSync(localMirrorRoot, { recursive: true });

    for (let i = 0; i < 3; i++) {
      await sharp({ create: { width: 100, height: 100, channels: 3, background: { r: i * 30, g: 5, b: 5 } } })
        .jpeg()
        .toFile(path.join(networkSourcePath, `IMG_${i}.jpg`));
    }

    storage = { id: 'storage_prune', name: 'PruneStorage', networkSourcePath, localMirrorRoot };
  }, 30000);

  afterEach(() => {
    resetDbForTests();
    delete process.env.GPHOTOS_TEST_DB_DIR;
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('removes the catalog row and mirror files for a photo deleted from the source, and picks up new ones', async () => {
    await syncVirtualStorage(storage);

    const mirrorFolder = path.join(localMirrorRoot, 'PruneStorage');
    const db = getDbForLibraryPath(mirrorFolder);
    expect((db.prepare('SELECT COUNT(*) as c FROM photos').get() as any).c).toBe(3);

    // Delete one source file, add a new one — simulates the real "some
    // photos removed, some added" scenario between two rescans.
    fs.unlinkSync(path.join(networkSourcePath, 'IMG_1.jpg'));
    await sharp({ create: { width: 100, height: 100, channels: 3, background: { r: 200, g: 5, b: 5 } } })
      .jpeg()
      .toFile(path.join(networkSourcePath, 'IMG_new.jpg'));

    const result = await syncVirtualStorage(storage);

    // 2 originals still there + 1 new = 3 total files synced this pass.
    expect(result.totalSynced).toBe(3);

    const remainingPhotos = db.prepare('SELECT file_name FROM photos').all() as Array<{ file_name: string }>;
    const remainingNames = remainingPhotos.map((p) => p.file_name).sort();
    expect(remainingNames).toEqual(['IMG_0.jpg', 'IMG_2.jpg', 'IMG_new.jpg']);

    // The deleted photo's mirror thumbnail + sidecar must be gone from disk too.
    expect(fs.existsSync(path.join(mirrorFolder, 'IMG_1.jpg'))).toBe(false);
    expect(fs.existsSync(path.join(mirrorFolder, 'IMG_1.json'))).toBe(false);
  });

  it('does NOT delete anything if the source folder is unreachable during a rescan', async () => {
    await syncVirtualStorage(storage);
    const mirrorFolder = path.join(localMirrorRoot, 'PruneStorage');
    const db = getDbForLibraryPath(mirrorFolder);
    expect((db.prepare('SELECT COUNT(*) as c FROM photos').get() as any).c).toBe(3);

    // Point the storage at a source path that doesn't exist — simulating a
    // dropped network drive rather than a genuinely emptied folder.
    const missingConfig: VirtualStorageConfig = {
      ...storage,
      networkSourcePath: path.join(tempDir, 'NeverExistsAnymore'),
    };
    const result = await syncVirtualStorage(missingConfig);

    expect(result.totalSynced).toBe(0);
    // Nothing should have been pruned — the 3 original catalog rows (and
    // their mirror files) must survive an unreachable-source pass untouched.
    expect((db.prepare('SELECT COUNT(*) as c FROM photos').get() as any).c).toBe(3);
    expect(fs.existsSync(path.join(mirrorFolder, 'IMG_1.jpg'))).toBe(true);
  });

  // Reproduces exactly what was found against a real library: a catalog row
  // left over from BEFORE this database-cleanup existed, whose sidecar and
  // thumbnail were already deleted by the (older) file-only cleanup — so
  // there's no file left on disk to walk to and trigger the check that
  // compares sidecars against the current source listing. Comparing every
  // DB row's original_remote_path directly catches this regardless of what
  // survives on disk.
  it('removes a stale catalog row whose sidecar/thumbnail files are already gone from disk', async () => {
    await syncVirtualStorage(storage);
    const mirrorFolder = path.join(localMirrorRoot, 'PruneStorage');
    const db = getDbForLibraryPath(mirrorFolder);

    const staleId = 'stale_orphan_photo';
    upsertPhoto(
      {
        id: staleId,
        filePath: path.join(mirrorFolder, 'LongGoneFile.jpg'), // never actually written to disk
        fileName: 'LongGoneFile.jpg',
        fileSize: 1000,
        fileDate: '',
        dateTaken: '2020-01-01T00:00:00Z',
        year: 2020,
        month: 1,
        day: 1,
        isVirtual: true,
        originalRemotePath: path.join(networkSourcePath, 'LongGoneFile.jpg'), // not in the current source
        storageName: storage.name,
      } as any,
      db
    );
    expect((db.prepare('SELECT COUNT(*) as c FROM photos').get() as any).c).toBe(4);

    await syncVirtualStorage(storage);

    const remaining = db.prepare('SELECT id FROM photos').all() as Array<{ id: string }>;
    expect(remaining.some((r) => r.id === staleId)).toBe(false);
    expect(remaining.length).toBe(3);
  });
});
