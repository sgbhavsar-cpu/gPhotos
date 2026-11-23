import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { clusterFaces as mainCluster } from '../../src/main/services/faceClustering';
import { clusterFaces as rendCluster, matchUnassignedFacesToCentroid } from '../../src/renderer/src/services/clustering';
import { resetDbForTests, getDbForLibraryPath } from '../../src/main/services/db';
import { upsertPhoto, upsertPeople, getFacesForPhoto, getAllFaces } from '../../src/main/services/libraryRepository';
import { secondPass } from '../../src/main/services/faceMaintenanceService';

// "Not this person" must stick: the face has no person afterwards, and every automatic matching pass used to hand it straight back
// to the person it was closest to (at startup, after a merge, on the next scan). The rejection is remembered on the face.

const unit = (a: number, b: number) => { const n = Math.hypot(a, b); return [a / n, b / n, 0, 0]; };
const face = (id: string, photoId: string, d: number[], extra: any = {}): any => ({ id, photoId, box: { x: 0, y: 0, width: 50, height: 50 }, descriptor: d, confidence: 0.9, isConfirmed: false, isManual: false, ...extra });
const people = () => [{ id: 'P', name: 'Ann', faceCount: 2, photoCount: 2, createdAt: 'x' }, { id: 'Q', name: 'Bea', faceCount: 1, photoCount: 1, createdAt: 'x' }] as any;
const anchors = () => [
  face('a', 'p1', unit(1, 0.02), { personId: 'P', isConfirmed: true }),
  face('b', 'p2', unit(1, 0.03), { personId: 'P', isConfirmed: true }),
  face('q', 'p9', unit(0.2, 1), { personId: 'Q', isConfirmed: true }),
];

for (const [name, fn] of [['main', mainCluster], ['renderer', rendCluster]] as const) {
  describe(`${name} clustering`, () => {
    it('without a rejection a face close to a person is given to them (the old behaviour, for comparison)', () => {
      const out = (fn as any)([...anchors(), face('x', 'p3', unit(1, 0.04))], people());
      expect(out.updatedFaces.find((f: any) => f.id === 'x').personId).toBe('P');
    });

    it('a face rejected for that person is NOT given back to them', () => {
      const out = (fn as any)([...anchors(), face('x', 'p3', unit(1, 0.04), { rejectedPersonIds: ['P'] })], people());
      const x = out.updatedFaces.find((f: any) => f.id === 'x');
      expect(x.personId).not.toBe('P');
      expect(x.personId).toBeTruthy(); // it becomes someone else (here: a new unnamed person), but never Ann
    });

    it('a rejection for one person does not stop a match with another', () => {
      const out = (fn as any)([...anchors(), face('y', 'p4', unit(0.25, 1), { rejectedPersonIds: ['P'] })], people());
      expect(out.updatedFaces.find((f: any) => f.id === 'y').personId).toBe('Q');
    });
  });
}

describe('"Find more" matching in the window', () => {
  it('skips a face rejected for that person', () => {
    const photos = [
      { id: 'p3', faces: [{ id: 'x', descriptor: unit(1, 0.04), rejectedPersonIds: ['P'] }] },
      { id: 'p4', faces: [{ id: 'z', descriptor: unit(1, 0.05) }] },
    ];
    const hits = matchUnassignedFacesToCentroid(photos as any, 'P', unit(1, 0), 0.42);
    expect(hits).toEqual([{ photoId: 'p4', faceId: 'z' }]);
  });
});

describe('on a real database', () => {
  let dir: string, db: any;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gphotos_reject_'));
    process.env.GPHOTOS_TEST_DB_DIR = path.join(dir, 'userdata');
    fs.mkdirSync(process.env.GPHOTOS_TEST_DB_DIR, { recursive: true });
    resetDbForTests();
    const lib = path.join(dir, 'Lib');
    fs.mkdirSync(lib, { recursive: true });
    db = getDbForLibraryPath(lib);
    upsertPeople(people());
  });
  afterEach(() => { resetDbForTests(); delete process.env.GPHOTOS_TEST_DB_DIR; try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch {} });
  const photo = (id: string, faces: any[]): any => ({ id, filePath: `C:\\p\\${id}.jpg`, fileName: `${id}.jpg`, fileSize: 1, dateTaken: '2026-01-01', year: 2026, month: 1, day: 1, isFavorite: false, faceScanCompleted: true, facesLocked: false, faces });

  it('the rejection is saved with the face and read back (the database column is created on open)', () => {
    upsertPhoto(photo('p3', [face('x', 'p3', unit(1, 0.04), { rejectedPersonIds: ['P', 'Q'] }), face('y', 'p3', unit(0, 1))]), db);
    const faces = getFacesForPhoto('p3', db);
    expect(faces.find((f) => f.id === 'x')!.rejectedPersonIds).toEqual(['P', 'Q']);
    expect(faces.find((f) => f.id === 'y')!.rejectedPersonIds).toBeUndefined();
    expect(getAllFaces(db).find((f) => f.id === 'x')!.rejectedPersonIds).toEqual(['P', 'Q']);
  });

  it('the second pass never hands a face to a person it was rejected for', async () => {
    upsertPhoto(photo('p1', [anchors()[0]]), db);
    upsertPhoto(photo('p2', [anchors()[1]]), db);
    upsertPhoto(photo('p3', [face('rej', 'p3', unit(1, 0.04), { rejectedPersonIds: ['P'] })]), db);
    upsertPhoto(photo('p4', [face('ok', 'p4', unit(1, 0.05))]), db);
    const r = await secondPass(db, [db]);
    expect(r.assignments.map((a) => a.faceId)).toEqual(['ok']);
    const viaIds = await secondPass(db, [db], { onlyFaceIds: ['rej'] });
    expect(viaIds.assignments).toEqual([]);
  });
});

describe('libraryStore: "Not this person" is remembered', () => {
  let store: any;
  let saves: any[];
  beforeEach(async () => {
    saves = [];
    (globalThis as any).window = { addEventListener: () => {}, electronAPI: { loadLibraryData: async () => null, saveLibraryData: async (key: string, data: any) => { saves.push({ key, data }); return true; } } };
    vi.resetModules();
    const { LibraryManager } = await import('../../src/renderer/src/services/libraryStore');
    store = new LibraryManager();
    await new Promise((r) => setTimeout(r, 20));
    const f = face('f1', 'p1', unit(1, 0), { personId: 'P' });
    store.state.people = people();
    store.state.faces = [f];
    store.state.photos = [{ id: 'p1', filePath: 'C:\\p\\p1.jpg', fileName: 'p1.jpg', fileSize: 1, dateTaken: '2026-01-01', year: 2026, month: 1, day: 1, isFavorite: false, faceScanCompleted: true, facesLocked: false, faces: [f] }];
    await store.persistNow();
    saves.length = 0;
  });
  afterEach(() => { if (store.saveDebounceTimer) clearTimeout(store.saveDebounceTimer); delete (globalThis as any).window; });
  const theFace = () => store.state.photos[0].faces[0];
  const savedFace = () => saves.filter((s) => s.key === 'gphotos_library_v1').flatMap((s) => s.data?.photos ?? []).flatMap((p: any) => p.faces ?? []).find((x: any) => x.id === 'f1');

  it('unassigning records who the face was taken from, on the face and in what is saved', async () => {
    await store.unassignFaceFromPerson('f1');
    expect(theFace()).toMatchObject({ personId: undefined, rejectedPersonIds: ['P'] });
    expect(store.state.faces[0].rejectedPersonIds).toEqual(['P']);
    await store.persistNow();
    expect(savedFace()).toMatchObject({ rejectedPersonIds: ['P'] });
    expect(savedFace().personId).toBeUndefined();
  });

  it('the startup re-matching (reconcilePeopleAndFaces) does not give a rejected face back — and still matches an ordinary unknown face', async () => {
    const mk = (id: string, photoId: string, d: number[], extra: any = {}) => face(id, photoId, d, extra);
    const faces = [
      ...anchors(),
      mk('rej', 'p3', unit(1, 0.04), { rejectedPersonIds: ['P'] }),   // the user pressed "Not this person" on this one before the restart
      mk('plain', 'p4', unit(1, 0.025)),                               // an ordinary unknown face next to Ann
    ];
    store.state.people = people();
    store.state.faces = faces;
    store.state.photos = faces.map((f: any) => ({ id: f.photoId, filePath: `C:\p\${f.photoId}.jpg`, fileName: `${f.photoId}.jpg`, fileSize: 1, dateTaken: '2026-01-01', year: 2026, month: 1, day: 1, isFavorite: false, faceScanCompleted: true, facesLocked: false, faces: [f] }));
    await store.reconcilePeopleAndFaces();
    const byId = (id: string) => store.state.faces.find((f: any) => f.id === id);
    expect(byId('plain').personId).toBe('P');
    expect(byId('rej').personId).not.toBe('P');
    expect(byId('rej').rejectedPersonIds).toEqual(['P']);
  });

  it('rejecting twice does not repeat the person', async () => {
    await store.unassignFaceFromPerson('f1');
    store.state.faces[0].personId = 'P';
    theFace().personId = 'P';
    await store.unassignFaceFromPerson('f1');
    expect(theFace().rejectedPersonIds).toEqual(['P']);
  });

  it('confirming the face as that person clears the rejection', async () => {
    await store.unassignFaceFromPerson('f1');
    expect(theFace().rejectedPersonIds).toEqual(['P']);
    store.state.faces[0].personId = 'P'; theFace().personId = 'P'; // the user puts it back by hand...
    await store.confirmFace('f1');                                  // ...and confirms it
    expect(theFace().rejectedPersonIds).toBeUndefined();
  });

  it('moving a face to another person rejects the first one and clears the second', async () => {
    store.state.faces[0].rejectedPersonIds = ['Q']; theFace().rejectedPersonIds = ['Q'];
    const r = await store.reassignFaceToPerson('f1', 'Q');
    expect(r.success).toBe(true);
    expect(theFace().personId).toBe('Q');
    expect(theFace().rejectedPersonIds).toEqual(['P']);
  });
});
