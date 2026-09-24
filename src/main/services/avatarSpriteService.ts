import fs from 'fs';
import path from 'path';
import type { AvatarSpriteCoord } from '../../types';
import { getSpritePath } from './spriteService';
import { getPersonAvatarPath } from './personAvatarService';
import { getDb, getDbForLibraryPath } from './db';
import { getDefaultMirrorRoot, isPathAllowed } from './pathSecurity';

// Person cover avatars packed into WebP sprite sheets, the same idea as the
// photo sprites in spriteService.ts: opening People used to fire one
// gphoto:// request per avatar (hundreds at once, which is what made covers
// slow and, under load, permanently broken). Here the renderer asks once for
// a screenful of avatars and gets back coordinates into a handful of 50-tile
// sheets — a sheet is one static image, so ~50 avatars cost one transfer.
//
// People who have no saved avatar file yet (never displayed) are cropped HERE
// from their cover face's local mirror thumbnail — same crop rules as the
// card's own canvas crop — instead of making each card fetch the (possibly
// cloud-only) original and crop it in the browser. Those tiles are
// "provisional": thumbnail-quality, and replaced by the sharper saved avatar
// file as soon as one exists (e.g. after choosing a cover).
//
// Sheets are immutable and named uniquely, so they're served through the
// existing gphoto://sprite?id=... handler (Cache-Control: immutable) with no
// protocol changes. The index maps personId+coverKey -> tile; a tile is
// rebuilt if its avatar file changed on disk (same cover face re-cropped).

let sharp: any = null;
try {
  sharp = require('sharp');
} catch {}

export const AVATAR_TILE = 160;
const COLS = 10;
const PER_SHEET = 50;
const TILE_CONCURRENCY = 3;

/** Where a cover face lives: its local image plus the detection box and the image size the box was measured in. */
export interface FaceSource {
  filePath: string;
  box: { x: number; y: number; width: number; height: number };
  imageWidth?: number;
  imageHeight?: number;
}

interface Deps {
  avatarPath: (personId: string, cacheKey: string) => string | null;
  spritePath: (spriteId: string) => string;
  faceSource: (cacheKey: string) => FaceSource | null;
}

/**
 * A face id is `${base64(photo local path)}_face_${n}`; the photo's own
 * library database holds the box. Only paths the app already serves are read.
 */
function faceSourceFromDb(cacheKey: string): FaceSource | null {
  try {
    const m = /^(.+)_face_\d+$/.exec(cacheKey);
    if (!m) return null;
    const filePath = Buffer.from(m[1], 'base64').toString('utf8');
    if (!path.isAbsolute(filePath) || !isPathAllowed(filePath) || !fs.existsSync(filePath)) return null;

    const root = getDefaultMirrorRoot();
    const rel = path.relative(root, filePath);
    const storage = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep)[0] : '';
    const db = storage ? getDbForLibraryPath(path.join(root, storage)) : getDb();
    const row = db
      .prepare('SELECT box_x, box_y, box_width, box_height, image_width, image_height FROM faces WHERE id = ?')
      .get(cacheKey) as any;
    if (!row || row.box_width == null || row.box_height == null) return null;
    return {
      filePath,
      box: { x: row.box_x ?? 0, y: row.box_y ?? 0, width: row.box_width, height: row.box_height },
      imageWidth: row.image_width ?? undefined,
      imageHeight: row.image_height ?? undefined,
    };
  } catch {
    return null;
  }
}

let deps: Deps = { avatarPath: getPersonAvatarPath, spritePath: getSpritePath, faceSource: faceSourceFromDb };

/** Test-only: point the service at temp directories instead of the real userData. */
export function configureAvatarSpritesForTests(overrides: Partial<Deps>): void {
  deps = { avatarPath: getPersonAvatarPath, spritePath: getSpritePath, faceSource: () => null, ...overrides };
  index = null;
  chain = Promise.resolve();
}

type IndexEntry = AvatarSpriteCoord & { mtimeMs: number; provisional?: boolean };
let index: Record<string, IndexEntry> | null = null;
let chain: Promise<unknown> = Promise.resolve(); // sheets are built one at a time (bounds sharp/libvips load)
let sheetSeq = 0;

export function avatarSpriteKey(personId: string, cacheKey: string): string {
  return `${personId}::${cacheKey}`;
}

function indexFile(): string {
  return path.join(path.dirname(deps.spritePath('avatar_index_probe')), 'avatar_sprite_index.json');
}

function loadIndex(): Record<string, IndexEntry> {
  if (index) return index;
  try {
    index = JSON.parse(fs.readFileSync(indexFile(), 'utf8'));
  } catch {
    index = {};
  }
  return index!;
}

function saveIndex(): void {
  try {
    const file = indexFile();
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(index || {}), 'utf8');
    fs.renameSync(`${file}.tmp`, file);
  } catch (err) {
    console.warn('[AvatarSprite] Failed to save index:', err);
  }
}

/**
 * Square, padded face crop of a local image as a tile — the same rules as the
 * card's canvas crop (FaceAvatar): normalise the box by the size it was
 * measured in, pad 35%, square around the face, clamp to the image.
 */
export async function cropFaceTile(src: FaceSource): Promise<Buffer | null> {
  if (!sharp) return null;
  const raw = await fs.promises.readFile(src.filePath);
  // Dimensions as DISPLAYED (EXIF orientation 5-8 swaps width/height), which is
  // what the detection box refers to. Read from the header only, so the crop
  // below is a single decode -> rotate -> extract -> resize pass.
  const meta = await sharp(raw).metadata();
  if (!meta.width || !meta.height) return null;
  const swap = (meta.orientation ?? 1) >= 5;
  const W = swap ? meta.height : meta.width;
  const H = swap ? meta.width : meta.height;
  const { box } = src;

  let nx: number, ny: number, nw: number, nh: number;
  if (src.imageWidth && src.imageHeight) {
    nx = box.x / src.imageWidth;
    ny = box.y / src.imageHeight;
    nw = box.width / src.imageWidth;
    nh = box.height / src.imageHeight;
  } else if (box.x + box.width <= W && box.y + box.height <= H) {
    // box already in this image's own pixels
    nx = box.x / W;
    ny = box.y / H;
    nw = box.width / W;
    nh = box.height / H;
  } else {
    return null;
  }
  nx = Math.max(0, Math.min(1, nx));
  ny = Math.max(0, Math.min(1, ny));
  nw = Math.max(0, Math.min(1 - nx, nw));
  nh = Math.max(0, Math.min(1 - ny, nh));

  const fx = nx * W;
  const fy = ny * H;
  const fw = nw * W;
  const fh = nh * H;
  if (fw < 1 || fh < 1) return null;

  const pad = 0.35;
  const rawX = Math.max(0, fx - fw * pad);
  const rawY = Math.max(0, fy - fh * pad);
  const rawW = Math.min(W - rawX, fw + fw * pad * 2);
  const rawH = Math.min(H - rawY, fh + fh * pad * 2);
  const side = Math.max(rawW, rawH);
  const cropX = Math.max(0, Math.min(W - side, rawX - (side - rawW) / 2));
  const cropY = Math.max(0, Math.min(H - side, rawY - (side - rawH) / 2));
  const cropSide = Math.max(1, Math.floor(Math.min(side, W - cropX, H - cropY)));

  return sharp(raw)
    .rotate() // apply EXIF orientation, matching what the browser shows
    .extract({ left: Math.floor(cropX), top: Math.floor(cropY), width: cropSide, height: cropSide })
    .resize(AVATAR_TILE, AVATAR_TILE)
    .toBuffer();
}

type BuildEntry =
  | { key: string; kind: 'file'; filePath: string; mtimeMs: number }
  | { key: string; kind: 'face'; source: FaceSource };

async function buildSheet(entries: BuildEntry[], idx: Record<string, IndexEntry>): Promise<void> {
  if (!sharp) return;

  // A few tiles at a time: each is a small read + decode + crop, mostly
  // waiting on the libuv/libvips threads, so one-by-one left the CPU idle
  // (~125ms/tile while the face scan competed). Kept low to bound native load.
  const made: Array<Buffer | null> = new Array(entries.length).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < entries.length) {
      const i = next++;
      const e = entries[i];
      try {
        if (e.kind === 'file') {
          // Read into memory first: on Windows a path-based sharp() keeps the file
          // locked, which blocks the renderer re-cropping/overwriting that avatar.
          const source = await fs.promises.readFile(e.filePath);
          made[i] = await sharp(source).resize(AVATAR_TILE, AVATAR_TILE, { fit: 'cover' }).toBuffer();
        } else {
          made[i] = await cropFaceTile(e.source);
        }
      } catch {
        // unreadable/corrupt source: leave it out; the card falls back to cropping the cover live
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(TILE_CONCURRENCY, entries.length) }, worker));

  const tiles: Array<{ key: string; input: Buffer; mtimeMs: number; provisional: boolean }> = [];
  entries.forEach((e, i) => {
    const input = made[i];
    if (input) tiles.push({ key: e.key, input, mtimeMs: e.kind === 'file' ? e.mtimeMs : 0, provisional: e.kind === 'face' });
  });
  if (tiles.length === 0) return;

  const rows = Math.ceil(tiles.length / COLS);
  const spriteId = `av_${Date.now().toString(36)}${(sheetSeq++).toString(36)}`;
  const target = deps.spritePath(spriteId);

  await sharp({
    create: { width: COLS * AVATAR_TILE, height: rows * AVATAR_TILE, channels: 4, background: { r: 15, g: 23, b: 42, alpha: 1 } },
  })
    .composite(tiles.map((t, i) => ({ input: t.input, left: (i % COLS) * AVATAR_TILE, top: Math.floor(i / COLS) * AVATAR_TILE })))
    .webp({ quality: 82, effort: 3 })
    .toFile(`${target}.tmp`);
  fs.renameSync(`${target}.tmp`, target); // never serve a half-written sheet

  tiles.forEach((t, i) => {
    idx[t.key] = { spriteId, col: i % COLS, row: Math.floor(i / COLS), rows, tile: AVATAR_TILE, mtimeMs: t.mtimeMs, provisional: t.provisional };
  });
}

/**
 * Looks up (and builds, if missing) sprite tiles for the given people's cover
 * avatars. Returns key -> tile, or null where no tile could be made (no saved
 * avatar and no usable face source; the renderer then crops live, which also
 * saves the avatar for next time). Sheets build one at a time; concurrent
 * calls queue.
 */
export async function getAvatarSprites(
  items: Array<{ personId: string; cacheKey: string }>
): Promise<Record<string, AvatarSpriteCoord | null>> {
  const out: Record<string, AvatarSpriteCoord | null> = {};

  const run = async () => {
    const idx = loadIndex();
    const toBuild: BuildEntry[] = [];

    for (const it of items) {
      if (!it || !it.personId || !it.cacheKey) continue;
      const key = avatarSpriteKey(it.personId, it.cacheKey);
      const cur = idx[key];
      const sheetExists = !!cur && fs.existsSync(deps.spritePath(cur.spriteId));

      // 1) A saved avatar file always wins (it can be a sharper crop or a user-chosen one).
      const filePath = deps.avatarPath(it.personId, it.cacheKey);
      let mtimeMs = 0;
      if (filePath) {
        try {
          mtimeMs = fs.statSync(filePath).mtimeMs;
        } catch {
          mtimeMs = 0;
        }
      }
      if (filePath && mtimeMs) {
        if (cur && !cur.provisional && cur.mtimeMs === mtimeMs && sheetExists) out[key] = cur;
        else toBuild.push({ key, kind: 'file', filePath, mtimeMs });
        continue;
      }

      // 2) No saved avatar: reuse an earlier thumbnail-quality tile, else bake one from the cover face.
      if (cur && cur.provisional && sheetExists) {
        out[key] = cur;
        continue;
      }
      const source = deps.faceSource(it.cacheKey);
      if (source) toBuild.push({ key, kind: 'face', source });
      else out[key] = null;
    }

    for (let i = 0; i < toBuild.length; i += PER_SHEET) {
      await buildSheet(toBuild.slice(i, i + PER_SHEET), idx);
    }
    for (const b of toBuild) {
      const built = idx[b.key];
      // a tile counts only if this build produced it (a failed tile leaves an older/no entry)
      const fresh = !!built && built.provisional === (b.kind === 'face') && (b.kind === 'face' || built.mtimeMs === b.mtimeMs);
      out[b.key] = fresh ? built : null;
    }
    if (toBuild.length > 0) saveIndex();
  };

  const p = chain.then(run, run);
  chain = p.catch(() => {});
  await p;
  return out;
}
