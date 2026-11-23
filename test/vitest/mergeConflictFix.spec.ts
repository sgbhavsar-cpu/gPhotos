import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// "Mark as unknown" resolves a blocked merge: in every photo where both people appear, one person's faces go back to unknown
// and the photo is queued for the idle face scan again; afterwards the merge is allowed.
function photo(id: string, faces: any[]): any {
  return { id, filePath: `C:\\p\\${id}.jpg`, fileName: `${id}.jpg`, fileSize: 1, dateTaken: '2026-01-01', year: 2026, month: 1, day: 1, isFavorite: false, faceScanCompleted: true, facesLocked: true, faces };
}
const face = (id: string, photoId: string, personId?: string): any => ({ id, photoId, personId, isConfirmed: !!personId, box: { x: 0, y: 0, width: 1, height: 1 }, descriptor: [] });

describe('merge conflict fix', () => {
  let store: any;

  beforeEach(async () => {
    (globalThis as any).window = { addEventListener: () => {}, electronAPI: { loadLibraryData: async () => null, saveLibraryData: async () => true } };
    vi.resetModules();
    const { LibraryManager } = await import('../../src/renderer/src/services/libraryStore');
    store = new LibraryManager();
    await new Promise((r) => setTimeout(r, 20));
    store.state.people = [{ id: 'A', name: 'Ann', faceCount: 0, photoCount: 0 }, { id: 'B', name: 'Annie', faceCount: 0, photoCount: 0 }];
    store.state.faces = [face('f1', 'p1', 'A'), face('f2', 'p1', 'B'), face('f3', 'p2', 'A'), face('f4', 'p2', 'B'), face('f5', 'p3', 'B')];
    store.state.photos = [
      photo('p1', [store.state.faces[0], store.state.faces[1]]),
      photo('p2', [store.state.faces[2], store.state.faces[3]]),
      photo('p3', [store.state.faces[4]]),
    ];
  });
  afterEach(() => { if (store.saveDebounceTimer) clearTimeout(store.saveDebounceTimer); delete (globalThis as any).window; });

  it('finds the conflicting photos and blocks the merge', () => {
    expect(store.getMergeConflictPhotos('A', 'B').map((p: any) => p.id)).toEqual(['p1', 'p2']);
    expect(store.canMergePeople('A', 'B').canMerge).toBe(false);
  });

  it('marking B unknown clears B only in the conflicting photos, queues them for a re-scan, and unblocks the merge', async () => {
    expect(store.markPersonUnknownWhereBothAppear('B', 'A')).toBe(2);
    const byId = (id: string) => store.state.photos.find((p: any) => p.id === id);
    for (const id of ['p1', 'p2']) {
      expect(byId(id).faces.map((f: any) => f.personId)).toEqual(['A', undefined]); // A kept, B now unknown
      expect(byId(id).faces[1]).toMatchObject({ isConfirmed: false, box: { width: 1 } }); // box kept
      expect(byId(id).faceScanCompleted).toBe(false);
      expect(byId(id).facesLocked).toBe(false);
    }
    expect(byId('p3').faces[0].personId).toBe('B');   // untouched
    expect(byId('p3').faceScanCompleted).toBe(true);
    expect(store.state.faces.filter((f: any) => f.personId === 'B').map((f: any) => f.id)).toEqual(['f5']);
    expect(store.canMergePeople('A', 'B').canMerge).toBe(true);
    expect(await store.mergePeople('A', 'B')).toBe(true);
  });

  it('with no conflict it changes nothing', () => {
    expect(store.markPersonUnknownWhereBothAppear('B', 'A')).toBe(2);
    expect(store.markPersonUnknownWhereBothAppear('B', 'A')).toBe(0);
  });
});
