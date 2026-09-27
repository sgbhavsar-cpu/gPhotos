import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';

// Lets a test replace the directory scan (200k fake paths) while everything else in fileOrganizer stays real.
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
import { syncVirtualStorage } from '../../src/main/services/virtualMirrorService';
import { VirtualStorageConfig } from '../../src/types';

// Reported against a real ~818k-photo library: "Failed to prioritize already-scanned photos ... RangeError:
// Maximum call stack size exceeded" (remoteFiles.push(...hugeArray) after remoteFiles.length = 0), followed by
// "The 'path' argument must be of type string. Received undefined" because the emptied list was then indexed.
describe('syncVirtualStorage on a library far larger than the call-stack argument limit', () => {
  let tempDir: string;
  let storage: VirtualStorageConfig;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gphotos_largesync_test_'));
    process.env.GPHOTOS_TEST_DB_DIR = tempDir;
    resetDbForTests();
    const src = path.join(tempDir, 'NetworkSource');
    fs.mkdirSync(src, { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'Mirrors'), { recursive: true });
    for (let i = 0; i < 3; i++) {
      await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: i * 30, g: 10, b: 10 } } })
        .jpeg()
        .toFile(path.join(src, `IMG_${i}.jpg`));
    }
    storage = { id: 'storage_large', name: 'BigStorage', networkSourcePath: src, localMirrorRoot: path.join(tempDir, 'Mirrors') };
  }, 30000);

  afterEach(() => {
    delete (globalThis as any).__gphotosScanOverride;
    resetDbForTests();
    delete process.env.GPHOTOS_TEST_DB_DIR;
    vi.restoreAllMocks();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('prioritises already-scanned photos among 200k entries without a RangeError or an emptied list', async () => {
    // 1) A real first pass so the library DB has completed face scans (doneIds is non-empty).
    const first = await syncVirtualStorage(storage);
    expect(first.success).toBe(true);

    // 2) Second pass over a huge list: the 3 real files plus 200k fake ones.
    const real = fs.readdirSync(storage.networkSourcePath).map((f) => path.join(storage.networkSourcePath, f));
    const fake = Array.from({ length: 200_000 }, (_, i) => path.join(storage.networkSourcePath, 'sub', `fake_${i}.jpg`));
    (globalThis as any).__gphotosScanOverride = () => [...fake, ...real];

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Stop right after the prioritisation step (the first progress event is emitted just after it).
    await expect(
      syncVirtualStorage(storage, () => {
        throw new Error('stop-after-prioritise');
      })
    ).rejects.toThrow('stop-after-prioritise');

    const messages = warn.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes('Failed to prioritize'))).toBe(false);
  }, 120000);
});
