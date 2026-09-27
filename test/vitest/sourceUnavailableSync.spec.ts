import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Replace only the directory scan so a test controls the file list (and can pull the source away during it).
vi.mock('../../src/main/services/fileOrganizer', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/main/services/fileOrganizer')>();
  return {
    ...real,
    scanDirectoryRecursive: vi.fn(async (...args: Parameters<typeof real.scanDirectoryRecursive>) => {
      const override = (globalThis as any).__gphotosScanOverride as (() => string[]) | undefined;
      return override ? override() : real.scanDirectoryRecursive(...args);
    }),
  };
});

import { resetDbForTests } from '../../src/main/services/db';
import { syncVirtualStorage, loadStorageCheckpoint } from '../../src/main/services/virtualMirrorService';
import { resetReachabilityCacheForTests } from '../../src/main/services/networkReachabilityCache';
import { VirtualStorageConfig, MirrorProgress } from '../../src/types';

describe('sync stops when the source storage becomes unavailable', () => {
  let tempDir: string;
  let src: string;
  let storage: VirtualStorageConfig;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gphotos_srcgone_test_'));
    process.env.GPHOTOS_TEST_DB_DIR = tempDir;
    resetDbForTests();
    resetReachabilityCacheForTests();
    src = path.join(tempDir, 'NetworkSource');
    fs.mkdirSync(src, { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'Mirrors'), { recursive: true });
    storage = { id: 'storage_gone', name: 'GoneStorage', networkSourcePath: src, localMirrorRoot: path.join(tempDir, 'Mirrors') };
  });

  afterEach(() => {
    delete (globalThis as any).__gphotosScanOverride;
    resetDbForTests();
    delete process.env.GPHOTOS_TEST_DB_DIR;
    vi.restoreAllMocks();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  const fakeFiles = (n: number) => Array.from({ length: n }, (_, i) => path.join(src, `IMG_${i}.jpg`));

  it('stops after a few failures instead of failing every remaining file, and says so clearly', async () => {
    const files = fakeFiles(500);
    // The source disappears right after the file list is read (unplugged drive / dropped share).
    (globalThis as any).__gphotosScanOverride = () => {
      fs.rmSync(src, { recursive: true, force: true });
      return files;
    };
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const progress: MirrorProgress[] = [];

    const result = await syncVirtualStorage(storage, (p) => progress.push(p));

    expect(result.success).toBe(false);
    expect(result.sourceUnavailable).toBe(true);
    expect(result.errors[0]).toMatch(/became unavailable/i);
    expect(result.errors.length).toBeLessThan(10); // not one entry per remaining file
    expect(errorLog.mock.calls.length).toBeLessThan(10); // and no per-file log flood
    expect(progress.some((p) => p.status === 'error' && /unavailable/i.test(p.errorMessage || ''))).toBe(true);
    expect(progress.some((p) => p.status === 'completed')).toBe(false);

    // Not marked completed, and not resumable by a (re-ordered) array index.
    const cp = loadStorageCheckpoint(storage.name, storage.localMirrorRoot);
    expect(cp?.phase).toBe('interrupted');
    expect(cp?.lastProcessedIndex).toBe(0);
  }, 60000);

  it('keeps going through bad files while the source is still reachable (no false stop)', async () => {
    (globalThis as any).__gphotosScanOverride = () => fakeFiles(12); // source dir still exists; the files do not
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await syncVirtualStorage(storage);

    expect(result.sourceUnavailable).toBeUndefined();
    expect(result.success).toBe(false); // the bad files are real errors...
    expect(result.errors.length).toBe(12); // ...and every one was attempted and reported
    expect(loadStorageCheckpoint(storage.name, storage.localMirrorRoot)?.phase).toBe('completed');
  }, 60000);
});
