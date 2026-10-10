import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { rotateLogsOnStartupForTests, getLogFilePath } from '../../src/main/services/logger';

describe('logger rotation', () => {
  let logsDir: string;

  beforeEach(() => {
    logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gphotos_logger_test_'));
  });

  afterEach(() => {
    try {
      fs.rmSync(logsDir, { recursive: true, force: true });
    } catch {}
  });

  it('keeps only the last 5 generations after startup rotation, discarding the rest', () => {
    const base = path.join(logsDir, 'main.log');
    // Seed 7 files: the live log plus 6 already-rotated generations —
    // more than the 5-generation retention window.
    fs.writeFileSync(base, 'current session');
    for (let generation = 1; generation <= 6; generation += 1) {
      fs.writeFileSync(`${base}.${generation}`, `session -${generation}`);
    }

    rotateLogsOnStartupForTests(logsDir);

    const remaining = fs.readdirSync(logsDir).sort();
    expect(remaining).toEqual(['main.log.1', 'main.log.2', 'main.log.3', 'main.log.4', 'main.log.5']);
  });

  it('shifts the previous session into .1 so its content is preserved', () => {
    const base = path.join(logsDir, 'main.log');
    fs.writeFileSync(base, 'previous session content');

    rotateLogsOnStartupForTests(logsDir);

    expect(fs.existsSync(`${base}.1`)).toBe(true);
    expect(fs.readFileSync(`${base}.1`, 'utf-8')).toBe('previous session content');
    expect(fs.existsSync(base)).toBe(false);
  });

  it('is a no-op when no log files exist yet (first-ever run)', () => {
    expect(() => rotateLogsOnStartupForTests(logsDir)).not.toThrow();
    expect(fs.readdirSync(logsDir)).toEqual([]);
  });

  it('getLogFilePath resolves under the app userData logs directory', () => {
    const previous = process.env.GPHOTOS_TEST_DB_DIR;
    process.env.GPHOTOS_TEST_DB_DIR = logsDir;
    try {
      expect(getLogFilePath()).toBe(path.join(logsDir, 'logs', 'main.log'));
    } finally {
      if (previous === undefined) delete process.env.GPHOTOS_TEST_DB_DIR;
      else process.env.GPHOTOS_TEST_DB_DIR = previous;
    }
  });
});

// Several main-process services (thumbnailWorkerService.ts, etc.) call plain console.log/warn/error
// rather than this module's own logger — initLogger() patches the global console so those calls
// land in main.log too, not just the live terminal (see §52/§[next] of CODE_REVIEW: a reported hang
// was untraceable afterward purely because of this gap).
describe('initLogger: mirrors plain console.* calls into the file (not just logger.debug/info/...)', () => {
  const originalConsole = { ...console };
  let logsDir: string;
  let previousTestDbDir: string | undefined;

  beforeEach(() => {
    logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gphotos_logger_console_test_'));
    previousTestDbDir = process.env.GPHOTOS_TEST_DB_DIR;
    process.env.GPHOTOS_TEST_DB_DIR = logsDir;
  });

  afterEach(() => {
    Object.assign(console, originalConsole);
    if (previousTestDbDir === undefined) delete process.env.GPHOTOS_TEST_DB_DIR;
    else process.env.GPHOTOS_TEST_DB_DIR = previousTestDbDir;
    try { fs.rmSync(logsDir, { recursive: true, force: true }); } catch {}
    vi.resetModules();
  });

  it('a plain console.log call after initLogger() still prints normally AND reaches main.log', async () => {
    vi.resetModules();
    const mod = await import('../../src/main/services/logger');

    // Captured BEFORE initLogger() wraps console.log, so this proves the real console output path
    // is still exercised (not replaced) by the wrap — only mirrored alongside it.
    let sawRealCall = false;
    const realLog = console.log;
    console.log = ((...args: unknown[]) => { sawRealCall = true; realLog(...(args as [])); }) as typeof console.log;

    mod.initLogger();
    console.log('[ThumbnailWorker] Background pre-caching resumed.');
    // electron-log's file transport write is not synchronous with the call — give it a tick.
    await new Promise((r) => setTimeout(r, 50));

    expect(sawRealCall).toBe(true);
    const logPath = path.join(logsDir, 'logs', 'main.log');
    expect(fs.existsSync(logPath)).toBe(true);
    expect(fs.readFileSync(logPath, 'utf-8')).toContain('Background pre-caching resumed');
  });
});
