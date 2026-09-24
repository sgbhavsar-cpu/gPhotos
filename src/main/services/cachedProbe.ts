/**
 * A last-known-value cache for something slow to look up (spawning `reg.exe`,
 * `tasklist`...). `get()` NEVER blocks: it returns the last known value
 * immediately and, when that value is older than `ttlMs`, starts ONE background
 * refresh. The synchronous `execSync('reg query')` this replaces cost 1-3s of
 * frozen main process per call (each launch is virus-scanned), and the
 * renderer asks for the service status from several screens.
 */
export function createCachedProbe<T>(probe: () => Promise<T>, ttlMs: number, initial: T) {
  let value = initial;
  let checkedAt = 0;
  let known = false;
  let inFlight = false;

  const refresh = (): void => {
    if (inFlight) return;
    inFlight = true;
    probe()
      .then((v) => {
        value = v;
        checkedAt = Date.now();
        known = true;
      })
      .catch(() => {
        /* keep the last known value; retry on the next stale read */
      })
      .finally(() => {
        inFlight = false;
      });
  };

  return {
    get(): T {
      if (!known || Date.now() - checkedAt > ttlMs) refresh();
      return value;
    },
    /** Record a value we just caused (e.g. after writing the registry), so the next read is already right. */
    set(v: T): void {
      value = v;
      checkedAt = Date.now();
      known = true;
    },
    refresh,
  };
}
