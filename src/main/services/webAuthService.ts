import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { readJsonSafe, writeFileAtomic } from './jsonFile';

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
// Configs handed out after a failed READ of an existing auth file. They are never cached or
// written, so a transient lock (antivirus/backup) can't replace the real PIN and paired devices.
const transientConfigs = new WeakSet<WebAuthConfig>();

/** Test-only: clears the in-memory config cache so the next call re-reads from disk. */
export function resetWebAuthCacheForTests(): void {
  configCache = null;
  lastSeenDirty = false;
  lastSeenFlushedAt = 0;
  failedAttempts.clear();
  globalFailures = [];
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
  let raw: any = null;
  try {
    // Unparsable content is quarantined to <file>.corrupt-<ts>; a real read error (EBUSY, EACCES...)
    // is rethrown so it is never mistaken for corruption.
    raw = readJsonSafe<any>(p, null);
  } catch (err) {
    console.warn('[webAuthService] Could not read the auth config; using a temporary one for now:', err);
    const temporary: WebAuthConfig = { pin: generatePin(), devices: [] };
    transientConfigs.add(temporary);
    return temporary;
  }
  if (raw && typeof raw === 'object') {
    configCache = {
      pin: typeof raw.pin === 'string' && raw.pin ? raw.pin : generatePin(),
      devices: Array.isArray(raw.devices) ? raw.devices : [],
    };
    return configCache;
  }
  configCache = { pin: generatePin(), devices: [] };
  saveConfig(configCache);
  return configCache;
}

/** Persists the config (mode 0600 — it holds the PIN). Returns false if the write failed. */
function saveConfig(config: WebAuthConfig): boolean {
  if (transientConfigs.has(config)) return false; // never overwrite a file we failed to read
  const p = getWebAuthConfigPath();
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    // Shared atomic writer: unique temp name and a short retry for the transient EPERM/EBUSY that
    // Windows raises when antivirus/indexers hold the target for a moment. Mode 0600: it holds the PIN.
    writeFileAtomic(p, JSON.stringify(config, null, 2), 0o600);
    return true;
  } catch (err) {
    console.warn('[webAuthService] Failed to save auth config:', err);
    return false;
  }
}

// lastSeenAt is only ever informational, so it is updated in memory on each
// request and flushed to disk at most once per interval instead of a
// synchronous write per thumbnail request.
const LAST_SEEN_FLUSH_MS = 60_000;
let lastSeenDirty = false;
let lastSeenFlushedAt = 0;

/** Writes any pending lastSeenAt updates to disk (also safe to call on quit). */
export function flushWebAuthConfig(): void {
  if (!lastSeenDirty || !configCache) return;
  if (saveConfig(configCache)) lastSeenDirty = false;
  lastSeenFlushedAt = Date.now();
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
  // The owner is the one rotating the PIN, so this is also the way out of a lockout
  // (e.g. a hostile LAN host burning the global failure budget).
  failedAttempts.clear();
  globalFailures = [];
  return config.pin;
}

export function verifyPin(candidate: string): boolean {
  if (typeof candidate !== 'string') return false;
  const a = crypto.createHash('sha256').update(candidate.trim()).digest();
  const b = crypto.createHash('sha256').update(loadConfig().pin).digest();
  return crypto.timingSafeEqual(a, b);
}

/** Issues a new session token for a paired device. The raw token is only ever returned here. */
export function createSessionToken(label: string): { id: string; token: string } {
  const config = loadConfig();
  const token = crypto.randomBytes(32).toString('hex');
  const id = crypto.randomBytes(8).toString('hex');
  const now = new Date().toISOString();
  const device: PairedDevice = {
    id,
    tokenHash: hashToken(token),
    label: (typeof label === 'string' && label ? label : 'Unknown device').slice(0, 80),
    createdAt: now,
    lastSeenAt: now,
  };
  config.devices.push(device);
  if (!saveConfig(config)) {
    // Don't hand out a token that won't survive a restart.
    config.devices = config.devices.filter((d) => d !== device);
    throw new Error('Could not save the pairing on the desktop (disk write failed)');
  }
  return { id, token };
}

/** Validates a bearer token and refreshes the device's last-seen timestamp (flushed to disk at most once a minute). */
export function validateToken(token: string): boolean {
  if (!token || typeof token !== 'string') return false;
  const config = loadConfig();
  const tokenHash = hashToken(token);
  const device = config.devices.find((d) => d.tokenHash === tokenHash);
  if (!device) return false;
  const nowMs = Date.now();
  device.lastSeenAt = new Date(nowMs).toISOString();
  lastSeenDirty = true;
  if (nowMs - lastSeenFlushedAt >= LAST_SEEN_FLUSH_MS) flushWebAuthConfig();
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
const failedAttempts = new Map<string, { count: number; lockedUntil: number; lastFailAt: number }>();
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 60_000;
// Failures older than this no longer count toward a lockout (and the entry is pruned).
const ATTEMPT_DECAY_MS = 10 * 60_000;
// Global cap across all IPs so rotating source addresses doesn't multiply the
// guess rate: too many failures overall pauses pairing for everyone.
const GLOBAL_MAX_FAILURES = 20;
const GLOBAL_WINDOW_MS = 5 * 60_000;
let globalFailures: number[] = [];

function pruneFailedAttempts(now: number): void {
  for (const [ip, e] of failedAttempts) {
    if (e.lockedUntil > now) continue;
    if (now - e.lastFailAt > ATTEMPT_DECAY_MS) failedAttempts.delete(ip);
  }
  globalFailures = globalFailures.filter((t) => now - t < GLOBAL_WINDOW_MS);
}

export function isLockedOut(ip: string): boolean {
  const now = Date.now();
  globalFailures = globalFailures.filter((t) => now - t < GLOBAL_WINDOW_MS);
  if (globalFailures.length >= GLOBAL_MAX_FAILURES) return true;
  const entry = failedAttempts.get(ip);
  if (!entry) return false;
  if (entry.lockedUntil && entry.lockedUntil > now) return true;
  if (entry.lockedUntil && entry.lockedUntil <= now) {
    failedAttempts.delete(ip);
  }
  return false;
}

/** Seconds until `ip` may try pairing again (0 when not locked out). */
export function lockoutRetrySeconds(ip: string): number {
  const now = Date.now();
  let until = failedAttempts.get(ip)?.lockedUntil ?? 0;
  const live = globalFailures.filter((t) => now - t < GLOBAL_WINDOW_MS);
  if (live.length >= GLOBAL_MAX_FAILURES) until = Math.max(until, live[0] + GLOBAL_WINDOW_MS);
  return until > now ? Math.ceil((until - now) / 1000) : 0;
}

export function recordFailedAttempt(ip: string): void {
  const now = Date.now();
  pruneFailedAttempts(now);
  globalFailures.push(now);
  const entry = failedAttempts.get(ip) || { count: 0, lockedUntil: 0, lastFailAt: now };
  entry.count += 1;
  entry.lastFailAt = now;
  if (entry.count >= MAX_ATTEMPTS) {
    entry.lockedUntil = now + LOCKOUT_MS;
    entry.count = 0;
  }
  failedAttempts.set(ip, entry);
}

export function clearFailedAttempts(ip: string): void {
  failedAttempts.delete(ip);
}
