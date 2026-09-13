import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resetDbForTests, setActiveLibrary } from '../../src/main/services/db';
import { upsertPeople, replaceAllPeople, getAllPeople } from '../../src/main/services/libraryRepository';
import { Person } from '../../src/types';

/**
 * These two functions back main.ts's storage:save handler for two different
 * IPC keys:
 *  - gphotos_library_v1.people -> upsertPeople (merge-only, never deletes)
 *  - gphotos_people_v2         -> replaceAllPeople (full destructive sync)
 *
 * The split exists so an ordinary library save can never accidentally wipe a
 * custom name (mirrors the old library.json anti-wipe guard), while the
 * explicit "Reset & Rescan" action — which saves gphotos_people_v2 as an
 * empty array — still actually clears the registry.
 */
describe('people save semantics (merge vs. destructive replace)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gphotos_people_semantics_test_'));
    process.env.GPHOTOS_TEST_DB_DIR = tempDir;
    resetDbForTests();
    setActiveLibrary(null);
  });

  afterEach(() => {
    resetDbForTests();
    delete process.env.GPHOTOS_TEST_DB_DIR;
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  const alice: Person = { id: 'p_alice', name: 'Alice', faceCount: 2, photoCount: 2, createdAt: '2026-01-01T00:00:00Z' };

  it('upsertPeople([]) (the gphotos_library_v1.people path) never deletes existing people', () => {
    upsertPeople([alice]);
    expect(getAllPeople()).toHaveLength(1);

    upsertPeople([]); // simulates an ordinary library save with an empty/stale people snapshot
    expect(getAllPeople().map((p) => p.name)).toEqual(['Alice']);
  });

  it('replaceAllPeople([]) (the gphotos_people_v2 path) does clear the registry, as Reset & Rescan relies on', () => {
    upsertPeople([alice]);
    expect(getAllPeople()).toHaveLength(1);

    replaceAllPeople([]); // simulates the explicit Reset & Rescan save
    expect(getAllPeople()).toHaveLength(0);
  });

  it('upsertPeople merges updates (e.g. a new custom name) without touching unrelated people', () => {
    const bob: Person = { id: 'p_bob', name: 'Person 2', faceCount: 1, photoCount: 1, createdAt: '2026-01-02T00:00:00Z' };
    upsertPeople([alice, bob]);

    const renamedBob: Person = { ...bob, name: 'Bob' };
    upsertPeople([renamedBob]);

    const people = getAllPeople();
    expect(people.find((p) => p.id === 'p_alice')?.name).toBe('Alice');
    expect(people.find((p) => p.id === 'p_bob')?.name).toBe('Bob');
  });
});
