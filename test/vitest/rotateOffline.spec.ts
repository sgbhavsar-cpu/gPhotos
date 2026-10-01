import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import { rotatePhotoWithOfflineQueue, getPendingRotations, processPendingRotations, enqueuePendingRotation, savePendingRotations, onRotationFailure, MAX_ROTATION_ATTEMPTS, type RotationFailureInfo } from '../../src/main/services/virtualMirrorService';
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

  // Regression guard for a reported ~21s main-process freeze on photo:rotate: rotatePhotoFile used
  // to read/copy/write the photo (and its sidecar) with readFileSync/copyFileSync/writeFileSync,
  // which — called from Electron's main process — blocks every other IPC call, menu action and
  // window repaint for however long that I/O takes, not just this one request. A slow/network file
  // can take tens of seconds; nothing else in the app should freeze while it does. Asserting none of
  // the sync fs calls touch the PHOTO'S OWN files (rather than timing anything) catches a regression
  // regardless of how fast the test machine's own disk happens to be. The local pending-rotations
  // queue file is deliberately excluded — it's always a small file under the app's own local
  // userData folder, never a network-mounted photo, so staying sync there was never part of this bug.
  it('never calls a blocking sync fs method on the photo itself while rotating (would freeze the whole app on a slow/network path)', async () => {
    const { local, remote } = await makeMirror('IMG_6.jpg');
    const syncMethods = ['readFileSync', 'writeFileSync', 'copyFileSync', 'statSync', 'existsSync', 'renameSync'] as const;
    const spies = syncMethods.map((m) => vi.spyOn(fs, m));

    const res = await rotatePhotoWithOfflineQueue({ localFilePath: local, originalRemotePath: remote, rotationDegrees: 90 });

    expect(res.success).toBe(true);
    for (const spy of spies) {
      const touchedPhotoPath = spy.mock.calls.some((args) => typeof args[0] === 'string' && (args[0] === local || args[0].startsWith(remote)));
      expect(touchedPhotoPath).toBe(false);
    }
    spies.forEach((s) => s.mockRestore());
  });

  // The follow-up fix: even an ONLINE/reachable original is never rotated inline — the slow part
  // (re-encoding a possibly-large file on a possibly-slow network mount) is always handed to the
  // background queue, so this call returns as soon as the small local thumbnail is done, not after
  // the original too. Rotating the thumbnail first and queuing the rest was the user's own framing
  // of this requirement.
  it('the original is queued for the background even when it is online and reachable right now', async () => {
    const { local, remote } = await makeMirror('IMG_7.jpg');
    fs.mkdirSync(path.dirname(remote), { recursive: true });
    await sharp({ create: { width: 200, height: 100, channels: 3, background: { r: 5, g: 5, b: 5 } } }).jpeg().toFile(remote);

    const res = await rotatePhotoWithOfflineQueue({ localFilePath: local, originalRemotePath: remote, rotationDegrees: 90 });

    // Queued, not rotated inline — this request returns as soon as the small local thumbnail is
    // done, regardless of whether the opportunistic background "kick" (fired but never awaited by
    // rotatePhotoWithOfflineQueue) has gotten around to the original yet or not by the time it does.
    expect(res.success).toBe(true);
    expect(res.isQueued).toBe(true);
    expect(await dims(local)).toBe('100x200'); // the local thumbnail: already rotated, on screen now

    // Whether the fire-and-forget kick already finished it or not, awaiting the (re-entrant-safe)
    // drain explicitly guarantees it's done by here — this is exactly what backgroundDaemon.ts's own
    // periodic 30s tick would eventually do on its own regardless.
    await processPendingRotations();
    expect(await dims(remote)).toBe('100x200');
    expect(getPendingRotations().some((i) => i.originalRemotePath === remote)).toBe(false);
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

  describe('giving up: the local thumbnail is reverted and the user is told why', () => {
    let captured: RotationFailureInfo[];
    let unsubscribe: () => void;
    beforeEach(() => {
      captured = [];
      unsubscribe = onRotationFailure((info) => captured.push(info));
    });
    afterEach(() => unsubscribe());

    it('a reachable original that keeps genuinely failing to rotate is dropped after MAX_ROTATION_ATTEMPTS, reverting the thumbnail', async () => {
      const { local, remote } = await makeMirror('IMG_8.jpg');
      fs.mkdirSync(path.dirname(remote), { recursive: true });
      fs.writeFileSync(remote, 'not a real image'); // reachable, but sharp can never decode this

      // The realistic setup: rotatePhotoWithOfflineQueue's own first step really does rotate the
      // local thumbnail (now 100x200) and enqueue the remote — exactly as a user's rotate click would.
      const initial = await rotatePhotoWithOfflineQueue({ localFilePath: local, originalRemotePath: remote, rotationDegrees: 90 });
      expect(initial.isQueued).toBe(true);
      expect(await dims(local)).toBe('100x200');

      let out: { processed: number; remaining: number } = { processed: 0, remaining: 1 };
      for (let i = 0; i < MAX_ROTATION_ATTEMPTS; i++) {
        out = await processPendingRotations();
      }

      expect(out.remaining).toBe(0); // gave up and dropped it, rather than retrying forever
      expect(captured).toHaveLength(1);
      expect(captured[0].originalRemotePath).toBe(remote);
      expect(captured[0].localFilePath).toBe(local);
      expect(captured[0].rotationDegrees).toBe(90);
      expect(await dims(local)).toBe('200x100'); // reverted back to its original (never-rotated) orientation
    });

    it('does not give up on the very first failure — only after the retry budget is exhausted', async () => {
      const { local, remote } = await makeMirror('IMG_9.jpg');
      fs.mkdirSync(path.dirname(remote), { recursive: true });
      fs.writeFileSync(remote, 'not a real image');
      await rotatePhotoWithOfflineQueue({ localFilePath: local, originalRemotePath: remote, rotationDegrees: 90 });

      await processPendingRotations();

      expect(getPendingRotations().some((i) => i.originalRemotePath === remote)).toBe(true); // still queued
      expect(captured).toHaveLength(0); // not given up on yet
      expect(await dims(local)).toBe('100x200'); // still showing the (not yet reverted) optimistic rotation
    });

    it('an unsupported format discovered only once reachable is also reverted and reported, not just silently dropped', async () => {
      // Simulates a rotation already queued before this fix's RAW_EXTENSIONS fast-path existed (or
      // any other way a RAW original ends up queued) — enqueued directly, with no localFilePath, so
      // the "revert" half is a no-op and only the notification half is exercised here.
      const remote = path.join(offlineRoot, 'Album', 'IMG_10.NEF');
      fs.mkdirSync(path.dirname(remote), { recursive: true });
      await sharp({ create: { width: 64, height: 32, channels: 3, background: { r: 1, g: 1, b: 1 } } }).tiff().toFile(remote);
      enqueuePendingRotation(remote, 90);

      const out = await processPendingRotations();

      expect(out.remaining).toBe(0); // dropped on the very first attempt — unsupported, not a transient failure
      expect(captured).toHaveLength(1);
      expect(captured[0].originalRemotePath).toBe(remote);
      expect(captured[0].reason).toMatch(/camera RAW/i);
    });
  });
});
