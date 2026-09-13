import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resetDbForTests, setActiveLibrary } from '../../src/main/services/db';
import {
  upsertPhoto,
  getAllPhotos,
  getTotalPhotoCount,
  upsertPerson,
  getAllPeople,
} from '../../src/main/services/libraryRepository';
import { Photo, Person } from '../../src/types';

function makePhoto(id: string): Photo {
  return {
    id,
    filePath: `C:\\Photos\\${id}.jpg`,
    fileName: `${id}.jpg`,
    fileSize: 1000,
    fileDate: '',
    dateTaken: '2026-01-01T00:00:00Z',
    year: 2026,
    month: 1,
    day: 1,
  };
}

describe('per-library database isolation', () => {
  let tempDir: string;
  let libraryA: string;
  let libraryB: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gphotos_perlib_test_'));
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
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('keeps photos scoped to whichever library is active, with a separate db file per folder', () => {
    setActiveLibrary(libraryA);
    upsertPhoto(makePhoto('a1'));
    upsertPhoto(makePhoto('a2'));
    expect(getTotalPhotoCount()).toBe(2);

    setActiveLibrary(libraryB);
    expect(getTotalPhotoCount()).toBe(0); // A different library, unaffected by A's photos
    upsertPhoto(makePhoto('b1'));
    expect(getTotalPhotoCount()).toBe(1);

    // Switching back to A must not have lost anything, and must not see B's photo.
    setActiveLibrary(libraryA);
    const photosA = getAllPhotos();
    expect(photosA.map((p) => p.id).sort()).toEqual(['a1', 'a2']);

    expect(fs.existsSync(path.join(libraryA, '.gphotos_catalog', 'gphotos.db'))).toBe(true);
    expect(fs.existsSync(path.join(libraryB, '.gphotos_catalog', 'gphotos.db'))).toBe(true);
  });

  it('shares people across every library, since identities are not library-scoped', () => {
    setActiveLibrary(libraryA);
    const alice: Person = { id: 'p_alice', name: 'Alice', faceCount: 1, photoCount: 1, createdAt: '2026-01-01T00:00:00Z' };
    upsertPerson(alice);
    expect(getAllPeople().map((p) => p.name)).toEqual(['Alice']);

    // Switching to a completely different library must still see Alice —
    // renaming/merging identities happens once, globally.
    setActiveLibrary(libraryB);
    expect(getAllPeople().map((p) => p.name)).toEqual(['Alice']);

    upsertPerson({ id: 'p_bob', name: 'Bob', faceCount: 1, photoCount: 1, createdAt: '2026-01-02T00:00:00Z' });
    expect(getAllPeople().map((p) => p.name).sort()).toEqual(['Alice', 'Bob']);

    setActiveLibrary(libraryA);
    expect(getAllPeople().map((p) => p.name).sort()).toEqual(['Alice', 'Bob']);
  });

  it('reconnecting to a previously-used library is instant (no rescan needed) and preserves its data', () => {
    setActiveLibrary(libraryA);
    upsertPhoto(makePhoto('a1'));

    setActiveLibrary(libraryB);
    upsertPhoto(makePhoto('b1'));

    // Simulate the app reopening library A after having switched away and back.
    setActiveLibrary(libraryA);
    expect(getAllPhotos().map((p) => p.id)).toEqual(['a1']);
  });
});
