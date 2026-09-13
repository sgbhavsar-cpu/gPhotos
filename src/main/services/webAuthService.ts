import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

export interface PairedDevice {
  id: string;
  tokenHash: string;
  label: string;
  createdAt: string;
  lastSeenAt: string;
}

interface WebAuthConfig {
  pin: string;
  devices: PairedDevice[];
}

export function getWebAuthConfigPath(): string {
  // Test-only override so unit tests never touch a real user's config on disk.
  if (process.env.GPHOTOS_TEST_CONFIG_DIR) {
    return path.join(process.env.GPHOTOS_TEST_CONFIG_DIR, 'webserver_auth.json');
  }

  try {
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') {
      return path.join(app.getPath('userData'), 'webserver_auth.json');
    }
  } catch {}

  const base =
    process.env.APPDATA ||
    (process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library/Application Support')
      : path.join(os.homedir(), '.config'));
  return path.join(base, 'gPhotos', 'webserver_auth.json');
}

let configCache: WebAuthConfig | null = null;

/** Test-only: clears the in-memory config cache so the next call re-reads from disk. */
export function resetWebAuthCacheForTests(): void {
  configCache = null;
}

function generatePin(): string {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function loadConfig(): WebAuthConfig {
  if (configCache) return configCache;
  const p = getWebAuthConfigPath();
  if (fs.existsSync(p)) {
    try {
      const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
      configCache = {
        pin: typeof raw.pin === 'string' && raw.pin ? raw.pin : generatePin(),
        devices: Array.isArray(raw.devices) ? raw.devices : [],
      };
      return configCache;
    } catch {}
  }
  configCache = { pin: generatePin(), devices: [] };
  saveConfig(configCache);
  return configCache;
}

function saveConfig(config: WebAuthConfig): void {
  const p = getWebAuthConfigPath();
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmpPath = `${p}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2), 'utf-8');
    fs.renameSync(tmpPath, p);
  } catch (err) {
    console.warn('[webAuthService] Failed to save auth config:', err);
  }
}

/** Returns the current pairing PIN, generating one on first use. */
export function getOrCreatePin(): string {
  return loadConfig().pin;
}

/** Generates and persists a new random pairing PIN. Existing paired devices remain valid. */
export function regeneratePin(): string {
  const config = loadConfig();
  config.pin = generatePin();
  saveConfig(config);
  return config.pin;
}

export function verifyPin(candidate: string): boolean {
  const config = loadConfig();
  return typeof candidate === 'string' && candidate.trim() === config.pin;
}

/** Issues a new session token for a paired device. The raw token is only ever returned here. */
export function createSessionToken(label: string): { id: string; token: string } {
  const config = loadConfig();
  const token = crypto.randomBytes(32).toString('hex');
  const id = crypto.randomBytes(8).toString('hex');
  const now = new Date().toISOString();
  config.devices.push({
    id,
    tokenHash: hashToken(token),
    label: (label || 'Unknown device').slice(0, 80),
    createdAt: now,
    lastSeenAt: now,
  });
  saveConfig(config);
  return { id, token };
}

/** Validates a bearer token and refreshes the device's last-seen timestamp. */
export function validateToken(token: string): boolean {
  if (!token) return false;
  const config = loadConfig();
  const tokenHash = hashToken(token);
  const device = config.devices.find((d) => d.tokenHash === tokenHash);
  if (!device) return false;
  device.lastSeenAt = new Date().toISOString();
  saveConfig(config);
  return true;
}

export function listDevices(): Array<{ id: string; label: string; createdAt: string; lastSeenAt: string }> {
  return loadConfig().devices.map(({ id, label, createdAt, lastSeenAt }) => ({ id, label, createdAt, lastSeenAt }));
}

export function revokeDevice(id: string): boolean {
  const config = loadConfig();
  const before = config.devices.length;
  config.devices = config.devices.filter((d) => d.id !== id);
  if (config.devices.length !== before) {
    saveConfig(config);
    return true;
  }
  return false;
}

export function revokeAllDevices(): void {
  const config = loadConfig();
  config.devices = [];
  saveConfig(config);
}

// Simple in-memory brute-force throttle for /api/auth/pair, keyed by client IP.
const failedAttempts = new Map<string, { count: number; lockedUntil: number }>();
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 60_000;

export function isLockedOut(ip: string): boolean {
  const entry = failedAttempts.get(ip);
  if (!entry) return false;
  if (entry.lockedUntil && entry.lockedUntil > Date.now()) return true;
  if (entry.lockedUntil && entry.lockedUntil <= Date.now()) {
    failedAttempts.delete(ip);
  }
  return false;
}

export function recordFailedAttempt(ip: string): void {
  const entry = failedAttempts.get(ip) || { count: 0, lockedUntil: 0 };
  entry.count += 1;
  if (entry.count >= MAX_ATTEMPTS) {
    entry.lockedUntil = Date.now() + LOCKOUT_MS;
    entry.count = 0;
  }
  failedAttempts.set(ip, entry);
}

export function clearFailedAttempts(ip: string): void {
  failedAttempts.delete(ip);
}
