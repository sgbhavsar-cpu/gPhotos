import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import { resetDbForTests } from '../../src/main/services/db';
import { getSetting, setSetting } from '../../src/main/services/libraryRepository';
import { runBackgroundSyncCycle } from '../../src/main/services/backgroundDaemon';
import { syncVirtualStorage } from '../../src/main/services/virtualMirrorService';
import { thumbnailWorker } from '../../src/main/services/thumbnailWorkerService';
import { VirtualStorageConfig } from '../../src/types';

describe('background sync uses the same implementation as manual sync (no divergent total-counting)', () => {
  let tempDir: string;
  let networkSourcePath: string;
  let localMirrorRoot: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gphotos_bgsync_test_'));
    process.env.GPHOTOS_TEST_DB_DIR = tempDir;
    resetDbForTests();

    // Isolate the shared thumbnailWorker singleton's checkpoint — this test
    // calls runBackgroundSyncCycle(), which enqueues into thumbnailWorker;
    // without this it reads/writes the real, persisted userData checkpoint.
    const workerCheckpointDir = path.join(tempDir, 'worker_checkpoint');
    fs.mkdirSync(workerCheckpointDir, { recursive: true });
    thumbnailWorker.useIsolatedStateForTests(workerCheckpointDir);

    networkSourcePath = path.join(tempDir, 'NetworkSource');
    localMirrorRoot = path.join(tempDir, 'Mirrors');
    fs.mkdirSync(networkSourcePath, { recursive: true });
    fs.mkdirSync(localMirrorRoot, { recursive: true });

    // 5 real source photos.
    for (let i = 0; i < 5; i++) {
      await sharp({ create: { width: 100, height: 100, channels: 3, background: { r: i * 10, g: 0, b: 0 } } })
        .jpeg()
        .toFile(path.join(networkSourcePath, `IMG_${i}.jpg`));
    }
  });

  afterEach(() => {
    resetDbForTests();
    delete process.env.GPHOTOS_TEST_DB_DIR;
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('running the background cycle repeatedly never inflates totalItems past the real file count', async () => {
    const storage: VirtualStorageConfig = {
      id: 'storage_1',
      name: 'TestStorage',
      networkSourcePath,
      localMirrorRoot,
    };
    setSetting('gphotos_virtual_storages_v1', [storage]);
    setSetting('gphotos_unlinked_storages_v1', []);

    await runBackgroundSyncCycle();
    let saved = getSetting<VirtualStorageConfig[]>('gphotos_virtual_storages_v1', []);
    expect(saved[0].totalItems).toBe(5);

    // Run it again (and again) — simulating repeated 15-minute daemon
    // cycles against an unchanged source. The total must stay exactly 5,
    // never accumulate.
    await runBackgroundSyncCycle();
    await runBackgroundSyncCycle();
    saved = getSetting<VirtualStorageConfig[]>('gphotos_virtual_storages_v1', []);
    expect(saved[0].totalItems).toBe(5);
  });

  it('manual sync (syncVirtualStorage) and the background cycle produce the same mirror file layout', async () => {
    const storage: VirtualStorageConfig = {
      id: 'storage_2',
      name: 'TestStorage2',
      networkSourcePath,
      localMirrorRoot,
    };

    // Manual sync first.
    const manualResult = await syncVirtualStorage(storage);
    expect(manualResult.totalSynced).toBe(5);

    // Then a background cycle against the SAME already-synced storage must
    // recognize everything as already up to date (no naming mismatch), not
    // reprocess and recount the whole library as "new".
    setSetting('gphotos_virtual_storages_v1', [storage]);
    setSetting('gphotos_unlinked_storages_v1', []);
    await runBackgroundSyncCycle();

    const saved = getSetting<VirtualStorageConfig[]>('gphotos_virtual_storages_v1', []);
    expect(saved[0].totalItems).toBe(5);
  });
});

describe('bandwidth throttling (bandwidthLimitMbps)', () => {
  let tempDir: string;
  let networkSourcePath: string;
  let localMirrorRoot: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gphotos_bandwidth_test_'));
    networkSourcePath = path.join(tempDir, 'NetworkSource');
    localMirrorRoot = path.join(tempDir, 'Mirrors');
    fs.mkdirSync(networkSourcePath, { recursive: true });
    fs.mkdirSync(localMirrorRoot, { recursive: true });

    // A ~2MB source photo — big enough that a low bandwidth cap forces a
    // measurable, deterministic delay regardless of how fast local disk I/O is.
    await sharp({ create: { width: 2000, height: 2000, channels: 3, background: { r: 100, g: 100, b: 100 } } })
      .jpeg({ quality: 100 })
      .toFile(path.join(networkSourcePath, 'big.jpg'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('a low bandwidthLimitMbps measurably slows down syncing a large file', async () => {
    const fileSize = fs.statSync(path.join(networkSourcePath, 'big.jpg')).size;
    // Cap low enough that even a couple hundred KB takes a meaningful fraction of a second.
    const bandwidthLimitMbps = 1; // 1 Mbps = 125,000 bytes/sec
    const expectedMinMs = (fileSize / 125_000) * 1000 * 0.5; // 50% margin for timer slop

    const storage: VirtualStorageConfig = {
      id: 'storage_bw',
      name: 'BandwidthTest',
      networkSourcePath,
      localMirrorRoot,
      bandwidthLimitMbps,
    };

    const t0 = Date.now();
    const result = await syncVirtualStorage(storage);
    const elapsed = Date.now() - t0;

    expect(result.totalSynced).toBe(1);
    expect(elapsed).toBeGreaterThan(expectedMinMs);
  });

  it('without a bandwidth limit, syncing the same file is not artificially delayed', async () => {
    const storage: VirtualStorageConfig = {
      id: 'storage_nolimit',
      name: 'NoLimitTest',
      networkSourcePath,
      localMirrorRoot,
    };

    const t0 = Date.now();
    const result = await syncVirtualStorage(storage);
    const elapsed = Date.now() - t0;

    expect(result.totalSynced).toBe(1);
    expect(elapsed).toBeLessThan(2000);
  });
});
