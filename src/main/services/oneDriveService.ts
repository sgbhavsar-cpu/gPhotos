import path from 'path';
import os from 'os';
import fs from 'fs';
import { execFile } from 'child_process';
import { getSetting, setSetting } from './libraryRepository';

// OneDrive Files On-Demand keeps photos as local "placeholder" files that
// download transparently on first read (fs.readFile just works, no code
// changes needed) but never give the disk space back on their own. This
// module detects which folders are OneDrive sync roots and, once the app is
// done reading a file for thumbnailing/face detection, marks it "unpinned"
// so OneDrive's own background process is free to dehydrate it back to
// cloud-only. Nothing is deleted — the file stays safe in the cloud copy.

const RECLAIM_ENABLED_SETTING = 'onedrive_reclaim_enabled';

function normalizeRoot(p: string): string {
  return path.resolve(p).toLowerCase().replace(/[\\/]+$/, '');
}

/**
 * OneDrive publishes its sync-root folder(s) as user environment variables,
 * refreshed every time the OneDrive client starts: OneDrive/OneDriveConsumer
 * for the personal account, OneDriveCommercial (and OneDrive_1, OneDrive_2,
 * ... for multiple work/school tenants) for business accounts. Reading these
 * needs no registry access and no manual configuration from the user.
 */
export function detectOneDriveRoots(): string[] {
  if (process.platform !== 'win32') return [];
  const roots = new Set<string>();
  for (const [key, value] of Object.entries(process.env)) {
    if (value && /^OneDrive/i.test(key)) {
      roots.add(normalizeRoot(value));
    }
  }
  return [...roots];
}

// Environment variables don't change during the app's lifetime, so the
// detected roots are computed once and cached.
let cachedRoots: string[] | null = null;
function getRoots(): string[] {
  if (cachedRoots === null) {
    cachedRoots = detectOneDriveRoots();
  }
  return cachedRoots;
}

export function isOneDrivePath(filePath: string | undefined | null): boolean {
  if (!filePath || process.platform !== 'win32') return false;
  const normalized = normalizeRoot(filePath);
  return getRoots().some((root) => normalized === root || normalized.startsWith(root + path.sep));
}

export function isReclaimEnabled(): boolean {
  return getSetting<boolean>(RECLAIM_ENABLED_SETTING, true);
}

export function setReclaimEnabled(enabled: boolean): void {
  setSetting<boolean>(RECLAIM_ENABLED_SETTING, enabled);
}

export function getOneDriveStatus(): { detectedRoots: string[]; reclaimEnabled: boolean; supported: boolean } {
  return {
    detectedRoots: getRoots(),
    reclaimEnabled: isReclaimEnabled(),
    supported: process.platform === 'win32',
  };
}

/**
 * Marks a OneDrive file "unpinned" (attrib +U -P) — the Files On-Demand
 * state meaning "eligible to free up space". OneDrive's own sync engine
 * dehydrates it back to cloud-only on its own schedule (usually promptly,
 * not instant or guaranteed), same as picking "Free up space" in Explorer.
 * A no-op — never even shells out — for non-Windows, non-OneDrive paths, or
 * when the user has turned the setting off.
 */
export function markFileForSpaceReclaim(filePath: string): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    if (!isOneDrivePath(filePath)) {
      resolve({ success: false, error: 'not-a-onedrive-path' });
      return;
    }
    if (!isReclaimEnabled()) {
      resolve({ success: false, error: 'reclaim-disabled' });
      return;
    }
    execFile('attrib', ['+U', '-P', filePath], { windowsHide: true }, (err) => {
      resolve(err ? { success: false, error: err.message } : { success: true });
    });
  });
}

export async function markFilesForSpaceReclaim(filePaths: string[]): Promise<{ markedCount: number }> {
  let markedCount = 0;
  for (const fp of filePaths) {
    const res = await markFileForSpaceReclaim(fp);
    if (res.success) {
      markedCount++;
      recordPendingReclaimCheck(fp);
    }
  }
  return { markedCount };
}

// ---------------------------------------------------------------------------
// Reclaim health tracking: verifies OneDrive is actually giving the space
// back, not just that the unpin flag was set. A file that stays hydrated for
// a long time after being unpinned (OneDrive account signed out, sync
// paused, "Always keep on this device" set at the folder level overriding
// the per-file flag, etc.) means every subsequent scan would just keep
// filling the disk with nothing ever reclaiming it — exactly what this
// feature exists to prevent. So callers of the unified sync+detect+unpin
// loop should check getReclaimHealth().broken before continuing and stop
// with a clear message if it's true, rather than grinding on regardless.
// ---------------------------------------------------------------------------

const PENDING_CHECKS_SETTING = 'onedrive_pending_reclaim_checks';
const RECENT_RESULTS_SETTING = 'onedrive_reclaim_recent_results';
const BROKEN_FLAG_SETTING = 'onedrive_reclaim_broken';

// How long to wait after unpinning before checking whether OneDrive actually
// dehydrated the file — dehydration is not instant, so checking too soon
// would just produce false "still hydrated" failures.
const RECLAIM_CHECK_DELAY_MS = 3 * 60 * 1000; // 3 minutes
// Require at least this many checked results before the failure rate is
// trusted enough to trip the circuit breaker — a couple of slow files early
// on shouldn't halt everything.
const RECLAIM_MIN_SAMPLE = 8;
// Fraction of the recent results (see ring buffer size below) that must
// still be hydrated for reclaim to be considered broken.
const RECLAIM_FAILURE_THRESHOLD = 0.7;
const RECENT_RESULTS_RING_SIZE = 20;
const PENDING_LIST_MAX = 500;

interface PendingReclaimEntry {
  filePath: string;
  markedAt: number;
}

function recordPendingReclaimCheck(filePath: string): void {
  const pending = getSetting<PendingReclaimEntry[]>(PENDING_CHECKS_SETTING, []);
  pending.push({ filePath, markedAt: Date.now() });
  // Cap the list so a very large library can't grow this unboundedly —
  // drop the oldest entries first, they're the most likely to already have
  // been checked or to be stale duplicates anyway.
  const trimmed = pending.length > PENDING_LIST_MAX ? pending.slice(pending.length - PENDING_LIST_MAX) : pending;
  setSetting(PENDING_CHECKS_SETTING, trimmed);
}

/**
 * Batched check of whether a set of files are still hydrated locally, via
 * the Windows Cloud Files "Offline" attribute (set once OneDrive actually
 * dehydrates a placeholder back to cloud-only). One PowerShell process for
 * the whole batch rather than one per file — spawning a process per file
 * would be far too slow for anything but a handful of files.
 */
async function checkFilesHydrated(paths: string[]): Promise<Record<string, boolean>> {
  if (paths.length === 0 || process.platform !== 'win32') return {};

  const tmpFile = path.join(os.tmpdir(), `gphotos_hydration_check_${Date.now()}_${Math.random().toString(36).slice(2)}.json`);
  try {
    fs.writeFileSync(tmpFile, JSON.stringify(paths), 'utf-8');
  } catch {
    return {};
  }

  const escapedTmpPath = tmpFile.replace(/'/g, "''");
  const script = [
    '$ErrorActionPreference = "SilentlyContinue"',
    `$paths = Get-Content -Raw -LiteralPath '${escapedTmpPath}' | ConvertFrom-Json`,
    '$results = @{}',
    'foreach ($p in $paths) {',
    '  try {',
    '    $attrs = (Get-Item -LiteralPath $p -Force).Attributes.ToString()',
    '    $results[$p] = [bool]($attrs -notmatch "Offline")',
    '  } catch {',
    '    $results[$p] = $false',
    '  }',
    '}',
    '$results | ConvertTo-Json -Compress',
  ].join('; ');

  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout) => {
        try {
          fs.unlinkSync(tmpFile);
        } catch {}
        if (err || !stdout) {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(stdout.trim()) || {});
        } catch {
          resolve({});
        }
      }
    );
  });
}

/**
 * Checks whichever pending entries are now old enough to have had a fair
 * chance to dehydrate, records each as a success/failure in the rolling
 * results buffer, and trips the "broken" flag if failures dominate. Cheap
 * to call often — it's a no-op whenever nothing is due yet.
 */
export async function runReclaimHealthCheck(): Promise<{ checked: number; stillHydrated: number }> {
  if (process.platform !== 'win32') return { checked: 0, stillHydrated: 0 };

  const pending = getSetting<PendingReclaimEntry[]>(PENDING_CHECKS_SETTING, []);
  const now = Date.now();
  const due = pending.filter((e) => now - e.markedAt >= RECLAIM_CHECK_DELAY_MS);
  if (due.length === 0) return { checked: 0, stillHydrated: 0 };

  const notYetDue = pending.filter((e) => now - e.markedAt < RECLAIM_CHECK_DELAY_MS);
  const hydrationByPath = await checkFilesHydrated(due.map((e) => e.filePath));

  const recentResults = getSetting<boolean[]>(RECENT_RESULTS_SETTING, []);
  let stillHydrated = 0;
  for (const entry of due) {
    // A file the check couldn't read at all (e.g. deleted since, or a
    // transient error) isn't evidence either way — skip it rather than
    // counting it as a failure.
    if (!(entry.filePath in hydrationByPath)) continue;
    const isStillHydrated = hydrationByPath[entry.filePath];
    if (isStillHydrated) stillHydrated++;
    recentResults.push(isStillHydrated);
  }
  const trimmedResults = recentResults.length > RECENT_RESULTS_RING_SIZE
    ? recentResults.slice(recentResults.length - RECENT_RESULTS_RING_SIZE)
    : recentResults;
  setSetting(RECENT_RESULTS_SETTING, trimmedResults);
  setSetting(PENDING_CHECKS_SETTING, notYetDue);

  if (trimmedResults.length >= RECLAIM_MIN_SAMPLE) {
    const failureRate = trimmedResults.filter(Boolean).length / trimmedResults.length;
    setSetting(BROKEN_FLAG_SETTING, failureRate >= RECLAIM_FAILURE_THRESHOLD);
  }

  return { checked: due.length, stillHydrated };
}

export function getReclaimHealth(): {
  broken: boolean;
  pendingCount: number;
  recentFailureRate: number;
  checkedCount: number;
} {
  const recentResults = getSetting<boolean[]>(RECENT_RESULTS_SETTING, []);
  const pending = getSetting<PendingReclaimEntry[]>(PENDING_CHECKS_SETTING, []);
  return {
    broken: getSetting<boolean>(BROKEN_FLAG_SETTING, false),
    pendingCount: pending.length,
    recentFailureRate: recentResults.length > 0
      ? recentResults.filter(Boolean).length / recentResults.length
      : 0,
    checkedCount: recentResults.length,
  };
}

/** Clears the broken flag and result history — used by a "Retry" action in the UI. */
export function resetReclaimHealth(): void {
  setSetting(RECENT_RESULTS_SETTING, []);
  setSetting(BROKEN_FLAG_SETTING, false);
}
