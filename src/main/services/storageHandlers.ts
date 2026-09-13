import { setActiveLibrary } from './db';
import {
  replaceAllPhotos,
  upsertPeople,
  replaceAllPeople,
  replaceAllAlbums,
  getAllPhotos,
  getAllPeople,
  getAllAlbums,
  getAllFaces,
  getSetting,
  setSetting,
} from './libraryRepository';
import { ensureMigratedIfEmpty } from './catalogService';

export const STORAGE_KEY = 'gphotos_library_v1';
export const GLOBAL_PEOPLE_KEY = 'gphotos_people_v2';

export interface SaveLibraryPayload {
  photos?: any[];
  people?: any[];
  faces?: any[];
  albums?: any[];
  selectedFolder?: string | null;
  currentDirectory?: string | null;
  recentLibraries?: string[];
}

/**
 * Backs the `storage:save` IPC channel. Routes each key to the right
 * SQLite-backed repository operation:
 *  - gphotos_library_v1: replaces this library's photos/albums, and
 *    merge-only upserts people (never deletes — see gphotos_people_v2 below).
 *  - gphotos_people_v2: the authoritative global registry, a full
 *    destructive sync — this is the one save path Reset & Rescan relies on
 *    to actually clear the registry.
 *  - anything else: stored as an opaque settings blob so nothing is dropped.
 *
 * Returns the resolved library path a photo enqueue should target, if any
 * (the caller uses this to kick off thumbnail pre-caching).
 */
export function handleStorageSave(key: string, data: any): { success: boolean; enqueuePhotos?: any[]; enqueueLibraryPath?: string | null } {
  if (key === STORAGE_KEY && data) {
    const payload = data as SaveLibraryPayload;
    const libPath: string | null = payload.selectedFolder || payload.currentDirectory || null;
    if (libPath) setActiveLibrary(libPath);

    let enqueuePhotos: any[] | undefined;
    if (Array.isArray(payload.photos)) {
      const result = replaceAllPhotos(payload.photos as any);
      if (!result.skipped) {
        enqueuePhotos = payload.photos;
      }
    }

    if (Array.isArray(payload.people) && payload.people.length > 0) {
      upsertPeople(payload.people as any);
    }

    if (Array.isArray(payload.albums)) {
      replaceAllAlbums(payload.albums as any);
    }

    if (payload.selectedFolder) setSetting('selectedFolder', payload.selectedFolder);
    if (Array.isArray(payload.recentLibraries)) setSetting('recentLibraries', payload.recentLibraries);

    return { success: true, enqueuePhotos, enqueueLibraryPath: libPath };
  }

  if (key === GLOBAL_PEOPLE_KEY) {
    replaceAllPeople(Array.isArray(data) ? data : []);
    return { success: true };
  }

  setSetting(key, data);
  return { success: true };
}

/** Backs the `storage:load` IPC channel — the mirror image of handleStorageSave's routing. */
export function handleStorageLoad(key: string): any {
  ensureMigratedIfEmpty();

  if (key === STORAGE_KEY) {
    const photos = getAllPhotos();
    const people = getAllPeople();
    const albums = getAllAlbums();
    if (photos.length === 0 && people.length === 0 && albums.length === 0) return null;
    return {
      photos,
      people,
      faces: getAllFaces(),
      albums,
      selectedFolder: getSetting<string | null>('selectedFolder', null),
      recentLibraries: getSetting<string[]>('recentLibraries', []),
    };
  }
  if (key === GLOBAL_PEOPLE_KEY) {
    return getAllPeople();
  }
  return getSetting(key, null);
}
