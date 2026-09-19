import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resetDbForTests, setActiveLibrary, getDb, getGlobalDb } from '../../src/main/services/db';
import {
  upsertPhoto,
  getAllPhotos,
  replaceFacesForPhoto,
  getAllFaces,
  upsertPerson,
  getAllPeople,
} from '../../src/main/services/libraryRepository';
import { FACE_DATA_VERSION } from '../../src/main/services/faceEngineVersion';
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
    faceScanCompleted: true,
    facesLocked: true,
  };
}

function makeFace(id: string, photoId: string): DetectedFace {
  return {
    id,
    photoId,
    box: { x: 0, y: 0, width: 100, height: 100 },
    descriptor: [0.1, 0.2, 0.3],
    confidence: 0.9,
    isConfirmed: true,
  };
}

function makePerson(id: string): Person {
  return { id, name: 'Alice', faceCount: 1, photoCount: 1, createdAt: new Date().toISOString() };
}

describe('full-reset migration when the face detection engine changes', () => {
  let tempDir: string;
  let libraryDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gphotos_facereset_test_'));
    process.env.GPHOTOS_TEST_DB_DIR = tempDir;
    libraryDir = path.join(tempDir, 'Library');
    fs.mkdirSync(libraryDir, { recursive: true });
    resetDbForTests();
    setActiveLibrary(libraryDir);
  });

  afterEach(() => {
    resetDbForTests();
    delete process.env.GPHOTOS_TEST_DB_DIR;
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('does not touch data already on the current engine version', () => {
    upsertPhoto(makePhoto('p1'));
    replaceFacesForPhoto('p1', [makeFace('f1', 'p1')]);
    upsertPerson(makePerson('person1'));

    // Reopen the connection without changing the stored version — simulates
    // a normal app restart on the same engine version.
    resetDbForTests();
    setActiveLibrary(libraryDir);

    expect(getAllFaces().length).toBe(1);
    expect(getAllPeople().length).toBe(1);
    const photo = getAllPhotos().find((p) => p.id === 'p1');
    expect(photo?.faceScanCompleted).toBe(true);
    expect(photo?.facesLocked).toBe(true);
  });

  it('wipes faces/people and resets photo flags when the stored engine version is stale', () => {
    upsertPhoto(makePhoto('p1'));
    replaceFacesForPhoto('p1', [makeFace('f1', 'p1')]);
    upsertPerson(makePerson('person1'));

    // Simulate a database created under a previous (incompatible) detection
    // engine by rolling back the stored version marker directly — on BOTH
    // the per-library db (faces live there) and the global db (people live
    // there), since each database file gates its own reset independently
    // and a real pre-upgrade install would have both equally stale.
    getDb().prepare(`UPDATE meta SET value = ? WHERE key = 'face_data_version'`).run('some-old-engine-v0');
    getGlobalDb().prepare(`UPDATE meta SET value = ? WHERE key = 'face_data_version'`).run('some-old-engine-v0');

    // Reopening the connection re-applies the schema, which should now see
    // the mismatch and perform the one-time reset.
    resetDbForTests();
    setActiveLibrary(libraryDir);

    expect(getAllFaces().length).toBe(0);
    expect(getAllPeople().length).toBe(0);
    const photo = getAllPhotos().find((p) => p.id === 'p1');
    expect(photo?.faceScanCompleted).toBe(false);
    expect(photo?.facesLocked).toBe(false);
    // The photo row itself (and its non-face metadata) must survive the reset.
    expect(photo?.fileName).toBe('p1.jpg');
  });

  it('stamps a brand-new database with the current version with no visible side effects', () => {
    const stored = getDb().prepare(`SELECT value FROM meta WHERE key = 'face_data_version'`).get() as
      | { value: string }
      | undefined;
    expect(stored?.value).toBe(FACE_DATA_VERSION);
  });
});
