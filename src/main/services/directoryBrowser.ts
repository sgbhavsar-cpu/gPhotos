import fs from 'fs';
import path from 'path';
import os from 'os';

export interface DirBrowseEntry {
  name: string;
  path: string;
}

export interface DirBrowseResult {
  path: string | null;
  parent: string | null;
  entries: DirBrowseEntry[];
  error?: string;
}

function listWindowsDrives(): DirBrowseEntry[] {
  const drives: DirBrowseEntry[] = [];
  for (let i = 65; i <= 90; i++) {
    const drivePath = `${String.fromCharCode(i)}:\\`;
    try {
      if (fs.existsSync(drivePath)) {
        drives.push({ name: drivePath, path: drivePath });
      }
    } catch {}
  }
  return drives;
}

/**
 * Lists the subfolders of a directory for a "browse for a folder" dialog —
 * the mobile/LAN web client has no native OS folder picker, so this lets it
 * show one built from the actual host filesystem instead of asking the user
 * to type an absolute path from memory (which is what the app fell back to
 * before this existed, and what the Electron desktop dialog never required).
 *
 * Given no path: Windows returns its drive letters as roots (there's no
 * single filesystem root to start from); every other platform starts at the
 * user's home directory.
 */
export function browseDirectory(targetPath?: string | null): DirBrowseResult {
  if (!targetPath) {
    if (process.platform === 'win32') {
      return { path: null, parent: null, entries: listWindowsDrives() };
    }
    return browseDirectory(os.homedir());
  }

  try {
    const resolved = path.resolve(targetPath);
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      return { path: resolved, parent: path.dirname(resolved), entries: [], error: 'Not a directory' };
    }

    const dirents = fs.readdirSync(resolved, { withFileTypes: true });
    const entries: DirBrowseEntry[] = dirents
      .filter((d) => {
        if (!d.isDirectory() || d.name.startsWith('.')) return false;
        // Skip this app's own per-library index folder — never a meaningful
        // pick, and clutters what should be a clean list of photo folders.
        if (d.name === '.gphotos_catalog') return false;
        return true;
      })
      .map((d) => ({ name: d.name, path: path.join(resolved, d.name) }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

    const dirnameResult = path.dirname(resolved);
    // dirname("/") === "/" and dirname("C:\\") === "C:\\" — both signal
    // "already at a root", so there's nowhere further up to go (on Windows,
    // the caller falls back to re-requesting the drive list instead).
    const parent = dirnameResult !== resolved ? dirnameResult : null;

    return { path: resolved, parent, entries };
  } catch (err: any) {
    return { path: targetPath, parent: null, entries: [], error: err.message || 'Failed to read directory' };
  }
}
