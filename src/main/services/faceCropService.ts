// Sharp, padded face crops kept on disk, so "Zoomed Faces" no longer stretches a face out of a small cached thumbnail.
// A crop (256 px square JPEG) is made from the full-resolution original: during face detection (the decoded photo is already in
// memory) and, for faces found earlier, the first time one is shown (or by the idle fill job). Crops live with their mirror —
// <mirror>\.gphotos_catalog\face_crops\<faceId>.jpg — or in the app's userData folder for a local library, and are removed
// together with the faces (reset / rescan).
import fs from 'fs';
import path from 'path';
import { getGlobalUserDataDir } from './db';
import sharp from 'sharp';
import { getHeicFullResolutionBufferForDetection } from './heicService';
import { isPathReachable } from './networkReachabilityCache';
import { logger } from './logger';

export const FACE_CROP_SIZE = 256;
/** Extra context around the face box, as a fraction of its larger side (each side). */
const PAD = 0.35;

export interface FaceCropRequest {
  filePath: string;
  originalRemotePath?: string;
  isVirtual?: boolean;
  storageName?: string;
  isVideo?: boolean;
  faceId: string;
  box: { x: number; y: number; width: number; height: number };
  /** The frame the box was measured in (see DetectedFace.imageWidth). */
  imageWidth?: number;
  imageHeight?: number;
}

const SAFE_ID = /^[A-Za-z0-9._-]{1,200}$/;
const IMAGE_EXT = /\.(jpe?g|png|webp|heic|heif|tiff?|bmp|gif|avif)$/i;

/** The square region (in the decoded frame's pixels) to cut for a face: padded, kept inside the frame. Null if unusable. */
export function cropGeometry(
  box: { x: number; y: number; width: number; height: number },
  refW: number | undefined,
  refH: number | undefined,
  frameW: number,
  frameH: number
): { left: number; top: number; size: number } | null {
  if (!(box.width > 0) || !(box.height > 0) || !(frameW > 0) || !(frameH > 0)) return null;
  let sx = 1, sy = 1;
  if (refW && refH && refW > 0 && refH > 0) {
    // A box measured in a frame of a different shape (e.g. rotated) cannot be mapped: skip rather than cut the wrong place.
    if (Math.abs(refW / refH - frameW / frameH) / (frameW / frameH) > 0.03) return null;
    sx = frameW / refW;
    sy = frameH / refH;
  }
  const cx = (box.x + box.width / 2) * sx, cy = (box.y + box.height / 2) * sy;
  const side = Math.max(box.width * sx, box.height * sy) * (1 + 2 * PAD);
  const size = Math.max(8, Math.min(Math.round(side), frameW, frameH));
  const left = Math.min(Math.max(0, Math.round(cx - size / 2)), frameW - size);
  const top = Math.min(Math.max(0, Math.round(cy - size / 2)), frameH - size);
  return { left, top, size };
}

/** The mirror folder a virtual photo belongs to (same derivation as resolveDbForPhoto), or null for a local photo. */
function mirrorFolderOf(req: Pick<FaceCropRequest, 'isVirtual' | 'storageName' | 'filePath'>): string | null {
  if (req.isVirtual && req.storageName && req.filePath) {
    const segments = req.filePath.split(/[\\/]+/);
    const idx = segments.findIndex((s) => s.toLowerCase() === req.storageName!.toLowerCase());
    if (idx !== -1) {
      const folder = segments.slice(0, idx + 1).join(path.sep);
      if (fs.existsSync(path.join(folder, '.gphotos_catalog'))) return folder; // only ever write inside a real catalog
    }
  }
  return null;
}

export function faceCropDirFor(req: Pick<FaceCropRequest, 'isVirtual' | 'storageName' | 'filePath'>): string {
  const mirror = mirrorFolderOf(req);
  return mirror ? path.join(mirror, '.gphotos_catalog', 'face_crops') : path.join(getGlobalUserDataDir(), 'face_crops');
}

export function faceCropPathFor(req: Pick<FaceCropRequest, 'isVirtual' | 'storageName' | 'filePath' | 'faceId'>): string | null {
  if (!SAFE_ID.test(req.faceId)) return null;
  return path.join(faceCropDirFor(req), `${req.faceId}.jpg`);
}

export function existingFaceCrop(req: FaceCropRequest): string | null {
  const p = faceCropPathFor(req);
  return p && fs.existsSync(p) ? p : null;
}

/** Cuts crops for `faces` out of one decoded photo. Returns how many crops were written. Never throws. */
export async function writeFaceCropsFromBuffer(buffer: Buffer, photo: Omit<FaceCropRequest, 'faceId' | 'box' | 'imageWidth' | 'imageHeight'>, faces: Array<Pick<FaceCropRequest, 'faceId' | 'box' | 'imageWidth' | 'imageHeight'>>): Promise<number> {
  try {
    const todo = faces.filter((f) => SAFE_ID.test(f.faceId) && !fs.existsSync(faceCropPathFor({ ...photo, faceId: f.faceId })!));
    if (todo.length === 0) return 0;
    const dir = faceCropDirFor(photo);
    fs.mkdirSync(dir, { recursive: true });
    // Decode once (with EXIF orientation, the frame detection measured its boxes in), then cut every face from the raw pixels.
    const { data, info } = await sharp(buffer, { limitInputPixels: 200_000_000 }).rotate().raw().toBuffer({ resolveWithObject: true });
    let made = 0;
    for (const f of todo) {
      const g = cropGeometry(f.box, f.imageWidth, f.imageHeight, info.width, info.height);
      if (!g) continue;
      const out = faceCropPathFor({ ...photo, faceId: f.faceId })!;
      const tmp = `${out}.${process.pid}.tmp`;
      await sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } })
        .extract({ left: g.left, top: g.top, width: g.size, height: g.size })
        .resize(FACE_CROP_SIZE, FACE_CROP_SIZE, { fit: 'fill', kernel: 'lanczos3' })
        .jpeg({ quality: 88, mozjpeg: false })
        .toFile(tmp);
      fs.renameSync(tmp, out);
      made++;
    }
    return made;
  } catch (err) {
    logger.warn('FaceCrop', 'Could not write face crops', { err: String((err as Error)?.message || err).slice(0, 200) });
    return 0;
  }
}

// A few at a time: each one reads a whole original (a OneDrive download, for a cloud-only file).
const MAX_CONCURRENT = 2;
let running = 0;
const waiters: Array<() => void> = [];
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= MAX_CONCURRENT) await new Promise<void>((r) => waiters.push(r));
  running++;
  try { return await fn(); } finally { running--; waiters.shift()?.(); }
}

/** The crop file for a face, creating it from the original if needed. Null when it cannot be made (offline, video, unreadable). */
export async function ensureFaceCrop(req: FaceCropRequest): Promise<string | null> {
  const existing = existingFaceCrop(req);
  if (existing) return existing;
  const out = faceCropPathFor(req);
  if (!out || req.isVideo) return null;
  const source = req.isVirtual ? req.originalRemotePath : req.filePath; // a virtual photo's filePath is only its thumbnail
  if (!source || !IMAGE_EXT.test(source)) return null;
  return slot(async () => {
    if (fs.existsSync(out)) return out;
    try {
      if (req.isVirtual && !(await isPathReachable(path.dirname(source)))) return null;
      const buf = /\.(heic|heif)$/i.test(source) ? await getHeicFullResolutionBufferForDetection(source) : await fs.promises.readFile(source);
      if (!buf) return null;
      await writeFaceCropsFromBuffer(buf, req, [req]);
      return fs.existsSync(out) ? out : null;
    } catch (err) {
      logger.debug('FaceCrop', 'Could not create a face crop', { source, err: String((err as Error)?.message || err).slice(0, 160) });
      return null;
    }
  });
}

/** Idle fill: makes the missing crops for these faces, sequentially. Returns counts. */
export async function fillFaceCrops(reqs: FaceCropRequest[], shouldStop?: () => boolean): Promise<{ made: number; skipped: number; failed: number }> {
  let made = 0, skipped = 0, failed = 0;
  for (const r of reqs) {
    if (shouldStop?.()) break;
    if (existingFaceCrop(r)) { skipped++; continue; }
    if (await ensureFaceCrop(r)) made++; else failed++;
  }
  return { made, skipped, failed };
}

/** Deletes crops: the given faces', or (no ids) every crop in that mirror / local-library folder. */
export function deleteFaceCrops(where: Pick<FaceCropRequest, 'isVirtual' | 'storageName' | 'filePath'>, faceIds?: string[]): number {
  const dir = faceCropDirFor(where);
  let removed = 0;
  try {
    if (!fs.existsSync(dir)) return 0;
    if (faceIds) {
      for (const id of faceIds) {
        if (!SAFE_ID.test(id)) continue;
        try { fs.unlinkSync(path.join(dir, `${id}.jpg`)); removed++; } catch {}
      }
    } else {
      for (const f of fs.readdirSync(dir)) { try { fs.unlinkSync(path.join(dir, f)); removed++; } catch {} }
    }
  } catch {}
  return removed;
}

/** Same, addressed by a mirror folder directly (used by the reset). */
export function clearMirrorFaceCrops(mirrorFolder: string, faceIds?: string[]): number {
  const dir = path.join(mirrorFolder, '.gphotos_catalog', 'face_crops');
  let removed = 0;
  try {
    if (!fs.existsSync(dir)) return 0;
    const names = faceIds ? faceIds.filter((i) => SAFE_ID.test(i)).map((i) => `${i}.jpg`) : fs.readdirSync(dir);
    for (const f of names) { try { fs.unlinkSync(path.join(dir, f)); removed++; } catch {} }
  } catch {}
  return removed;
}
