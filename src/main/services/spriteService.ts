import fs from 'fs';
import path from 'path';
import os from 'os';
import { app } from 'electron';
import { Photo, SpriteCoordinate } from '../../types';
import { getOrGenerateCachedThumbnail } from './thumbnailCacheService';

let sharp: any = null;
try {
  sharp = require('sharp');
} catch {}

const SPRITE_THUMB_SIZE = 160;
const SPRITE_COLS = 10;
const SPRITE_ROWS = 5;
const PHOTOS_PER_SPRITE = SPRITE_COLS * SPRITE_ROWS; // 50 photos per sheet

function getSpriteCacheDir(): string {
  const appData = app
    ? app.getPath('userData')
    : (process.env.APPDATA || (process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library/Application Support')
        : path.join(os.homedir(), '.config')));
  const d = path.join(appData, 'gPhotos', 'cache', 'sprites');
  if (!fs.existsSync(d)) {
    fs.mkdirSync(d, { recursive: true });
  }
  return d;
}

function getIndexFilePath(): string {
  return path.join(getSpriteCacheDir(), 'sprite_index.json');
}

// In-memory index cache: photoPath -> SpriteCoordinate
let memoryIndex: Record<string, SpriteCoordinate> | null = null;

export function loadSpriteIndex(): Record<string, SpriteCoordinate> {
  if (memoryIndex) return memoryIndex;
  const p = getIndexFilePath();
  if (fs.existsSync(p)) {
    try {
      const raw = fs.readFileSync(p, 'utf8');
      memoryIndex = JSON.parse(raw);
      return memoryIndex || {};
    } catch {}
  }
  memoryIndex = {};
  return memoryIndex;
}

export function saveSpriteIndex(): void {
  if (!memoryIndex) return;
  try {
    const p = getIndexFilePath();
    fs.writeFileSync(p, JSON.stringify(memoryIndex), 'utf8');
  } catch (err) {
    console.warn('[SpriteService] Failed to save sprite index:', err);
  }
}

export function getSpriteCoordinate(photoPath: string): SpriteCoordinate | null {
  const index = loadSpriteIndex();
  return index[photoPath.toLowerCase()] || null;
}

export function getSpritePath(spriteId: string): string {
  return path.join(getSpriteCacheDir(), `${spriteId}.webp`);
}

/**
 * Pre-bakes a tiled WebP sprite sheet for up to 50 photos.
 * Serves as 1 static image transferring 50 thumbnails in 1 request (~120 KB total).
 */
export async function generateSpriteSheet(
  spriteId: string,
  photos: Photo[]
): Promise<string> {
  const targetFile = getSpritePath(spriteId);
  if (fs.existsSync(targetFile)) {
    return targetFile;
  }

  if (!sharp) {
    throw new Error('Sharp module is required for sprite generation');
  }

  const count = Math.min(photos.length, PHOTOS_PER_SPRITE);
  if (count === 0) return '';

  const sheetWidth = SPRITE_COLS * SPRITE_THUMB_SIZE;
  const sheetHeight = Math.ceil(count / SPRITE_COLS) * SPRITE_THUMB_SIZE;

  const overlays: Array<{ input: Buffer; left: number; top: number }> = [];
  const index = loadSpriteIndex();

  for (let i = 0; i < count; i++) {
    const p = photos[i];
    const col = i % SPRITE_COLS;
    const row = Math.floor(i / SPRITE_COLS);
    const left = col * SPRITE_THUMB_SIZE;
    const top = row * SPRITE_THUMB_SIZE;

    try {
      const thumb = await getOrGenerateCachedThumbnail(p.filePath, SPRITE_THUMB_SIZE);
      if (thumb && thumb.buffer) {
        // Resize buffer exactly to square thumb
        const squareBuf = await sharp(thumb.buffer)
          .resize(SPRITE_THUMB_SIZE, SPRITE_THUMB_SIZE, { fit: 'cover' })
          .toBuffer();

        overlays.push({ input: squareBuf, left, top });

        index[p.filePath.toLowerCase()] = {
          spriteId,
          url: `/api/sprites/${spriteId}.webp`,
          col,
          row,
          x: left,
          y: top,
          width: SPRITE_THUMB_SIZE,
          height: SPRITE_THUMB_SIZE,
          sheetWidth,
          sheetHeight,
        };
      }
    } catch (err) {
      // Graceful fallback: skip missing thumbnail
    }
  }

  if (overlays.length === 0) return '';

  // Composite all 50 thumbnails into a single high-efficiency WebP
  await sharp({
    create: {
      width: sheetWidth,
      height: sheetHeight,
      channels: 4,
      background: { r: 15, g: 23, b: 42, alpha: 1 },
    },
  })
    .composite(overlays)
    .webp({ quality: 80, effort: 4 })
    .toFile(targetFile);

  saveSpriteIndex();
  return targetFile;
}

/**
 * Generates sprite sheets for a whole page or slice of photos in the background.
 */
export async function prebakeSpritesForPhotos(photos: Photo[], prefix = 'page'): Promise<void> {
  for (let i = 0; i < photos.length; i += PHOTOS_PER_SPRITE) {
    const slice = photos.slice(i, i + PHOTOS_PER_SPRITE);
    const spriteId = `${prefix}_sprite_${Math.floor(i / PHOTOS_PER_SPRITE)}`;
    try {
      await generateSpriteSheet(spriteId, slice);
    } catch (err) {
      console.warn(`[SpriteService] Pre-baking sprite ${spriteId} failed:`, err);
    }
  }
}
