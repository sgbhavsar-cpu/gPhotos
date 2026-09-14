import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getStorageDetails, saveStorageCheckpoint } from '../../src/main/services/virtualMirrorService';

/**
 * Regression test for a real bug the user hit: a network storage with only
 * 37 real files was shown as "37/128" cached, and another with far fewer
 * real files than reported showed "1835/3671". Root cause: getStorageDetails
 * did a live, accurate scan of the mirror folder, then unconditionally
 * overrode that accurate count upward whenever a persisted checkpoint or
 * library-status record happened to have a larger (stale/inflated) number.
 */
describe('getStorageDetails count accuracy (stale-checkpoint regression)', () => {
  let tempDir: string;
  let mirrorRoot: string;
  const storageName = 'photo1';

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gphotos_storage_details_test_'));
    mirrorRoot = path.join(tempDir, 'mirrors');
    fs.mkdirSync(path.join(mirrorRoot, storageName), { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  function writeSidecar(index: number, opts: { thumbnailExists?: boolean } = {}) {
    const storageDir = path.join(mirrorRoot, storageName);
    const thumbPath = path.join(storageDir, `IMG_${index}.jpg`);
    if (opts.thumbnailExists !== false) {
      fs.writeFileSync(thumbPath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    }
    fs.writeFileSync(
      path.join(storageDir, `IMG_${index}.json`),
      JSON.stringify({
        fileName: `IMG_${index}.jpg`,
        thumbnailPath: thumbPath,
        faceScanCompleted: true,
        faces: [],
      })
    );
  }

  it('reports the real, live sidecar count (37) instead of a larger stale checkpoint total (128)', () => {
    // 37 real photos actually mirrored to disk.
    for (let i = 0; i < 37; i++) writeSidecar(i);

    // A stale checkpoint left over from an earlier bug/state claims 128 total.
    saveStorageCheckpoint({
      storageName,
      networkSourcePath: '\\\\NAS\\photo1',
      localMirrorRoot: mirrorRoot,
      phase: 'completed',
      processedCount: 128,
      totalDiscovered: 128,
      lastProcessedIndex: 127,
      percent: 100,
      timestamp: Date.now(),
      updatedAt: new Date().toISOString(),
    });

    const details = getStorageDetails(storageName, mirrorRoot);
    expect(details.totalPhotos).toBe(37);
    expect(details.thumbnailCachedCount).toBe(37);
  });

  it('falls back to the checkpoint total only when the live scan finds nothing at all (sync in progress)', () => {
    // No sidecars written yet — a sync is presumably still running.
    saveStorageCheckpoint({
      storageName,
      networkSourcePath: '\\\\NAS\\photo1',
      localMirrorRoot: mirrorRoot,
      phase: 'thumbnails',
      processedCount: 5,
      totalDiscovered: 40,
      lastProcessedIndex: 4,
      percent: 12,
      timestamp: Date.now(),
      updatedAt: new Date().toISOString(),
    });

    const details = getStorageDetails(storageName, mirrorRoot);
    expect(details.totalPhotos).toBe(40);
    expect(details.thumbnailCachedCount).toBe(5);
  });

  it('never reports more cached thumbnails than the live scan actually found on disk', () => {
    // 5 sidecars exist, but only 3 have their thumbnail file present.
    for (let i = 0; i < 3; i++) writeSidecar(i);
    for (let i = 3; i < 5; i++) writeSidecar(i, { thumbnailExists: false });

    saveStorageCheckpoint({
      storageName,
      networkSourcePath: '\\\\NAS\\photo1',
      localMirrorRoot: mirrorRoot,
      phase: 'completed',
      processedCount: 999, // stale/bogus
      totalDiscovered: 999,
      lastProcessedIndex: 998,
      percent: 100,
      timestamp: Date.now(),
      updatedAt: new Date().toISOString(),
    });

    const details = getStorageDetails(storageName, mirrorRoot);
    expect(details.totalPhotos).toBe(5);
    expect(details.thumbnailCachedCount).toBe(3);
  });
});
