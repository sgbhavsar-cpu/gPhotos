import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resetDbForTests, setActiveLibrary, getDb, getDbForLibraryPath, getOpenConnectionCountForTests, setEvictionGraceMsForTests } from '../../src/main/services/db';

// Regression test for the OOM fix in CODE_REVIEW §57: before this cap, switching through many
// libraries in one session kept every one of their DatabaseSync connections open forever, which in
// turn kept pipelineOrchestrator's ~100MB-per-library face-cluster cache (keyed off the connection
// object) alive forever too. See MAX_OPEN_LIBRARY_CONNECTIONS in db.ts.
describe('db connection cap (OOM fix)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gphotos_dbcap_test_'));
    process.env.GPHOTOS_TEST_DB_DIR = tempDir;
  });

  afterEach(() => {
    setEvictionGraceMsForTests(3 * 60_000);
    resetDbForTests();
    delete process.env.GPHOTOS_TEST_DB_DIR;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('keeps recently used connections open even over the cap (in-flight sync must not lose its handle)', () => {
    const libs = Array.from({ length: 5 }, (_, i) => path.join(tempDir, `Library${i}`));
    for (const dir of libs) fs.mkdirSync(dir, { recursive: true });
    setActiveLibrary(libs[0]);
    const held = getDbForLibraryPath(libs[1]); // e.g. a sync holding this handle across awaits
    for (const dir of libs.slice(2)) getDbForLibraryPath(dir);
    expect(() => held.prepare('select 1').get()).not.toThrow();
  });

  it('closes the least-recently-used connection once more than a handful of libraries have been opened', () => {
    setEvictionGraceMsForTests(0);
    const libs = Array.from({ length: 5 }, (_, i) => path.join(tempDir, `Library${i}`));
    for (const dir of libs) {
      fs.mkdirSync(dir, { recursive: true });
      setActiveLibrary(dir);
      getDb(); // opens + caches this library's connection
    }
    // Only the cap's worth of connections should still be open — the earliest-opened ones evicted.
    expect(getOpenConnectionCountForTests()).toBeLessThanOrEqual(3);
  });

  it('never evicts the currently active library, even if it was opened first', () => {
    const libs = Array.from({ length: 5 }, (_, i) => path.join(tempDir, `Library${i}`));
    for (const dir of libs) fs.mkdirSync(dir, { recursive: true });

    setActiveLibrary(libs[0]);
    getDb();
    // Touch several other libraries read-only without switching the active pointer away from libs[0].
    for (const dir of libs.slice(1)) getDbForLibraryPath(dir);

    // Re-fetching the active library's connection must not throw (i.e. it was never closed).
    expect(() => getDb()).not.toThrow();
  });
});
