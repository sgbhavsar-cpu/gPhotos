// On-demand hover-preview clips for video library items (see
// docs/FEATURE_VIDEO_LIBRARY_SUPPORT.md §2.5) — a short, silent, looping mp4 sampled from ~12
// frames spread across the source video, generated the first time a video tile is actually
// hovered long enough to need one, then cached on disk like a thumbnail. Deliberately NOT a
// background sweep (see the doc's §2.8): the first-ever hover on a given video pays the
// generation cost once; every hover after that (including a restart) is an instant cache hit.
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { app } from 'electron';
import { probeMedia, grabVideoFrame, runFfmpeg } from './videoExportService';

const PREVIEW_FRAME_COUNT = 12;
const PREVIEW_FPS = 2; // 12 frames @ 2fps = a ~6s looping preview
const PREVIEW_WIDTH = 320;
// Skip the first/last 5% of the clip — title cards and fade-to-black make poor preview frames.
const SAMPLE_MARGIN = 0.05;

function getPreviewCacheDir(): string {
  try {
    if (app && typeof app.getPath === 'function') {
      return path.join(app.getPath('userData'), 'cache', 'video_previews');
    }
  } catch {}
  const appData = process.env.APPDATA || path.join(os.homedir(), '.config');
  return path.join(appData, 'gPhotos', 'cache', 'video_previews');
}

/** Same scheme as thumbnailCacheService.getCacheKey, kept independent so the two caches never collide. */
function getPreviewCacheKey(filePath: string, mtimeMs: number): string {
  return crypto.createHash('sha1').update(`preview:${filePath}:${mtimeMs}`).digest('hex');
}

/**
 * N evenly-spaced timestamps across [margin*duration, (1-margin)*duration]. Pure (no I/O) —
 * unit-tested directly in videoPreviewService.spec.ts.
 */
export function pickSampleTimestamps(durationSec: number, count: number, margin = SAMPLE_MARGIN): number[] {
  if (durationSec <= 0 || count <= 0) return [];
  const start = durationSec * margin;
  const end = durationSec * (1 - margin);
  const span = Math.max(0, end - start);
  if (count === 1) return [start + span / 2];
  const step = span / (count - 1);
  return Array.from({ length: count }, (_, i) => start + step * i);
}

async function writeFileAtomic(target: string, data: Buffer): Promise<void> {
  const tmp = `${target}.${process.pid}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.tmp`;
  try {
    await fs.promises.writeFile(tmp, data);
    await fs.promises.rename(tmp, target);
  } catch (err) {
    fs.promises.unlink(tmp).catch(() => {});
    throw err;
  }
}

// Same in-flight de-dup pattern as thumbnailCacheService — two simultaneous hovers on the same
// video (or a double IPC call from a fast re-render) must not spawn two parallel ffmpeg jobs.
const inFlightJobs = new Map<string, Promise<string | null>>();

/**
 * Returns the absolute path to a cached (or freshly generated) hover-preview clip for `sourcePath`,
 * or null if the video couldn't be probed/sampled at all (corrupt file, zero duration, etc.) — a
 * null is treated by the caller as "just keep showing the static thumbnail", never a thrown error.
 */
export async function getOrGenerateVideoPreview(sourcePath: string): Promise<string | null> {
  if (!sourcePath) return null;

  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(sourcePath);
  } catch {
    return null;
  }

  const cacheKey = getPreviewCacheKey(sourcePath, stat.mtimeMs);
  const cacheDir = getPreviewCacheDir();
  const cachedFilePath = path.join(cacheDir, `${cacheKey}.mp4`);

  try {
    const cacheStat = await fs.promises.stat(cachedFilePath);
    if (cacheStat.size > 0) return cachedFilePath;
  } catch {
    // cache miss — generate below
  }

  if (inFlightJobs.has(cacheKey)) return inFlightJobs.get(cacheKey)!;

  const jobPromise = (async () => {
    const tempDir = path.join(cacheDir, `._tmp_${cacheKey}`);
    try {
      const info = await probeMedia(sourcePath);
      if (!info.durationSec || info.durationSec <= 0) return null;

      const timestamps = pickSampleTimestamps(info.durationSec, PREVIEW_FRAME_COUNT);
      await fs.promises.mkdir(tempDir, { recursive: true });

      const framePaths: string[] = [];
      for (let i = 0; i < timestamps.length; i++) {
        const frame = await grabVideoFrame(sourcePath, timestamps[i]);
        if (!frame) continue;
        const framePath = path.join(tempDir, `frame_${String(i).padStart(2, '0')}.jpg`);
        await fs.promises.writeFile(framePath, frame);
        framePaths.push(framePath);
      }
      if (framePaths.length < 2) return null; // too few usable frames to make a meaningful preview

      await fs.promises.mkdir(cacheDir, { recursive: true });
      const outPath = path.join(tempDir, 'preview.mp4');
      const args = [
        '-y', '-framerate', String(PREVIEW_FPS), '-i', path.join(tempDir, 'frame_%02d.jpg'),
        '-vf', `scale=${PREVIEW_WIDTH}:-2`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart', outPath,
      ];
      const result = await runFfmpeg(args, framePaths.length / PREVIEW_FPS);
      if (!result.success || !fs.existsSync(outPath)) return null;

      const buf = await fs.promises.readFile(outPath);
      await writeFileAtomic(cachedFilePath, buf);
      return cachedFilePath;
    } catch (err) {
      console.error(`[VideoPreview] Failed generating preview for ${sourcePath}:`, err);
      return null;
    } finally {
      fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      inFlightJobs.delete(cacheKey);
    }
  })();

  inFlightJobs.set(cacheKey, jobPromise);
  return jobPromise;
}
