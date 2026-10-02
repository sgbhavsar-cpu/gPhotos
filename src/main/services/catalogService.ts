import fs from 'fs';
import { Photo, CatalogMeta, TimelineMonthSummary, PlaceSummaryItem, Album } from '../../types';
import type { DatabaseSync } from 'node:sqlite';
import { setActiveLibrary, getDbPath, getDbForLibraryPath, getDb } from './db';
import {
  getPhotosPage,
  getTotalPhotoCount,
  getAllPeople,
  getAllAlbums,
  getAllPhotos,
  getSetting,
  setSetting,
  replaceAllPhotos,
} from './libraryRepository';
import { migrateLibraryJsonToSqliteIfNeeded } from './libraryMigration';
import { scanPhotoDirectory } from './fileOrganizer';

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

function placeKeyAndName(loc: NonNullable<SummaryPhoto['location']>): { placeKey: string; albumName: string } {
  // A custom label (set via "rename this location" on the map) is the user's own deliberate name
  // for this spot and always wins over the auto-derived "City, Country" string — see the identical
  // fix/comment in the renderer's placesService.ts (groupPhotosByPlace). This is a separate,
  // SQL-backed fast-path duplicate of that same naming logic (startup/catalog summary, instead of
  // recomputing from the full in-memory photo list), so it needed the identical fix on its own —
  // renaming a cluster to "Andaman" kept showing as "Andaman, India" after a restart specifically
  // because this copy of the logic never looked at the label either.
  const customLabel = loc.label?.trim();
  if (loc.city && loc.country) {
    return { placeKey: `${loc.city}_${loc.country}`.toLowerCase(), albumName: customLabel || `${loc.city}, ${loc.country}` };
  }
  if (loc.city) {
    return { placeKey: loc.city.toLowerCase(), albumName: customLabel || loc.city };
  }
  const gridLat = loc.latitude.toFixed(1);
  const gridLng = loc.longitude.toFixed(1);
  return {
    placeKey: `geo_${gridLat}_${gridLng}`,
    albumName: loc.country
      ? `${loc.country} (${loc.latitude.toFixed(2)}°, ${loc.longitude.toFixed(2)}°)`
      : `Location (${loc.latitude.toFixed(2)}°, ${loc.longitude.toFixed(2)}°)`,
  };
}

/**
 * Pre-computes place summaries so startup never needs to run spatial map clustering.
 */
export function computePlacesSummary(photos: SummaryPhoto[]): PlaceSummaryItem[] {
  const geoPhotos = photos.filter((p) => p.location && p.location.latitude && p.location.longitude);
  const map = new Map<string, PlaceSummaryItem>();

  for (const p of geoPhotos) {
    const loc = p.location!;
    const { placeKey, albumName } = placeKeyAndName(loc);

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

// Rows whose (local-time) year/month can be read straight off the ISO string, so SQL can GROUP BY
// it exactly like `new Date(str)` + getFullYear()/getMonth() would: either a tz-less date-time (JS
// treats it as local wall time, so its own Y-M is the answer; day 01-28 so DST gaps can't cross a
// month) or a UTC ('Z') one on days 02-27 (any UTC->local shift is under a day, so the month can't
// change whatever the machine's timezone/historical DST rules). Everything else (boundary days,
// offsets, date-only, odd/invalid strings, empty) goes through the original JS logic.
const FAST_MONTH_SQL = `(
  d GLOB '[12][0-9][0-9][0-9]-[01][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-5][0-9]*'
  AND substr(d, 6, 2) BETWEEN '01' AND '12'
  AND substr(d, 12, 2) < '24'
  AND (
    ((substr(d, 20) = '' OR substr(d, 20) GLOB '.[0-9][0-9][0-9]') AND substr(d, 9, 2) BETWEEN '01' AND '28')
    OR ((substr(d, 20) = 'Z' OR substr(d, 20) GLOB '.[0-9][0-9][0-9]Z') AND substr(d, 9, 2) BETWEEN '02' AND '27')
  )
)`;

// Only the covering-index columns (date_taken, id) go through the window, so it streams from
// idx_photos_date_taken_id without touching table rows; anything else is joined back per selected row.
const DATE_RANK_CTE = `WITH r AS (
  SELECT id, date_taken AS d, ROW_NUMBER() OVER (ORDER BY date_taken DESC, id DESC) - 1 AS rn
  FROM photos
)`;

/**
 * Same result as computeTimelineSummary(<all photos in date_taken DESC, id DESC order>), but the bulk
 * of the counting happens in SQLite (GROUP BY year-month with MIN(row number) as firstPhotoIndex) and
 * only the unusual date strings are pushed through the original JS logic — no photo list is loaded.
 */
export function computeTimelineSummarySql(db: DatabaseSync = getDb()): TimelineMonthSummary[] {
  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];
  const map = new Map<string, TimelineMonthSummary>();

  const fast = db
    .prepare(`${DATE_RANK_CTE} SELECT substr(d, 1, 7) AS ym, COUNT(*) AS c, MIN(rn) AS fi FROM r WHERE ${FAST_MONTH_SQL} GROUP BY ym`)
    .all() as Array<{ ym: string; c: number; fi: number }>;
  for (const row of fast) {
    const year = Number(row.ym.slice(0, 4));
    const month = Number(row.ym.slice(5, 7));
    map.set(row.ym, { year, month, label: `${monthNames[month - 1]} ${year}`, count: row.c, firstPhotoIndex: row.fi });
  }

  const rest = db
    .prepare(`${DATE_RANK_CTE} SELECT rn, d, (SELECT file_date FROM photos WHERE id = r.id) AS f FROM r WHERE NOT ${FAST_MONTH_SQL} ORDER BY rn`)
    .all() as Array<{ rn: number; d: string; f: string | null }>;
  if (rest.length > 0) {
    const slow = computeTimelineSummary(rest.map((x) => ({ id: '', filePath: '', dateTaken: x.d, fileDate: x.f || '' })));
    for (const e of slow) {
      const key = `${e.year}-${String(e.month).padStart(2, '0')}`;
      const rn = rest[e.firstPhotoIndex].rn;
      const cur = map.get(key);
      if (cur) {
        cur.count += e.count;
        cur.firstPhotoIndex = Math.min(cur.firstPhotoIndex, rn);
      } else {
        map.set(key, { ...e, firstPhotoIndex: rn });
      }
    }
  }

  return Array.from(map.values()).sort((a, b) => (a.year !== b.year ? b.year - a.year : b.month - a.month));
}

/**
 * Same result as computePlacesSummary(<all photos in date_taken DESC, id DESC order>). SQLite groups the
 * geotagged photos by (city, country) — or by exact coordinates when there is no city — keeping the
 * first photo of each group; only one row per group is then parsed in JS to derive the place key/name
 * (JS toLowerCase/toFixed semantics), and groups sharing a key are merged in first-photo order.
 */
export function computePlacesSummarySql(db: DatabaseSync = getDb()): PlaceSummaryItem[] {
  const groups = db
    .prepare(
      // MAX(date_taken || char(1) || id) is the (date_taken, id) tuple max as one scalar (char(1) sorts
      // below every real character, so a shorter date_taken still orders before its extensions), i.e.
      // the FIRST photo of each group in the library's DESC order; SQLite then takes the bare
      // columns (id, file_path, lj) from that very row. No window/sort needed.
      `WITH g AS (
         SELECT id, file_path, date_taken, location_json AS lj,
           CASE WHEN json_valid(location_json) THEN json_extract(location_json, '$.city') END AS city,
           CASE WHEN json_valid(location_json) THEN json_extract(location_json, '$.country') END AS country,
           CASE WHEN json_valid(location_json) THEN json_extract(location_json, '$.latitude') END AS lat,
           CASE WHEN json_valid(location_json) THEN json_extract(location_json, '$.longitude') END AS lng
         FROM photos WHERE location_json IS NOT NULL
       )
       SELECT id, file_path, lj, COUNT(*) AS c, MAX(date_taken || char(1) || id) AS k
       FROM g
       WHERE lat IS NOT NULL AND lat <> 0 AND lat <> '' AND lng IS NOT NULL AND lng <> 0 AND lng <> ''
       GROUP BY city, country,
                CASE WHEN city IS NULL OR city = '' THEN lat END,
                CASE WHEN city IS NULL OR city = '' THEN lng END
       ORDER BY k DESC`
    )
    .all() as Array<{ id: string; file_path: string; lj: string; c: number }>;

  const map = new Map<string, PlaceSummaryItem>();
  for (const g of groups) {
    const loc = JSON.parse(g.lj) as NonNullable<SummaryPhoto['location']>;
    const { placeKey, albumName } = placeKeyAndName(loc);
    const cur = map.get(placeKey);
    if (cur) {
      cur.photoCount += g.c;
    } else {
      map.set(placeKey, {
        id: `place_${placeKey}`,
        name: albumName,
        city: loc.city,
        country: loc.country,
        latitude: loc.latitude,
        longitude: loc.longitude,
        photoCount: g.c,
        coverPhotoId: g.id,
        coverFilePath: g.file_path,
      });
    }
  }
  return Array.from(map.values()).sort((a, b) => b.photoCount - a.photoCount);
}

async function buildMeta(customDir?: string | null): Promise<CatalogMeta> {
  const db = getDb();
  const people = getAllPeople();
  const albums = getAllAlbums();

  // Aggregated in SQLite — never materialises the photo list (see computeTimelineSummarySql).
  const totalPhotos = getTotalPhotoCount(db);
  const timelineSummary = computeTimelineSummarySql(db);
  const placesSummary = computePlacesSummarySql(db);
  const edgeSql = (dir: 'ASC' | 'DESC') =>
    db.prepare(`SELECT date_taken, file_date FROM photos ORDER BY date_taken ${dir}, id ${dir} LIMIT 1`).get() as
      | { date_taken: string; file_date: string | null }
      | undefined;
  const latest = totalPhotos > 0 ? edgeSql('DESC') : undefined;
  const earliest = totalPhotos > 0 ? edgeSql('ASC') : undefined;

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

  const totalPages = Math.max(1, Math.ceil(totalPhotos / PAGE_SIZE));
  const recentLibraries = getSetting<string[]>('recentLibraries', []);
  const selectedFolder = getSetting<string | null>('selectedFolder', customDir || null);

  return {
    version: 3,
    totalPhotos,
    totalAlbums: albumsSummary.length,
    totalPeople: peopleSummary.length,
    totalPlaces: placesSummary.length,
    earliestDate: earliest ? earliest.date_taken || earliest.file_date || '' : undefined,
    latestDate: latest ? latest.date_taken || latest.file_date || '' : undefined,
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
 *
 * When no folder is given (the normal case on app startup, before the
 * renderer knows what was last active), this resolves the persisted
 * selectedFolder from the global settings database first — without that,
 * the very first call of the process would activate the library-independent
 * global database (which holds no photos), making the "instant" startup
 * fast-path always report 0 photos and silently fall through to a slower
 * legacy load.
 */
export async function getCatalogMeta(customDir?: string): Promise<CatalogMeta> {
  const targetDir = customDir || getSetting<string | null>('selectedFolder', null) || undefined;
  setActiveLibrary(targetDir || null);
  ensureMigratedIfEmpty();
  return await buildMeta(targetDir || null);
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
  // IPC-supplied values: clamp so a negative/NaN/huge pageSize can't become
  // SQLite's LIMIT -1 (= whole library, synchronously) or a bind error.
  pageSize = Number.isFinite(pageSize) ? Math.min(500, Math.max(1, Math.floor(pageSize))) : PAGE_SIZE;
  pageIndex = Number.isFinite(pageIndex) ? Math.max(0, Math.floor(pageIndex)) : 0;

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
          // Local mirror file first (cheap local sidecar/store lookup); the
          // remote original is looked up in the in-memory store ONLY — its
          // sidecar path would be a sync stat on a possibly-offline share.
          const rot = (p.originalRemotePath && p.filePath && p.filePath !== target ? getHeicSavedRotation(p.filePath) : 0)
            || getHeicSavedRotation(target, { skipSidecar: !!p.originalRemotePath });
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
): Promise<{ meta: CatalogMeta; firstPage: Photo[]; albums: Album[] }> {
  // A folder whose database file doesn't exist yet has never been indexed —
  // opening it used to just activate a freshly-created, empty catalog and
  // report success, leaving the caller to separately notice 0 photos and
  // trigger its own fallback scan. That fallback only ever existed in one
  // client code path (the desktop "Select Local Photo Folder" button) and
  // treated ANY truthy result as success regardless of photo count, so in
  // practice a brand-new folder opened via switchLibrary — from the desktop
  // recent-library list, from a virtual-storage "Browse in Library", or from
  // the web/mobile client at all — silently showed an empty library instead
  // of what's actually on disk. Scanning it here instead means every caller,
  // on every platform, gets the real contents the first time, with no extra
  // round trip.
  const dbPath = getDbPath(targetDir);
  const isFirstOpen = !fs.existsSync(dbPath);

  setActiveLibrary(targetDir);
  ensureMigratedIfEmpty();

  if (isFirstOpen && getTotalPhotoCount() === 0) {
    try {
      const scanned = await scanPhotoDirectory(targetDir);
      if (scanned.length > 0) {
        // Resolved explicitly rather than trusting the ambient active-library
        // pointer after this await — another request (a different paired
        // device, a background sync cycle) can legitimately repoint it while
        // scanPhotoDirectory is walking a large folder (see db.ts's
        // setActiveLibrary doc comment for the exact failure class this
        // avoids).
        replaceAllPhotos(scanned, getDbForLibraryPath(targetDir));
      }
    } catch (err) {
      console.warn('[CatalogService] Initial scan of new library folder failed:', err);
    }
  }

  const recent = new Set(getSetting<string[]>('recentLibraries', []));
  recent.delete(targetDir);
  const updatedRecent = [targetDir, ...Array.from(recent)].slice(0, 10);
  setSetting('recentLibraries', updatedRecent);
  setSetting('selectedFolder', targetDir);

  const meta = await buildMeta(targetDir);
  const firstPageResult = await getCatalogPage(0, PAGE_SIZE, targetDir);
  // Explicit target-library db, not the ambient getAllAlbums() default —
  // switchLibrary()'s renderer-side doc comment covers why: without this,
  // the renderer keeps whatever albums were in memory for the PREVIOUS
  // library and, on its next save, overwrites (or empties) this library's
  // real album_photos rows with that stale data.
  const albums = getAllAlbums(getDbForLibraryPath(targetDir));

  return {
    meta,
    firstPage: firstPageResult.photos,
    albums,
  };
}

/**
 * Re-walks an ALREADY-indexed local library folder on disk, unlike switchCatalogLibrary (which
 * deliberately skips re-scanning once a folder's database exists — see its doc comment). Needed
 * whenever the folder has new files switchLibrary would otherwise never discover on its own, e.g.
 * video files added after this library was first opened, before video support existed (see
 * docs/FEATURE_VIDEO_LIBRARY_SUPPORT.md — a local library has no other way to pick those up: there
 * is no background watcher on an arbitrary disk folder, unlike a virtual/network mirror's own sync).
 *
 * Safe to call on a library already in active use: replaceAllPhotos is a non-destructive upsert +
 * diff (see its own doc comment in libraryRepository.ts), not a wipe-and-rebuild — an existing
 * photo's favorites/rotation/faces/album membership are untouched; only genuinely new files are
 * added and genuinely deleted files are removed.
 */
export async function rescanLocalLibrary(
  targetDir: string
): Promise<{ meta: CatalogMeta; firstPage: Photo[]; albums: Album[] }> {
  setActiveLibrary(targetDir);
  const targetDb = getDbForLibraryPath(targetDir);

  // A fresh disk scan has no way to know a photo's favorite/rotation/exclusion/face-scan state —
  // scanPhotoDirectory always starts a Photo object from scratch for every file on disk. Carrying
  // those fields forward from whatever's already in the DB (keyed by id, which is stable for the
  // same filePath — see scanPhotoDirectory) is what makes this rescan non-destructive; without it,
  // every photo still on disk would silently have its favorite/rotation/etc. reset on every rescan.
  const existingById = new Map(getAllPhotos(targetDb).map((p) => [p.id, p]));
  const scanned = (await scanPhotoDirectory(targetDir)).map((fresh) => {
    const prev = existingById.get(fresh.id);
    if (!prev) return fresh;
    return {
      ...fresh,
      isFavorite: prev.isFavorite,
      isExcluded: prev.isExcluded,
      faceScanCompleted: prev.faceScanCompleted,
      facesLocked: prev.facesLocked,
      sharpnessScore: prev.sharpnessScore,
      rotation: prev.rotation,
      isHeicRotated: prev.isHeicRotated,
      heicRotation: prev.heicRotation,
      originalMtimeMs: prev.originalMtimeMs,
    };
  });
  if (scanned.length > 0) {
    replaceAllPhotos(scanned, targetDb);
  }

  const meta = await buildMeta(targetDir);
  const firstPageResult = await getCatalogPage(0, PAGE_SIZE, targetDir);
  const albums = getAllAlbums(targetDb);

  return {
    meta,
    firstPage: firstPageResult.photos,
    albums,
  };
}
