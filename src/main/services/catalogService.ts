import { Photo, CatalogMeta, TimelineMonthSummary, PlaceSummaryItem } from '../../types';
import { setActiveLibrary } from './db';
import {
  getPhotosPage,
  getAllPhotosForSummary,
  getTotalPhotoCount,
  getAllPeople,
  getAllAlbums,
  getSetting,
  setSetting,
} from './libraryRepository';
import { migrateLibraryJsonToSqliteIfNeeded } from './libraryMigration';

const PAGE_SIZE = 100;

type SummaryPhoto = Pick<Photo, 'id' | 'filePath' | 'dateTaken' | 'fileDate' | 'location'>;

/**
 * Pre-computes timeline grouping (Year/Month counts) across all photos.
 */
export function computeTimelineSummary(photos: SummaryPhoto[]): TimelineMonthSummary[] {
  const map = new Map<string, { year: number; month: number; label: string; count: number; firstPhotoIndex: number }>();
  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];

  for (let i = 0; i < photos.length; i++) {
    const p = photos[i];
    const dateStr = p.dateTaken || p.fileDate || new Date().toISOString();
    const d = new Date(dateStr);
    const year = isNaN(d.getFullYear()) ? 2026 : d.getFullYear();
    const month = isNaN(d.getMonth()) ? 8 : d.getMonth() + 1; // 1-12
    const key = `${year}-${String(month).padStart(2, '0')}`;

    if (!map.has(key)) {
      map.set(key, {
        year,
        month,
        label: `${monthNames[month - 1]} ${year}`,
        count: 1,
        firstPhotoIndex: i,
      });
    } else {
      map.get(key)!.count += 1;
    }
  }

  // Sort descending: newest year/month first
  return Array.from(map.values()).sort((a, b) => {
    if (a.year !== b.year) return b.year - a.year;
    return b.month - a.month;
  });
}

/**
 * Pre-computes place summaries so startup never needs to run spatial map clustering.
 */
export function computePlacesSummary(photos: SummaryPhoto[]): PlaceSummaryItem[] {
  const geoPhotos = photos.filter((p) => p.location && p.location.latitude && p.location.longitude);
  const map = new Map<string, PlaceSummaryItem>();

  for (const p of geoPhotos) {
    const loc = p.location!;
    let placeKey = '';
    let albumName = '';

    if (loc.city && loc.country) {
      placeKey = `${loc.city}_${loc.country}`.toLowerCase();
      albumName = `${loc.city}, ${loc.country}`;
    } else if (loc.city) {
      placeKey = loc.city.toLowerCase();
      albumName = loc.city;
    } else {
      const gridLat = loc.latitude.toFixed(1);
      const gridLng = loc.longitude.toFixed(1);
      placeKey = `geo_${gridLat}_${gridLng}`;
      albumName = loc.country
        ? `${loc.country} (${loc.latitude.toFixed(2)}°, ${loc.longitude.toFixed(2)}°)`
        : `Location (${loc.latitude.toFixed(2)}°, ${loc.longitude.toFixed(2)}°)`;
    }

    if (!map.has(placeKey)) {
      map.set(placeKey, {
        id: `place_${placeKey}`,
        name: albumName,
        city: loc.city,
        country: loc.country,
        latitude: loc.latitude,
        longitude: loc.longitude,
        photoCount: 1,
        coverPhotoId: p.id,
        coverFilePath: p.filePath,
      });
    } else {
      map.get(placeKey)!.photoCount += 1;
    }
  }

  return Array.from(map.values()).sort((a, b) => b.photoCount - a.photoCount);
}

function buildMeta(customDir?: string | null): CatalogMeta {
  const photos = getAllPhotosForSummary();
  const people = getAllPeople();
  const albums = getAllAlbums();

  const timelineSummary = computeTimelineSummary(photos);
  const placesSummary = computePlacesSummary(photos);

  const albumsSummary = albums.map((a) => ({
    id: a.id,
    title: a.title,
    count: a.photoIds ? a.photoIds.length : 0,
    coverPhotoId: a.coverPhotoId,
  }));

  const peopleSummary = people.map((p) => ({
    id: p.id,
    name: p.name,
    count: p.faceCount ?? 0,
  }));

  const totalPhotos = photos.length;
  const totalPages = Math.max(1, Math.ceil(totalPhotos / PAGE_SIZE));
  const recentLibraries = getSetting<string[]>('recentLibraries', []);
  const selectedFolder = getSetting<string | null>('selectedFolder', customDir || null);

  return {
    version: 3,
    totalPhotos,
    totalAlbums: albumsSummary.length,
    totalPeople: peopleSummary.length,
    totalPlaces: placesSummary.length,
    earliestDate: totalPhotos > 0 ? photos[totalPhotos - 1].dateTaken || photos[totalPhotos - 1].fileDate : undefined,
    latestDate: totalPhotos > 0 ? photos[0].dateTaken || photos[0].fileDate : undefined,
    timelineSummary,
    placesSummary,
    albumsSummary,
    peopleSummary,
    recentLibraries,
    currentDirectory: selectedFolder,
    selectedFolder,
    pageSize: PAGE_SIZE,
    totalPages,
    lastUpdated: new Date().toISOString(),
  };
}

/**
 * Ensures the active library's database has data, migrating from a legacy
 * library.json on first access if the database is still empty. Safe to call
 * on every request — idempotent and effectively free once already migrated.
 */
export function ensureMigratedIfEmpty(): void {
  if (getTotalPhotoCount() > 0) return;
  try {
    const electron = require('electron');
    if (electron?.app?.getPath) {
      const path = require('path');
      const userDir: string = electron.app.getPath('userData');
      // Cross-compatibility between dev environment (gphotos-desktop) and
      // packaged exe (gPhotos) userData folder names — matches the same
      // fallback used elsewhere (heicRotationStore, embeddedWebServer).
      const appData: string = electron.app.getPath('appData');
      const isAppGPhotos = path.basename(userDir).toLowerCase() === 'gphotos';
      const altDir = isAppGPhotos
        ? path.join(appData, 'gphotos-desktop')
        : path.join(appData, 'gPhotos');
      const candidates = [
        path.join(userDir, 'library.json'),
        path.join(altDir, 'library.json'),
      ];
      for (const candidate of candidates) {
        const result = migrateLibraryJsonToSqliteIfNeeded(candidate);
        if (result.migrated) {
          console.log(`[CatalogService] Migrated legacy library.json into SQLite: ${result.photoCount} photos, ${result.peopleCount} people.`);
          break;
        }
      }
    }
  } catch (err) {
    console.warn('[CatalogService] Legacy migration check failed:', err);
  }
}

/**
 * Returns catalog summary metadata (timeline/places/people/albums summaries)
 * for the given library folder, computed from SQLite.
 */
export async function getCatalogMeta(customDir?: string): Promise<CatalogMeta> {
  setActiveLibrary(customDir || null);
  ensureMigratedIfEmpty();
  return buildMeta(customDir || null);
}

/**
 * Loads a specific page of photos (e.g. Page 0 = first 100 photos) for the
 * given library folder, via an indexed SQL query.
 */
export async function getCatalogPage(
  pageIndex: number,
  pageSize = PAGE_SIZE,
  customDir?: string
): Promise<{ photos: Photo[]; totalPages: number; totalPhotos: number }> {
  setActiveLibrary(customDir || null);
  ensureMigratedIfEmpty();

  const totalPhotos = getTotalPhotoCount();
  const totalPages = Math.max(1, Math.ceil(totalPhotos / pageSize));
  const photos = getPhotosPage(pageIndex, pageSize);

  for (const p of photos) {
    if (!p.isHeicRotated) {
      const target = p.originalRemotePath || p.filePath || '';
      if (/\.(heic|heif)$/i.test(target)) {
        try {
          const { getHeicSavedRotation } = require('./heicRotationStore');
          const rot = getHeicSavedRotation(target);
          if (rot !== 0) {
            p.isHeicRotated = true;
            p.heicRotation = rot;
            p.rotation = rot;
          }
        } catch {}
      }
    }
  }

  return { photos, totalPages, totalPhotos };
}

/**
 * Switches the active library: points subsequent reads/writes at the target
 * folder's own database (instant if it's been opened before — no rescan
 * needed), migrating a legacy library.json into it on first access.
 */
export async function switchCatalogLibrary(
  targetDir: string
): Promise<{ meta: CatalogMeta; firstPage: Photo[] }> {
  setActiveLibrary(targetDir);
  ensureMigratedIfEmpty();

  const recent = new Set(getSetting<string[]>('recentLibraries', []));
  recent.delete(targetDir);
  const updatedRecent = [targetDir, ...Array.from(recent)].slice(0, 10);
  setSetting('recentLibraries', updatedRecent);
  setSetting('selectedFolder', targetDir);

  const meta = buildMeta(targetDir);
  const firstPageResult = await getCatalogPage(0, PAGE_SIZE, targetDir);

  return {
    meta,
    firstPage: firstPageResult.photos,
  };
}
