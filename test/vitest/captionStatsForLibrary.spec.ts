import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { DatabaseSync } from 'node:sqlite';
import { resetDbForTests, setActiveLibrary, getDbForLibraryPath } from '../../src/main/services/db';
import { upsertPhotos, upsertPhotoContentEntry, getCaptionStatsForLibrary } from '../../src/main/services/libraryRepository';
import type { Photo, PhotoContentEntry } from '../../src/types';

// Feeds the new "AI Description x/y" status shown per network storage (VirtualStorageView.tsx /
// Sidebar.tsx) — see docs/FEATURE_AI_AUTO_TAGGING.md.
describe('getCaptionStatsForLibrary', () => {
  let tempDir: string;
  let libraryDir: string;
  let db: DatabaseSync;

  const photo = (n: number, over: Partial<Photo> = {}): Photo => ({
    id: `p${n}`, filePath: `C:\\Lib\\p${n}.jpg`, fileName: `p${n}.jpg`, fileSize: 1,
    fileDate: '2026-01-01', dateTaken: '2026-01-01', year: 2026, month: 1, day: 1, isFavorite: false,
    ...over,
  }) as Photo;

  const entry = (over: Partial<PhotoContentEntry> = {}): PhotoContentEntry => ({
    caption: 'a photo', tags: [], embedding: null, verdicts: {}, updatedAt: new Date().toISOString(),
    ...over,
  });

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gphotos_caption_stats_test_'));
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

  it('counts captioned photos out of all non-video photos', () => {
    upsertPhotos([photo(1), photo(2), photo(3)], db);
    upsertPhotoContentEntry('p1', entry(), db);
    upsertPhotoContentEntry('p2', entry({ caption: '' }), db); // empty caption — not counted

    const stats = getCaptionStatsForLibrary(libraryDir);
    expect(stats.captionEligibleCount).toBe(3);
    expect(stats.captionedCount).toBe(1);
  });

  it('excludes video photos from the eligible denominator', () => {
    upsertPhotos([photo(1), photo(2, { isVideo: true })], db);
    upsertPhotoContentEntry('p1', entry(), db);

    const stats = getCaptionStatsForLibrary(libraryDir);
    expect(stats.captionEligibleCount).toBe(1);
    expect(stats.captionedCount).toBe(1);
  });

  it('an empty library reports 0/0, not an error', () => {
    expect(getCaptionStatsForLibrary(libraryDir)).toEqual({ captionEligibleCount: 0, captionedCount: 0 });
  });

  it('a non-existent library directory fails safe to 0/0', () => {
    expect(getCaptionStatsForLibrary(path.join(tempDir, 'does-not-exist'))).toEqual({ captionEligibleCount: 0, captionedCount: 0 });
  });
});
