import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  getHeicRotationsFilePath,
  resetHeicRotationCacheForTests,
  saveHeicSavedRotation,
  getHeicSavedRotation,
} from '../../src/main/services/heicRotationStore';
import {
  getOrCreatePin,
  createSessionToken,
  resetWebAuthCacheForTests,
  getWebAuthConfigPath,
  regeneratePin,
  isLockedOut,
  recordFailedAttempt,
  lockoutRetrySeconds,
} from '../../src/main/services/webAuthService';

// Makes the next `times` reads of `targetFile` fail with EBUSY (a locked file), then behaves normally.
function busy(targetFile: string, times = 1) {
  const real = fs.readFileSync;
  let left = times;
  return vi.spyOn(fs, 'readFileSync').mockImplementation(((p: any, ...rest: any[]) => {
    if (left > 0 && String(p) === targetFile) {
      left--;
      const err: NodeJS.ErrnoException = new Error('EBUSY: resource busy or locked');
      err.code = 'EBUSY';
      throw err;
    }
    return (real as any)(p, ...rest);
  }) as any);
}

describe('review fixes: a transient read failure must never overwrite existing data', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gphotos_reviewfix_test_'));
    process.env.GPHOTOS_TEST_CONFIG_DIR = tempDir;
    resetHeicRotationCacheForTests();
    resetWebAuthCacheForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.GPHOTOS_TEST_CONFIG_DIR;
    resetHeicRotationCacheForTests();
    resetWebAuthCacheForTests();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('heicRotationStore: a locked first read followed by a good second read does not wipe saved rotations', () => {
    const file = getHeicRotationsFilePath();
    fs.writeFileSync(file, JSON.stringify({ 'c:/photos/keep.heic': 90 }));
    const spy = busy(file);

    // First load (inside saveHeicSavedRotation) hits EBUSY; the second (inside getHeicSavedRotation) succeeds.
    saveHeicSavedRotation('C:/photos/new.heic', 90);
    spy.mockRestore();

    expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual({ 'c:/photos/keep.heic': 90 });
    // And the store still works normally afterwards.
    resetHeicRotationCacheForTests();
    saveHeicSavedRotation('C:/photos/new.heic', 90);
    expect(getHeicSavedRotation('C:/photos/keep.heic')).toBe(90);
    expect(getHeicSavedRotation('C:/photos/new.heic')).toBe(90);
  });

  it('webAuthService: a locked auth file keeps the real PIN and paired devices (no re-pair, no overwrite)', () => {
    const pin = getOrCreatePin();
    const { token } = createSessionToken('phone');
    const file = getWebAuthConfigPath();
    const before = fs.readFileSync(file, 'utf-8');

    resetWebAuthCacheForTests(); // simulate a restart
    const spy = busy(file, 2); // still locked for both reads below
    const temporaryPin = getOrCreatePin(); // read fails: temporary, unsaved config
    expect(temporaryPin).not.toBe(pin);
    expect(() => createSessionToken('other phone')).toThrow(); // must not write over the real file
    spy.mockRestore();

    expect(fs.readFileSync(file, 'utf-8')).toBe(before);
    resetWebAuthCacheForTests();
    expect(getOrCreatePin()).toBe(pin); // the real PIN is still there once the lock clears
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('webAuthService: regenerating the PIN clears a global lockout and the retry time is reported', () => {
    getOrCreatePin();
    for (let i = 0; i < 20; i++) recordFailedAttempt(`10.0.0.${i}`);
    expect(isLockedOut('192.168.1.50')).toBe(true);
    expect(lockoutRetrySeconds('192.168.1.50')).toBeGreaterThan(0);

    regeneratePin();
    expect(isLockedOut('192.168.1.50')).toBe(false);
    expect(lockoutRetrySeconds('192.168.1.50')).toBe(0);
  });
});
