import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { DatabaseSync } from 'node:sqlite';
import { resetDbForTests, setActiveLibrary, getDbForLibraryPath } from '../../src/main/services/db';
import { upsertPhotos, getPhotoById } from '../../src/main/services/libraryRepository';
import type { Photo } from '../../src/types';

// isVideo/videoDurationSec round-trip through the real SQLite schema (see
// docs/FEATURE_VIDEO_LIBRARY_SUPPORT.md §2.2) — same isolated-temp-DB setup as wholeLibraryReads.spec.ts.
describe('libraryRepository: isVideo / videoDurationSec persist through the DB', () => {
  let tempDir: string;
  let libraryDir: string;
  let db: DatabaseSync;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gphotos_video_repo_test_'));
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

  const basePhoto = (over: Partial<Photo>): Photo => ({
    id: 'p1', filePath: 'C:\\Videos\\clip.mp4', fileName: 'clip.mp4', fileSize: 1000,
    fileDate: '2026-01-01T00:00:00Z', dateTaken: '2026-01-01T00:00:00Z', year: 2026, month: 1, day: 1,
    isFavorite: false,
    ...over,
  }) as Photo;

  it('a video photo round-trips isVideo:true and its duration', () => {
    upsertPhotos([basePhoto({ isVideo: true, videoDurationSec: 42.5 })], db);
    const reloaded = getPhotoById('p1', db)!;
    expect(reloaded.isVideo).toBe(true);
    expect(reloaded.videoDurationSec).toBe(42.5);
  });

  it('a photo (not a video) round-trips isVideo as falsy and no duration', () => {
    upsertPhotos([basePhoto({ id: 'p2', filePath: 'C:\\Photos\\a.jpg', fileName: 'a.jpg' })], db);
    const reloaded = getPhotoById('p2', db)!;
    expect(reloaded.isVideo).toBeFalsy();
    expect(reloaded.videoDurationSec).toBeUndefined();
  });

  it('an UPDATE (upsert over an existing row) correctly changes isVideo/duration', () => {
    upsertPhotos([basePhoto({ isVideo: true, videoDurationSec: 10 })], db);
    upsertPhotos([basePhoto({ isVideo: true, videoDurationSec: 20 })], db);
    const reloaded = getPhotoById('p1', db)!;
    expect(reloaded.videoDurationSec).toBe(20);
  });
});
