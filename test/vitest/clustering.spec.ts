import { describe, it, expect } from 'vitest';
import {
  normalizeVector,
  euclideanDistance,
  cosineDistance,
  computeQualityWeightedCentroid,
  clusterFaces,
} from '../../src/renderer/src/services/clustering';
import { DetectedFace, Person } from '../../src/types';

function makeFace(overrides: Partial<DetectedFace> = {}): DetectedFace {
  return {
    id: 'f1',
    photoId: 'p1',
    box: { x: 0, y: 0, width: 100, height: 100 },
    descriptor: [1, 0, 0],
    confidence: 0.9,
    ...overrides,
  };
}

describe('clustering math', () => {
  describe('normalizeVector', () => {
    it('scales a vector to unit length', () => {
      const result = normalizeVector([3, 4]);
      const magnitude = Math.sqrt(result[0] ** 2 + result[1] ** 2);
      expect(magnitude).toBeCloseTo(1, 6);
      expect(result[0]).toBeCloseTo(0.6, 6);
      expect(result[1]).toBeCloseTo(0.8, 6);
    });

    it('returns an empty array for empty input', () => {
      expect(normalizeVector([])).toEqual([]);
    });

    it('does not divide by zero for an all-zero vector', () => {
      const result = normalizeVector([0, 0, 0]);
      expect(result.every((v) => Number.isFinite(v))).toBe(true);
    });
  });

  describe('euclideanDistance', () => {
    it('is zero for identical vectors', () => {
      expect(euclideanDistance([1, 2, 3], [1, 2, 3])).toBe(0);
    });

    it('computes the straight-line distance between two vectors', () => {
      expect(euclideanDistance([0, 0], [3, 4])).toBeCloseTo(5, 6);
    });

    it('returns a sentinel distance for mismatched or empty vectors', () => {
      expect(euclideanDistance([1, 2], [1, 2, 3])).toBe(1.0);
      expect(euclideanDistance([], [])).toBe(1.0);
    });
  });

  describe('cosineDistance', () => {
    it('is zero for identical-direction vectors', () => {
      expect(cosineDistance([1, 0, 0], [1, 0, 0])).toBeCloseTo(0, 6);
    });

    it('is 1 for orthogonal vectors', () => {
      expect(cosineDistance([1, 0], [0, 1])).toBeCloseTo(1, 6);
    });

    it('is 2 for exactly opposite vectors', () => {
      expect(cosineDistance([1, 0], [-1, 0])).toBeCloseTo(2, 6);
    });

    it('returns a sentinel distance for mismatched or empty vectors', () => {
      expect(cosineDistance([1, 2], [1, 2, 3])).toBe(1.0);
      expect(cosineDistance([], [])).toBe(1.0);
    });
  });

  describe('computeQualityWeightedCentroid', () => {
    it('returns an empty array when no faces have descriptors', () => {
      expect(computeQualityWeightedCentroid([])).toEqual([]);
    });

    it('weighs manually confirmed faces 2.5x more than unconfirmed ones', () => {
      // A low-confidence unconfirmed face pointing one way, and a
      // high-confidence *manual* face pointing another way — the manual
      // one should dominate the resulting centroid direction.
      const unconfirmed = makeFace({ descriptor: [1, 0, 0], confidence: 0.5, isConfirmed: false });
      const manual = makeFace({ descriptor: [0, 1, 0], confidence: 0.5, isManual: true, box: { x: 0, y: 0, width: 100, height: 100 } });

      const centroid = computeQualityWeightedCentroid([unconfirmed, manual]);
      expect(centroid[1]).toBeGreaterThan(centroid[0]);
    });

    it('produces a unit-normalized centroid', () => {
      const centroid = computeQualityWeightedCentroid([
        makeFace({ descriptor: [1, 0, 0] }),
        makeFace({ descriptor: [0, 1, 0] }),
      ]);
      const magnitude = Math.sqrt(centroid.reduce((s, v) => s + v * v, 0));
      expect(magnitude).toBeCloseTo(1, 6);
    });

    it('skips faces with mismatched descriptor dimensions', () => {
      const centroid = computeQualityWeightedCentroid([
        makeFace({ descriptor: [1, 0, 0] }),
        makeFace({ descriptor: [1, 0] }), // wrong dimension, must be ignored
      ]);
      expect(centroid).toHaveLength(3);
    });
  });

  describe('clusterFaces pruning', () => {
    function makePerson(overrides: Partial<Person> = {}): Person {
      return {
        id: 'person_1',
        name: 'Person 1',
        faceCount: 1,
        photoCount: 1,
        createdAt: new Date().toISOString(),
        ...overrides,
      };
    }

    it('drops a generically-named existing person once it has no faces left', () => {
      // Reproduces: renaming/reassigning a person's only face (e.g. from
      // within the lightbox) used to leave the old "Person N" behind
      // forever at 0 faces, because clusterFaces exempted any pre-existing
      // person from pruning regardless of name.
      const staleGenericPerson = makePerson({ id: 'person_7', name: 'Person 7', faceCount: 1 });
      const newNamedPerson = makePerson({ id: 'person_trupti', name: 'Trupti', faceCount: 0 });
      // The one face that used to belong to "Person 7" now points at the
      // newly-named person instead — nothing in `faces` references person_7
      // any more.
      const face = makeFace({ id: 'f1', personId: 'person_trupti' });

      const { people } = clusterFaces([face], [staleGenericPerson, newNamedPerson]);

      expect(people.find((p) => p.id === 'person_7')).toBeUndefined();
      expect(people.find((p) => p.id === 'person_trupti')?.faceCount).toBe(1);
    });

    it('keeps a real-named existing person even at 0 faces', () => {
      // A person the user has actually named must never disappear just
      // because none of their faces are currently assigned (e.g. a
      // transient recompute, or all their photos were temporarily
      // excluded) — only generic, never-reviewed placeholders are disposable.
      const namedPerson = makePerson({ id: 'person_named', name: 'Grandma', faceCount: 1 });

      const { people } = clusterFaces([], [namedPerson]);

      expect(people.find((p) => p.id === 'person_named')).toBeDefined();
    });

    it('still drops a brand-new generic cluster invented in the same pass with no faces', () => {
      const { people } = clusterFaces([], []);
      expect(people).toHaveLength(0);
    });
  });
});
