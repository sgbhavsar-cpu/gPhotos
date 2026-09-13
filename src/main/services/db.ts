import fs from 'fs';
import path from 'path';
import os from 'os';

// node:sqlite is a built-in Node.js module (stable since Node 22.5+/24). Electron
// 41 bundles Node 24, so this needs no native addon compilation — unlike
// better-sqlite3, which requires a C++ toolchain to rebuild against Electron's
// ABI and fails on machines without Visual Studio Build Tools installed.
import { DatabaseSync, StatementSync } from 'node:sqlite';

export const SCHEMA_VERSION = 1;

function getGlobalUserDataDir(): string {
  if (process.env.GPHOTOS_TEST_DB_DIR) {
    return process.env.GPHOTOS_TEST_DB_DIR;
  }
  try {
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') {
      return path.join(app.getPath('userData'));
    }
  } catch {}
  const base =
    process.env.APPDATA ||
    (process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library/Application Support')
      : path.join(os.homedir(), '.config'));
  return path.join(base, 'gPhotos');
}

/**
 * Each library folder gets its own database file (mirroring the existing
 * `.gphotos_catalog` per-folder JSON catalog convention), so switching back to
 * a previously-opened library is an instant reconnect, not a rescan. When no
 * specific library folder is given (customDir), a single default database in
 * the app's userData directory is used.
 */
export function getDbPath(customDir?: string | null): string {
  if (customDir && fs.existsSync(customDir)) {
    return path.join(customDir, '.gphotos_catalog', 'gphotos.db');
  }
  return path.join(getGlobalUserDataDir(), 'gphotos.db');
}

// Cache of open connections keyed by resolved db file path, so flipping
// between a handful of recently-used libraries doesn't reopen/re-migrate a
// connection on every switch.
const openConnections = new Map<string, DatabaseSync>();
let activeDbPath: string | null = null;

/** Points subsequent getDb() calls at the database for this library folder (or the default one if null/omitted). */
export function setActiveLibrary(customDir?: string | null): void {
  activeDbPath = getDbPath(customDir);
}

const SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS photos (
    id TEXT PRIMARY KEY,
    file_path TEXT NOT NULL,
    file_name TEXT NOT NULL,
    file_size INTEGER NOT NULL DEFAULT 0,
    file_date TEXT,
    date_taken TEXT NOT NULL,
    year INTEGER NOT NULL,
    month INTEGER NOT NULL,
    day INTEGER NOT NULL,
    width INTEGER,
    height INTEGER,
    is_favorite INTEGER NOT NULL DEFAULT 0,
    is_virtual INTEGER NOT NULL DEFAULT 0,
    original_remote_path TEXT,
    storage_name TEXT,
    is_excluded INTEGER NOT NULL DEFAULT 0,
    face_scan_completed INTEGER NOT NULL DEFAULT 0,
    sharpness_score REAL,
    rotation INTEGER,
    is_heic_rotated INTEGER NOT NULL DEFAULT 0,
    heic_rotation INTEGER,
    exif_json TEXT,
    location_json TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_photos_date_taken ON photos(date_taken DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_photos_year_month ON photos(year, month)`,
  `CREATE INDEX IF NOT EXISTS idx_photos_storage_name ON photos(storage_name)`,
  `CREATE INDEX IF NOT EXISTS idx_photos_original_remote_path ON photos(original_remote_path)`,

  `CREATE TABLE IF NOT EXISTS people (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    cover_face_id TEXT,
    cover_photo_id TEXT,
    face_count INTEGER NOT NULL DEFAULT 0,
    photo_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS faces (
    id TEXT PRIMARY KEY,
    photo_id TEXT NOT NULL,
    person_id TEXT,
    box_x REAL,
    box_y REAL,
    box_width REAL,
    box_height REAL,
    image_width REAL,
    image_height REAL,
    descriptor_json TEXT,
    confidence REAL,
    is_confirmed INTEGER NOT NULL DEFAULT 0,
    is_manual INTEGER NOT NULL DEFAULT 0,
    age REAL,
    gender TEXT,
    gender_probability REAL,
    expressions_json TEXT,
    dominant_expression TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_faces_photo_id ON faces(photo_id)`,
  `CREATE INDEX IF NOT EXISTS idx_faces_person_id ON faces(person_id)`,

  `CREATE TABLE IF NOT EXISTS albums (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    cover_photo_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    event_date TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS album_photos (
    album_id TEXT NOT NULL,
    photo_id TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (album_id, photo_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_album_photos_album ON album_photos(album_id, position)`,

  `CREATE TABLE IF NOT EXISTS virtual_storages (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    network_source_path TEXT,
    local_mirror_root TEXT,
    last_synced TEXT,
    total_items INTEGER,
    total_size_saved INTEGER,
    newly_added INTEGER,
    delay_between_photos_sec REAL,
    bandwidth_limit_mbps REAL
  )`,

  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
  )`,
];

function applySchema(db: DatabaseSync): void {
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  for (const stmt of SCHEMA_STATEMENTS) {
    db.exec(stmt);
  }
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as
    | { value: string }
    | undefined;
  if (!row) {
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
  }
}

function openConnection(dbPath: string): DatabaseSync {
  const existing = openConnections.get(dbPath);
  if (existing) return existing;

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  applySchema(db);
  openConnections.set(dbPath, db);
  return db;
}

/**
 * Returns the connection for the currently active library (see
 * setActiveLibrary), opening and schema-migrating it on first access. Falls
 * back to the default (non-library-scoped) database if no library is active
 * yet, e.g. before the user has opened any folder. Holds photos/faces/albums
 * for whichever library folder is currently open.
 */
export function getDb(): DatabaseSync {
  const dbPath = activeDbPath || getDbPath(null);
  return openConnection(dbPath);
}

/**
 * Returns the single, library-independent database that holds People
 * identities (and other cross-library settings like recentLibraries) — people
 * a user has named must stay recognizable/reusable across every library
 * folder they open, not be scoped to just one of them.
 */
export function getGlobalDb(): DatabaseSync {
  return openConnection(getDbPath(null));
}

/** Test-only: closes all open connections and clears the active-library pointer. */
export function resetDbForTests(): void {
  for (const db of openConnections.values()) {
    try {
      db.close();
    } catch {}
  }
  openConnections.clear();
  activeDbPath = null;
}

/** Closes every open library connection (e.g. on app quit). */
export function closeDb(): void {
  resetDbForTests();
}

/** Closes and forgets one library's connection without touching others, e.g. after deleting that library. */
export function closeLibraryConnection(customDir?: string | null): void {
  const dbPath = getDbPath(customDir);
  const db = openConnections.get(dbPath);
  if (db) {
    try {
      db.close();
    } catch {}
    openConnections.delete(dbPath);
  }
  if (activeDbPath === dbPath) {
    activeDbPath = null;
  }
}

const transactionDepthByDb = new WeakMap<DatabaseSync, number>();

/**
 * Runs fn atomically against the given database (the active per-library
 * database by default; pass getGlobalDb() to target the People database
 * instead). Safe to call from inside another runInTransaction() on the SAME
 * database — SQLite doesn't support nested BEGIN/COMMIT, so nested calls use
 * a SAVEPOINT instead, keeping the call chain composable and atomic as one
 * unit. Transactions on different databases (e.g. per-library vs global) are
 * independent of each other and may be nested/interleaved freely.
 */
export function runInTransaction<T>(fn: () => T, db: DatabaseSync = getDb()): T {
  const depth = transactionDepthByDb.get(db) ?? 0;
  transactionDepthByDb.set(db, depth + 1);
  const savepointName = `sp_${depth}`;
  try {
    if (depth === 0) {
      db.exec('BEGIN');
    } else {
      db.exec(`SAVEPOINT ${savepointName}`);
    }
    const result = fn();
    if (depth === 0) {
      db.exec('COMMIT');
    } else {
      db.exec(`RELEASE ${savepointName}`);
    }
    return result;
  } catch (err) {
    try {
      if (depth === 0) {
        db.exec('ROLLBACK');
      } else {
        db.exec(`ROLLBACK TO ${savepointName}`);
      }
    } catch {}
    throw err;
  } finally {
    transactionDepthByDb.set(db, depth);
  }
}

export type { DatabaseSync, StatementSync };
