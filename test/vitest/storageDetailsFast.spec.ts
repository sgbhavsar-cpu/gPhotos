import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  getStorageDetailsFast,
  getAllStorageDetailsFast,
  scanStorageDetailsPhysical,
  confirmAllStorageDetailsPhysical,
  saveStorageCheckpoint,
} from '../../src/main/services/virtualMirrorService';

/**
 * getAllStorageDetails' live sidecar-folder walk (readdir+readFile+JSON.parse
 * per synced photo) measured as a main-process block bad enough to make the
 * Network Mirrors screen's "Loading storage configurations..." step, and its
 * 2-second status poll, both freeze the app — see getStorageDetailsFast's
 * doc comment in virtualMirrorService.ts. These verify the checkpoint-only
 * fast path a poll can safely use, and that the async physical-confirmation
 * scan (meant to run once, in the background) still reaches the same
 * ground truth the old synchronous scan did.
 */
describe('storage details: fast (checkpoint-only) vs physical (live scan) paths', () => {
  let tempDir: string;
  let mirrorRoot: string;
  const storageName = 'photo1';

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gphotos_storage_details_fast_test_'));
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
      JSON.stringify({ fileName: `IMG_${index}.jpg`, thumbnailPath: thumbPath, faceScanCompleted: true, faces: [] })
    );
  }

  it('getStorageDetailsFast trusts the checkpoint directly — no disk walk, so it does NOT notice real sidecars disagreeing with it', () => {
    // 37 real photos on disk...
    for (let i = 0; i < 37; i++) writeSidecar(i);
    // ...but the checkpoint (what the fast path actually reads) says 128.
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

    const details = getStorageDetailsFast(storageName, mirrorRoot);
    expect(details.totalPhotos).toBe(128);
    expect(details.thumbnailCachedCount).toBe(128);
  });

  it('scanStorageDetailsPhysical (async) reaches the same ground truth the old synchronous live scan did', async () => {
    for (let i = 0; i < 37; i++) writeSidecar(i);
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

    const details = await scanStorageDetailsPhysical(storageName, mirrorRoot);
    expect(details.totalPhotos).toBe(37);
    expect(details.thumbnailCachedCount).toBe(37);
  });

  it('getAllStorageDetailsFast and confirmAllStorageDetailsPhysical agree once the checkpoint matches reality', async () => {
    for (let i = 0; i < 10; i++) writeSidecar(i);
    saveStorageCheckpoint({
      storageName,
      networkSourcePath: '\\\\NAS\\photo1',
      localMirrorRoot: mirrorRoot,
      phase: 'completed',
      processedCount: 10,
      totalDiscovered: 10,
      lastProcessedIndex: 9,
      percent: 100,
      timestamp: Date.now(),
      updatedAt: new Date().toISOString(),
    });

    const fast = getAllStorageDetailsFast(mirrorRoot);
    const physical = await confirmAllStorageDetailsPhysical(mirrorRoot);

    expect(fast[storageName].totalPhotos).toBe(10);
    expect(physical[storageName].totalPhotos).toBe(10);
    expect(fast[storageName].thumbnailCachedCount).toBe(physical[storageName].thumbnailCachedCount);
  });

  it('confirmAllStorageDetailsPhysical scans every configured storage, yielding between them', async () => {
    fs.mkdirSync(path.join(mirrorRoot, 'photo2'), { recursive: true });
    for (let i = 0; i < 3; i++) writeSidecar(i);
    const storage2Dir = path.join(mirrorRoot, 'photo2');
    fs.writeFileSync(path.join(storage2Dir, 'A.jpg'), Buffer.from([0xff, 0xd8]));
    fs.writeFileSync(
      path.join(storage2Dir, 'A.json'),
      JSON.stringify({ fileName: 'A.jpg', thumbnailPath: path.join(storage2Dir, 'A.jpg'), faceScanCompleted: true, faces: [] })
    );

    const result = await confirmAllStorageDetailsPhysical(mirrorRoot);
    expect(result[storageName].totalPhotos).toBe(3);
    expect(result['photo2'].totalPhotos).toBe(1);
  });

  it('scanStorageDetailsPhysical counts from directory listings: nested folders, missing thumbnails, housekeeping files, case-insensitive names', async () => {
    const dir = path.join(mirrorRoot, storageName);
    const nested = path.join(dir, '2026', '09');
    fs.mkdirSync(nested, { recursive: true });
    fs.mkdirSync(path.join(dir, '.gphotos_catalog'), { recursive: true });

    writeSidecar(0);                                   // top-level, thumbnail present
    writeSidecar(1, { thumbnailExists: false });       // sidecar but thumbnail missing -> counted as a photo, not as cached
    // nested: one with an upper-case extension thumbnail (Windows names are case-insensitive)
    fs.writeFileSync(path.join(nested, 'A.HEIC'), Buffer.from([1]));
    fs.writeFileSync(path.join(nested, 'A.json'), '{}');
    fs.writeFileSync(path.join(nested, 'B.jpg'), Buffer.from([1]));
    fs.writeFileSync(path.join(nested, 'b.json'), '{}');   // different case than its thumbnail
    fs.writeFileSync(path.join(nested, 'C.json'), '{}');    // no thumbnail
    // housekeeping / hidden things must not count
    fs.writeFileSync(path.join(dir, '_mirror_summary.json'), '{}');
    fs.writeFileSync(path.join(dir, '_sync_checkpoint.json'), '{}');
    fs.writeFileSync(path.join(dir, '.gphotos_status.json'), '{}');
    fs.writeFileSync(path.join(dir, '.gphotos_catalog', 'x.json'), '{}');

    const d = await scanStorageDetailsPhysical(storageName, mirrorRoot);
    expect(d.totalPhotos).toBe(5);            // IMG_0, IMG_1, A, b, C
    expect(d.thumbnailCachedCount).toBe(3);   // IMG_0, A (.HEIC), b (B.jpg)
  });

  it('does not open any sidecar file (that per-file open is what made it take minutes on a real 24K-photo mirror)', async () => {
    for (let i = 0; i < 25; i++) writeSidecar(i);
    const realRead = fs.readFileSync;
    let opened = 0;
    (fs as any).readFileSync = (...args: any[]) => { if (String(args[0]).endsWith('.json') && String(args[0]).includes(storageName)) opened++; return (realRead as any)(...args); };
    try {
      await scanStorageDetailsPhysical(storageName, mirrorRoot);
    } finally {
      (fs as any).readFileSync = realRead;
    }
    expect(opened).toBe(0);
  });
});
