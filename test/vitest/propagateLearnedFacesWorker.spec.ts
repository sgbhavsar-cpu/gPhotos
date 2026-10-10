// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Reported bug: confirming or reassigning a single face froze the whole app ("Not Responding") for
// 10+ seconds on a large library. Root cause: propagateLearnedFaces scanned EVERY photo (two
// vector-distance computations per face) synchronously, on the renderer's one UI thread — nothing
// (clicks, repaints, even a "please wait" indicator) can run until a loop like that returns control.
// Confirmed via hang-watchdog.log: the main process logged nothing at all for the whole freeze (no
// stalls, no in-flight IPC) right up to Electron's own "RENDERER UNRESPONSIVE" event — i.e. the
// renderer's JS thread itself was stuck, not any IPC call.
//
// A first fix (yielding every 300 photos, see git history) helped but wasn't enough on its own — the
// real fix (this one) moves the computation to a Web Worker entirely (clusterWorker.ts /
// clusterWorkerClient.ts), so the main thread can never block on it regardless of library size. These
// tests check that propagateLearnedFaces/cluster() actually delegate through the client (the
// mechanism that matters now) rather than doing the O(photos) scan inline — and that results are
// unchanged either way (clusterWorkerClient's jsdom-environment fallback calls the exact same pure
// functions, covered end-to-end by faceClusteringEquivalence.spec.ts).
vi.mock('../../src/renderer/src/services/clusterWorkerClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/renderer/src/services/clusterWorkerClient')>();
  return {
    ...actual,
    clusterFacesAsync: vi.fn(actual.clusterFacesAsync),
    matchUnassignedFacesToCentroidAsync: vi.fn(actual.matchUnassignedFacesToCentroidAsync),
  };
});

describe('propagateLearnedFaces / cluster(): delegate to clusterWorkerClient instead of blocking the renderer thread', () => {
  let mod: any;
  let clientMod: any;
  let store: any;

  beforeEach(async () => {
    (globalThis as any).window = {
      addEventListener: () => {},
      electronAPI: { loadLibraryData: async () => null, saveLibraryData: async () => true },
    };
    vi.resetModules();
    mod = await import('../../src/renderer/src/services/libraryStore');
    clientMod = await import('../../src/renderer/src/services/clusterWorkerClient');
    store = new mod.LibraryManager();
    await new Promise((r) => setTimeout(r, 20));
  });
  afterEach(() => {
    if (store?.saveDebounceTimer) clearTimeout(store.saveDebounceTimer);
    delete (globalThis as any).window;
    vi.clearAllMocks();
  });

  const photo = (id: string, extra: Record<string, any> = {}): any => ({
    id, filePath: `C:\\${id}.jpg`, fileName: `${id}.jpg`, fileSize: 1, dateTaken: '2026-01-01',
    year: 2026, month: 1, day: 1, faces: [], ...extra,
  });

  it('propagateLearnedFaces calls matchUnassignedFacesToCentroidAsync (the worker-backed matcher), not an inline scan', async () => {
    const aliceFace = { id: 'af', photoId: 'owner', box: { x: 0, y: 0, width: 1, height: 1 }, descriptor: new Array(128).fill(0.1), confidence: 0.9, isConfirmed: true, personId: 'alice' };
    store.state.photos = [photo('owner', { faces: [aliceFace] })];
    store.state.faces = [aliceFace];
    store.state.people = [{ id: 'alice', name: 'Alice', faceCount: 1, photoCount: 1, createdAt: 'x' }];

    await store.propagateLearnedFaces('alice');

    expect(clientMod.matchUnassignedFacesToCentroidAsync).toHaveBeenCalledTimes(1);
  });

  it('reassignFaceToPerson calls clusterFacesAsync (the worker-backed clusterer), not an inline cluster() call', async () => {
    const face = { id: 'f1', photoId: 'p1', box: { x: 0, y: 0, width: 1, height: 1 }, descriptor: new Array(128).fill(0.1), confidence: 0.9, isConfirmed: false };
    store.state.photos = [photo('p1', { faces: [face] })];
    store.state.faces = [face];
    store.state.people = [];

    await store.reassignFaceToPerson('f1', 'Alice');
    // The re-cluster is backgrounded now (see CODE_REVIEW §58) — reassignFaceToPerson's own promise
    // resolves before clusterFacesAsync is even called, so wait for the background chain too.
    await store.backgroundClusterChain;

    expect(clientMod.clusterFacesAsync).toHaveBeenCalled();
  });

  it('still returns the same result (newlyAssignedCount / affectedPhotosCount) as before — delegating to the worker client changes nothing about behavior', async () => {
    const aliceFace = { id: 'af', photoId: 'owner', box: { x: 0, y: 0, width: 1, height: 1 }, descriptor: new Array(128).fill(0.1), confidence: 0.9, isConfirmed: true, personId: 'alice' };
    const matchingFace = { id: 'mf', photoId: 'match', box: { x: 0, y: 0, width: 1, height: 1 }, descriptor: new Array(128).fill(0.1), confidence: 0.9, isConfirmed: false };
    store.state.photos = [
      photo('owner', { faces: [aliceFace] }),
      photo('match', { faces: [matchingFace] }),
      ...Array.from({ length: 300 }, (_, i) => photo(`p${i}`)),
    ];
    store.state.faces = [aliceFace, matchingFace];
    store.state.people = [{ id: 'alice', name: 'Alice', faceCount: 1, photoCount: 1, createdAt: 'x' }];

    const result = await store.propagateLearnedFaces('alice');
    expect(result).toEqual({ newlyAssignedCount: 1, affectedPhotosCount: 1 });
    expect(store.getState().faces.find((f: any) => f.id === 'mf').personId).toBe('alice');
    // photo.faces must stay in sync with state.faces too (see cluster()'s resync loop) — this is the
    // exact invariant that silently broke for most of the library before the appendCatalogPage fix.
    const matchPhoto = store.getState().photos.find((p: any) => p.id === 'match');
    expect(matchPhoto.faces.find((f: any) => f.id === 'mf').personId).toBe('alice');
  });
});
