import fs from 'fs';
import os from 'os';
import path from 'path';
import { getSetting } from './libraryRepository';
import { VirtualStorageConfig } from '../../types';

/**
 * Default local root for virtual/network storage mirrors when the user
 * hasn't configured a custom one. Windows keeps the long-standing
 * C:\GPhotos_VirtualMirrors default (existing installs already have data
 * there); other platforms have no C: drive to anchor to, so they get an
 * equivalent folder under the user's home directory instead.
 */
export function getDefaultMirrorRoot(): string {
  if (process.platform === 'win32') {
    return 'C:\\GPhotos_VirtualMirrors';
  }
  return path.join(os.homedir(), 'GPhotos_VirtualMirrors');
}

/**
 * Computes every filesystem root the app currently considers "known/trusted"
 * for operations that read arbitrary file content or delete files: the
 * active and recently-used library folders, every configured virtual
 * storage's local mirror root and remote network source, the default
 * virtual-mirror discovery root, and the app's own userData/temp directories.
 *
 * Deliberately NOT used to restrict "browse the filesystem to pick a new
 * folder" operations (the native folder dialog, scanner:scan-directory,
 * storage:read-directory-tree, the date-organizer's source/target dirs) —
 * those are explicitly meant to work on any folder the user points them at,
 * and the user already has that same filesystem access via Explorer.
 */
export function getAllowedRoots(includeAppDirs: boolean = true): string[] {
  const roots = new Set<string>();

  try {
    const selectedFolder = getSetting<string | null>('selectedFolder', null);
    if (selectedFolder) roots.add(selectedFolder);
  } catch {}

  try {
    const recentLibraries = getSetting<string[]>('recentLibraries', []);
    for (const lib of recentLibraries) {
      if (lib) roots.add(lib);
    }
  } catch {}

  try {
    const storages = getSetting<VirtualStorageConfig[]>('gphotos_virtual_storages_v1', []);
    for (const s of storages) {
      if (s.localMirrorRoot && s.name) roots.add(path.join(s.localMirrorRoot, s.name));
      if (s.localMirrorRoot) roots.add(s.localMirrorRoot);
      if (s.networkSourcePath) roots.add(s.networkSourcePath);
    }
  } catch {}

  roots.add(getDefaultMirrorRoot());

  if (includeAppDirs) {
    try {
      const { app } = require('electron');
      if (app && typeof app.getPath === 'function') {
        roots.add(app.getPath('userData'));
        roots.add(app.getPath('temp'));
      }
    } catch {}
  }

  return Array.from(roots).filter(Boolean);
}

/**
 * Roots for the LAN/mobile HTTP server. Narrower than getAllowedRoots(): no
 * userData (auth file with the PIN + token hashes, settings DB) and no OS
 * temp dir. The only app-internal folder a paired device legitimately needs
 * is the HEIC high-quality temp dir that /api/heic/prepare-hq hands back.
 */
export function getRemoteAllowedRoots(): string[] {
  const roots = getAllowedRoots(false);
  try {
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') {
      roots.push(path.join(app.getPath('userData'), 'temp_hq'));
    }
  } catch {}
  return roots;
}

const IS_WIN = process.platform === 'win32';
const REALPATH_TTL_MS = 5000;
const REALPATH_CACHE_MAX = 2000;
const realpathCache = new Map<string, { value: string; at: number }>();

/** Test hook: drop the short-lived realpath cache. */
export function clearPathSecurityCache(): void {
  realpathCache.clear();
}

function isUncPath(p: string): boolean {
  return IS_WIN && /^[\\/]{2}/.test(p);
}

/**
 * realpath of `p`, or — if it does not exist (yet) — realpath of its nearest
 * existing ancestor with the missing tail re-appended. Cached for a few
 * seconds because this runs per HTTP request. UNC paths are left lexical:
 * a sync realpath against an unreachable share can stall the main process.
 */
function realpathLoose(p: string): string {
  const abs = path.resolve(p);
  if (isUncPath(abs)) return abs;
  const now = Date.now();
  const hit = realpathCache.get(abs);
  if (hit && now - hit.at < REALPATH_TTL_MS) return hit.value;

  let cur = abs;
  let tail = '';
  let value = abs;
  for (;;) {
    try {
      value = path.join(fs.realpathSync.native(cur), tail);
      break;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) { value = abs; break; }
      tail = tail ? path.join(path.basename(cur), tail) : path.basename(cur);
      cur = parent;
    }
  }
  if (realpathCache.size >= REALPATH_CACHE_MAX) realpathCache.clear();
  realpathCache.set(abs, { value, at: now });
  return value;
}

/** Real (link-resolved), case-folded on Windows only, no trailing separator except for a filesystem root. */
function normalize(p: string): string {
  let r = realpathLoose(p);
  if (IS_WIN) r = r.toLowerCase();
  const root = path.parse(r).root;
  return r.length > root.length ? r.replace(/[\\/]+$/, '') : r;
}

/**
 * Candidates must be absolute. Both candidate and roots are resolved through
 * symlinks/junctions (or their nearest existing ancestor) before the prefix
 * compare, so a link inside an allowed root that points outside is rejected.
 * A root that IS a filesystem root ('/' or 'C:') allows everything beneath
 * it, but only because it was explicitly configured. UNC paths are compared
 * lexically (no realpath), so links on network shares are not resolved.
 */
function isUnderRoots(candidatePath: string | undefined | null, roots: string[]): boolean {
  if (!candidatePath || typeof candidatePath !== 'string' || candidatePath.includes('\0')) return false;
  if (!path.isAbsolute(candidatePath)) return false;
  let resolved: string;
  try {
    resolved = normalize(candidatePath);
  } catch {
    return false;
  }

  for (const root of roots) {
    if (!root || typeof root !== 'string' || !path.isAbsolute(root)) continue;
    let resolvedRoot: string;
    try {
      resolvedRoot = normalize(root);
    } catch {
      continue;
    }
    const prefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep;
    if (resolved === resolvedRoot || resolved.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}

export function isPathAllowed(candidatePath: string | undefined | null): boolean {
  return isUnderRoots(candidatePath, getAllowedRoots());
}

/** Same check against the narrower remote (LAN/mobile) allow-list; requires an absolute path. */
export function isPathAllowedRemote(candidatePath: string | undefined | null): boolean {
  if (!candidatePath || typeof candidatePath !== 'string' || !path.isAbsolute(candidatePath)) return false;
  return isUnderRoots(candidatePath, getRemoteAllowedRoots());
}

/**
 * True if `child` (a storage name or relative sub-path) stays inside `base`
 * once joined — rejects absolute paths, `..` segments and separators that
 * escape the base.
 */
export function isSafeRelativeName(child: unknown): child is string {
  if (typeof child !== 'string' || !child || child.includes('\0')) return false;
  if (path.isAbsolute(child) || /^[a-zA-Z]:/.test(child)) return false;
  const rel = path.relative('/base', path.resolve('/base', child));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Throws if candidatePath is not inside any known/trusted root. */
export function assertPathAllowed(candidatePath: string | undefined | null, context: string): void {
  if (!isPathAllowed(candidatePath)) {
    throw new Error(`Access denied: path is outside the app's known library/mirror folders (${context}).`);
  }
}

/** Same as assertPathAllowed, but for a batch of paths — all must be allowed. */
export function assertPathsAllowed(paths: Array<string | undefined | null>, context: string): void {
  for (const p of paths) {
    assertPathAllowed(p, context);
  }
}
