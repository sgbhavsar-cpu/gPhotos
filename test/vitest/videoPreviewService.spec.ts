import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// ffmpeg itself is mocked out — these tests exercise the caching/dedup/sampling LOGIC in
// videoPreviewService.ts, not real video encoding (see docs/FEATURE_VIDEO_LIBRARY_SUPPORT.md §2.5).
vi.mock('../../src/main/services/videoExportService', () => ({
  probeMedia: vi.fn(async () => ({ durationSec: 12, hasAudio: false, hasVideo: true })),
  grabVideoFrame: vi.fn(async () => Buffer.from([0xff, 0xd8, 0xff])), // a fake JPEG-ish buffer
  runFfmpeg: vi.fn(async (args: string[]) => {
    // Simulate ffmpeg actually writing the output file the real binary would produce.
    const outPath = args[args.length - 1];
    fs.writeFileSync(outPath, Buffer.from('fake-mp4-bytes'));
    return { success: true };
  }),
}));

import { pickSampleTimestamps, getOrGenerateVideoPreview } from '../../src/main/services/videoPreviewService';
import * as videoExportService from '../../src/main/services/videoExportService';

describe('pickSampleTimestamps (pure)', () => {
  it('returns N increasing timestamps within the middle (1 - 2*margin) of the duration', () => {
    const ts = pickSampleTimestamps(100, 12, 0.05);
    expect(ts).toHaveLength(12);
    expect(ts[0]).toBeCloseTo(5, 5);
    expect(ts[ts.length - 1]).toBeCloseTo(95, 5);
    for (let i = 1; i < ts.length; i++) expect(ts[i]).toBeGreaterThan(ts[i - 1]);
  });

  it('a zero or negative duration yields no timestamps', () => {
    expect(pickSampleTimestamps(0, 12)).toEqual([]);
    expect(pickSampleTimestamps(-5, 12)).toEqual([]);
  });

  it('count=1 returns the midpoint of the sampled span', () => {
    expect(pickSampleTimestamps(100, 1, 0.05)).toEqual([50]);
  });
});

describe('getOrGenerateVideoPreview', () => {
  let dir: string;
  let appDataDir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gphotos-video-src-'));
    appDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gphotos-video-appdata-'));
    process.env.APPDATA = appDataDir;
    vi.clearAllMocks();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(appDataDir, { recursive: true, force: true });
  });

  it('generates a preview on first call, spawning ffmpeg exactly once', async () => {
    const srcPath = path.join(dir, 'clip.mp4');
    fs.writeFileSync(srcPath, 'not a real video, just needs to exist for stat()');

    const result = await getOrGenerateVideoPreview(srcPath);
    expect(result).toBeTruthy();
    expect(fs.existsSync(result!)).toBe(true);
    expect(videoExportService.probeMedia).toHaveBeenCalledTimes(1);
    expect(videoExportService.runFfmpeg).toHaveBeenCalledTimes(1);
  });

  it('a second call for the same (unchanged) video is an instant cache hit — no ffmpeg spawned again', async () => {
    const srcPath = path.join(dir, 'clip.mp4');
    fs.writeFileSync(srcPath, 'source bytes');

    const first = await getOrGenerateVideoPreview(srcPath);
    vi.clearAllMocks();
    const second = await getOrGenerateVideoPreview(srcPath);

    expect(second).toBe(first);
    expect(videoExportService.probeMedia).not.toHaveBeenCalled();
    expect(videoExportService.runFfmpeg).not.toHaveBeenCalled();
  });

  it('two concurrent calls for the same video de-duplicate into one ffmpeg run', async () => {
    const srcPath = path.join(dir, 'clip.mp4');
    fs.writeFileSync(srcPath, 'source bytes');

    const [a, b] = await Promise.all([getOrGenerateVideoPreview(srcPath), getOrGenerateVideoPreview(srcPath)]);
    expect(a).toBe(b);
    expect(videoExportService.runFfmpeg).toHaveBeenCalledTimes(1);
  });

  it('a video that fails to probe (durationSec null) yields no preview, not a thrown error', async () => {
    (videoExportService.probeMedia as any).mockResolvedValueOnce({ durationSec: null, hasAudio: false, hasVideo: false });
    const srcPath = path.join(dir, 'clip.mp4');
    fs.writeFileSync(srcPath, 'source bytes');

    const result = await getOrGenerateVideoPreview(srcPath);
    expect(result).toBeNull();
  });

  it('a non-existent source file yields null rather than throwing', async () => {
    const result = await getOrGenerateVideoPreview(path.join(dir, 'does-not-exist.mp4'));
    expect(result).toBeNull();
  });
});
