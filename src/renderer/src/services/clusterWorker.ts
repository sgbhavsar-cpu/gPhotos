// Runs clusterFaces/matchUnassignedFacesToCentroid OFF the renderer's one UI thread. Both are pure,
// environment-free functions (see clustering.ts — only numeric math, no window/electronAPI/DOM), so
// moving them here is a plain relocation, not a rewrite: identical inputs produce identical outputs
// whether called from here or from clusterWorkerClient.ts's synchronous fallback.
//
// Why this exists: confirmed via hang-watchdog.log during real use — reassigning or confirming a
// single face on a large library (tens of thousands of faces) ran this exact computation
// synchronously on the renderer's one thread and froze the entire app (every window, every click)
// for 10+ seconds, with Electron's own "RENDERER UNRESPONSIVE" firing. A per-chunk `setTimeout`
// yield (see CODE_REVIEW §54) helped but wasn't enough — the fix that actually guarantees the main
// thread can never block on this is to not run it there at all.
import { clusterFaces, matchUnassignedFacesToCentroid, DEFAULT_MATCH_THRESHOLD } from './clustering';
import type { DetectedFace, Person } from '../../../types';
import type { SlimPhotoForMatching } from './clustering';

export type ClusterWorkerRequest =
  | { id: number; type: 'cluster'; faces: DetectedFace[]; people: Person[]; threshold?: number; allowNewClusters?: boolean }
  | { id: number; type: 'match'; photos: SlimPhotoForMatching[]; personId: string; centroid: number[]; threshold: number };

export type ClusterWorkerResponse =
  | { id: number; result: { people: Person[]; updatedFaces: DetectedFace[] } }
  | { id: number; result: Array<{ photoId: string; faceId: string }> }
  | { id: number; error: string };

self.onmessage = (event: MessageEvent<ClusterWorkerRequest>) => {
  const req = event.data;
  try {
    if (req.type === 'cluster') {
      const result = clusterFaces(req.faces, req.people, req.threshold ?? DEFAULT_MATCH_THRESHOLD, req.allowNewClusters ?? true);
      (self as unknown as Worker).postMessage({ id: req.id, result } satisfies ClusterWorkerResponse);
    } else if (req.type === 'match') {
      const result = matchUnassignedFacesToCentroid(req.photos, req.personId, req.centroid, req.threshold);
      (self as unknown as Worker).postMessage({ id: req.id, result } satisfies ClusterWorkerResponse);
    }
  } catch (err: unknown) {
    const id = (req as { id?: number })?.id;
    if (typeof id === 'number') {
      (self as unknown as Worker).postMessage({ id, error: String((err as Error)?.message || err) } satisfies ClusterWorkerResponse);
    }
  }
};
