import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  getOrCreatePin,
  regeneratePin,
  verifyPin,
  createSessionToken,
  validateToken,
  listDevices,
  revokeDevice,
  revokeAllDevices,
  isLockedOut,
  recordFailedAttempt,
  clearFailedAttempts,
  resetWebAuthCacheForTests,
} from '../../src/main/services/webAuthService';

describe('webAuthService', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gphotos_webauth_test_'));
    process.env.GPHOTOS_TEST_CONFIG_DIR = tempDir;
    resetWebAuthCacheForTests();
  });

  afterEach(() => {
    delete process.env.GPHOTOS_TEST_CONFIG_DIR;
    resetWebAuthCacheForTests();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('generates a 6-digit PIN on first use and persists it to disk', () => {
    const pin = getOrCreatePin();
    expect(pin).toMatch(/^\d{6}$/);
    expect(fs.existsSync(path.join(tempDir, 'webserver_auth.json'))).toBe(true);

    const pinAgain = getOrCreatePin();
    expect(pinAgain).toBe(pin);
  });

  it('regeneratePin issues a new PIN without discarding paired devices', () => {
    const originalPin = getOrCreatePin();
    const { token } = createSessionToken('Test Phone');
    expect(validateToken(token)).toBe(true);

    const newPin = regeneratePin();
    expect(newPin).not.toBe(originalPin);
    expect(verifyPin(originalPin)).toBe(false);
    expect(verifyPin(newPin)).toBe(true);

    // Existing session token must still work after a PIN regeneration.
    expect(validateToken(token)).toBe(true);
  });

  it('verifyPin accepts the current PIN (trimming incidental whitespace) and rejects anything else', () => {
    const pin = getOrCreatePin();
    expect(verifyPin(pin)).toBe(true);
    // Trimmed, since a user pasting the PIN may pick up stray whitespace.
    expect(verifyPin(`  ${pin}  `)).toBe(true);

    const wrongPin = pin === '000000' ? '111111' : '000000';
    expect(verifyPin(wrongPin)).toBe(false);
    expect(verifyPin('')).toBe(false);
    expect(verifyPin(pin.slice(0, -1))).toBe(false);
  });

  it('createSessionToken issues a unique token accepted by validateToken', () => {
    const { id, token } = createSessionToken('Living Room iPad');
    expect(id).toBeTruthy();
    expect(token).toHaveLength(64); // 32 random bytes as hex

    expect(validateToken(token)).toBe(true);
    expect(validateToken('not-a-real-token')).toBe(false);
    expect(validateToken('')).toBe(false);
  });

  it('listDevices never exposes the raw token, only device metadata', () => {
    createSessionToken('Device A');
    createSessionToken('Device B');
    const devices = listDevices();
    expect(devices).toHaveLength(2);
    for (const d of devices) {
      expect(d).not.toHaveProperty('tokenHash');
      expect(d).not.toHaveProperty('token');
      expect(d.label).toBeTruthy();
      expect(d.createdAt).toBeTruthy();
    }
  });

  it("revokeDevice invalidates that device's token but leaves others paired", () => {
    const a = createSessionToken('Device A');
    const b = createSessionToken('Device B');

    expect(revokeDevice(a.id)).toBe(true);
    expect(validateToken(a.token)).toBe(false);
    expect(validateToken(b.token)).toBe(true);
    expect(listDevices()).toHaveLength(1);

    // Revoking an already-revoked / unknown id is a no-op, not an error.
    expect(revokeDevice(a.id)).toBe(false);
  });

  it('revokeAllDevices signs every paired device out at once', () => {
    const a = createSessionToken('Device A');
    const b = createSessionToken('Device B');
    revokeAllDevices();
    expect(validateToken(a.token)).toBe(false);
    expect(validateToken(b.token)).toBe(false);
    expect(listDevices()).toHaveLength(0);
  });

  it('locks out an IP after repeated failed pairing attempts', () => {
    const ip = '10.0.0.42';
    expect(isLockedOut(ip)).toBe(false);
    for (let i = 0; i < 5; i++) recordFailedAttempt(ip);
    expect(isLockedOut(ip)).toBe(true);

    // A different IP is unaffected.
    expect(isLockedOut('10.0.0.99')).toBe(false);

    clearFailedAttempts(ip);
    expect(isLockedOut(ip)).toBe(false);
  });
});
