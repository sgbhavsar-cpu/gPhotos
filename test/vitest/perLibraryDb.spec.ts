import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resetDbForTests, setActiveLibrary, getDbForLibraryPath } from '../../src/main/services/db';
import {
  upsertPhoto,
  upsertPhotos,
  replaceAllPhotos,
  getAllPhotos,
  getTotalPhotoCount,
  upsertPerson,
  getAllPeople,
  getFacesForPhoto,
} from '../../src/main/services/libraryRepository';
import { Photo, Person, DetectedFace } from '../../src/types';

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

  // Regression: the renderer debounce-saves its whole in-memory photo list
  // periodically (libraryStore.ts's scheduleDebouncedSave -> upsertPhotos),
  // regardless of which library happens to be "active" in the main process
  // at that moment. upsertPhotos used to always target getDb()'s ambient
  // pointer for every photo in the batch — for a virtual/network storage
  // photo, if some OTHER library was active when that autosave fired, its
  // faces (freshly, correctly detected and persisted moments earlier via a
  // properly-scoped call) would get silently upserted into the wrong
  // database instead of updated/preserved in its own.
  it('upsertPhotos targets each virtual photo\'s own storage database, not whichever library is "active"', () => {
    const mirrorRoot = path.join(tempDir, 'Mirrors');
    const storageName = 'VStorage';
    const mirrorFolder = path.join(mirrorRoot, storageName);
    fs.mkdirSync(mirrorFolder, { recursive: true });

    // Some unrelated local library is "active" — simulating the renderer
    // having browsed somewhere else earlier in the session.
    setActiveLibrary(libraryA);

    const face: DetectedFace = {
      id: 'face_1',
      photoId: 'virtual_1',
      box: { x: 1, y: 1, width: 10, height: 10 },
      descriptor: [0.1, 0.2, 0.3],
      confidence: 0.9,
      isConfirmed: false,
      isManual: false,
    };
    const virtualPhoto: Photo = {
      id: 'virtual_1',
      filePath: path.join(mirrorFolder, 'photo.jpg'),
      fileName: 'photo.jpg',
      fileSize: 1000,
      fileDate: '',
      dateTaken: '2026-01-01T00:00:00Z',
      year: 2026,
      month: 1,
      day: 1,
      isVirtual: true,
      storageName,
      faces: [face],
    };

    upsertPhotos([virtualPhoto]);

    const ownDb = getDbForLibraryPath(mirrorFolder);
    expect(getTotalPhotoCount(ownDb)).toBe(1);
    expect(getFacesForPhoto('virtual_1', ownDb).map((f) => f.id)).toEqual(['face_1']);

    // The "active" library (libraryA) must be completely untouched by this.
    expect(getTotalPhotoCount()).toBe(0);
  });

  it('replaceAllPhotos resolves the database from a virtual batch\'s own storage, not the "active" library', () => {
    const mirrorRoot = path.join(tempDir, 'Mirrors');
    const storageName = 'VStorage2';
    const mirrorFolder = path.join(mirrorRoot, storageName);
    fs.mkdirSync(mirrorFolder, { recursive: true });

    setActiveLibrary(libraryB);
    upsertPhoto(makePhoto('b1')); // pre-existing, unrelated photo in the "active" library

    const virtualPhoto: Photo = {
      id: 'virtual_2',
      filePath: path.join(mirrorFolder, 'photo2.jpg'),
      fileName: 'photo2.jpg',
      fileSize: 1000,
      fileDate: '',
      dateTaken: '2026-01-01T00:00:00Z',
      year: 2026,
      month: 1,
      day: 1,
      isVirtual: true,
      storageName,
    };

    const result = replaceAllPhotos([virtualPhoto]);
    expect(result.skipped).toBe(false);

    const ownDb = getDbForLibraryPath(mirrorFolder);
    expect(getTotalPhotoCount(ownDb)).toBe(1);

    // libraryB's own photo must survive untouched — replaceAllPhotos must
    // not have targeted (and cleared) libraryB just because it was "active".
    expect(getTotalPhotoCount()).toBe(1);
    expect(getAllPhotos().map((p) => p.id)).toEqual(['b1']);
  });
});
