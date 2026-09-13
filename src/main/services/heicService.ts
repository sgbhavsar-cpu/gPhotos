import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import exifr from 'exifr';
import sharp from 'sharp';

// In Electron, app.getPath('userData') is used. In Node scripts/fallback, use APPDATA or HOME.
function getUserDataDir(): string {
  try {
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') {
      return app.getPath('userData');
    }
  } catch {}

  const base =
    process.env.APPDATA ||
    (process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library/Application Support')
      : path.join(os.homedir(), '.config'));

  return path.join(base, 'gphotos-desktop');
}

export function getThumbnailsDir(): string {
  const dir = path.join(getUserDataDir(), 'thumbnails');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function getTempHqDir(): string {
  const dir = path.join(getUserDataDir(), 'temp_hq');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

// In-memory LRU cache for 500px and HQ image buffers
const memoryCache = new Map<string, Buffer>();
const MAX_CACHE_ITEMS = 60;

function setMemoryCache(key: string, buffer: Buffer) {
  if (memoryCache.size >= MAX_CACHE_ITEMS) {
    const firstKey = memoryCache.keys().next().value;
    if (firstKey) memoryCache.delete(firstKey);
  }
  memoryCache.set(key, buffer);
}

let heicConvert: any = null;
try {
  heicConvert = require('heic-convert');
} catch (e) {
  console.warn('heic-convert module could not be loaded:', e);
}

/**
 * Computes a deterministic cache key for a file based on path and modification timestamp.
 */
function getFileCacheHash(filePath: string): string {
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(filePath).mtimeMs;
  } catch {}
  return crypto.createHash('md5').update(`${filePath}:${mtimeMs}`).digest('hex');
}

/**
 * Extracts raw JPEG bytes from HEIC:
 *  1. Fast path: embedded high-res EXIF thumbnail (<5ms)
 *  2. Fallback: full bitstream decode via heic-convert (libheif WASM)
 */
async function extractRawHeicJpeg(fileBuffer: Buffer, filePath: string): Promise<{ buffer: Buffer; fromThumbnail: boolean } | null> {
  // 1. Fast path: embedded EXIF thumbnail
  try {
    const thumbBuffer = await exifr.thumbnail(fileBuffer);
    if (thumbBuffer && thumbBuffer.length > 0) {
      return { buffer: Buffer.from(thumbBuffer), fromThumbnail: true };
    }
  } catch {}

  // 2. Native Sharp decode (fast path for formats handled directly by libvips)
  try {
    const sharpJpeg = await sharp(fileBuffer).jpeg({ quality: 90 }).toBuffer();
    if (sharpJpeg && sharpJpeg.length > 0) {
      return { buffer: sharpJpeg, fromThumbnail: false };
    }
  } catch {}

  // 3. Fallback: full decode via heic-convert
  if (heicConvert) {
    try {
      const converted = await heicConvert({
        buffer: fileBuffer,
        format: 'JPEG',
        quality: 0.90,
      });
      return { buffer: Buffer.from(converted), fromThumbnail: false };
    } catch (convErr) {
      console.error(`heic-convert failed to decode ${filePath}:`, convErr);
    }
  }

  // Automatic self-healing: if file was corrupted and a .bak backup exists, restore it!
  const bakPath = `${filePath}.bak`;
  if (fs.existsSync(bakPath)) {
    try {
      const bakBuf = fs.readFileSync(bakPath);
      // Fast check if backup is valid
      const thumbBuffer = await exifr.thumbnail(bakBuf).catch(() => null);
      if (thumbBuffer && thumbBuffer.length > 0) {
        fs.copyFileSync(bakPath, filePath);
        console.log(`[heicService] Self-healed corrupted HEIC from backup: ${filePath}`);
        return { buffer: Buffer.from(thumbBuffer), fromThumbnail: true };
      }
    } catch {}
  }

  return null;
}

/**
 * Detects the EXIF rotation in degrees for an image buffer using exifr.
 */
async function detectExifRotation(fileBuffer: Buffer): Promise<number> {
  try {
    const rot = await exifr.rotation(fileBuffer);
    if (rot && typeof rot.deg === 'number') {
      return rot.deg;
    }
  } catch {}
  return 0;
}

/**
 * Retrieves or generates a 500px JPEG thumbnail saved in the local thumbnails folder.
 * Guaranteed to be auto-oriented (NOT rotated) and fast to serve.
 */
export async function getOrGenerateHeicThumbnail500(filePath: string): Promise<Buffer | null> {
  if (!fs.existsSync(filePath)) return null;

  try {
    const hash = getFileCacheHash(filePath);
    const thumbFileName = `${hash}_500.jpg`;
    const thumbPath = path.join(getThumbnailsDir(), thumbFileName);

    // 1. Memory cache hit
    const memKey = `thumb500:${hash}`;
    if (memoryCache.has(memKey)) {
      return memoryCache.get(memKey)!;
    }

    // 2. Local disk cache hit
    if (fs.existsSync(thumbPath)) {
      try {
        const diskBuf = fs.readFileSync(thumbPath);
        if (diskBuf && diskBuf.length > 0) {
          setMemoryCache(memKey, diskBuf);
          return diskBuf;
        }
      } catch (readErr) {
        console.warn(`Failed to read cached thumbnail ${thumbPath}, regenerating:`, readErr);
      }
    }

    // 3. Generate from HEIC source
    const fileBuffer = fs.readFileSync(filePath);
    const rotationDeg = await detectExifRotation(fileBuffer);
    const extracted = await extractRawHeicJpeg(fileBuffer, filePath);
    if (!extracted || !extracted.buffer) return null;

    // Use Sharp to rotate to upright orientation and resize to 500px
    let sharpPipeline = sharp(extracted.buffer);
    if (rotationDeg !== 0) {
      sharpPipeline = sharpPipeline.rotate(rotationDeg);
    } else {
      sharpPipeline = sharpPipeline.rotate(); // Auto-orient via EXIF
    }

    const thumbBuffer = await sharpPipeline
      .resize(500, 500, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer();

    // Persist to local disk folder
    try {
      fs.writeFileSync(thumbPath, thumbBuffer);
    } catch (writeErr) {
      console.warn(`Failed to write thumbnail to disk at ${thumbPath}:`, writeErr);
    }

    setMemoryCache(memKey, thumbBuffer);
    return thumbBuffer;
  } catch (err) {
    console.error(`Error generating 500px thumbnail for ${filePath}:`, err);
    return null;
  }
}

/**
 * Retrieves a high-quality JPEG Buffer for fullscreen photo view (PhotoLightbox) or inspection.
 * Auto-oriented so it is never sideways.
 */
export async function getHeicHighQualityJpegBuffer(filePath: string): Promise<Buffer | null> {
  if (!fs.existsSync(filePath)) return null;

  try {
    const hash = getFileCacheHash(filePath);
    const memKey = `hq:${hash}`;
    if (memoryCache.has(memKey)) {
      return memoryCache.get(memKey)!;
    }

    const fileBuffer = fs.readFileSync(filePath);
    const rotationDeg = await detectExifRotation(fileBuffer);
    const extracted = await extractRawHeicJpeg(fileBuffer, filePath);
    if (!extracted || !extracted.buffer) return null;

    let sharpPipeline = sharp(extracted.buffer);
    if (rotationDeg !== 0) {
      sharpPipeline = sharpPipeline.rotate(rotationDeg);
    } else {
      sharpPipeline = sharpPipeline.rotate();
    }

    const hqBuffer = await sharpPipeline
      .jpeg({ quality: 92, mozjpeg: true })
      .toBuffer();

    setMemoryCache(memKey, hqBuffer);
    return hqBuffer;
  } catch (err) {
    console.error(`Error getting high-quality JPEG for ${filePath}:`, err);
    return null;
  }
}

/**
 * Prepares a high-quality temporary image on disk for AI Face Detection.
 * Extracts the HQ image, rotates it upright, saves to temp_hq/hq_<photoId>.jpg,
 * and also generates the persistent 500px thumbnail in the background.
 */
export async function prepareHeicHqTemp(filePath: string, photoId: string): Promise<string | null> {
  if (!fs.existsSync(filePath)) return null;

  try {
    // Also ensure the 500px thumbnail is generated for subsequent gallery display
    getOrGenerateHeicThumbnail500(filePath).catch(() => {});

    const hqBuffer = await getHeicHighQualityJpegBuffer(filePath);
    if (!hqBuffer) return null;

    const safePhotoId = photoId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const tempPath = path.join(getTempHqDir(), `hq_${safePhotoId}.jpg`);
    fs.writeFileSync(tempPath, hqBuffer);
    return tempPath;
  } catch (err) {
    console.error(`Failed to prepare HQ temp image for face detection (${filePath}):`, err);
    return null;
  }
}

/**
 * Cleans up / deletes the temporary HQ image file after face detection completes.
 * Keeps the 500px thumbnail in the thumbnails folder.
 */
export function cleanupHeicHqTemp(photoId: string): void {
  try {
    const safePhotoId = photoId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const tempPath = path.join(getTempHqDir(), `hq_${safePhotoId}.jpg`);
    if (fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
    }
  } catch (err) {
    console.warn(`Failed to cleanup HQ temp image for photo ${photoId}:`, err);
  }
}

/**
 * Purges cached thumbnails and memory entries for a specific HEIC file,
 * forcing a fresh regeneration from the source file.
 */
export function purgeHeicCache(filePath: string): void {
  try {
    const hash = getFileCacheHash(filePath);
    memoryCache.delete(`thumb500:${hash}`);
    memoryCache.delete(`hq:${hash}`);

    const thumbDir = getThumbnailsDir();
    const thumbFileName = `${hash}_500.jpg`;
    const thumbPath = path.join(thumbDir, thumbFileName);
    if (fs.existsSync(thumbPath)) {
      try {
        fs.unlinkSync(thumbPath);
      } catch {}
    }
  } catch (err) {
    console.warn(`[heicService] Error purging cache for ${filePath}:`, err);
  }
}

/**
 * Legacy compatibility alias for getHeicJpegBuffer:
 * When preferOriginal/hq is true, returns high quality; otherwise returns 500px thumbnail.
 */
export async function getHeicJpegBuffer(filePath: string, preferHq: boolean = false): Promise<Buffer | null> {
  if (preferHq) {
    return getHeicHighQualityJpegBuffer(filePath);
  }
  return getOrGenerateHeicThumbnail500(filePath);
}

