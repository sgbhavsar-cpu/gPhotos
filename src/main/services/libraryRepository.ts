import type { DatabaseSync } from 'node:sqlite';
import { getDb, getGlobalDb, getDbForLibraryPath, runInTransaction, resolveDbForPhoto } from './db';
import { Photo, Person, DetectedFace, Album, ExifMetadata, LocationMetadata } from '../../types';

function toBool(v: any): boolean {
  return v === 1 || v === true;
}

function fromBool(v: boolean | undefined): number {
  return v ? 1 : 0;
}

function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Photos
// ---------------------------------------------------------------------------

function rowToPhoto(row: any): Photo {
  const photo: Photo = {
    id: row.id,
    filePath: row.file_path,
    fileName: row.file_name,
    fileSize: row.file_size,
    fileDate: row.file_date || '',
    dateTaken: row.date_taken,
    year: row.year,
    month: row.month,
    day: row.day,
    width: row.width ?? undefined,
    height: row.height ?? undefined,
    isFavorite: toBool(row.is_favorite),
    isVirtual: toBool(row.is_virtual),
    originalRemotePath: row.original_remote_path ?? undefined,
    storageName: row.storage_name ?? undefined,
    isExcluded: toBool(row.is_excluded),
    faceScanCompleted: toBool(row.face_scan_completed),
    facesLocked: toBool(row.faces_locked),
    sharpnessScore: row.sharpness_score ?? undefined,
    rotation: row.rotation ?? undefined,
    isHeicRotated: toBool(row.is_heic_rotated),
    heicRotation: row.heic_rotation ?? undefined,
    originalMtimeMs: row.original_mtime_ms ?? undefined,
  };
  const exif = parseJson<ExifMetadata | null>(row.exif_json, null);
  if (exif) photo.exif = exif;
  const location = parseJson<LocationMetadata | null>(row.location_json, null);
  if (location) photo.location = location;
  return photo;
}

const UPSERT_PHOTO_SQL = `
  INSERT INTO photos (
    id, file_path, file_name, file_size, file_date, date_taken, year, month, day,
    width, height, is_favorite, is_virtual, original_remote_path, storage_name,
    is_excluded, face_scan_completed, faces_locked, sharpness_score, rotation, is_heic_rotated,
    heic_rotation, exif_json, location_json, original_mtime_ms
  ) VALUES (
    @id, @filePath, @fileName, @fileSize, @fileDate, @dateTaken, @year, @month, @day,
    @width, @height, @isFavorite, @isVirtual, @originalRemotePath, @storageName,
    @isExcluded, @faceScanCompleted, @facesLocked, @sharpnessScore, @rotation, @isHeicRotated,
    @heicRotation, @exifJson, @locationJson, @originalMtimeMs
  )
  ON CONFLICT(id) DO UPDATE SET
    file_path=excluded.file_path, file_name=excluded.file_name, file_size=excluded.file_size,
    file_date=excluded.file_date, date_taken=excluded.date_taken, year=excluded.year,
    month=excluded.month, day=excluded.day, width=excluded.width, height=excluded.height,
    is_favorite=excluded.is_favorite, is_virtual=excluded.is_virtual,
    original_remote_path=excluded.original_remote_path, storage_name=excluded.storage_name,
    is_excluded=excluded.is_excluded, face_scan_completed=excluded.face_scan_completed,
    faces_locked=excluded.faces_locked,
    sharpness_score=excluded.sharpness_score, rotation=excluded.rotation,
    is_heic_rotated=excluded.is_heic_rotated, heic_rotation=excluded.heic_rotation,
    exif_json=excluded.exif_json, location_json=excluded.location_json,
    original_mtime_ms=excluded.original_mtime_ms
`;

function photoToParams(photo: Photo): Record<string, any> {
  return {
    id: photo.id,
    filePath: photo.filePath,
    fileName: photo.fileName,
    fileSize: photo.fileSize ?? 0,
    fileDate: photo.fileDate ?? null,
    dateTaken: photo.dateTaken,
    year: photo.year,
    month: photo.month,
    day: photo.day,
    width: photo.width ?? null,
    height: photo.height ?? null,
    isFavorite: fromBool(photo.isFavorite),
    isVirtual: fromBool(photo.isVirtual),
    originalRemotePath: photo.originalRemotePath ?? null,
    storageName: photo.storageName ?? null,
    isExcluded: fromBool(photo.isExcluded),
    faceScanCompleted: fromBool(photo.faceScanCompleted),
    facesLocked: fromBool(photo.facesLocked),
    sharpnessScore: photo.sharpnessScore ?? null,
    rotation: photo.rotation ?? null,
    isHeicRotated: fromBool(photo.isHeicRotated),
    heicRotation: photo.heicRotation ?? null,
    exifJson: photo.exif ? JSON.stringify(photo.exif) : null,
    locationJson: photo.location ? JSON.stringify(photo.location) : null,
    originalMtimeMs: photo.originalMtimeMs ?? null,
  };
}

export function upsertPhoto(photo: Photo, db: DatabaseSync = getDb()): void {
  db.prepare(UPSERT_PHOTO_SQL).run(photoToParams(photo) as any);
  if (photo.faces) {
    replaceFacesForPhoto(photo.id, photo.faces, false, db);
  }
}

export function upsertPhotos(photos: Photo[]): void {
  if (photos.length === 0) return;
  // Resolved PER PHOTO via resolveDbForPhoto, not once via the ambient
  // "active library" pointer (getDb()'s default) — this bulk path backs the
  // renderer's periodic debounced autosave of its whole in-memory photo
  // list (libraryStore.ts's scheduleDebouncedSave), which fires regardless
  // of which library happens to be "active" in the main process at that
  // moment. Using a single ambient db for the whole batch meant a virtual
  // storage photo edited (or just re-saved as-is) while some OTHER library
  // was active would upsert into the wrong database — for faces specifically,
  // that silently overwrote a correctly-detected-and-persisted set with
  // whatever (possibly stale) `faces` the renderer's snapshot happened to
  // carry, making a face just detected via the correctly-scoped
  // faces:detect-one-forced path vanish again moments later. Grouped by
  // resolved database so each group still gets one transaction, not one per
  // photo — in the common case (a batch from one library) that's still a
  // single transaction, same as before.
  const groups = new Map<DatabaseSync, Photo[]>();
  for (const photo of photos) {
    const db = resolveDbForPhoto(photo);
    const group = groups.get(db);
    if (group) group.push(photo);
    else groups.set(db, [photo]);
  }
  for (const [db, group] of groups) {
    runInTransaction(() => {
      const stmt = db.prepare(UPSERT_PHOTO_SQL);
      for (const photo of group) {
        stmt.run(photoToParams(photo) as any);
        if (photo.faces) {
          replaceFacesForPhoto(photo.id, photo.faces, /* skipTransaction */ true, db);
        }
      }
    }, db);
  }
}

export function getPhotoById(id: string, db: DatabaseSync = getDb()): Photo | null {
  const row = db.prepare('SELECT * FROM photos WHERE id = ?').get(id);
  if (!row) return null;
  const photo = rowToPhoto(row);
  photo.faces = getFacesForPhoto(id, db);
  return photo;
}

export function getTotalPhotoCount(db: DatabaseSync = getDb()): number {
  const row = db.prepare('SELECT COUNT(*) as c FROM photos').get() as any;
  return row?.c ?? 0;
}

/**
 * Face-detection stats for a specific library folder's own catalog database
 * — not necessarily the currently active one. Face-detection results (via
 * upsertPhotos/replaceFacesForPhoto) only ever get written to this SQLite
 * catalog, never back into the mirror folder's loose sidecar JSON files, so
 * this is the only accurate source for "how many of this storage's photos
 * have been face-scanned" — a caller that instead parses the sidecar JSONs
 * will always see 0, since nothing writes face data there.
 */
export function getFaceStatsForLibrary(libraryDir: string): {
  totalPhotos: number;
  faceScannedCount: number;
  facesDetectedCount: number;
} {
  try {
    const db = getDbForLibraryPath(libraryDir);
    const photoRow = db.prepare('SELECT COUNT(*) as total, SUM(face_scan_completed) as scanned FROM photos').get() as any;
    const faceRow = db.prepare('SELECT COUNT(*) as c FROM faces').get() as any;
    return {
      totalPhotos: photoRow?.total ?? 0,
      faceScannedCount: photoRow?.scanned ?? 0,
      facesDetectedCount: faceRow?.c ?? 0,
    };
  } catch {
    return { totalPhotos: 0, faceScannedCount: 0, facesDetectedCount: 0 };
  }
}

export function getPhotosPage(pageIndex: number, pageSize: number): Photo[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM photos ORDER BY date_taken DESC, id DESC LIMIT ? OFFSET ?')
    .all(pageSize, pageIndex * pageSize) as any[];
  const photos = rows.map(rowToPhoto);
  attachFacesToPhotos(photos);
  return photos;
}

export function getAllPhotos(db: DatabaseSync = getDb()): Photo[] {
  const rows = db.prepare('SELECT * FROM photos ORDER BY date_taken DESC, id DESC').all() as any[];
  const photos = rows.map(rowToPhoto);
  attachFacesToPhotos(photos, db);
  return photos;
}

const FULL_LOAD_CHUNK_SIZE = 2000;

/**
 * Same result as getAllPhotos, but reads+maps in chunks and yields to the
 * event loop between them. node:sqlite's DatabaseSync is fully synchronous —
 * one plain getAllPhotos() call against a library with several thousand
 * photos (row fetch + rowToPhoto's per-row JSON.parse + attachFacesToPhotos'
 * own queries) measured as an 80+ second, completely un-yielding
 * main-process block on a real ~9,800-photo library, which is exactly what
 * made storage:load (and every other IPC call queued behind it) pile up and
 * made the whole app look hung at every startup. Use this from any caller
 * that can be async (storage:load's handler, the mobile web API) instead of
 * the plain sync version above.
 */
export async function getAllPhotosChunked(db: DatabaseSync = getDb()): Promise<Photo[]> {
  const total = getTotalPhotoCount(db);
  const stmt = db.prepare('SELECT * FROM photos ORDER BY date_taken DESC, id DESC LIMIT ? OFFSET ?');
  const photos: Photo[] = [];

  for (let offset = 0; offset < total; offset += FULL_LOAD_CHUNK_SIZE) {
    const rows = stmt.all(FULL_LOAD_CHUNK_SIZE, offset) as any[];
    if (rows.length === 0) break;
    const chunk = rows.map(rowToPhoto);
    attachFacesToPhotos(chunk, db);
    photos.push(...chunk);
    if (rows.length < FULL_LOAD_CHUNK_SIZE) break;
    await new Promise((resolve) => setImmediate(resolve));
  }

  return photos;
}

/**
 * Photos (with faces attached) for one virtual storage by name — used after
 * the unified sync pipeline (see pipelineOrchestrator.ts) writes face
 * results straight to SQLite, so the renderer can pick up freshly-detected
 * faces without re-reading the whole library.
 */
export function getPhotosByStorageName(storageName: string, db: DatabaseSync = getDb()): Photo[] {
  const rows = db.prepare('SELECT * FROM photos WHERE storage_name = ? ORDER BY date_taken DESC, id DESC').all(storageName) as any[];
  const photos = rows.map(rowToPhoto);
  attachFacesToPhotos(photos, db);
  return photos;
}

const SUMMARY_QUERY_CHUNK_SIZE = 5000;

/**
 * Lightweight photo listing for computing catalog summaries (timeline/places)
 * — selects only the columns those computations actually read and skips the
 * face-hydration join entirely, so summarizing a large library doesn't pay
 * the cost of loading every photo's full record and face list into memory.
 *
 * Reads in chunks and yields to the event loop between them (node:sqlite's
 * DatabaseSync is fully synchronous, so a single all-rows query on a
 * library with hundreds of thousands of photos can block the main process
 * long enough for Windows to mark the app "Not Responding" during a library
 * switch). Callers on a hot path that must stay synchronous can still fall
 * back to the exported sync variant below.
 */
export async function getAllPhotosForSummary(): Promise<Pick<Photo, 'id' | 'filePath' | 'dateTaken' | 'fileDate' | 'location'>[]> {
  const db = getDb();
  const total = getTotalPhotoCount();
  const stmt = db.prepare(
    'SELECT id, file_path, date_taken, file_date, location_json FROM photos ORDER BY date_taken DESC, id DESC LIMIT ? OFFSET ?'
  );
  const results: Pick<Photo, 'id' | 'filePath' | 'dateTaken' | 'fileDate' | 'location'>[] = [];

  for (let offset = 0; offset < total; offset += SUMMARY_QUERY_CHUNK_SIZE) {
    const rows = stmt.all(SUMMARY_QUERY_CHUNK_SIZE, offset) as any[];
    for (const row of rows) {
      results.push({
        id: row.id,
        filePath: row.file_path,
        dateTaken: row.date_taken,
        fileDate: row.file_date || '',
        location: parseJson<LocationMetadata | null>(row.location_json, null) ?? undefined,
      });
    }
    if (rows.length < SUMMARY_QUERY_CHUNK_SIZE) break;
    await new Promise((resolve) => setImmediate(resolve));
  }

  return results;
}

/**
 * Replaces the active library's full photo set to match `photos` exactly —
 * upserts everything present, and deletes any existing photo whose id is no
 * longer in the incoming list (e.g. the user deleted a file or a dedup
 * cleanup removed a photo). Mirrors the "send the whole current state, it
 * fully replaces what's stored" contract the renderer already uses for
 * library.json saves.
 *
 * Safety guard: if the incoming list is empty but the library isn't, this is
 * far more likely a bogus/incomplete save than an intentional full wipe, so
 * it's treated as a no-op — matching the equivalent guard that used to
 * protect library.json from being truncated by a stray empty save.
 */
export function replaceAllPhotos(photos: Photo[], dbHint?: DatabaseSync): { upsertedCount: number; deletedCount: number; skipped: boolean } {
  // This is a "this batch IS the complete library" operation — it deletes
  // whatever's in the target database but missing from `photos`, so it must
  // resolve that database from the batch's OWN content (its first virtual
  // photo's storage), not the ambient "active library" pointer, which can
  // legitimately point at a different library than the one this batch
  // actually belongs to (see resolveDbForPhoto's doc comment). Getting this
  // wrong here is worse than the face-overwrite bug it's fixed alongside:
  // it would delete photos from whatever library getDb() happened to
  // resolve to, based on an incoming set that was never meant to replace it.
  // A caller that already resolved the exact target database itself (e.g.
  // across an earlier await, where the ambient pointer could have moved on)
  // can pass it explicitly via dbHint instead of relying on getDb() here.
  const virtualPhoto = photos.find((p) => p.isVirtual);
  const db = virtualPhoto ? resolveDbForPhoto(virtualPhoto) : (dbHint || getDb());

  const existingCount = getTotalPhotoCount(db);
  if (photos.length === 0 && existingCount > 0) {
    return { upsertedCount: 0, deletedCount: 0, skipped: true };
  }

  const incomingIds = new Set(photos.map((p) => p.id));
  const existingIds = (db.prepare('SELECT id FROM photos').all() as any[]).map((r) => r.id as string);
  const idsToDelete = existingIds.filter((id) => !incomingIds.has(id));

  runInTransaction(() => {
    if (idsToDelete.length > 0) {
      deletePhotos(idsToDelete, db);
    }
    upsertPhotos(photos);
  }, db);

  return { upsertedCount: photos.length, deletedCount: idsToDelete.length, skipped: false };
}

export function deletePhotos(ids: string[], db: DatabaseSync = getDb()): void {
  if (ids.length === 0) return;
  runInTransaction(() => {
    const deletePhotoStmt = db.prepare('DELETE FROM photos WHERE id = ?');
    const deleteFacesStmt = db.prepare('DELETE FROM faces WHERE photo_id = ?');
    const deleteAlbumLinksStmt = db.prepare('DELETE FROM album_photos WHERE photo_id = ?');
    for (const id of ids) {
      deletePhotoStmt.run(id);
      deleteFacesStmt.run(id);
      deleteAlbumLinksStmt.run(id);
    }
  }, db);
}

export function setPhotoFavorite(id: string, isFavorite: boolean): void {
  getDb().prepare('UPDATE photos SET is_favorite = ? WHERE id = ?').run(fromBool(isFavorite), id);
}

/** Records that a OneDrive original was marked for space reclaim after processing (observability only). */
export function markOneDriveReleased(id: string, db: DatabaseSync = getDb()): void {
  db.prepare('UPDATE photos SET onedrive_released_at = ? WHERE id = ?').run(new Date().toISOString(), id);
}

// ---------------------------------------------------------------------------
// Faces
// ---------------------------------------------------------------------------

function rowToFace(row: any): DetectedFace {
  const face: DetectedFace = {
    id: row.id,
    photoId: row.photo_id,
    box: {
      x: row.box_x ?? 0,
      y: row.box_y ?? 0,
      width: row.box_width ?? 0,
      height: row.box_height ?? 0,
    },
    descriptor: parseJson<number[]>(row.descriptor_json, []),
    confidence: row.confidence ?? 0,
  };
  if (row.person_id) face.personId = row.person_id;
  if (row.image_width != null) face.imageWidth = row.image_width;
  if (row.image_height != null) face.imageHeight = row.image_height;
  if (row.is_confirmed != null) face.isConfirmed = toBool(row.is_confirmed);
  if (row.is_manual != null) face.isManual = toBool(row.is_manual);
  if (row.age != null) face.age = row.age;
  if (row.gender != null) face.gender = row.gender;
  if (row.gender_probability != null) face.genderProbability = row.gender_probability;
  const expressions = parseJson<Record<string, number> | null>(row.expressions_json, null);
  if (expressions) face.expressions = expressions;
  if (row.dominant_expression) face.dominantExpression = row.dominant_expression;
  return face;
}

const UPSERT_FACE_SQL = `
  INSERT INTO faces (
    id, photo_id, person_id, box_x, box_y, box_width, box_height, image_width, image_height,
    descriptor_json, confidence, is_confirmed, is_manual, age, gender, gender_probability,
    expressions_json, dominant_expression
  ) VALUES (
    @id, @photoId, @personId, @boxX, @boxY, @boxWidth, @boxHeight, @imageWidth, @imageHeight,
    @descriptorJson, @confidence, @isConfirmed, @isManual, @age, @gender, @genderProbability,
    @expressionsJson, @dominantExpression
  )
  ON CONFLICT(id) DO UPDATE SET
    photo_id=excluded.photo_id, person_id=excluded.person_id, box_x=excluded.box_x,
    box_y=excluded.box_y, box_width=excluded.box_width, box_height=excluded.box_height,
    image_width=excluded.image_width, image_height=excluded.image_height,
    descriptor_json=excluded.descriptor_json, confidence=excluded.confidence,
    is_confirmed=excluded.is_confirmed, is_manual=excluded.is_manual, age=excluded.age,
    gender=excluded.gender, gender_probability=excluded.gender_probability,
    expressions_json=excluded.expressions_json, dominant_expression=excluded.dominant_expression
`;

function faceToParams(face: DetectedFace): Record<string, any> {
  return {
    id: face.id,
    photoId: face.photoId,
    personId: face.personId ?? null,
    boxX: face.box?.x ?? null,
    boxY: face.box?.y ?? null,
    boxWidth: face.box?.width ?? null,
    boxHeight: face.box?.height ?? null,
    imageWidth: face.imageWidth ?? null,
    imageHeight: face.imageHeight ?? null,
    descriptorJson: face.descriptor ? JSON.stringify(face.descriptor) : null,
    confidence: face.confidence ?? null,
    isConfirmed: face.isConfirmed != null ? fromBool(face.isConfirmed) : 0,
    isManual: face.isManual != null ? fromBool(face.isManual) : 0,
    age: face.age ?? null,
    gender: face.gender ?? null,
    genderProbability: face.genderProbability ?? null,
    expressionsJson: face.expressions ? JSON.stringify(face.expressions) : null,
    dominantExpression: face.dominantExpression ?? null,
  };
}

export function getFacesForPhoto(photoId: string, db: DatabaseSync = getDb()): DetectedFace[] {
  const rows = db.prepare('SELECT * FROM faces WHERE photo_id = ?').all(photoId) as any[];
  return rows.map(rowToFace);
}

// SQLite rejects a statement with more bound parameters than this (the
// default SQLITE_MAX_VARIABLE_NUMBER is 999 on many builds) — batch large
// IN (...) lookups instead of binding one placeholder per photo.
const MAX_SQL_VARIABLES_PER_BATCH = 500;

/** Bulk-hydrates photo.faces on each photo, batching the lookup for large photo counts. */
export function attachFacesToPhotos(photos: Photo[], db: DatabaseSync = getDb()): void {
  if (photos.length === 0) return;
  const byPhoto = new Map<string, DetectedFace[]>();

  for (let i = 0; i < photos.length; i += MAX_SQL_VARIABLES_PER_BATCH) {
    const batch = photos.slice(i, i + MAX_SQL_VARIABLES_PER_BATCH);
    const placeholders = batch.map(() => '?').join(',');
    const rows = db
      .prepare(`SELECT * FROM faces WHERE photo_id IN (${placeholders})`)
      .all(...batch.map((p) => p.id)) as any[];
    for (const row of rows) {
      const face = rowToFace(row);
      if (!byPhoto.has(face.photoId)) byPhoto.set(face.photoId, []);
      byPhoto.get(face.photoId)!.push(face);
    }
  }

  for (const photo of photos) {
    photo.faces = byPhoto.get(photo.id) || [];
  }
}

export function replaceFacesForPhoto(photoId: string, faces: DetectedFace[], skipTransaction = false, db: DatabaseSync = getDb()): void {
  const doWork = () => {
    db.prepare('DELETE FROM faces WHERE photo_id = ?').run(photoId);
    const stmt = db.prepare(UPSERT_FACE_SQL);
    for (const face of faces) {
      stmt.run(faceToParams({ ...face, photoId }) as any);
    }
  };
  if (skipTransaction) {
    doWork();
  } else {
    runInTransaction(doWork, db);
  }
}

export function getAllFaces(db: DatabaseSync = getDb()): DetectedFace[] {
  const rows = db.prepare('SELECT * FROM faces').all() as any[];
  return rows.map(rowToFace);
}

/** Same result as getAllFaces, chunked + yielding — see getAllPhotosChunked's doc comment for why. */
export async function getAllFacesChunked(db: DatabaseSync = getDb()): Promise<DetectedFace[]> {
  const stmt = db.prepare('SELECT * FROM faces LIMIT ? OFFSET ?');
  const faces: DetectedFace[] = [];
  for (let offset = 0; ; offset += FULL_LOAD_CHUNK_SIZE) {
    const rows = stmt.all(FULL_LOAD_CHUNK_SIZE, offset) as any[];
    if (rows.length === 0) break;
    faces.push(...rows.map(rowToFace));
    if (rows.length < FULL_LOAD_CHUNK_SIZE) break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return faces;
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

function rowToPerson(row: any): Person {
  return {
    id: row.id,
    name: row.name,
    coverFaceId: row.cover_face_id ?? undefined,
    coverPhotoId: row.cover_photo_id ?? undefined,
    faceCount: row.face_count ?? 0,
    photoCount: row.photo_count ?? 0,
    createdAt: row.created_at,
  };
}

const UPSERT_PERSON_SQL = `
  INSERT INTO people (id, name, cover_face_id, cover_photo_id, face_count, photo_count, created_at)
  VALUES (@id, @name, @coverFaceId, @coverPhotoId, @faceCount, @photoCount, @createdAt)
  ON CONFLICT(id) DO UPDATE SET
    name=excluded.name, cover_face_id=excluded.cover_face_id, cover_photo_id=excluded.cover_photo_id,
    face_count=excluded.face_count, photo_count=excluded.photo_count, created_at=excluded.created_at
`;

// People are stored in the global (library-independent) database — a name a
// user has assigned to someone must stay recognizable across every library
// folder they open, not be scoped to just the one active when it was set.

export function upsertPerson(person: Person): void {
  getGlobalDb()
    .prepare(UPSERT_PERSON_SQL)
    .run({
      id: person.id,
      name: person.name,
      coverFaceId: person.coverFaceId ?? null,
      coverPhotoId: person.coverPhotoId ?? null,
      faceCount: person.faceCount ?? 0,
      photoCount: person.photoCount ?? 0,
      createdAt: person.createdAt,
    } as any);
}

export function upsertPeople(people: Person[]): void {
  if (people.length === 0) return;
  const db = getGlobalDb();
  runInTransaction(() => {
    const stmt = db.prepare(UPSERT_PERSON_SQL);
    for (const person of people) {
      stmt.run({
        id: person.id,
        name: person.name,
        coverFaceId: person.coverFaceId ?? null,
        coverPhotoId: person.coverPhotoId ?? null,
        faceCount: person.faceCount ?? 0,
        photoCount: person.photoCount ?? 0,
        createdAt: person.createdAt,
      } as any);
    }
  }, db);
}

export function getAllPeople(): Person[] {
  const db = getGlobalDb();
  const rows = db.prepare('SELECT * FROM people ORDER BY name COLLATE NOCASE ASC').all() as any[];
  return rows.map(rowToPerson);
}

/** Deletes a person globally and unassigns their faces in the CURRENTLY ACTIVE library only. */
export function deletePerson(personId: string): void {
  getGlobalDb().prepare('DELETE FROM people WHERE id = ?').run(personId);
  getDb().prepare('UPDATE faces SET person_id = NULL, is_confirmed = 0 WHERE person_id = ?').run(personId);
}

export function renamePerson(personId: string, name: string): void {
  getGlobalDb().prepare('UPDATE people SET name = ? WHERE id = ?').run(name, personId);
}

/** Replaces the global people registry. */
export function replaceAllPeople(people: Person[]): void {
  const db = getGlobalDb();
  runInTransaction(() => {
    db.exec('DELETE FROM people');
    const peopleStmt = db.prepare(UPSERT_PERSON_SQL);
    for (const person of people) {
      peopleStmt.run({
        id: person.id,
        name: person.name,
        coverFaceId: person.coverFaceId ?? null,
        coverPhotoId: person.coverPhotoId ?? null,
        faceCount: person.faceCount ?? 0,
        photoCount: person.photoCount ?? 0,
        createdAt: person.createdAt,
      } as any);
    }
  }, db);
}

/** Replaces faces in the currently active library only (people live in the global database — see replaceAllPeople). */
export function replaceAllFaces(faces: DetectedFace[]): void {
  const db = getDb();
  runInTransaction(() => {
    db.exec('DELETE FROM faces');
    const faceStmt = db.prepare(UPSERT_FACE_SQL);
    for (const face of faces) {
      faceStmt.run(faceToParams(face) as any);
    }
  }, db);
}

/** Convenience wrapper used by the JSON migration: replaces both the global people registry and this library's faces. */
export function replaceAllPeopleAndFaces(people: Person[], faces: DetectedFace[]): void {
  replaceAllPeople(people);
  replaceAllFaces(faces);
}

// ---------------------------------------------------------------------------
// Albums
// ---------------------------------------------------------------------------

function rowToAlbum(row: any, photoIds: string[]): Album {
  return {
    id: row.id,
    title: row.title,
    description: row.description ?? undefined,
    coverPhotoId: row.cover_photo_id ?? undefined,
    photoIds,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    eventDate: row.event_date ?? undefined,
  };
}

export function upsertAlbum(album: Album, db: DatabaseSync = getDb()): void {
  runInTransaction(() => {
    db.prepare(
      `INSERT INTO albums (id, title, description, cover_photo_id, created_at, updated_at, event_date)
       VALUES (@id, @title, @description, @coverPhotoId, @createdAt, @updatedAt, @eventDate)
       ON CONFLICT(id) DO UPDATE SET
         title=excluded.title, description=excluded.description, cover_photo_id=excluded.cover_photo_id,
         updated_at=excluded.updated_at, event_date=excluded.event_date`
    ).run({
      id: album.id,
      title: album.title,
      description: album.description ?? null,
      coverPhotoId: album.coverPhotoId ?? null,
      createdAt: album.createdAt,
      updatedAt: album.updatedAt,
      eventDate: album.eventDate ?? null,
    } as any);

    db.prepare('DELETE FROM album_photos WHERE album_id = ?').run(album.id);
    const linkStmt = db.prepare('INSERT INTO album_photos (album_id, photo_id, position) VALUES (?, ?, ?)');
    album.photoIds.forEach((photoId, index) => {
      linkStmt.run(album.id, photoId, index);
    });
  }, db);
}

export function getAllAlbums(db: DatabaseSync = getDb()): Album[] {
  const albumRows = db.prepare('SELECT * FROM albums ORDER BY created_at DESC').all() as any[];
  const linkRows = db.prepare('SELECT album_id, photo_id FROM album_photos ORDER BY album_id, position').all() as any[];
  const photoIdsByAlbum = new Map<string, string[]>();
  for (const link of linkRows) {
    if (!photoIdsByAlbum.has(link.album_id)) photoIdsByAlbum.set(link.album_id, []);
    photoIdsByAlbum.get(link.album_id)!.push(link.photo_id);
  }
  return albumRows.map((row) => rowToAlbum(row, photoIdsByAlbum.get(row.id) || []));
}

/**
 * Replaces the active library's full album set to match `albums` exactly
 * (upserts + deletes removed ones).
 *
 * Safety guard: if the incoming list is empty but the library has albums,
 * this is far more likely a stale/bogus save (e.g. the renderer's in-memory
 * albums hadn't been repopulated yet for whichever library this db actually
 * belongs to — see switchLibrary()'s doc comment) than someone intentionally
 * deleting every album at once, so it's treated as a no-op. Mirrors
 * replaceAllPhotos' identical guard.
 */
export function replaceAllAlbums(albums: Album[], db: DatabaseSync = getDb()): { skipped: boolean } {
  const incomingIds = new Set(albums.map((a) => a.id));
  const existingIds = (db.prepare('SELECT id FROM albums').all() as any[]).map((r) => r.id as string);

  if (albums.length === 0 && existingIds.length > 0) {
    return { skipped: true };
  }

  const idsToDelete = existingIds.filter((id) => !incomingIds.has(id));

  runInTransaction(() => {
    for (const id of idsToDelete) {
      deleteAlbum(id, db);
    }
    for (const album of albums) {
      upsertAlbum(album, db);
    }
  }, db);

  return { skipped: false };
}

export function deleteAlbum(albumId: string, db: DatabaseSync = getDb()): void {
  runInTransaction(() => {
    db.prepare('DELETE FROM albums WHERE id = ?').run(albumId);
    db.prepare('DELETE FROM album_photos WHERE album_id = ?').run(albumId);
  }, db);
}

// ---------------------------------------------------------------------------
// Settings (selectedFolder, recentLibraries, face-cache, arbitrary config)
//
// Always stored in the global database, not the active per-library one —
// every setting used today (recentLibraries, selectedFolder, the
// cross-library face descriptor cache) is a cross-library concept, so there
// is currently no such thing as a genuinely per-library setting.
// ---------------------------------------------------------------------------

export function getSetting<T>(key: string, fallback: T): T {
  const db = getGlobalDb();
  const row = db.prepare('SELECT value_json FROM settings WHERE key = ?').get(key) as
    | { value_json: string }
    | undefined;
  if (!row) return fallback;
  return parseJson<T>(row.value_json, fallback);
}

export function setSetting<T>(key: string, value: T): void {
  getGlobalDb()
    .prepare(
      `INSERT INTO settings (key, value_json) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`
    )
    .run(key, JSON.stringify(value));
}
