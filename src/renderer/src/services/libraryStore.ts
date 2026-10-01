import { Photo, Person, DetectedFace, PlaceAlbum, Album, AlbumChapter, CatalogMeta } from '../../../types';
import { groupPhotosByPlace } from './placesService';
import { logger } from './logger';
import { trackBackendCall } from './responseTracker';
import { appendAuthToken, authFetch } from './webAuthClient';
import { notifyError } from './notifications';
import { normalizeDegrees, resolveFaceFrame, rotateBox } from './faceGeometry';
import { getImageVersion } from './imageVersion';
import {
  clusterFaces,
  euclideanDistance,
  cosineDistance,
  computeQualityWeightedCentroid,
  DEFAULT_MATCH_THRESHOLD,
} from './clustering';

export interface LibraryState {
  photos: Photo[];
  people: Person[];
  faces: DetectedFace[];
  places: PlaceAlbum[];
  albums: Album[];
  selectedFolder: string | null;
  currentDirectory?: string | null;
  recentLibraries?: string[];
  isScanning: boolean;
  isDetectingFaces: boolean;
  faceDetectionProgress: { current: number; total: number } | null;
  catalogMeta?: CatalogMeta | null;
  totalCount?: number;
  isInitialized?: boolean;
}

/**
 * Undo storage:load's compactDescriptors (Float32Array on the wire): everything
 * else in the app (clustering, JSON saves) expects descriptor to be a plain number[]
 * — JSON.stringify of a Float32Array would silently write an object, not an array.
 */
export function expandCompactDescriptors(faces: any[] | undefined | null): void {
  if (!faces) return;
  for (const f of faces) {
    if (f && f.descriptor && !Array.isArray(f.descriptor) && typeof f.descriptor.length === 'number') {
      f.descriptor = Array.from(f.descriptor as ArrayLike<number>);
    }
  }
}

export function deduplicatePhotoList(photos: Photo[]): Photo[] {
  const map = new Map<string, Photo>();
  for (const p of photos) {
    const key = (p.originalRemotePath || p.filePath || '').toLowerCase().replace(/\\/g, '/');
    if (!map.has(key)) {
      map.set(key, p);
    } else {
      const existing = map.get(key)!;
      // Prefer physical over virtual for filePath, ID, and isVirtual
      const isVirtual = Boolean(existing.isVirtual && p.isVirtual);
      const unifiedPhoto = !p.isVirtual ? p : existing;
      const unifiedId = unifiedPhoto.id;
      const filePath = !p.isVirtual ? p.filePath : existing.filePath;
      const originalRemotePath = p.originalRemotePath || existing.originalRemotePath;

      const rawFaces = (p.faces && p.faces.length > 0) ? p.faces : existing.faces;
      const mergedFaces = (rawFaces || []).map((f) => ({
        ...f,
        photoId: unifiedId,
      }));

      const faceScanCompleted = Boolean(p.faceScanCompleted || existing.faceScanCompleted || mergedFaces.length > 0);
      const isFavorite = Boolean(p.isFavorite || existing.isFavorite);
      const location = p.location || existing.location;
      const exif = (p.exif && Object.keys(p.exif).length > 0) ? p.exif : existing.exif;

      map.set(key, {
        ...existing,
        ...p,
        id: unifiedId,
        filePath,
        originalRemotePath,
        isVirtual,
        faces: mergedFaces,
        faceScanCompleted,
        isFavorite,
        location,
        exif,
      });
    }
  }
  return Array.from(map.values());
}

const STORAGE_KEY = 'gphotos_library_v1';
const GLOBAL_PEOPLE_KEY = 'gphotos_people_v2';
const GLOBAL_FACE_CACHE_KEY = 'gphotos_face_cache_v2';

// Every Nth save re-signs every photo ignoring the per-object cache: the safety net for an in-place
// edit of NESTED photo data (exif/location contents, a face's fields) that the cheap guard can't see.
export const FULL_RESIGN_EVERY = 20;
// Catalog pages arriving in one run are announced to React at most this often (and once at the end).
const PAGE_NOTIFY_INTERVAL_MS = 250;

/**
 * Per-Photo-object save signature cache. `sig` is the (expensive) content signature; the other fields
 * snapshot what it was computed from, so an unchanged object costs ~25 comparisons instead of a
 * JSON.stringify of exif/location + string building. A replaced object never hits (new identity), and
 * a top-level in-place edit (photo.isFavorite = true) or face-array reassign/push fails the guard.
 */
interface SigEntry {
  sig: string;
  fc: boolean; // faces already copied into globalFaceCache for this snapshot
  filePath: unknown; fileName: unknown; fileSize: unknown; fileDate: unknown; dateTaken: unknown;
  year: unknown; month: unknown; day: unknown; width: unknown; height: unknown;
  isFavorite: unknown; isVirtual: unknown; originalRemotePath: unknown; storageName: unknown;
  isExcluded: unknown; faceScanCompleted: unknown; facesLocked: unknown; sharpnessScore: unknown;
  rotation: unknown; isHeicRotated: unknown; heicRotation: unknown; originalMtimeMs: unknown;
  exif: unknown; location: unknown; faces: unknown; nFaces: number;
}

function computePhotoSig(p: Photo): string {
  let faceSig = '';
  if (p.faces) {
    for (const f of p.faces) {
      faceSig += `${f.id},${f.personId ?? ''},${f.isConfirmed ? 1 : 0},${f.isManual ? 1 : 0},${f.box?.x},${f.box?.y},${f.box?.width},${f.box?.height};`;
    }
  }
  return [
    p.filePath, p.fileName, p.fileSize, p.fileDate, p.dateTaken, p.year, p.month, p.day,
    p.width, p.height, p.isFavorite, p.isVirtual, p.originalRemotePath, p.storageName,
    p.isExcluded, p.faceScanCompleted, p.facesLocked, p.sharpnessScore, p.rotation,
    p.isHeicRotated, p.heicRotation, p.originalMtimeMs,
    p.exif ? JSON.stringify(p.exif) : '', p.location ? JSON.stringify(p.location) : '',
    p.faces ? p.faces.length : -1, faceSig,
  ].join('|');
}

function makeSigEntry(p: Photo): SigEntry {
  return {
    sig: computePhotoSig(p), fc: false,
    filePath: p.filePath, fileName: p.fileName, fileSize: p.fileSize, fileDate: p.fileDate, dateTaken: p.dateTaken,
    year: p.year, month: p.month, day: p.day, width: p.width, height: p.height,
    isFavorite: p.isFavorite, isVirtual: p.isVirtual, originalRemotePath: p.originalRemotePath, storageName: p.storageName,
    isExcluded: p.isExcluded, faceScanCompleted: p.faceScanCompleted, facesLocked: p.facesLocked, sharpnessScore: p.sharpnessScore,
    rotation: p.rotation, isHeicRotated: p.isHeicRotated, heicRotation: p.heicRotation, originalMtimeMs: p.originalMtimeMs,
    exif: p.exif, location: p.location, faces: p.faces, nFaces: p.faces ? p.faces.length : -1,
  };
}

function sigEntryMatches(e: SigEntry, p: Photo): boolean {
  return e.filePath === p.filePath && e.fileName === p.fileName && e.fileSize === p.fileSize
    && e.fileDate === p.fileDate && e.dateTaken === p.dateTaken && e.year === p.year && e.month === p.month
    && e.day === p.day && e.width === p.width && e.height === p.height && e.isFavorite === p.isFavorite
    && e.isVirtual === p.isVirtual && e.originalRemotePath === p.originalRemotePath && e.storageName === p.storageName
    && e.isExcluded === p.isExcluded && e.faceScanCompleted === p.faceScanCompleted && e.facesLocked === p.facesLocked
    && e.sharpnessScore === p.sharpnessScore && e.rotation === p.rotation && e.isHeicRotated === p.isHeicRotated
    && e.heicRotation === p.heicRotation && e.originalMtimeMs === p.originalMtimeMs && e.exif === p.exif
    && e.location === p.location && e.faces === p.faces && e.nFaces === (p.faces ? p.faces.length : -1);
}

export interface CachedFaceRecord {
  faces: DetectedFace[];
  faceScanCompleted: boolean;
}

export function normalizeFaceCacheKey(pathOrId?: string | null): string {
  if (!pathOrId) return '';
  return pathOrId.trim().toLowerCase().replace(/\\/g, '/');
}

export function getLocalPhotoUrl(
  filePath: string,
  originalRemotePath?: string,
  preferOriginal: boolean = false,
  size: number = 250
): string {
  // Cache key that changes when the photo's pixels changed on disk (see imageVersion.ts).
  const ver = getImageVersion(filePath);
  const vq = ver > 0 ? `&v=${ver}` : '';
  if (typeof window !== 'undefined') {
    const isElectron = !!(window.electronAPI && !(window.electronAPI as any).isBrowserShim);

    // If running in browser outside Electron (HTTP/HTTPS mobile or desktop web)
    if (!isElectron && window.location?.protocol?.startsWith('http')) {
      let url = `/api/photo?path=${encodeURIComponent(filePath)}`;
      if (originalRemotePath) {
        url += `&originalPath=${encodeURIComponent(originalRemotePath)}`;
      }
      if (preferOriginal) {
        url += `&preferOriginal=1`;
      } else if (size > 0) {
        url += `&size=${size}`;
      }
      return appendAuthToken(url + vq);
    }

    // If running in native Electron
    if (isElectron) {
      let url = `gphoto://load?path=${encodeURIComponent(filePath)}`;
      if (originalRemotePath) {
        url += `&originalPath=${encodeURIComponent(originalRemotePath)}`;
      }
      if (preferOriginal) {
        url += `&preferOriginal=1`;
      } else if (size > 0) {
        url += `&size=${size}`;
      }
      return url + vq;
    }

    // Generic web fallback
    if (window.location?.protocol?.startsWith('http')) {
      let url = `/api/photo?path=${encodeURIComponent(filePath)}`;
      if (originalRemotePath) {
        url += `&originalPath=${encodeURIComponent(originalRemotePath)}`;
      }
      if (preferOriginal) {
        url += `&preferOriginal=1`;
      } else if (size > 0) {
        url += `&size=${size}`;
      }
      return appendAuthToken(url + vq);
    }
  }
  return filePath;
}

export class LibraryManager {
  private state: LibraryState = {
    photos: [],
    people: [],
    faces: [],
    places: [],
    albums: [],
    selectedFolder: null,
    currentDirectory: null,
    isScanning: false,
    isDetectingFaces: false,
    faceDetectionProgress: null,
    catalogMeta: null,
    totalCount: 0,
    isInitialized: false,
  };

  private globalFaceCache: Map<string, CachedFaceRecord> = new Map();
  private globalPeopleRegistry: Map<string, Person> = new Map();
  private currentCatalogPage = 0;
  private isLoadingCatalogPage = false;
  private listeners: Set<() => void> = new Set();
  private saveDebounceTimer: any = null;
  // id -> signature of each photo as last persisted (or loaded from the DB);
  // null until the first load/save, which forces one full save.
  private savedPhotoSigs: Map<string, string> | null = null;
  private lastSavedPeopleSig: string | null = null;
  private isVerifyingInBackground = false;
  // Set when loading the persisted library failed (IPC rejected): the in-memory
  // state is then NOT the user's library, so saving it would overwrite the real
  // one. Saves stay blocked until a load / switch / open succeeds.
  private loadError: unknown = null;
  // Set when the global people registry failed to load (state.people is then NOT the stored
  // registry). Unlike loadError it is cleared only by a later successful people load, never by
  // setPhotos/switchLibrary, so the people key is never sent (main would wipe every person).
  private peopleLoadFailed = false;
  private loadInFlight: Promise<void> | null = null;
  // Saves run strictly one after another so the baseline signatures a save
  // advances are never computed against a half-finished previous save.
  private saveChain: Promise<void> = Promise.resolve();
  private saveFailures = 0;
  // Bumped on every library switch/replace; async page loads started under an
  // older epoch must not append their photos to the new library.
  private libraryEpoch = 0;
  // Ids removed via removePhotos that the database has not confirmed deleting yet.
  private pendingRemovedIds: Set<string> = new Set();
  // Per-Photo-object signature cache (see SigEntry). A new WeakMap drops every entry at once.
  private sigEntries = new WeakMap<Photo, SigEntry>();
  // Set by operations that edit face contents in place, and on blur/unload: the next scan re-signs
  // every photo. Otherwise it happens every FULL_RESIGN_EVERY-th save.
  private forceFullResign = false;
  private savesSinceFullResign = 0;
  // Catalog-page notification coalescing while a loadNextCatalogPages run is active.
  private pageRunDepth = 0;
  private pageNotifyPending = false;
  private pageNotifyTimer: any = null;
  private lastPageNotifyAt = 0;

  /** Forget the cached signature of a photo whose nested data (a face's fields) was edited in place. */
  private touch(photo: Photo | undefined | null) {
    if (photo) this.sigEntries.delete(photo);
  }

  /** clusterFaces edits face objects in place, and those objects are shared with photo.faces. */
  private cluster(...args: Parameters<typeof clusterFaces>): ReturnType<typeof clusterFaces> {
    const result = clusterFaces(...args);
    this.forceFullResign = true;
    return result;
  }

  public getCachedFaces(photo: { id?: string; filePath?: string; originalRemotePath?: string }): CachedFaceRecord | null {
    const keys = [
      normalizeFaceCacheKey(photo.originalRemotePath),
      normalizeFaceCacheKey(photo.filePath),
      photo.id,
    ].filter(Boolean) as string[];

    for (const k of keys) {
      if (this.globalFaceCache.has(k)) {
        return this.globalFaceCache.get(k)!;
      }
    }
    return null;
  }

  public cachePhotoFaces(
    photo: { id: string; filePath: string; originalRemotePath?: string },
    faces: DetectedFace[],
    faceScanCompleted = true
  ) {
    const record: CachedFaceRecord = {
      faces: faces || [],
      faceScanCompleted: Boolean(faceScanCompleted || (faces && faces.length > 0)),
    };
    const keys = [
      normalizeFaceCacheKey(photo.originalRemotePath),
      normalizeFaceCacheKey(photo.filePath),
      photo.id,
    ].filter(Boolean) as string[];

    for (const k of keys) {
      this.globalFaceCache.set(k, record);
    }
  }

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', () => {
        this.forceFullResign = true;
        this.flushSaveImmediately();
      });
      // Safety net for a missed in-place edit: when the window loses focus, audit every photo once
      // (off the interaction path) and save if the audit finds anything the cheap scan missed.
      window.addEventListener('blur', () => {
        if (!this.savedPhotoSigs || this.loadError) return;
        this.forceFullResign = true;
        if (this.scanPhotos().dirty) this.flushSaveImmediately();
      });
    }
    // No load here: App.tsx's mount effect always calls loadPersistedData(), and
    // a second load raced it (and in browser mode ran before the PIN gate, so it 401'd).
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Lightweight notification to React listeners without triggering disk I/O.
   */
  public notifyListeners() {
    this.listeners.forEach((fn) => fn());
  }

  /**
   * Full notification that updates UI immediately and schedules a debounced disk save.
   */
  public notify(immediateSave = false) {
    this.notifyListeners();
    if (immediateSave) {
      this.flushSaveImmediately();
    } else {
      this.scheduleDebouncedSave();
    }
  }

  private scheduleDebouncedSave(delayMs = 500) {
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
    }
    this.saveDebounceTimer = setTimeout(() => {
      this.saveDebounceTimer = null;
      this.savePersistedData();
    }, delayMs);
  }

  public async flushSaveImmediately() {
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
      this.saveDebounceTimer = null;
    }
    await this.savePersistedData();
  }

  public getState(): LibraryState {
    return this.state;
  }

  public init(initialState: Partial<LibraryState>) {
    this.state = {
      ...this.state,
      ...initialState,
    };
    if (this.state.photos) {
      this.state.places = groupPhotosByPlace(this.state.photos);
    }
    this.notify(true);
  }

  /**
   * Reconciles and self-heals people and faces across all photos and the central store.
   * Restores lost Person identities for photos that have faces with personId,
   * clusters unassigned faces, synchronizes state.faces with photo.faces,
   * and updates accurate face/photo counts.
   */
  public reconcilePeopleAndFaces(): boolean {
    let modified = false;

    // 1. Gather all faces from all photos and state.faces
    const allFacesMap = new Map<string, DetectedFace>();
    for (const f of this.state.faces) {
      if (f && f.id) allFacesMap.set(f.id, f);
    }
    for (const photo of this.state.photos) {
      if (photo.faces && Array.isArray(photo.faces)) {
        for (const face of photo.faces) {
          if (!face || !face.id) continue;
          const existing = allFacesMap.get(face.id);
          if (existing) {
            // `existing` may be the very face object a photo holds: edited in place, so re-sign everything.
            if (!existing.personId && face.personId) { existing.personId = face.personId; this.forceFullResign = true; }
            if (!existing.descriptor && face.descriptor) existing.descriptor = face.descriptor;
            if (face.isConfirmed && !existing.isConfirmed) { existing.isConfirmed = true; this.forceFullResign = true; }
          } else {
            allFacesMap.set(face.id, { ...face, photoId: photo.id });
          }
        }
      }
    }

    const allFaces = Array.from(allFacesMap.values());
    if (allFaces.length !== this.state.faces.length) {
      this.state.faces = allFaces;
      modified = true;
    }

    // 2. Build map of current known people
    const peopleMap = new Map<string, Person>();
    for (const p of this.state.people) {
      if (p && p.id) {
        peopleMap.set(p.id, { ...p });
      }
    }

    // 3. Identify faces whose personId is missing from peopleMap
    const missingPersonFaces = new Map<string, DetectedFace[]>();
    const unassignedFaces: DetectedFace[] = [];

    for (const face of allFaces) {
      if (face.personId) {
        if (!peopleMap.has(face.personId)) {
          if (!missingPersonFaces.has(face.personId)) {
            missingPersonFaces.set(face.personId, []);
          }
          missingPersonFaces.get(face.personId)!.push(face);
        }
      } else {
        unassignedFaces.push(face);
      }
    }

    // 4. Auto-reconstruct Person entities for faces that already had assigned personIds
    if (missingPersonFaces.size > 0) {
      let nextIndex = peopleMap.size + 1;
      for (const [pId, assignedFaces] of missingPersonFaces.entries()) {
        const registered = this.globalPeopleRegistry.get(pId);
        const firstFace = assignedFaces[0];
        const uniquePhotos = new Set(assignedFaces.map((f) => f.photoId));
        const personName = (registered && registered.name && !/^Person(\s+\d+)?$/i.test(registered.name))
          ? registered.name
          : `Person ${nextIndex++}`;

        const newPerson: Person = {
          id: pId,
          name: personName,
          coverFaceId: registered?.coverFaceId || firstFace.id,
          coverPhotoId: registered?.coverPhotoId || firstFace.photoId,
          faceCount: assignedFaces.length,
          photoCount: uniquePhotos.size,
          createdAt: registered?.createdAt || new Date().toISOString(),
        };
        peopleMap.set(pId, newPerson);
        this.globalPeopleRegistry.set(pId, newPerson);
        modified = true;
      }
    }

    // 5. If people is STILL empty and all faces have no personId, run clusterFaces
    if (peopleMap.size === 0 && allFaces.length > 0) {
      const facesWithDesc = allFaces.filter((f) => f.descriptor && f.descriptor.length > 0);
      if (facesWithDesc.length > 0) {
        const { people, updatedFaces } = this.cluster(allFaces, [], DEFAULT_MATCH_THRESHOLD, true);
        for (const p of people) {
          const registered = this.globalPeopleRegistry.get(p.id);
          if (registered && !/^Person(\s+\d+)?$/i.test(registered.name)) {
            p.name = registered.name;
          }
          peopleMap.set(p.id, p);
          this.globalPeopleRegistry.set(p.id, p);
        }
        this.state.faces = updatedFaces;
        modified = true;
      }
    } else if (unassignedFaces.length > 0 && peopleMap.size > 0) {
      // If we have some unassigned faces, cluster them matching to existing people or create new clusters
      const { people, updatedFaces } = this.cluster(allFaces, Array.from(peopleMap.values()), DEFAULT_MATCH_THRESHOLD, true);
      for (const p of people) {
        const registered = this.globalPeopleRegistry.get(p.id);
        if (registered && !/^Person(\s+\d+)?$/i.test(registered.name)) {
          p.name = registered.name;
        }
        peopleMap.set(p.id, p);
        this.globalPeopleRegistry.set(p.id, p);
      }
      this.state.faces = updatedFaces;
      modified = true;
    }

    // Never lose custom names: if any person in peopleMap has generic name but global registry has custom name, restore it!
    for (const [pId, person] of peopleMap.entries()) {
      const registered = this.globalPeopleRegistry.get(pId);
      if (registered && !/^Person(\s+\d+)?$/i.test(registered.name) && /^Person(\s+\d+)?$/i.test(person.name)) {
        person.name = registered.name;
        modified = true;
      }
    }

    // 6. Recalculate accurate faceCount and photoCount for all people
    const personFacesSet = new Map<string, Set<string>>();
    const personPhotosSet = new Map<string, Set<string>>();
    for (const pId of peopleMap.keys()) {
      personFacesSet.set(pId, new Set());
      personPhotosSet.set(pId, new Set());
    }

    for (const f of this.state.faces) {
      if (f.personId && peopleMap.has(f.personId)) {
        personFacesSet.get(f.personId)?.add(f.id);
        personPhotosSet.get(f.personId)?.add(f.photoId);
      }
    }

    const finalPeople: Person[] = [];
    for (const person of peopleMap.values()) {
      const fSet = personFacesSet.get(person.id);
      const pSet = personPhotosSet.get(person.id);
      finalPeople.push({
        ...person,
        faceCount: fSet ? fSet.size : 0,
        photoCount: pSet ? pSet.size : 0,
      });
    }
    this.state.people = finalPeople;

    // 7. Ensure photo.faces on every photo are synced with state.faces
    const photoFacesMap = new Map<string, DetectedFace[]>();
    for (const f of this.state.faces) {
      if (!photoFacesMap.has(f.photoId)) photoFacesMap.set(f.photoId, []);
      photoFacesMap.get(f.photoId)!.push(f);
    }
    for (const photo of this.state.photos) {
      if (photoFacesMap.has(photo.id)) {
        photo.faces = photoFacesMap.get(photo.id)!;
      }
    }

    if (modified) {
      this.scheduleDebouncedSave();
    }

    return modified;
  }

  public async loadGlobalCache() {
    try {
      let globalPeopleData: any = null;
      if (typeof window !== 'undefined' && window.electronAPI) {
        globalPeopleData = await window.electronAPI.loadLibraryData(GLOBAL_PEOPLE_KEY);
        // The old persisted face cache (GLOBAL_FACE_CACHE_KEY) is no longer loaded: SQLite is the
        // source of truth for faces, and that blob had grown to ~390MB read+parsed at every launch.
        // globalFaceCache below is now a per-session, in-memory cache only. This one-time write
        // makes main replace the stale blob with [] (idempotent, 2 bytes).
        window.electronAPI.saveLibraryData?.(GLOBAL_FACE_CACHE_KEY, [])?.catch?.(() => {});
      } else if (typeof localStorage !== 'undefined') {
        const rawP = localStorage.getItem(GLOBAL_PEOPLE_KEY);
        if (rawP) globalPeopleData = JSON.parse(rawP);
        localStorage.removeItem(GLOBAL_FACE_CACHE_KEY);
      }
      this.peopleLoadFailed = false; // the registry was read (possibly empty) — saving people is safe again

      if (Array.isArray(globalPeopleData) && globalPeopleData.length > 0) {
        const existingMap = new Map(this.state.people.map((p) => [p.id, p]));
        for (const p of globalPeopleData) {
          if (p && p.id) {
            this.globalPeopleRegistry.set(p.id, p);
            if (!existingMap.has(p.id)) {
              this.state.people.push(p);
            } else {
              const cur = existingMap.get(p.id)!;
              if (/^Person(\s+\d+)?$/i.test(cur.name) && !/^Person(\s+\d+)?$/i.test(p.name)) {
                cur.name = p.name;
              }
            }
          }
        }
      }
    } catch (err) {
      console.warn('Failed to load global people / face cache:', err);
      // Saving with an unloaded people registry would overwrite the stored one.
      this.peopleLoadFailed = true;
      this.reportLoadFailure(err);
    }
  }

  private reportLoadFailure(err: unknown) {
    this.loadError = err;
    notifyError('Could not load your library (changes will not be saved until it loads — restart the app)', err);
  }

  /**
   * Instant startup loader:
   * 1. Reads pre-calculated catalog_meta.json (<25 KB, ~1ms)
   * 2. Immediately paints Screen 1 with Page 0 (first 100 photos, ~40 KB)
   * 3. Seamlessly restores and reconciles people, faces, and albums from central storage
   */
  public loadPersistedData(): Promise<void> {
    // Concurrent callers (StrictMode's double effect, a remount) share one load.
    if (!this.loadInFlight) {
      this.loadInFlight = this.doLoadPersistedData().finally(() => {
        this.loadInFlight = null;
      });
    }
    return this.loadInFlight;
  }

  private async doLoadPersistedData() {
    this.libraryEpoch++;
    this.loadError = null;
    try {
      await this.loadGlobalCache();
      // 1. FAST-PATH (500K Scalable Catalog): Load pre-calculated metadata in ~1ms
      if (typeof window !== 'undefined' && window.electronAPI?.getCatalogMeta) {
        try {
          const t0 = performance.now();
          console.log('[STARTUP AUDIT] Renderer starting Fast-Path 500K catalog initialization...');
          const meta = await window.electronAPI.getCatalogMeta();
          const tMeta = performance.now();
          if (meta && meta.totalPhotos > 0) {
            console.log(`[STARTUP AUDIT] Pre-calculated catalog_meta.json loaded in ${(tMeta - t0).toFixed(1)}ms. Total photos: ${meta.totalPhotos}, Albums: ${meta.totalAlbums}, Places: ${meta.totalPlaces}, Timeline buckets: ${meta.timelineSummary?.length || 0}`);
            this.state.catalogMeta = meta;
            this.state.totalCount = meta.totalPhotos;
            this.state.places = (meta.placesSummary as any) || [];
            this.state.selectedFolder = meta.selectedFolder;
            this.state.currentDirectory = meta.currentDirectory;
            this.state.recentLibraries = meta.recentLibraries || [];

            // Fast Screen 1: Load Page 0 (first 100 photos). Pass the
            // just-resolved library explicitly rather than letting the main
            // process fall back to whatever it currently considers "active"
            // — that shared pointer can be repointed by another concurrent
            // request (another device's session, a background scan) between
            // this call and the meta call just above.
            const libraryDir = this.state.selectedFolder || undefined;
            const tPageStart = performance.now();
            const p0 = await window.electronAPI.getCatalogPage({ pageIndex: 0, pageSize: 100, libraryDir });
            const tPageEnd = performance.now();
            if (p0 && p0.photos && p0.photos.length > 0) {
              console.log(`[STARTUP AUDIT] Page 0 (${p0.photos.length} photos) loaded in ${(tPageEnd - tPageStart).toFixed(1)}ms. Total renderer startup time to first screen: ${(tPageEnd - t0).toFixed(1)}ms`);
              this.state.photos = p0.photos;
              this.stampPersisted(p0.photos, true);
              this.currentCatalogPage = 0;

              // Restore persisted people, faces, and albums from central
              // store — same explicit-library reasoning as above; without
              // it, Albums/People/Faces here could silently come from a
              // different library than the one this session's Photos/Places
              // just loaded from (see catalog-meta/catalog-page calls above).
              // Photos arrive page by page (above/below); only people/faces/albums are needed here.
              const data = await window.electronAPI.loadLibraryData(STORAGE_KEY, libraryDir, { includePhotos: false, compactDescriptors: true });
              if (data) {
                expandCompactDescriptors(data.faces);
                this.state.people = data.people || [];
                this.state.faces = data.faces || [];
                this.state.albums = data.albums || [];
                if (!this.state.selectedFolder) this.state.selectedFolder = data.selectedFolder || null;
                if (!this.state.recentLibraries || this.state.recentLibraries.length === 0) {
                  this.state.recentLibraries = data.recentLibraries || [];
                }
              }

              this.reconcilePeopleAndFaces();
              this.state.isInitialized = true;
              this.notifyListeners();
              // Screen 1 is already painted from Page 0 above — everything
              // past this point is a background top-up. Places/Albums/People
              // all read the same `photos` array but (unlike Gallery) have no
              // scroll to lazily trigger more pages, so without this they'd
              // only ever see whatever page Gallery happened to have loaded.
              // Not awaited: pages arrive progressively via notifyListeners().
              this.loadNextCatalogPages(Number.MAX_SAFE_INTEGER);
              return;
            }
          }
        } catch (metaErr) {
          console.warn('[STARTUP AUDIT] Fast-path catalog load failed, falling back:', metaErr);
        }
      }

      // 2. Web Browser Fast-Path over HTTP
      if (typeof window !== 'undefined' && window.location?.protocol?.startsWith('http')) {
        try {
          const metaRes = await authFetch('/api/catalog-meta', { signal: AbortSignal.timeout(1500) });
          if (metaRes.ok) {
            const meta: CatalogMeta = await metaRes.json();
            if (meta && meta.totalPhotos > 0) {
              this.state.catalogMeta = meta;
              this.state.totalCount = meta.totalPhotos;
              this.state.places = (meta.placesSummary as any) || [];
              this.state.selectedFolder = meta.selectedFolder;
              this.state.currentDirectory = meta.currentDirectory;
              this.state.recentLibraries = meta.recentLibraries || [];

              const libraryDirParam = this.state.selectedFolder ? `&libraryDir=${encodeURIComponent(this.state.selectedFolder)}` : '';
              const pageRes = await authFetch(`/api/catalog-page?page=0&size=100${libraryDirParam}`, { signal: AbortSignal.timeout(2000) });
              if (pageRes.ok) {
                const pageData = await pageRes.json();
                if (pageData && pageData.photos && pageData.photos.length > 0) {
                  this.state.photos = pageData.photos;
                  this.stampPersisted(pageData.photos, true);
                  this.currentCatalogPage = 0;
                  try {
                    const libDirParam = this.state.selectedFolder ? `?libraryDir=${encodeURIComponent(this.state.selectedFolder)}` : '';
                    const libRes = await authFetch(`/api/library${libDirParam}`, { signal: AbortSignal.timeout(2000) });
                    if (libRes.ok) {
                      const full = await libRes.json();
                      const libData = full[STORAGE_KEY] || full;
                      if (libData) {
                        this.state.people = libData.people || [];
                        this.state.faces = libData.faces || [];
                        this.state.albums = libData.albums || [];
                      }
                    }
                  } catch {}
                  this.reconcilePeopleAndFaces();
                  this.state.isInitialized = true;
                  this.notifyListeners();
                  // See the matching comment in the Electron fast-path above.
                  this.loadNextCatalogPages(Number.MAX_SAFE_INTEGER);
                  return;
                }
              }
            }
          }
        } catch {}
      }

      // 3. Fallback: Legacy storage loading for unindexed stores
      let data: any = null;
      if (typeof window !== 'undefined' && window.electronAPI) {
        data = await window.electronAPI.loadLibraryData(STORAGE_KEY);
      }

      // Browser fallback: direct fetch from /api/library ONLY if in browser/shim over HTTP
      const isBrowser = typeof window !== 'undefined' && (!window.electronAPI || (window.electronAPI as any).isBrowserShim);
      if (isBrowser && !data && window.location?.protocol?.startsWith('http')) {
        try {
          const res = await authFetch('/api/library', { signal: AbortSignal.timeout(2000) });
          if (res.ok) {
            const full = await res.json();
            data = full[STORAGE_KEY] || (full.photos ? full : null);
          }
        } catch (fetchErr) {
          // Silent catch
        }
      }

      if (!data && typeof localStorage !== 'undefined') {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) data = JSON.parse(raw);
      }

      if (data) {
        const rawPhotos: Photo[] = data.photos || [];
        const dedupedPhotos = deduplicatePhotoList(rawPhotos);

        // Immediately populate state and paint first screen
        this.state.photos = dedupedPhotos;
        this.stampPersisted(dedupedPhotos, true);
        this.state.totalCount = dedupedPhotos.length;
        this.state.people = data.people || [];
        this.state.faces = data.faces || [];
        this.state.albums = data.albums || [];
        const folder = data.selectedFolder || data.currentDirectory || null;
        this.state.selectedFolder = folder;
        this.state.currentDirectory = folder;
        const recent = Array.isArray(data.recentLibraries) ? data.recentLibraries : (folder ? [folder] : []);
        this.state.recentLibraries = recent;
        this.state.places = groupPhotosByPlace(this.state.photos);
        
        // Auto-reconcile people and faces if missing or unassigned
        this.reconcilePeopleAndFaces();

        // Immediate paint for UI responsiveness
        this.notifyListeners();

        // Auto-restore photos if store was empty but folder is configured
        if (this.state.photos.length === 0 && this.state.selectedFolder && typeof window !== 'undefined' && window.electronAPI) {
          try {
            const isMirror = /virtualmirrors/i.test(this.state.selectedFolder);
            if (isMirror && typeof window.electronAPI.scanVirtualMirror === 'function') {
              const restored = await window.electronAPI.scanVirtualMirror(this.state.selectedFolder);
              if (restored && restored.length > 0) {
                this.setPhotos(restored, this.state.selectedFolder);
              }
            } else if (typeof window.electronAPI.scanDirectory === 'function') {
              const restored = await window.electronAPI.scanDirectory(this.state.selectedFolder);
              if (restored && restored.length > 0) {
                this.setPhotos(restored, this.state.selectedFolder);
              }
            }
          } catch (autoLoadErr) {
            console.warn('Auto-loading photos for selected folder failed:', autoLoadErr);
            notifyError('Could not reload photos for the selected folder', autoLoadErr);
          }
        }

        // Defer orphan / deleted file verification to a non-blocking background task
        if (typeof window !== 'undefined' && window.electronAPI?.checkFileExists) {
          setTimeout(() => {
            this.verifyPhotosInBackground();
          }, 1200);
        }
      } else if (this.state.photos.length > 0) {
        this.reconcilePeopleAndFaces();
        this.notifyListeners();
      }
    } catch (err) {
      console.warn('Failed to load library state:', err);
      // Not "an empty library": remember the failure so it is shown and nothing is saved over the real data.
      this.reportLoadFailure(err);
    } finally {
      this.state.isInitialized = true;
      this.notifyListeners();
    }
  }

  /**
   * Switches the active library in <30ms by reading ONLY the target's 20 KB meta + Page 0.
   */
  public async switchLibrary(targetPath: string): Promise<boolean> {
    try {
      if (typeof window !== 'undefined') {
        // Save current library before switching
        await this.flushSaveImmediately();

        const tSwitch0 = performance.now();
        let result: { meta: CatalogMeta; firstPage: Photo[]; albums?: Album[] } | null = null;
        if (window.electronAPI?.switchLibrary) {
          result = await trackBackendCall(window.electronAPI.switchLibrary(targetPath), 'Switching library...');
        } else if (window.location?.protocol?.startsWith('http')) {
          const res = await authFetch('/api/switch-library', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetPath }),
          });
          if (res.ok) result = await res.json();
        }

        if (result && result.meta) {
          const tSwitchEnd = performance.now();
          console.log(`[LIBRARY SWITCH] Switched library to "${targetPath}" in ${(tSwitchEnd - tSwitch0).toFixed(1)}ms. Total photos: ${result.meta.totalPhotos}, Page 0 loaded: ${result.firstPage?.length || 0}`);
          this.state.catalogMeta = result.meta;
          this.state.totalCount = result.meta.totalPhotos;
          this.state.places = (result.meta.placesSummary as any) || [];
          this.state.selectedFolder = targetPath;
          this.state.currentDirectory = targetPath;
          this.state.recentLibraries = result.meta.recentLibraries || [];

          // Restore faces from globalFaceCache for firstPage
          const restoredFirstPage = (result.firstPage || []).map((p) => {
            const cached = this.getCachedFaces(p);
            if (cached) {
              return {
                ...p,
                faces: (cached.faces || []).map((f) => ({ ...f, photoId: p.id })),
                faceScanCompleted: cached.faceScanCompleted,
              };
            }
            return p;
          });

          this.state.photos = restoredFirstPage;
          // Stamp the raw DB rows, not the cache-restored copies, so photos
          // whose restored faces differ from the DB are still re-saved as before.
          this.stampPersisted(result.firstPage || [], true);
          this.currentCatalogPage = 0;
          this.libraryEpoch++;
          this.loadError = null;
          this.pendingRemovedIds.clear();
          // Albums are per-library (unlike people, which are a global
          // registry) — without repopulating this from the just-switched-to
          // library's own data, the PREVIOUS library's albums stayed in
          // memory and the immediate notify(true) save below would overwrite
          // (or empty, if none had loaded yet) this library's real albums
          // with that stale data. See replaceAllAlbums' matching guard for
          // the second layer of protection against this.
          this.state.albums = result.albums || [];
          this.reconcilePeopleAndFaces();
          this.notify(true);
          // See the matching comment in loadPersistedData's fast-path.
          this.loadNextCatalogPages(Number.MAX_SAFE_INTEGER);
          return true;
        }
      }
    } catch (err) {
      console.warn('[LibraryStore] switchLibrary failed:', err);
      // Callers fall back to a full rescan on `false`; say why instead of doing it silently.
      notifyError('Could not switch library', err);
    }
    return false;
  }

  /**
   * Loads several catalog pages ahead in one go (instead of one page per
   * scroll-triggered call), so the buffer stays several screenfuls deep
   * while it's cheap to do so (each page is a fast indexed SQLite read).
   * Stops early once the whole catalog is loaded or another load is
   * already in flight.
   */
  public async loadNextCatalogPages(count: number = 3): Promise<void> {
    // Inside a run the per-page notifications are coalesced (each one regroups/re-renders the whole
    // app: 5000 pages at 500K photos); the run always ends with a final notification.
    this.pageRunDepth++;
    try {
      for (let i = 0; i < count; i++) {
        const loadedMore = await this.loadNextCatalogPage();
        if (!loadedMore) break;
      }
    } finally {
      this.pageRunDepth--;
      if (this.pageRunDepth === 0) this.flushPageNotify();
    }
  }

  /** Notify now if this run hasn't for PAGE_NOTIFY_INTERVAL_MS, otherwise once when the interval is up. */
  private notifyPageLoaded() {
    if (this.pageRunDepth === 0) {
      this.notifyListeners();
      return;
    }
    const wait = this.lastPageNotifyAt + PAGE_NOTIFY_INTERVAL_MS - Date.now();
    if (wait <= 0) {
      this.flushPageNotify(true);
    } else {
      this.pageNotifyPending = true;
      if (!this.pageNotifyTimer) this.pageNotifyTimer = setTimeout(() => this.flushPageNotify(), wait);
    }
  }

  private flushPageNotify(force = false) {
    if (this.pageNotifyTimer) {
      clearTimeout(this.pageNotifyTimer);
      this.pageNotifyTimer = null;
    }
    if (!force && !this.pageNotifyPending) return;
    this.pageNotifyPending = false;
    this.lastPageNotifyAt = Date.now();
    this.notifyListeners();
  }

  /**
   * Seamlessly loads the next 100-photo catalog page as the user scrolls.
   * Returns whether a page was actually loaded (false if already loading,
   * or the whole catalog is already loaded).
   */
  public async loadNextCatalogPage(): Promise<boolean> {
    if (this.isLoadingCatalogPage || !this.state.catalogMeta) return false;
    if (this.currentCatalogPage + 1 >= this.state.catalogMeta.totalPages) return false;

    this.isLoadingCatalogPage = true;
    try {
      // The page index only advances once the page has actually been appended —
      // bumping it up-front skipped 100 photos for good after any failed fetch.
      const pageIndex = this.currentCatalogPage + 1;
      const epoch = this.libraryEpoch;
      let newPhotos: Photo[] = [];
      // Always pass the currently active library explicitly — omitting it
      // relies on the main process still having the right library active
      // from whenever it was last switched, which isn't guaranteed once
      // other catalog calls may have run in between.
      const libraryDir = this.state.selectedFolder || this.state.currentDirectory || undefined;

      if (window.electronAPI?.getCatalogPage) {
        const res = await trackBackendCall(
          window.electronAPI.getCatalogPage({ pageIndex, libraryDir }),
          'Loading photos...'
        );
        if (res && res.photos) newPhotos = res.photos;
      } else if (window.location?.protocol?.startsWith('http')) {
        const libraryDirParam = libraryDir ? `&libraryDir=${encodeURIComponent(libraryDir)}` : '';
        const res = await authFetch(`/api/catalog-page?page=${pageIndex}&size=100${libraryDirParam}`);
        if (res.ok) {
          const data = await res.json();
          if (data && data.photos) newPhotos = data.photos;
        }
      }

      // The library was switched/reloaded while this page was in flight: its photos
      // belong to the old library. Drop them; returning true lets the caller's loop
      // carry on loading the NEW library's pages (its own loop bailed on isLoadingCatalogPage).
      if (epoch !== this.libraryEpoch) return true;

      if (newPhotos.length > 0) {
        this.currentCatalogPage = pageIndex;
        this.appendCatalogPage(newPhotos);
        this.stampPersisted(newPhotos);
        this.notifyPageLoaded();
        return true;
      }
      return false;
    } catch (err) {
      console.warn('[LibraryStore] Failed loading next catalog page:', err);
      notifyError('Could not load more photos', err);
      return false;
    } finally {
      this.isLoadingCatalogPage = false;
    }
  }

  private photoKeyCache: { arr: Photo[]; keys: Set<string> } | null = null;

  /**
   * Appends a catalog page without re-deduplicating the whole library (that was
   * O(N) per 100-photo page, O(N^2) overall). Only falls back to the full
   * deduplicatePhotoList when the page actually collides with what's loaded.
   */
  private appendCatalogPage(newPhotos: Photo[]) {
    const keyOf = (p: Photo) => (p.originalRemotePath || p.filePath || '').toLowerCase().replace(/\\/g, '/');
    const cache = this.photoKeyCache;
    const keys = cache && cache.arr === this.state.photos ? cache.keys : new Set(this.state.photos.map(keyOf));
    const batch = new Set<string>();
    let collides = false;
    for (const p of newPhotos) {
      const k = keyOf(p);
      if (!k || keys.has(k) || batch.has(k)) {
        collides = true;
        break;
      }
      batch.add(k);
    }
    if (collides) {
      this.state.photos = deduplicatePhotoList([...this.state.photos, ...newPhotos]);
      this.photoKeyCache = null;
      return;
    }
    batch.forEach((k) => keys.add(k));
    this.state.photos = this.state.photos.concat(newPhotos);
    this.photoKeyCache = { arr: this.state.photos, keys };
  }

  /**
   * Background non-blocking file existence verification.
   * Checks files in small slices of 20 with 40ms event loop yields,
   * checking local mirror files first to avoid network timeouts.
   */
  private async verifyPhotosInBackground() {
    if (this.isVerifyingInBackground || !window.electronAPI?.checkFileExists) return;
    this.isVerifyingInBackground = true;

    try {
      const currentPhotos = [...this.state.photos];
      if (currentPhotos.length === 0) return;

      const verified: Photo[] = [];
      const batchSize = 20;

      for (let i = 0; i < currentPhotos.length; i += batchSize) {
        const slice = currentPhotos.slice(i, i + batchSize);
        for (const p of slice) {
          // For virtual network mirrors, always check local mirrored thumbnail path first
          const localCheckPath = p.filePath;
          if (localCheckPath) {
            const exists = await window.electronAPI.checkFileExists(localCheckPath);
            if (exists) {
              verified.push(p);
              continue;
            }
          }
          // If not virtual or local check failed, check original path
          if (p.originalRemotePath && !p.isVirtual) {
            const exists = await window.electronAPI.checkFileExists(p.originalRemotePath);
            if (exists) {
              verified.push(p);
              continue;
            }
          } else if (p.filePath) {
            verified.push(p); // retain if cannot determine
          }
        }

        // Non-blocking yield to keep UI at 60fps
        await new Promise((r) => setTimeout(r, 40));
      }

      if (verified.length > 0 && verified.length !== currentPhotos.length) {
        console.log(`Pruned ${currentPhotos.length - verified.length} unreachable or removed photos in background.`);
        this.state.photos = verified;
        this.state.places = groupPhotosByPlace(verified);
        this.notify();
      }
    } catch (err) {
      console.warn('Background photo verification error:', err);
    } finally {
      this.isVerifyingInBackground = false;
    }
  }

  private savePersistedData(): Promise<void> {
    // doSave never rejects (it reports its own failures), so the chain can't wedge.
    this.saveChain = this.saveChain.then(() => this.doSave());
    return this.saveChain;
  }

  private async doSave() {
    if (this.loadError) {
      // Memory is not the user's library (load failed): saving would overwrite the real one.
      notifyError('Changes are not being saved because your library failed to load', this.loadError);
      return;
    }
    try {
      // Safety guard: if photos contain faces but people is empty, reconcile first
      if (this.state.people.length === 0 && this.state.photos.some((p) => p.faces && p.faces.length > 0)) {
        this.reconcilePeopleAndFaces();
      }

      // When the SQLite catalog fast-path is active, this.state.photos is
      // usually only a PARTIAL view — whatever catalog pages have been
      // loaded so far (starts at just the first 100). Telling the main
      // process this is the complete library, and having it destructively
      // replace the library's full photo set with just that partial view,
      // silently deleted every not-yet-loaded photo from SQLite the moment
      // any save fired (e.g. immediately after switching libraries, or
      // toggling one favorite) — this is what made libraries randomly
      // appear "stuck" at whatever count happened to be loaded at the time.
      const isPartialPageSet =
        !!this.state.catalogMeta &&
        this.state.photos.length < (this.state.catalogMeta.totalPhotos || 0);

      // People + face cache are large and rarely change on a given autosave;
      // re-sending them every time froze the main process for ~19s (sync
      // DELETE+reinsert of every person, plus a 20K-entry JSON blob write).
      // Only send when a cheap content signature differs from the last
      // successful save. ponytail: signature ignores in-place face edits that
      // leave counts unchanged; upgrade to a dirty flag if that ever matters.
      const peopleSig = this.peopleSigOf(this.state.people);
      // While the registry failed to load, state.people is not the real registry: never send it.
      const peopleChanged = !this.peopleLoadFailed && peopleSig !== this.lastSavedPeopleSig;
      if (this.peopleLoadFailed) {
        notifyError('People are not being saved because the people registry failed to load — restart the app', this.loadError ?? 'people registry load failed');
      }

      // Photos: send only the ones whose signature changed since the last
      // successful save, as a merge-only upsert (never deletes). Sending the
      // whole 24K-photo library (with ~27K face descriptors) on every edit
      // froze main for 10-26s. Falls back to the full payload (today's
      // behavior) when there's no baseline yet or a photo left the set —
      // removals still need replaceAllPhotos to delete the missing rows.
      // One pass over the photos: per-object cached signature (no string building for an unchanged
      // object), compared straight against the baseline, so no 100k-entry signature map per save.
      const baseline = this.savedPhotoSigs;
      const scan = this.scanPhotos();
      // A photo that left the set normally needs replaceAllPhotos to delete its row — except one the user
      // removed via removePhotos: its id travels in removedIds, so it can stay an incremental merge.
      const incremental = !!baseline && scan.removed.every((id) => this.pendingRemovedIds.has(id));
      const photosToSend = incremental ? scan.changed : this.state.photos;
      // Full-payload case: the new baseline is every current photo's signature (as of now, pre-await).
      const fullBaseline = incremental ? null : new Map(this.state.photos.map((p) => [p.id, this.photoSig(p)] as [string, string]));

      const dataToSave = {
        photos: photosToSend,
        isPartialPageSet: incremental ? true : isPartialPageSet,
        // main only upserts people when non-empty, so [] skips that work
        people: peopleChanged ? this.state.people : [],
        albums: this.state.albums,
        selectedFolder: this.state.selectedFolder,
        recentLibraries: this.state.recentLibraries,
        // Photos the user deleted: lets main delete their rows even when only a partial page set is loaded.
        removedIds: this.pendingRemovedIds.size > 0 ? Array.from(this.pendingRemovedIds) : undefined,
      };
      const sentRemovedIds = dataToSave.removedIds;

      logger.debug('libraryStore', 'savePersistedData: debounced autosave firing', {
        isPartialPageSet: dataToSave.isPartialPageSet,
        incremental,
        photosSent: photosToSend.length,
        photoCount: this.state.photos.length,
        peopleCount: this.state.people.length,
      });

      if (typeof window !== 'undefined' && window.electronAPI && typeof window.electronAPI.saveLibraryData === 'function') {
        // main resolves false (it doesn't throw) when the write failed — treat that as a failure,
        // and only advance the "already saved" baseline once the write really happened.
        if ((await window.electronAPI.saveLibraryData(STORAGE_KEY, dataToSave)) === false) {
          throw new Error('The library database rejected the save');
        }
        if (this.savedPhotoSigs === baseline) {
          if (fullBaseline) {
            this.savedPhotoSigs = fullBaseline;
          } else if (baseline) {
            scan.changed.forEach((p, i) => baseline.set(p.id, scan.changedSigs[i]));
            scan.removed.forEach((id) => baseline.delete(id));
          }
        }
        sentRemovedIds?.forEach((id) => this.pendingRemovedIds.delete(id));
        if (peopleChanged) {
          if ((await window.electronAPI.saveLibraryData(GLOBAL_PEOPLE_KEY, this.state.people)) === false) {
            throw new Error('The people database rejected the save');
          }
          this.lastSavedPeopleSig = peopleSig;
        }
      } else if (typeof localStorage !== 'undefined') {
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({ ...dataToSave, photos: this.state.photos, people: this.state.people, faces: this.state.faces })
        );
        if (!this.peopleLoadFailed) localStorage.setItem(GLOBAL_PEOPLE_KEY, JSON.stringify(this.state.people));
      }
      this.saveFailures = 0;
    } catch (err) {
      console.warn('Failed to save library state:', err);
      notifyError('Could not save your library', err);
      // Nothing was marked saved, so the next attempt re-sends the same changes.
      if (this.saveFailures < 5 && !this.saveDebounceTimer) {
        this.scheduleDebouncedSave(Math.min(30000, 2000 * 2 ** this.saveFailures));
      }
      this.saveFailures++;
    }
  }

  private peopleSigOf(people: Person[]): string {
    return people.map((p) => `${p.id}:${p.name}:${p.faceCount}:${p.photoCount}:${p.coverFaceId}`).join('|');
  }

  /** Cached entry for this Photo object; `verify` re-derives the signature from its content instead of trusting the guard. */
  private sigEntry(p: Photo, verify = false): SigEntry {
    let e = this.sigEntries.get(p);
    if (e !== undefined && sigEntryMatches(e, p) && (!verify || computePhotoSig(p) === e.sig)) return e;
    e = makeSigEntry(p);
    this.sigEntries.set(p, e);
    return e;
  }

  /** Content signature over every persisted photo field + face identity (not descriptors); cached per Photo object. */
  private photoSig(p: Photo): string {
    return this.sigEntry(p).sig;
  }

  /**
   * One pass over state.photos for a save (or the blur audit): which photos differ from the saved baseline,
   * and which baseline ids are gone. Also mirrors faces into the session face cache once per new/changed object.
   * Every FULL_RESIGN_EVERY-th scan, after a face edit that bypasses the cache, and on blur/unload it
   * re-signs everything, so an in-place edit the cheap guard missed still reaches the database.
   */
  private scanPhotos(): { changed: Photo[]; changedSigs: string[]; removed: string[]; dirty: boolean } {
    const verify = this.forceFullResign || ++this.savesSinceFullResign >= FULL_RESIGN_EVERY;
    if (verify) {
      this.forceFullResign = false;
      this.savesSinceFullResign = 0;
    }
    const baseline = this.savedPhotoSigs;
    const changed: Photo[] = [];
    const changedSigs: string[] = [];
    const removed: string[] = [];
    const seen = new Set<string>();
    for (const p of this.state.photos) {
      const e = this.sigEntry(p, verify);
      if (!e.fc) {
        e.fc = true;
        if (p.faceScanCompleted || (p.faces && p.faces.length > 0)) this.cachePhotoFaces(p, p.faces || [], p.faceScanCompleted);
      }
      if (baseline) {
        const b = baseline.get(p.id);
        if (b !== undefined) seen.add(p.id);
        if (b !== e.sig) {
          changed.push(p);
          changedSigs.push(e.sig);
        }
      }
    }
    if (baseline && seen.size < baseline.size) {
      for (const id of baseline.keys()) if (!seen.has(id)) removed.push(id);
    }
    return { changed, changedSigs, removed, dirty: !!baseline && (changed.length > 0 || removed.length > 0) };
  }

  /**
   * Records photos that just came FROM the database as already-persisted, so
   * the next autosave doesn't re-send them. `reset` starts a fresh baseline
   * (library switch / first load); otherwise it only adds entries.
   */
  private stampPersisted(photos: Photo[], reset = false) {
    if (reset || !this.savedPhotoSigs) this.savedPhotoSigs = new Map();
    for (const p of photos) this.savedPhotoSigs.set(p.id, this.photoSig(p));
  }

  public async persistNow(): Promise<void> {
    return this.savePersistedData();
  }

  public setPhotos(photos: Photo[], folderPath?: string): Photo[] {
    // Deduplicate incoming photos first
    const cleanNew = deduplicatePhotoList(photos);

    // Map existing photos by normalized path and ID to seamlessly preserve faces, tags & favorites
    const existingPathMap = new Map<string, Photo>();
    for (const p of this.state.photos) {
      const k = (p.originalRemotePath || p.filePath || '').toLowerCase().replace(/\\/g, '/');
      if (k) existingPathMap.set(k, p);
      if (p.id) existingPathMap.set(p.id, p);
    }

    const preserved = cleanNew.map((newPhoto) => {
      const key = (newPhoto.originalRemotePath || newPhoto.filePath || '').toLowerCase().replace(/\\/g, '/');
      const existing = existingPathMap.get(key) || existingPathMap.get(newPhoto.id);
      const cached = this.getCachedFaces(newPhoto);

      let faces = (newPhoto.faces && newPhoto.faces.length > 0) ? newPhoto.faces : undefined;
      let faceScanCompleted = Boolean(newPhoto.faceScanCompleted);

      if (existing) {
        const candidateFaces = (faces && faces.length > 0) ? faces : existing.faces;
        faces = (candidateFaces || []).map((f) => ({ ...f, photoId: newPhoto.id }));
        faceScanCompleted = Boolean(faceScanCompleted || existing.faceScanCompleted || (faces && faces.length > 0));
      } else if (cached) {
        if (!faces || faces.length === 0) {
          faces = (cached.faces || []).map((f) => ({ ...f, photoId: newPhoto.id }));
        }
        faceScanCompleted = Boolean(faceScanCompleted || cached.faceScanCompleted || (faces && faces.length > 0));
      }

      if (faces && faces.length > 0) {
        this.cachePhotoFaces(newPhoto, faces, faceScanCompleted);
      }

      // A rescan/resync builds a fresh Photo record from disk metadata alone
      // (e.g. scanVirtualMirrorDirectory's sidecar JSON), which never carries
      // this flag — without preserving it from the existing in-memory
      // record, a re-sync would silently un-verify a photo the user had
      // already manually curated, letting the next auto face-scan pass
      // touch it again.
      const facesLocked = newPhoto.facesLocked ?? existing?.facesLocked ?? false;

      return {
        ...newPhoto,
        isFavorite: newPhoto.isFavorite ?? existing?.isFavorite ?? false,
        faces,
        faceScanCompleted: Boolean(faceScanCompleted || (faces && faces.length > 0)),
        facesLocked,
        location: newPhoto.location || existing?.location,
        isExcluded: newPhoto.isExcluded ?? existing?.isExcluded,
        sharpnessScore: newPhoto.sharpnessScore ?? existing?.sharpnessScore,
      };
    });

    const finalDeduped = deduplicatePhotoList(preserved);
    this.state.photos = finalDeduped;
    // The photo set was replaced wholesale (open/scan): an earlier load failure no longer
    // makes this state untrustworthy, and page loads still in flight belong to the old set.
    this.libraryEpoch++;
    this.loadError = null;
    this.state.totalCount = finalDeduped.length;

    if (folderPath) {
      this.state.selectedFolder = folderPath;
      this.state.currentDirectory = folderPath;
      this.addRecentLibrary(folderPath);
    }
    this.state.places = groupPhotosByPlace(finalDeduped);
    this.reconcilePeopleAndFaces();
    this.notify();

    if (typeof window !== 'undefined' && window.electronAPI?.startThumbnailPreCache) {
      window.electronAPI.startThumbnailPreCache(finalDeduped).catch(() => {});
    }

    return finalDeduped;
  }

  public addPhotos(newPhotos: Photo[]) {
    // Only the new photos are checked against the loaded set (full dedupe only on a collision),
    // and each date is parsed once instead of twice per sort comparison.
    this.appendCatalogPage(newPhotos);
    const times = new Map<Photo, number>();
    const timeOf = (p: Photo) => {
      let t = times.get(p);
      if (t === undefined) {
        t = new Date(p.dateTaken).getTime();
        if (!Number.isFinite(t)) t = 0;
        times.set(p, t);
      }
      return t;
    };
    const deduped = this.state.photos.slice().sort((a, b) => timeOf(b) - timeOf(a));
    this.state.photos = deduped;
    this.photoKeyCache = null;
    this.state.places = groupPhotosByPlace(deduped);
    this.reconcilePeopleAndFaces();
    this.notify();

    if (typeof window !== 'undefined' && window.electronAPI?.startThumbnailPreCache && newPhotos.length > 0) {
      window.electronAPI.startThumbnailPreCache(newPhotos).catch(() => {});
    }
  }

  public addRecentLibrary(folderPath: string) {
    if (!folderPath) return;
    const current = this.state.recentLibraries || [];
    const normalized = folderPath.trim();
    const filtered = current.filter((f) => f.toLowerCase() !== normalized.toLowerCase());
    this.state.recentLibraries = [normalized, ...filtered].slice(0, 10);
    this.notify();
  }

  /** Replaces the recent-libraries list outright — used to drop entries whose folder no longer exists. */
  public setRecentLibraries(list: string[]) {
    this.state.recentLibraries = list;
    this.notify(true);
  }

  public getRecentLibraries(): string[] {
    return this.state.recentLibraries || [];
  }

  public toggleFavorite(photoId: string) {
    // Replaces the Photo object and the array instead of flipping the flag in place: PhotoCard is
    // memoized on prev.photo.isFavorite vs next.photo.isFavorite (the same object once mutated, so the
    // heart never updated) and GalleryView's useMemo([photos]) keeps serving the old list.
    const idx = this.state.photos.findIndex((p) => p.id === photoId);
    if (idx >= 0) {
      const photos = this.state.photos.slice();
      photos[idx] = { ...photos[idx], isFavorite: !photos[idx].isFavorite };
      this.state.photos = photos;
      this.notify();
    }
  }

  public excludePhotos(photoIds: string[], exclude = true) {
    const idSet = new Set(photoIds);
    let changed = false;
    // New objects + new array for the touched photos (see toggleFavorite for why not in place).
    const photos = this.state.photos.map((photo) => {
      if (!idSet.has(photo.id)) return photo;
      changed = true;
      return { ...photo, isExcluded: exclude };
    });
    if (changed) {
      this.state.photos = photos;
      this.state.places = groupPhotosByPlace(this.state.photos.filter((p) => !p.isExcluded));
      this.notify();
    }
  }

  public updatePhotoQuietly(updatedPhoto: Photo) {
    const idx = this.state.photos.findIndex((p) => p.id === updatedPhoto.id || p.filePath === updatedPhoto.filePath);
    if (idx >= 0) {
      this.photoIndexCache = null; // object at idx is replaced in place
      this.state.photos[idx] = { ...this.state.photos[idx], ...updatedPhoto };
    }
  }

  public updatePhoto(updatedPhoto: Photo, recalculatePlaces = false) {
    const idx = this.state.photos.findIndex((p) => p.id === updatedPhoto.id || p.filePath === updatedPhoto.filePath);
    let locationChanged = recalculatePlaces;
    if (idx >= 0) {
      this.photoIndexCache = null; // object at idx is replaced in place
      if (updatedPhoto.location && JSON.stringify(updatedPhoto.location) !== JSON.stringify(this.state.photos[idx].location)) {
        locationChanged = true;
      }
      // New array too, so memoized views keyed on the photos array (GalleryView) see the change.
      const photos = this.state.photos.slice();
      photos[idx] = { ...photos[idx], ...updatedPhoto };
      this.state.photos = photos;
    }
    if (locationChanged) {
      this.state.places = groupPhotosByPlace(this.state.photos.filter((p) => !p.isExcluded));
    }
    this.notify();
  }

  /** Merges each entry over the current photo with the same id — partial patches are fine (and preferred). */
  public updatePhotos(updatedList: Array<Partial<Photo> & { id: string }>, recalculatePlaces = false) {
    const map = new Map(updatedList.map((p) => [p.id, p]));
    let locationChanged = recalculatePlaces;
    this.state.photos = this.state.photos.map((p) => {
      const u = map.get(p.id);
      if (u) {
        if (u.location && JSON.stringify(u.location) !== JSON.stringify(p.location)) {
          locationChanged = true;
        }
        return { ...p, ...u };
      }
      return p;
    });
    if (locationChanged) {
      this.state.places = groupPhotosByPlace(this.state.photos.filter((p) => !p.isExcluded));
    }
    this.notify();
  }

  public removePhotos(photoIds: string[]) {
    const idSet = new Set(photoIds);
    const countBefore = this.state.photos.length;
    this.state.photos = this.state.photos.filter((p) => !idSet.has(p.id));
    // Without this, photos.length < catalogMeta.totalPhotos forever after a delete, so every
    // later save was sent as a merge-only "partial page set" and the deleted rows stayed in the DB.
    const removedLoaded = countBefore - this.state.photos.length;
    if (this.state.catalogMeta && removedLoaded > 0) {
      this.state.catalogMeta = {
        ...this.state.catalogMeta,
        totalPhotos: Math.max(0, (this.state.catalogMeta.totalPhotos || 0) - removedLoaded),
      };
    }
    photoIds.forEach((id) => this.pendingRemovedIds.add(id));
    this.state.totalCount = Math.max(0, (this.state.totalCount || this.state.photos.length) - photoIds.length);
    this.state.faces = this.state.faces.filter((f) => !idSet.has(f.photoId));
    this.state.places = groupPhotosByPlace(this.state.photos.filter((p) => !p.isExcluded));

    // Update people identities and cover photos safely without losing names
    const remainingFaces = this.state.faces;
    const personFacesMap = new Map<string, DetectedFace[]>();
    const personPhotosMap = new Map<string, Set<string>>();
    for (const p of this.state.people) {
      personFacesMap.set(p.id, []);
      personPhotosMap.set(p.id, new Set());
    }

    for (const f of remainingFaces) {
      if (f.personId && personFacesMap.has(f.personId)) {
        personFacesMap.get(f.personId)!.push(f);
        personPhotosMap.get(f.personId)!.add(f.photoId);
      }
    }

    for (const person of this.state.people) {
      const faces = personFacesMap.get(person.id) || [];
      const photos = personPhotosMap.get(person.id) || new Set();
      person.faceCount = faces.length;
      person.photoCount = photos.size;

      // If the deleted photo was the cover photo, pick another remaining photo that contains their face
      if (person.coverPhotoId && idSet.has(person.coverPhotoId)) {
        if (faces.length > 0) {
          person.coverFaceId = faces[0].id;
          person.coverPhotoId = faces[0].photoId;
        } else {
          // No remaining photos for this person in this library; keep custom name but clear broken cover reference
          person.coverFaceId = undefined;
          person.coverPhotoId = undefined;
        }
      }
    }

    this.notify(true);
  }

  public updatePersonName(
    personId: string,
    newName: string
  ): { success: boolean; merged?: boolean; error?: string; targetPersonName?: string; conflictPhoto?: Photo } {
    const cleanName = newName.trim();
    if (!cleanName) {
      return { success: false, error: 'Person name cannot be empty' };
    }

    const person = this.state.people.find((p) => p.id === personId);
    if (!person) {
      return { success: false, error: 'Person not found' };
    }

    if (person.name === cleanName) {
      return { success: true };
    }

    // Check if another person already has this exact name (case-insensitive)
    const existingPerson = this.state.people.find(
      (p) => p.id !== personId && p.name.toLowerCase() === cleanName.toLowerCase()
    );

    if (existingPerson) {
      // Check if they can be merged without single-photo conflict
      const canMerge = this.canMergePeople(existingPerson.id, personId);
      if (canMerge.canMerge) {
        this.mergePeople(existingPerson.id, personId, cleanName);
        return { success: true, merged: true, targetPersonName: existingPerson.name };
      } else {
        return {
          success: false,
          error: `Cannot rename to "${cleanName}": A person named "${cleanName}" already exists, and both people appear together in photo "${canMerge.conflictPhotoName}". One photo cannot have two faces of the same person.`,
          conflictPhoto: canMerge.conflictPhoto,
        };
      }
    }

    person.name = cleanName;
    this.globalPeopleRegistry.set(person.id, { ...person });
    this.state.people = [...this.state.people];
    this.notify(true);
    return { success: true };
  }

  public canMergePeople(
    personId1: string,
    personId2: string
  ): { canMerge: boolean; conflictPhoto?: Photo; conflictPhotoName?: string } {
    for (const photo of this.state.photos) {
      const hasP1 = photo.faces?.some((f) => f.personId === personId1);
      const hasP2 = photo.faces?.some((f) => f.personId === personId2);
      if (hasP1 && hasP2) {
        return { canMerge: false, conflictPhoto: photo, conflictPhotoName: photo.fileName };
      }
    }
    return { canMerge: true };
  }

  public resetAllPeopleAndFaces() {
    this.state.people = [];
    this.state.faces = [];
    this.globalPeopleRegistry.clear();
    this.globalFaceCache.clear();
    for (const photo of this.state.photos) {
      photo.faces = [];
      photo.faceScanCompleted = false;
    }
    this.notify(true);
  }

  public propagateLearnedFaces(
    personId: string,
    options?: { matchThreshold?: number }
  ): { newlyAssignedCount: number; affectedPhotosCount: number } {
    // 1. Gather all faces belonging to this person across state.faces and photo.faces
    const personFaces: DetectedFace[] = [];
    const seenFaceIds = new Set<string>();

    for (const f of this.state.faces) {
      if (f.personId === personId && f.descriptor && f.descriptor.length > 0) {
        if (!seenFaceIds.has(f.id)) {
          seenFaceIds.add(f.id);
          personFaces.push(f);
        }
      }
    }

    for (const photo of this.state.photos) {
      if (photo.faces) {
        for (const f of photo.faces) {
          if (f.personId === personId && f.descriptor && f.descriptor.length > 0) {
            if (!seenFaceIds.has(f.id)) {
              seenFaceIds.add(f.id);
              personFaces.push(f);
            }
          }
        }
      }
    }

    if (personFaces.length === 0) return { newlyAssignedCount: 0, affectedPhotosCount: 0 };

    let targetPerson = this.state.people.find((p) => p.id === personId);
    if (!targetPerson) {
      targetPerson = {
        id: personId,
        name: 'Person',
        faceCount: personFaces.length,
        photoCount: 1,
        coverFaceId: personFaces[0]?.id,
        coverPhotoId: personFaces[0]?.photoId,
        createdAt: new Date().toISOString(),
      };
      this.state.people.push(targetPerson);
    }

    const centroid = computeQualityWeightedCentroid(personFaces);
    if (!centroid || centroid.length === 0) return { newlyAssignedCount: 0, affectedPhotosCount: 0 };

    const threshold = options?.matchThreshold ?? 0.42;
    let newlyAssignedCount = 0;
    const affectedPhotoIds = new Set<string>();

    for (const photo of this.state.photos) {
      if (!photo.faces || photo.faces.length === 0) continue;

      // RULE: Single-photo uniqueness! If personId already in photo, skip
      const alreadyInPhoto = photo.faces.some((f) => f.personId === personId);
      if (alreadyInPhoto) continue;

      let bestCandidate: DetectedFace | null = null;
      let minDistance = Infinity;

      for (const face of photo.faces) {
        // Only evaluate unassigned faces (or unconfirmed auto-detections)
        if (face.personId && face.isConfirmed) continue;
        if (!face.descriptor || face.descriptor.length === 0) continue;

        const cosDist = cosineDistance(face.descriptor, centroid);
        const euclDist = euclideanDistance(face.descriptor, centroid);
        const dist = Math.min(cosDist, euclDist);

        if (dist < minDistance) {
          minDistance = dist;
          if (dist < threshold) {
            bestCandidate = face;
          }
        }
      }

      if (bestCandidate) {
        bestCandidate.personId = personId;
        bestCandidate.isConfirmed = false;
        newlyAssignedCount++;
        affectedPhotoIds.add(photo.id);

        const globalFace = this.state.faces.find((f) => f.id === bestCandidate!.id);
        if (globalFace) {
          globalFace.personId = personId;
          globalFace.isConfirmed = false;
        } else {
          this.state.faces.push(bestCandidate);
        }
      }
    }

    if (newlyAssignedCount > 0) {
      const { people, updatedFaces } = this.cluster(this.state.faces, this.state.people, DEFAULT_MATCH_THRESHOLD, false);
      this.state.people = people;
      this.state.faces = updatedFaces;
      this.notify();
    }

    return { newlyAssignedCount, affectedPhotosCount: affectedPhotoIds.size };
  }

  public mergePeople(targetPersonId: string, sourcePersonId: string, preferredName?: string): boolean {
    if (targetPersonId === sourcePersonId) return false;

    const check = this.canMergePeople(targetPersonId, sourcePersonId);
    if (!check.canMerge) {
      return false;
    }

    const targetPerson = this.state.people.find((p) => p.id === targetPersonId);
    if (!targetPerson) return false;

    if (preferredName && preferredName.trim()) {
      targetPerson.name = preferredName.trim();
    }

    // Update all faces belonging to sourcePersonId to targetPersonId
    for (const face of this.state.faces) {
      if (face.personId === sourcePersonId) {
        face.personId = targetPersonId;
        face.isConfirmed = true;
      }
    }

    for (const photo of this.state.photos) {
      if (photo.faces) {
        for (const face of photo.faces) {
          if (face.personId === sourcePersonId) {
            face.personId = targetPersonId;
            face.isConfirmed = true;
          }
        }
      }
    }

    // Re-cluster / recalculate
    const { people, updatedFaces } = this.cluster(
      this.state.faces,
      this.state.people.filter((p) => p.id !== sourcePersonId)
    );
    this.state.people = people;
    this.state.faces = updatedFaces;
    this.notify();
    return true;
  }

  public addPerson(name: string): Person {
    const clean = name.trim();
    const existing = this.state.people.find((p) => p.name.toLowerCase() === clean.toLowerCase());
    if (existing) return existing;
    const newPerson: Person = {
      id: `person_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
      name: clean,
      faceCount: 0,
      photoCount: 0,
      createdAt: new Date().toISOString(),
    };
    this.state.people = [...this.state.people, newPerson];
    this.notify();
    return newPerson;
  }

  public reassignFaceToPerson(
    faceId: string,
    targetPersonIdOrName: string
  ): { success: boolean; error?: string; propagation?: { newlyAssignedCount: number; affectedPhotosCount: number } } {
    const face = this.state.faces.find((f) => f.id === faceId);
    if (!face) {
      return { success: false, error: 'Face detection not found' };
    }

    const photo = this.state.photos.find((p) => p.id === face.photoId);
    if (!photo) {
      return { success: false, error: 'Associated photo not found' };
    }

    const cleanInput = targetPersonIdOrName.trim();
    if (!cleanInput) {
      return { success: false, error: 'Person name cannot be empty' };
    }

    // Check if target is an existing person (by ID or by name)
    let targetPerson = this.state.people.find(
      (p) => p.id === cleanInput || p.name.toLowerCase() === cleanInput.toLowerCase()
    );

    if (targetPerson) {
      // Check constraint: Is targetPerson already in this same photo?
      const alreadyInPhoto = photo.faces?.some(
        (f) => f.id !== faceId && f.personId === targetPerson!.id
      );
      if (alreadyInPhoto) {
        return {
          success: false,
          error: `Cannot reassign: "${targetPerson.name}" is already identified in this photo. One photo cannot contain two faces of the same person.`,
        };
      }

      face.personId = targetPerson.id;
      face.isConfirmed = true;
    } else {
      // Create new Person
      const newPersonId = `person_${Date.now()}`;
      targetPerson = {
        id: newPersonId,
        name: cleanInput,
        coverFaceId: face.id,
        coverPhotoId: face.photoId,
        faceCount: 0,
        photoCount: 0,
        createdAt: new Date().toISOString(),
      };
      this.state.people.push(targetPerson);
      face.personId = targetPerson.id;
      face.isConfirmed = true;
    }

    // Update photo's face reference
    if (photo.faces) {
      const pf = photo.faces.find((f) => f.id === faceId);
      if (pf) {
        pf.personId = face.personId;
        pf.isConfirmed = true;
      }
    }

    // Re-cluster and recalculate face and photo counts
    const { people, updatedFaces } = this.cluster(this.state.faces, this.state.people);
    this.state.people = people;
    this.state.faces = updatedFaces;
    this.recomputeFacesLockedForPhoto(face.photoId);
    this.notify();

    // Propagate learned manual input to improve face detection across other photos!
    const propagation = this.propagateLearnedFaces(targetPerson.id);

    return { success: true, propagation };
  }

  public unassignFaceFromPerson(faceId: string): { success: boolean; photoName?: string; personName?: string } {
    let unassigned = false;
    let photoName: string | undefined;
    let personName: string | undefined;
    let affectedPhotoId: string | undefined;

    // 1. Unassign in state.faces
    for (const f of this.state.faces) {
      if (f.id === faceId) {
        if (f.personId) {
          const person = this.state.people.find((p) => p.id === f.personId);
          if (person) personName = person.name;
        }
        f.personId = undefined;
        f.isConfirmed = false;
        unassigned = true;
        affectedPhotoId = f.photoId;
      }
    }

    // 2. Immutably update photos array so React triggers immediate re-renders
    this.state.photos = this.state.photos.map((photo) => {
      if (photo.faces && photo.faces.some((f) => f.id === faceId)) {
        photoName = photo.fileName;
        if (!personName) {
          const matchingFace = photo.faces.find((f) => f.id === faceId);
          if (matchingFace?.personId) {
            const p = this.state.people.find((item) => item.id === matchingFace.personId);
            if (p) personName = p.name;
          }
        }
        unassigned = true;
        return {
          ...photo,
          faces: photo.faces.map((f) =>
            f.id === faceId ? { ...f, personId: undefined, isConfirmed: false } : f
          ),
        };
      }
      return photo;
    });

    if (unassigned) {
      // Re-calculate people without creating unwanted new clusters for unassigned faces
      const { people, updatedFaces } = this.cluster(this.state.faces, this.state.people, DEFAULT_MATCH_THRESHOLD, false);
      this.state.people = people;
      this.state.faces = updatedFaces;
      if (affectedPhotoId) {
        this.recomputeFacesLockedForPhoto(affectedPhotoId);
      }
      this.savePersistedData();
      this.notify();
    }

    return { success: unassigned, photoName, personName };
  }

  public confirmFace(faceId: string): { newlyAssignedCount: number; affectedPhotosCount: number } {
    let face = this.state.faces.find((f) => f.id === faceId);
    if (!face) {
      for (const photo of this.state.photos) {
        const pf = photo.faces?.find((f) => f.id === faceId);
        if (pf) {
          face = pf;
          this.state.faces.push(pf);
          break;
        }
      }
    }

    let propagation = { newlyAssignedCount: 0, affectedPhotosCount: 0 };
    if (face) {
      face.isConfirmed = true;
      for (const photo of this.state.photos) {
        const photoFace = photo.faces?.find((f) => f.id === faceId);
        if (photoFace) {
          photoFace.isConfirmed = true;
          this.touch(photo); // nested edit: the cached signature no longer matches
        }
      }
      this.recomputeFacesLockedForPhoto(face.photoId);
      this.notify();

      // Active learning: User confirmation anchors ground truth with 2.5x weight in centroid.
      // Automatically scan unassigned/unconfirmed library photos to improve recognition!
      if (face.personId) {
        propagation = this.propagateLearnedFaces(face.personId);
      }
    }
    return propagation;
  }

  /**
   * A photo was physically rotated `degrees` clockwise (its local thumbnail now, its original when reachable).
   * Face boxes are stored in pixel coordinates of the OLD orientation, so without this every face overlay and
   * every person avatar cropped from the photo would point at the wrong region. Rotates each face's box and
   * its reference frame with the picture and swaps the photo's width/height for quarter turns.
   *
   * Returns how many faces were moved, how many could not be (no known frame), and the people whose avatar is
   * cut from this photo so the caller can regenerate it.
   */
  public applyPhotoRotation(photoId: string, degrees: number): { rotatedFaces: number; skippedFaces: number; avatarPersonIds: string[] } {
    const turn = normalizeDegrees(degrees);
    const none = { rotatedFaces: 0, skippedFaces: 0, avatarPersonIds: [] as string[] };
    if (turn === 0) return none;
    const photo = this.state.photos.find((p) => p.id === photoId);
    if (!photo) return none;

    // Face objects are shared between photo.faces and state.faces, but not always (a photo loaded from disk
    // may hold its own copies). Rotate every distinct object once, matched by id.
    const targets = new Map<string, DetectedFace[]>();
    const add = (f: DetectedFace) => {
      const list = targets.get(f.id) || [];
      if (!list.includes(f)) list.push(f);
      targets.set(f.id, list);
    };
    (photo.faces || []).forEach(add);
    this.state.faces.filter((f) => f.photoId === photoId).forEach(add);

    let rotatedFaces = 0;
    let skippedFaces = 0;
    const rotatedIds = new Set<string>();
    for (const [id, copies] of targets) {
      const frame = resolveFaceFrame(copies[0], photo);
      if (!frame) {
        skippedFaces++;
        continue;
      }
      const moved = rotateBox(copies[0].box, frame.w, frame.h, turn);
      for (const f of copies) {
        f.box = moved.box;
        f.imageWidth = moved.frameW;
        f.imageHeight = moved.frameH;
      }
      rotatedIds.add(id);
      rotatedFaces++;
    }

    const swap = turn === 90 || turn === 270;
    const idx = this.state.photos.indexOf(photo);
    if (idx >= 0) {
      this.photoIndexCache = null;
      const photos = this.state.photos.slice();
      photos[idx] = swap && photo.width && photo.height ? { ...photo, width: photo.height, height: photo.width } : { ...photo };
      this.state.photos = photos; // new object + array: face edits are nested, so this also forgets the cached signature
    }
    this.forceFullResign = true;
    this.notify();

    const avatarPersonIds = this.state.people
      .filter((p) =>
        (p.coverFaceId && rotatedIds.has(p.coverFaceId)) ||
        (!p.coverFaceId && (p.coverPhotoId === photoId || (photo.faces || []).some((f) => f.personId === p.id)))
      )
      .map((p) => p.id);

    return { rotatedFaces, skippedFaces, avatarPersonIds };
  }

  /**
   * Photos were physically moved to another folder (photoRelocation.ts): their ids, paths and the ids of their
   * faces all changed. The main process already updated the database; this brings the in-memory library in line so
   * albums, people covers and face lists keep pointing at the same photos, and queues the old ids for deletion in
   * whichever database might still hold them.
   */
  public applyPhotoRelocations(
    moves: Array<{ oldId: string; newId: string; newFilePath: string; newOriginalRemotePath?: string; newFileName?: string }>
  ): number {
    const byOld = new Map(moves.filter((m) => m.oldId && m.newId && m.oldId !== m.newId).map((m) => [m.oldId, m] as const));
    if (byOld.size === 0) return 0;

    // Face ids embed the photo id (`<photoId>_face_<n>`): rewrite them once, on the shared face objects.
    const faceIdMap = new Map<string, string>();
    const remapFace = (f: DetectedFace) => {
      const move = byOld.get(f.photoId);
      if (!move) return;
      const oldFaceId = f.id;
      f.photoId = move.newId;
      if (oldFaceId.startsWith(move.oldId)) f.id = move.newId + oldFaceId.slice(move.oldId.length);
      if (f.id !== oldFaceId) faceIdMap.set(oldFaceId, f.id);
    };
    this.state.faces.forEach(remapFace);
    for (const p of this.state.photos) if (byOld.has(p.id)) (p.faces || []).forEach(remapFace);

    this.photoIndexCache = null;
    this.state.photos = this.state.photos.map((p) => {
      const move = byOld.get(p.id);
      if (!move) return p;
      return {
        ...p,
        id: move.newId,
        filePath: move.newFilePath,
        fileName: move.newFileName ?? p.fileName,
        originalRemotePath: move.newOriginalRemotePath ?? p.originalRemotePath,
        thumbnailPath: p.thumbnailPath ? move.newFilePath : p.thumbnailPath,
      };
    });

    this.state.people = this.state.people.map((person) => {
      const coverMove = person.coverPhotoId ? byOld.get(person.coverPhotoId) : undefined;
      const newCoverFace = person.coverFaceId ? faceIdMap.get(person.coverFaceId) : undefined;
      if (!coverMove && !newCoverFace) return person;
      return {
        ...person,
        coverPhotoId: coverMove ? coverMove.newId : person.coverPhotoId,
        coverFaceId: newCoverFace ?? person.coverFaceId,
      };
    });

    this.state.albums = this.state.albums.map((album) => {
      const touched = album.photoIds.some((id) => byOld.has(id)) || (album.coverPhotoId && byOld.has(album.coverPhotoId));
      if (!touched) return album;
      return {
        ...album,
        photoIds: album.photoIds.map((id) => byOld.get(id)?.newId ?? id),
        coverPhotoId: album.coverPhotoId ? byOld.get(album.coverPhotoId)?.newId ?? album.coverPhotoId : album.coverPhotoId,
        updatedAt: new Date().toISOString(),
      };
    });

    this.state.places = groupPhotosByPlace(this.state.photos.filter((p) => !p.isExcluded));
    byOld.forEach((_m, oldId) => this.pendingRemovedIds.add(oldId));
    this.forceFullResign = true;
    this.notify(true);
    return byOld.size;
  }

  public deleteFaceDetection(faceId: string) {
    const removedFace = this.state.faces.find((f) => f.id === faceId);
    this.state.faces = this.state.faces.filter((f) => f.id !== faceId);
    for (const photo of this.state.photos) {
      if (photo.faces) {
        photo.faces = photo.faces.filter((f) => f.id !== faceId);
      }
    }
    const { people, updatedFaces } = this.cluster(this.state.faces, this.state.people);
    this.state.people = people;
    this.state.faces = updatedFaces;
    if (removedFace) {
      this.recomputeFacesLockedForPhoto(removedFace.photoId);
    }
    this.notify();
  }

  /**
   * Removes every unnamed/unrecognized face from one photo in a single
   * action — useful for a crowd/public photo where only a couple of people
   * are actually known and tagging or deleting each stray detection one by
   * one isn't worth it. Also flags the photo as manually verified so
   * automatic/bulk face (re-)detection (runFaceDetectionForPhotos,
   * FaceQueueService) skips it going forward, and it stays skipped even
   * through a re-sync — until the user explicitly re-runs "Scan Faces" on
   * this specific photo (detectAndMatchFacesForPhoto clears the flag).
   */
  public removeUnknownFacesFromPhoto(photoId: string): { removedCount: number } {
    const photo = this.state.photos.find((p) => p.id === photoId);
    if (!photo) return { removedCount: 0 };

    const peopleById = new Map(this.state.people.map((p) => [p.id, p]));
    const isUnnamed = (face: DetectedFace): boolean => {
      if (!face.personId) return true;
      const person = peopleById.get(face.personId);
      if (!person) return true;
      return /^Person(\s+\d+)?$/i.test(person.name);
    };

    const idsToRemove = new Set((photo.faces || []).filter(isUnnamed).map((f) => f.id));

    if (idsToRemove.size > 0) {
      this.state.faces = this.state.faces.filter((f) => !idsToRemove.has(f.id));
      for (const p of this.state.photos) {
        if (p.faces) {
          p.faces = p.faces.filter((f) => !idsToRemove.has(f.id));
        }
      }
      const { people, updatedFaces } = this.cluster(this.state.faces, this.state.people);
      this.state.people = people;
      this.state.faces = updatedFaces;
    }

    photo.facesLocked = true;
    this.notify(true);

    return { removedCount: idsToRemove.size };
  }

  /**
   * Auto-lock rule: a photo locks itself the moment every face currently on
   * it is confirmed (including the trivial zero-faces case) — no separate
   * "verify" click required. Called after any action that changes a face's
   * confirmed state (confirm, reassign, unassign, delete) so the lock always
   * reflects current reality. Explicit bulk-curation actions (e.g. "Remove
   * Unknown Faces") still force-lock directly, since those already mean
   * "I'm done with this photo" regardless of what's left unconfirmed.
   */
  private recomputeFacesLockedForPhoto(photoId: string): void {
    const photo = this.state.photos.find((p) => p.id === photoId);
    if (!photo) return;
    const faces = this.state.faces.filter((f) => f.photoId === photoId);
    photo.facesLocked = faces.every((f) => f.isConfirmed);
  }

  /** A face tagged to a real named person that the user has not yet confirmed correct. */
  private isUnconfirmedNamedFace = (face: DetectedFace): boolean => {
    if (face.isConfirmed) return false;
    if (!face.personId) return false;
    const person = this.state.people.find((p) => p.id === face.personId);
    if (!person) return false;
    return !/^Person(\s+\d+)?$/i.test(person.name);
  };

  /**
   * Deletes every unconfirmed named-person face detection from one photo —
   * a tentative auto-match (e.g. "Monika") the user never verified with the
   * checkmark. Unlike removeUnknownFacesFromPhoto (faces with no name at
   * all), this targets guesses that do have a name but aren't trusted yet.
   * Also locks the photo from auto-rescanning, since the same face
   * embedding would otherwise immediately reproduce the same guess.
   */
  public removeUnconfirmedFacesFromPhoto(photoId: string): { removedCount: number } {
    const photo = this.state.photos.find((p) => p.id === photoId);
    if (!photo) return { removedCount: 0 };

    const idsToRemove = new Set((photo.faces || []).filter(this.isUnconfirmedNamedFace).map((f) => f.id));

    if (idsToRemove.size > 0) {
      this.state.faces = this.state.faces.filter((f) => !idsToRemove.has(f.id));
      for (const p of this.state.photos) {
        if (p.faces) {
          p.faces = p.faces.filter((f) => !idsToRemove.has(f.id));
        }
      }
      const { people, updatedFaces } = this.cluster(this.state.faces, this.state.people);
      this.state.people = people;
      this.state.faces = updatedFaces;
    }

    photo.facesLocked = true;
    this.notify(true);

    return { removedCount: idsToRemove.size };
  }

  /**
   * Clears the person assignment (back to unlabeled) on every unconfirmed
   * named-person face in a photo, keeping the face boxes intact — unlike
   * removeUnconfirmedFacesFromPhoto, nothing is deleted so the faces remain
   * available to be manually re-tagged or re-matched on a future scan.
   */
  public resetUnconfirmedFacesToUnknown(photoId: string): { resetCount: number } {
    const photo = this.state.photos.find((p) => p.id === photoId);
    if (!photo) return { resetCount: 0 };

    const idsToReset = new Set((photo.faces || []).filter(this.isUnconfirmedNamedFace).map((f) => f.id));

    if (idsToReset.size > 0) {
      for (const f of this.state.faces) {
        if (idsToReset.has(f.id)) {
          f.personId = undefined;
          f.isConfirmed = false;
        }
      }
      this.state.photos = this.state.photos.map((p) => {
        if (p.faces && p.faces.some((f) => idsToReset.has(f.id))) {
          return {
            ...p,
            faces: p.faces.map((f) => (idsToReset.has(f.id) ? { ...f, personId: undefined, isConfirmed: false } : f)),
          };
        }
        return p;
      });
      const { people, updatedFaces } = this.cluster(this.state.faces, this.state.people, DEFAULT_MATCH_THRESHOLD, false);
      this.state.people = people;
      this.state.faces = updatedFaces;
      this.notify(true);
    }

    return { resetCount: idsToReset.size };
  }

  public updateFacesAndPeople(newFaces: DetectedFace[]) {
    // Merge new faces
    const faceMap = new Map(this.state.faces.map((f) => [f.id, f]));
    for (const f of newFaces) {
      faceMap.set(f.id, f);
    }
    const mergedFaces = Array.from(faceMap.values());

    const { people, updatedFaces } = this.cluster(mergedFaces, this.state.people);
    this.state.faces = updatedFaces;
    this.state.people = people;

    // Update face references on photos
    const photoFaceMap = new Map<string, DetectedFace[]>();
    for (const f of updatedFaces) {
      if (!photoFaceMap.has(f.photoId)) {
        photoFaceMap.set(f.photoId, []);
      }
      photoFaceMap.get(f.photoId)!.push(f);
    }

    for (const photo of this.state.photos) {
      const faces = photoFaceMap.get(photo.id) || [];
      photo.faces = faces;
      if (faces.length > 0) {
        photo.faceScanCompleted = true;
        this.cachePhotoFaces(photo, faces, true);
      }
    }

    this.notify();
  }

  /**
   * Adopts face-detection results the main process already clustered and
   * persisted to SQLite (see pipelineOrchestrator.ts) as-is, instead of
   * re-clustering them again renderer-side — the main process is now the
   * single source of truth for face data, so this only mirrors it into the
   * in-memory view rather than recomputing it a second time.
   */
  public applyServerDetectedFaces(
    perPhotoFaces: Array<{ photoId: string; faces: DetectedFace[]; faceScanCompleted: boolean; facesLocked: boolean }>,
    people: Person[]
  ) {
    const facesByPhoto = new Map(perPhotoFaces.map((p) => [p.photoId, p]));
    // id -> Photo lookup: this runs once per chunk of ~8 photos, so scanning every photo
    // each time was O(N^2/8) over a full-library scan.
    const photoIndex = this.getPhotoIndex();

    // Drop this library's cached copy of each touched photo's faces — the
    // authoritative per-photo list below replaces them. Skippable when none of these
    // photos carried faces yet (the usual first-scan case): nothing to drop.
    const mayHaveStaleFaces = perPhotoFaces.some((e) => {
      const p = photoIndex.get(e.photoId);
      return !p || p.faceScanCompleted || (p.faces && p.faces.length > 0);
    });
    if (mayHaveStaleFaces) {
      this.state.faces = this.state.faces.filter((f) => !facesByPhoto.has(f.photoId));
    }
    for (const entry of perPhotoFaces) {
      this.state.faces.push(...entry.faces);
    }
    // Main just persisted this people list too (pipelineOrchestrator's
    // upsertPeople) — advance the save baseline unless the renderer had its
    // own unsaved people edit (e.g. a rename), which must still go out.
    const peopleWereClean = this.lastSavedPeopleSig !== null && this.lastSavedPeopleSig === this.peopleSigOf(this.state.people);
    this.state.people = people;
    if (peopleWereClean) this.lastSavedPeopleSig = this.peopleSigOf(people);

    let matchedInStatePhotos = 0;
    for (const entry of perPhotoFaces) {
      const photo = photoIndex.get(entry.photoId);
      if (photo) {
        matchedInStatePhotos++;
        // Main already persisted these faces/flags, so advance the save
        // baseline too — but only if the photo had no other unsaved edit
        // (e.g. a just-toggled favorite), which must still go out.
        const sigs = this.savedPhotoSigs;
        const wasClean = !!sigs && sigs.get(photo.id) === this.photoSig(photo);
        photo.faces = entry.faces;
        photo.faceScanCompleted = entry.faceScanCompleted;
        photo.facesLocked = entry.facesLocked;
        this.cachePhotoFaces(photo, entry.faces, true);
        if (wasClean) sigs!.set(photo.id, this.photoSig(photo));
      }
    }
    // If a requested photoId isn't found in this.state.photos at all (e.g.
    // the user navigated to a different library/folder while detection was
    // still in flight, replacing this array), its face update above is
    // silently skipped — the returned faces are real, but nothing in the
    // renderer's photo objects ever reflects them, so no marker/panel entry
    // can appear no matter what the backend correctly persisted.
    if (matchedInStatePhotos < perPhotoFaces.length) {
      logger.warn('libraryStore', 'applyServerDetectedFaces: some photoIds were not found in state.photos (update skipped for those)', {
        requestedPhotoIds: perPhotoFaces.map((p) => p.photoId),
        requestedFaceCounts: perPhotoFaces.map((p) => p.faces.length),
        matchedInStatePhotos,
        totalStatePhotos: this.state.photos.length,
      });
    } else {
      logger.debug('libraryStore', 'applyServerDetectedFaces applied', {
        photoIds: perPhotoFaces.map((p) => p.photoId),
        faceCounts: perPhotoFaces.map((p) => p.faces.length),
      });
    }

    // No autosave: the main process already persisted exactly these photos'
    // faces + people incrementally (pipelineOrchestrator). Re-sending the whole
    // library here froze the main process for 10-26s per detection (23K photos).
    this.notifyListeners();
  }

  public deletePerson(personId: string): boolean {
    const person = this.state.people.find((p) => p.id === personId);
    if (!person) return false;

    // 1. Unassign all faces that belonged to this person
    for (const face of this.state.faces) {
      if (face.personId === personId) {
        face.personId = undefined;
        face.isConfirmed = false;
      }
    }

    for (const photo of this.state.photos) {
      if (photo.faces) {
        for (const face of photo.faces) {
          if (face.personId === personId) {
            face.personId = undefined;
            face.isConfirmed = false;
          }
        }
      }
    }

    // 2. Remove the person from people list
    const remainingPeople = this.state.people.filter((p) => p.id !== personId);

    // 3. Recalculate people and faces without creating new clusters for unassigned faces
    const { people, updatedFaces } = this.cluster(this.state.faces, remainingPeople, DEFAULT_MATCH_THRESHOLD, false);
    this.state.people = people;
    this.state.faces = updatedFaces;
    this.notify();
    return true;
  }

  public addManualFace(
    photoId: string,
    box: { x: number; y: number; width: number; height: number },
    descriptor?: number[],
    imageWidth?: number,
    imageHeight?: number
  ): DetectedFace {
    const photo = this.state.photos.find((p) => p.id === photoId);
    if (!photo) {
      throw new Error(`Photo ${photoId} not found`);
    }

    const faceId = `${photoId}_manual_${Date.now()}`;
    const newFace: DetectedFace = {
      id: faceId,
      photoId,
      box,
      imageWidth,
      imageHeight,
      descriptor: descriptor && descriptor.length === 128 ? descriptor : new Array(128).fill(0),
      confidence: 1.0,
      isConfirmed: true,
      isManual: true,
    };

    if (!photo.faces) photo.faces = [];
    photo.faces.push(newFace);
    this.state.faces.push(newFace);

    this.notify();
    return newFace;
  }

  public detectAndMatchFacesForPhoto(
    photoId: string,
    newDetections: DetectedFace[],
    precisionThreshold = 0.48
  ): Photo {
    const photo = this.state.photos.find((p) => p.id === photoId);
    if (!photo) throw new Error(`Photo ${photoId} not found`);

    // 1. Gather all known person faces across the library, segregating confirmed exemplars
    const personAllFaces = new Map<string, DetectedFace[]>();
    const personConfirmedFaces = new Map<string, DetectedFace[]>();

    for (const person of this.state.people) {
      personAllFaces.set(person.id, []);
      personConfirmedFaces.set(person.id, []);
    }

    for (const face of this.state.faces) {
      if (face.personId && personAllFaces.has(face.personId) && face.descriptor && face.descriptor.length === 128) {
        personAllFaces.get(face.personId)!.push(face);
        if (face.isConfirmed || face.isManual) {
          personConfirmedFaces.get(face.personId)!.push(face);
        }
      }
    }

    // 2. Preserve manually confirmed or manually added faces already on this photo
    const preservedFaces = (photo.faces || []).filter((f) => f.isConfirmed || f.isManual);
    const alreadyInPhoto = new Set(
      preservedFaces.map((f) => f.personId).filter(Boolean) as string[]
    );

    let matchedCount = 0;
    const finalFaces: DetectedFace[] = [...preservedFaces];

    // Overlap IoU helper
    const computeOverlap = (boxA: any, boxB: any) => {
      const xA = Math.max(boxA.x, boxB.x);
      const yA = Math.max(boxA.y, boxB.y);
      const xB = Math.min(boxA.x + boxA.width, boxB.x + boxB.width);
      const yB = Math.min(boxA.y + boxA.height, boxB.y + boxB.height);
      const interArea = Math.max(0, xB - xA) * Math.max(0, yB - yA);
      const boxAArea = boxA.width * boxA.height;
      const boxBArea = boxB.width * boxB.height;
      return interArea / (boxAArea + boxBArea - interArea);
    };

    // 3. Match newly detected faces with high precision against confirmed person exemplars first
    for (const det of newDetections) {
      const overlapsPreserved = preservedFaces.some((pf) => computeOverlap(pf.box, det.box) > 0.35);
      if (overlapsPreserved) continue;

      let bestMatchPersonId: string | null = null;
      let minDistance = Infinity;

      for (const [pId, confirmedList] of personConfirmedFaces.entries()) {
        if (alreadyInPhoto.has(pId) || confirmedList.length === 0) continue;

        const centroid = computeQualityWeightedCentroid(confirmedList);
        const cosDist = cosineDistance(det.descriptor, centroid);
        const euclDist = euclideanDistance(det.descriptor, centroid);
        const dist = Math.min(cosDist, euclDist);

        // Confirmed faces provide strong ground truth; allow confident threshold up to 0.52
        if (dist < minDistance && dist < 0.52) {
          minDistance = dist;
          bestMatchPersonId = pId;
        }

        // Check individual confirmed exemplars
        for (const exemplar of confirmedList) {
          const exDist = Math.min(
            cosineDistance(det.descriptor, exemplar.descriptor),
            euclideanDistance(det.descriptor, exemplar.descriptor)
          );
          if (exDist < minDistance && exDist < 0.50) {
            minDistance = exDist;
            bestMatchPersonId = pId;
          }
        }
      }

      // Fallback: Check general person centroids if no confirmed exemplar matched
      if (!bestMatchPersonId) {
        for (const [pId, assignedList] of personAllFaces.entries()) {
          if (alreadyInPhoto.has(pId) || assignedList.length === 0) continue;

          const centroid = computeQualityWeightedCentroid(assignedList);
          const dist = Math.min(
            cosineDistance(det.descriptor, centroid),
            euclideanDistance(det.descriptor, centroid)
          );
          if (dist < minDistance && dist < precisionThreshold) {
            minDistance = dist;
            bestMatchPersonId = pId;
          }
        }
      }

      if (bestMatchPersonId) {
        det.personId = bestMatchPersonId;
        det.isConfirmed = false;
        alreadyInPhoto.add(bestMatchPersonId);
        matchedCount++;
      } else {
        det.personId = undefined;
        det.isConfirmed = false;
      }

      finalFaces.push(det);
    }

    photo.faces = finalFaces;

    this.state.faces = this.state.faces.filter((f) => f.photoId !== photoId).concat(finalFaces);

    const { people, updatedFaces } = this.cluster(this.state.faces, this.state.people);
    this.state.people = people;
    this.state.faces = updatedFaces;
    photo.faces = updatedFaces.filter((f) => f.photoId === photoId);

    // The user explicitly asked to (re-)scan this specific photo, so lift
    // any earlier manual-verification lock — that lock exists only to keep
    // automatic/bulk scans from touching a photo the user already curated,
    // not to block a deliberate single-photo re-scan.
    photo.facesLocked = false;

    this.notify();

    return photo;
  }

  private photoIndexCache: { arr: Photo[]; len: number; map: Map<string, Photo> } | null = null;

  /** id -> Photo for the current photos array; rebuilt when the array (or its length) changes. */
  private getPhotoIndex(): Map<string, Photo> {
    const arr = this.state.photos;
    const c = this.photoIndexCache;
    if (c && c.arr === arr && c.len === arr.length) return c.map;
    const map = new Map<string, Photo>();
    for (const p of arr) map.set(p.id, p);
    this.photoIndexCache = { arr, len: arr.length, map };
    return map;
  }

  public setScanning(isScanning: boolean) {
    this.state.isScanning = isScanning;
    this.notifyListeners();
  }

  public setDetectingFaces(
    isDetecting: boolean,
    progress: { current: number; total: number; currentPhotoName?: string } | null = null
  ) {
    this.state.isDetectingFaces = isDetecting;
    this.state.faceDetectionProgress = progress;
    this.notifyListeners();
  }

  public removePhotosByStorage(storageName: string) {
    const remaining = this.state.photos.filter((p) => p.storageName !== storageName);
    this.state.photos = remaining;
    if (this.state.selectedFolder && this.state.selectedFolder.toLowerCase().includes(storageName.toLowerCase())) {
      this.state.selectedFolder = null;
    }
    this.notify();
  }

  public setPersonCover(personId: string, photoId: string, faceId?: string): boolean {
    const person = this.state.people.find((p) => p.id === personId);
    if (!person) return false;

    person.coverPhotoId = photoId;
    if (faceId) {
      person.coverFaceId = faceId;
    } else {
      const photo = this.state.photos.find((p) => p.id === photoId);
      const face = photo?.faces?.find((f) => f.personId === personId);
      if (face) person.coverFaceId = face.id;
    }

    this.state.people = [...this.state.people];
    this.notify();
    return true;
  }

  public autoSelectBestFaceCover(personId: string): { photoId: string; faceId: string; score: number } | null {
    const person = this.state.people.find((p) => p.id === personId);
    if (!person) return null;

    const candidates: Array<{ photoId: string; face: DetectedFace; score: number }> = [];

    for (const photo of this.state.photos) {
      if (!photo.faces) continue;
      for (const face of photo.faces) {
        if (face.personId === personId) {
          const area = (face.box.width || 50) * (face.box.height || 50);
          const sizeFactor = Math.min(2.0, Math.max(0.5, Math.sqrt(area) / 100));
          const conf = face.confidence || 0.8;
          const confirmedBonus = face.isConfirmed ? 1.4 : 1.0;
          const happyBonus = (face.dominantExpression === 'happy' || (face.expressions?.happy || 0) > 0.4) ? 1.3 : 1.0;
          const sharpness = photo.sharpnessScore ? (photo.sharpnessScore / 50) : 1.0;

          const score = Math.round(conf * sizeFactor * confirmedBonus * happyBonus * sharpness * 50);
          candidates.push({ photoId: photo.id, face, score });
        }
      }
    }

    if (candidates.length === 0) return null;

    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];

    this.setPersonCover(personId, best.photoId, best.face.id);
    return { photoId: best.photoId, faceId: best.face.id, score: best.score };
  }

  public clearLibrary() {
    this.state.photos = [];
    this.state.people = [];
    this.state.faces = [];
    this.state.places = [];
    this.state.albums = [];
    this.state.selectedFolder = null;
    this.notify();
  }

  /**
   * Clears the "active library" pointer and its photos when the folder it
   * points at no longer exists on disk (deleted outside the app, a network
   * share gone offline for good, a drive unplugged) — unlike clearLibrary(),
   * leaves people/faces/albums alone, since those are the global cross-library
   * registry, not specific to whichever folder happened to be open.
   */
  public clearMissingActiveLibrary() {
    this.state.photos = [];
    this.state.places = [];
    this.state.selectedFolder = null;
    this.state.currentDirectory = null;
    this.notify(true);
  }

  // ================= ALBUM OPERATIONS =================
  public createAlbum(
    title: string,
    description?: string,
    eventDateOrPhotoIds?: string | string[],
    photoIds: string[] = []
  ): Album {
    let eventDate: string | undefined;
    let initialPhotoIds: string[] = [];

    if (Array.isArray(eventDateOrPhotoIds)) {
      initialPhotoIds = eventDateOrPhotoIds;
    } else if (typeof eventDateOrPhotoIds === 'string') {
      eventDate = eventDateOrPhotoIds;
      initialPhotoIds = Array.isArray(photoIds) ? photoIds : [];
    } else if (Array.isArray(photoIds)) {
      initialPhotoIds = photoIds;
    }

    const cleanPhotoIds = [...new Set(initialPhotoIds.filter((id) => typeof id === 'string' && id.length > 0))];

    const newAlbum: Album = {
      id: `album_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      title: title.trim() || 'Untitled Album',
      description: description?.trim(),
      photoIds: cleanPhotoIds,
      coverPhotoId: cleanPhotoIds.length > 0 ? cleanPhotoIds[0] : undefined,
      eventDate: eventDate || undefined,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.state.albums = [newAlbum, ...this.state.albums];
    this.notify();
    return newAlbum;
  }

  public updateAlbum(albumId: string, updates: Partial<Album>): boolean {
    const idx = this.state.albums.findIndex((a) => a.id === albumId);
    if (idx === -1) return false;

    this.state.albums[idx] = {
      ...this.state.albums[idx],
      ...updates,
      updatedAt: new Date().toISOString(),
    };
    this.notify();
    return true;
  }

  public deleteAlbum(albumId: string): boolean {
    const countBefore = this.state.albums.length;
    this.state.albums = this.state.albums.filter((a) => a.id !== albumId);
    if (this.state.albums.length !== countBefore) {
      this.notify();
      return true;
    }
    return false;
  }

  public addPhotosToAlbum(albumId: string, photoIds: string[]): boolean {
    const album = this.state.albums.find((a) => a.id === albumId);
    if (!album) return false;

    const existingSet = new Set(album.photoIds);
    let addedCount = 0;
    for (const pid of photoIds) {
      if (!existingSet.has(pid)) {
        album.photoIds.push(pid);
        existingSet.add(pid);
        addedCount++;
      }
    }

    if (!album.coverPhotoId && album.photoIds.length > 0) {
      album.coverPhotoId = album.photoIds[0];
    }

    album.updatedAt = new Date().toISOString();
    this.notify();
    return addedCount > 0;
  }

  public removePhotosFromAlbum(albumId: string, photoIds: string[]): boolean {
    const album = this.state.albums.find((a) => a.id === albumId);
    if (!album) return false;

    const toRemoveSet = new Set(photoIds);
    album.photoIds = album.photoIds.filter((id) => !toRemoveSet.has(id));

    if (album.coverPhotoId && toRemoveSet.has(album.coverPhotoId)) {
      album.coverPhotoId = album.photoIds.length > 0 ? album.photoIds[0] : undefined;
    }

    // A photo removed from the album can't stay listed in one of its chapters either.
    if (album.chapters) {
      for (const chapter of album.chapters) {
        chapter.photoIds = chapter.photoIds.filter((id) => !toRemoveSet.has(id));
        if (chapter.coverPhotoId && toRemoveSet.has(chapter.coverPhotoId)) {
          chapter.coverPhotoId = chapter.photoIds[0];
        }
      }
    }

    album.updatedAt = new Date().toISOString();
    this.notify();
    return true;
  }

  public setAlbumCover(albumId: string, photoId: string): boolean {
    const album = this.state.albums.find((a) => a.id === albumId);
    if (!album) return false;

    album.coverPhotoId = photoId;
    album.updatedAt = new Date().toISOString();
    this.notify();
    return true;
  }

  // ================= ALBUM CHAPTERS =================
  public createChapter(albumId: string, title: string, photoIds: string[] = []): AlbumChapter | null {
    const album = this.state.albums.find((a) => a.id === albumId);
    if (!album) return null;

    const now = new Date().toISOString();
    const chapter: AlbumChapter = {
      id: `chapter_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      title: title.trim() || 'Untitled chapter',
      photoIds: [],
      createdAt: now,
      updatedAt: now,
    };
    album.chapters = [...(album.chapters || []), chapter];
    album.lastUsedChapterId = chapter.id;
    album.updatedAt = now;
    this.notify();

    if (photoIds.length > 0) {
      this.addPhotosToChapter(albumId, chapter.id, photoIds);
    }
    return chapter;
  }

  public renameChapter(albumId: string, chapterId: string, title: string): boolean {
    const album = this.state.albums.find((a) => a.id === albumId);
    const chapter = album?.chapters?.find((c) => c.id === chapterId);
    if (!album || !chapter) return false;

    chapter.title = title.trim() || chapter.title;
    chapter.updatedAt = new Date().toISOString();
    album.updatedAt = chapter.updatedAt;
    this.notify();
    return true;
  }

  public reorderChapters(albumId: string, orderedChapterIds: string[]): boolean {
    const album = this.state.albums.find((a) => a.id === albumId);
    if (!album?.chapters) return false;

    const byId = new Map(album.chapters.map((c) => [c.id, c]));
    const reordered = orderedChapterIds.map((id) => byId.get(id)).filter((c): c is AlbumChapter => !!c);
    // Any chapter missing from the given order (shouldn't happen) is kept, appended at the end,
    // so a chapter can never silently disappear from a reorder call.
    for (const c of album.chapters) if (!orderedChapterIds.includes(c.id)) reordered.push(c);

    album.chapters = reordered;
    album.updatedAt = new Date().toISOString();
    this.notify();
    return true;
  }

  /**
   * Deleting a chapter never deletes photos: they fall back to the album's default
   * (no-chapter) bucket, exactly as if they'd never been chaptered.
   */
  public deleteChapter(albumId: string, chapterId: string): boolean {
    const album = this.state.albums.find((a) => a.id === albumId);
    if (!album?.chapters) return false;

    const before = album.chapters.length;
    album.chapters = album.chapters.filter((c) => c.id !== chapterId);
    if (album.chapters.length === before) return false;

    if (album.lastUsedChapterId === chapterId) album.lastUsedChapterId = undefined;
    album.updatedAt = new Date().toISOString();
    this.notify();
    return true;
  }

  /**
   * Adds photos to a chapter (creating the album membership too, if they weren't already in the
   * album) and records this as the album's last-used chapter. A photo belongs to at most one
   * chapter at a time, so it's removed from any other chapter of the same album first.
   */
  /**
   * `insertBeforePhotoId`, if given and currently in this chapter, positions the moved photos
   * right before it instead of appending them at the end — this is also how reordering *within*
   * one chapter works: every chapter (including this one) is stripped of the moved ids first, so
   * dropping a photo already in this chapter onto another one of its own photos just relocates it.
   */
  public addPhotosToChapter(albumId: string, chapterId: string, photoIds: string[], insertBeforePhotoId?: string): boolean {
    const album = this.state.albums.find((a) => a.id === albumId);
    const chapter = album?.chapters?.find((c) => c.id === chapterId);
    if (!album || !chapter) return false;

    const idsSet = new Set(photoIds);
    for (const other of album.chapters!) {
      other.photoIds = other.photoIds.filter((id) => !idsSet.has(id));
    }

    let insertIdx = chapter.photoIds.length;
    if (insertBeforePhotoId) {
      const idx = chapter.photoIds.indexOf(insertBeforePhotoId);
      if (idx !== -1) insertIdx = idx;
    }
    chapter.photoIds.splice(insertIdx, 0, ...photoIds);
    if (!chapter.coverPhotoId && chapter.photoIds.length > 0) chapter.coverPhotoId = chapter.photoIds[0];

    const existingAlbumSet = new Set(album.photoIds);
    for (const id of photoIds) {
      if (!existingAlbumSet.has(id)) {
        album.photoIds.push(id);
        existingAlbumSet.add(id);
      }
    }
    if (!album.coverPhotoId && album.photoIds.length > 0) album.coverPhotoId = album.photoIds[0];

    const now = new Date().toISOString();
    chapter.updatedAt = now;
    album.lastUsedChapterId = chapterId;
    album.updatedAt = now;
    this.notify();
    return true;
  }

  /** Moves photos back to the album's default (no-chapter) bucket without removing them from the album. */
  public removePhotosFromChapter(albumId: string, chapterId: string, photoIds: string[]): boolean {
    const album = this.state.albums.find((a) => a.id === albumId);
    const chapter = album?.chapters?.find((c) => c.id === chapterId);
    if (!album || !chapter) return false;

    const toRemoveSet = new Set(photoIds);
    chapter.photoIds = chapter.photoIds.filter((id) => !toRemoveSet.has(id));
    if (chapter.coverPhotoId && toRemoveSet.has(chapter.coverPhotoId)) {
      chapter.coverPhotoId = chapter.photoIds[0];
    }
    chapter.updatedAt = new Date().toISOString();
    album.updatedAt = chapter.updatedAt;
    this.notify();
    return true;
  }

  /** Every album photo id not currently listed in any of its chapters. */
  public getUnchapteredPhotoIds(album: Album): string[] {
    if (!album.chapters || album.chapters.length === 0) return album.photoIds;
    const chaptered = new Set(album.chapters.flatMap((c) => c.photoIds));
    return album.photoIds.filter((id) => !chaptered.has(id));
  }

  /** Drops photos back to the album's default (no-chapter) bucket, whichever chapter(s) they were in — e.g. dragging a mixed-source selection onto "Other Photos". */
  public removePhotosFromAllChapters(albumId: string, photoIds: string[]): boolean {
    const album = this.state.albums.find((a) => a.id === albumId);
    if (!album?.chapters || album.chapters.length === 0) return false;

    const idsSet = new Set(photoIds);
    for (const chapter of album.chapters) {
      chapter.photoIds = chapter.photoIds.filter((id) => !idsSet.has(id));
      if (chapter.coverPhotoId && idsSet.has(chapter.coverPhotoId)) chapter.coverPhotoId = chapter.photoIds[0];
    }
    album.updatedAt = new Date().toISOString();
    this.notify();
    return true;
  }
}

export const libraryStore = new LibraryManager();
