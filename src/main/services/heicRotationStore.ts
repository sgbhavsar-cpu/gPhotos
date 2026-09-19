import fs from 'fs';
import path from 'path';
import os from 'os';

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

function normalizePath(filePath: string): string {
  return (filePath || '').trim().toLowerCase().replace(/\\/g, '/');
}

function loadHeicRotations(): Map<string, number> {
  if (heicRotationsCache) return heicRotationsCache;
  heicRotationsCache = new Map();
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
      if (fs.existsSync(loadPath)) {
        try {
          const raw = fs.readFileSync(loadPath, 'utf-8');
          const data = JSON.parse(raw);
          if (data && typeof data === 'object') {
            for (const [k, v] of Object.entries(data)) {
              if (typeof v === 'number') {
                const norm = normalizePath(k);
                const deg = ((v % 360) + 360) % 360;
                if (deg !== 0) {
                  heicRotationsCache.set(norm, deg);
                }
              }
            }
          }
        } catch {}
      }
    }
  } catch (err) {
    console.warn('[heicRotationStore] Failed reading heic_rotations.json:', err);
  }
  return heicRotationsCache;
}

function persistHeicRotations(map: Map<string, number>): void {
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
    const jsonStr = JSON.stringify(obj, null, 2);
    fs.writeFileSync(p, jsonStr, 'utf-8');

    // Also sync to alternative APPDATA directory if present so both environments stay in sync
    // (skipped entirely under test isolation, so tests never write real user data).
    const base = process.env.GPHOTOS_TEST_CONFIG_DIR ? '' : (process.env.APPDATA || '');
    if (base) {
      const altDirs = [path.join(base, 'gPhotos'), path.join(base, 'gphotos-desktop')];
      for (const d of altDirs) {
        const altFile = path.join(d, 'heic_rotations.json');
        if (altFile !== p && fs.existsSync(d)) {
          try {
            fs.writeFileSync(altFile, jsonStr, 'utf-8');
          } catch {}
        }
      }
    }
  } catch (err) {
    console.error('[heicRotationStore] Failed writing heic_rotations.json:', err);
  }
}

/**
 * Returns the currently saved rotation in degrees (0, 90, 180, 270) for a HEIC image.
 * Checks direct path, sidecar JSON metadata, and originalFilePath.
 */
export function getHeicSavedRotation(filePath: string): number {
  if (!filePath) return 0;
  const map = loadHeicRotations();
  const norm = normalizePath(filePath);

  // 1. Direct match in rotation store
  if (map.has(norm)) {
    return map.get(norm) || 0;
  }

  // 2. Check if this is a virtual mirror file or has a sidecar JSON
  try {
    const sidecarPath = filePath.replace(/\.[^/.]+$/, '.json');
    if (fs.existsSync(sidecarPath)) {
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
    }
  } catch {}

  return 0;
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
