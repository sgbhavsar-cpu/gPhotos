import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { app } from 'electron';
import {
  getHeicHighQualityJpegBuffer,
  getOrGenerateHeicThumbnail500,
  purgeHeicCache,
  rotateHeic500Thumbnail,
} from './heicService';
import { getHeicSavedRotation, saveHeicSavedRotation } from './heicRotationStore';
import { isPathReachable } from './networkReachabilityCache';

let sharp: any = null;
try {
  sharp = require('sharp');
} catch (err) {
  console.warn('[ThumbnailCache] Sharp library not available, using nativeImage fallback.');
}

let nativeImage: any = null;
try {
  const electron = require('electron');
  nativeImage = electron.nativeImage;
} catch {}

function getGlobalCacheDir(): string {
  try {
    if (app && typeof app.getPath === 'function') {
      return path.join(app.getPath('userData'), 'cache', 'thumbnails');
    }
  } catch {}

  const appData =
    process.env.APPDATA ||
    (process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library/Application Support')
      : path.join(os.homedir(), '.config'));

  return path.join(appData, 'gPhotos', 'cache', 'thumbnails');
}

export function getCacheKey(filePath: string, mtimeMs: number, size: number): string {
  return crypto.createHash('sha1').update(`${filePath}:${mtimeMs}:${size}`).digest('hex');
}

export interface ThumbnailResult {
  filePath?: string;
  buffer?: Buffer;
  mime: string;
  etag: string;
  isFromCache: boolean;
}

// 1. In-flight request deduplication map to prevent redundant concurrent processing
const inFlightJobs = new Map<string, Promise<ThumbnailResult | null>>();

// 2. Concurrency limiter (Semaphore) to prevent starving CPU & Node.js event loop
const MAX_CONCURRENT_RESIZES = 4;
let activeResizes = 0;
const resizeQueue: (() => void)[] = [];

function acquireResizeSlot(): Promise<void> {
  if (activeResizes < MAX_CONCURRENT_RESIZES) {
    activeResizes++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    resizeQueue.push(() => {
      activeResizes++;
      resolve();
    });
  });
}

function releaseResizeSlot(): void {
  activeResizes--;
  if (resizeQueue.length > 0 && activeResizes < MAX_CONCURRENT_RESIZES) {
    const next = resizeQueue.shift();
    if (next) next();
  }
}

/**
 * Retrieves a multi-tier cached thumbnail (250px, 500px, 1600px).
 * 100% Asynchronous & non-blocking disk operations with concurrency throttling.
 */
export async function getOrGenerateCachedThumbnail(
  sourcePath: string,
  targetSize: number = 250
): Promise<ThumbnailResult | null> {
  if (!sourcePath) return null;

  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(sourcePath);
  } catch {
    return null;
  }

  const cacheKey = getCacheKey(sourcePath, stat.mtimeMs, targetSize);
  const cacheDir = path.join(getGlobalCacheDir(), `${targetSize}`);
  const cachedFilePath = path.join(cacheDir, `${cacheKey}.jpg`);

  // Fast-path: Check disk cache asynchronously without waiting in concurrency queue!
  try {
    const cacheStat = await fs.promises.stat(cachedFilePath);
    const etag = `"${cacheStat.mtimeMs.toString(36)}-${cacheStat.size.toString(36)}"`;
    return {
      filePath: cachedFilePath,
      mime: 'image/jpeg',
      etag,
      isFromCache: true,
    };
  } catch {
    // Cache miss, proceed to generate
  }

  // Deduplicate in-flight generation for the same image & size
  const jobKey = `${cacheKey}:${targetSize}`;
  if (inFlightJobs.has(jobKey)) {
    return inFlightJobs.get(jobKey)!;
  }

  const jobPromise = (async () => {
    // Acquire concurrency slot for CPU-bound image resize
    await acquireResizeSlot();

    try {
      // Re-check cache in case another worker just finished it
      try {
        const cacheStat = await fs.promises.stat(cachedFilePath);
        const etag = `"${cacheStat.mtimeMs.toString(36)}-${cacheStat.size.toString(36)}"`;
        return {
          filePath: cachedFilePath,
          mime: 'image/jpeg',
          etag,
          isFromCache: true,
        };
      } catch {}

      await fs.promises.mkdir(cacheDir, { recursive: true });

      let thumbBuffer: Buffer | null = null;
      const ext = path.extname(sourcePath).toLowerCase();
      const isHeic = ext === '.heic' || ext === '.heif';

      // A. For HEIC images
      if (isHeic) {
        const extraRot = getHeicSavedRotation(sourcePath);
        if (sharp) {
          try {
            let sharpPipeline = sharp(sourcePath).rotate();
            if (extraRot !== 0) {
              sharpPipeline = sharpPipeline.rotate(extraRot);
            }
            thumbBuffer = await sharpPipeline
              .resize(targetSize, targetSize, { fit: 'inside', withoutEnlargement: true })
              .jpeg({ quality: targetSize > 500 ? 86 : 82 })
              .toBuffer();
          } catch {}
        }
        if (!thumbBuffer) {
          thumbBuffer = targetSize > 500
            ? await getHeicHighQualityJpegBuffer(sourcePath)
            : await getOrGenerateHeicThumbnail500(sourcePath);
        }
      }

      // B. High-speed Sharp processing (SIMD C++ libvips)
      if (!thumbBuffer && sharp) {
        try {
          thumbBuffer = await sharp(sourcePath)
            .rotate()
            .resize(targetSize, targetSize, { fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: targetSize > 500 ? 86 : 82, mozjpeg: true })
            .toBuffer();
        } catch (sharpErr) {
          // Continue to nativeImage fallback
        }
      }

      // C. NativeImage fallback
      if (!thumbBuffer && nativeImage) {
        try {
          const img = nativeImage.createFromPath(sourcePath);
          if (!img.isEmpty()) {
            const currentSize = img.getSize();
            const maxDimension = Math.max(currentSize.width, currentSize.height);
            const scale = maxDimension > targetSize ? targetSize / maxDimension : 1;
            const targetW = Math.max(1, Math.round(currentSize.width * scale));
            const targetH = Math.max(1, Math.round(currentSize.height * scale));

            const resized = img.resize({
              width: targetW,
              height: targetH,
              quality: 'good',
            });
            thumbBuffer = resized.toJPEG(targetSize > 500 ? 86 : 82);
          }
        } catch {}
      }

      // D. Small image fallback
      if (!thumbBuffer) {
        if (stat.size <= 200_000) {
          thumbBuffer = await fs.promises.readFile(sourcePath);
        } else {
          return null;
        }
      }

      // Asynchronously persist to disk cache
      await fs.promises.writeFile(cachedFilePath, thumbBuffer);
      const etag = `"${stat.mtimeMs.toString(36)}-${thumbBuffer.length.toString(36)}"`;

      return {
        filePath: cachedFilePath,
        buffer: thumbBuffer,
        mime: 'image/jpeg',
        etag,
        isFromCache: false,
      };
    } catch (err) {
      console.error(`[ThumbnailCache] Failed generating thumbnail for ${sourcePath}:`, err);
      return null;
    } finally {
      releaseResizeSlot();
      inFlightJobs.delete(jobKey);
    }
  })();

  inFlightJobs.set(jobKey, jobPromise);
  return jobPromise;
}

/**
 * Clears the thumbnail cache directory to reclaim disk space.
 */
export async function clearThumbnailCache(): Promise<{ freedBytes: number; fileCount: number }> {
  const root = getGlobalCacheDir();
  let freedBytes = 0;
  let fileCount = 0;

  async function prune(dir: string) {
    try {
      await fs.promises.access(dir);
    } catch {
      return;
    }
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await prune(full);
        try { await fs.promises.rmdir(full); } catch {}
      } else if (entry.isFile()) {
        try {
          const sz = (await fs.promises.stat(full)).size;
          await fs.promises.unlink(full);
          freedBytes += sz;
          fileCount++;
        } catch {}
      }
    }
  }

  await prune(root);
  return { freedBytes, fileCount };
}

/**
 * Purges cached thumbnails for a specific file across all standard size buckets.
 */
export async function purgeCachedThumbnailsForFile(filePath: string, previousMtimeMs?: number): Promise<void> {
  if (!filePath) return;

  const isHeic = /\.(heic|heif)$/i.test(filePath);
  if (isHeic) {
    purgeHeicCache(filePath);
  }

  const root = getGlobalCacheDir();
  const knownSizes = [150, 200, 250, 300, 500, 1600];

  let currentMtimeMs: number | null = null;
  try {
    currentMtimeMs = (await fs.promises.stat(filePath)).mtimeMs;
  } catch {}

  const mtimesToPurge: number[] = [];
  if (previousMtimeMs !== undefined && previousMtimeMs !== null) {
    mtimesToPurge.push(previousMtimeMs);
  }
  if (currentMtimeMs !== null && !mtimesToPurge.includes(currentMtimeMs)) {
    mtimesToPurge.push(currentMtimeMs);
  }

  for (const mtime of mtimesToPurge) {
    for (const size of knownSizes) {
      const key = getCacheKey(filePath, mtime, size);
      const targetFile = path.join(root, `${size}`, `${key}.jpg`);
      try {
        await fs.promises.unlink(targetFile);
      } catch {}
    }
  }
}

/**
 * Purges thumbnail caches and re-generates fresh thumbnails directly from source files
 * for multiple selected images.
 */
export async function refreshThumbnailsFromSource(
  items: { filePath: string; originalRemotePath?: string }[]
): Promise<{ refreshedCount: number; errors: string[] }> {
  let refreshedCount = 0;
  const errors: string[] = [];

  for (const item of items) {
    try {
      const source = (item.originalRemotePath && (await isPathReachable(item.originalRemotePath)))
        ? item.originalRemotePath
        : item.filePath;

      if (!source || !(await isPathReachable(source))) {
        errors.push(`Source file not found for ${item.filePath}`);
        continue;
      }

      // 1. Purge old caches for both paths
      await purgeCachedThumbnailsForFile(item.filePath);
      if (item.originalRemotePath && item.originalRemotePath !== item.filePath) {
        await purgeCachedThumbnailsForFile(item.originalRemotePath);
      }

      // 2. If it's a virtual mirror thumbnail, re-generate mirror thumbnail file from source
      if (item.originalRemotePath && item.originalRemotePath !== item.filePath && fs.existsSync(path.dirname(item.filePath))) {
        const isHeic = /\.(heic|heif)$/i.test(source);
        let freshMirrorBuf: Buffer | null = null;
        if (isHeic) {
          freshMirrorBuf = await getOrGenerateHeicThumbnail500(source);
        } else {
          try {
            const { generateThumbnailBuffer } = require('./virtualMirrorService');
            freshMirrorBuf = await generateThumbnailBuffer(source, 500);
          } catch {}
        }
        if (freshMirrorBuf) {
          fs.writeFileSync(item.filePath, freshMirrorBuf);
        }
      }

      // 3. Pre-generate fresh 250px and 500px cached thumbnails from source
      await getOrGenerateCachedThumbnail(source, 250);
      await getOrGenerateCachedThumbnail(source, 500);

      refreshedCount++;
    } catch (err: any) {
      errors.push(`Failed refreshing ${item.filePath}: ${err.message}`);
    }
  }

  return { refreshedCount, errors };
}

/**
 * Rotates all existing cached thumbnails on disk for a HEIC image,
 * updates the persistent HEIC rotation store, and ensures fresh rotated thumbnails are saved.
 * Returns the resulting total rotation degrees (0, 90, 180, 270).
 */
export async function rotateCachedHeicThumbnail(
  sourcePath: string,
  degrees: number,
  secondaryPath?: string
): Promise<number> {
  if (!sourcePath) return 0;

  // Determine all paths that represent this image (e.g. local mirror thumbnail + original remote path)
  const pathsToRotate = new Set<string>();
  pathsToRotate.add(sourcePath);
  if (secondaryPath) pathsToRotate.add(secondaryPath);

  // Check if sourcePath has sidecar metadata specifying originalFilePath
  try {
    const sidecarPath = sourcePath.replace(/\.[^/.]+$/, '.json');
    if (fs.existsSync(sidecarPath)) {
      const meta = JSON.parse(fs.readFileSync(sidecarPath, 'utf-8'));
      if (meta.originalFilePath) {
        pathsToRotate.add(meta.originalFilePath);
      }
    }
  } catch {}

  let totalRotation = 0;
  const root = getGlobalCacheDir();
  const knownSizes = [150, 200, 250, 300, 500, 1600];

  for (const target of pathsToRotate) {
    // 1. Record delta rotation in persistent store
    totalRotation = saveHeicSavedRotation(target, degrees);

    // 2. Rotate all existing cached thumbnail files in cache/thumbnails/{size}/{cacheKey}.jpg
    let stat: fs.Stats | null = null;
    try {
      stat = await fs.promises.stat(target);
    } catch {}

    if (stat) {
      for (const size of knownSizes) {
        const cacheKey = getCacheKey(target, stat.mtimeMs, size);
        const cachedFilePath = path.join(root, `${size}`, `${cacheKey}.jpg`);

        if (fs.existsSync(cachedFilePath)) {
          try {
            if (sharp) {
              const buf = await fs.promises.readFile(cachedFilePath);
              const rotated = await sharp(buf)
                .rotate(degrees)
                .jpeg({ quality: size > 500 ? 86 : 82, mozjpeg: true })
                .toBuffer();
              await fs.promises.writeFile(cachedFilePath, rotated);
            }
          } catch (err) {
            console.warn(`[ThumbnailCache] Failed to rotate existing cached thumbnail ${cachedFilePath}:`, err);
          }
        }
      }
    }

    // 3. Rotate 500px thumbnail in heicService
    try {
      await rotateHeic500Thumbnail(target, degrees);
    } catch (err) {
      console.warn('[ThumbnailCache] Failed to rotate heicService thumbnail:', err);
    }

    // 4. Pre-generate and cache 250px and 500px thumbnails immediately so they exist rotated
    try {
      await getOrGenerateCachedThumbnail(target, 250);
      await getOrGenerateCachedThumbnail(target, 500);
    } catch {}
  }

  return totalRotation;
}

