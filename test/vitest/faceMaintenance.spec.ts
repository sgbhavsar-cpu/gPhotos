import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import { resetDbForTests, getDbForLibraryPath } from '../../src/main/services/db';
import { upsertPhoto, upsertPeople, getFacesForPhoto, getPhotoById } from '../../src/main/services/libraryRepository';
import { previewResetFaces, resetFaces, secondPass } from '../../src/main/services/faceMaintenanceService';
import { cropGeometry, writeFaceCropsFromBuffer, ensureFaceCrop, existingFaceCrop, deleteFaceCrops, clearMirrorFaceCrops } from '../../src/main/services/faceCropService';
import { boxIou } from '../../src/main/services/pipelineOrchestrator';

const box = { x: 0, y: 0, width: 10, height: 10 };
const face = (id: string, photoId: string, extra: Record<string, any> = {}): any => ({ id, photoId, box, descriptor: [1, 0, 0, 0], confidence: 0.9, isConfirmed: false, isManual: false, ...extra });
const photo = (id: string, faces: any[], extra: Record<string, any> = {}): any => ({
  id, filePath: `C:\\p\\${id}.jpg`, fileName: `${id}.jpg`, fileSize: 1, dateTaken: '2026-01-01', year: 2026, month: 1, day: 1,
  isFavorite: false, faceScanCompleted: true, facesLocked: false, faces, ...extra,
});

describe('face maintenance (reset + second pass) on a real library database', () => {
  let dir: string, lib: string, db: any;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gphotos_facemaint_'));
    process.env.GPHOTOS_TEST_DB_DIR = path.join(dir, 'userdata');
    fs.mkdirSync(process.env.GPHOTOS_TEST_DB_DIR, { recursive: true });
    resetDbForTests();
    lib = path.join(dir, 'Mirror');
    fs.mkdirSync(lib, { recursive: true });
    db = getDbForLibraryPath(lib);
    upsertPeople([{ id: 'A', name: 'Ann', faceCount: 0, photoCount: 0, createdAt: 'x' }, { id: 'B', name: 'Bob', faceCount: 0, photoCount: 0, createdAt: 'x' }] as any);
  });
  afterEach(() => { resetDbForTests(); delete process.env.GPHOTOS_TEST_DB_DIR; try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch {} });

  describe('reset', () => {
    beforeEach(() => {
      // p1: one automatic face. p2: one confirmed face + one automatic. p3: fully confirmed and locked. p4: scanned, no faces. v1: a video.
      upsertPhoto(photo('p1', [face('p1_f0', 'p1', { personId: 'A' })]), db);
      upsertPhoto(photo('p2', [face('p2_f0', 'p2', { personId: 'A', isConfirmed: true }), face('p2_f1', 'p2')]), db);
      upsertPhoto(photo('p3', [face('p3_f0', 'p3', { personId: 'B', isConfirmed: true })], { facesLocked: true }), db);
      upsertPhoto(photo('p4', []), db);
      upsertPhoto(photo('v1', [], { isVideo: true }), db);
    });

    it('previews the numbers without changing anything', () => {
      expect(previewResetFaces(db, false)).toEqual({ total: 4, confirmed: 2, wouldDelete: 2, wouldKeep: 2 });
      expect(previewResetFaces(db, true)).toEqual({ total: 4, confirmed: 2, wouldDelete: 4, wouldKeep: 0 });
      expect(getFacesForPhoto('p1', db)).toHaveLength(1);
    });

    it('keeps confirmed faces, deletes the rest, and queues every other photo for a new scan', () => {
      const r = resetFaces(db, { deleteConfirmed: false });
      expect(r).toMatchObject({ deletedFaces: 2, keptFaces: 2 });
      expect(r.deletedFaceIds.sort()).toEqual(['p1_f0', 'p2_f1']);
      expect(getFacesForPhoto('p2', db).map((f) => f.id)).toEqual(['p2_f0']);
      expect(getFacesForPhoto('p3', db)).toHaveLength(1);
      const flags = (id: string) => { const p = getPhotoById(id, db)!; return { done: p.faceScanCompleted, locked: p.facesLocked }; };
      expect(flags('p1')).toEqual({ done: false, locked: false });   // lost its face
      expect(flags('p2')).toEqual({ done: false, locked: false });   // lost one face: scanned again, the confirmed one is preserved then
      expect(flags('p4')).toEqual({ done: false, locked: false });   // scanned with no faces: scanned again
      expect(flags('p3')).toEqual({ done: true, locked: true });     // all faces confirmed: stays done
      expect(flags('v1')).toEqual({ done: true, locked: false });    // videos are not scanned for faces at all
    });

    it('with "delete confirmed" everything goes, including locked photos', () => {
      const r = resetFaces(db, { deleteConfirmed: true });
      expect(r).toMatchObject({ deletedFaces: 4, keptFaces: 0 });
      expect(getFacesForPhoto('p3', db)).toHaveLength(0);
      expect(getPhotoById('p3', db)).toMatchObject({ faceScanCompleted: false, facesLocked: false });
    });

    it('the people registry is not touched', () => {
      resetFaces(db, { deleteConfirmed: true });
      expect((db.prepare('SELECT COUNT(*) AS n FROM people').get() as any).n).toBeGreaterThanOrEqual(0);
    });
  });

  describe('second pass', () => {
    // Ann is confirmed in c1 (descriptor along x); Bob in c2 (along y). Unknown faces: near Ann, near Bob, between, far from both.
    beforeEach(() => {
      upsertPhoto(photo('c1', [face('c1_f0', 'c1', { personId: 'A', isConfirmed: true, descriptor: [1, 0, 0, 0] })]), db);
      upsertPhoto(photo('c2', [face('c2_f0', 'c2', { personId: 'B', isConfirmed: true, descriptor: [0, 1, 0, 0] })]), db);
      upsertPhoto(photo('u1', [face('u1_f0', 'u1', { descriptor: [0.97, 0.1, 0, 0] })]), db);               // clearly Ann
      upsertPhoto(photo('u2', [face('u2_f0', 'u2', { descriptor: [0.05, 0.99, 0, 0] })]), db);               // clearly Bob
      upsertPhoto(photo('u3', [face('u3_f0', 'u3', { descriptor: [0.7071, 0.7071, 0, 0] })]), db);           // between: too close a call
      upsertPhoto(photo('u4', [face('u4_f0', 'u4', { descriptor: [0, 0, 1, 0] })]), db);                     // matches nobody
      upsertPhoto(photo('u5', [face('u5_f0', 'u5', { personId: 'B', isConfirmed: false, descriptor: [0.98, 0.1, 0, 0] })]), db); // already assigned (wrongly): left alone
      upsertPhoto(photo('u6', [face('u6_f0', 'u6', { personId: 'A', descriptor: [1, 0, 0, 0] }), face('u6_f1', 'u6', { descriptor: [0.96, 0.12, 0, 0] })]), db); // Ann already here
    });

    it('assigns only clear matches among unknown faces and leaves everything else alone', async () => {
      const r = await secondPass(db, [db]);
      expect(r.peopleUsed).toBe(2);
      const got = Object.fromEntries(r.assignments.map((a) => [a.faceId, a.personId]));
      expect(got).toEqual({ u1_f0: 'A', u2_f0: 'B' });
      expect(r.candidates).toBe(5); // u1,u2,u3,u4,u6_f1 (the unknown ones)
      expect(getFacesForPhoto('u1', db)[0]).toMatchObject({ personId: 'A', isConfirmed: false });
      expect(getFacesForPhoto('u3', db)[0].personId).toBeUndefined();   // close call: stays unknown
      expect(getFacesForPhoto('u4', db)[0].personId).toBeUndefined();   // nobody close
      expect(getFacesForPhoto('u5', db)[0].personId).toBe('B');          // already assigned: untouched
      expect(getFacesForPhoto('u6', db).find((f) => f.id === 'u6_f1')!.personId).toBeUndefined(); // a person appears once per photo
    });

    it('can be limited to one person or to given faces', async () => {
      const onlyAnn = await secondPass(db, [db], { onlyPersonId: 'A' });
      expect(onlyAnn.assignments.map((a) => a.faceId)).toEqual(['u1_f0']);
      const some = await secondPass(db, [db], { onlyFaceIds: ['u2_f0', 'u4_f0'] });
      expect(some.assignments.map((a) => a.faceId)).toEqual(['u2_f0']);
      expect(some.candidates).toBe(2);
    });

    it('with nobody confirmed there is nothing to learn from', async () => {
      db.prepare('UPDATE faces SET is_confirmed = 0, is_manual = 0').run();
      expect(await secondPass(db, [db])).toEqual({ assignments: [], candidates: 0, peopleUsed: 0 });
    });
  });
});

describe('face crops', () => {
  it('cropGeometry pads, squares and keeps the region inside the frame', () => {
    const g = cropGeometry({ x: 100, y: 100, width: 40, height: 60 }, 1000, 800, 1000, 800)!;
    expect(g.size).toBe(Math.round(60 * 1.7));
    expect(g.left).toBe(Math.round(120 - g.size / 2));
    // near an edge: shifted inside, not shrunk
    const edge = cropGeometry({ x: 0, y: 0, width: 50, height: 50 }, 1000, 800, 1000, 800)!;
    expect(edge).toMatchObject({ left: 0, top: 0 });
    // detection frame is half the size of the decoded frame: the region scales
    expect(cropGeometry({ x: 50, y: 50, width: 20, height: 20 }, 500, 400, 1000, 800)!.size).toBe(Math.round(40 * 1.7));
    // a frame of a different shape (rotated) cannot be mapped
    expect(cropGeometry(box, 800, 1000, 1000, 800)).toBeNull();
    expect(cropGeometry({ x: 0, y: 0, width: 0, height: 5 }, 100, 100, 100, 100)).toBeNull();
  });

  describe('on disk', () => {
    let dir: string, mirror: string;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gphotos_facecrop_'));
      mirror = path.join(dir, 'MyMirror');
      fs.mkdirSync(path.join(mirror, '.gphotos_catalog'), { recursive: true });
    });
    afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch {} });

    const base = () => ({ filePath: path.join(mirror, 'a', 'thumb.jpg'), isVirtual: true, storageName: 'MyMirror' });
    const makeOriginal = async (file: string) => {
      // 800x600 grey picture with a red 100x100 "face" at (300,200)
      const red = await sharp({ create: { width: 100, height: 100, channels: 3, background: '#ff0000' } }).png().toBuffer();
      await sharp({ create: { width: 800, height: 600, channels: 3, background: '#808080' } }).composite([{ input: red, left: 300, top: 200 }]).jpeg().toFile(file);
    };

    it('writes a 256 px square crop into the mirror catalog, centred on the face, from the in-memory photo', async () => {
      const orig = path.join(dir, 'orig.jpg');
      await makeOriginal(orig);
      const made = await writeFaceCropsFromBuffer(fs.readFileSync(orig), base(), [{ faceId: 'p1_face_0', box: { x: 300, y: 200, width: 100, height: 100 }, imageWidth: 800, imageHeight: 600 }]);
      expect(made).toBe(1);
      const out = path.join(mirror, '.gphotos_catalog', 'face_crops', 'p1_face_0.jpg');
      expect(fs.existsSync(out)).toBe(true);
      const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
      expect([info.width, info.height]).toEqual([256, 256]);
      const px = (x: number, y: number) => [data[(y * 256 + x) * info.channels], data[(y * 256 + x) * info.channels + 1], data[(y * 256 + x) * info.channels + 2]];
      expect(px(128, 128)[0]).toBeGreaterThan(200);   // centre = the red face
      expect(px(128, 128)[1]).toBeLessThan(60);
      expect(px(4, 4)[0]).toBeGreaterThan(100);       // corner = surrounding grey (padding)
      expect(px(4, 4)[0]).toBeLessThan(160);
      expect(existingFaceCrop({ ...base(), faceId: 'p1_face_0', box })).toBe(out);
    });

    it('ensureFaceCrop reads the original for a face found earlier, and gives up cleanly for videos and unreadable files', async () => {
      const orig = path.join(dir, 'orig.png.jpg');
      await makeOriginal(orig);
      const req = { ...base(), originalRemotePath: orig, faceId: 'late_0', box: { x: 300, y: 200, width: 100, height: 100 }, imageWidth: 800, imageHeight: 600 };
      const p = await ensureFaceCrop(req);
      expect(p && fs.existsSync(p)).toBe(true);
      expect(await ensureFaceCrop({ ...req, faceId: 'vid_0', isVideo: true })).toBeNull();
      expect(await ensureFaceCrop({ ...req, faceId: 'gone_0', originalRemotePath: path.join(dir, 'nope.jpg') })).toBeNull();
      expect(await ensureFaceCrop({ ...req, faceId: '../evil' })).toBeNull();
    });

    it('crops are deleted per face, or all together', async () => {
      const orig = path.join(dir, 'orig.jpg');
      await makeOriginal(orig);
      const faces = ['a_0', 'a_1', 'b_0'].map((faceId) => ({ faceId, box: { x: 300, y: 200, width: 100, height: 100 }, imageWidth: 800, imageHeight: 600 }));
      await writeFaceCropsFromBuffer(fs.readFileSync(orig), base(), faces);
      expect(deleteFaceCrops(base(), ['a_0', 'a_1'])).toBe(2);
      expect(fs.readdirSync(path.join(mirror, '.gphotos_catalog', 'face_crops'))).toEqual(['b_0.jpg']);
      expect(clearMirrorFaceCrops(mirror)).toBe(1);
    });
  });
});

describe('boxIou', () => {
  it('measures overlap', () => {
    expect(boxIou({ x: 0, y: 0, width: 10, height: 10 }, { x: 0, y: 0, width: 10, height: 10 })).toBe(1);
    expect(boxIou({ x: 0, y: 0, width: 10, height: 10 }, { x: 20, y: 20, width: 10, height: 10 })).toBe(0);
    expect(boxIou({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 0, width: 10, height: 10 })).toBeCloseTo(50 / 150, 5);
  });
});
