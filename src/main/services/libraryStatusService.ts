import fs from 'fs';
import path from 'path';
import os from 'os';
import { app } from 'electron';
import { LibraryScanStatus } from '../../types';
import { getDefaultMirrorRoot } from './pathSecurity';

function getUserDataPath(): string {
  try {
    if (app && typeof app.getPath === 'function' && app.isReady()) {
      return app.getPath('userData');
    }
  } catch {}

  return (
    process.env.APPDATA
      ? path.join(process.env.APPDATA, 'gPhotos')
      : path.join(os.homedir(), '.gphotos')
  );
}

function getGlobalStatusFilePath(): string {
  const base = getUserDataPath();
  if (!fs.existsSync(base)) {
    try { fs.mkdirSync(base, { recursive: true }); } catch {}
  }
  return path.join(base, 'libraries_status.json');
}

class LibraryStatusService {
  private cache: Record<string, LibraryScanStatus> = {};
  private initialized = false;

  private normalizeKey(libraryPath: string): string {
    if (!libraryPath || typeof libraryPath !== 'string') return '';
    // A virtual/network storage is often identified by just its bare folder
    // name (e.g. "OndrivePhotos"), never a full path — path.resolve() on a
    // bare name resolves it against process.cwd(), which differs between
    // the installed app and every different way of launching in dev. That
    // silently fragmented a single real storage's tracked status across a
    // different key per cwd ever used, each one stuck at whatever it last
    // saw. Every virtual storage lives under the one shared, stable mirror
    // root, so resolve a non-absolute name against THAT instead of cwd.
    const resolved = path.isAbsolute(libraryPath) ? libraryPath : path.join(getDefaultMirrorRoot(), libraryPath);
    return path.resolve(resolved).toLowerCase().replace(/[\\/]+$/, '');
  }

  private loadAll(): void {
    try {
      const p = getGlobalStatusFilePath();
      if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          this.cache = parsed;
        }
      }
    } catch (err) {
      console.warn('[LibraryStatus] Failed to load global status:', err);
    }
    this.initialized = true;
  }

  public getAllLibraryStatuses(): Record<string, LibraryScanStatus> {
    if (!this.initialized) this.loadAll();
    return { ...this.cache };
  }

  public getLibraryStatus(libraryPath: string): LibraryScanStatus | null {
    if (!this.initialized) this.loadAll();
    const key = this.normalizeKey(libraryPath);
    if (!key) return null;

    if (this.cache[key]) return { ...this.cache[key] };

    // Also check local sidecar in the library directory if available
    try {
      if (fs.existsSync(libraryPath)) {
        const localStatusFile = path.join(libraryPath, '.gphotos_status.json');
        if (fs.existsSync(localStatusFile)) {
          const raw = fs.readFileSync(localStatusFile, 'utf-8');
          const data = JSON.parse(raw);
          if (data && data.libraryPath) {
            this.cache[key] = data;
            return { ...data };
          }
        }
      }
    } catch {}

    return null;
  }

  public saveLibraryStatus(status: Partial<LibraryScanStatus> & { libraryPath: string }): LibraryScanStatus {
    if (!this.initialized) this.loadAll();
    const key = this.normalizeKey(status.libraryPath);
    if (!key) throw new Error('Invalid libraryPath for status save');

    const existing = this.cache[key] || {
      libraryPath: status.libraryPath,
      libraryName: path.basename(status.libraryPath) || 'Library',
      totalPhotos: 0,
      thumbnailCachedCount: 0,
      thumbnailTotalCount: 0,
      thumbnailLastIndex: -1,
      thumbnailCompleted: false,
      thumbnailPercent: 0,
      faceScannedCount: 0,
      faceTotalCount: 0,
      faceDetectedCount: 0,
      faceLastIndex: -1,
      faceCompleted: false,
      facePercent: 0,
      phase: 'idle',
      lastUpdated: new Date().toISOString(),
    };

    const merged: LibraryScanStatus = {
      ...existing,
      ...status,
      libraryPath: status.libraryPath,
      libraryName: status.libraryName || existing.libraryName || path.basename(status.libraryPath),
      // totalPhotos/thumbnailTotalCount/faceTotalCount represent this
      // library's true full size — never let them shrink. Several callers
      // save status after processing only a SCOPE of the library (e.g. face
      // detection on just the first loaded page while later pages are still
      // fetching), and a naive {...existing, ...status} spread let that
      // partial scope's smaller count silently overwrite an already-known
      // larger true total — after which "already 100% done" checks
      // elsewhere trusted the now-wrong small total as complete, leaving
      // the rest of the library permanently unaccounted for.
      totalPhotos: Math.max(existing.totalPhotos || 0, status.totalPhotos ?? 0),
      thumbnailTotalCount: Math.max(existing.thumbnailTotalCount || 0, status.thumbnailTotalCount ?? 0),
      faceTotalCount: Math.max(existing.faceTotalCount || 0, status.faceTotalCount ?? 0),
      lastUpdated: new Date().toISOString(),
    };

    // Derive completed/percent from the now-protected totalPhotos rather
    // than trust the caller's own boolean/percent — a partial-scope caller
    // computes those using ITS OWN smaller local total (e.g.
    // `faceCompleted: currentScanned >= totalPhotos` where that totalPhotos
    // was only the first loaded page), so accepting them as-is could still
    // mark the library "done" prematurely even with totalPhotos itself now
    // protected above.
    if (merged.totalPhotos > 0) {
      merged.thumbnailCompleted = merged.thumbnailCachedCount >= merged.totalPhotos;
      merged.thumbnailPercent = Math.min(100, Math.round((merged.thumbnailCachedCount / merged.totalPhotos) * 100));
      merged.faceCompleted = merged.faceScannedCount >= merged.totalPhotos;
      merged.facePercent = Math.min(100, Math.round((merged.faceScannedCount / merged.totalPhotos) * 100));
    }

    this.cache[key] = merged;

    // 1. Persist to global userData file
    try {
      const p = getGlobalStatusFilePath();
      const dir = path.dirname(p);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(p, JSON.stringify(this.cache, null, 2), 'utf-8');
    } catch (err) {
      console.warn('[LibraryStatus] Failed to persist global status:', err);
    }

    // 2. Persist local sidecar into library directory if writable
    try {
      if (fs.existsSync(status.libraryPath)) {
        const localStatusFile = path.join(status.libraryPath, '.gphotos_status.json');
        fs.writeFileSync(localStatusFile, JSON.stringify(merged, null, 2), 'utf-8');
      }
    } catch {}

    return merged;
  }
}

export const libraryStatusService = new LibraryStatusService();
export default libraryStatusService;
