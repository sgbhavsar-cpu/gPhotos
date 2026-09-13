import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resetDbForTests, setActiveLibrary } from '../../src/main/services/db';
import { upsertPhotos, upsertPeople, upsertAlbum } from '../../src/main/services/libraryRepository';
import { getCatalogMeta, getCatalogPage, switchCatalogLibrary } from '../../src/main/services/catalogService';
import { Photo } from '../../src/types';

function makePhoto(id: string, dateTaken: string): Photo {
  const d = new Date(dateTaken);
  return {
    id,
    filePath: `C:\\Photos\\${id}.jpg`,
    fileName: `${id}.jpg`,
    fileSize: 1000,
    fileDate: '',
    dateTaken,
    year: d.getFullYear(),
    month: d.getMonth() + 1,
    day: d.getDate(),
  };
}

describe('catalogService (SQLite-backed)', () => {
  let tempDir: string;
  let libraryA: string;
  let libraryB: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gphotos_catalog_test_'));
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

  it('getCatalogMeta computes accurate totals and a timeline summary from the active library', async () => {
    setActiveLibrary(libraryA);
    upsertPhotos([
      makePhoto('p1', '2026-01-05T10:00:00Z'),
      makePhoto('p2', '2026-01-20T10:00:00Z'),
      makePhoto('p3', '2025-12-01T10:00:00Z'),
    ]);
    upsertPeople([{ id: 'p_alice', name: 'Alice', faceCount: 1, photoCount: 1, createdAt: '2026-01-01T00:00:00Z' }]);

    const meta = await getCatalogMeta(libraryA);
    expect(meta.totalPhotos).toBe(3);
    expect(meta.totalPeople).toBe(1);
    expect(meta.timelineSummary).toHaveLength(2); // Jan 2026, Dec 2025
    expect(meta.timelineSummary[0].year).toBe(2026); // newest first
    expect(meta.timelineSummary[0].count).toBe(2);
  });

  it('getCatalogPage returns photos newest-first with pagination', async () => {
    setActiveLibrary(libraryA);
    upsertPhotos([
      makePhoto('old', '2025-01-01T00:00:00Z'),
      makePhoto('new', '2026-06-01T00:00:00Z'),
      makePhoto('mid', '2026-01-01T00:00:00Z'),
    ]);

    const page = await getCatalogPage(0, 2, libraryA);
    expect(page.totalPhotos).toBe(3);
    expect(page.totalPages).toBe(2);
    expect(page.photos.map((p) => p.id)).toEqual(['new', 'mid']);

    const page2 = await getCatalogPage(1, 2, libraryA);
    expect(page2.photos.map((p) => p.id)).toEqual(['old']);
  });

  it('switchCatalogLibrary keeps two libraries fully isolated and instantly reconnectable', async () => {
    setActiveLibrary(libraryA);
    upsertPhotos([makePhoto('a1', '2026-01-01T00:00:00Z')]);

    setActiveLibrary(libraryB);
    upsertPhotos([makePhoto('b1', '2026-01-01T00:00:00Z'), makePhoto('b2', '2026-01-02T00:00:00Z')]);

    const switchToA = await switchCatalogLibrary(libraryA);
    expect(switchToA.meta.totalPhotos).toBe(1);
    expect(switchToA.firstPage.map((p) => p.id)).toEqual(['a1']);

    const switchToB = await switchCatalogLibrary(libraryB);
    expect(switchToB.meta.totalPhotos).toBe(2);

    // recentLibraries should now list B most recently used, with A still present.
    expect(switchToB.meta.recentLibraries[0]).toBe(libraryB);
    expect(switchToB.meta.recentLibraries).toContain(libraryA);
  });

  it('computes album and place summaries alongside the timeline', async () => {
    setActiveLibrary(libraryA);
    const photo = { ...makePhoto('p1', '2026-01-01T00:00:00Z'), location: { latitude: 21.17, longitude: 72.83, city: 'Surat', country: 'India' } };
    upsertPhotos([photo]);
    upsertAlbum({ id: 'album1', title: 'Trip', photoIds: ['p1'], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' });

    const meta = await getCatalogMeta(libraryA);
    expect(meta.totalAlbums).toBe(1);
    expect(meta.albumsSummary[0].count).toBe(1);
    expect(meta.totalPlaces).toBe(1);
    expect(meta.placesSummary[0].city).toBe('Surat');
  });
});
