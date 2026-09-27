import { describe, it, expect, afterEach } from 'vitest';

// If the people registry fails to load, state.people is [] but is NOT the stored registry. Opening a
// folder afterwards (setPhotos) must not clear that: sending [] makes main wipe every person.
const PEOPLE_KEY = 'gphotos_people_v2';

describe('libraryStore people registry load failure', () => {
  let store: any;
  afterEach(() => {
    if (store?.saveDebounceTimer) clearTimeout(store.saveDebounceTimer);
    delete (globalThis as any).window;
  });

  it('never sends the people key after a failed people load, even after setPhotos', async () => {
    const saves: any[] = [];
    let failPeople = true;
    (globalThis as any).window = {
      addEventListener: () => {},
      electronAPI: {
        loadLibraryData: async (key: string) => {
          if (key === PEOPLE_KEY && failPeople) throw new Error('boom');
          return null;
        },
        saveLibraryData: async (key: string, data: any) => { saves.push({ key, data }); return true; },
      },
    };
    const { LibraryManager } = await import('../../src/renderer/src/services/libraryStore');
    store = new LibraryManager();
    await store.loadPersistedData();

    store.setPhotos([{ id: 'a', filePath: 'C:\p\a.jpg', fileName: 'a.jpg', fileSize: 1, dateTaken: '2026-01-01', year: 2026, month: 1, day: 1, isFavorite: false, faces: [] }], 'C:\p');
    if (store.saveDebounceTimer) clearTimeout(store.saveDebounceTimer);
    await store.persistNow();

    expect(saves.some((s) => s.key === 'gphotos_library_v1')).toBe(true); // photos still save
    expect(saves.some((s) => s.key === PEOPLE_KEY)).toBe(false);

    // A later successful people load re-enables people saves.
    failPeople = false;
    await store.loadGlobalCache();
    store.state.people = [{ id: 'p1', name: 'Ann', faceCount: 0, photoCount: 0 }];
    saves.length = 0;
    await store.persistNow();
    expect(saves.some((s) => s.key === PEOPLE_KEY)).toBe(true);
  });
});
