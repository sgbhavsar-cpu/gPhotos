import { describe, it, expect, afterEach } from 'vitest';
import { DetectedFace, Person } from '../../src/types';
import {
  clusterFaces as newMainCluster,
  FaceClusterSession,
  peopleNeedingWrite,
  DEFAULT_MATCH_THRESHOLD,
} from '../../src/main/services/faceClustering';
import { clusterFaces as newRendererCluster } from '../../src/renderer/src/services/clustering';

// Equivalence tests: the optimised clusterFaces (main + renderer) and the
// incremental FaceClusterSession must return EXACTLY what the original
// brute-force implementations did. The originals are kept verbatim below as
// oracles (do not "improve" them). Data is synthetic but shaped like real
// embeddings: identity clusters of noisy unit vectors, several faces per photo,
// user-confirmed / manual faces, stale personIds, duplicates and outliers.


// ---- ORACLE: verbatim copies of the pre-optimisation implementations (main + renderer) ----
const O_DEFAULT_THRESHOLD = 1.1;
function oNormalize(vec: number[]): number[] {
  if (!vec || vec.length === 0) return [];
  let sumSq = 0;
  for (let i = 0; i < vec.length; i++) {
    sumSq += vec[i] * vec[i];
  }
  const norm = Math.sqrt(sumSq) || 1e-10;
  return vec.map((v) => v / norm);
}

/**
 * Standard Euclidean distance between two embedding vectors.
 */
function oEuclid(a: number[], b: number[]): number {
  if (!a || !b || a.length !== b.length || a.length === 0) return 1.0;
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

function oCentroid(faces: DetectedFace[]): number[] {
  if (!faces || faces.length === 0) return [];
  const validFaces = faces.filter((f) => f.descriptor && f.descriptor.length > 0);
  if (validFaces.length === 0) return [];

  const dim = validFaces[0].descriptor.length;
  const sum = new Array(dim).fill(0);
  let totalWeight = 0;

  for (const face of validFaces) {
    if (face.descriptor.length !== dim) continue;

    // 1. Detection confidence (defaults to 0.7 if unrecorded)
    const conf = typeof face.confidence === 'number' ? face.confidence : 0.7;

    // 2. User confirmation / manual tag multiplier: 2.5x
    const confirmWeight = face.isConfirmed || face.isManual ? 2.5 : 1.0;

    // 3. Face size / resolution weight: larger face crops carry higher detail
    let sizeWeight = 1.0;
    if (face.box && face.box.width && face.box.height) {
      const area = Math.sqrt(face.box.width * face.box.height);
      sizeWeight = Math.min(1.5, Math.max(0.6, area / 100));
    }

    const weight = conf * confirmWeight * sizeWeight;
    const normalized = oNormalize(face.descriptor);

    for (let i = 0; i < dim; i++) {
      sum[i] += normalized[i] * weight;
    }
    totalWeight += weight;
  }

  if (totalWeight < 1e-10) {
    return oNormalize(validFaces[0].descriptor);
  }

  return oNormalize(sum);
}


function oldMainCluster(
  allFaces: DetectedFace[],
  existingPeople: Person[] = [],
  threshold = O_DEFAULT_THRESHOLD,
  allowNewClusters = true
): { people: Person[]; updatedFaces: DetectedFace[] } {
  const peopleMap = new Map<string, Person>();
  const personFaces = new Map<string, DetectedFace[]>();
  const updatedFaces = [...allFaces];

  // Track which persons are assigned to each photo to prevent duplicate identities per photo
  // personId -> the face holding it, per photo
  const photoAssignedPeople = new Map<string, Map<string, DetectedFace>>();
  // A user-confirmed / manually tagged face is the user's own decision and is
  // never unassigned by this automatic pass.
  const isProtected = (f: DetectedFace) => !!(f.isConfirmed || f.isManual);

  // Initialize with existing known people
  for (const person of existingPeople) {
    peopleMap.set(person.id, { ...person, faceCount: 0, photoCount: 0 });
    personFaces.set(person.id, []);
  }

  // Populate known person faces and validate existing face assignments for single-photo uniqueness
  for (const face of updatedFaces) {
    if (face.personId && peopleMap.has(face.personId)) {
      if (!photoAssignedPeople.has(face.photoId)) {
        photoAssignedPeople.set(face.photoId, new Map());
      }
      const assignedInPhoto = photoAssignedPeople.get(face.photoId)!;
      const holder = assignedInPhoto.get(face.personId);

      if (holder && !isProtected(face)) {
        // CONFLICT: This photo already has another face assigned to this person!
        // Unassign this conflicting face so it can be re-assigned or placed in a new cluster
        face.personId = undefined;
      } else if (holder && !isProtected(holder)) {
        // The earlier holder is an unconfirmed guess but this face is the user's own
        // assignment — the guess gives way, not the user's choice.
        const list = personFaces.get(face.personId);
        if (list) {
          const at = list.indexOf(holder);
          if (at >= 0) list.splice(at, 1);
        }
        holder.personId = undefined;
        assignedInPhoto.set(face.personId, face);
        personFaces.get(face.personId)?.push(face);
      } else {
        // No conflict (or both faces are user-confirmed: keep the user's data as-is).
        if (!holder) assignedInPhoto.set(face.personId, face);
        if (personFaces.has(face.personId)) {
          personFaces.get(face.personId)!.push(face);
        }
      }
    }
  }

  let nextPersonIndex = existingPeople.length + 1;
  const centroidCache = new Map<string, number[]>();

  for (let i = 0; i < updatedFaces.length; i++) {
    const face = updatedFaces[i];
    // A face that already carries SOME personId is left alone here, even if
    // that person doesn't happen to be in this call's existingPeople list
    // (e.g. it's a cross-library face, or the two got out of sync for any
    // other reason) — it must NOT fall through to the "no match found"
    // branch below. Every call to this function re-clusters the full
    // existing face set (not just newly-added faces), so previously this
    // re-ran the full O(people x exemplars) search AND minted a brand new
    // throwaway "Person N" for every such face, on every single call —
    // measured against a real 1,418-face library, that cost over a second
    // of blocking main-thread time per photo synced, and silently churned
    // out hundreds of duplicate person records over repeated syncs.
    if (face.personId) {
      continue;
    }

    if (!photoAssignedPeople.has(face.photoId)) {
      photoAssignedPeople.set(face.photoId, new Map());
    }
    const assignedInThisPhoto = photoAssignedPeople.get(face.photoId)!;

    // Find closest matching person whose identity is NOT already in this same photo
    let bestMatchPersonId: string | null = null;
    let minDistance = Infinity;

    for (const [personId, assignedList] of personFaces.entries()) {
      // RULE: One photo cannot have two faces of the same person!
      if (assignedInThisPhoto.has(personId)) {
        continue;
      }

      // Compute distance against quality-weighted centroid
      if (assignedList.length > 0) {
        // Memoized per person for this call (invalidated when a face joins
        // them below) — recomputing every person's centroid for every new
        // face re-normalized the whole library's descriptors each time.
        let centroid = centroidCache.get(personId);
        if (!centroid) {
          centroid = oCentroid(assignedList);
          centroidCache.set(personId, centroid);
        }
        const centroidDist = oEuclid(face.descriptor, centroid);
        if (centroidDist < minDistance) {
          minDistance = centroidDist;
          if (centroidDist < threshold) {
            bestMatchPersonId = personId;
          }
        }

        // Also check against individual confirmed exemplars
        for (const exemplar of assignedList) {
          const dist = oEuclid(face.descriptor, exemplar.descriptor);
          if (dist < minDistance) {
            minDistance = dist;
            if (dist < threshold) {
              bestMatchPersonId = personId;
            }
          }
        }
      }
    }

    if (bestMatchPersonId) {
      face.personId = bestMatchPersonId;
      personFaces.get(bestMatchPersonId)!.push(face);
      centroidCache.delete(bestMatchPersonId);
      assignedInThisPhoto.set(bestMatchPersonId, face);
    } else if (allowNewClusters) {
      // Create new person cluster. Seeded off this face's own (stable,
      // DB-persisted) id rather than Date.now() — see the matching
      // reconciliation copy in src/renderer/src/services/clustering.ts for
      // why: two independent runs (e.g. a background scan here and a
      // renderer session's own reconciliation) inventing "the same" new
      // person for the same unassigned face must derive the same id, or the
      // merge-only people upsert (never deletes) keeps both as duplicates.
      const newPersonId = `person_${face.id}`;
      const newPerson: Person = {
        id: newPersonId,
        name: `Person ${nextPersonIndex}`,
        coverFaceId: face.id,
        coverPhotoId: face.photoId,
        faceCount: 0,
        photoCount: 0,
        createdAt: new Date().toISOString(),
      };
      nextPersonIndex++;

      peopleMap.set(newPersonId, newPerson);
      personFaces.set(newPersonId, [face]);
      face.personId = newPersonId;
      assignedInThisPhoto.set(newPersonId, face);
    } else {
      face.personId = undefined;
    }
  }

  // Recalculate face counts and unique photos per person
  const personPhotoSets = new Map<string, Set<string>>();
  for (const pId of peopleMap.keys()) {
    personPhotoSets.set(pId, new Set());
  }

  for (const face of updatedFaces) {
    if (face.personId && peopleMap.has(face.personId)) {
      const person = peopleMap.get(face.personId)!;
      person.faceCount++;
      personPhotoSets.get(face.personId)?.add(face.photoId);
      if (!person.coverFaceId) {
        person.coverFaceId = face.id;
        person.coverPhotoId = face.photoId;
      }
    }
  }

  for (const [pId, photoSet] of personPhotoSets.entries()) {
    if (peopleMap.has(pId)) {
      peopleMap.get(pId)!.photoCount = photoSet.size;
    }
  }

  return {
    // A real, user-given name (anything but the auto-assigned "Person N"
    // placeholder) is always kept, even at 0 faces — a named person the
    // user cares about should never vanish as a side effect of some
    // unrelated face losing its assignment elsewhere. A generic placeholder
    // has no such claim: once it has no faces left, it's just orphaned
    // scaffolding, whether it was invented moments ago in this same pass or
    // pre-existed this call. Previously ANY pre-existing person was exempt
    // from pruning regardless of name, which is exactly what left a stale,
    // empty "Person N" behind forever whenever its one face got reassigned
    // (e.g. naming it from within a photo) or unassigned elsewhere. Must
    // stay in sync with the renderer's copy in clustering.ts.
    people: Array.from(peopleMap.values()).filter((p) => {
      if (p.faceCount > 0) return true;
      const isGenericName = /^Person(\s+\d+)?$/i.test(p.name.trim());
      return !isGenericName;
    }),
    updatedFaces,
  };
}

function oldRendererCluster(
  allFaces: DetectedFace[],
  existingPeople: Person[] = [],
  threshold = O_DEFAULT_THRESHOLD,
  allowNewClusters = true
): { people: Person[]; updatedFaces: DetectedFace[] } {
  const peopleMap = new Map<string, Person>();
  const personFaces = new Map<string, DetectedFace[]>();
  const updatedFaces = [...allFaces];

  // Track which persons are assigned to each photo to prevent duplicate identities per photo
  const photoAssignedPeople = new Map<string, Set<string>>();

  // Initialize with existing known people
  for (const person of existingPeople) {
    peopleMap.set(person.id, { ...person, faceCount: 0, photoCount: 0 });
    personFaces.set(person.id, []);
  }

  // Populate known person faces and validate existing face assignments for single-photo uniqueness
  for (const face of updatedFaces) {
    if (face.personId && peopleMap.has(face.personId)) {
      if (!photoAssignedPeople.has(face.photoId)) {
        photoAssignedPeople.set(face.photoId, new Set());
      }
      const assignedInPhoto = photoAssignedPeople.get(face.photoId)!;

      if (assignedInPhoto.has(face.personId)) {
        // CONFLICT: This photo already has another face assigned to this person!
        // Unassign this conflicting face so it can be re-assigned or placed in a new cluster
        face.personId = undefined;
      } else {
        assignedInPhoto.add(face.personId);
        if (personFaces.has(face.personId)) {
          personFaces.get(face.personId)!.push(face);
        }
      }
    }
  }

  let nextPersonIndex = existingPeople.length + 1;

  for (let i = 0; i < updatedFaces.length; i++) {
    const face = updatedFaces[i];
    // A face that already carries SOME personId is left alone here, even if
    // that person doesn't happen to be in this call's existingPeople list —
    // it must NOT fall through to the "no match found" branch below. See
    // src/main/services/faceClustering.ts for the full explanation: this
    // used to re-run the full O(people x exemplars) search AND mint a brand
    // new throwaway "Person N" for every such face, on every single call,
    // which is expensive CPU work running on the UI thread here.
    if (face.personId) {
      continue;
    }

    if (!photoAssignedPeople.has(face.photoId)) {
      photoAssignedPeople.set(face.photoId, new Set());
    }
    const assignedInThisPhoto = photoAssignedPeople.get(face.photoId)!;

    // Find closest matching person whose identity is NOT already in this same photo
    let bestMatchPersonId: string | null = null;
    let minDistance = Infinity;

    for (const [personId, assignedList] of personFaces.entries()) {
      // RULE: One photo cannot have two faces of the same person!
      if (assignedInThisPhoto.has(personId)) {
        continue;
      }

      // Compute distance against quality-weighted centroid
      if (assignedList.length > 0) {
        const centroid = oCentroid(assignedList);
        const centroidDist = oEuclid(face.descriptor, centroid);
        if (centroidDist < minDistance) {
          minDistance = centroidDist;
          if (centroidDist < threshold) {
            bestMatchPersonId = personId;
          }
        }

        // Also check against individual confirmed exemplars
        for (const exemplar of assignedList) {
          const dist = oEuclid(face.descriptor, exemplar.descriptor);
          if (dist < minDistance) {
            minDistance = dist;
            if (dist < threshold) {
              bestMatchPersonId = personId;
            }
          }
        }
      }
    }

    if (bestMatchPersonId) {
      face.personId = bestMatchPersonId;
      personFaces.get(bestMatchPersonId)!.push(face);
      assignedInThisPhoto.add(bestMatchPersonId);
    } else if (allowNewClusters) {
      // Create new person cluster. Seeded off this face's own (stable,
      // DB-persisted) id rather than Date.now() — this reconciliation runs
      // independently in every session that loads the library (desktop
      // window, each mobile browser tab), so two sessions inventing "the
      // same" new person for the same unassigned face must derive the same
      // id, or the merge-only people upsert (never deletes — see
      // storageHandlers.ts) permanently keeps both as separate duplicates.
      const newPersonId = `person_${face.id}`;
      const newPerson: Person = {
        id: newPersonId,
        name: `Person ${nextPersonIndex}`,
        coverFaceId: face.id,
        coverPhotoId: face.photoId,
        faceCount: 0,
        photoCount: 0,
        createdAt: new Date().toISOString(),
      };
      nextPersonIndex++;

      peopleMap.set(newPersonId, newPerson);
      personFaces.set(newPersonId, [face]);
      face.personId = newPersonId;
      assignedInThisPhoto.add(newPersonId);
    } else {
      face.personId = undefined;
    }
  }

  // Recalculate face counts and unique photos per person
  const personPhotoSets = new Map<string, Set<string>>();
  for (const pId of peopleMap.keys()) {
    personPhotoSets.set(pId, new Set());
  }

  for (const face of updatedFaces) {
    if (face.personId && peopleMap.has(face.personId)) {
      const person = peopleMap.get(face.personId)!;
      person.faceCount++;
      personPhotoSets.get(face.personId)?.add(face.photoId);
      if (!person.coverFaceId) {
        person.coverFaceId = face.id;
        person.coverPhotoId = face.photoId;
      }
    }
  }

  for (const [pId, photoSet] of personPhotoSets.entries()) {
    if (peopleMap.has(pId)) {
      peopleMap.get(pId)!.photoCount = photoSet.size;
    }
  }

  return {
    // A real, user-given name (anything but the auto-assigned "Person N"
    // placeholder) is always kept, even at 0 faces — a named person the
    // user cares about should never vanish as a side effect of some
    // unrelated face losing its assignment elsewhere. A generic placeholder
    // has no such claim: once it has no faces left, it's just orphaned
    // scaffolding, whether it was invented moments ago in this same pass or
    // pre-existed this call. Previously ANY pre-existing person was exempt
    // from pruning regardless of name, which is exactly what left a stale,
    // empty "Person N" behind forever whenever its one face got reassigned
    // (e.g. naming it from within a photo) or unassigned elsewhere.
    people: Array.from(peopleMap.values()).filter((p) => {
      if (p.faceCount > 0) return true;
      const isGenericName = /^Person(\s+\d+)?$/i.test(p.name.trim());
      return !isGenericName;
    }),
    updatedFaces,
  };
}



// ---- synthetic data ----------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(r: () => number): number {
  return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
}

function unitVec(dim: number, r: () => number): number[] {
  const v = Array.from({ length: dim }, () => gauss(r));
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / n);
}

function noisy(center: number[], sigma: number, r: () => number): number[] {
  const v = center.map((c) => c + sigma * gauss(r));
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / n);
}

interface GenOpts {
  clusters: number;
  faces: number;
  dim: number;
  /** Per-component noise: ~0.05 at dim 128 gives same-identity pairs around 0.8-1.1, straddling the 1.1 threshold together with the outliers. */
  sigma: number;
  /** Fraction of faces that already carry a personId (the rest are unassigned). */
  assignedFrac: number;
  seed: number;
  photoPrefix?: string;
}

interface Dataset {
  faces: DetectedFace[];
  people: Person[];
  centers: number[][];
}

function makeDataset(o: GenOpts): Dataset {
  const r = mulberry32(o.seed);
  const centers = Array.from({ length: o.clusters }, () => unitVec(o.dim, r));
  const people: Person[] = centers.map((_, k) => ({
    id: `cl_${k}`,
    // a third are user-named, the rest generic placeholders
    name: k % 3 === 0 ? `Real Name ${k}` : `Person ${k + 1}`,
    faceCount: 0,
    photoCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...(k % 5 === 0 ? {} : { coverFaceId: `cover_${k}`, coverPhotoId: `coverphoto_${k}` }),
  }));
  // A named and a generic person with no faces at all.
  people.push({ id: 'empty_named', name: 'Nobody Yet', faceCount: 0, photoCount: 0, createdAt: '2026-01-01T00:00:00.000Z' });
  people.push({ id: 'empty_generic', name: 'Person 999', faceCount: 0, photoCount: 0, createdAt: '2026-01-01T00:00:00.000Z' });

  const faces: DetectedFace[] = [];
  const prefix = o.photoPrefix ?? 'ph';
  let photoNo = 0;
  while (faces.length < o.faces) {
    const photoId = `${prefix}${photoNo++}`;
    const inPhoto = 1 + Math.floor(r() * 4);
    for (let idx = 0; idx < inPhoto && faces.length < o.faces; idx++) {
      const roll = r();
      const cluster = Math.floor(r() * o.clusters);
      let descriptor: number[];
      if (roll < 0.03) {
        descriptor = unitVec(o.dim, r); // outlier: matches nobody
      } else if (roll < 0.05 && faces.length > 0) {
        descriptor = faces[Math.floor(r() * faces.length)].descriptor.slice(); // exact duplicate -> distance ties
      } else if (roll < 0.1) {
        descriptor = noisy(centers[cluster], o.sigma, r).map((x) => x * (0.5 + 1.5 * r())); // not unit length
      } else {
        descriptor = noisy(centers[cluster], o.sigma, r);
      }
      const face: DetectedFace = {
        id: `${photoId}_face_${idx}`,
        photoId,
        box: r() < 0.1 ? (undefined as any) : { x: 0, y: 0, width: 30 + r() * 200, height: 30 + r() * 200 },
        descriptor,
        confidence: r() < 0.1 ? (undefined as any) : 0.3 + 0.7 * r(),
      };
      if (r() < o.assignedFrac) {
        const wrong = r() < 0.05;
        const ghost = r() < 0.01;
        face.personId = ghost ? 'ghost_person' : `cl_${wrong ? Math.floor(r() * o.clusters) : cluster}`;
        const c = r();
        if (c < 0.05) face.isConfirmed = true;
        else if (c < 0.08) face.isManual = true;
      }
      faces.push(face);
    }
  }
  return { faces, people, centers };
}

const clone = <T>(x: T): T => structuredClone(x);
// The oracle runs are long synchronous CPU work; yielding between them lets vitest's worker RPC breathe (else: "Timeout calling onTaskUpdate").
const tick = () => new Promise<void>((r) => setTimeout(r, 0));
afterEach(tick);
const stripPeople = (ps: Person[]) => ps.map((p) => ({ ...p, createdAt: 'x' }));
const view = (r: { people: Person[]; updatedFaces: DetectedFace[] }) => ({
  faces: r.updatedFaces,
  people: stripPeople(r.people),
});

function expectSame(
  oracle: (f: DetectedFace[], p: Person[], t: number, a: boolean) => { people: Person[]; updatedFaces: DetectedFace[] },
  impl: typeof newMainCluster,
  ds: Dataset,
  threshold: number,
  allowNew: boolean
) {
  const want = oracle(clone(ds.faces), clone(ds.people), threshold, allowNew);
  const got = impl(clone(ds.faces), clone(ds.people), threshold, allowNew);
  expect(want.updatedFaces.filter((f) => f.personId).length).toBeGreaterThan(0);
  expect(view(got)).toEqual(view(want));
}

// ---- clusterFaces ------------------------------------------------------------

describe('optimised clusterFaces == original (oracle) on randomized synthetic libraries', () => {
  const oracles = { main: oldMainCluster, renderer: oldRendererCluster };
  const impls = { main: newMainCluster, renderer: newRendererCluster };

  for (const which of ['main', 'renderer'] as const) {
    describe(which, () => {
      it('warm library, dim 128, 40 clusters, 3000 faces (some confirmed/manual, conflicts, ghosts), several thresholds', async () => {
        for (const [seed, threshold] of [[1, DEFAULT_MATCH_THRESHOLD], [2, 0.9], [3, 1.3]] as const) {
          const ds = makeDataset({ clusters: 40, faces: 3000, dim: 128, sigma: 0.05, assignedFrac: 0.7, seed });
          expectSame(oracles[which], impls[which], ds, threshold, true);
          await tick();
        }
      });

      it('cluster from scratch (nothing assigned, no existing people), allowNewClusters true and false', async () => {
        const ds = makeDataset({ clusters: 40, faces: 1500, dim: 128, sigma: 0.05, assignedFrac: 0, seed: 11 });
        ds.people = [];
        expectSame(oracles[which], impls[which], ds, DEFAULT_MATCH_THRESHOLD, true);
        const ds2 = makeDataset({ clusters: 40, faces: 1500, dim: 128, sigma: 0.05, assignedFrac: 0.5, seed: 12 });
        expectSame(oracles[which], impls[which], ds2, DEFAULT_MATCH_THRESHOLD, false);
      });

      it('realistic 512-d embeddings, 40 clusters, 2000 faces', async () => {
        // sigma 0.02 at dim 512 ~ same noise energy as 0.04 at dim 128
        const ds = makeDataset({ clusters: 40, faces: 2000, dim: 512, sigma: 0.025, assignedFrac: 0.75, seed: 21 });
        expectSame(oracles[which], impls[which], ds, DEFAULT_MATCH_THRESHOLD, true);
      });

      it('large library (main 20000 faces, renderer 8000: its oracle is much slower), 60 clusters, mostly assigned', async () => {
        const ds = makeDataset({ clusters: 60, faces: which === 'main' ? 20000 : 8000, dim: 64, sigma: 0.09, assignedFrac: 0.95, seed: 31 });
        expectSame(oracles[which], impls[which], ds, DEFAULT_MATCH_THRESHOLD, true);
      }, 300000);

      it('degenerate inputs: mixed descriptor lengths, missing/empty descriptors, zero vectors', async () => {
        const r = mulberry32(5);
        const ds = makeDataset({ clusters: 6, faces: 300, dim: 16, sigma: 0.15, assignedFrac: 0.5, seed: 41 });
        ds.faces.forEach((f, i) => {
          if (i % 17 === 0) f.descriptor = unitVec(8, r); // legacy length
          if (i % 23 === 0) f.descriptor = [];
          if (i % 29 === 0) f.descriptor = undefined as any;
          if (i % 31 === 0) f.descriptor = new Array(16).fill(0);
        });
        expectSame(oracles[which], impls[which], ds, DEFAULT_MATCH_THRESHOLD, true);
      });

      it('exact distance ties resolve to the earlier person', async () => {
        const d = unitVec(32, mulberry32(9));
        const faces: DetectedFace[] = [
          { id: 'a1', photoId: 'pa', box: { x: 0, y: 0, width: 100, height: 100 }, descriptor: d.slice(), confidence: 0.9, personId: 'B' },
          { id: 'a2', photoId: 'pb', box: { x: 0, y: 0, width: 100, height: 100 }, descriptor: d.slice(), confidence: 0.9, personId: 'A' },
          { id: 'n1', photoId: 'pc', box: { x: 0, y: 0, width: 100, height: 100 }, descriptor: d.slice(), confidence: 0.9 },
        ];
        const people: Person[] = [
          { id: 'A', name: 'A', faceCount: 1, photoCount: 1, createdAt: '' },
          { id: 'B', name: 'B', faceCount: 1, photoCount: 1, createdAt: '' },
        ];
        const want = oracles[which](clone(faces), clone(people), DEFAULT_MATCH_THRESHOLD, true);
        const got = impls[which](clone(faces), clone(people), DEFAULT_MATCH_THRESHOLD, true);
        expect(want.updatedFaces[2].personId).toBe('A');
        expect(view(got)).toEqual(view(want));
      });
    });
  }
});

// ---- FaceClusterSession (the pipeline's per-photo incremental path) -----------

describe('FaceClusterSession.clusterPhoto == re-clustering the whole library per photo (oracle)', () => {
  it('matches a sequence of full clusterFaces calls, incl. re-scans of existing photos and id collisions', async () => {
    const ds = makeDataset({ clusters: 40, faces: 3000, dim: 128, sigma: 0.05, assignedFrac: 0.6, seed: 51 });
    // Settle both sides from the SAME starting state (the pipeline's first, full pass).
    const start = oldMainCluster(clone(ds.faces), clone(ds.people), DEFAULT_MATCH_THRESHOLD, true);
    let oracleFaces = clone(start.updatedFaces);
    let oraclePeople = clone(start.people);
    let faces = clone(start.updatedFaces);
    let people = clone(start.people);
    let session: FaceClusterSession | null = new FaceClusterSession(faces, people);

    const r = mulberry32(77);
    const photoIds = Array.from(new Set(ds.faces.map((f) => f.photoId)));
    let fast = 0;
    let full = 0;
    for (let step = 0; step < 80; step++) {
      if (step % 10 === 0) await tick();
      // 1 in 3 steps re-scans an existing photo (its old faces are dropped first, ids are re-used).
      const rescan = r() < 0.33;
      const photoId = rescan ? photoIds[Math.floor(r() * photoIds.length)] : `new_${step}`;
      const count = r() < 0.25 ? 0 : 1 + Math.floor(r() * 4);
      const fresh: DetectedFace[] = Array.from({ length: count }, (_, idx) => {
        const known = r() < 0.85;
        return {
          id: `${photoId}_face_${idx}`,
          photoId,
          box: { x: 0, y: 0, width: 40 + r() * 150, height: 40 + r() * 150 },
          descriptor: known ? noisy(ds.centers[Math.floor(r() * ds.centers.length)], 0.05, r) : unitVec(128, r),
          confidence: 0.4 + 0.6 * r(),
          isConfirmed: false,
          isManual: false,
        };
      });

      // Oracle: the original per-photo call.
      const existing = oracleFaces.filter((f) => f.photoId !== photoId);
      const want = oldMainCluster([...existing, ...clone(fresh)], oraclePeople, DEFAULT_MATCH_THRESHOLD, true);
      const wantChanged = peopleNeedingWrite(oraclePeople, want.people);

      // Implementation, mirroring pipelineOrchestrator.detectFacesForPhoto.
      let gotPeople: Person[];
      let gotFaces: DetectedFace[];
      let gotChanged: Person[];
      const freshForImpl = clone(fresh);
      const res = session && session.matches(faces, people) ? session.clusterPhoto(photoId, freshForImpl) : null;
      if (res) {
        fast++;
        ({ people: gotPeople, faces: gotFaces, changedPeople: gotChanged } = res);
      } else {
        full++;
        const existingImpl = faces.filter((f) => f.photoId !== photoId);
        const out = newMainCluster([...existingImpl, ...clone(fresh)], people);
        gotPeople = out.people;
        gotFaces = out.updatedFaces;
        gotChanged = peopleNeedingWrite(people, out.people);
        session = new FaceClusterSession(gotFaces, gotPeople);
      }

      expect(gotFaces.map((f) => [f.id, f.personId ?? null])).toEqual(want.updatedFaces.map((f) => [f.id, f.personId ?? null]));
      expect(stripPeople(gotPeople)).toEqual(stripPeople(want.people));
      const byId = (ps: Person[]) => stripPeople([...ps].sort((a, b) => (a.id < b.id ? -1 : 1)));
      expect(byId(gotChanged)).toEqual(byId(wantChanged));

      oracleFaces = want.updatedFaces;
      oraclePeople = want.people;
      faces = gotFaces;
      people = gotPeople;
    }
    expect(fast).toBeGreaterThan(40);
  }, 300000);

  it('refuses (without modifying anything) faces that already carry a personId', () => {
    const ds = makeDataset({ clusters: 5, faces: 60, dim: 16, sigma: 0.1, assignedFrac: 1, seed: 61 });
    const start = newMainCluster(ds.faces, ds.people);
    const session = new FaceClusterSession(start.updatedFaces, start.people);
    const before = start.updatedFaces.length;
    const bad: DetectedFace = { ...start.updatedFaces[0], id: 'x_face_0', photoId: 'x', personId: 'cl_1' };
    expect(session.clusterPhoto('x', [bad])).toBeNull();
    expect(start.updatedFaces.length).toBe(before);
  });
});

// ---- benchmark (opt-in: GPHOTOS_BENCH=1) ---------------------------------------

describe.skipIf(!process.env.GPHOTOS_BENCH)('benchmark: old vs new', () => {
  const time = (fn: () => void) => {
    const t = process.hrtime.bigint();
    fn();
    return Number(process.hrtime.bigint() - t) / 1e6;
  };

  it('20000 faces / 300 people, 512-d', () => {
    // 5% unassigned (a library that was mostly clustered already, then gets new faces)
    const ds = makeDataset({ clusters: 300, faces: 20000, dim: 512, sigma: 0.025, assignedFrac: 0.95, seed: 71 });
    const unassigned = ds.faces.filter((f) => !f.personId).length;
    // Inputs are cloned OUTSIDE the timers: clusterFaces mutates its input, and cloning 20000x512 doubles is itself seconds.
    const timed = (fn: (f: DetectedFace[], p: Person[], t: number, a: boolean) => unknown) => {
      const f = clone(ds.faces);
      const p = clone(ds.people);
      return time(() => fn(f, p, DEFAULT_MATCH_THRESHOLD, true));
    };
    const tOld = timed(oldRendererCluster);
    const tNew = timed(newRendererCluster);
    const tOldMain = timed(oldMainCluster);
    const tNewMain = timed(newMainCluster);
    console.log(`[bench] 20000 faces, 300 people, ${unassigned} unassigned: renderer old ${tOld.toFixed(0)} ms -> new ${tNew.toFixed(0)} ms; main old ${tOldMain.toFixed(0)} ms -> new ${tNewMain.toFixed(0)} ms`);

    // Per-photo pipeline step: 3 new faces on a settled 20000-face library.
    const settled = newMainCluster(clone(ds.faces), clone(ds.people));
    const r = mulberry32(5);
    const freshFor = (n: number): DetectedFace[] =>
      Array.from({ length: 3 }, (_, i) => ({
        id: `b${n}_face_${i}`,
        photoId: `b${n}`,
        box: { x: 0, y: 0, width: 100, height: 100 },
        descriptor: noisy(ds.centers[Math.floor(r() * ds.centers.length)], 0.025, r),
        confidence: 0.9,
      }));
    const N = 10;
    let faces = clone(settled.updatedFaces);
    let people = clone(settled.people);
    let oldTotal = 0;
    for (let n = 0; n < N; n++) {
      const fresh = freshFor(n);
      oldTotal += time(() => {
        const out = oldMainCluster([...faces.filter((f) => f.photoId !== `b${n}`), ...clone(fresh)], people, DEFAULT_MATCH_THRESHOLD, true);
        peopleNeedingWrite(people, out.people);
        faces = out.updatedFaces;
        people = out.people;
      });
    }
    faces = clone(settled.updatedFaces);
    people = clone(settled.people);
    const session = new FaceClusterSession(faces, people);
    let newTotal = 0;
    for (let n = 0; n < N; n++) {
      const fresh = freshFor(n + 100);
      newTotal += time(() => session.clusterPhoto(`b${n + 100}`, fresh));
    }
    console.log(`[bench] per-photo pipeline step (3 faces, 20000-face library): old ${(oldTotal / N).toFixed(0)} ms/photo -> new ${(newTotal / N).toFixed(1)} ms/photo`);
  }, 900000);
});
