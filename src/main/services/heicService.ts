import fs from 'fs';
import path from 'path';
import exifr from 'exifr';

// Memory cache for decoded HEIC photos to prevent redundant CPU cycles (up to 100 images)
const heicCache = new Map<string, Buffer>();
const MAX_CACHE_ITEMS = 100;

let heicConvert: any = null;
try {
  heicConvert = require('heic-convert');
} catch (e) {
  console.warn('heic-convert module could not be loaded:', e);
}

/**
 * Robustly retrieves a JPEG Buffer for an Apple iPhone HEIC/HEIF photo.
 * Strategy:
 *  1. Cache hit: returns immediately from memory.
 *  2. Fast path: extracts embedded high-res EXIF thumbnail (<5ms) using exifr with an in-memory buffer.
 *  3. Fallback: decodes the HEVC bitstream into a standard JPEG using heic-convert (libheif-js WASM).
 */
export async function getHeicJpegBuffer(filePath: string): Promise<Buffer | null> {
  if (!fs.existsSync(filePath)) return null;

  try {
    const stat = fs.statSync(filePath);
    const cacheKey = `${filePath}:${stat.mtimeMs}`;
    if (heicCache.has(cacheKey)) {
      return heicCache.get(cacheKey)!;
    }

    const fileBuffer = fs.readFileSync(filePath);

    // 1. Fast path: embedded EXIF JPEG preview
    try {
      // Pass buffer to exifr so it doesn't open an OS file descriptor
      const thumbBuffer = await exifr.thumbnail(fileBuffer);
      if (thumbBuffer && thumbBuffer.length > 0) {
        const result = Buffer.from(thumbBuffer);
        if (heicCache.size >= MAX_CACHE_ITEMS) {
          const firstKey = heicCache.keys().next().value;
          if (firstKey) heicCache.delete(firstKey);
        }
        heicCache.set(cacheKey, result);
        return result;
      }
    } catch (thumbErr) {
      // If embedded thumbnail is missing or corrupted, continue to full decode
    }

    // 2. Fallback: full decode using heic-convert (pure JS/WASM libheif)
    if (heicConvert) {
      try {
        const converted = await heicConvert({
          buffer: fileBuffer,
          format: 'JPEG',
          quality: 0.88,
        });
        const result = Buffer.from(converted);
        if (heicCache.size >= MAX_CACHE_ITEMS) {
          const firstKey = heicCache.keys().next().value;
          if (firstKey) heicCache.delete(firstKey);
        }
        heicCache.set(cacheKey, result);
        return result;
      } catch (convErr) {
        console.error(`heic-convert failed to decode ${filePath}:`, convErr);
      }
    }

    return null;
  } catch (err) {
    console.error(`Error processing HEIC file ${filePath}:`, err);
    return null;
  }
}
