import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resetDbForTests } from '../../src/main/services/db';
import { setSetting } from '../../src/main/services/libraryRepository';
import {
  isPathReachable,
  isPathReachableForServing,
  isKnownOfflineStorage,
  clearOfflineCache,
  clearAllOfflineCache,
  resetReachabilityCacheForTests,
} from '../../src/main/services/networkReachabilityCache';

describe('networkReachabilityCache', () => {
  let tempDir: string;
  let networkRoot: string;
  let localDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gphotos_reachability_test_'));
    process.env.GPHOTOS_TEST_DB_DIR = tempDir;
    resetDbForTests();
    resetReachabilityCacheForTests();

    // A path that stands in for a configured network storage's source path
    // (deliberately never created on disk, so checks against it — and
    // anything under it — behave like an offline/unreachable share).
    networkRoot = path.join(tempDir, 'NeverExistsNetworkShare');
    localDir = path.join(tempDir, 'LocalLibrary');
    fs.mkdirSync(localDir, { recursive: true });

    setSetting('gphotos_virtual_storages_v1', [
      { id: 's1', name: 'TestNAS', networkSourcePath: networkRoot, localMirrorRoot: tempDir },
    ]);
  });

  afterEach(() => {
    resetReachabilityCacheForTests();
    resetDbForTests();
    delete process.env.GPHOTOS_TEST_DB_DIR;
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('returns true for a local file that actually exists', async () => {
    const realFile = path.join(localDir, 'photo.jpg');
    fs.writeFileSync(realFile, 'x');
    expect(await isPathReachable(realFile)).toBe(true);
  });

  it('does not report an existing folder as unreachable just because the event loop was blocked past the probe timeout', async () => {
    // Regression: a >1.5s main-process stall at startup made the probe's timeout
    // timer fire before the (already-finished) fs probe was processed, so every
    // synced storage looked deleted and was permanently unlinked.
    const pending = isPathReachable(localDir);
    const until = Date.now() + 2200; // block the loop longer than PROBE_TIMEOUT_MS (1500ms)
    while (Date.now() < until) { /* busy-wait: simulates a long synchronous stall */ }
    expect(await pending).toBe(true);
  });

  it('isPathReachableForServing: app-owned files skip the timeout race; missing ones are false; foreign paths still use the bounded probe', async () => {
    const owned = path.join(localDir, 'avatar.jpg');
    fs.writeFileSync(owned, 'x');
    // App-owned + present -> true even if the loop is blocked far past PROBE_TIMEOUT_MS
    const pending = isPathReachableForServing(owned, [localDir]);
    const until = Date.now() + 2200;
    while (Date.now() < until) { /* simulate a stall */ }
    expect(await pending).toBe(true);
    // App-owned + missing -> false (no timeout involved)
    expect(await isPathReachableForServing(path.join(localDir, 'nope.jpg'), [localDir])).toBe(false);
    // Not under an owned root -> falls back to isPathReachable (exists -> true)
    expect(await isPathReachableForServing(owned, [path.join(tempDir, 'somewhere-else')])).toBe(true);
    expect(await isPathReachableForServing('', [localDir])).toBe(false);
    // Nothing gets cached as an offline "storage"
    expect(isKnownOfflineStorage(path.join(localDir, 'nope.jpg'))).toBe(false);
  });

  it('returns false for a local file that does not exist, without caching anything (not a known network root)', async () => {
    const missingLocal = path.join(localDir, 'missing.jpg');
    expect(await isPathReachable(missingLocal)).toBe(false);
    // A local, non-configured path must never be treated as a "storage" —
    // it should never show up as a cached-offline root.
    expect(isKnownOfflineStorage(missingLocal)).toBe(false);
  });

  it('caches a configured network storage as offline after one failed probe, and skips re-probing other files under it', async () => {
    const fileA = path.join(networkRoot, 'sub', 'photoA.jpg');
    const fileB = path.join(networkRoot, 'sub2', 'photoB.jpg');

    expect(await isPathReachable(fileA)).toBe(false);
    expect(isKnownOfflineStorage(fileA)).toBe(true);
    // A DIFFERENT file under the same configured storage root must also
    // read as cached-offline, without needing its own probe.
    expect(isKnownOfflineStorage(fileB)).toBe(true);

    const tStart = Date.now();
    const reachable = await isPathReachable(fileB);
    const elapsedMs = Date.now() - tStart;
    expect(reachable).toBe(false);
    // A real probe (even a fast-failing one) still touches the filesystem;
    // a cache hit should be near-instant. 200ms is a generous ceiling well
    // under the module's own 1500ms probe timeout, so this only passes if
    // the cache genuinely short-circuited the second check.
    expect(elapsedMs).toBeLessThan(200);
  });

  it('clearOfflineCache lifts the cached-offline flag for that storage', async () => {
    const fileA = path.join(networkRoot, 'photoA.jpg');
    await isPathReachable(fileA);
    expect(isKnownOfflineStorage(fileA)).toBe(true);

    clearOfflineCache(networkRoot);
    expect(isKnownOfflineStorage(fileA)).toBe(false);

    // Clearing it doesn't fabricate reachability — the very next probe
    // (since the path still doesn't exist) re-establishes the offline
    // cache on its own.
    expect(await isPathReachable(fileA)).toBe(false);
    expect(isKnownOfflineStorage(fileA)).toBe(true);
  });

  it('clearOfflineCache also accepts a specific file path (not just the storage root) and resolves to the same storage', async () => {
    const fileA = path.join(networkRoot, 'nested', 'deep', 'photoA.jpg');
    await isPathReachable(fileA);
    expect(isKnownOfflineStorage(fileA)).toBe(true);

    clearOfflineCache(fileA);
    expect(isKnownOfflineStorage(fileA)).toBe(false);
  });

  it('clearAllOfflineCache resets every cached storage', async () => {
    const fileA = path.join(networkRoot, 'photoA.jpg');
    await isPathReachable(fileA);
    expect(isKnownOfflineStorage(fileA)).toBe(true);

    clearAllOfflineCache();
    expect(isKnownOfflineStorage(fileA)).toBe(false);
  });

  it('coalesces concurrent checks against the same path into one probe without erroring', async () => {
    const fileA = path.join(networkRoot, 'photoA.jpg');
    const [r1, r2, r3] = await Promise.all([
      isPathReachable(fileA),
      isPathReachable(fileA),
      isPathReachable(fileA),
    ]);
    expect(r1).toBe(false);
    expect(r2).toBe(false);
    expect(r3).toBe(false);
  });

  it('returns false immediately for an empty/undefined path', async () => {
    expect(await isPathReachable('')).toBe(false);
    expect(await isPathReachable(undefined)).toBe(false);
    expect(await isPathReachable(null)).toBe(false);
  });
});
