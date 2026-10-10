import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { DatabaseSync } from 'node:sqlite';
import { resetDbForTests, setActiveLibrary, getDbForLibraryPath } from '../../src/main/services/db';
import {
  upsertPhotos,
  getPhotoById,
  replaceFacesForPhoto,
  getFacesForPhoto,
  upsertAlbum,
  getAllAlbums,
  upsertPhotoContentEntry,
  getPhotoContentEntry,
  deletePhotos,
} from '../../src/main/services/libraryRepository';
import type { Photo, Album, DetectedFace, PhotoContentEntry } from '../../src/types';

// Reported gap: deleting a photo (e.g. via the Duplicate Cleaner's "Find Best Shot") left its
// photo_content row (AI caption/tags/embedding) behind forever — deletePhotos only ever cleaned up
// photos/faces/album_photos. See docs/CODE_REVIEW_2026-09-26.md.
describe('deletePhotos: full cleanup across every table that references a photo id', () => {
  let tempDir: string;
  let libraryDir: string;
  let db: DatabaseSync;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gphotos_delete_cleanup_test_'));
    process.env.GPHOTOS_TEST_DB_DIR = tempDir;
    libraryDir = path.join(tempDir, 'Lib');
    fs.mkdirSync(libraryDir, { recursive: true });
    resetDbForTests();
    setActiveLibrary(libraryDir);
    db = getDbForLibraryPath(libraryDir);
  });

  afterEach(() => {
    resetDbForTests();
    delete process.env.GPHOTOS_TEST_DB_DIR;
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  const photo = (id: string): Photo => ({
    id, filePath: `C:\\Lib\\${id}.jpg`, fileName: `${id}.jpg`, fileSize: 1000,
    fileDate: '2026-01-01T00:00:00Z', dateTaken: '2026-01-01T00:00:00Z', year: 2026, month: 1, day: 1,
    isFavorite: false,
  }) as Photo;

  const face = (photoId: string, n: number): DetectedFace => ({
    id: `${photoId}_f${n}`, photoId, box: { x: n, y: n, width: 10, height: 10 },
    descriptor: new Array(128).fill(0.1), confidence: 0.9, isConfirmed: false,
  }) as any;

  const contentEntry = (): PhotoContentEntry => ({
    caption: 'a duplicate burst shot', tags: ['burst'], embedding: [0.1, 0.2], verdicts: {},
    updatedAt: '2026-01-01T00:00:00.000Z',
  });

  it('deletes the photo, its faces, its album links, and its photo_content row — leaving an untouched photo intact', () => {
    upsertPhotos([photo('keep'), photo('gone')], db);
    replaceFacesForPhoto('keep', [face('keep', 0)], false, db);
    replaceFacesForPhoto('gone', [face('gone', 0), face('gone', 1)], false, db);
    upsertPhotoContentEntry('keep', contentEntry(), db);
    upsertPhotoContentEntry('gone', contentEntry(), db);
    const album: Album = { id: 'alb1', title: 'Trip', photoIds: ['keep', 'gone'], createdAt: 'x', updatedAt: 'x' } as any;
    upsertAlbum(album, db);

    deletePhotos(['gone'], db);

    expect(getPhotoById('gone', db)).toBeNull();
    expect(getFacesForPhoto('gone', db)).toEqual([]);
    expect(getPhotoContentEntry('gone', db)).toBeNull();
    expect(getAllAlbums(db)[0].photoIds).toEqual(['keep']);

    // Nothing belonging to the untouched photo was collaterally removed.
    expect(getPhotoById('keep', db)).not.toBeNull();
    expect(getFacesForPhoto('keep', db)).toHaveLength(1);
    expect(getPhotoContentEntry('keep', db)).not.toBeNull();
  });

  it('a photo with no photo_content row (never analysed) deletes cleanly, no error', () => {
    upsertPhotos([photo('p1')], db);
    expect(() => deletePhotos(['p1'], db)).not.toThrow();
    expect(getPhotoById('p1', db)).toBeNull();
  });
});
