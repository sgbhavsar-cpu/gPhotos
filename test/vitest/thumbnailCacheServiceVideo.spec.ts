import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// A real decodable 1x1 PNG, returned as the "extracted video frame" — sharp sniffs actual bytes,
// not the extension, so a PNG buffer decodes fine even though grabVideoFrame's real implementation
// always produces a JPEG. See docs/FEATURE_VIDEO_LIBRARY_SUPPORT.md §2.4.
const FAKE_FRAME_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWPgEpHjEpFjgFAABk4A8YCCZIUAAAAASUVORK5CYII=';

vi.mock('../../src/main/services/videoExportService', () => ({
  grabVideoFrame: vi.fn(async () => Buffer.from(FAKE_FRAME_BASE64, 'base64')),
  probeMedia: vi.fn(async () => ({ durationSec: 10, hasAudio: false, hasVideo: true })),
}));

import { getOrGenerateCachedThumbnail } from '../../src/main/services/thumbnailCacheService';
import { grabVideoFrame, probeMedia } from '../../src/main/services/videoExportService';

describe('getOrGenerateCachedThumbnail on a video source (FEATURE_VIDEO_LIBRARY_SUPPORT.md §2.4)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gphotos-video-thumb-'));
    vi.clearAllMocks();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('extracts a frame via ffmpeg before resizing, and caches a normal JPEG result', async () => {
    const videoPath = path.join(dir, 'clip.mp4');
    fs.writeFileSync(videoPath, 'not real video bytes, just needs to exist for stat()');

    const result = await getOrGenerateCachedThumbnail(videoPath, 250);
    expect(result).not.toBeNull();
    expect(result!.mime).toBe('image/jpeg');
    expect(grabVideoFrame).toHaveBeenCalledTimes(1);
    expect(probeMedia).toHaveBeenCalledTimes(1);
    // Seeks into the clip rather than frame 0 (a lead-in black frame) — see the seek-time comment
    // in thumbnailCacheService.ts.
    expect((grabVideoFrame as any).mock.calls[0][1]).toBeGreaterThan(0);
  });

  it('a video frame that fails to extract yields no thumbnail, not a crash or a misdecoded result', async () => {
    (grabVideoFrame as any).mockResolvedValueOnce(null);
    const videoPath = path.join(dir, 'broken.mp4');
    fs.writeFileSync(videoPath, 'x');

    const result = await getOrGenerateCachedThumbnail(videoPath, 250);
    expect(result).toBeNull();
  });

  it('a second request for the same video is served from disk cache — ffmpeg is not invoked again', async () => {
    const videoPath = path.join(dir, 'clip2.mp4');
    fs.writeFileSync(videoPath, 'source bytes');

    await getOrGenerateCachedThumbnail(videoPath, 250);
    vi.clearAllMocks();

    const second = await getOrGenerateCachedThumbnail(videoPath, 250);
    expect(second).not.toBeNull();
    expect(second!.isFromCache).toBe(true);
    expect(grabVideoFrame).not.toHaveBeenCalled();
  });
});
