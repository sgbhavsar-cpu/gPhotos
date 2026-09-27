import fs from 'fs';
import path from 'path';
import os from 'os';
import { readJsonSafe, writeJsonAtomic } from './jsonFile';

/**
 * Resolves the path to the persistent heic_rotations.json file in userData.
 */
export function getHeicRotationsFilePath(): string {
  // Test-only override so unit tests never touch a real user's rotation flags.
  if (process.env.GPHOTOS_TEST_CONFIG_DIR) {
    return path.join(process.env.GPHOTOS_TEST_CONFIG_DIR, 'heic_rotations.json');
  }

  try {
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') {
      return path.join(app.getPath('userData'), 'heic_rotations.json');
    }
  } catch {}

  const base =
    process.env.APPDATA ||
    (process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library/Application Support')
      : path.join(os.homedir(), '.config'));

  // Check gPhotos first (since app.setName is 'gPhotos'), then fallback to gphotos-desktop
  const pGphotos = path.join(base, 'gPhotos', 'heic_rotations.json');
  if (fs.existsSync(pGphotos)) return pGphotos;
  return path.join(base, 'gphotos-desktop', 'heic_rotations.json');
}

// In-memory cache of saved rotations: normalizedPath -> rotation degrees (0, 90, 180, 270)
let heicRotationsCache: Map<string, number> | null = null;
/** Test-only: clears the in-memory cache so the next call re-reads from disk. */
export function resetHeicRotationCacheForTests(): void {
  heicRotationsCache = null;
}

// Paths whose sidecar lookup already came up empty: normalizedPath -> when. getHeicSavedRotation is
// called per photo (thumbnails, catalog rows) and a miss used to re-hit the disk every single time.
// Bounded (cleared wholesale at the cap) and short-lived, since a sync/rotate may create the sidecar later.
const NEGATIVE_LOOKUP_TTL_MS = 60_000;
const NEGATIVE_LOOKUP_MAX = 20_000;
const negativeLookups = new Map<string, number>();
/** Test-only: forget cached negative sidecar lookups. */
export function resetHeicNegativeCacheForTests(): void {
  negativeLookups.clear();
}

function normalizePath(filePath: string): string {
  return (filePath || '').trim().toLowerCase().replace(/\\/g, '/');
}

function loadHeicRotations(): Map<string, number> {
  if (heicRotationsCache) return heicRotationsCache;
  const loaded = new Map<string, number>();
  try {
    // Load from primary path
    const p = getHeicRotationsFilePath();
    const pathsToLoad = [p];

    // Also check alternative userData directories to merge any past rotations
    // (skipped entirely under test isolation, so tests never read real user data).
    const base = process.env.GPHOTOS_TEST_CONFIG_DIR ? '' : (process.env.APPDATA || '');
    if (base) {
      const alt1 = path.join(base, 'gPhotos', 'heic_rotations.json');
      const alt2 = path.join(base, 'gphotos-desktop', 'heic_rotations.json');
      if (alt1 !== p && fs.existsSync(alt1)) pathsToLoad.push(alt1);
      if (alt2 !== p && fs.existsSync(alt2)) pathsToLoad.push(alt2);
    }

    for (const loadPath of pathsToLoad) {
      // Unparseable file -> moved aside to .corrupt-<ts> (never silently overwritten);
      // an unreadable one throws and is handled below.
      const data = readJsonSafe<Record<string, unknown> | null>(loadPath, null);
      if (data && typeof data === 'object') {
        for (const [k, v] of Object.entries(data)) {
          if (typeof v === 'number') {
            const norm = normalizePath(k);
            const deg = ((v % 360) + 360) % 360;
            if (deg !== 0) {
              loaded.set(norm, deg);
            }
          }
        }
      }
    }
  } catch (err) {
    console.warn('[heicRotationStore] Failed reading heic_rotations.json:', err);
    // Don't cache a partial view — retry on the next call. Callers get this temporary map;
    // persistHeicRotations refuses to write any map that is not the cached, fully loaded one.
    return loaded;
  }
  heicRotationsCache = loaded;
  return heicRotationsCache;
}

function persistHeicRotations(map: Map<string, number>): void {
  // Only the cached map is a complete view of the file. A temporary map (failed read) would
  // overwrite every saved rotation with just the new one — even if a later load has succeeded.
  if (map !== heicRotationsCache) {
    console.warn('[heicRotationStore] Not saving rotation: existing heic_rotations.json could not be read (would overwrite it).');
    return;
  }
  try {
    const p = getHeicRotationsFilePath();
    const dir = path.dirname(p);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const obj: Record<string, number> = {};
    for (const [k, v] of map.entries()) {
      if (v !== 0) {
        obj[k] = v;
      }
    }
    writeJsonAtomic(p, obj);

    // Also sync to alternative APPDATA directory if present so both environments stay in sync
    // (skipped entirely under test isolation, so tests never write real user data).
    const base = process.env.GPHOTOS_TEST_CONFIG_DIR ? '' : (process.env.APPDATA || '');
    if (base) {
      const altDirs = [path.join(base, 'gPhotos'), path.join(base, 'gphotos-desktop')];
      for (const d of altDirs) {
        const altFile = path.join(d, 'heic_rotations.json');
        if (altFile !== p && fs.existsSync(d)) {
          try {
            writeJsonAtomic(altFile, obj);
          } catch {}
        }
      }
    }
  } catch (err) {
    console.error('[heicRotationStore] Failed writing heic_rotations.json:', err);
  }
}

/** True when the leading bytes are a plain JPEG / PNG / WebP image (real pixels, not a HEIC/RAW container). */
export function isPlainRasterBytes(head: Uint8Array | null | undefined): boolean {
  if (!head || head.length < 4) return false;
  if (head[0] === 0xff && head[1] === 0xd8) return true; // JPEG
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return true; // PNG
  return head.length >= 12 && head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46 && head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50; // WebP
}

/**
 * The saved rotation to apply when decoding `filePath`, whose leading bytes are `head`.
 *
 * The flag store holds one number per path, but it means two different things: under a genuine HEIC file it is
 * "rotate when decoding this", while under a mirror thumbnail (JPEG bytes that are merely NAMED .heic) it records
 * that the rotation is ALREADY in the pixels. Applying it to plain raster bytes rotated such thumbnails twice as
 * soon as their cache was regenerated, so it is ignored for them.
 */
export function getSavedRotationForContent(filePath: string, head: Uint8Array | null | undefined): number {
  return isPlainRasterBytes(head) ? 0 : getHeicSavedRotation(filePath);
}

/**
 * Returns the currently saved rotation in degrees (0, 90, 180, 270) for a HEIC image.
 * Checks direct path, sidecar JSON metadata, and originalFilePath.
 */
export function getHeicSavedRotation(filePath: string, options?: { skipSidecar?: boolean }): number {
  if (!filePath) return 0;
  const map = loadHeicRotations();
  const norm = normalizePath(filePath);

  // 1. Direct match in rotation store
  if (map.has(norm)) {
    return map.get(norm) || 0;
  }

  // 2. Check if this is a virtual mirror file or has a sidecar JSON.
  // skipSidecar: for a path on a (possibly offline) network share, where the
  // sync read below could block the main thread for the SMB timeout. UNC paths
  // are skipped for the same reason even when the caller didn't say so; mirror
  // sidecars only ever live on the local disk.
  if (options?.skipSidecar || /^[\\/]{2}/.test(filePath)) return 0;
  const missedAt = negativeLookups.get(norm);
  if (missedAt !== undefined) {
    if (Date.now() - missedAt < NEGATIVE_LOOKUP_TTL_MS) return 0;
    negativeLookups.delete(norm);
  }
  try {
    const sidecarPath = filePath.replace(/\.[^/.]+$/, '.json');
    // One read (ENOENT lands in the catch) instead of existsSync + readFileSync.
    const meta = JSON.parse(fs.readFileSync(sidecarPath, 'utf-8'));
    if (typeof meta.heicRotation === 'number' && meta.heicRotation !== 0) {
      const deg = ((meta.heicRotation % 360) + 360) % 360;
      map.set(norm, deg);
      return deg;
    }
    if (typeof meta.rotation === 'number' && meta.rotation !== 0) {
      const deg = ((meta.rotation % 360) + 360) % 360;
      map.set(norm, deg);
      return deg;
    }
    if (meta.originalFilePath) {
      const origNorm = normalizePath(meta.originalFilePath);
      if (map.has(origNorm)) {
        const deg = map.get(origNorm) || 0;
        map.set(norm, deg);
        return deg;
      }
    }
  } catch {}

  if (negativeLookups.size >= NEGATIVE_LOOKUP_MAX) negativeLookups.clear();
  negativeLookups.set(norm, Date.now());
  return 0;
}

/**
 * Adds `deltaDegrees` to the saved rotation of EACH of `paths` (a photo's local mirror thumbnail and its remote
 * original, say), exactly once per path, and returns the new total per path.
 *
 * Every path's previous value is read BEFORE anything is written. That matters because saveHeicSavedRotation
 * also mirrors its result onto the original path named in the file's sidecar; calling it once per path therefore
 * added the rotation to the original TWICE (90 turned into 180), so a HEIC original was shown rotated twice as
 * far as its thumbnail. Sidecars are deliberately not consulted here: the caller names every path it means.
 */
export function addSavedRotation(paths: Array<string | undefined | null>, deltaDegrees: number): Map<string, number> {
  const map = loadHeicRotations();
  const unique = Array.from(new Set(paths.filter((p): p is string => !!p)));
  const before = new Map(unique.map((p) => [p, getHeicSavedRotation(p)] as const));
  const totals = new Map<string, number>();
  for (const p of unique) {
    const total = ((((before.get(p) || 0) + deltaDegrees) % 360) + 360) % 360;
    if (total === 0) map.delete(normalizePath(p));
    else map.set(normalizePath(p), total);
    totals.set(p, total);
  }
  negativeLookups.clear();
  persistHeicRotations(map);
  return totals;
}

/**
 * Accumulates deltaDegrees (e.g. +90) to the saved rotation for a HEIC image,
 * persists it to disk, and returns the resulting total rotation degrees (0, 90, 180, 270).
 */
export function saveHeicSavedRotation(filePath: string, deltaDegrees: number): number {
  if (!filePath) return 0;
  const map = loadHeicRotations();
  const norm = normalizePath(filePath);
  const current = getHeicSavedRotation(filePath);
  const total = (((current + deltaDegrees) % 360) + 360) % 360;

  if (total === 0) {
    map.delete(norm);
  } else {
    map.set(norm, total);
  }
  negativeLookups.clear();

  // Also check sidecar to synchronize originalFilePath or mirror path
  try {
    const sidecarPath = filePath.replace(/\.[^/.]+$/, '.json');
    if (fs.existsSync(sidecarPath)) {
      const meta = JSON.parse(fs.readFileSync(sidecarPath, 'utf-8'));
      if (meta.originalFilePath) {
        const origNorm = normalizePath(meta.originalFilePath);
        if (total === 0) map.delete(origNorm);
        else map.set(origNorm, total);
      }
    }
  } catch {}

  persistHeicRotations(map);
  return total;
}

/**
 * Directly sets the rotation degrees for a HEIC image.
 */
export function setHeicSavedRotation(filePath: string, degrees: number): void {
  if (!filePath) return;
  const map = loadHeicRotations();
  const norm = normalizePath(filePath);
  const total = ((degrees % 360) + 360) % 360;

  if (total === 0) {
    map.delete(norm);
  } else {
    map.set(norm, total);
  }
  negativeLookups.clear();

  try {
    const sidecarPath = filePath.replace(/\.[^/.]+$/, '.json');
    if (fs.existsSync(sidecarPath)) {
      const meta = JSON.parse(fs.readFileSync(sidecarPath, 'utf-8'));
      if (meta.originalFilePath) {
        const origNorm = normalizePath(meta.originalFilePath);
        if (total === 0) map.delete(origNorm);
        else map.set(origNorm, total);
      }
    }
  } catch {}

  persistHeicRotations(map);
}

/**
 * Clears any saved rotation for a HEIC image.
 */
export function clearHeicSavedRotation(filePath: string): void {
  if (!filePath) return;
  const map = loadHeicRotations();
  const norm = normalizePath(filePath);
  negativeLookups.clear();
  if (map.has(norm)) {
    map.delete(norm);
    persistHeicRotations(map);
  }
}

/**
 * Returns a dictionary of all saved HEIC rotations.
 */
export function getAllHeicSavedRotations(): Record<string, number> {
  const map = loadHeicRotations();
  const obj: Record<string, number> = {};
  for (const [k, v] of map.entries()) {
    obj[k] = v;
  }
  return obj;
}

/**
 * Moves the saved rotation flag stored under `oldPath` to `newPath` (a photo that was moved on disk).
 * Only the exact-path flag is moved (no sidecar lookups); returns true when there was one to move.
 */
export function moveHeicSavedRotation(oldPath: string, newPath: string): boolean {
  if (!oldPath || !newPath) return false;
  const map = loadHeicRotations();
  const from = normalizePath(oldPath);
  const to = normalizePath(newPath);
  if (from === to || !map.has(from)) return false;
  map.set(to, map.get(from) as number);
  map.delete(from);
  negativeLookups.clear();
  persistHeicRotations(map);
  return true;
}
