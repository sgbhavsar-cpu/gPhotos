import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getDb, resetDbForTests } from '../../src/main/services/db';
import { migrateLibraryJsonToSqliteIfNeeded } from '../../src/main/services/libraryMigration';
import { getAllPhotos, getAllPeople, getAllFaces, getAllAlbums, getSetting } from '../../src/main/services/libraryRepository';

describe('library.json -> SQLite migration', () => {
  let tempDir: string;
  let libraryJsonPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gphotos_migration_test_'));
    process.env.GPHOTOS_TEST_DB_DIR = tempDir;
    resetDbForTests();
    libraryJsonPath = path.join(tempDir, 'library.json');
  });

  afterEach(() => {
    resetDbForTests();
    delete process.env.GPHOTOS_TEST_DB_DIR;
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  function writeFixtureLibrary() {
    const fixture = {
      gphotos_library_v1: {
        photos: [
          {
            id: 'photo_1',
            filePath: 'C:\\Photos\\a.jpg',
            fileName: 'a.jpg',
            fileSize: 12345,
            fileDate: '2026-01-01T00:00:00Z',
            dateTaken: '2026-01-01T10:00:00Z',
            year: 2026,
            month: 1,
            day: 1,
            width: 4000,
            height: 3000,
            isFavorite: true,
            exif: { cameraMake: 'Canon', iso: 100 },
            location: { latitude: 12.34, longitude: 56.78, city: 'Surat' },
            faces: [
              {
                id: 'face_1',
                photoId: 'photo_1',
                box: { x: 10, y: 10, width: 50, height: 50 },
                descriptor: [0.1, 0.2, 0.3],
                personId: 'person_alice',
                confidence: 0.95,
                isConfirmed: true,
              },
            ],
          },
          {
            id: 'photo_2',
            filePath: 'C:\\Photos\\b.jpg',
            fileName: 'b.jpg',
            fileSize: 6789,
            fileDate: '2026-02-01T00:00:00Z',
            dateTaken: '2026-02-01T10:00:00Z',
            year: 2026,
            month: 2,
            day: 1,
            faces: [],
          },
        ],
        people: [
          { id: 'person_alice', name: 'Alice', faceCount: 1, photoCount: 1, createdAt: '2026-01-01T00:00:00Z' },
        ],
        faces: [],
        albums: [
          {
            id: 'album_1',
            title: 'Trip',
            photoIds: ['photo_1', 'photo_2'],
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          },
        ],
        selectedFolder: 'C:\\Photos',
        recentLibraries: ['C:\\Photos', 'C:\\Old'],
      },
      // A person only present in the global registry (not in this library's
      // active people list) — must survive the migration too, per the app's
      // "never lose a custom name" invariant.
      gphotos_people_v2: [
        { id: 'person_alice', name: 'Alice', faceCount: 1, photoCount: 1, createdAt: '2026-01-01T00:00:00Z' },
        { id: 'person_bob_orphaned', name: 'Bob', faceCount: 0, photoCount: 0, createdAt: '2025-12-01T00:00:00Z' },
      ],
    };
    fs.writeFileSync(libraryJsonPath, JSON.stringify(fixture, null, 2), 'utf-8');
  }

  it('migrates photos, people (including orphaned registry-only people), faces, and albums with no data loss', () => {
    writeFixtureLibrary();

    const result = migrateLibraryJsonToSqliteIfNeeded(libraryJsonPath);

    expect(result.migrated).toBe(true);
    expect(result.photoCount).toBe(2);
    expect(result.peopleCount).toBe(2); // Alice + orphaned Bob
    expect(result.faceCount).toBe(1);
    expect(result.albumCount).toBe(1);

    const photos = getAllPhotos();
    expect(photos).toHaveLength(2);
    const photo1 = photos.find((p) => p.id === 'photo_1')!;
    expect(photo1).toBeTruthy();
    expect(photo1.isFavorite).toBe(true);
    expect(photo1.exif?.cameraMake).toBe('Canon');
    expect(photo1.location?.city).toBe('Surat');
    expect(photo1.faces).toHaveLength(1);
    expect(photo1.faces![0].personId).toBe('person_alice');
    expect(photo1.faces![0].descriptor).toEqual([0.1, 0.2, 0.3]);

    const people = getAllPeople();
    expect(people.map((p) => p.name).sort()).toEqual(['Alice', 'Bob']);
    expect(people.find((p) => p.id === 'person_bob_orphaned')).toBeTruthy();

    const faces = getAllFaces();
    expect(faces).toHaveLength(1);
    expect(faces[0].id).toBe('face_1');

    const albums = getAllAlbums();
    expect(albums).toHaveLength(1);
    expect(albums[0].photoIds).toEqual(['photo_1', 'photo_2']);

    expect(getSetting('selectedFolder', null)).toBe('C:\\Photos');
    expect(getSetting('recentLibraries', [])).toEqual(['C:\\Photos', 'C:\\Old']);
  });

  it('renames library.json to a timestamped backup after a successful migration, never deleting it', () => {
    writeFixtureLibrary();
    const result = migrateLibraryJsonToSqliteIfNeeded(libraryJsonPath);

    expect(fs.existsSync(libraryJsonPath)).toBe(false);
    expect(result.backupPath).toBeTruthy();
    expect(fs.existsSync(result.backupPath!)).toBe(true);
    const backupContent = JSON.parse(fs.readFileSync(result.backupPath!, 'utf-8'));
    expect(backupContent.gphotos_library_v1.photos).toHaveLength(2);
  });

  it('is idempotent: running it twice never duplicates or re-processes data', () => {
    writeFixtureLibrary();
    const first = migrateLibraryJsonToSqliteIfNeeded(libraryJsonPath);
    expect(first.migrated).toBe(true);

    // library.json has been renamed away; re-running against the same path
    // must be a safe no-op (source file no longer exists at that path AND
    // the DB already has data).
    const second = migrateLibraryJsonToSqliteIfNeeded(libraryJsonPath);
    expect(second.migrated).toBe(false);

    expect(getAllPhotos()).toHaveLength(2);
    expect(getAllPeople()).toHaveLength(2);
  });

  it('does nothing and reports no-source-file when library.json does not exist', () => {
    const result = migrateLibraryJsonToSqliteIfNeeded(libraryJsonPath);
    expect(result.migrated).toBe(false);
    expect(result.reason).toBe('no-source-file');
  });

  it('does not crash or lose the file on unparsable JSON, and leaves the file in place for inspection', () => {
    fs.writeFileSync(libraryJsonPath, '{ this is not valid json ][', 'utf-8');
    const result = migrateLibraryJsonToSqliteIfNeeded(libraryJsonPath);
    expect(result.migrated).toBe(false);
    expect(result.reason).toMatch(/unreadable-source-file/);
    expect(fs.existsSync(libraryJsonPath)).toBe(true);
    expect(getAllPhotos()).toHaveLength(0);
  });

  it('handles a library with zero photos/people/albums without error', () => {
    fs.writeFileSync(libraryJsonPath, JSON.stringify({ gphotos_library_v1: {} }), 'utf-8');
    const result = migrateLibraryJsonToSqliteIfNeeded(libraryJsonPath);
    expect(result.migrated).toBe(true);
    expect(result.photoCount).toBe(0);
    expect(result.peopleCount).toBe(0);
  });
});
