// Per-photo "image version", appended to photo URLs (`&v=N`) as a cache key.
//
// Chromium reuses an <img>'s bitmap for an identical URL within a page (measured: even `Cache-Control: no-cache`
// + ETag does not make a second load of the same URL ask the server again), and keeps disk-cached responses
// across restarts. A photo whose pixels change on disk while its path stays the same (a physical rotation) would
// therefore keep showing the OLD pixels everywhere that re-loads it. Bumping the version changes the URL, which
// forces a fresh fetch; it is remembered in localStorage so the new URL also survives a restart.

const STORAGE_KEY = 'gphotos_image_versions_v1';
const MAX_ENTRIES = 5000; // oldest are dropped first; a dropped entry only means one harmless extra cache miss

let versions: Map<string, number> | null = null;

const normalize = (p: string) => p.trim().toLowerCase().replace(/\\/g, '/');

function load(): Map<string, number> {
  if (versions) return versions;
  versions = new Map();
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
    if (raw) {
      for (const [k, v] of Object.entries(JSON.parse(raw) as Record<string, number>)) {
        if (typeof v === 'number' && v > 0) versions.set(k, v);
      }
    }
  } catch {
    // unreadable/blocked storage: start empty, the app still works (versions just are not remembered)
  }
  return versions;
}

function persist(map: Map<string, number>) {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(map)));
  } catch {}
}

/** 0 when the photo was never changed on disk by this app. */
export function getImageVersion(filePath: string | undefined | null): number {
  if (!filePath) return 0;
  return load().get(normalize(filePath)) || 0;
}

/** Call after a photo's pixels changed on disk. Pass every path the photo is displayed under. */
export function bumpImageVersion(...filePaths: Array<string | undefined | null>): void {
  const map = load();
  for (const p of filePaths) {
    if (!p) continue;
    const key = normalize(p);
    const next = (map.get(key) || 0) + 1;
    map.delete(key); // re-insert so the most recently changed stay last
    map.set(key, next);
  }
  while (map.size > MAX_ENTRIES) map.delete(map.keys().next().value as string);
  persist(map);
}

/** Test-only. */
export function resetImageVersionsForTests(): void {
  versions = null;
}
