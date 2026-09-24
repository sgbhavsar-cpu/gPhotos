import fs from 'fs';
import { getSetting } from './libraryRepository';

// How long a "this storage is offline" result stays cached before a
// reachability check is willing to actually probe again on its own. The
// user can also force an immediate re-check via clearOfflineCache(), which
// is what the "Rescan" action on a network storage does.
const OFFLINE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// How long a single reachability probe is allowed to take before it's
// treated as unreachable. fs.existsSync/statSync have no timeout and can
// block for the OS's full SMB/network timeout (often 20s+) when the target
// is a dead mapped drive or UNC share — since these checks used to run
// synchronously in the Electron main process, that froze the entire app,
// not just the one photo that was loading. Bounding every probe here (and
// coalescing concurrent probes for the same storage into one) is what
// actually prevents that, independent of the offline cache below.
const PROBE_TIMEOUT_MS = 1500;

// If the probe timer fires this much later than scheduled, the event loop was
// blocked rather than the target being slow (see the re-arm in isPathReachable).
const LOOP_BLOCKED_LAG_MS = 500;

interface RootStatus {
  offline: boolean;
  lastCheckedAt: number;
}

const rootStatus = new Map<string, RootStatus>();
const inFlightProbes = new Map<string, Promise<boolean>>();

function normalize(p: string): string {
  return p.trim().toLowerCase().replace(/[\\/]+$/, '');
}

/**
 * Reads the currently configured virtual storages' network source paths.
 * Re-read on every call since storages can be added/removed at runtime.
 */
function getConfiguredNetworkRoots(): string[] {
  try {
    const storages = getSetting<Array<{ networkSourcePath?: string }>>('gphotos_virtual_storages_v1', []);
    return (storages || []).map((s) => s.networkSourcePath).filter((p): p is string => !!p);
  } catch {
    return [];
  }
}

/**
 * Finds which configured network storage root (if any) this path falls
 * under, so reachability is cached/circuit-broken per storage rather than
 * per individual file — if the whole share is down, there's no point
 * probing each of its thousand files separately. Returns null for
 * anything that isn't inside a configured network storage (e.g. a plain
 * local library path); those are always probed fresh (still bounded by
 * PROBE_TIMEOUT_MS, just never cached), so an unrelated local "does this
 * file exist yet" check can never be poisoned by an unrelated network
 * outage.
 */
function findNetworkRoot(filePath: string): string | null {
  const normalizedPath = normalize(filePath);
  for (const root of getConfiguredNetworkRoots()) {
    const normalizedRoot = normalize(root);
    if (!normalizedRoot) continue;
    if (normalizedPath === normalizedRoot || normalizedPath.startsWith(normalizedRoot + '\\') || normalizedPath.startsWith(normalizedRoot + '/')) {
      return normalizedRoot;
    }
  }
  return null;
}

/** True if this path falls under one of the configured network storage roots (online or not). */
export function isNetworkPath(filePath: string | undefined | null): boolean {
  if (!filePath) return false;
  return findNetworkRoot(filePath) !== null;
}

/** True if this path belongs to a network storage currently cached as offline. */
export function isKnownOfflineStorage(filePath: string | undefined | null): boolean {
  if (!filePath) return false;
  const root = findNetworkRoot(filePath);
  if (!root) return false;
  const status = rootStatus.get(root);
  if (!status || !status.offline) return false;
  return Date.now() - status.lastCheckedAt <= OFFLINE_CACHE_TTL_MS;
}

/**
 * Clears the cached offline flag for whatever storage this path (or a
 * storage's own networkSourcePath) belongs to, forcing the next
 * reachability check to actually probe again instead of assuming it's
 * still offline. Call this from an explicit user action (e.g. clicking
 * "Rescan" on a network storage) — never from an automatic/background
 * sync cycle, or the "don't keep hammering a dead share" behavior this
 * exists for would be defeated.
 */
export function clearOfflineCache(networkSourcePathOrFile: string): void {
  const root = findNetworkRoot(networkSourcePathOrFile) || normalize(networkSourcePathOrFile);
  rootStatus.delete(root);
}

/** Clears every cached offline flag (e.g. app restart, or a manual "check all" action). */
export function clearAllOfflineCache(): void {
  rootStatus.clear();
}

/**
 * Checks whether a file is currently reachable without risking hanging the
 * caller for the OS's full network timeout:
 *  - If this path's storage is already cached as offline (within the TTL),
 *    returns false immediately — no filesystem call at all.
 *  - Otherwise probes with fs.promises.access, racing it against
 *    PROBE_TIMEOUT_MS (and coalescing with any identical in-flight probe),
 *    then caches the result for known network storages.
 */
export async function isPathReachable(filePath: string | undefined | null): Promise<boolean> {
  if (!filePath) return false;

  const root = findNetworkRoot(filePath);
  if (root) {
    const status = rootStatus.get(root);
    if (status && status.offline && Date.now() - status.lastCheckedAt <= OFFLINE_CACHE_TTL_MS) {
      return false;
    }
  }

  const probeKey = root || normalize(filePath);
  const existing = inFlightProbes.get(probeKey);
  if (existing) return existing;

  const probePromise = (async () => {
    try {
      // A timer that fires much later than scheduled means the event loop
      // itself was blocked (a long sync stall in this process), not that the
      // path is slow — the probe's completion callback was just queued behind
      // it and hasn't had its turn yet, while Node runs timers first. Declaring
      // "unreachable" then made a local folder look deleted, and the renderer
      // permanently unlinked every storage on a slow startup. So re-arm once
      // (twice max) to give the probe its turn instead.
      const timeout = new Promise<boolean>((resolve) => {
        let retriesLeft = 2;
        let armedAt = Date.now();
        const fire = () => {
          const lag = Date.now() - armedAt - PROBE_TIMEOUT_MS;
          if (lag > LOOP_BLOCKED_LAG_MS && retriesLeft-- > 0) {
            armedAt = Date.now();
            setTimeout(fire, PROBE_TIMEOUT_MS);
          } else {
            resolve(false);
          }
        };
        setTimeout(fire, PROBE_TIMEOUT_MS);
      });
      const probe = fs.promises.access(filePath, fs.constants.F_OK).then(
        () => true,
        () => false
      );
      const reachable = await Promise.race([probe, timeout]);
      if (root) {
        rootStatus.set(root, { offline: !reachable, lastCheckedAt: Date.now() });
      }
      return reachable;
    } catch {
      if (root) {
        rootStatus.set(root, { offline: true, lastCheckedAt: Date.now() });
      }
      return false;
    } finally {
      inFlightProbes.delete(probeKey);
    }
  })();

  inFlightProbes.set(probeKey, probePromise);
  return probePromise;
}

/**
 * isPathReachable for the gphoto:// protocol handler. Files the app owns on
 * local disk (person avatars under userData, thumbnails under the mirror root)
 * can't hang like an SMB share, so they skip the timeout race: when hundreds
 * of these are requested at once (opening People), the probes queue behind
 * libuv's small thread pool, blow the 1.5s budget, and the handler answers
 * 404 — which Chromium then caches, leaving those images permanently broken.
 * Everything else (OneDrive/network/unknown paths) keeps the bounded probe.
 */
export async function isPathReachableForServing(filePath: string | undefined | null, appOwnedRoots: string[]): Promise<boolean> {
  if (!filePath) return false;
  const n = normalize(filePath);
  const owned = appOwnedRoots.some((r) => {
    const root = r ? normalize(r) : '';
    return root && (n === root || n.startsWith(root + '\\') || n.startsWith(root + '/'));
  });
  if (!owned) return isPathReachable(filePath);
  return fs.promises.access(filePath, fs.constants.F_OK).then(() => true, () => false);
}

/** Test-only: resets all cached state. */
export function resetReachabilityCacheForTests(): void {
  rootStatus.clear();
  inFlightProbes.clear();
}
