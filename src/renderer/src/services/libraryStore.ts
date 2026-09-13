import { Photo, Person, DetectedFace, PlaceAlbum, Album, CatalogMeta } from '../../types';
import { groupPhotosByPlace } from './placesService';
import { trackBackendCall } from './responseTracker';
import {
  clusterFaces,
  euclideanDistance,
  cosineDistance,
  computeQualityWeightedCentroid,
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
      return url;
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
      return url;
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
      return url;
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
  };

  private globalFaceCache: Map<string, CachedFaceRecord> = new Map();
  private currentCatalogPage = 0;
  private isLoadingCatalogPage = false;
  private listeners: Set<() => void> = new Set();
  private saveDebounceTimer: any = null;
  private isVerifyingInBackground = false;

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
        this.flushSaveImmediately();
      });
    }
    this.loadPersistedData();
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

  private scheduleDebouncedSave() {
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
    }
    this.saveDebounceTimer = setTimeout(() => {
      this.saveDebounceTimer = null;
      this.savePersistedData();
    }, 500);
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
            if (!existing.personId && face.personId) existing.personId = face.personId;
            if (!existing.descriptor && face.descriptor) existing.descriptor = face.descriptor;
            if (face.isConfirmed) existing.isConfirmed = true;
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
        const firstFace = assignedFaces[0];
        const uniquePhotos = new Set(assignedFaces.map((f) => f.photoId));
        const newPerson: Person = {
          id: pId,
          name: `Person ${nextIndex++}`,
          coverFaceId: firstFace.id,
          coverPhotoId: firstFace.photoId,
          faceCount: assignedFaces.length,
          photoCount: uniquePhotos.size,
          createdAt: new Date().toISOString(),
        };
        peopleMap.set(pId, newPerson);
        modified = true;
      }
    }

    // 5. If people is STILL empty and all faces have no personId, run clusterFaces
    if (peopleMap.size === 0 && allFaces.length > 0) {
      const facesWithDesc = allFaces.filter((f) => f.descriptor && f.descriptor.length > 0);
      if (facesWithDesc.length > 0) {
        const { people, updatedFaces } = clusterFaces(allFaces, [], 0.55, true);
        for (const p of people) {
          peopleMap.set(p.id, p);
        }
        this.state.faces = updatedFaces;
        modified = true;
      }
    } else if (unassignedFaces.length > 0 && peopleMap.size > 0) {
      // If we have some unassigned faces, cluster them matching to existing people or create new clusters
      const { people, updatedFaces } = clusterFaces(allFaces, Array.from(peopleMap.values()), 0.55, true);
      for (const p of people) {
        peopleMap.set(p.id, p);
      }
      this.state.faces = updatedFaces;
      modified = true;
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
      let globalFaceData: any = null;
      if (typeof window !== 'undefined' && window.electronAPI) {
        globalPeopleData = await window.electronAPI.loadLibraryData(GLOBAL_PEOPLE_KEY);
        globalFaceData = await window.electronAPI.loadLibraryData(GLOBAL_FACE_CACHE_KEY);
      } else if (typeof localStorage !== 'undefined') {
        const rawP = localStorage.getItem(GLOBAL_PEOPLE_KEY);
        if (rawP) globalPeopleData = JSON.parse(rawP);
        const rawF = localStorage.getItem(GLOBAL_FACE_CACHE_KEY);
        if (rawF) globalFaceData = JSON.parse(rawF);
      }

      if (Array.isArray(globalFaceData)) {
        for (const [k, v] of globalFaceData) {
          if (k && v) this.globalFaceCache.set(k, v);
        }
      } else if (globalFaceData && typeof globalFaceData === 'object') {
        for (const [k, v] of Object.entries(globalFaceData)) {
          if (k && v) this.globalFaceCache.set(k, v as any);
        }
      }

      if (Array.isArray(globalPeopleData) && globalPeopleData.length > 0) {
        const existingMap = new Map(this.state.people.map((p) => [p.id, p]));
        for (const p of globalPeopleData) {
          if (p && p.id) {
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
    }
  }

  /**
   * Instant startup loader:
   * 1. Reads pre-calculated catalog_meta.json (<25 KB, ~1ms)
   * 2. Immediately paints Screen 1 with Page 0 (first 100 photos, ~40 KB)
   * 3. Seamlessly restores and reconciles people, faces, and albums from central storage
   */
  public async loadPersistedData() {
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

            // Fast Screen 1: Load Page 0 (first 100 photos)
            const tPageStart = performance.now();
            const p0 = await window.electronAPI.getCatalogPage({ pageIndex: 0, pageSize: 100 });
            const tPageEnd = performance.now();
            if (p0 && p0.photos && p0.photos.length > 0) {
              console.log(`[STARTUP AUDIT] Page 0 (${p0.photos.length} photos) loaded in ${(tPageEnd - tPageStart).toFixed(1)}ms. Total renderer startup time to first screen: ${(tPageEnd - t0).toFixed(1)}ms`);
              this.state.photos = p0.photos;
              this.currentCatalogPage = 0;

              // Restore persisted people, faces, and albums from central store
              const data = await window.electronAPI.loadLibraryData(STORAGE_KEY);
              if (data) {
                this.state.people = data.people || [];
                this.state.faces = data.faces || [];
                this.state.albums = data.albums || [];
                if (!this.state.selectedFolder) this.state.selectedFolder = data.selectedFolder || null;
                if (!this.state.recentLibraries || this.state.recentLibraries.length === 0) {
                  this.state.recentLibraries = data.recentLibraries || [];
                }
              }

              this.reconcilePeopleAndFaces();
              this.notifyListeners();
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
          const metaRes = await fetch('/api/catalog-meta', { signal: AbortSignal.timeout(1500) });
          if (metaRes.ok) {
            const meta: CatalogMeta = await metaRes.json();
            if (meta && meta.totalPhotos > 0) {
              this.state.catalogMeta = meta;
              this.state.totalCount = meta.totalPhotos;
              this.state.places = (meta.placesSummary as any) || [];
              this.state.selectedFolder = meta.selectedFolder;
              this.state.currentDirectory = meta.currentDirectory;
              this.state.recentLibraries = meta.recentLibraries || [];

              const pageRes = await fetch('/api/catalog-page?page=0&size=100', { signal: AbortSignal.timeout(2000) });
              if (pageRes.ok) {
                const pageData = await pageRes.json();
                if (pageData && pageData.photos && pageData.photos.length > 0) {
                  this.state.photos = pageData.photos;
                  this.currentCatalogPage = 0;
                  try {
                    const libRes = await fetch('/api/library', { signal: AbortSignal.timeout(2000) });
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
                  this.notifyListeners();
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
          const res = await fetch('/api/library', { signal: AbortSignal.timeout(2000) });
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
        let result: { meta: CatalogMeta; firstPage: Photo[] } | null = null;
        if (window.electronAPI?.switchLibrary) {
          result = await trackBackendCall(window.electronAPI.switchLibrary(targetPath), 'Switching library...');
        } else if (window.location?.protocol?.startsWith('http')) {
          const res = await fetch('/api/switch-library', {
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
          this.currentCatalogPage = 0;
          this.reconcilePeopleAndFaces();
          this.notify(true);
          return true;
        }
      }
    } catch (err) {
      console.warn('[LibraryStore] switchLibrary failed:', err);
    }
    return false;
  }

  /**
   * Seamlessly loads the next 100-photo catalog page as the user scrolls.
   */
  public async loadNextCatalogPage(): Promise<void> {
    if (this.isLoadingCatalogPage || !this.state.catalogMeta) return;
    if (this.currentCatalogPage + 1 >= this.state.catalogMeta.totalPages) return;

    this.isLoadingCatalogPage = true;
    try {
      this.currentCatalogPage += 1;
      let newPhotos: Photo[] = [];

      if (window.electronAPI?.getCatalogPage) {
        const res = await trackBackendCall(window.electronAPI.getCatalogPage({ pageIndex: this.currentCatalogPage }), 'Loading photos...');
        if (res && res.photos) newPhotos = res.photos;
      } else if (window.location?.protocol?.startsWith('http')) {
        const res = await fetch(`/api/catalog-page?page=${this.currentCatalogPage}&size=100`);
        if (res.ok) {
          const data = await res.json();
          if (data && data.photos) newPhotos = data.photos;
        }
      }

      if (newPhotos.length > 0) {
        this.state.photos = deduplicatePhotoList([...this.state.photos, ...newPhotos]);
        this.notifyListeners();
      }
    } catch (err) {
      console.warn('[LibraryStore] Failed loading next catalog page:', err);
    } finally {
      this.isLoadingCatalogPage = false;
    }
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

  private async savePersistedData() {
    try {
      // Always update globalFaceCache from current photos
      for (const p of this.state.photos) {
        if (p.faceScanCompleted || (p.faces && p.faces.length > 0)) {
          this.cachePhotoFaces(p, p.faces || [], p.faceScanCompleted);
        }
      }

      // Safety guard: if photos contain faces but people is empty, reconcile first
      if (this.state.people.length === 0 && this.state.photos.some((p) => p.faces && p.faces.length > 0)) {
        this.reconcilePeopleAndFaces();
      }

      const dataToSave = {
        photos: this.state.photos,
        people: this.state.people,
        faces: this.state.faces,
        albums: this.state.albums,
        selectedFolder: this.state.selectedFolder,
        recentLibraries: this.state.recentLibraries,
      };

      const cacheEntries = Array.from(this.globalFaceCache.entries()).slice(-20000);

      if (typeof window !== 'undefined' && window.electronAPI && typeof window.electronAPI.saveLibraryData === 'function') {
        await window.electronAPI.saveLibraryData(STORAGE_KEY, dataToSave);
        await window.electronAPI.saveLibraryData(GLOBAL_PEOPLE_KEY, this.state.people);
        await window.electronAPI.saveLibraryData(GLOBAL_FACE_CACHE_KEY, cacheEntries);
      } else if (typeof localStorage !== 'undefined') {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(dataToSave));
        localStorage.setItem(GLOBAL_PEOPLE_KEY, JSON.stringify(this.state.people));
        localStorage.setItem(GLOBAL_FACE_CACHE_KEY, JSON.stringify(cacheEntries));
      }
    } catch (err) {
      console.warn('Failed to save library state:', err);
    }
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

      return {
        ...newPhoto,
        isFavorite: newPhoto.isFavorite ?? existing?.isFavorite ?? false,
        faces,
        faceScanCompleted: Boolean(faceScanCompleted || (faces && faces.length > 0)),
        location: newPhoto.location || existing?.location,
        isExcluded: newPhoto.isExcluded ?? existing?.isExcluded,
        sharpnessScore: newPhoto.sharpnessScore ?? existing?.sharpnessScore,
      };
    });

    const finalDeduped = deduplicatePhotoList(preserved);
    this.state.photos = finalDeduped;
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
    const combined = [...this.state.photos, ...newPhotos];
    const deduped = deduplicatePhotoList(combined).sort(
      (a, b) => new Date(b.dateTaken).getTime() - new Date(a.dateTaken).getTime()
    );
    this.state.photos = deduped;
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

  public getRecentLibraries(): string[] {
    return this.state.recentLibraries || [];
  }

  public toggleFavorite(photoId: string) {
    const photo = this.state.photos.find((p) => p.id === photoId);
    if (photo) {
      photo.isFavorite = !photo.isFavorite;
      this.notify();
    }
  }

  public excludePhotos(photoIds: string[], exclude = true) {
    const idSet = new Set(photoIds);
    let changed = false;
    for (const photo of this.state.photos) {
      if (idSet.has(photo.id)) {
        photo.isExcluded = exclude;
        changed = true;
      }
    }
    if (changed) {
      this.state.places = groupPhotosByPlace(this.state.photos.filter((p) => !p.isExcluded));
      this.notify();
    }
  }

  public updatePhotoQuietly(updatedPhoto: Photo) {
    const idx = this.state.photos.findIndex((p) => p.id === updatedPhoto.id || p.filePath === updatedPhoto.filePath);
    if (idx >= 0) {
      this.state.photos[idx] = { ...this.state.photos[idx], ...updatedPhoto };
    }
  }

  public updatePhoto(updatedPhoto: Photo, recalculatePlaces = false) {
    const idx = this.state.photos.findIndex((p) => p.id === updatedPhoto.id || p.filePath === updatedPhoto.filePath);
    let locationChanged = recalculatePlaces;
    if (idx >= 0) {
      if (updatedPhoto.location && JSON.stringify(updatedPhoto.location) !== JSON.stringify(this.state.photos[idx].location)) {
        locationChanged = true;
      }
      this.state.photos[idx] = { ...this.state.photos[idx], ...updatedPhoto };
    }
    if (locationChanged) {
      this.state.places = groupPhotosByPlace(this.state.photos.filter((p) => !p.isExcluded));
    }
    this.notify();
  }

  public updatePhotos(updatedList: Photo[], recalculatePlaces = false) {
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
    this.state.photos = this.state.photos.filter((p) => !idSet.has(p.id));
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
    this.state.people = [...this.state.people];
    this.notify();
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
    for (const photo of this.state.photos) {
      photo.faces = [];
      photo.faceScanCompleted = false;
    }
    this.notify();
    this.savePersistedData();
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
      const { people, updatedFaces } = clusterFaces(this.state.faces, this.state.people, 0.55, false);
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
    const { people, updatedFaces } = clusterFaces(
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
    const { people, updatedFaces } = clusterFaces(this.state.faces, this.state.people);
    this.state.people = people;
    this.state.faces = updatedFaces;
    this.notify();

    // Propagate learned manual input to improve face detection across other photos!
    const propagation = this.propagateLearnedFaces(targetPerson.id);

    return { success: true, propagation };
  }

  public unassignFaceFromPerson(faceId: string): { success: boolean; photoName?: string; personName?: string } {
    let unassigned = false;
    let photoName: string | undefined;
    let personName: string | undefined;

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
      const { people, updatedFaces } = clusterFaces(this.state.faces, this.state.people, 0.55, false);
      this.state.people = people;
      this.state.faces = updatedFaces;
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
        }
      }
      this.notify();

      // Active learning: User confirmation anchors ground truth with 2.5x weight in centroid.
      // Automatically scan unassigned/unconfirmed library photos to improve recognition!
      if (face.personId) {
        propagation = this.propagateLearnedFaces(face.personId);
      }
    }
    return propagation;
  }

  public deleteFaceDetection(faceId: string) {
    this.state.faces = this.state.faces.filter((f) => f.id !== faceId);
    for (const photo of this.state.photos) {
      if (photo.faces) {
        photo.faces = photo.faces.filter((f) => f.id !== faceId);
      }
    }
    const { people, updatedFaces } = clusterFaces(this.state.faces, this.state.people);
    this.state.people = people;
    this.state.faces = updatedFaces;
    this.notify();
  }

  public updateFacesAndPeople(newFaces: DetectedFace[]) {
    // Merge new faces
    const faceMap = new Map(this.state.faces.map((f) => [f.id, f]));
    for (const f of newFaces) {
      faceMap.set(f.id, f);
    }
    const mergedFaces = Array.from(faceMap.values());

    const { people, updatedFaces } = clusterFaces(mergedFaces, this.state.people);
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
    const { people, updatedFaces } = clusterFaces(this.state.faces, remainingPeople, 0.55, false);
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

    const { people, updatedFaces } = clusterFaces(this.state.faces, this.state.people);
    this.state.people = people;
    this.state.faces = updatedFaces;
    photo.faces = updatedFaces.filter((f) => f.photoId === photoId);
    this.notify();

    return photo;
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
}

export const libraryStore = new LibraryManager();
