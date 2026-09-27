import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// detectFaces is the only piece of detectFacesForPhoto that needs the ONNX
// engine; everything else (DB reads/writes, clustering, the shared cache) is real.
vi.mock('../../src/main/services/faceDetectionWorkerClient', async (importOriginal) => {
  const orig: any = await importOriginal();
  return { ...orig, detectFaces: vi.fn() };
});

import { detectFaces } from '../../src/main/services/faceDetectionWorkerClient';
import { resetDbForTests, setActiveLibrary, getDb } from '../../src/main/services/db';
import { getAllFaces, getAllPeople, replaceFacesForPhoto, upsertPeople, deletePerson } from '../../src/main/services/libraryRepository';
import { detectFacesForPhoto, createFaceClusterCache } from '../../src/main/services/pipelineOrchestrator';
import { FaceClusterSession } from '../../src/main/services/faceClustering';
import { Photo } from '../../src/types';

// The pipeline used to re-cluster the WHOLE cached library for every photo; it
// now clusters only the photo's own new faces against the cached state
// (FaceClusterSession). Whatever the DB ends up holding must be identical to
// the uncached path (fresh DB read + full clusterFaces per photo).

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
function unit(v: number[]): number[] {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / n);
}

const DIM = 512;

describe('detectFacesForPhoto with a shared cache == uncached, photo after photo', () => {
  let tempDir: string;
  let imagePath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gphotos_incr_'));
    process.env.GPHOTOS_TEST_DB_DIR = tempDir;
    imagePath = path.join(tempDir, 'x.jpg');
    fs.writeFileSync(imagePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  });
  afterEach(() => {
    resetDbForTests();
    delete process.env.GPHOTOS_TEST_DB_DIR;
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  async function scenario(useCache: boolean, label: string) {
    const lib = path.join(tempDir, label);
    fs.mkdirSync(lib, { recursive: true });
    resetDbForTests();
    setActiveLibrary(lib);
    const db = getDb();
    // The people table is global (not per-library) and survives resetDbForTests: start each scenario empty.
    for (const p of getAllPeople()) deletePerson(p.id);

    const r = rng(1234);
    const centers = Array.from({ length: 6 }, () => unit(Array.from({ length: DIM }, () => gauss(r))));
    const face = (cluster: number) => unit(centers[cluster].map((c) => c + 0.025 * gauss(r)));

    // Pre-existing library state (as loaded from the DB: every face already has a person, which is what the cache design relies on).
    upsertPeople([
      { id: 'bob', name: 'Bob', faceCount: 1, photoCount: 1, createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'alice', name: 'Alice', faceCount: 1, photoCount: 1, createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'person_old', name: 'Person 1', faceCount: 1, photoCount: 1, createdAt: '2026-01-01T00:00:00.000Z' },
    ]);
    replaceFacesForPhoto('seed0', [
      { id: 'seed0_face_0', photoId: 'seed0', box: { x: 0, y: 0, width: 100, height: 100 }, descriptor: face(0), confidence: 0.9, personId: 'alice', isConfirmed: true },
    ], false, db);
    replaceFacesForPhoto('seed1', [
      { id: 'seed1_face_0', photoId: 'seed1', box: { x: 0, y: 0, width: 100, height: 100 }, descriptor: face(1), confidence: 0.9, personId: 'person_old' },
      { id: 'seed1_face_1', photoId: 'seed1', box: { x: 0, y: 0, width: 100, height: 100 }, descriptor: face(2), confidence: 0.9, personId: 'bob' },
    ], false, db);

    const cache = useCache ? createFaceClusterCache(db) : undefined;
    // Steps that skip detection (e.g. re-scanning a locked photo) must not leave a stale result queued.
    let current: any;
    vi.mocked(detectFaces).mockReset();
    vi.mocked(detectFaces).mockImplementation(async () => current);
    const plan = rng(99);
    const photoNames = Array.from({ length: 30 }, (_, i) => `ph${i}`);
    for (let step = 0; step < 40; step++) {
      // last 10 steps re-scan an already-scanned photo (changed mtime => stale faces dropped)
      const name = step < 30 ? photoNames[step] : photoNames[Math.floor(plan() * 30)];
      const n = Math.floor(plan() * 4); // 0..3 faces
      const descs = Array.from({ length: n }, () => face(Math.floor(plan() * 6)));
      current = {
        faces: descs.map((descriptor) => ({ box: { x: 1, y: 1, width: 80 + plan() * 50, height: 80 + plan() * 50 }, confidence: 0.5 + plan() * 0.5, descriptor })),
        imageWidth: 640,
        imageHeight: 480,
      };
      const photo: Photo = {
        id: name, filePath: imagePath, fileName: `${name}.jpg`, fileSize: 1000, fileDate: '', dateTaken: '2026-01-01T00:00:00Z',
        year: 2026, month: 1, day: 1, isVirtual: false, originalMtimeMs: 1000 + step,
      };
      await detectFacesForPhoto(photo, imagePath, db, cache);
    }

    const faces = getAllFaces(db).map((f) => [f.id, f.photoId, f.personId ?? null] as const).sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const people = getAllPeople()
      .map((p) => ({ ...p, createdAt: 'x' }))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    return { faces, people, cache };
  }

  it('produces identical faces and people rows, and keeps the cache in step with the DB', async () => {
    const spy = vi.spyOn(FaceClusterSession.prototype, 'clusterPhoto');
    const cached = await scenario(true, 'cached');
    expect(spy.mock.calls.length).toBeGreaterThan(25); // the incremental path really ran
    const uncached = await scenario(false, 'uncached');
    expect(cached.faces.length).toBeGreaterThan(20);
    expect(cached.faces).toEqual(uncached.faces);
    expect(cached.people).toEqual(uncached.people);

    // The cache the batch left behind agrees with what was persisted.
    expect(cached.cache!.faces.map((f) => [f.id, f.photoId, f.personId ?? null] as const).sort((a, b) => (a[0] < b[0] ? -1 : 1))).toEqual(cached.faces);
    expect(cached.cache!.people.map((p) => ({ ...p, createdAt: 'x' })).sort((a, b) => (a.id < b.id ? -1 : 1))).toEqual(cached.people);
  }, 120000);
});
