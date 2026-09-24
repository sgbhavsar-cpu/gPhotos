import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resetDbForTests, setActiveLibrary, getDb } from '../../src/main/services/db';
import { upsertPhoto, replaceFacesForPhoto, upsertPerson, renamePerson, deletePerson } from '../../src/main/services/libraryRepository';
import { getSharedFaceClusterCache } from '../../src/main/services/pipelineOrchestrator';
import { clusterFaces, computeQualityWeightedCentroid } from '../../src/main/services/faceClustering';
import { Photo, Person, DetectedFace } from '../../src/types';

const photo = (id: string): Photo => ({
  id, filePath: `C:\\P\\${id}.jpg`, fileName: `${id}.jpg`, fileSize: 1, fileDate: '', dateTaken: '2026-01-01T00:00:00Z',
  year: 2026, month: 1, day: 1,
});
const face = (id: string, photoId: string, descriptor: number[]): DetectedFace => ({
  id, photoId, box: { x: 0, y: 0, width: 100, height: 100 }, descriptor, confidence: 0.9,
});

describe('shared face cluster cache: reused only while nothing else wrote faces/people', () => {
  let tempDir: string;
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gphotos_facecache_'));
    process.env.GPHOTOS_TEST_DB_DIR = tempDir;
    resetDbForTests();
    setActiveLibrary(tempDir);
    upsertPhoto(photo('p1'), getDb());
    replaceFacesForPhoto('p1', [face('f1', 'p1', [1, 0, 0])], false, getDb());
  });
  afterEach(() => {
    resetDbForTests();
    delete process.env.GPHOTOS_TEST_DB_DIR;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns the same object while unchanged, and a fresh one after any faces/people write', () => {
    const db = getDb();
    // Warm-up: the very first call lazily opens the global DB, whose one-time
    // face-data-version check itself bumps the revision (so the cache built
    // just before it is correctly treated as stale once). After that it's stable.
    getSharedFaceClusterCache(db);
    const a = getSharedFaceClusterCache(db);
    expect(getSharedFaceClusterCache(db)).toBe(a); // no reload

    const person: Person = { id: 'pp', name: 'Old', faceCount: 1, photoCount: 1, createdAt: '2026-01-01T00:00:00Z' };
    upsertPerson(person);
    const b = getSharedFaceClusterCache(db);
    expect(b).not.toBe(a);
    expect(b.people.map((p) => p.name)).toEqual(['Old']);

    renamePerson('pp', 'New'); // a rename elsewhere must never be served stale
    const c = getSharedFaceClusterCache(db);
    expect(c).not.toBe(b);
    expect(c.people[0].name).toBe('New');

    replaceFacesForPhoto('p1', [face('f1', 'p1', [1, 0, 0]), face('f2', 'p1', [0, 1, 0])], false, db);
    const d = getSharedFaceClusterCache(db);
    expect(d.faces).toHaveLength(2);

    deletePerson('pp');
    expect(getSharedFaceClusterCache(db)).not.toBe(d);
  });
});

describe('clusterFaces centroid memo does not change results', () => {
  it('matches a brute-force reference (centroid recomputed for every face) on a multi-face batch', () => {
    // Reference = the pre-memo algorithm, inlined: same rules, no cache.
    const threshold = 1.1;
    const known: DetectedFace[] = [
      { ...face('k1', 'a', [1, 0, 0]), personId: 'A' },
      { ...face('k2', 'b', [0, 1, 0]), personId: 'B' },
    ];
    const people: Person[] = [
      { id: 'A', name: 'A', faceCount: 1, photoCount: 1, createdAt: '' },
      { id: 'B', name: 'B', faceCount: 1, photoCount: 1, createdAt: '' },
    ];
    // Several new faces in ONE photo-set so a face joining A must change the
    // centroid the next face is compared against (the memo's invalidation path).
    const fresh = (): DetectedFace[] => [
      face('n1', 'c', [0.9, 0.1, 0]),
      face('n2', 'd', [0.8, 0.2, 0]),
      face('n3', 'e', [0, 0.9, 0.1]),
      face('n4', 'f', [0, 0, 1]),
    ];

    const got = clusterFaces([...known.map((f) => ({ ...f })), ...fresh()], people).updatedFaces.map((f) => f.personId);

    // brute-force reference
    const faces = [...known.map((f) => ({ ...f })), ...fresh()];
    const lists = new Map<string, DetectedFace[]>([['A', [faces[0]]], ['B', [faces[1]]]]);
    for (const f of faces.slice(2)) {
      let best: string | null = null;
      let min = Infinity;
      for (const [pid, list] of lists) {
        const cen = computeQualityWeightedCentroid(list);
        for (const other of [cen, ...list.map((l) => l.descriptor)]) {
          const d = Math.sqrt(other.reduce((s, v, i) => s + (v - f.descriptor[i]) ** 2, 0));
          if (d < min) { min = d; if (d < threshold) best = pid; }
        }
      }
      if (best) { f.personId = best; lists.get(best)!.push(f); }
      else { f.personId = `person_${f.id}`; lists.set(f.personId, [f]); }
    }
    expect(got).toEqual(faces.map((f) => f.personId));
  });
});
