import { DetectedFace, Person } from '../../types';

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

/**
 * Clusters detected face vectors into People identities with quality-weighted centroids
 * and strict enforcement of the single-photo uniqueness invariant:
 * "In one photo, two faces should NEVER be detected as the same person."
 */
export function clusterFaces(
  allFaces: DetectedFace[],
  existingPeople: Person[] = [],
  threshold = DEFAULT_MATCH_THRESHOLD,
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
        const centroid = computeQualityWeightedCentroid(assignedList);
        const centroidDist = euclideanDistance(face.descriptor, centroid);
        if (centroidDist < minDistance) {
          minDistance = centroidDist;
          if (centroidDist < threshold) {
            bestMatchPersonId = personId;
          }
        }

        // Also check against individual confirmed exemplars
        for (const exemplar of assignedList) {
          const dist = euclideanDistance(face.descriptor, exemplar.descriptor);
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

  const existingPeopleIds = new Set(existingPeople.map((p) => p.id));

  return {
    people: Array.from(peopleMap.values()).filter((p) => {
      if (p.faceCount > 0) return true;
      if (existingPeopleIds.has(p.id)) return true;
      const isGenericName = /^Person(\s+\d+)?$/i.test(p.name.trim());
      if (!isGenericName) return true;
      return false;
    }),
    updatedFaces,
  };
}
