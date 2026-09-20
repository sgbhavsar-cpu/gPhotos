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

  it('round-trips a full library save through to load, matching what the renderer expects back', async () => {
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

    const loaded = await handleStorageLoad(STORAGE_KEY);
    expect(loaded.photos.map((p: Photo) => p.id).sort()).toEqual(['p1', 'p2']);
    expect(loaded.people.map((p: any) => p.name)).toEqual(['Alice']);
    expect(loaded.selectedFolder).toBe(libraryDir);
    expect(loaded.recentLibraries).toEqual([libraryDir]);
  });

  it('a later save with fewer photos deletes the removed ones (matches "send full current state" contract)', async () => {
    handleStorageSave(STORAGE_KEY, { photos: [makePhoto('p1'), makePhoto('p2'), makePhoto('p3')], selectedFolder: libraryDir });
    expect((await handleStorageLoad(STORAGE_KEY)).photos).toHaveLength(3);

    handleStorageSave(STORAGE_KEY, { photos: [makePhoto('p1')], selectedFolder: libraryDir });
    const loaded = await handleStorageLoad(STORAGE_KEY);
    expect(loaded.photos.map((p: Photo) => p.id)).toEqual(['p1']);
  });

  it('an ordinary library save never wipes people, even with an empty people array', async () => {
    setActiveLibrary(libraryDir);
    handleStorageSave(STORAGE_KEY, {
      photos: [makePhoto('p1')],
      people: [{ id: 'p_alice', name: 'Alice', faceCount: 0, photoCount: 0, createdAt: '2026-01-01T00:00:00Z' }],
      selectedFolder: libraryDir,
    });
    expect((await handleStorageLoad(STORAGE_KEY)).people).toHaveLength(1);

    // A subsequent save with no/empty people (e.g. a stale in-memory snapshot) must not erase Alice.
    handleStorageSave(STORAGE_KEY, { photos: [makePhoto('p1')], people: [], selectedFolder: libraryDir });
    expect((await handleStorageLoad(STORAGE_KEY)).people.map((p: any) => p.name)).toEqual(['Alice']);
  });

  it('a gphotos_people_v2 save with an empty array DOES clear the registry (Reset & Rescan contract)', async () => {
    setActiveLibrary(libraryDir);
    handleStorageSave(GLOBAL_PEOPLE_KEY, [{ id: 'p_alice', name: 'Alice', faceCount: 0, photoCount: 0, createdAt: '2026-01-01T00:00:00Z' }]);
    expect(await handleStorageLoad(GLOBAL_PEOPLE_KEY)).toHaveLength(1);

    handleStorageSave(GLOBAL_PEOPLE_KEY, []);
    expect(await handleStorageLoad(GLOBAL_PEOPLE_KEY)).toHaveLength(0);
  });

  it('stores an unrecognized key (e.g. the face descriptor cache) as an opaque settings blob without loss', async () => {
    const cacheEntries = [['C:\\Photos\\p1.jpg', { faces: [1, 2, 3] }]];
    handleStorageSave('gphotos_face_cache_v2', cacheEntries);
    expect(await handleStorageLoad('gphotos_face_cache_v2')).toEqual(cacheEntries);
  });

  it('returns null for an empty/never-saved library, matching the old library.json-absent behavior', async () => {
    setActiveLibrary(libraryDir);
    expect(await handleStorageLoad(STORAGE_KEY)).toBeNull();
  });

  it('isPartialPageSet:true merges instead of destructively replacing (SQLite catalog pagination contract)', async () => {
    // Simulates the SQLite fast-path: a library with 3 photos indexed, but
    // the renderer has only loaded the first "page" (1 photo) into memory
    // when an immediate save fires (e.g. right after switchLibrary, or
    // toggling a favorite on the one loaded photo). Before this contract
    // existed, sending that partial photos array through the ordinary
    // (destructive) save path deleted the other two photos' rows the
    // instant any save happened — this is what made a switched-to library
    // randomly appear "stuck" at whatever count happened to be loaded.
    handleStorageSave(STORAGE_KEY, {
      photos: [makePhoto('p1'), makePhoto('p2'), makePhoto('p3')],
      selectedFolder: libraryDir,
    });
    expect((await handleStorageLoad(STORAGE_KEY)).photos).toHaveLength(3);

    handleStorageSave(STORAGE_KEY, {
      photos: [makePhoto('p1')],
      isPartialPageSet: true,
      selectedFolder: libraryDir,
    });
    const loaded = await handleStorageLoad(STORAGE_KEY);
    expect(loaded.photos.map((p: Photo) => p.id).sort()).toEqual(['p1', 'p2', 'p3']);
  });

  it('isPartialPageSet:true still updates fields on the photos it does include (e.g. a favorite toggle)', async () => {
    handleStorageSave(STORAGE_KEY, {
      photos: [makePhoto('p1'), makePhoto('p2')],
      selectedFolder: libraryDir,
    });

    const favorited = { ...makePhoto('p1'), isFavorite: true };
    handleStorageSave(STORAGE_KEY, {
      photos: [favorited],
      isPartialPageSet: true,
      selectedFolder: libraryDir,
    });

    const loaded = await handleStorageLoad(STORAGE_KEY);
    expect(loaded.photos).toHaveLength(2);
    const p1 = loaded.photos.find((p: Photo) => p.id === 'p1');
    expect(p1.isFavorite).toBe(true);
  });

  // Regression: a stale/empty albums array in an otherwise-ordinary library
  // save (e.g. the renderer hadn't yet repopulated in-memory albums for a
  // just-switched-to library — see switchLibrary()'s doc comment) used to
  // silently wipe every real album this library had, mirroring the exact
  // "albums become empty" bug report. replaceAllAlbums' guard (matching
  // replaceAllPhotos' identical one) must no-op instead.
  it('an album save with an empty array never wipes existing albums (matches the photos/people no-wipe contract)', async () => {
    setActiveLibrary(libraryDir);
    handleStorageSave(STORAGE_KEY, {
      photos: [makePhoto('p1')],
      albums: [{ id: 'album1', title: 'Trip', photoIds: ['p1'], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }],
      selectedFolder: libraryDir,
    });
    expect((await handleStorageLoad(STORAGE_KEY)).albums).toHaveLength(1);

    // A subsequent save with a stale/empty albums array must not erase it.
    handleStorageSave(STORAGE_KEY, { photos: [makePhoto('p1')], albums: [], selectedFolder: libraryDir });
    const loaded = await handleStorageLoad(STORAGE_KEY);
    expect(loaded.albums).toHaveLength(1);
    expect(loaded.albums[0].id).toBe('album1');
  });

  it('an album save with a genuinely different (non-empty) set still replaces removed albums', async () => {
    setActiveLibrary(libraryDir);
    handleStorageSave(STORAGE_KEY, {
      photos: [makePhoto('p1')],
      albums: [
        { id: 'album1', title: 'Trip', photoIds: ['p1'], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
        { id: 'album2', title: 'Party', photoIds: ['p1'], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
      ],
      selectedFolder: libraryDir,
    });

    handleStorageSave(STORAGE_KEY, {
      photos: [makePhoto('p1')],
      albums: [{ id: 'album1', title: 'Trip', photoIds: ['p1'], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }],
      selectedFolder: libraryDir,
    });

    const loaded = await handleStorageLoad(STORAGE_KEY);
    expect(loaded.albums.map((a: any) => a.id)).toEqual(['album1']);
  });

  it('gphotos_virtual_storages_v1 collapses entries pointing at the same network source, keeping the most recently synced', async () => {
    const VIRTUAL_STORAGES_KEY = 'gphotos_virtual_storages_v1';
    setActiveLibrary(libraryDir);

    // Reproduces the real bug: two saved configs for the same underlying
    // network folder (one under the user's chosen name, one under a stale
    // auto-derived name from a since-fixed code path) — a save carrying
    // both (e.g. from a stale renderer snapshot written after a fresher
    // session had already deduped) must not let the duplicate survive.
    handleStorageSave(VIRTUAL_STORAGES_KEY, [
      {
        id: 'storage_correct',
        name: 'hemlata',
        networkSourcePath: 'V:\\Backups\\hemlata',
        lastSynced: '2026-09-14T11:06:27.611Z',
      },
      {
        id: 'storage_stale_duplicate',
        name: '20230423 varshitap parna mom hemlataben',
        networkSourcePath: 'V:\\Backups\\hemlata',
        lastSynced: '2026-09-14T08:20:52.675Z',
      },
      {
        id: 'storage_other',
        name: 'Jainish',
        networkSourcePath: 'C:\\OneDrive\\J',
        lastSynced: '2026-09-14T09:00:00.000Z',
      },
    ]);

    const loaded = await handleStorageLoad(VIRTUAL_STORAGES_KEY);
    expect(loaded).toHaveLength(2);
    const names = loaded.map((s: any) => s.name).sort();
    expect(names).toEqual(['Jainish', 'hemlata']);
  });
});
