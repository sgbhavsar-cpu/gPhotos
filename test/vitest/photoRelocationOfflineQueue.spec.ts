import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';

// Two-pane explorer "Commit" button: a commit whose root is unreachable right now must be queued
// (pending_moves.json) instead of reported as a plain failure, and drained automatically once that
// root becomes reachable again — same offline-queue contract as pending_rotations/pending_metadata.
const reachability = vi.hoisted(() => ({
  isPathReachable: vi.fn(async () => true),
  isKnownOfflineStorage: vi.fn(() => false),
}));
vi.mock('../../src/main/services/networkReachabilityCache', () => reachability);

import { resetDbForTests, setActiveLibrary } from '../../src/main/services/db';
import { setSetting } from '../../src/main/services/libraryRepository';
import {
  relocatePhotosWithOfflineQueue,
  getPendingMoves,
  savePendingMoves,
  processPendingMoves,
  onPendingMoveApplied,
  type RelocationPhotoInput,
} from '../../src/main/services/photoRelocation';

const b64 = (s: string) => Buffer.from(s).toString('base64');

async function jpeg(file: string): Promise<void> {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } } }).jpeg().toFile(file);
}

describe('photoRelocation: offline commit queue', () => {
  let tempDir: string;
  let lib: string;

  beforeEach(() => {
    reachability.isPathReachable.mockReset().mockResolvedValue(true);
    reachability.isKnownOfflineStorage.mockReset().mockReturnValue(false);
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gphotos_reloc_queue_'));
    process.env.GPHOTOS_TEST_DB_DIR = tempDir;
    process.env.GPHOTOS_TEST_CONFIG_DIR = path.join(tempDir, 'cfg');
    fs.mkdirSync(process.env.GPHOTOS_TEST_CONFIG_DIR, { recursive: true });
    resetDbForTests();
    lib = path.join(tempDir, 'Lib');
    fs.mkdirSync(lib, { recursive: true });
    setSetting('selectedFolder', lib);
    setSetting('recentLibraries', [lib]);
    setActiveLibrary(lib);
    savePendingMoves([]);
  });

  afterEach(() => {
    savePendingMoves([]);
    resetDbForTests();
    delete process.env.GPHOTOS_TEST_DB_DIR;
    delete process.env.GPHOTOS_TEST_CONFIG_DIR;
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  it('queues the batch (without touching disk) when unreachable, then applies it once reachable again', async () => {
    const filePath = path.join(lib, 'A', 'one.jpg');
    await jpeg(filePath);
    const id = b64(filePath);
    const input: RelocationPhotoInput = { id, filePath, fileName: 'one.jpg' };
    const target = path.join(lib, 'B');

    reachability.isPathReachable.mockResolvedValue(false);
    const outcome = await relocatePhotosWithOfflineQueue({ photos: [input], targetDir: target });
    expect(outcome.queued).toBe(true);
    expect(outcome.error).toBeTruthy();
    expect(getPendingMoves()).toHaveLength(1);
    expect(getPendingMoves()[0]).toMatchObject({ targetDir: target });
    expect(fs.existsSync(filePath)).toBe(true); // nothing moved yet

    reachability.isPathReachable.mockResolvedValue(true);
    const applied: Array<{ targetDir: string; results: any[] }> = [];
    const unsubscribe = onPendingMoveApplied((info) => applied.push(info));
    const drain = await processPendingMoves();
    unsubscribe();

    expect(drain).toEqual({ processed: 1, remaining: 0 });
    expect(getPendingMoves()).toHaveLength(0);
    expect(applied).toHaveLength(1);
    expect(applied[0].results[0]).toMatchObject({ oldId: id, status: 'moved' });
    expect(fs.existsSync(path.join(target, 'one.jpg'))).toBe(true);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('leaves a queued move queued (and un-applied) while still unreachable', async () => {
    const filePath = path.join(lib, 'A', 'two.jpg');
    await jpeg(filePath);
    const id = b64(filePath);
    const input: RelocationPhotoInput = { id, filePath, fileName: 'two.jpg' };
    const target = path.join(lib, 'B');

    reachability.isPathReachable.mockResolvedValue(false);
    await relocatePhotosWithOfflineQueue({ photos: [input], targetDir: target });
    expect(getPendingMoves()).toHaveLength(1);

    const drain = await processPendingMoves();
    expect(drain).toEqual({ processed: 0, remaining: 1 });
    expect(getPendingMoves()).toHaveLength(1);
    expect(fs.existsSync(filePath)).toBe(true);
  });
});
