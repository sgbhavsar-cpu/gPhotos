import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import { thumbnailWorker, isThumbnailCached } from '../../src/main/services/thumbnailWorkerService';
import { getOrGenerateCachedThumbnail } from '../../src/main/services/thumbnailCacheService';
import type { Photo } from '../../src/types';

describe('thumbnail worker cached-photo fast-forward', () => {
  let dir: string;
  const files: string[] = [];

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gphotos_ff_test_'));
    fs.mkdirSync(path.join(dir, 'ckpt'));
    thumbnailWorker.useIsolatedStateForTests(path.join(dir, 'ckpt'));
    files.length = 0;
    // 40 photos > CACHE_PROBE_WINDOW so more than one probe window is exercised.
    for (let i = 0; i < 40; i++) {
      const f = path.join(dir, `p${i}.jpg`);
      await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: i, g: 9, b: 9 } } }).jpeg().toFile(f);
      files.push(f);
    }
  });

  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  const toPhoto = (f: string): Photo => ({ filePath: f, fileName: path.basename(f) } as unknown as Photo);

  async function waitDone(): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < 60000) {
      // enqueuePhotos starts processQueue synchronously, so !isRunning means the queue drained.
      // (Failed photos don't advance `current`, so it can't be part of the condition.)
      if (!thumbnailWorker.getStatus().isRunning) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('worker did not finish');
  }

  it('isThumbnailCached agrees with the real cache layout (drift guard)', async () => {
    expect(await isThumbnailCached(files[0], 250)).toBe(false);
    const res = await getOrGenerateCachedThumbnail(files[0], 250);
    expect(res?.isFromCache).toBe(false);
    expect(await isThumbnailCached(files[0], 250)).toBe(true);
    expect(await isThumbnailCached(path.join(dir, 'missing.jpg'), 250)).toBe(false);
  });

  it('processes a mix of cached and uncached photos, each exactly once', async () => {
    // Pre-cache every third photo.
    for (let i = 0; i < files.length; i += 3) await getOrGenerateCachedThumbnail(files[i], 250);

    thumbnailWorker.setResourceLimits({ concurrency: 1, maxCpuPercent: 100 });
    thumbnailWorker.enqueuePhotos(files.map(toPhoto), dir);
    await waitDone();

    const s = thumbnailWorker.getStatus();
    expect(s.total).toBe(files.length);
    expect(s.current).toBe(files.length);
    expect(s.failed).toBe(0);
    for (const f of files) expect(await isThumbnailCached(f, 250)).toBe(true);
  });

  it('counts a missing source as failed without stalling the rest', async () => {
    const list = [files[0], path.join(dir, 'gone.jpg'), files[1]].map(toPhoto);
    thumbnailWorker.setResourceLimits({ concurrency: 1, maxCpuPercent: 100 });
    thumbnailWorker.enqueuePhotos(list, dir);
    await waitDone();
    expect(thumbnailWorker.getStatus().failed).toBe(1);
    expect(await isThumbnailCached(files[1], 250)).toBe(true);
  });
});
