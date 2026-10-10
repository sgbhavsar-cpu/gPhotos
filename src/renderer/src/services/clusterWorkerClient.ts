// Thin client for clusterWorker.ts — runs the expensive clustering/matching computation on a
// background thread so a large library's worth of face/vector math can never freeze the renderer's
// one UI thread (confirmed via hang-watchdog.log: reassigning/confirming a single face could
// otherwise block input for 10+ seconds — see CODE_REVIEW §54/§55). Falls back to calling the pure
// functions directly, synchronously, when Worker isn't available at all (e.g. the vitest/jsdom test
// environment, or any future non-browser host) — same result either way, since both paths call the
// exact same pure functions in ./clustering.ts.
import type { DetectedFace, Person } from '../../../types';
import {
  clusterFaces as clusterFacesSync,
  matchUnassignedFacesToCentroid as matchUnassignedFacesToCentroidSync,
  DEFAULT_MATCH_THRESHOLD,
  type SlimPhotoForMatching,
} from './clustering';
import type { ClusterWorkerRequest, ClusterWorkerResponse } from './clusterWorker';
import ClusterWorkerCtor from './clusterWorker?worker';

let worker: Worker | null | undefined; // undefined = not yet tried, null = unavailable/permanently failed
let nextRequestId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function failAllPending(message: string): void {
  for (const [id, entry] of pending) {
    entry.reject(new Error(message));
    pending.delete(id);
  }
}

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    if (typeof Worker === 'undefined') {
      worker = null;
      return worker;
    }
    const w = new ClusterWorkerCtor();
    w.onmessage = (event: MessageEvent<ClusterWorkerResponse>) => {
      const data = event.data;
      const entry = pending.get(data.id);
      if (!entry) return;
      pending.delete(data.id);
      if ('error' in data) entry.reject(new Error(data.error));
      else entry.resolve(data.result);
    };
    w.onerror = () => {
      // A worker-level error (e.g. failed to even load the script) fails every still-pending
      // request — a single bad message's error is reported via postMessage's `error` field above
      // instead, without touching this handler. Also drop the worker itself: leaving `worker` set
      // to this same (now-dead) instance meant every call for the rest of the session kept posting
      // into it and piling up in `pending` forever (never resolving, never rejecting, never
      // removed) — resetting to `undefined` makes the next getWorker() call spin up a fresh one.
      try { w.terminate(); } catch {}
      if (worker === w) worker = undefined;
      failAllPending('Cluster worker error');
    };
    worker = w;
  } catch {
    worker = null;
  }
  return worker;
}

// A plain Omit<Union, 'id'> collapses the discriminated union's branches into one merged (and
// therefore wrong) shape; a distributive conditional type applies Omit to each branch separately
// first, keeping 'cluster'/'match' each with exactly their own fields.
type WithoutId<T> = T extends { id: number } ? Omit<T, 'id'> : never;

function callWorker<T>(message: WithoutId<ClusterWorkerRequest>): Promise<T> | null {
  const w = getWorker();
  if (!w) return null;
  const id = nextRequestId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    w.postMessage({ ...message, id } as ClusterWorkerRequest);
  });
}

export async function clusterFacesAsync(
  faces: DetectedFace[],
  people: Person[] = [],
  threshold: number = DEFAULT_MATCH_THRESHOLD,
  allowNewClusters: boolean = true
): Promise<{ people: Person[]; updatedFaces: DetectedFace[] }> {
  const viaWorker = callWorker<{ people: Person[]; updatedFaces: DetectedFace[] }>({
    type: 'cluster', faces, people, threshold, allowNewClusters,
  });
  if (viaWorker) {
    try {
      return await viaWorker;
    } catch {
      // Fall through to the synchronous path — a wedged/crashed worker must not leave every future
      // clustering call permanently broken for the rest of the session.
    }
  }
  return clusterFacesSync(faces, people, threshold, allowNewClusters);
}

export async function matchUnassignedFacesToCentroidAsync(
  photos: SlimPhotoForMatching[],
  personId: string,
  centroid: number[],
  threshold: number
): Promise<Array<{ photoId: string; faceId: string }>> {
  const viaWorker = callWorker<Array<{ photoId: string; faceId: string }>>({
    type: 'match', photos, personId, centroid, threshold,
  });
  if (viaWorker) {
    try {
      return await viaWorker;
    } catch {
      // same reasoning as clusterFacesAsync above
    }
  }
  return matchUnassignedFacesToCentroidSync(photos, personId, centroid, threshold);
}

/** Test-only: forces the next getWorker() call to re-evaluate Worker availability from scratch. */
export function resetClusterWorkerForTests(): void {
  try { worker?.terminate(); } catch {}
  worker = undefined;
  failAllPending('reset for tests');
}
