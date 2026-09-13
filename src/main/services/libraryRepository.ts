import { getDb, getGlobalDb, runInTransaction } from './db';
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
    sharpnessScore: row.sharpness_score ?? undefined,
    rotation: row.rotation ?? undefined,
    isHeicRotated: toBool(row.is_heic_rotated),
    heicRotation: row.heic_rotation ?? undefined,
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
    is_excluded, face_scan_completed, sharpness_score, rotation, is_heic_rotated,
    heic_rotation, exif_json, location_json
  ) VALUES (
    @id, @filePath, @fileName, @fileSize, @fileDate, @dateTaken, @year, @month, @day,
    @width, @height, @isFavorite, @isVirtual, @originalRemotePath, @storageName,
    @isExcluded, @faceScanCompleted, @sharpnessScore, @rotation, @isHeicRotated,
    @heicRotation, @exifJson, @locationJson
  )
  ON CONFLICT(id) DO UPDATE SET
    file_path=excluded.file_path, file_name=excluded.file_name, file_size=excluded.file_size,
    file_date=excluded.file_date, date_taken=excluded.date_taken, year=excluded.year,
    month=excluded.month, day=excluded.day, width=excluded.width, height=excluded.height,
    is_favorite=excluded.is_favorite, is_virtual=excluded.is_virtual,
    original_remote_path=excluded.original_remote_path, storage_name=excluded.storage_name,
    is_excluded=excluded.is_excluded, face_scan_completed=excluded.face_scan_completed,
    sharpness_score=excluded.sharpness_score, rotation=excluded.rotation,
    is_heic_rotated=excluded.is_heic_rotated, heic_rotation=excluded.heic_rotation,
    exif_json=excluded.exif_json, location_json=excluded.location_json
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
    sharpnessScore: photo.sharpnessScore ?? null,
    rotation: photo.rotation ?? null,
    isHeicRotated: fromBool(photo.isHeicRotated),
    heicRotation: photo.heicRotation ?? null,
    exifJson: photo.exif ? JSON.stringify(photo.exif) : null,
    locationJson: photo.location ? JSON.stringify(photo.location) : null,
  };
}

export function upsertPhoto(photo: Photo): void {
  const db = getDb();
  db.prepare(UPSERT_PHOTO_SQL).run(photoToParams(photo) as any);
  if (photo.faces) {
    replaceFacesForPhoto(photo.id, photo.faces);
  }
}

export function upsertPhotos(photos: Photo[]): void {
  if (photos.length === 0) return;
  runInTransaction(() => {
    const db = getDb();
    const stmt = db.prepare(UPSERT_PHOTO_SQL);
    for (const photo of photos) {
      stmt.run(photoToParams(photo) as any);
      if (photo.faces) {
        replaceFacesForPhoto(photo.id, photo.faces, /* skipTransaction */ true);
      }
    }
  });
}

export function getPhotoById(id: string): Photo | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM photos WHERE id = ?').get(id);
  if (!row) return null;
  const photo = rowToPhoto(row);
  photo.faces = getFacesForPhoto(id);
  return photo;
}

export function getTotalPhotoCount(): number {
  const db = getDb();
  const row = db.prepare('SELECT COUNT(*) as c FROM photos').get() as any;
  return row?.c ?? 0;
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

export function getAllPhotos(): Photo[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM photos ORDER BY date_taken DESC, id DESC').all() as any[];
  const photos = rows.map(rowToPhoto);
  attachFacesToPhotos(photos);
  return photos;
}

export function deletePhotos(ids: string[]): void {
  if (ids.length === 0) return;
  runInTransaction(() => {
    const db = getDb();
    const deletePhotoStmt = db.prepare('DELETE FROM photos WHERE id = ?');
    const deleteFacesStmt = db.prepare('DELETE FROM faces WHERE photo_id = ?');
    const deleteAlbumLinksStmt = db.prepare('DELETE FROM album_photos WHERE photo_id = ?');
    for (const id of ids) {
      deletePhotoStmt.run(id);
      deleteFacesStmt.run(id);
      deleteAlbumLinksStmt.run(id);
    }
  });
}

export function setPhotoFavorite(id: string, isFavorite: boolean): void {
  getDb().prepare('UPDATE photos SET is_favorite = ? WHERE id = ?').run(fromBool(isFavorite), id);
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

export function getFacesForPhoto(photoId: string): DetectedFace[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM faces WHERE photo_id = ?').all(photoId) as any[];
  return rows.map(rowToFace);
}

/** Bulk-hydrates photo.faces on each photo, using one query instead of N. */
export function attachFacesToPhotos(photos: Photo[]): void {
  if (photos.length === 0) return;
  const db = getDb();
  const placeholders = photos.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT * FROM faces WHERE photo_id IN (${placeholders})`)
    .all(...photos.map((p) => p.id)) as any[];
  const byPhoto = new Map<string, DetectedFace[]>();
  for (const row of rows) {
    const face = rowToFace(row);
    if (!byPhoto.has(face.photoId)) byPhoto.set(face.photoId, []);
    byPhoto.get(face.photoId)!.push(face);
  }
  for (const photo of photos) {
    photo.faces = byPhoto.get(photo.id) || [];
  }
}

export function replaceFacesForPhoto(photoId: string, faces: DetectedFace[], skipTransaction = false): void {
  const db = getDb();
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
    runInTransaction(doWork);
  }
}

export function getAllFaces(): DetectedFace[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM faces').all() as any[];
  return rows.map(rowToFace);
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

export function upsertAlbum(album: Album): void {
  runInTransaction(() => {
    const db = getDb();
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
  });
}

export function getAllAlbums(): Album[] {
  const db = getDb();
  const albumRows = db.prepare('SELECT * FROM albums ORDER BY created_at DESC').all() as any[];
  const linkRows = db.prepare('SELECT album_id, photo_id FROM album_photos ORDER BY album_id, position').all() as any[];
  const photoIdsByAlbum = new Map<string, string[]>();
  for (const link of linkRows) {
    if (!photoIdsByAlbum.has(link.album_id)) photoIdsByAlbum.set(link.album_id, []);
    photoIdsByAlbum.get(link.album_id)!.push(link.photo_id);
  }
  return albumRows.map((row) => rowToAlbum(row, photoIdsByAlbum.get(row.id) || []));
}

export function deleteAlbum(albumId: string): void {
  runInTransaction(() => {
    const db = getDb();
    db.prepare('DELETE FROM albums WHERE id = ?').run(albumId);
    db.prepare('DELETE FROM album_photos WHERE album_id = ?').run(albumId);
  });
}

// ---------------------------------------------------------------------------
// Settings (selectedFolder, recentLibraries, arbitrary key/value config)
// ---------------------------------------------------------------------------

export function getSetting<T>(key: string, fallback: T): T {
  const db = getDb();
  const row = db.prepare('SELECT value_json FROM settings WHERE key = ?').get(key) as
    | { value_json: string }
    | undefined;
  if (!row) return fallback;
  return parseJson<T>(row.value_json, fallback);
}

export function setSetting<T>(key: string, value: T): void {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value_json) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`
    )
    .run(key, JSON.stringify(value));
}
