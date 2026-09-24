import { setActiveLibrary, getDb, getDbForLibraryPath } from './db';
import {
  replaceAllPhotos,
  upsertPhotos,
  upsertPeople,
  replaceAllPeople,
  replaceAllAlbums,
  getAllPhotosChunked,
  getTotalPhotoCount,
  getAllPeople,
  getAllAlbums,
  getAllFacesChunked,
  getSetting,
  setSetting,
} from './libraryRepository';
import { ensureMigratedIfEmpty } from './catalogService';

export const STORAGE_KEY = 'gphotos_library_v1';
export const GLOBAL_PEOPLE_KEY = 'gphotos_people_v2';
const VIRTUAL_STORAGES_KEY = 'gphotos_virtual_storages_v1';
// Renderer-side face cache from the JSON-storage era. Faces live in SQLite now, so this only
// ever held a stale copy — but it had grown to ~390MB and was read, JSON-parsed (~3.7s frozen
// main process) and shipped to the renderer on EVERY launch. Reads return empty without touching
// the blob; any write replaces the blob with [] so the space is reclaimed.
export const LEGACY_FACE_CACHE_KEY = 'gphotos_face_cache_v2';

export interface SaveLibraryPayload {
  photos?: any[];
  // True when `photos` is only a partial view of the library (e.g. just the
  // catalog pages loaded so far under the SQLite paginated fast-path), not
  // its full contents. Sending this array through as a destructive full
  // replace would silently delete every not-yet-loaded photo's row.
  isPartialPageSet?: boolean;
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
 *  - gphotos_library_v1: replaces this library's photos/albums (or
 *    merge-only upserts photos when the incoming set is a known-partial
 *    page view — see isPartialPageSet above), and merge-only upserts people
 *    (never deletes — see gphotos_people_v2 below).
 *  - gphotos_people_v2: the authoritative global registry, a full
 *    destructive sync — this is the one save path Reset & Rescan relies on
 *    to actually clear the registry.
 *  - anything else: stored as an opaque settings blob so nothing is dropped.
 *
 * Returns the resolved library path a photo enqueue should target, if any
 * (the caller uses this to kick off thumbnail pre-caching).
 */
export function handleStorageSave(key: string, data: any): { success: boolean; enqueuePhotos?: any[]; enqueueLibraryPath?: string | null } {
  if (key === LEGACY_FACE_CACHE_KEY) {
    setSetting(key, []); // drop whatever was sent (and any old multi-hundred-MB value)
    return { success: true };
  }
  if (key === STORAGE_KEY && data) {
    const payload = data as SaveLibraryPayload;
    const libPath: string | null = payload.selectedFolder || payload.currentDirectory || null;
    if (libPath) setActiveLibrary(libPath);
    // Resolved once, explicitly, rather than relying on further ambient
    // getDb() calls below — this whole function is synchronous so there's no
    // await gap for another request to repoint the shared "active library"
    // pointer mid-way through, but pinning it here means every operation in
    // this call unambiguously targets the library this save is actually for.
    const db = libPath ? getDbForLibraryPath(libPath) : getDb();

    let enqueuePhotos: any[] | undefined;
    if (Array.isArray(payload.photos)) {
      if (payload.isPartialPageSet) {
        // Merge-only: update/insert the photos the renderer actually has
        // loaded, without touching (let alone deleting) any photo whose
        // page hasn't been fetched into memory yet.
        upsertPhotos(payload.photos as any);
        enqueuePhotos = payload.photos;
      } else {
        const result = replaceAllPhotos(payload.photos as any);
        if (!result.skipped) {
          enqueuePhotos = payload.photos;
        }
      }
    }

    if (Array.isArray(payload.people) && payload.people.length > 0) {
      upsertPeople(payload.people as any);
    }

    if (Array.isArray(payload.albums)) {
      replaceAllAlbums(payload.albums as any, db);
    }

    if (payload.selectedFolder) setSetting('selectedFolder', payload.selectedFolder);
    if (Array.isArray(payload.recentLibraries)) setSetting('recentLibraries', payload.recentLibraries);

    return { success: true, enqueuePhotos, enqueueLibraryPath: libPath };
  }

  if (key === GLOBAL_PEOPLE_KEY) {
    replaceAllPeople(Array.isArray(data) ? data : []);
    return { success: true };
  }

  if (key === VIRTUAL_STORAGES_KEY && Array.isArray(data)) {
    setSetting(key, dedupeVirtualStorages(data));
    return { success: true };
  }

  setSetting(key, data);
  return { success: true };
}

/**
 * Collapses virtual storage configs that point at the same network source
 * into one entry, keeping whichever was synced most recently.
 *
 * This setting is saved as a plain opaque blob (whatever the renderer's
 * current in-memory list is), with no merge step — so if two renderer
 * sessions/windows/relaunches ever hold different snapshots of the list
 * (e.g. one created a storage while another was still open with a stale
 * copy), the next save from the stale one silently reintroduces whatever
 * duplicate the fresher one had already removed. Deduping here, at the one
 * place this key is actually persisted, means a stale save can't
 * resurrect a duplicate regardless of how it got created.
 */
function dedupeVirtualStorages(storages: any[]): any[] {
  const byNetworkSource = new Map<string, any>();
  const order: string[] = [];

  for (const s of storages) {
    if (!s || typeof s !== 'object') continue;
    const key = String(s.networkSourcePath || s.name || '').trim().toLowerCase();
    if (!key) continue;

    const existing = byNetworkSource.get(key);
    if (!existing) {
      byNetworkSource.set(key, s);
      order.push(key);
      continue;
    }

    const existingSynced = existing.lastSynced ? new Date(existing.lastSynced).getTime() : 0;
    const candidateSynced = s.lastSynced ? new Date(s.lastSynced).getTime() : 0;
    if (candidateSynced >= existingSynced) {
      byNetworkSource.set(key, s);
    }
  }

  return order.map((key) => byNetworkSource.get(key));
}

/**
 * Backs the `storage:load` IPC channel and the mobile `GET /api/library`
 * endpoint — the mirror image of handleStorageSave's routing.
 *
 * `libraryDir`, when given, pins every read to that specific library's own
 * database via getDbForLibraryPath, instead of trusting whatever the shared
 * "active library" pointer (getDb()) happens to be at the moment this runs.
 * That pointer is one mutable value shared by the whole main process — the
 * Electron window's own IPC calls, the LAN web server's concurrent requests
 * from other devices, and background scans can all repoint it between when a
 * caller last confirmed which library it wants and when this function
 * actually executes. Without an explicit `libraryDir`, a caller loading
 * moments after some unrelated request changed the active library would
 * silently get that OTHER library's photos/albums/faces — this is what made
 * a mobile browser tab and the desktop window disagree on Albums/People
 * counts for the "same" library open on both.
 */
export async function handleStorageLoad(
  key: string,
  libraryDir?: string | null,
  options?: { includePhotos?: boolean; compactDescriptors?: boolean }
): Promise<any> {
  if (key === LEGACY_FACE_CACHE_KEY) return [];

  ensureMigratedIfEmpty();

  if (key === STORAGE_KEY) {
    const db = libraryDir ? getDbForLibraryPath(libraryDir) : getDb();
    // includePhotos:false is for callers that page photos in separately (the
    // renderer's catalog fast path) and only need people/faces/albums here.
    // Sending the whole photo list too — every photo WITH its faces, then every
    // face again — made this a several-hundred-MB message that froze the UI
    // thread for ~10s (twice) at every launch while it was deserialised.
    if (options?.includePhotos === false) {
      const people = getAllPeople();
      const albums = getAllAlbums(db);
      if (getTotalPhotoCount(db) === 0 && people.length === 0 && albums.length === 0) return null;
      let faces = await getAllFacesChunked(db);
      // compactDescriptors: send each 512-number descriptor as a Float32Array (raw bytes on the
      // wire) instead of a number[] (V8 serialises the ~15M numbers one by one, ~seconds of
      // UI-thread time). The renderer converts them straight back; float32 model output
      // round-trips exactly. Only for callers that opt in — JSON consumers (mobile web) must not.
      if (options?.compactDescriptors) {
        faces = faces.map((f) => (f.descriptor && f.descriptor.length ? ({ ...f, descriptor: Float32Array.from(f.descriptor) } as any) : f));
      }
      return {
        photos: [],
        people,
        faces,
        albums,
        selectedFolder: getSetting<string | null>('selectedFolder', null),
        recentLibraries: getSetting<string[]>('recentLibraries', []),
      };
    }

    // Chunked + yielding, not the plain sync getAllPhotos/getAllFaces — a
    // single un-yielding read across a several-thousand-photo library
    // measured as an 80+ second main-process block (see
    // getAllPhotosChunked's doc comment), which froze the whole app,
    // including this same handler's own dispatch, at every startup.
    const photos = await getAllPhotosChunked(db);
    const people = getAllPeople();
    const albums = getAllAlbums(db);
    if (photos.length === 0 && people.length === 0 && albums.length === 0) return null;
    return {
      photos,
      people,
      faces: await getAllFacesChunked(db),
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
