// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';

// clusterWorkerClient.ts is what actually keeps clustering/matching off the renderer's UI thread
// (see CODE_REVIEW §55) — a real Web Worker in the app, falling back to calling the identical pure
// functions in clustering.ts synchronously wherever Worker isn't available (this vitest/jsdom
// environment has no Worker global, same as it would for any other non-browser host). These tests
// exercise that fallback path directly, since every other spec touching libraryStore's face/cluster
// methods already goes through it implicitly.
describe('clusterWorkerClient: falls back to the synchronous functions when Worker is unavailable', () => {
  afterEach(() => {
    vi.resetModules();
  });

  const face = (id: string, personId: string | undefined, descriptor: number[]): any => ({
    id, photoId: `photo_${id}`, box: { x: 0, y: 0, width: 1, height: 1 }, descriptor, confidence: 0.9, isConfirmed: !!personId, personId,
  });

  it('clusterFacesAsync produces the same result as calling clusterFaces directly', async () => {
    const client = await import('../../src/renderer/src/services/clusterWorkerClient');
    const direct = await import('../../src/renderer/src/services/clustering');

    const faces = [face('a', 'p1', [1, 0, 0]), face('b', undefined, [0.99, 0.01, 0])];
    const people = [{ id: 'p1', name: 'Alice', faceCount: 1, photoCount: 1, createdAt: 'x' }];

    const viaClient = await client.clusterFacesAsync(faces, people);
    const viaDirect = direct.clusterFaces(
      faces.map((f) => ({ ...f })), // clusterFaces mutates in place — give it its own copies
      people.map((p) => ({ ...p }))
    );

    expect(viaClient.updatedFaces.map((f: any) => f.personId)).toEqual(viaDirect.updatedFaces.map((f) => f.personId));
    expect(viaClient.people.map((p: any) => p.id)).toEqual(viaDirect.people.map((p) => p.id));
  });

  it('matchUnassignedFacesToCentroidAsync produces the same result as calling matchUnassignedFacesToCentroid directly', async () => {
    const client = await import('../../src/renderer/src/services/clusterWorkerClient');
    const direct = await import('../../src/renderer/src/services/clustering');

    const photos = [
      { id: 'owner', faces: [{ id: 'af', personId: 'alice', isConfirmed: true, descriptor: [1, 0, 0] }] },
      { id: 'match', faces: [{ id: 'mf', personId: undefined, isConfirmed: false, descriptor: [0.99, 0.01, 0] }] },
      { id: 'nomatch', faces: [{ id: 'nf', personId: undefined, isConfirmed: false, descriptor: [0, 0, 1] }] },
    ];

    const viaClient = await client.matchUnassignedFacesToCentroidAsync(photos, 'alice', [1, 0, 0], 0.5);
    const viaDirect = direct.matchUnassignedFacesToCentroid(photos, 'alice', [1, 0, 0], 0.5);

    expect(viaClient).toEqual(viaDirect);
    expect(viaClient).toEqual([{ photoId: 'match', faceId: 'mf' }]);
  });

  it('a request made before Worker-availability is even checked still resolves correctly (no hang, no unhandled rejection)', async () => {
    const client = await import('../../src/renderer/src/services/clusterWorkerClient');
    await expect(client.clusterFacesAsync([], [])).resolves.toEqual({ people: [], updatedFaces: [] });
    await expect(client.matchUnassignedFacesToCentroidAsync([], 'alice', [1, 0, 0], 0.5)).resolves.toEqual([]);
  });
});
