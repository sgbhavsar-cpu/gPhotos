import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The window's in-memory copy must follow what the main process did to the database (second pass / reset), or the next autosave
// would write the stale copy straight back.
const face = (id: string, photoId: string, extra: Record<string, any> = {}): any => ({ id, photoId, box: { x: 0, y: 0, width: 1, height: 1 }, descriptor: [], isConfirmed: false, ...extra });
const photo = (id: string, faces: any[], extra: Record<string, any> = {}): any => ({
  id, filePath: `C:\\p\\${id}.jpg`, fileName: `${id}.jpg`, fileSize: 1, dateTaken: '2026-01-01', year: 2026, month: 1, day: 1, isFavorite: false,
  faceScanCompleted: true, facesLocked: false, faces, ...extra,
});

describe('libraryStore face actions', () => {
  let store: any;
  beforeEach(async () => {
    (globalThis as any).window = { addEventListener: () => {}, electronAPI: { loadLibraryData: async () => null, saveLibraryData: async () => true } };
    vi.resetModules();
    const { LibraryManager } = await import('../../src/renderer/src/services/libraryStore');
    store = new LibraryManager();
    await new Promise((r) => setTimeout(r, 20));
    store.state.people = [{ id: 'A', name: 'Ann', faceCount: 0, photoCount: 0 }];
  });
  afterEach(() => { if (store.saveDebounceTimer) clearTimeout(store.saveDebounceTimer); delete (globalThis as any).window; });

  it('applyFaceAssignments gives unknown faces to their person, unconfirmed, and never overrides a face somebody already has', () => {
    const f1 = face('f1', 'p1'), f2 = face('f2', 'p2', { personId: 'B', isConfirmed: true });
    store.state.faces = [f1, f2];
    store.state.photos = [photo('p1', [f1]), photo('p2', [f2])];
    const n = store.applyFaceAssignments([{ faceId: 'f1', photoId: 'p1', personId: 'A' }, { faceId: 'f2', photoId: 'p2', personId: 'A' }]);
    expect(n).toBe(1);
    expect(store.state.photos[0].faces[0]).toMatchObject({ personId: 'A', isConfirmed: false });
    expect(store.state.photos[1].faces[0]).toMatchObject({ personId: 'B', isConfirmed: true });
    expect(store.state.faces.find((f: any) => f.id === 'f1')).toMatchObject({ personId: 'A' });
    expect(store.applyFaceAssignments([])).toBe(0);
  });

  it('getFaceIdsOfPerson lists every face of a person', () => {
    const fa = face('fa', 'p1', { personId: 'A' }), fb = face('fb', 'p1', { personId: 'B' });
    store.state.faces = [fa];
    store.state.photos = [photo('p1', [fa, fb]), photo('p2', [face('fc', 'p2', { personId: 'A' })])];
    expect(store.getFaceIdsOfPerson('A').sort()).toEqual(['fa', 'fc']);
  });

  it('applyFaceReset drops automatic faces of that storage only, keeps confirmed ones, and queues photos for a new scan', () => {
    const auto = face('a1', 'p1', { personId: 'A' }), confirmed = face('c1', 'p2', { personId: 'A', isConfirmed: true }), otherStorage = face('o1', 'p3', { personId: 'A' });
    store.state.faces = [auto, confirmed, otherStorage];
    store.state.photos = [
      photo('p1', [auto], { storageName: 'M', isVirtual: true }),
      photo('p2', [confirmed, face('a2', 'p2')], { storageName: 'M', isVirtual: true }),
      photo('p3', [otherStorage], { storageName: 'Other', isVirtual: true }),
      photo('p4', [], { storageName: 'M', isVirtual: true }),
      photo('p5', [confirmed], { storageName: 'M', isVirtual: true, facesLocked: true }),
      photo('v', [], { storageName: 'M', isVirtual: true, isVideo: true }),
    ];
    store.applyFaceReset('M', false);
    const by = (id: string) => store.state.photos.find((p: any) => p.id === id);
    expect(by('p1')).toMatchObject({ faces: [], faceScanCompleted: false, facesLocked: false });
    expect(by('p2').faces.map((f: any) => f.id)).toEqual(['c1']);
    expect(by('p2').faceScanCompleted).toBe(false);
    expect(by('p4').faceScanCompleted).toBe(false);
    expect(by('p5')).toMatchObject({ faceScanCompleted: true, facesLocked: true });   // all faces confirmed: stays done
    expect(by('p3').faces).toHaveLength(1);                                          // another storage: untouched
    expect(by('v').faceScanCompleted).toBe(true);                                    // videos: untouched
    expect(store.state.faces.map((f: any) => f.id).sort()).toEqual(['c1', 'o1']);

    store.applyFaceReset('M', true);
    expect(by('p5')).toMatchObject({ faces: [], faceScanCompleted: false, facesLocked: false });
    expect(by('p2').faces).toEqual([]);
  });
});
