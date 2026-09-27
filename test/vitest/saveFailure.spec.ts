import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// A save main reports as failed (it resolves false, it doesn't throw) must not be treated as saved:
// the same changes have to go out again, the failure must reach the user, and photos the user
// removed must be sent as removedIds so the database can delete them.
const STORAGE_KEY = 'gphotos_library_v1';

function photo(id: string): any {
  return {
    id, filePath: `C:\\p\\${id}.jpg`, fileName: `${id}.jpg`, fileSize: 1, dateTaken: '2026-01-01',
    year: 2026, month: 1, day: 1, isFavorite: false, faces: [],
  };
}

describe('libraryStore save failures', () => {
  let store: any;
  let notices: any;
  let saves: any[];
  let result: boolean;

  beforeEach(async () => {
    saves = [];
    result = true;
    (globalThis as any).window = {
      addEventListener: () => {},
      electronAPI: {
        loadLibraryData: async () => null,
        saveLibraryData: async (key: string, data: any) => { saves.push({ key, data }); return result; },
      },
    };
    const { LibraryManager } = await import('../../src/renderer/src/services/libraryStore');
    notices = await import('../../src/renderer/src/services/notifications');
    store = new LibraryManager();
    store.state.photos = [photo('a'), photo('b')];
    await store.persistNow(); // baseline
    saves.length = 0;
  });

  afterEach(() => {
    if (store.saveDebounceTimer) clearTimeout(store.saveDebounceTimer);
    delete (globalThis as any).window;
  });

  it('keeps unsaved edits pending, tells the user, and re-sends them on the next save', async () => {
    store.state.photos[0].isFavorite = true;
    result = false;
    await store.persistNow();
    expect(notices.getNotices().some((n: any) => n.kind === 'error' && /save/i.test(n.message))).toBe(true);

    saves.length = 0;
    result = true;
    await store.persistNow();
    const sent = saves.find((s) => s.key === STORAGE_KEY).data.photos.map((p: any) => p.id);
    expect(sent).toEqual(['a']);
  });

  it('sends removed photo ids and keeps them until a save succeeds', async () => {
    store.removePhotos(['b']);
    if (store.saveDebounceTimer) clearTimeout(store.saveDebounceTimer);
    result = false;
    await store.persistNow();
    saves.length = 0;
    result = true;
    await store.persistNow();
    expect(saves.find((s) => s.key === STORAGE_KEY).data.removedIds).toEqual(['b']);
    saves.length = 0;
    await store.persistNow();
    expect(saves.find((s) => s.key === STORAGE_KEY).data.removedIds).toBeUndefined();
  });

  it('does not save over the library after a failed load', async () => {
    (globalThis as any).window.electronAPI.loadLibraryData = async () => { throw new Error('boom'); };
    await store.loadPersistedData();
    saves.length = 0;
    store.state.photos[0].isFavorite = true;
    await store.persistNow();
    expect(saves).toHaveLength(0);
  });
});
