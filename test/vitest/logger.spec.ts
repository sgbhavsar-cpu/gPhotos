import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
