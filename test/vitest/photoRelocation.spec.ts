import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import { resetDbForTests, getDb, getDbForLibraryPath, getGlobalDb, setActiveLibrary } from '../../src/main/services/db';
import { setSetting, upsertPhoto, replaceFacesForPhoto, upsertAlbum, upsertPerson, getAllPeople } from '../../src/main/services/libraryRepository';
import { syncVirtualStorage, enqueuePendingRotation, getPendingRotations, savePendingRotations } from '../../src/main/services/virtualMirrorService';
import { setHeicSavedRotation, getAllHeicSavedRotations, resetHeicRotationCacheForTests } from '../../src/main/services/heicRotationStore';
import { resetReachabilityCacheForTests } from '../../src/main/services/networkReachabilityCache';
import { planRelocation, relocatePhotos, type RelocationPhotoInput } from '../../src/main/services/photoRelocation';
import type { VirtualStorageConfig } from '../../src/types';

const b64 = (s: string) => Buffer.from(s).toString('base64');
const norm = (s: string) => s.toLowerCase().replace(/\\/g, '/');

async function jpeg(file: string, r = 10): Promise<void> {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await sharp({ create: { width: 64, height: 64, channels: 3, background: { r, g: 20, b: 30 } } }).jpeg().toFile(file);
}

const face = (photoId: string, n: number) => ({
  id: `${photoId}_face_${n}`,
  photoId,
  box: { x: 1, y: 2, width: 3, height: 4 },
  descriptor: [0.1, 0.2],
  confidence: 0.9,
});

describe('photoRelocation', () => {
  let tempDir: string;
  let lib: string;
  let net: string;
  let mirrors: string;
  let storage: VirtualStorageConfig;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gphotos_reloc_'));
    process.env.GPHOTOS_TEST_DB_DIR = tempDir;
    process.env.GPHOTOS_TEST_CONFIG_DIR = path.join(tempDir, 'cfg');
    fs.mkdirSync(process.env.GPHOTOS_TEST_CONFIG_DIR, { recursive: true });
    resetDbForTests();
    resetHeicRotationCacheForTests();
    resetReachabilityCacheForTests();
    lib = path.join(tempDir, 'Lib');
    net = path.join(tempDir, 'Net');
    mirrors = path.join(tempDir, 'Mirrors');
    for (const d of [lib, net, mirrors]) fs.mkdirSync(d, { recursive: true });
    storage = { id: 's1', name: 'Nas', networkSourcePath: net, localMirrorRoot: mirrors };
    setSetting('selectedFolder', lib);
    setSetting('recentLibraries', [lib]);
    setSetting('gphotos_virtual_storages_v1', [storage]);
    setActiveLibrary(lib);
    savePendingRotations([]);
  });

  afterEach(() => {
    savePendingRotations([]);
    resetDbForTests();
    resetHeicRotationCacheForTests();
    delete process.env.GPHOTOS_TEST_DB_DIR;
    delete process.env.GPHOTOS_TEST_CONFIG_DIR;
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  function plainInput(filePath: string): RelocationPhotoInput {
    return { id: b64(filePath), filePath, fileName: path.basename(filePath) };
  }

  /** A plain library photo with row, face, album, person cover, rotation flag, companions. */
  async function seedPlain(rel: string, opts?: { companions?: boolean }) {
    const filePath = path.join(lib, rel);
    await jpeg(filePath);
    const id = b64(filePath);
    if (opts?.companions) {
      const stem = filePath.replace(/\.jpg$/, '');
      fs.writeFileSync(stem + '.xmp', 'xmp-data');
      fs.writeFileSync(stem + '.aae', 'aae-data');
      fs.writeFileSync(filePath + '.bak', 'bak-data');
    }
    upsertPhoto({
      id, filePath, fileName: path.basename(filePath), fileSize: 1, fileDate: '', dateTaken: '2020-01-02T00:00:00.000Z',
      year: 2020, month: 1, day: 2, isFavorite: false, faces: [face(id, 0), face(id, 1)],
    } as any, getDb());
    getDb().prepare('UPDATE photos SET thumbnail_cached_at = ? WHERE id = ?').run('2020-01-01', id);
    upsertAlbum({ id: 'alb', title: 'A', photoIds: [id], coverPhotoId: id, createdAt: 'x', updatedAt: 'x' } as any, getDb());
    upsertPerson({ id: 'per', name: 'P', coverFaceId: `${id}_face_1`, coverPhotoId: id, faceCount: 2, photoCount: 1, createdAt: 'x' } as any);
    setHeicSavedRotation(filePath, 90);
    return { filePath, id };
  }

  it('moves a plain library photo and remaps files, rows, faces, albums, people and rotation flags', async () => {
    const { filePath, id } = await seedPlain('A/one.jpg', { companions: true });
    const target = path.join(lib, 'B', 'deep');
    const input = plainInput(filePath);

    const plan = await planRelocation([input]);
    expect(plan.root).toEqual({ kind: 'library', label: 'Lib', path: lib });
    expect(plan.movableIds).toEqual([id]);

    const progress: Array<[number, number]> = [];
    const out = await relocatePhotos({ photos: [input], targetDir: target, onProgress: (d, t) => progress.push([d, t]) });
    expect(out.error).toBeUndefined();
    expect(progress).toEqual([[1, 1]]);
    const r = out.results[0];
    const newPath = path.join(target, 'one.jpg');
    const newId = b64(newPath);
    expect(r).toMatchObject({ oldId: id, status: 'moved', newId, newFilePath: newPath, newFileName: 'one.jpg' });

    // files (original + companions) moved, nothing left behind
    for (const n of ['one.jpg', 'one.xmp', 'one.aae', 'one.jpg.bak']) {
      expect(fs.existsSync(path.join(target, n))).toBe(true);
      expect(fs.existsSync(path.join(lib, 'A', n))).toBe(false);
    }
    expect(fs.readFileSync(path.join(target, 'one.xmp'), 'utf-8')).toBe('xmp-data');

    const db = getDb();
    expect(db.prepare('SELECT COUNT(*) c FROM photos WHERE id = ?').get(id)).toMatchObject({ c: 0 });
    const row = db.prepare('SELECT * FROM photos WHERE id = ?').get(newId) as any;
    expect(row.file_path).toBe(newPath);
    expect(row.file_name).toBe('one.jpg');
    expect(row.thumbnail_cached_at).toBeNull();
    const faces = db.prepare('SELECT id, photo_id FROM faces ORDER BY id').all() as any[];
    expect(faces).toEqual([
      { id: `${newId}_face_0`, photo_id: newId },
      { id: `${newId}_face_1`, photo_id: newId },
    ]);
    expect(db.prepare('SELECT photo_id FROM album_photos').all()).toEqual([{ photo_id: newId }]);
    expect((db.prepare('SELECT cover_photo_id FROM albums').get() as any).cover_photo_id).toBe(newId);
    const [person] = getAllPeople();
    expect(person.coverPhotoId).toBe(newId);
    expect(person.coverFaceId).toBe(`${newId}_face_1`);
    const flags = getAllHeicSavedRotations();
    expect(Object.keys(flags)).toEqual([newPath.toLowerCase().replace(/\\/g, '/')]);
  });

  it('moves a virtual-storage photo (original + mirror pair), rewrites the sidecar, and a re-sync neither duplicates nor prunes', async () => {
    await jpeg(path.join(net, '2020', 'a.jpg'), 10);
    await jpeg(path.join(net, '2020', 'b.jpg'), 60);
    fs.writeFileSync(path.join(net, '2020', 'a.xmp'), 'xmp');
    await syncVirtualStorage(storage);

    const mirror = path.join(mirrors, 'Nas');
    const mdb = getDbForLibraryPath(mirror);
    const oldThumb = path.join(mirror, '2020', 'a.jpg');
    const oldId = b64(oldThumb);
    const rows = mdb.prepare('SELECT id, file_path FROM photos').all() as any[];
    expect(rows.map((r) => r.id).sort()).toEqual([oldId, b64(path.join(mirror, '2020', 'b.jpg'))].sort());

    replaceFacesForPhoto(oldId, [face(oldId, 0)] as any, false, mdb);
    upsertAlbum({ id: 'alb', title: 'A', photoIds: [oldId], coverPhotoId: oldId, createdAt: 'x', updatedAt: 'x' } as any, getDb()); // active (library) db
    upsertPerson({ id: 'per', name: 'P', coverFaceId: `${oldId}_face_0`, coverPhotoId: oldId, faceCount: 1, photoCount: 1, createdAt: 'x' } as any);
    const oldOrig = path.join(net, '2020', 'a.jpg');
    setHeicSavedRotation(oldThumb, 90);
    enqueuePendingRotation(oldOrig, 90, oldThumb);

    const input: RelocationPhotoInput = { id: oldId, filePath: oldThumb, fileName: 'a.jpg', originalRemotePath: oldOrig, isVirtual: true, storageName: 'Nas' };
    const target = path.join(net, 'Moved', 'x');
    const out = await relocatePhotos({ photos: [input], targetDir: target });
    expect(out.error).toBeUndefined();
    expect(out.root).toEqual({ kind: 'storage', label: 'Nas', path: net });

    const newOrig = path.join(target, 'a.jpg');
    const newThumb = path.join(mirror, 'Moved', 'x', 'a.jpg');
    const newId = b64(newThumb);
    expect(out.results[0]).toMatchObject({ status: 'moved', oldId, newId, newFilePath: newThumb, newOriginalRemotePath: newOrig, newFileName: 'a.jpg' });

    // network side
    expect(fs.existsSync(newOrig)).toBe(true);
    expect(fs.existsSync(path.join(target, 'a.xmp'))).toBe(true);
    expect(fs.existsSync(oldOrig)).toBe(false);
    // mirror side
    expect(fs.existsSync(newThumb)).toBe(true);
    expect(fs.existsSync(path.join(mirror, 'Moved', 'x', 'a.json'))).toBe(true);
    expect(fs.existsSync(oldThumb)).toBe(false);
    expect(fs.existsSync(path.join(mirror, '2020', 'a.json'))).toBe(false);
    const sc = JSON.parse(fs.readFileSync(path.join(mirror, 'Moved', 'x', 'a.json'), 'utf-8'));
    expect(sc).toMatchObject({
      fileName: 'a.jpg', originalFilePath: newOrig, thumbnailPath: newThumb, storageRoot: net,
      relativePath: path.join('Moved', 'x', 'a.jpg'), storageName: 'Nas',
    });

    // rows
    expect(mdb.prepare('SELECT COUNT(*) c FROM photos WHERE id = ?').get(oldId)).toMatchObject({ c: 0 });
    const row = mdb.prepare('SELECT * FROM photos WHERE id = ?').get(newId) as any;
    expect(row).toMatchObject({ file_path: newThumb, original_remote_path: newOrig, file_name: 'a.jpg', storage_name: 'Nas', is_virtual: 1 });
    expect((mdb.prepare('SELECT id, photo_id FROM faces').get() as any)).toEqual({ id: `${newId}_face_0`, photo_id: newId });
    expect(getDb().prepare('SELECT photo_id FROM album_photos').all()).toEqual([{ photo_id: newId }]);
    expect((getDb().prepare('SELECT cover_photo_id FROM albums').get() as any).cover_photo_id).toBe(newId);
    expect(getAllPeople()[0]).toMatchObject({ coverPhotoId: newId, coverFaceId: `${newId}_face_0` });
    // setHeicSavedRotation also mirrors the flag onto the sidecar's original path: both keys must follow the move
    expect(Object.keys(getAllHeicSavedRotations()).sort()).toEqual([newThumb, newOrig].map(norm).sort());
    expect(getPendingRotations()).toMatchObject([{ originalRemotePath: newOrig, localFilePath: newThumb }]);

    // KEY INTEGRATION CHECK: the real sync against the moved layout
    const sync = await syncVirtualStorage(storage);
    expect(sync.success).toBe(true);
    expect(sync.totalSynced).toBe(2);
    expect(sync.newlyAdded).toBe(0); // sidecar matched -> no re-thumbnail
    const after = (mdb.prepare('SELECT id, file_path, original_remote_path FROM photos').all() as any[]).sort((x, y) => x.id.localeCompare(y.id));
    expect(after.map((r) => r.id).sort()).toEqual([newId, b64(path.join(mirror, '2020', 'b.jpg'))].sort());
    expect(fs.existsSync(newThumb)).toBe(true);
    expect(fs.existsSync(path.join(mirror, 'Moved', 'x', 'a.json'))).toBe(true);
    expect(fs.existsSync(oldThumb)).toBe(false); // sync did not resurrect the old mirror entry
    expect((mdb.prepare('SELECT COUNT(*) c FROM faces').get() as any).c).toBe(1);
  });

  it('never overwrites: a name clash gets a "(1)" suffix and companions follow the new name', async () => {
    const { filePath, id } = await seedPlain('A/one.jpg', { companions: true });
    const target = path.join(lib, 'B');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'one.jpg'), 'EXISTING-BYTES');
    fs.writeFileSync(path.join(target, 'one.xmp'), 'EXISTING-XMP');

    const out = await relocatePhotos({ photos: [plainInput(filePath)], targetDir: target });
    const newPath = path.join(target, 'one (1).jpg');
    expect(out.results[0]).toMatchObject({ status: 'moved', newFileName: 'one (1).jpg', newId: b64(newPath) });
    expect(fs.readFileSync(path.join(target, 'one.jpg'), 'utf-8')).toBe('EXISTING-BYTES');
    expect(fs.readFileSync(path.join(target, 'one.xmp'), 'utf-8')).toBe('EXISTING-XMP');
    expect(fs.readFileSync(path.join(target, 'one (1).xmp'), 'utf-8')).toBe('xmp-data');
    expect(fs.existsSync(path.join(target, 'one (1).jpg.bak'))).toBe(true);
    expect(getDb().prepare('SELECT COUNT(*) c FROM photos WHERE id = ?').get(b64(newPath))).toMatchObject({ c: 1 });
    expect(getDb().prepare('SELECT COUNT(*) c FROM photos WHERE id = ?').get(id)).toMatchObject({ c: 0 });
  });

  it('two same-named photos moved into one folder get distinct names', async () => {
    const a = await seedPlain('A/x.jpg');
    await jpeg(path.join(lib, 'C', 'x.jpg'), 99);
    const b = plainInput(path.join(lib, 'C', 'x.jpg'));
    const target = path.join(lib, 'B');
    const out = await relocatePhotos({ photos: [plainInput(a.filePath), b], targetDir: target });
    expect(out.results.map((r) => r.status)).toEqual(['moved', 'moved']);
    expect(out.results.map((r) => r.newFileName)).toEqual(['x.jpg', 'x (1).jpg']);
    expect(fs.readdirSync(target).sort()).toEqual(['x (1).jpg', 'x.jpg']);
  });

  it('refuses a target outside the root (absolute, relative, traversal) and touches nothing', async () => {
    const { filePath } = await seedPlain('A/one.jpg');
    const outside = path.join(tempDir, 'Other');
    for (const t of [outside, 'relative/dir', path.join(lib, '..', 'Other'), path.join(lib, 'A', '..', '..', 'Other')]) {
      const out = await relocatePhotos({ photos: [plainInput(filePath)], targetDir: t });
      expect(out.error).toBeTruthy();
      expect(out.results[0].status).toBe('skipped');
    }
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.existsSync(outside)).toBe(false);
  });

  it('skips a photo already in the target folder', async () => {
    const { filePath, id } = await seedPlain('A/one.jpg');
    const out = await relocatePhotos({ photos: [plainInput(filePath)], targetDir: path.join(lib, 'A') });
    expect(out.results[0]).toMatchObject({ oldId: id, status: 'skipped' });
    expect(out.results[0].reason).toMatch(/already in this folder/i);
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it('plan: biggest root wins, other roots / offline storage / missing files / unknown paths are skipped with reasons', async () => {
    const p1 = await seedPlain('A/one.jpg');
    const p2 = await seedPlain('A/two.jpg');
    await jpeg(path.join(net, 'v.jpg'));
    const virt: RelocationPhotoInput = { id: 'v1', filePath: path.join(mirrors, 'Nas', 'v.jpg'), fileName: 'v.jpg', originalRemotePath: path.join(net, 'v.jpg'), isVirtual: true, storageName: 'Nas' };
    const missing = plainInput(path.join(lib, 'A', 'gone.jpg'));
    const stray = plainInput(path.join(tempDir, 'nowhere', 'z.jpg'));
    const offlineNet = path.join(tempDir, 'OfflineNet'); // never created
    setSetting('gphotos_virtual_storages_v1', [storage, { id: 's2', name: 'Off', networkSourcePath: offlineNet, localMirrorRoot: mirrors }]);
    const off: RelocationPhotoInput = { id: 'o1', filePath: path.join(mirrors, 'Off', 'o.jpg'), fileName: 'o.jpg', originalRemotePath: path.join(offlineNet, 'o.jpg'), isVirtual: true, storageName: 'Off' };

    const plan = await planRelocation([plainInput(p1.filePath), plainInput(p2.filePath), virt, missing, stray, off]);
    expect(plan.root).toEqual({ kind: 'library', label: 'Lib', path: lib });
    expect(plan.movableIds).toEqual([p1.id, p2.id]);
    const reasons = Object.fromEntries(plan.skipped.map((s) => [s.id, s.reason]));
    expect(reasons['v1']).toMatch(/Nas/);
    expect(reasons[missing.id]).toMatch(/missing/i);
    expect(reasons[stray.id]).toMatch(/known library/i);
    expect(reasons['o1']).toMatch(/offline/i);

    // an offline-only selection has no root and cannot be relocated
    const onlyOff = await relocatePhotos({ photos: [off], targetDir: path.join(offlineNet, 'x') });
    expect(onlyOff.root).toBeNull();
    expect(onlyOff.error).toBeTruthy();
    expect(onlyOff.results[0].status).toBe('skipped');
  });

  it('rolls back a virtual photo completely when the mirror destination is unusable', async () => {
    await jpeg(path.join(net, 'a.jpg'), 10);
    fs.writeFileSync(path.join(net, 'a.xmp'), 'xmp');
    await syncVirtualStorage(storage);
    const mirror = path.join(mirrors, 'Nas');
    const mdb = getDbForLibraryPath(mirror);
    const oldThumb = path.join(mirror, 'a.jpg');
    const oldId = b64(oldThumb);
    replaceFacesForPhoto(oldId, [face(oldId, 0)] as any, false, mdb);
    setHeicSavedRotation(oldThumb, 90);
    const sidecarBefore = fs.readFileSync(path.join(mirror, 'a.json'), 'utf-8');
    const before = mdb.prepare('SELECT * FROM photos WHERE id = ?').get(oldId);

    // A FILE where the mirror folder must be created -> mkdir fails after the original was already moved.
    fs.writeFileSync(path.join(mirror, 'Moved'), 'blocker');
    const input: RelocationPhotoInput = { id: oldId, filePath: oldThumb, fileName: 'a.jpg', originalRemotePath: path.join(net, 'a.jpg'), isVirtual: true, storageName: 'Nas' };
    const out = await relocatePhotos({ photos: [input], targetDir: path.join(net, 'Moved') });

    expect(out.results[0].status).toBe('failed');
    expect(out.results[0].reason).toBeTruthy();
    expect(out.results[0].reason).not.toMatch(/rollback incomplete/);
    // everything exactly as before
    expect(fs.existsSync(path.join(net, 'a.jpg'))).toBe(true);
    expect(fs.existsSync(path.join(net, 'a.xmp'))).toBe(true);
    expect(fs.existsSync(path.join(net, 'Moved', 'a.jpg'))).toBe(false);
    expect(fs.existsSync(oldThumb)).toBe(true);
    expect(fs.readFileSync(path.join(mirror, 'a.json'), 'utf-8')).toBe(sidecarBefore);
    expect(mdb.prepare('SELECT * FROM photos WHERE id = ?').get(oldId)).toEqual(before);
    expect((mdb.prepare('SELECT id FROM faces').get() as any).id).toBe(`${oldId}_face_0`);
    expect(Object.keys(getAllHeicSavedRotations()).sort()).toEqual([oldThumb, path.join(net, 'a.jpg')].map(norm).sort());
  });

  it('rolls back the filesystem when a later DB step fails (people table unavailable)', async () => {
    const { filePath, id } = await seedPlain('A/one.jpg', { companions: true });
    getGlobalDb().exec('ALTER TABLE people RENAME TO people_gone'); // remapPeopleCoversForPhoto will throw
    const target = path.join(lib, 'B');
    const out = await relocatePhotos({ photos: [plainInput(filePath)], targetDir: target });
    getGlobalDb().exec('ALTER TABLE people_gone RENAME TO people');

    expect(out.results[0].status).toBe('failed');
    for (const n of ['one.jpg', 'one.xmp', 'one.aae', 'one.jpg.bak']) {
      expect(fs.existsSync(path.join(lib, 'A', n))).toBe(true);
      expect(fs.existsSync(path.join(target, n))).toBe(false);
    }
    const db = getDb();
    expect(db.prepare('SELECT file_path FROM photos WHERE id = ?').get(id)).toEqual({ file_path: filePath });
    expect((db.prepare('SELECT COUNT(*) c FROM faces WHERE photo_id = ?').get(id) as any).c).toBe(2);
    expect(db.prepare('SELECT photo_id FROM album_photos').all()).toEqual([{ photo_id: id }]);
    expect(Object.keys(getAllHeicSavedRotations())).toEqual([filePath.toLowerCase().replace(/\\/g, '/')]);
  });
});
