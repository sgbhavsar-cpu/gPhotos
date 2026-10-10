import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Reported bug: Organize Photos could hang the whole app on a synchronous fs call (statSync/
// existsSync/renameSync/...) against a file on a network storage that just went offline — those
// calls have no timeout and block the main process for the OS's full SMB timeout. Fixed by (a)
// converting every per-file fs call in generateDryRun/executeOrganization to its async equivalent,
// and (b) checking the networkReachabilityCache's global per-storage offline flag before touching
// a file, skipping it instead of attempting (and hanging on) the I/O.
const reachability = vi.hoisted(() => ({
  isPathReachable: vi.fn(async () => true),
  isKnownOfflineStorage: vi.fn(() => false),
}));
vi.mock('../../src/main/services/networkReachabilityCache', () => reachability);

import { generateDryRun } from '../../src/main/services/fileOrganizer';
import type { OrganizeOptions } from '../../src/types';

describe('fileOrganizer: skips rather than hangs when the source storage is offline', () => {
  let testRoot: string;
  let sourceDir: string;
  let targetDir: string;

  beforeEach(() => {
    reachability.isPathReachable.mockReset().mockResolvedValue(true);
    reachability.isKnownOfflineStorage.mockReset().mockReturnValue(false);
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gphotos_organizer_offline_test_'));
    sourceDir = path.join(testRoot, 'source');
    targetDir = path.join(testRoot, 'target');
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.mkdirSync(targetDir, { recursive: true });
  });

  afterEach(() => {
    try { fs.rmSync(testRoot, { recursive: true, force: true }); } catch {}
  });

  const options = (): OrganizeOptions => ({
    sourceDir, targetDir, structure: 'YYYY/YYYY-MM', mode: 'copy', conflictResolution: 'skip',
  });

  it('generateDryRun bails out immediately (no scan) when the whole source is unreachable', async () => {
    fs.writeFileSync(path.join(sourceDir, 'a.jpg'), 'x');
    reachability.isPathReachable.mockResolvedValue(false);

    const dryRun = await generateDryRun(options());

    expect(dryRun.totalFiles).toBe(0);
    expect(dryRun.items).toEqual([]);
    expect(dryRun.errors.some((e) => /not reachable/i.test(e))).toBe(true);
  });

  it('generateDryRun skips a file whose storage went offline mid-scan, and still processes the rest', async () => {
    fs.writeFileSync(path.join(sourceDir, 'ok.jpg'), 'x');
    const goneFile = path.join(sourceDir, 'gone.jpg');
    fs.writeFileSync(goneFile, 'x');
    reachability.isKnownOfflineStorage.mockImplementation((p: string) => p === goneFile);

    const dryRun = await generateDryRun(options());

    expect(dryRun.items.map((i) => path.basename(i.sourceFile))).toEqual(['ok.jpg']);
    expect(dryRun.errors.some((e) => e.includes('gone.jpg') && /offline/i.test(e))).toBe(true);
  });
});
