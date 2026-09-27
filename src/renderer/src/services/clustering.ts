import { DetectedFace, Person } from '../../../types';

/**
 * L2-normalizes a numeric embedding vector onto the unit hypersphere.
 */
export function normalizeVector(vec: number[]): number[] {
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
export function euclideanDistance(a: number[], b: number[]): number {
  if (!a || !b || a.length !== b.length || a.length === 0) return 1.0;
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

/**
 * CosFace / Angular Cosine Distance metric: 1 - cosine_similarity.
 * Embeddings on the unit sphere have distance between 0 (identical) and 2 (opposite).
 */
export function cosineDistance(a: number[], b: number[]): number {
  if (!a || !b || a.length !== b.length || a.length === 0) return 1.0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator < 1e-10) return 1.0;
  const sim = Math.max(-1, Math.min(1, dot / denominator));
  return 1.0 - sim;
}

/**
 * Computes a normalized, quality-weighted centroid embedding for a person's faces.
 * Weight incorporates detector confidence, face bounding box size, and a 2.5x multiplier
 * for manually confirmed or user-tagged faces to eliminate identity drift.
 */
export function computeQualityWeightedCentroid(faces: DetectedFace[]): number[] {
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
    const normalized = normalizeVector(face.descriptor);

    for (let i = 0; i < dim; i++) {
      sum[i] += normalized[i] * weight;
    }
    totalWeight += weight;
  }

  if (totalWeight < 1e-10) {
    return normalizeVector(validFaces[0].descriptor);
  }

  return normalizeVector(sum);
}

/**
 * Default Euclidean-distance match threshold for the 512-d, L2-normalized
 * ArcFace/MobileFaceNet embeddings produced by the main-process detection
 * engine (see src/main/services/faceDetectionEngine.ts) — must stay in sync
 * with faceClustering.ts's DEFAULT_MATCH_THRESHOLD, since this copy clusters
 * the exact same descriptors during interactive edits (confirm/reassign/
 * unassign/delete) on the renderer's in-memory state.
 */
export const DEFAULT_MATCH_THRESHOLD = 1.1;

// ---------------------------------------------------------------------------
// Clustering engine.
//
// The pre-optimisation version recomputed every person's centroid (allocating
// one 512-float array per member face) for every unassigned face, and scanned
// every person's every exemplar with a full 512-d distance. This version
// returns EXACTLY the same assignments (test/vitest/faceClusteringEquivalence
// .spec.ts keeps the old code as an oracle and deep-compares) but does far less
// work:
//   * each person's weighted sum is folded incrementally - a face's
//     contribution is added once, in list order, so the floating-point result is
//     bit-identical to recomputing over the whole list - and the normalised
//     centroid is cached until the person gains a face;
//   * candidate persons are visited nearest-centroid first, so a tight match
//     bound is established immediately, and every distance aborts as soon as its
//     partial sum proves it cannot beat that bound (partial sums only grow, so
//     an abort never discards a distance that would have won);
//   * ties still resolve to the person that comes first in the original
//     iteration order (see findBestPerson).
// The old code only ever assigned to the first-encountered global minimum
// distance when it was < threshold (a distance >= threshold never assigns, and
// can't hide a later < threshold one), which is what makes the reordering exact.
// ---------------------------------------------------------------------------

interface PersonAcc {
  /** Position in the original people iteration order (ties resolve to the lowest). */
  order: number;
  faces: DetectedFace[];
  /** How many of `faces` are already folded into sum/totalWeight. */
  folded: number;
  dim: number;
  sum: number[] | null;
  totalWeight: number;
  first: number[] | null;
  centroid: number[] | null;
  /** Distance from the centroid to each exemplar in `faces` (NaN = not comparable); null = stale. Used to skip exemplars by triangle inequality. */
  radii: Float64Array | null;
}

function newAcc(order: number, faces: DetectedFace[] = []): PersonAcc {
  return { order, faces, folded: 0, dim: 0, sum: null, totalWeight: 0, first: null, centroid: null, radii: null };
}

function resetAcc(acc: PersonAcc, faces: DetectedFace[]): void {
  acc.faces = faces;
  acc.folded = 0;
  acc.dim = 0;
  acc.sum = null;
  acc.totalWeight = 0;
  acc.first = null;
  acc.centroid = null;
  acc.radii = null;
}

/** Folds any not-yet-counted faces into the person's running weighted sum (same maths/order as computeQualityWeightedCentroid). */
function foldPending(acc: PersonAcc): void {
  const faces = acc.faces;
  if (acc.folded === faces.length) return;
  for (let k = acc.folded; k < faces.length; k++) {
    const face = faces[k];
    const d = face.descriptor;
    if (!d || d.length === 0) continue;
    if (acc.sum === null) {
      acc.dim = d.length;
      acc.sum = new Array(d.length).fill(0);
      acc.first = d;
    } else if (d.length !== acc.dim) {
      continue;
    }
    const conf = typeof face.confidence === 'number' ? face.confidence : 0.7;
    const confirmWeight = face.isConfirmed || face.isManual ? 2.5 : 1.0;
    let sizeWeight = 1.0;
    if (face.box && face.box.width && face.box.height) {
      const area = Math.sqrt(face.box.width * face.box.height);
      sizeWeight = Math.min(1.5, Math.max(0.6, area / 100));
    }
    const weight = conf * confirmWeight * sizeWeight;
    let sumSq = 0;
    for (let i = 0; i < d.length; i++) sumSq += d[i] * d[i];
    const norm = Math.sqrt(sumSq) || 1e-10;
    const sum = acc.sum;
    for (let i = 0; i < d.length; i++) sum[i] += (d[i] / norm) * weight;
    acc.totalWeight += weight;
  }
  acc.folded = faces.length;
  acc.centroid = null;
  acc.radii = null;
}

function accCentroid(acc: PersonAcc): number[] {
  foldPending(acc);
  if (acc.centroid) return acc.centroid;
  acc.centroid =
    acc.sum === null ? [] : acc.totalWeight < 1e-10 ? normalizeVector(acc.first!) : normalizeVector(acc.sum);
  return acc.centroid;
}

/** Distance from the person's centroid to each of their exemplars (NaN where descriptor lengths differ). */
function accRadii(acc: PersonAcc, centroid: number[]): Float64Array {
  if (acc.radii) return acc.radii;
  const radii = new Float64Array(acc.faces.length);
  for (let k = 0; k < radii.length; k++) {
    const d = acc.faces[k].descriptor;
    radii[k] = d && d.length === centroid.length ? euclideanDistance(d, centroid) : NaN;
  }
  acc.radii = radii;
  return radii;
}

/**
 * euclideanDistance(a, b), except it gives up (returns Infinity) once the
 * partial sum already proves the distance exceeds `bound`. Otherwise the value
 * is bit-identical to euclideanDistance (same accumulation order).
 */
function distanceWithin(a: number[], b: number[], bound: number): number {
  if (!a || !b || a.length !== b.length || a.length === 0) return 1.0;
  const n = a.length;
  let sum = 0;
  let i = 0;
  while (i < n) {
    const end = i + 32 < n ? i + 32 : n;
    for (; i < end; i++) {
      const diff = a[i] - b[i];
      sum += diff * diff;
    }
    if (i < n && Math.sqrt(sum) > bound) return Infinity;
  }
  return Math.sqrt(sum);
}

const PRUNE_MARGIN = 1e-6;

/**
 * The person whose centroid/exemplar is closest to `face` (< threshold), among
 * persons for which `isTaken` is false. Ties go to the person earliest in
 * iteration order, exactly like the original "strictly closer wins" scan.
 */
function findBestPerson(
  face: DetectedFace,
  accs: Map<string, PersonAcc>,
  isTaken: (personId: string) => boolean,
  threshold: number
): string | null {
  const desc = face.descriptor;
  const ids: string[] = [];
  const list: PersonAcc[] = [];
  const cds: number[] = [];
  for (const [personId, acc] of accs) {
    if (acc.faces.length === 0 || isTaken(personId)) continue;
    ids.push(personId);
    list.push(acc);
    // Full distance (no early abort): it also drives the visit order and the triangle-inequality skip below.
    cds.push(euclideanDistance(desc, accCentroid(acc)));
  }
  const visit = ids.map((_, k) => k);
  visit.sort((x, y) => (cds[x] < cds[y] ? -1 : cds[x] > cds[y] ? 1 : x - y));

  let bestId: string | null = null;
  let bestOrder = Infinity;
  let bound = threshold;
  for (const k of visit) {
    const acc = list[k];
    const order = acc.order;
    // Wins if strictly closer, or (once something matched) an exact tie from an earlier person.
    let d = cds[k];
    if (bestId === null ? d < threshold : d < bound || (d === bound && order < bestOrder)) {
      bound = d;
      bestId = ids[k];
      bestOrder = order;
    }
    // Triangle inequality: |exemplar - face| >= | |face - centroid| - |exemplar - centroid| |.
    // An exemplar whose lower bound exceeds the current bound (by a margin far
    // above floating-point error) cannot win, so its distance is never computed.
    // Only valid where euclideanDistance is a real metric (same descriptor length);
    // NaN radii (mismatched lengths) never prune. Skipped for persons already
    // within the bound (the winner): building their radii costs more than it saves.
    const cd = cds[k];
    const radii =
      cd > bound + PRUNE_MARGIN && desc && desc.length > 0 && desc.length === acc.dim ? accRadii(acc, acc.centroid!) : null;
    const exemplars = acc.faces;
    for (let e = 0; e < exemplars.length; e++) {
      if (radii !== null && Math.abs(cd - radii[e]) > bound + PRUNE_MARGIN) continue;
      d = distanceWithin(desc, exemplars[e].descriptor, bound);
      if (bestId === null ? d < threshold : d < bound || (d === bound && order < bestOrder)) {
        bound = d;
        bestId = ids[k];
        bestOrder = order;
      }
    }
  }
  return bestId;
}

interface ClusterState {
  peopleMap: Map<string, Person>;
  accs: Map<string, PersonAcc>;
  photoAssigned: Map<string, Set<string>>;
  nextPersonIndex: number;
  nextOrder: number;
}

function newState(existingPeople: Person[]): ClusterState {
  const state: ClusterState = {
    peopleMap: new Map(),
    accs: new Map(),
    photoAssigned: new Map(),
    nextPersonIndex: existingPeople.length + 1,
    nextOrder: 0,
  };
  for (const person of existingPeople) {
    state.peopleMap.set(person.id, { ...person, faceCount: 0, photoCount: 0 });
    const prior = state.accs.get(person.id);
    state.accs.set(person.id, newAcc(prior ? prior.order : state.nextOrder++));
  }
  return state;
}

function assignedIn(state: ClusterState, photoId: string): Set<string> {
  let m = state.photoAssigned.get(photoId);
  if (!m) {
    m = new Set();
    state.photoAssigned.set(photoId, m);
  }
  return m;
}

/** The old per-face loop body: give an unassigned face a person (or a new one / none). */
function assignFace(state: ClusterState, face: DetectedFace, threshold: number, allowNewClusters: boolean): void {
  const assignedInThisPhoto = assignedIn(state, face.photoId);
  // RULE: One photo cannot have two faces of the same person!
  const bestMatchPersonId = findBestPerson(face, state.accs, (id) => assignedInThisPhoto.has(id), threshold);

  if (bestMatchPersonId) {
    face.personId = bestMatchPersonId;
    state.accs.get(bestMatchPersonId)!.faces.push(face);
    assignedInThisPhoto.add(bestMatchPersonId);
  } else if (allowNewClusters) {
    // Create new person cluster. Seeded off this face's own (stable,
    // DB-persisted) id rather than Date.now() - see the matching
    // reconciliation copy in src/renderer/src/services/clustering.ts for
    // why: two independent runs (e.g. a background scan here and a
    // renderer session's own reconciliation) inventing "the same" new
    // person for the same unassigned face must derive the same id, or the
    // merge-only people upsert (never deletes) keeps both as duplicates.
    const newPersonId = `person_${face.id}`;
    const newPerson: Person = {
      id: newPersonId,
      name: `Person ${state.nextPersonIndex}`,
      coverFaceId: face.id,
      coverPhotoId: face.photoId,
      faceCount: 0,
      photoCount: 0,
      createdAt: new Date().toISOString(),
    };
    state.nextPersonIndex++;

    const prior = state.accs.get(newPersonId);
    state.peopleMap.set(newPersonId, newPerson);
    // Same as the original: an id collision replaces the earlier person's list.
    state.accs.set(newPersonId, newAcc(prior ? prior.order : state.nextOrder++, [face]));
    face.personId = newPersonId;
    assignedInThisPhoto.add(newPersonId);
  } else {
    face.personId = undefined;
  }
}

/** A generic "Person N" placeholder with no faces is orphaned scaffolding. */
function isPrunable(p: Person): boolean {
  return p.faceCount <= 0 && /^Person(\s+\d+)?$/i.test(p.name.trim());
}

/** Recalculate face counts and unique photos per person (over `faces`), filling in missing covers. */
function recountAll(peopleMap: Map<string, Person>, faces: DetectedFace[]): void {
  const personPhotoSets = new Map<string, Set<string>>();
  for (const pId of peopleMap.keys()) {
    personPhotoSets.set(pId, new Set());
  }

  for (const face of faces) {
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
}

/**
 * Clusters detected face vectors into People identities with quality-weighted centroids
 * and strict enforcement of the single-photo uniqueness invariant:
 * "In one photo, two faces should NEVER be detected as the same person."
 *
 * Returns exactly what the original brute-force version did (see the
 * "Clustering engine" comment above for why it is cheaper): this runs on the
 * UI thread from libraryStore.reconcilePeopleAndFaces, so its cost matters.
 */
export function clusterFaces(
  allFaces: DetectedFace[],
  existingPeople: Person[] = [],
  threshold = DEFAULT_MATCH_THRESHOLD,
  allowNewClusters = true
): { people: Person[]; updatedFaces: DetectedFace[] } {
  const state = newState(existingPeople);
  const { peopleMap, accs } = state;
  const updatedFaces = [...allFaces];

  // Populate known person faces and validate existing face assignments for single-photo uniqueness
  for (const face of updatedFaces) {
    if (face.personId && peopleMap.has(face.personId)) {
      const assignedInPhoto = assignedIn(state, face.photoId);

      if (assignedInPhoto.has(face.personId)) {
        // CONFLICT: This photo already has another face assigned to this person!
        // Unassign this conflicting face so it can be re-assigned or placed in a new cluster
        face.personId = undefined;
      } else {
        assignedInPhoto.add(face.personId);
        accs.get(face.personId)?.faces.push(face);
      }
    }
  }

  for (let i = 0; i < updatedFaces.length; i++) {
    const face = updatedFaces[i];
    // A face that already carries SOME personId is left alone here, even if
    // that person doesn't happen to be in this call's existingPeople list -
    // it must NOT fall through to the "no match found" branch. See
    // src/main/services/faceClustering.ts for the full explanation.
    if (face.personId) {
      continue;
    }
    assignFace(state, face, threshold, allowNewClusters);
  }

  recountAll(peopleMap, updatedFaces);

  return {
    // A real, user-given name (anything but the auto-assigned "Person N"
    // placeholder) is always kept, even at 0 faces - a named person the
    // user cares about should never vanish as a side effect of some
    // unrelated face losing its assignment elsewhere. A generic placeholder
    // has no such claim: once it has no faces left, it's just orphaned
    // scaffolding. Must stay in sync with the main-process copy.
    people: Array.from(peopleMap.values()).filter((p) => !isPrunable(p)),
    updatedFaces,
  };
}
