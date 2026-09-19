import fs from 'fs';
import path from 'path';
import log from 'electron-log';
import { getGlobalUserDataDir } from './db';
import { getSetting, setSetting } from './libraryRepository';

// Central logging service for the main process, bridged to the renderer via
// the 'logger:write' IPC channel (see main.ts + preload.ts) so both
// processes end up in the same file. Built on electron-log for
// level-filtered console+file output; log FILE rotation itself is handled
// by rotateLogsOnStartup() below rather than electron-log's own size-based
// rotation, per the "keep last 5 files, shift on startup" requirement.

const LOG_FILE_NAME = 'main.log';
const MAX_ROTATED_FILES = 5;
const LOG_LEVEL_OVERRIDE_SETTING_KEY = 'log_level_override_debug';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
type LogMeta = Record<string, unknown> | undefined;

let initialized = false;

function getLogsDir(): string {
  const dir = path.join(getGlobalUserDataDir(), 'logs');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // Best-effort: if this directory truly can't be created, the file
    // transport write below will fail too and electron-log falls back to
    // console-only output — nothing further to do here.
  }
  return dir;
}

/**
 * Shifts main.log -> main.log.1 -> ... -> main.log.5, deleting anything
 * beyond the 5th generation. Runs once per app start (not size-triggered),
 * so "last 5 log files" means "last 5 app sessions", which is what makes
 * the retention policy predictable for a desktop app that may run for
 * days at a time.
 */
function rotateLogsOnStartup(logsDir: string): void {
  const basePath = path.join(logsDir, LOG_FILE_NAME);
  const oldestPath = `${basePath}.${MAX_ROTATED_FILES}`;
  try {
    if (fs.existsSync(oldestPath)) fs.unlinkSync(oldestPath);
  } catch {
    // Worst case one extra generation lingers until the next startup.
  }
  for (let generation = MAX_ROTATED_FILES - 1; generation >= 1; generation -= 1) {
    const from = `${basePath}.${generation}`;
    const to = `${basePath}.${generation + 1}`;
    try {
      if (fs.existsSync(from)) fs.renameSync(from, to);
    } catch {
      // A stuck rename is retried next startup; not worth failing boot over.
    }
  }
  try {
    if (fs.existsSync(basePath)) fs.renameSync(basePath, `${basePath}.1`);
  } catch {
    // ignore
  }
  sweepStrayGenerations(logsDir);
}

/**
 * Defensive cleanup: removes any main.log.N beyond the retention window that
 * the shift loop above wouldn't otherwise touch (e.g. leftovers from a
 * previous app version with a different MAX_ROTATED_FILES, or a file that
 * failed to rename on a prior run). Keeps the "last 5, rest removed on
 * startup" guarantee true regardless of how the directory got into an
 * unexpected state.
 */
function sweepStrayGenerations(logsDir: string): void {
  const generationPattern = new RegExp(`^${escapeRegExp(LOG_FILE_NAME)}\\.(\\d+)$`);
  let entries: string[];
  try {
    entries = fs.readdirSync(logsDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const match = entry.match(generationPattern);
    if (match && Number(match[1]) > MAX_ROTATED_FILES) {
      try {
        fs.unlinkSync(path.join(logsDir, entry));
      } catch {
        // ignore — cleaned up next startup
      }
    }
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function resolveDefaultLevel(): LogLevel {
  try {
    const { app } = require('electron');
    if (app && typeof app.isPackaged === 'boolean' && app.isPackaged) {
      return 'info';
    }
  } catch {
    // Running outside a full Electron app context (e.g. tests) — treat as dev.
  }
  return 'debug';
}

/** Must be called once, as early as possible in main process startup. */
export function initLogger(): void {
  if (initialized) return;
  initialized = true;

  const logsDir = getLogsDir();
  rotateLogsOnStartup(logsDir);

  log.transports.file.resolvePathFn = () => path.join(logsDir, LOG_FILE_NAME);
  log.transports.file.maxSize = 0; // disable electron-log's own size-based rotation — see rotateLogsOnStartup
  log.transports.file.level = resolveDefaultLevel();
  log.transports.console.level = resolveDefaultLevel();
}

/**
 * Re-reads the persisted debug-override setting and applies it. Call once
 * the global DB is safe to touch (e.g. inside app.whenReady) — safe to call
 * again any time the Settings UI toggle changes.
 */
export function applyStoredLogLevelOverride(): void {
  try {
    const overrideDebug = getSetting<boolean>(LOG_LEVEL_OVERRIDE_SETTING_KEY, false);
    const level: LogLevel = overrideDebug ? 'debug' : resolveDefaultLevel();
    log.transports.file.level = level;
    log.transports.console.level = level;
  } catch (err) {
    // DB not ready yet — defaults already applied by initLogger(), so this
    // is non-fatal; log via console since our own logger may not be at the
    // right level yet.
    console.warn('[Logger] Could not apply stored log level override (DB not ready?):', err);
  }
}

export function setLogLevelOverride(overrideDebug: boolean): void {
  setSetting(LOG_LEVEL_OVERRIDE_SETTING_KEY, overrideDebug);
  applyStoredLogLevelOverride();
}

export function getLogLevelOverride(): boolean {
  return getSetting<boolean>(LOG_LEVEL_OVERRIDE_SETTING_KEY, false);
}

export function getLogFilePath(): string {
  return path.join(getLogsDir(), LOG_FILE_NAME);
}

function write(level: LogLevel, scope: string, message: string, meta?: LogMeta): void {
  if (meta !== undefined) {
    log[level](`[${scope}] ${message}`, meta);
  } else {
    log[level](`[${scope}] ${message}`);
  }
}

/**
 * logger.debug/info/warn/error(scope, message, meta?) — the standard
 * error-handling pattern for this codebase going forward:
 *
 *   try {
 *     logger.debug('MyService', 'starting doThing', { photoId });
 *     ...
 *   } catch (err) {
 *     logger.error('MyService', 'doThing failed', { photoId, err: String(err) });
 *     return { success: false, error: String(err) };
 *   }
 *
 * `debug` is for the per-user-action "assertion" logging requirement
 * (entry/exit of anything the user clicks) — it's level-gated (silent in
 * packaged builds unless the Settings debug-logging toggle is on), never
 * commented out.
 */
export const logger = {
  debug: (scope: string, message: string, meta?: LogMeta) => write('debug', scope, message, meta),
  info: (scope: string, message: string, meta?: LogMeta) => write('info', scope, message, meta),
  warn: (scope: string, message: string, meta?: LogMeta) => write('warn', scope, message, meta),
  error: (scope: string, message: string, meta?: LogMeta) => write('error', scope, message, meta),
};

/** Test-only: allows a vitest spec to re-run startup rotation against a fresh temp dir. */
export function rotateLogsOnStartupForTests(logsDir: string): void {
  rotateLogsOnStartup(logsDir);
}
