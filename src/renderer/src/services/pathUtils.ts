/**
 * Joins a virtual storage's local mirror root with its name, matching
 * whichever path separator the root itself already uses — the renderer has
 * no access to Node's path module (especially not the browser/mobile
 * client), and a literal '\\' broke every mirror path on Linux/macOS hosts
 * (e.g. "/root/GPhotos_VirtualMirrors\\TestNAS", which isn't a valid path on
 * either OS).
 */
export function joinMirrorPath(root: string, name: string): string {
  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  return `${root.replace(/[\\/]+$/, '')}${sep}${name}`;
}

/**
 * True when `path` is `root` itself or somewhere below it. Separator- and case-insensitive (Windows paths),
 * ignores trailing slashes. Purely lexical: the main process re-checks real paths before anything is moved.
 */
export function isPathInsideRoot(path: string | null | undefined, root: string | null | undefined): boolean {
  if (!path || !root) return false;
  const norm = (p: string) => p.trim().replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
  const p = norm(path);
  const r = norm(root);
  if (!r) return false;
  return p === r || p.startsWith(r + '/');
}

/** A single folder name: no separators, no characters Windows forbids, not "." / "..", no trailing dot or space. */
export function isValidFolderName(name: string): boolean {
  const n = name.trim();
  if (!n || n === '.' || n === '..') return false;
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(n)) return false;
  return !/[. ]$/.test(n) && n.length <= 200;
}

/** `dir` + `name`, using whichever separator `dir` already uses. */
export function joinChildPath(dir: string, name: string): string {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return `${dir.replace(/[\\/]+$/, '')}${sep}${name.trim()}`;
}
