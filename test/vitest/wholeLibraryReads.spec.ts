import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { DatabaseSync } from 'node:sqlite';
import { resetDbForTests, setActiveLibrary, getDb, getDbForLibraryPath } from '../../src/main/services/db';
import {
  upsertPhotos,
  getAllPhotos,
  getAllFaces,
  getAllPhotosChunked,
  getAllFacesChunked,
  getAllPhotosForSummary,
  replaceFacesForPhoto,
} from '../../src/main/services/libraryRepository';
import {
  computeTimelineSummarySql,
  computePlacesSummarySql,
  computePlacesSummary,
  getCatalogMeta,
} from '../../src/main/services/catalogService';
import type { Photo, DetectedFace, TimelineMonthSummary, PlaceSummaryItem, LocationMetadata } from '../../src/types';

// ---------------------------------------------------------------------------
// Reference oracles: the ORIGINAL implementations, copied verbatim (LIMIT/OFFSET paging, and
// summaries computed in JS over the full photo list). New code must produce identical results.
// ---------------------------------------------------------------------------

type SummaryPhoto = Pick<Photo, 'id' | 'filePath' | 'dateTaken' | 'fileDate' | 'location'>;

function oldComputeTimelineSummary(photos: SummaryPhoto[]): TimelineMonthSummary[] {
  const map = new Map<string, { year: number; month: number; label: string; count: number; firstPhotoIndex: number }>();
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  for (let i = 0; i < photos.length; i++) {
    const p = photos[i];
    const dateStr = p.dateTaken || p.fileDate || new Date().toISOString();
    const d = new Date(dateStr);
    const year = isNaN(d.getFullYear()) ? 2026 : d.getFullYear();
    const month = isNaN(d.getMonth()) ? 8 : d.getMonth() + 1;
    const key = `${year}-${String(month).padStart(2, '0')}`;
    if (!map.has(key)) {
      map.set(key, { year, month, label: `${monthNames[month - 1]} ${year}`, count: 1, firstPhotoIndex: i });
    } else {
      map.get(key)!.count += 1;
    }
  }
  return Array.from(map.values()).sort((a, b) => {
    if (a.year !== b.year) return b.year - a.year;
    return b.month - a.month;
  });
}

function oldComputePlacesSummary(photos: SummaryPhoto[]): PlaceSummaryItem[] {
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

/** Old getAllPhotosForSummary: LIMIT/OFFSET pages over the same ordering. */
function oldSummaryRows(db: DatabaseSync, chunk = 5000): SummaryPhoto[] {
  const total = (db.prepare('SELECT COUNT(*) AS c FROM photos').get() as any).c as number;
  const stmt = db.prepare('SELECT id, file_path, date_taken, file_date, location_json FROM photos ORDER BY date_taken DESC, id DESC LIMIT ? OFFSET ?');
  const out: SummaryPhoto[] = [];
  for (let offset = 0; offset < total; offset += chunk) {
    const rows = stmt.all(chunk, offset) as any[];
    for (const row of rows) {
      let loc: LocationMetadata | null = null;
      try {
        loc = row.location_json ? JSON.parse(row.location_json) : null;
      } catch {
        loc = null;
      }
      out.push({ id: row.id, filePath: row.file_path, dateTaken: row.date_taken, fileDate: row.file_date || '', location: loc ?? undefined });
    }
    if (rows.length < chunk) break;
  }
  return out;
}

function oldPhotoIdsOffset(db: DatabaseSync, chunk: number, onChunk?: (i: number) => void): string[] {
  const stmt = db.prepare('SELECT id FROM photos ORDER BY date_taken DESC, id DESC LIMIT ? OFFSET ?');
  const ids: string[] = [];
  for (let i = 0, offset = 0; ; i++, offset += chunk) {
    const rows = stmt.all(chunk, offset) as any[];
    if (rows.length === 0) break;
    ids.push(...rows.map((r) => r.id));
    if (rows.length < chunk) break;
    onChunk?.(i);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Synthetic data
// ---------------------------------------------------------------------------

// Deterministic PRNG so failures reproduce.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const DATE_POOL = [
  '2024-03-15T10:20:30.000Z', // Z with ms, mid-month
  '2024-03-15T10:20:30.000Z', // duplicate sort key (many photos share it)
  '2024-03-15T10:20:30.000Z',
  '2023-11-02T08:00:00Z',
  '2023-11-27T23:59:59Z',
  '2023-12-01T00:30:00.000Z', // UTC month-boundary days (tz-dependent locally)
  '2023-11-30T23:30:00.000Z',
  '2022-01-31T22:00:00.000Z',
  '2022-02-01T01:00:00.000Z',
  '2021-06-10T12:00:00', // tz-less local
  '2021-06-28T23:59:59',
  '2021-06-30T12:00:00', // tz-less, day > 28
  '2020-05-05', // date-only (UTC in JS)
  '2020-05-01',
  '2019-08-20T10:00:00+05:30', // explicit offset
  '2019-08-31T23:00:00-08:00',
  '2018-04-04 10:00:00', // space separated
  '2017/07/07', // legacy format
  'not a date at all', // invalid -> 2026-09 fallback
  '2016-13-45T99:99:99Z', // invalid components
  '2016-02-31T10:00:00', // impossible day
  '1969-12-31T23:59:59Z', // pre-epoch
  '2500-01-15T10:00:00Z',
  '0999-01-15T10:00:00Z',
  '', // empty -> falls back to file_date
];

const FILE_DATES = ['', '', '2015-03-03T03:03:03.000Z', '2015-03-31T23:59:00Z', 'garbage'];

const LOCATIONS: Array<LocationMetadata | null | 'badjson'> = [
  null,
  null,
  null,
  { latitude: 48.85, longitude: 2.35, city: 'Paris', country: 'France' },
  { latitude: 48.86, longitude: 2.36, city: 'paris', country: 'france' }, // same key, different case + coords
  { latitude: 40.7, longitude: -74.0, city: 'New York', country: 'USA' },
  { latitude: 40.71, longitude: -74.01, city: 'New York' }, // city only
  { latitude: 40.72, longitude: -74.02, city: 'new york' }, // city only, other case -> same key as above
  { latitude: 35.68, longitude: 139.69, country: 'Japan' }, // no city -> grid
  { latitude: 35.69, longitude: 139.71, country: 'Japan' }, // same 0.1 grid? (35.7,139.7)
  { latitude: 35.68, longitude: 139.69 }, // grid, no country
  { latitude: 0, longitude: 10, city: 'Zero Lat' }, // filtered (falsy lat)
  { latitude: 10, longitude: 0, city: 'Zero Lng' }, // filtered
  { latitude: 1.25, longitude: 2.25 }, // toFixed rounding tie cases
  { latitude: 1.35, longitude: 2.35 },
  { latitude: -33.87, longitude: 151.21, city: 'Sydney', country: 'Australia' },
  'badjson',
];

interface Dataset {
  photoCount: number;
  faceCount: number;
  descriptorLen: number;
  /** Realistic camera-library mix (toISOString timestamps over 10 years, ~60% geotagged with ~40 cities) instead of the adversarial edge-case pool. */
  realistic?: boolean;
}

function makePhoto(i: number, r: () => number, realistic = false): Photo {
  const dateTaken = realistic
    ? new Date(Date.UTC(2014, 0, 1) + Math.floor(r() * 11 * 365 * 86400000)).toISOString()
    : DATE_POOL[Math.floor(r() * DATE_POOL.length)];
  const loc: LocationMetadata | null | 'badjson' = realistic
    ? r() < 0.6
      ? { latitude: 10 + Math.floor(r() * 40) + 0.123, longitude: 20 + Math.floor(r() * 40) + 0.456, city: `City${Math.floor(r() * 40)}`, country: 'Country' }
      : null
    : LOCATIONS[Math.floor(r() * LOCATIONS.length)];
  const photo: Photo = {
    id: `photo_${String(i).padStart(7, '0')}`,
    filePath: `C:\\Photos\\${i}.jpg`,
    fileName: `${i}.jpg`,
    fileSize: 1000 + (i % 7),
    fileDate: FILE_DATES[Math.floor(r() * FILE_DATES.length)],
    dateTaken,
    year: 2000 + (i % 25),
    month: 1 + (i % 12),
    day: 1 + (i % 28),
  };
  if (loc && loc !== 'badjson') photo.location = loc;
  return photo;
}

function seed(db: DatabaseSync, { photoCount, faceCount, descriptorLen, realistic }: Dataset, seedValue = 42): void {
  const r = rng(seedValue);
  const all: Photo[] = [];
  for (let i = 0; i < photoCount; i++) all.push(makePhoto(i, r, realistic));
  for (let i = 0; i < all.length; i += 5000) upsertPhotos(all.slice(i, i + 5000), db);
  // A few rows with unparseable location_json, written raw.
  db.prepare("UPDATE photos SET location_json = '{not json' WHERE id IN (?, ?, ?)").run('photo_0000003', 'photo_0000010', `photo_${String(photoCount - 1).padStart(7, '0')}`);

  // Faces: descriptor of varying content; some with nulls/odd values.
  const ins = db.prepare(
    `INSERT INTO faces (id, photo_id, person_id, box_x, box_y, box_width, box_height, image_width, image_height,
       descriptor_json, confidence, is_confirmed, is_manual, age, gender, gender_probability, expressions_json, dominant_expression)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  db.exec('BEGIN');
  for (let i = 0; i < faceCount; i++) {
    const photoId = `photo_${String(Math.floor(r() * photoCount)).padStart(7, '0')}`;
    const odd = i % 11 === 0;
    const desc = odd ? null : JSON.stringify(Array.from({ length: descriptorLen }, () => Math.round(r() * 1e6) / 1e6));
    // Deliberately non-monotonic ids so id order != insertion (rowid) order.
    const id = `face_${(i * 7919) % 1000003}_${i}`;
    ins.run(
      id, photoId, i % 3 === 0 ? `person_${i % 17}` : null,
      odd ? null : r(), odd ? null : r(), odd ? null : r(), odd ? null : r(),
      odd ? null : 1000, odd ? null : 800, desc, odd ? null : r(),
      i % 2, i % 5 === 0 ? 1 : 0, odd ? null : 20 + (i % 50), odd ? null : 'male', odd ? null : 0.9,
      odd ? null : JSON.stringify({ happy: 0.5 }), odd ? null : 'happy'
    );
  }
  db.exec('COMMIT');
}

function tick(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

// ---------------------------------------------------------------------------

describe('whole-library read paths (keyset pagination + SQL aggregates)', () => {
  let tempDir: string;
  let libraryDir: string;
  let db: DatabaseSync;
  const ORIGINAL_TZ = process.env.TZ;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gphotos_wholelib_test_'));
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
    if (ORIGINAL_TZ === undefined) delete process.env.TZ;
    else process.env.TZ = ORIGINAL_TZ;
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('getAllPhotosChunked deep-equals the full ordered read on data with many duplicate sort keys', async () => {
    seed(db, { photoCount: 5300, faceCount: 2500, descriptorLen: 8 });
    const oracle = getAllPhotos(db); // ORDER BY date_taken DESC, id DESC, full read, faces attached
    const chunked = await getAllPhotosChunked(db);
    expect(chunked.length).toBe(5300);
    expect(chunked).toEqual(oracle);
    // Spans > 2 chunks of 2000, with the tie-broken ordering preserved.
    expect(new Set(chunked.map((p) => p.id)).size).toBe(5300);
  });

  it('getAllFacesChunked returns exactly the same faces, in the same (physical) order, as the full read', async () => {
    seed(db, { photoCount: 300, faceCount: 4500, descriptorLen: 8 });
    const oracle = getAllFaces(db); // SELECT * FROM faces, no ORDER BY = rowid order, what the old chunked reader paged through
    const chunked = await getAllFacesChunked(db);
    expect(chunked.length).toBe(4500);
    expect(chunked).toEqual(oracle);
  });

  it('getAllPhotosForSummary matches the old LIMIT/OFFSET implementation', async () => {
    seed(db, { photoCount: 6200, faceCount: 0, descriptorLen: 0 });
    expect(await getAllPhotosForSummary(db)).toEqual(oldSummaryRows(db));
  });

  it('empty library: every reader returns empty results', async () => {
    expect(await getAllPhotosChunked(db)).toEqual([]);
    expect(await getAllFacesChunked(db)).toEqual([]);
    expect(await getAllPhotosForSummary(db)).toEqual([]);
    expect(computeTimelineSummarySql(db)).toEqual([]);
    expect(computePlacesSummarySql(db)).toEqual([]);
  });

  // Reported bug: renaming a cluster of photos to "Andaman" (sets label + city, deliberately leaves
  // the geographically-correct country alone) still showed "Andaman, India" after restarting the
  // app — because this SQL-backed startup summary (computePlacesSummarySql, and its plain-JS
  // sibling computePlacesSummary) has its own, separate copy of the "derive a place's display name"
  // logic (placeKeyAndName), which the equivalent fix in the renderer's placesService.ts never
  // reached. Both copies needed the identical fix: a custom label always wins over the "City,
  // Country" string derived from city+country.
  it('a custom label on the place wins over the derived "City, Country" name, in both the SQL and plain-JS summaries', () => {
    const photos: Photo[] = [
      {
        id: 'photo_0000000', filePath: 'C:\\Photos\\andaman.jpg', fileName: 'andaman.jpg', fileSize: 1,
        dateTaken: '2024-01-01T00:00:00Z', fileDate: '2024-01-01T00:00:00Z', year: 2024, month: 1, day: 1,
        location: { latitude: 11.6, longitude: 92.7, city: 'Andaman', country: 'India', label: 'Andaman' },
      } as any,
      {
        id: 'photo_0000001', filePath: 'C:\\Photos\\udaipur.jpg', fileName: 'udaipur.jpg', fileSize: 1,
        dateTaken: '2024-01-02T00:00:00Z', fileDate: '2024-01-02T00:00:00Z', year: 2024, month: 1, day: 2,
        location: { latitude: 24.5, longitude: 73.6, city: 'Udaipur', country: 'India' }, // never renamed
      } as any,
    ];
    upsertPhotos(photos, db);

    const sqlResult = computePlacesSummarySql(db);
    expect(sqlResult.find((p) => p.city === 'Andaman')?.name).toBe('Andaman'); // not "Andaman, India"
    expect(sqlResult.find((p) => p.city === 'Udaipur')?.name).toBe('Udaipur, India'); // unchanged without a label

    const jsResult = computePlacesSummary(photos);
    expect(jsResult.find((p) => p.city === 'Andaman')?.name).toBe('Andaman');
    expect(jsResult.find((p) => p.city === 'Udaipur')?.name).toBe('Udaipur, India');
  });

  it('exactly one full chunk (2000 rows) terminates cleanly', async () => {
    seed(db, { photoCount: 2000, faceCount: 2000, descriptorLen: 4 });
    expect((await getAllPhotosChunked(db)).length).toBe(2000);
    expect((await getAllFacesChunked(db)).length).toBe(2000);
  });

  for (const tz of ['UTC', 'America/Los_Angeles', 'Asia/Kolkata', 'Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
    it(`timeline + places SQL aggregates equal the old JS computation (TZ=${tz})`, () => {
      process.env.TZ = tz;
      seed(db, { photoCount: 4000, faceCount: 0, descriptorLen: 0 });
      const rows = oldSummaryRows(db);
      expect(computeTimelineSummarySql(db)).toEqual(oldComputeTimelineSummary(rows));
      expect(computePlacesSummarySql(db)).toEqual(oldComputePlacesSummary(rows));
    });
  }

  for (const tz of ['UTC', 'America/New_York', 'Asia/Kolkata', 'Pacific/Kiritimati']) {
    it(`realistic library (toISOString stamps, many geotags): SQL aggregates equal the old JS computation (TZ=${tz})`, () => {
      process.env.TZ = tz;
      seed(db, { photoCount: 8000, faceCount: 0, descriptorLen: 0, realistic: true });
      const rows = oldSummaryRows(db);
      expect(computeTimelineSummarySql(db)).toEqual(oldComputeTimelineSummary(rows));
      expect(computePlacesSummarySql(db)).toEqual(oldComputePlacesSummary(rows));
    });
  }

  it('timeline SQL handles the fallback-only case (no photo matches the fast path)', () => {
    upsertPhotos(
      [
        { ...makePhoto(1, rng(1)), dateTaken: '2020-05-05' },
        { ...makePhoto(2, rng(1)), dateTaken: 'zzz' },
        { ...makePhoto(3, rng(1)), dateTaken: '', fileDate: '2011-02-03T04:05:06Z' },
      ],
      db
    );
    expect(computeTimelineSummarySql(db)).toEqual(oldComputeTimelineSummary(oldSummaryRows(db)));
  });

  it('getCatalogMeta returns the same meta (totals, earliest/latest, summaries) as the old all-photos path', async () => {
    seed(db, { photoCount: 3000, faceCount: 0, descriptorLen: 0 });
    const rows = oldSummaryRows(db);
    const meta = await getCatalogMeta(libraryDir);
    expect(meta.totalPhotos).toBe(rows.length);
    expect(meta.totalPages).toBe(Math.max(1, Math.ceil(rows.length / 100)));
    expect(meta.earliestDate).toBe(rows[rows.length - 1].dateTaken || rows[rows.length - 1].fileDate);
    expect(meta.latestDate).toBe(rows[0].dateTaken || rows[0].fileDate);
    expect(meta.timelineSummary).toEqual(oldComputeTimelineSummary(rows));
    expect(meta.placesSummary).toEqual(oldComputePlacesSummary(rows));
    expect(meta.totalPlaces).toBe(meta.placesSummary.length);
  });

  it('getCatalogMeta on an empty library leaves earliest/latest undefined', async () => {
    const meta = await getCatalogMeta(libraryDir);
    expect(meta.totalPhotos).toBe(0);
    expect(meta.earliestDate).toBeUndefined();
    expect(meta.latestDate).toBeUndefined();
    expect(meta.timelineSummary).toEqual([]);
  });

  it('a writer running between chunks neither duplicates nor drops untouched photos (and old OFFSET paging does)', async () => {
    seed(db, { photoCount: 9000, faceCount: 0, descriptorLen: 0 });
    const originalIds = (db.prepare('SELECT id FROM photos').all() as any[]).map((r) => r.id as string);
    const insertPhoto = (id: string, dateTaken: string) =>
      upsertPhotos([{ ...makePhoto(0, rng(7)), id, filePath: `C:\\x\\${id}.jpg`, fileName: `${id}.jpg`, dateTaken }], db);

    // Writer: between chunks, insert rows that sort BEFORE everything (shifts OFFSET pages) and
    // delete rows from the already-read head and the not-yet-read tail.
    const ordered = (db.prepare('SELECT id FROM photos ORDER BY date_taken DESC, id DESC').all() as any[]).map((r) => r.id as string);
    const deleted = new Set<string>();
    const del = db.prepare('DELETE FROM photos WHERE id = ?');
    let step = 0;
    const writer = async () => {
      for (let i = 0; i < 4; i++) {
        await tick();
        step++;
        for (let k = 0; k < 25; k++) insertPhoto(`zz_new_${step}_${k}`, '2999-01-01T00:00:00.000Z');
        for (let k = 0; k < 10; k++) {
          const head = ordered[step * 10 + k]; // already-read region
          const tail = ordered[ordered.length - 1 - (step * 10 + k)]; // not-yet-read region
          for (const id of [head, tail]) {
            del.run(id);
            deleted.add(id);
          }
        }
      }
    };

    const [photos] = await Promise.all([getAllPhotosChunked(db), writer()]);
    const got = photos.map((p) => p.id);
    expect(new Set(got).size).toBe(got.length); // no duplicates at all
    const gotSet = new Set(got);
    const missingUntouched = originalIds.filter((id) => !deleted.has(id) && !gotSet.has(id));
    expect(missingUntouched).toEqual([]); // no untouched row dropped
  });

  it('old LIMIT/OFFSET paging DOES misbehave under the same interleaved writer (control for the test above)', () => {
    seed(db, { photoCount: 9000, faceCount: 0, descriptorLen: 0 });
    let inserted = 0;
    const ids = oldPhotoIdsOffset(db, 2000, () => {
      for (let k = 0; k < 25; k++) {
        upsertPhotos([{ ...makePhoto(0, rng(7)), id: `zz_new_${inserted++}`, dateTaken: '2999-01-01T00:00:00.000Z' }], db);
      }
    });
    expect(new Set(ids).size).toBeLessThan(ids.length); // duplicated rows across page boundaries
  });

  it('a writer replacing/adding/deleting faces between chunks neither duplicates nor drops untouched faces', async () => {
    seed(db, { photoCount: 600, faceCount: 7000, descriptorLen: 4 });
    const before = getAllFaces(db);
    const touchedPhotos = new Set<string>();
    const removed = new Set<string>();
    const writer = async () => {
      for (let step = 1; step <= 4; step++) {
        await tick();
        // replaceFacesForPhoto = DELETE + re-INSERT of the same ids (rowid changes, id doesn't).
        const victim = before[step * 3].photoId;
        touchedPhotos.add(victim);
        replaceFacesForPhoto(victim, getAllFaces(db).filter((f) => f.photoId === victim), false, db);
        // Brand-new faces with ids that sort both before and after the cursor.
        for (const prefix of ['a_new', 'zz_new']) {
          replaceFacesForPhoto(`photo_0000001`, [
            ...getAllFaces(db).filter((f) => f.photoId === 'photo_0000001'),
            { id: `${prefix}_${step}`, photoId: 'photo_0000001', box: { x: 0, y: 0, width: 1, height: 1 }, descriptor: [1, 2, 3, 4], confidence: 1 },
          ] as DetectedFace[], false, db);
        }
        // Delete a couple of faces outright.
        const gone = before[before.length - 1 - step].id;
        db.prepare('DELETE FROM faces WHERE id = ?').run(gone);
        removed.add(gone);
      }
    };
    const [faces] = await Promise.all([getAllFacesChunked(db), writer()]);
    const got = faces.map((f) => f.id);
    expect(new Set(got).size).toBe(got.length);
    const gotSet = new Set(got);
    const missing = before.filter((f) => !removed.has(f.id) && !gotSet.has(f.id));
    expect(missing).toEqual([]);
  });

  it('keyset queries use idx_photos_date_taken_id (no sort, no full scan per page)', () => {
    seed(db, { photoCount: 500, faceCount: 0, descriptorLen: 0 });
    const plan = (sql: string, ...args: any[]) =>
      (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as any[]).map((r) => r.detail as string).join(' | ');
    const p = plan('SELECT * FROM photos WHERE (date_taken, id) < (?, ?) ORDER BY date_taken DESC, id DESC LIMIT ?', '2020', 'x', 10);
    expect(p).toContain('idx_photos_date_taken_id');
    expect(p).not.toContain('TEMP B-TREE');
  });

  it('schema migration is idempotent and adds the index to an existing DB', () => {
    db.exec('DROP INDEX IF EXISTS idx_photos_date_taken_id');
    resetDbForTests();
    const reopened = getDbForLibraryPath(libraryDir); // applySchema runs again
    const idx = reopened.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_photos_date_taken_id'").all();
    expect(idx).toHaveLength(1);
    resetDbForTests();
    expect(() => getDbForLibraryPath(libraryDir)).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // Benchmark (old vs new) at ~100k rows. Opt-in: GPHOTOS_BENCH=1 (it is slow-ish and only prints).
  // -------------------------------------------------------------------------
  const bench = process.env.GPHOTOS_BENCH ? it : it.skip;
  bench('benchmark old vs new at 100k photos / 100k faces', async () => {
    const N = 100_000;
    const t0 = Date.now();
    seed(db, { photoCount: N, faceCount: N, descriptorLen: 8 });
    // Same 512-float descriptor cost measured separately below on a smaller face set.
    console.log(`[bench] seeded ${N} photos + ${N} faces in ${Date.now() - t0}ms`);

    // Best of 3 (the box is shared with a running app and other agents, single runs are noisy).
    const time = async <T>(label: string, fn: () => T | Promise<T>): Promise<T> => {
      const runs: number[] = [];
      let v!: T;
      for (let i = 0; i < 3; i++) {
        const s = performance.now();
        v = await fn();
        runs.push(performance.now() - s);
      }
      console.log(`[bench] ${label}: best ${Math.min(...runs).toFixed(0)}ms (runs ${runs.map((r) => r.toFixed(0)).join('/')})`);
      return v;
    };

    const oldIds = await time('OLD photo paging only (LIMIT/OFFSET, ids)', () => oldPhotoIdsOffset(db, 2000));
    const newIds = await time('NEW photo paging only (keyset, ids)', () => {
      const first = db.prepare('SELECT id, date_taken FROM photos ORDER BY date_taken DESC, id DESC LIMIT ?');
      const next = db.prepare('SELECT id, date_taken FROM photos WHERE (date_taken, id) < (?, ?) ORDER BY date_taken DESC, id DESC LIMIT ?');
      const ids: string[] = [];
      let rows = first.all(2000) as any[];
      while (rows.length) {
        for (const r of rows) ids.push(r.id);
        const l = rows[rows.length - 1];
        rows = rows.length < 2000 ? [] : (next.all(l.date_taken, l.id, 2000) as any[]);
      }
      return ids;
    });
    expect(newIds).toEqual(oldIds);

    const full = await time('NEW getAllPhotosChunked (full, with faces)', () => getAllPhotosChunked(db));
    console.log('[bench] plan timeline: ' + (db.prepare('EXPLAIN QUERY PLAN WITH r AS (SELECT date_taken AS d, ROW_NUMBER() OVER (ORDER BY date_taken DESC, id DESC) - 1 AS rn FROM photos) SELECT substr(d,1,7), COUNT(*), MIN(rn) FROM r GROUP BY 1').all() as any[]).map((r) => r.detail).join(' | '));
    expect(full.length).toBe(N);
    expect(full.map((p) => p.id)).toEqual(oldIds);
    const newFaces = await time('NEW getAllFacesChunked (8-float descriptors)', () => getAllFacesChunked(db));
    expect(newFaces).toEqual(getAllFaces(db));
    await time('OLD faces LIMIT/OFFSET (no ORDER BY)', () => {
      const stmt = db.prepare('SELECT * FROM faces LIMIT ? OFFSET ?');
      let n = 0;
      for (let off = 0; ; off += 2000) {
        const rows = stmt.all(2000, off) as any[];
        n += rows.length;
        if (rows.length < 2000) break;
      }
      return n;
    });

    const oldMeta = await time('OLD buildMeta core (load all summary rows + JS aggregate)', () => {
      const rows = oldSummaryRows(db);
      return { t: oldComputeTimelineSummary(rows), p: oldComputePlacesSummary(rows) };
    });
    const newT = await time('NEW timeline (SQL GROUP BY)', () => computeTimelineSummarySql(db));
    const newP = await time('NEW places (SQL GROUP BY)', () => computePlacesSummarySql(db));
    expect(newT).toEqual(oldMeta.t);
    expect(newP).toEqual(oldMeta.p);
    await time('NEW getCatalogMeta (end to end)', () => getCatalogMeta(libraryDir));
  });

  bench('benchmark old vs new summaries at 100k REALISTIC photos', async () => {
    seed(db, { photoCount: 100_000, faceCount: 0, descriptorLen: 0, realistic: true });
    const time = async <T>(label: string, fn: () => T | Promise<T>): Promise<T> => {
      const runs: number[] = [];
      let v!: T;
      for (let i = 0; i < 3; i++) {
        const s = performance.now();
        v = await fn();
        runs.push(performance.now() - s);
      }
      console.log(`[bench-real] ${label}: best ${Math.min(...runs).toFixed(0)}ms (runs ${runs.map((r) => r.toFixed(0)).join('/')})`);
      return v;
    };
    const old = await time('OLD buildMeta core (load all summary rows + JS aggregate)', () => {
      const rows = oldSummaryRows(db);
      return { t: oldComputeTimelineSummary(rows), p: oldComputePlacesSummary(rows) };
    });
    const t = await time('NEW timeline (SQL)', () => computeTimelineSummarySql(db));
    const p = await time('NEW places (SQL)', () => computePlacesSummarySql(db));
    expect(t).toEqual(old.t);
    expect(p).toEqual(old.p);
    await time('NEW getCatalogMeta (end to end)', () => getCatalogMeta(libraryDir));
  });
});
