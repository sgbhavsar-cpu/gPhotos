import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Guards the incremental autosave: only changed photos (and only changed
// people/face-cache) may cross IPC, removals must still fall back to a full
// replace, and a face result main already persisted must not be re-sent.
const PEOPLE_KEY = 'gphotos_people_v2';
const STORAGE_KEY = 'gphotos_library_v1';

function photo(id: string, extra: Record<string, any> = {}): any {
  return {
    id, filePath: `C:\\p\\${id}.jpg`, fileName: `${id}.jpg`, fileSize: 1, dateTaken: '2026-01-01',
    year: 2026, month: 1, day: 1, isFavorite: false, faces: [], ...extra,
  };
}

describe('libraryStore incremental autosave', () => {
  let store: any;
  let saves: Array<{ key: string; data: any }>;

  beforeEach(async () => {
    saves = [];
    (globalThis as any).window = {
      addEventListener: () => {},
      electronAPI: {
        loadLibraryData: async () => null,
        saveLibraryData: async (key: string, data: any) => { saves.push({ key, data }); return true; },
      },
    };
    vi.resetModules();
    const { LibraryManager } = await import('../../src/renderer/src/services/libraryStore');
    store = new LibraryManager();
    await new Promise((r) => setTimeout(r, 20)); // let constructor's loadPersistedData settle
    store.state.photos = [photo('a'), photo('b'), photo('c')];
    store.state.people = [{ id: 'p1', name: 'X', faceCount: 1, photoCount: 1 }];
    saves.length = 0;
  });

  afterEach(() => {
    if (store.saveDebounceTimer) clearTimeout(store.saveDebounceTimer);
    delete (globalThis as any).window;
  });

  const librarySave = () => saves.filter((s) => s.key === STORAGE_KEY).pop()!.data;

  it('sends everything on the first save (no baseline), then nothing when nothing changed', async () => {
    await store.persistNow();
    expect(librarySave().photos).toHaveLength(3);

    saves.length = 0;
    await store.persistNow();
    expect(librarySave().photos).toHaveLength(0);
    expect(librarySave().isPartialPageSet).toBe(true); // merge-only, never deletes
    expect(saves.some((s) => s.key === PEOPLE_KEY)).toBe(false); // unchanged people not re-sent
  });

  it('sends only the edited photo, and people only when they change', async () => {
    await store.persistNow();
    saves.length = 0;

    store.state.photos[1].isFavorite = true;
    await store.persistNow();
    expect(librarySave().photos.map((p: any) => p.id)).toEqual(['b']);

    saves.length = 0;
    store.state.people[0].name = 'Renamed';
    await store.persistNow();
    expect(saves.some((s) => s.key === PEOPLE_KEY)).toBe(true);
  });

  it('falls back to a full destructive-replace payload when a photo is removed', async () => {
    await store.persistNow();
    saves.length = 0;

    store.state.photos = store.state.photos.filter((p: any) => p.id !== 'c');
    await store.persistNow();
    expect(librarySave().photos).toHaveLength(2);
    expect(librarySave().isPartialPageSet).toBe(false); // main runs replaceAllPhotos -> deletes 'c'
  });

  it('a running scan (main already persisted people) does not trigger people/face-cache saves', async () => {
    await store.persistNow();
    saves.length = 0;

    // main returns the updated people list after each detection
    const updated = [{ ...store.state.people[0], faceCount: 2, photoCount: 2 }];
    store.applyServerDetectedFaces([{ photoId: 'a', faces: [], faceScanCompleted: true, facesLocked: false }], updated);
    store.state.photos[0].isFavorite = true; // and the user edits something
    await store.persistNow();
    expect(saves.map((s) => s.key)).toEqual([STORAGE_KEY]); // no people key, no face-cache key
  });

  it('still saves a pending people edit (rename) that arrives alongside a scan result', async () => {
    await store.persistNow();
    saves.length = 0;

    store.state.people[0].name = 'Renamed'; // unsaved user edit
    store.applyServerDetectedFaces([{ photoId: 'a', faces: [], faceScanCompleted: true, facesLocked: false }], [
      { ...store.state.people[0], name: 'Renamed', faceCount: 2 },
    ]);
    await store.persistNow();
    expect(saves.some((s) => s.key === PEOPLE_KEY)).toBe(true);
  });

  it('never saves or loads the legacy face-cache blob (it had grown to ~390MB, read+parsed at every launch)', async () => {
    const CACHE_KEY = 'gphotos_face_cache_v2';
    store.cachePhotoFaces(photo('a'), [{ id: 'f', photoId: 'a', box: { x: 0, y: 0, width: 1, height: 1 }, descriptor: [1], confidence: 1 }]);
    await store.persistNow();
    store.resetAllPeopleAndFaces();
    if (store.saveDebounceTimer) clearTimeout(store.saveDebounceTimer);
    await store.persistNow();
    // the only thing ever sent for that key is the one-time "replace the stale blob with []" from startup
    const sent = saves.filter((s) => s.key === CACHE_KEY);
    expect(sent.every((s) => Array.isArray(s.data) && s.data.length === 0)).toBe(true);
    // the in-memory, per-session cache still works
    store.cachePhotoFaces(photo('b'), [{ id: 'g', photoId: 'b', box: { x: 0, y: 0, width: 1, height: 1 }, descriptor: [1], confidence: 1 }]);
    expect(store.getCachedFaces(photo('b'))?.faces).toHaveLength(1);
  });

  it('does not ask main for the legacy face cache at startup', async () => {
    const loaded: string[] = [];
    (globalThis as any).window.electronAPI.loadLibraryData = async (key: string) => { loaded.push(key); return null; };
    await store.loadGlobalCache();
    expect(loaded).toContain('gphotos_people_v2');
    expect(loaded).not.toContain('gphotos_face_cache_v2');
  });

  it('does not re-send faces main already persisted, but still sends a pending edit', async () => {
    await store.persistNow();
    saves.length = 0;

    store.state.photos[2].isFavorite = true; // unsaved edit on c
    store.applyServerDetectedFaces(
      [
        { photoId: 'a', faces: [], faceScanCompleted: true, facesLocked: false },
        { photoId: 'c', faces: [], faceScanCompleted: true, facesLocked: false },
      ],
      store.state.people
    );
    await store.persistNow();
    expect(librarySave().photos.map((p: any) => p.id)).toEqual(['c']);
  });
});
