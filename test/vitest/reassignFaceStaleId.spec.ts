// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Reported bug: naming an "Unknown Person" face sometimes fails with "Face detection not found"
// even though the face is still visibly on screen. Root cause: an UNCONFIRMED face's id doesn't
// survive a rescan of its photo (detectAndMatchFacesForPhoto/applyServerDetectedFaces preserve only
// confirmed/manual faces as-is; everything else is replaced by freshly-detected faces under new
// ids) — so a screen that hasn't refreshed yet can submit a now-gone id. reassignFaceToPerson's
// optional staleIdFallback re-resolves by photo + screen position instead of failing outright.
describe('reassignFaceToPerson: recovering from a stale (rescanned-away) face id', () => {
  let mod: any;
  let store: any;

  beforeEach(async () => {
    (globalThis as any).window = {
      addEventListener: () => {},
      electronAPI: { loadLibraryData: async () => null, saveLibraryData: async () => true },
    };
    vi.resetModules();
    mod = await import('../../src/renderer/src/services/libraryStore');
    store = new mod.LibraryManager();
    await new Promise((r) => setTimeout(r, 20));
  });
  afterEach(() => {
    if (store?.saveDebounceTimer) clearTimeout(store.saveDebounceTimer);
    delete (globalThis as any).window;
  });

  const box = { x: 10, y: 20, width: 30, height: 40 };
  const load = (faceId: string) => {
    const face = { id: faceId, photoId: 'p1', box, descriptor: [0.1], confidence: 0.9, isConfirmed: false };
    const photo: any = { id: 'p1', filePath: 'C:\\p1.jpg', fileName: 'p1.jpg', fileSize: 1, dateTaken: '2026-01-01', year: 2026, month: 1, day: 1, faces: [face] };
    store.state.photos = [photo];
    store.state.faces = [face];
    store.state.people = [];
  };

  it('a live (still-present) face id reassigns normally — no fallback needed', async () => {
    load('face_old');
    const result = await store.reassignFaceToPerson('face_old', 'Alice', { photoId: 'p1', box });
    expect(result.success).toBe(true);
    expect(store.getState().faces[0].personId).toBeTruthy();
  });

  it('a stale id is recovered by matching the same photo + screen position, and the name is applied', async () => {
    load('face_new'); // a rescan already swapped the face the UI still thinks is "face_old" for this one
    const result = await store.reassignFaceToPerson('face_old', 'Alice', { photoId: 'p1', box });
    expect(result.success).toBe(true);
    const people = store.getState().people;
    expect(people).toHaveLength(1);
    expect(people[0].name).toBe('Alice');
    expect(store.getState().faces[0].personId).toBe(people[0].id);
  });

  it('without a fallback, a stale id still fails with the original error (unchanged behavior)', async () => {
    load('face_new');
    const result = await store.reassignFaceToPerson('face_old', 'Alice');
    expect(result).toEqual({ success: false, error: 'Face detection not found' });
  });

  it('a fallback that matches no face on that photo (box moved too far) fails with a clearer message', async () => {
    load('face_new');
    const result = await store.reassignFaceToPerson('face_old', 'Alice', { photoId: 'p1', box: { x: 900, y: 900, width: 10, height: 10 } });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/refreshed by a recent scan/i);
  });

  it('a fallback pointing at a different photo entirely is not mistaken for a match', async () => {
    load('face_new');
    const result = await store.reassignFaceToPerson('face_old', 'Alice', { photoId: 'other_photo', box });
    expect(result.success).toBe(false);
  });
});
