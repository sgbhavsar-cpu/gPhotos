import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { DatabaseSync } from 'node:sqlite';

vi.mock('../../src/main/services/videoExportService', () => ({
  probeMedia: vi.fn(async () => ({ durationSec: 9, hasAudio: false, hasVideo: true })),
}));

import { resetDbForTests, setActiveLibrary, getDbForLibraryPath } from '../../src/main/services/db';
import { switchCatalogLibrary, rescanLocalLibrary } from '../../src/main/services/catalogService';
import { getAllPhotos, setPhotoFavorite } from '../../src/main/services/libraryRepository';

// Rescanning an existing local library picks up newly-added files (e.g. videos) without losing
// edits already made to photos still present — see docs/FEATURE_VIDEO_LIBRARY_SUPPORT.md and
// catalogService.rescanLocalLibrary's doc comment.
describe('rescanLocalLibrary', () => {
  let tempDir: string;
  let libraryDir: string;
  let db: DatabaseSync;

  const pngBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWPgEpHjEpFjgFAABk4A8YCCZIUAAAAASUVORK5CYII=', 'base64');

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gphotos_rescan_test_'));
    process.env.GPHOTOS_TEST_DB_DIR = tempDir;
    libraryDir = path.join(tempDir, 'Lib');
    fs.mkdirSync(libraryDir, { recursive: true });
    resetDbForTests();
  });

  afterEach(() => {
    resetDbForTests();
    delete process.env.GPHOTOS_TEST_DB_DIR;
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  it('a second rescan discovers a video added after the first open, without disturbing existing edits', async () => {
    fs.writeFileSync(path.join(libraryDir, 'photo.png'), pngBytes);

    // First open: indexes just the photo.
    const first = await switchCatalogLibrary(libraryDir);
    expect(first.meta.totalPhotos).toBe(1);
    db = getDbForLibraryPath(libraryDir);

    // The user favorites the existing photo — this must survive the rescan below.
    const existingId = getAllPhotos(db)[0].id;
    setPhotoFavorite(existingId, true);

    // A video is added to the folder after the library was already indexed.
    fs.writeFileSync(path.join(libraryDir, 'clip.mp4'), 'not real video bytes, just needs to exist');

    // Re-opening via switchCatalogLibrary alone would NOT pick it up (db already exists).
    const reopened = await switchCatalogLibrary(libraryDir);
    expect(reopened.meta.totalPhotos).toBe(1);

    // rescanLocalLibrary does pick it up.
    const rescanned = await rescanLocalLibrary(libraryDir);
    expect(rescanned.meta.totalPhotos).toBe(2);

    const allPhotos = getAllPhotos(getDbForLibraryPath(libraryDir));
    const video = allPhotos.find((p) => p.fileName === 'clip.mp4')!;
    const photo = allPhotos.find((p) => p.fileName === 'photo.png')!;
    expect(video.isVideo).toBe(true);
    expect(video.videoDurationSec).toBe(9);
    expect(photo.isFavorite).toBe(true); // the earlier edit was not lost
  });

  it('a file deleted from disk is removed from the catalog on rescan', async () => {
    fs.writeFileSync(path.join(libraryDir, 'a.png'), pngBytes);
    fs.writeFileSync(path.join(libraryDir, 'b.png'), pngBytes);
    const first = await switchCatalogLibrary(libraryDir);
    expect(first.meta.totalPhotos).toBe(2);

    fs.unlinkSync(path.join(libraryDir, 'b.png'));
    const rescanned = await rescanLocalLibrary(libraryDir);
    expect(rescanned.meta.totalPhotos).toBe(1);
    expect(getAllPhotos(getDbForLibraryPath(libraryDir))[0].fileName).toBe('a.png');
  });
});
