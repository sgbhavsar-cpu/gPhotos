import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { computeQualityWeightedCentroid } from '../../src/renderer/src/services/clustering';

// Regression test for CODE_REVIEW §59: addManualFace used to default a face with no computable
// descriptor (e.g. tagging someone shown from behind) to `new Array(128).fill(0)`. The real
// recognition model produces 512-d embeddings, so that 128-length fake not only failed to act as a
// harmless placeholder — if it happened to sort first in a person's face list, EVERY real 512-d
// exemplar for that person was silently dropped from computeQualityWeightedCentroid (dimension
// mismatch), permanently breaking that person's future matching. Fixed to use an empty array, which
// every distance/centroid function already treats as "no exemplar" via a `length > 0` guard.
describe('addManualFace with no computable descriptor (CODE_REVIEW §59)', () => {
  (globalThis as any).window = { addEventListener: () => {}, electronAPI: { loadLibraryData: async () => null, saveLibraryData: async () => true } };
  let mod: any;
  let store: any;

  beforeEach(async () => {
    vi.resetModules();
    mod = await import('../../src/renderer/src/services/libraryStore');
    store = new mod.LibraryManager();
    await new Promise((r) => setTimeout(r, 20));
  });
  afterEach(() => {
    if (store?.saveDebounceTimer) clearTimeout(store.saveDebounceTimer);
  });

  const photo = (id: string): any => ({
    id, filePath: `C:\\${id}.jpg`, fileName: `${id}.jpg`, fileSize: 1, dateTaken: '2026-01-01',
    year: 2026, month: 1, day: 1, faces: [],
  });

  it('gets an empty descriptor, not a wrong-length zero-filled one', () => {
    store.state.photos = [photo('p1')];
    const face = store.addManualFace('p1', { x: 0, y: 0, width: 10, height: 10 }); // no descriptor arg — box had no detectable face
    expect(face.descriptor).toEqual([]);
  });

  it('a real 512-d descriptor is kept as-is (previously discarded for not being exactly 128)', () => {
    store.state.photos = [photo('p1')];
    const real = new Array(512).fill(0.01);
    const face = store.addManualFace('p1', { x: 0, y: 0, width: 10, height: 10 }, real);
    expect(face.descriptor).toBe(real);
  });

  it("doesn't wipe out a person's real exemplars even if the no-descriptor tag sorts first in the list", () => {
    const realDescriptor = new Array(512).fill(0);
    realDescriptor[0] = 1; // a distinct real embedding
    const noDescriptorFace: any = { id: 'f1', photoId: 'p1', box: { x: 0, y: 0, width: 10, height: 10 }, descriptor: [], confidence: 1.0, isConfirmed: true, isManual: true, personId: 'alice' };
    const realFace: any = { id: 'f2', photoId: 'p2', box: { x: 0, y: 0, width: 50, height: 50 }, descriptor: realDescriptor, confidence: 0.9, isConfirmed: true, personId: 'alice' };

    // The no-descriptor face sorts first — this is exactly the ordering that broke before the fix.
    const centroid = computeQualityWeightedCentroid([noDescriptorFace, realFace]);

    expect(centroid.length).toBe(512); // not discarded down to a degenerate/empty result
    expect(centroid[0]).toBeGreaterThan(0.9); // still points at the real exemplar's direction
  });
});
