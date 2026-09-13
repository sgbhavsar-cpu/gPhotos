import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resetDbForTests, setActiveLibrary } from '../../src/main/services/db';
import { handleStorageSave, handleStorageLoad, STORAGE_KEY, GLOBAL_PEOPLE_KEY } from '../../src/main/services/storageHandlers';
import { Photo } from '../../src/types';

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

describe('storage:save / storage:load handlers (end-to-end)', () => {
  let tempDir: string;
  let libraryDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gphotos_storage_handlers_test_'));
    process.env.GPHOTOS_TEST_DB_DIR = tempDir;
    libraryDir = path.join(tempDir, 'MyPhotos');
    fs.mkdirSync(libraryDir, { recursive: true });
    resetDbForTests();
  });

  afterEach(() => {
    resetDbForTests();
    delete process.env.GPHOTOS_TEST_DB_DIR;
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('round-trips a full library save through to load, matching what the renderer expects back', () => {
    const payload = {
      photos: [makePhoto('p1'), makePhoto('p2')],
      people: [{ id: 'p_alice', name: 'Alice', faceCount: 0, photoCount: 0, createdAt: '2026-01-01T00:00:00Z' }],
      albums: [],
      selectedFolder: libraryDir,
      recentLibraries: [libraryDir],
    };

    const saveResult = handleStorageSave(STORAGE_KEY, payload);
    expect(saveResult.success).toBe(true);
    expect(saveResult.enqueuePhotos).toHaveLength(2);
    expect(saveResult.enqueueLibraryPath).toBe(libraryDir);

    const loaded = handleStorageLoad(STORAGE_KEY);
    expect(loaded.photos.map((p: Photo) => p.id).sort()).toEqual(['p1', 'p2']);
    expect(loaded.people.map((p: any) => p.name)).toEqual(['Alice']);
    expect(loaded.selectedFolder).toBe(libraryDir);
    expect(loaded.recentLibraries).toEqual([libraryDir]);
  });

  it('a later save with fewer photos deletes the removed ones (matches "send full current state" contract)', () => {
    handleStorageSave(STORAGE_KEY, { photos: [makePhoto('p1'), makePhoto('p2'), makePhoto('p3')], selectedFolder: libraryDir });
    expect(handleStorageLoad(STORAGE_KEY).photos).toHaveLength(3);

    handleStorageSave(STORAGE_KEY, { photos: [makePhoto('p1')], selectedFolder: libraryDir });
    const loaded = handleStorageLoad(STORAGE_KEY);
    expect(loaded.photos.map((p: Photo) => p.id)).toEqual(['p1']);
  });

  it('an ordinary library save never wipes people, even with an empty people array', () => {
    setActiveLibrary(libraryDir);
    handleStorageSave(STORAGE_KEY, {
      photos: [makePhoto('p1')],
      people: [{ id: 'p_alice', name: 'Alice', faceCount: 0, photoCount: 0, createdAt: '2026-01-01T00:00:00Z' }],
      selectedFolder: libraryDir,
    });
    expect(handleStorageLoad(STORAGE_KEY).people).toHaveLength(1);

    // A subsequent save with no/empty people (e.g. a stale in-memory snapshot) must not erase Alice.
    handleStorageSave(STORAGE_KEY, { photos: [makePhoto('p1')], people: [], selectedFolder: libraryDir });
    expect(handleStorageLoad(STORAGE_KEY).people.map((p: any) => p.name)).toEqual(['Alice']);
  });

  it('a gphotos_people_v2 save with an empty array DOES clear the registry (Reset & Rescan contract)', () => {
    setActiveLibrary(libraryDir);
    handleStorageSave(GLOBAL_PEOPLE_KEY, [{ id: 'p_alice', name: 'Alice', faceCount: 0, photoCount: 0, createdAt: '2026-01-01T00:00:00Z' }]);
    expect(handleStorageLoad(GLOBAL_PEOPLE_KEY)).toHaveLength(1);

    handleStorageSave(GLOBAL_PEOPLE_KEY, []);
    expect(handleStorageLoad(GLOBAL_PEOPLE_KEY)).toHaveLength(0);
  });

  it('stores an unrecognized key (e.g. the face descriptor cache) as an opaque settings blob without loss', () => {
    const cacheEntries = [['C:\\Photos\\p1.jpg', { faces: [1, 2, 3] }]];
    handleStorageSave('gphotos_face_cache_v2', cacheEntries);
    expect(handleStorageLoad('gphotos_face_cache_v2')).toEqual(cacheEntries);
  });

  it('returns null for an empty/never-saved library, matching the old library.json-absent behavior', () => {
    setActiveLibrary(libraryDir);
    expect(handleStorageLoad(STORAGE_KEY)).toBeNull();
  });
});
