import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import { rotatePhotoWithOfflineQueue, getPendingRotations, processPendingRotations, enqueuePendingRotation, savePendingRotations } from '../../src/main/services/virtualMirrorService';
import { getOrGenerateCachedThumbnail } from '../../src/main/services/thumbnailCacheService';
import { resetHeicRotationCacheForTests, getHeicSavedRotation } from '../../src/main/services/heicRotationStore';
import { resetReachabilityCacheForTests } from '../../src/main/services/networkReachabilityCache';

const dims = async (buf: Buffer | string) => {
  const m = await sharp(buf).metadata();
  return `${m.width}x${m.height}`;
};

describe('rotate a photo whose original storage is offline', () => {
  let dir: string;
  let mirror: string;
  let offlineRoot: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gphotos_rotoffline_test_'));
    process.env.GPHOTOS_TEST_CONFIG_DIR = dir;
    mirror = path.join(dir, 'Mirrors', 'Store');
    fs.mkdirSync(mirror, { recursive: true });
    offlineRoot = path.join(dir, 'DisconnectedShare'); // never created -> unreachable
    resetHeicRotationCacheForTests();
    resetReachabilityCacheForTests();
    savePendingRotations([]); // the queue file lives outside the per-test folder
  });
  afterEach(() => {
    delete process.env.GPHOTOS_TEST_CONFIG_DIR;
    resetHeicRotationCacheForTests();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  const makeMirror = async (name: string, remoteName = name) => {
    const local = path.join(mirror, name);
    await sharp({ create: { width: 200, height: 100, channels: 3, background: { r: 200, g: 30, b: 30 } } }).jpeg().toFile(local);
    const remote = path.join(offlineRoot, 'Album', remoteName);
    fs.writeFileSync(local.replace(/\.[^/.]+$/, '.json'), JSON.stringify({ fileName: name, originalFilePath: remote, width: 200, height: 100 }));
    return { local, remote };
  };

  // The local (mirror) thumbnail is what is shown while the storage is offline: rotated once, in the file AND in
  // what the grid/lightbox are served, and the original's rotation is queued for when the storage is back.
  it('IMG_1.jpg: local thumbnail rotated, cached tiers show it once, original queued', async () => {
    const { local, remote } = await makeMirror('IMG_1.jpg');
    const warm = (await getOrGenerateCachedThumbnail(local, 250))!;
    expect(await dims(warm.buffer || fs.readFileSync(warm.filePath!))).toBe('200x100');

    const res = await rotatePhotoWithOfflineQueue({ localFilePath: local, originalRemotePath: remote, rotationDegrees: 90 });
    expect(res.success).toBe(true);
    expect(res.isQueued).toBe(true);

    expect(await dims(local)).toBe('100x200');
    const t = (await getOrGenerateCachedThumbnail(local, 250))!;
    expect(await dims(t.buffer || fs.readFileSync(t.filePath!))).toBe('100x200');
    expect(getPendingRotations().some((i) => i.originalRemotePath === remote && i.rotationDegrees === 90)).toBe(true);
  });

  // A HEIC master cannot be re-encoded here, so its rotation is stored as a flag on the remote path (applied whenever
  // thumbnails are made from it) instead of being queued; queuing it as well would rotate it twice once it drains.
  it('IMG_2.HEIC: local thumbnail rotated once, rotation remembered for the original, nothing queued', async () => {
    const { local, remote } = await makeMirror('IMG_2.HEIC');
    const res = await rotatePhotoWithOfflineQueue({ localFilePath: local, originalRemotePath: remote, rotationDegrees: 90 });
    expect(res.success).toBe(true);
    expect(await dims(local)).toBe('100x200');
    const t = (await getOrGenerateCachedThumbnail(local, 250))!;
    expect(await dims(t.buffer || fs.readFileSync(t.filePath!))).toBe('100x200'); // not rotated a second time
    expect(getHeicSavedRotation(remote)).toBe(90);
    expect(getPendingRotations().some((i) => i.originalRemotePath === remote)).toBe(false);
  });

  // Rewriting a camera RAW master with sharp would destroy it: only the local thumbnail may change.
  it('a RAW original (online) is left byte-for-byte alone, the local thumbnail is rotated, nothing is queued', async () => {
    const { local, remote } = await makeMirror('IMG_4.NEF');
    fs.mkdirSync(path.dirname(remote), { recursive: true });
    await sharp({ create: { width: 200, height: 100, channels: 3, background: { r: 1, g: 2, b: 3 } } }).tiff().toFile(remote); // TIFF container named .NEF
    const before = fs.readFileSync(remote);

    const res = await rotatePhotoWithOfflineQueue({ localFilePath: local, originalRemotePath: remote, rotationDegrees: 90 });

    expect(res.success).toBe(true);
    expect(res.isQueued).toBe(false);
    expect(res.message).toMatch(/camera RAW/i);
    expect(Buffer.compare(fs.readFileSync(remote), before)).toBe(0);
    expect(fs.existsSync(remote + '.bak')).toBe(false);
    expect(await dims(local)).toBe('100x200');
    expect(getPendingRotations()).toHaveLength(0);
  });

  it('a queued rotation for a RAW original is dropped when the storage returns instead of retrying forever', async () => {
    const remote = path.join(offlineRoot, 'Album', 'IMG_5.DNG');
    fs.mkdirSync(path.dirname(remote), { recursive: true });
    await sharp({ create: { width: 64, height: 32, channels: 3, background: { r: 9, g: 9, b: 9 } } }).tiff().toFile(remote);
    const before = fs.readFileSync(remote);
    enqueuePendingRotation(remote, 90);
    expect(getPendingRotations()).toHaveLength(1);

    const out = await processPendingRotations();

    expect(out.processed).toBe(0);
    expect(getPendingRotations()).toHaveLength(0);
    expect(Buffer.compare(fs.readFileSync(remote), before)).toBe(0);
  });

  it('two successive 90° rotations end at 180° (no compounding or loss)', async () => {
    const { local, remote } = await makeMirror('IMG_3.jpg');
    await rotatePhotoWithOfflineQueue({ localFilePath: local, originalRemotePath: remote, rotationDegrees: 90 });
    await rotatePhotoWithOfflineQueue({ localFilePath: local, originalRemotePath: remote, rotationDegrees: 90 });
    expect(await dims(local)).toBe('200x100');
    const q = getPendingRotations().filter((i) => i.originalRemotePath === remote);
    expect(q).toHaveLength(1);
    expect(q[0].rotationDegrees).toBe(180);
  });
});
