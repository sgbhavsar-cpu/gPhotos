import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../../src/main/services/videoExportService', () => ({
  probeMedia: vi.fn(async () => ({ durationSec: 7.5, hasAudio: true, hasVideo: true })),
}));

import { isImageFile, isVideoFile, scanPhotoDirectory } from '../../src/main/services/fileOrganizer';

describe('isVideoFile (FEATURE_VIDEO_LIBRARY_SUPPORT.md §2.3)', () => {
  it('recognises every supported video extension, case-insensitively', () => {
    for (const ext of ['.mp4', '.MOV', '.avi', '.Mkv', '.webm', '.wmv', '.m4v']) {
      expect(isVideoFile(`C:\\clips\\x${ext}`)).toBe(true);
    }
  });

  it('does not treat an image extension as a video', () => {
    expect(isVideoFile('C:\\photos\\a.jpg')).toBe(false);
    expect(isImageFile('C:\\photos\\a.jpg')).toBe(true);
  });

  it('does not treat a video extension as an image', () => {
    expect(isImageFile('C:\\clips\\a.mp4')).toBe(false);
  });
});

describe('scanPhotoDirectory: videos are scanned alongside photos', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gphotos-scan-test-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a video gets isVideo:true and a probed duration; a photo gets neither', async () => {
    // A 1x1 PNG (smallest valid real image) so parsePhotoMetadata's decode path doesn't choke.
    const pngBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWPgEpHjEpFjgFAABk4A8YCCZIUAAAAASUVORK5CYII=', 'base64');
    fs.writeFileSync(path.join(dir, 'photo.png'), pngBytes);
    fs.writeFileSync(path.join(dir, 'clip.mp4'), 'not real video bytes, just needs to exist');

    const photos = await scanPhotoDirectory(dir);
    expect(photos).toHaveLength(2);

    const video = photos.find((p) => p.fileName === 'clip.mp4')!;
    const photo = photos.find((p) => p.fileName === 'photo.png')!;

    expect(video.isVideo).toBe(true);
    expect(video.videoDurationSec).toBe(7.5);
    expect(photo.isVideo).toBeUndefined();
    expect(photo.videoDurationSec).toBeUndefined();
  });

  it('a video whose duration probe fails still scans in, just without a duration', async () => {
    const { probeMedia } = await import('../../src/main/services/videoExportService');
    (probeMedia as any).mockRejectedValueOnce(new Error('ffmpeg not found'));
    fs.writeFileSync(path.join(dir, 'broken.mkv'), 'x');

    const photos = await scanPhotoDirectory(dir);
    expect(photos).toHaveLength(1);
    expect(photos[0].isVideo).toBe(true);
    expect(photos[0].videoDurationSec).toBeUndefined();
  });
});
