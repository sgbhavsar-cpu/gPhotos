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
export function getAllowedRoots(): string[] {
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

  try {
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') {
      roots.add(app.getPath('userData'));
      roots.add(app.getPath('temp'));
    }
  } catch {}

  return Array.from(roots).filter(Boolean);
}

function normalize(p: string): string {
  return path.resolve(p).toLowerCase().replace(/[\\/]+$/, '');
}

export function isPathAllowed(candidatePath: string | undefined | null): boolean {
  if (!candidatePath) return false;
  let resolved: string;
  try {
    resolved = normalize(candidatePath);
  } catch {
    return false;
  }

  for (const root of getAllowedRoots()) {
    let resolvedRoot: string;
    try {
      resolvedRoot = normalize(root);
    } catch {
      continue;
    }
    if (resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep)) {
      return true;
    }
  }
  return false;
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
