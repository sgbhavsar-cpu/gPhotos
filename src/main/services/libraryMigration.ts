import fs from 'fs';
import path from 'path';
import { Photo, Person, DetectedFace, Album } from '../../types';
import { getDb, runInTransaction, setActiveLibrary } from './db';
import {
  upsertPhotos,
  replaceAllPeopleAndFaces,
  upsertAlbum,
  setSetting,
  getTotalPhotoCount,
} from './libraryRepository';

const STORAGE_KEY = 'gphotos_library_v1';
const GLOBAL_PEOPLE_KEY = 'gphotos_people_v2';

interface RawLibraryV1 {
  photos?: Photo[];
  people?: Person[];
  faces?: DetectedFace[];
  albums?: Album[];
  selectedFolder?: string | null;
  recentLibraries?: string[];
}

interface RawLibraryFile {
  [STORAGE_KEY]?: RawLibraryV1;
  [GLOBAL_PEOPLE_KEY]?: Person[];
  [key: string]: any;
}

export interface MigrationResult {
  migrated: boolean;
  reason?: string;
  photoCount: number;
  peopleCount: number;
  faceCount: number;
  albumCount: number;
  backupPath?: string;
}

function isAlreadyMigrated(): boolean {
  const db = getDb();
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('migrated_from_json') as
    | { value: string }
    | undefined;
  return !!row;
}

function markMigrated(sourcePath: string): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run('migrated_from_json', JSON.stringify({ at: new Date().toISOString(), sourcePath }));
}

/**
 * One-time, idempotent migration of the legacy library.json store into SQLite.
 * Safe to call on every app startup: it no-ops once the database already has
 * data or has already recorded a migration, so it never re-runs or duplicates.
 *
 * Never deletes library.json — on success it is renamed to a timestamped
 * `.bak-migrated-*` file so the original data remains on disk as a durable,
 * human-inspectable backup even though the app no longer reads it.
 */
export function migrateLibraryJsonToSqliteIfNeeded(libraryJsonPath: string): MigrationResult {
  if (!fs.existsSync(libraryJsonPath)) {
    return { migrated: false, reason: 'no-source-file', photoCount: 0, peopleCount: 0, faceCount: 0, albumCount: 0 };
  }

  let raw: RawLibraryFile;
  try {
    raw = JSON.parse(fs.readFileSync(libraryJsonPath, 'utf-8'));
  } catch (err: any) {
    return {
      migrated: false,
      reason: `unreadable-source-file: ${err.message}`,
      photoCount: 0,
      peopleCount: 0,
      faceCount: 0,
      albumCount: 0,
    };
  }

  const lib = raw[STORAGE_KEY] || {};
  const photos: Photo[] = Array.isArray(lib.photos) ? lib.photos : [];
  const albums: Album[] = Array.isArray(lib.albums) ? lib.albums : [];

  // Photos/faces/albums are scoped to the library folder that was active when
  // library.json was last saved (falling back to the default database if none
  // was recorded) — people are migrated into the global, library-independent
  // database regardless (see replaceAllPeopleAndFaces).
  setActiveLibrary(lib.selectedFolder || null);

  if (isAlreadyMigrated() || getTotalPhotoCount() > 0) {
    return { migrated: false, reason: 'already-migrated', photoCount: 0, peopleCount: 0, faceCount: 0, albumCount: 0 };
  }

  // People: the active library's own people list is primary, but the global
  // people registry (gphotos_people_v2) may hold custom names for people not
  // currently represented in this library's photos — never drop those.
  const peopleById = new Map<string, Person>();
  for (const p of Array.isArray(lib.people) ? lib.people : []) {
    if (p && p.id) peopleById.set(p.id, p);
  }
  for (const p of Array.isArray(raw[GLOBAL_PEOPLE_KEY]) ? (raw[GLOBAL_PEOPLE_KEY] as Person[]) : []) {
    if (p && p.id && !peopleById.has(p.id)) peopleById.set(p.id, p);
  }
  const people = Array.from(peopleById.values());

  // Faces: primarily embedded per-photo (authoritative, what actually renders),
  // plus any orphaned entries from the flat state.faces list not already
  // covered by a photo's own faces array (matched by id).
  const facesById = new Map<string, DetectedFace>();
  for (const photo of photos) {
    for (const f of photo.faces || []) {
      if (f && f.id) facesById.set(f.id, f);
    }
  }
  for (const f of Array.isArray(lib.faces) ? lib.faces : []) {
    if (f && f.id && !facesById.has(f.id)) facesById.set(f.id, f);
  }
  const allFaces = Array.from(facesById.values());

  runInTransaction(() => {
    upsertPhotos(photos);
    replaceAllPeopleAndFaces(people, allFaces);
    for (const album of albums) {
      upsertAlbum(album);
    }
    if (lib.selectedFolder) setSetting('selectedFolder', lib.selectedFolder);
    if (Array.isArray(lib.recentLibraries)) setSetting('recentLibraries', lib.recentLibraries);
    markMigrated(libraryJsonPath);
  });

  let backupPath: string | undefined;
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    backupPath = `${libraryJsonPath}.bak-migrated-${timestamp}`;
    fs.renameSync(libraryJsonPath, backupPath);
  } catch (err) {
    console.warn('[libraryMigration] Migrated data to SQLite successfully, but failed to rename source library.json:', err);
  }

  return {
    migrated: true,
    photoCount: photos.length,
    peopleCount: people.length,
    faceCount: allFaces.length,
    albumCount: albums.length,
    backupPath,
  };
}
