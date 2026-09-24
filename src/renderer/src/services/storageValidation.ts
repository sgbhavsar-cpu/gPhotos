import { VirtualStorageConfig } from '../../types';

/**
 * Checks each configured storage's local mirror folder against disk and
 * splits the list into what's still real vs. what's gone. The mirror folder
 * is the source of truth for whether a storage still "exists" — the config
 * itself is just a settings record that necessarily lives somewhere else
 * (it has to exist before the first sync ever creates that folder).
 *
 * There were previously two separate copies of this check (App.tsx and
 * VirtualStorageView.tsx), which is exactly how a folder deleted outside the
 * app kept reappearing in one screen after being fixed in the other — this
 * is the one place it should happen now, called from both.
 */
export async function splitStoragesByExistence(
  list: VirtualStorageConfig[],
  checkFileExists: (path: string) => Promise<boolean>
): Promise<{ valid: VirtualStorageConfig[]; removed: VirtualStorageConfig[] }> {
  if (list.length === 0) return { valid: [], removed: [] };

  // Pruning is permanent (the name is blacklisted), so a "missing" verdict is
  // re-checked once before it's believed — a transient false (busy/blocked
  // main process at startup) must never delete a storage.
  const checkTwice = async (p: string): Promise<boolean> => {
    if (await checkFileExists(p).catch(() => true)) return true;
    await new Promise((r) => setTimeout(r, 2000));
    return checkFileExists(p).catch(() => true);
  };

  const checks = await Promise.all(
    list.map(async (s) => {
      // A storage that has never completed even one sync (no lastSynced,
      // nothing mirrored yet) legitimately has no mirror folder on disk —
      // that's expected, not evidence it was deleted. Checking it here was
      // a real bug: a brand-new "Add Storage" entry would get silently
      // deleted and blacklisted the very next time this ran, before the
      // very first sync it was waiting on ever got a chance to create the
      // folder. Only storages with actual sync history are eligible to be
      // pruned for a folder that's gone missing.
      const neverSynced = !s.lastSynced && !s.totalItems;
      if (neverSynced) {
        return { storage: s, exists: true };
      }
      return {
        storage: s,
        exists: await checkTwice(`${s.localMirrorRoot}\\${s.name}`),
      };
    })
  );

  return {
    valid: checks.filter((c) => c.exists).map((c) => c.storage),
    removed: checks.filter((c) => !c.exists).map((c) => c.storage),
  };
}

/**
 * Whether a storage's remote source lives under a detected OneDrive
 * Files-On-Demand root, meaning it should go through the unified per-photo
 * sync+face+reclaim pipeline instead of a bulk pass.
 *
 * Previously duplicated inline in VirtualStorageView.tsx only — App.tsx's
 * own refresh path (the sidebar's mini-refresh icon, plus onRefreshNetwork)
 * had no such check at all and always ran the old bulk syncVirtualStorage,
 * hydrating every remote original at once before any reclaim happened. That
 * silently defeated the whole point of the unified pipeline for any OneDrive
 * storage refreshed from the sidebar instead of the Network Storage screen.
 */
export function isOneDriveBackedPath(sourcePath: string, oneDriveRoots: string[]): boolean {
  if (!sourcePath || oneDriveRoots.length === 0) return false;
  const normalized = sourcePath.toLowerCase();
  return oneDriveRoots.some((root) => normalized.startsWith(root.toLowerCase()));
}
