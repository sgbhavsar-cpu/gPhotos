import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resetDbForTests, setActiveLibrary } from '../../src/main/services/db';
import { getPhotoContentEntry, getAllPhotoContentEntries, upsertPhotoContentEntry } from '../../src/main/services/libraryRepository';
import type { PhotoContentEntry } from '../../src/types';

describe('photo_content table (Smart Flows shared cache / RAG index)', () => {
  let tempDir: string;
  let libraryA: string;
  let libraryB: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gphotos_photocontent_test_'));
    process.env.GPHOTOS_TEST_DB_DIR = tempDir;
    libraryA = path.join(tempDir, 'LibraryA');
    libraryB = path.join(tempDir, 'LibraryB');
    fs.mkdirSync(libraryA, { recursive: true });
    fs.mkdirSync(libraryB, { recursive: true });
    resetDbForTests();
  });

  afterEach(() => {
    resetDbForTests();
    delete process.env.GPHOTOS_TEST_DB_DIR;
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  const entry = (over: Partial<PhotoContentEntry> = {}): PhotoContentEntry => ({
    caption: 'a scanned bill with line items',
    tags: ['bill', 'receipt'],
    embedding: [0.1, 0.2, 0.3],
    verdicts: { 'a scanned bill': { match: true, confidence: 0.9 } },
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  });

  it('round-trips caption/tags/embedding/verdicts exactly, including a null embedding', () => {
    setActiveLibrary(libraryA);
    upsertPhotoContentEntry('p1', entry());
    expect(getPhotoContentEntry('p1')).toEqual(entry());

    upsertPhotoContentEntry('p2', entry({ embedding: null, tags: [] }));
    expect(getPhotoContentEntry('p2')).toEqual(entry({ embedding: null, tags: [] }));
  });

  it('an upsert of the same photo id replaces the row rather than duplicating it', () => {
    setActiveLibrary(libraryA);
    upsertPhotoContentEntry('p1', entry());
    upsertPhotoContentEntry('p1', entry({ caption: 'updated caption', tags: ['bill', 'document'] }));

    expect(getPhotoContentEntry('p1')).toMatchObject({ caption: 'updated caption', tags: ['bill', 'document'] });
    expect(Object.keys(getAllPhotoContentEntries())).toEqual(['p1']);
  });

  it('getPhotoContentEntry returns null for a photo never classified', () => {
    setActiveLibrary(libraryA);
    expect(getPhotoContentEntry('nope')).toBeNull();
  });

  it('is scoped per library, like the rest of the per-library database', () => {
    setActiveLibrary(libraryA);
    upsertPhotoContentEntry('shared-id', entry({ caption: 'library A photo' }));

    setActiveLibrary(libraryB);
    expect(getPhotoContentEntry('shared-id')).toBeNull(); // a different library, unaffected by A's cache
    upsertPhotoContentEntry('shared-id', entry({ caption: 'library B photo' }));

    setActiveLibrary(libraryA);
    expect(getPhotoContentEntry('shared-id')).toMatchObject({ caption: 'library A photo' });
  });

  it('getAllPhotoContentEntries returns every cached photo for the active library, keyed by id', () => {
    setActiveLibrary(libraryA);
    upsertPhotoContentEntry('p1', entry({ caption: 'first' }));
    upsertPhotoContentEntry('p2', entry({ caption: 'second' }));

    const all = getAllPhotoContentEntries();
    expect(Object.keys(all).sort()).toEqual(['p1', 'p2']);
    expect(all.p1.caption).toBe('first');
    expect(all.p2.caption).toBe('second');
  });
});
