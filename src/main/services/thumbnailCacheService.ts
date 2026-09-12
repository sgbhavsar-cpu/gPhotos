import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { app } from 'electron';
import { getHeicHighQualityJpegBuffer, getOrGenerateHeicThumbnail500 } from './heicService';

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
  const hash = crypto.createHash('sha1').update(`${filePath}:${mtimeMs}:${size}`).digest('hex');
  return hash;
}

export interface ThumbnailResult {
  filePath?: string;
  buffer?: Buffer;
  mime: string;
  etag: string;
  isFromCache: boolean;
}

/**
 * Retrieves a multi-tier cached thumbnail (250px, 500px, 1600px).
 * Generates and stores in disk cache if missing.
 */
export async function getOrGenerateCachedThumbnail(
  sourcePath: string,
  targetSize: number = 250
): Promise<ThumbnailResult | null> {
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    return null;
  }

  const stat = fs.statSync(sourcePath);
  const cacheKey = getCacheKey(sourcePath, stat.mtimeMs, targetSize);
  const cacheDir = path.join(getGlobalCacheDir(), `${targetSize}`);
  const cachedFilePath = path.join(cacheDir, `${cacheKey}.jpg`);

  // 1. Instant Cache Hit
  if (fs.existsSync(cachedFilePath)) {
    try {
      const cacheStat = fs.statSync(cachedFilePath);
      const etag = `"${cacheStat.mtimeMs.toString(36)}-${cacheStat.size.toString(36)}"`;
      return {
        filePath: cachedFilePath,
        mime: 'image/jpeg',
        etag,
        isFromCache: true,
      };
    } catch {}
  }

  // 2. Cache Miss: Generate thumbnail
  try {
    fs.mkdirSync(cacheDir, { recursive: true });

    let thumbBuffer: Buffer | null = null;
    const ext = path.extname(sourcePath).toLowerCase();
    const isHeic = ext === '.heic' || ext === '.heif';

    // A. For HEIC images, use libheif / sharp
    if (isHeic) {
      if (sharp) {
        try {
          thumbBuffer = await sharp(sourcePath)
            .rotate()
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

    // B. High-speed Sharp processing for standard images (JPEG, PNG, WebP, GIF, TIFF, BMP)
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

    // D. If small image file, copy raw
    if (!thumbBuffer) {
      if (stat.size <= 200_000) {
        thumbBuffer = fs.readFileSync(sourcePath);
      } else {
        return null;
      }
    }

    // Persist to disk cache
    fs.writeFileSync(cachedFilePath, thumbBuffer);
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
  }
}

/**
 * Clears the thumbnail cache directory to reclaim disk space.
 */
export function clearThumbnailCache(): { freedBytes: number; fileCount: number } {
  const root = getGlobalCacheDir();
  let freedBytes = 0;
  let fileCount = 0;

  function prune(dir: string) {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        prune(full);
        try { fs.rmdirSync(full); } catch {}
      } else if (entry.isFile()) {
        try {
          const sz = fs.statSync(full).size;
          fs.unlinkSync(full);
          freedBytes += sz;
          fileCount++;
        } catch {}
      }
    }
  }

  prune(root);
  return { freedBytes, fileCount };
}
