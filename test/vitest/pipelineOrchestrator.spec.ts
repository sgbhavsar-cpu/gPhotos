import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import { resetDbForTests, setActiveLibrary, getDb, getDbForLibraryPath } from '../../src/main/services/db';
import { getPhotoById, upsertPhoto, replaceFacesForPhoto, getAllFaces } from '../../src/main/services/libraryRepository';
import { detectFacesForPhoto, forceRedetectFacesForPhoto, resolveDbForPhoto } from '../../src/main/services/pipelineOrchestrator';
import { Photo, DetectedFace } from '../../src/types';

// These exercise the real ONNX detection engine against a synthetic
// (faceless) image — slower than a pure-logic unit test, but the lock/
// offline-gating/upsert behavior around detection is exactly what's being
// verified here, not detection accuracy (that's covered separately by the
// Sprint 2 manual spot-check against real photos).

function makeLocalPhoto(id: string, filePath: string): Photo {
  return {
    id,
    filePath,
    fileName: path.basename(filePath),
    fileSize: 1000,
    fileDate: '',
    dateTaken: '2026-01-01T00:00:00Z',
    year: 2026,
    month: 1,
    day: 1,
    isVirtual: false,
  };
}

describe('pipelineOrchestrator face detection step', () => {
  let tempDir: string;
  let libraryDir: string;
  let imagePath: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gphotos_pipeline_test_'));
    process.env.GPHOTOS_TEST_DB_DIR = tempDir;
    libraryDir = path.join(tempDir, 'Library');
    fs.mkdirSync(libraryDir, { recursive: true });
    resetDbForTests();
    setActiveLibrary(libraryDir);

    imagePath = path.join(tempDir, 'blank.jpg');
    // A plain solid-color image — deliberately faceless, so detection always
    // returns zero results (exercising the "trivially locked" path) without
    // needing a real portrait fixture or network access in the test suite.
    await sharp({
      create: { width: 320, height: 240, channels: 3, background: { r: 120, g: 140, b: 160 } },
    }).jpeg().toFile(imagePath);
  }, 30000);

  afterEach(() => {
    resetDbForTests();
    delete process.env.GPHOTOS_TEST_DB_DIR;
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('locks a photo automatically when zero faces are detected', async () => {
    const photo = makeLocalPhoto('local1', imagePath);
    const result = await detectFacesForPhoto(photo, imagePath);

    expect(result.ran).toBe(true);
    expect(result.faceCount).toBe(0);
    expect(result.locked).toBe(true);

    const stored = getPhotoById('local1');
    expect(stored?.faceScanCompleted).toBe(true);
    expect(stored?.facesLocked).toBe(true);
  }, 30000);

  it('skips re-detection on a locked photo without touching it', async () => {
    const photo = makeLocalPhoto('local2', imagePath);
    await detectFacesForPhoto(photo, imagePath);

    const second = await detectFacesForPhoto(photo, imagePath);
    expect(second.ran).toBe(false);
    expect(second.skippedReason).toBe('locked');
  }, 30000);

  // Regression: found against a real photo — "8 faces detected" reported
  // correctly, but the faces table ended up with 0. detectFacesForPhoto
  // persists fresh detections via its own replaceFacesForPhoto call, then
  // calls upsertPhoto(working, db) moments later just to save the photo's
  // metadata flags (faceScanCompleted etc) — but upsertPhoto ALSO replaces
  // a photo's faces whenever .faces is set on the object it's given (even
  // an empty array, which is truthy in JS). Since `working` is a shallow
  // copy of whatever photo object the CALLER passed in, its .faces still
  // held the caller's (here: stale/empty) snapshot — so that later,
  // metadata-only upsertPhoto call silently overwrote the faces just
  // inserted. This must hold on every early-return path too, not just the
  // full-detection path: exercised here via the 'locked' skip branch, where
  // no real detection runs at all but upsertPhoto(working, db) still does.
  it('does not let a stale .faces snapshot on the input photo wipe what is actually in the database (locked-skip path)', async () => {
    const photo = makeLocalPhoto('local_stale_faces', imagePath);
    await detectFacesForPhoto(photo, imagePath); // locks itself (faceless fixture)

    const db = getDb();
    const realFace: DetectedFace = {
      id: 'real_face_1',
      photoId: 'local_stale_faces',
      box: { x: 1, y: 1, width: 10, height: 10 },
      descriptor: new Array(512).fill(0.02),
      confidence: 0.9,
      isConfirmed: true,
      isManual: false,
    };
    replaceFacesForPhoto('local_stale_faces', [realFace], false, db);
    expect(getAllFaces(db).some((f) => f.id === 'real_face_1')).toBe(true);

    // Simulate the renderer calling back in with a stale local snapshot:
    // facesLocked: true (matches DB) so this hits the early-return 'locked'
    // skip path, but .faces is a stale EMPTY array, not the real one.
    const staleInput: Photo = { ...photo, facesLocked: true, faces: [] };
    const result = await detectFacesForPhoto(staleInput, imagePath, db);
    expect(result.skippedReason).toBe('locked');

    // The real face must have survived this metadata-only upsert.
    expect(getAllFaces(db).some((f) => f.id === 'real_face_1')).toBe(true);
  }, 30000);

  it('forceRedetectFacesForPhoto unlocks and re-runs even on an already-locked photo', async () => {
    const photo = makeLocalPhoto('local3', imagePath);
    await detectFacesForPhoto(photo, imagePath);
    const locked = getPhotoById('local3');
    expect(locked?.facesLocked).toBe(true);

    const forced = await forceRedetectFacesForPhoto(locked!);
    expect(forced.ran).toBe(true);
    expect(forced.skippedReason).not.toBe('locked');
  }, 30000);

  it('skips face detection for a virtual photo whose storage is unreachable, without crashing', async () => {
    const unreachableDir = path.join(tempDir, 'NeverExistsNetworkShare');
    const virtualPhoto: Photo = {
      ...makeLocalPhoto('virtual1', imagePath),
      isVirtual: true,
      originalRemotePath: path.join(unreachableDir, 'photo.jpg'),
      storageName: 'TestNAS',
    };

    const result = await detectFacesForPhoto(virtualPhoto, virtualPhoto.originalRemotePath!);
    expect(result.ran).toBe(false);
    expect(result.skippedReason).toBe('offline');
    expect(result.locked).toBe(false);

    // The photo row itself should still be recorded (metadata persisted),
    // just without a completed face scan.
    const stored = getPhotoById('virtual1');
    expect(stored).not.toBeNull();
    expect(stored?.faceScanCompleted).toBeFalsy();
  }, 30000);

  it('leaves a photo unlocked (available for a future scan) when the file cannot be decoded', async () => {
    const missingPath = path.join(tempDir, 'does-not-exist.jpg');
    const photo = makeLocalPhoto('local4', missingPath);

    const result = await detectFacesForPhoto(photo, missingPath);
    expect(result.ran).toBe(true);
    expect(result.faceCount).toBe(0);
    expect(result.locked).toBe(false);
    expect(result.skippedReason).toBe('decode-failed');
  }, 30000);

  it('skips re-detection when the source file is unchanged (same size + mtime as last scan), even if unlocked', async () => {
    const mtimeMs = Date.now();
    const photo: Photo = { ...makeLocalPhoto('local5', imagePath), originalMtimeMs: mtimeMs };
    await detectFacesForPhoto(photo, imagePath);

    // Simulate "faces detected but not yet confirmed" — unlock the photo
    // directly (a faceless fixture auto-locks, so this stands in for a real
    // photo with unconfirmed faces) while keeping the same recorded
    // size/mtime, so only the change-detection check is under test here.
    const scanned = getPhotoById('local5')!;
    upsertPhoto({ ...scanned, facesLocked: false });

    const second = await detectFacesForPhoto({ ...photo }, imagePath);
    expect(second.ran).toBe(false);
    expect(second.skippedReason).toBe('unchanged');
  }, 30000);

  it('re-runs detection and clears stale face marks when the source file has actually changed', async () => {
    const mtimeMs = Date.now();
    const photo: Photo = { ...makeLocalPhoto('local6', imagePath), originalMtimeMs: mtimeMs };
    await detectFacesForPhoto(photo, imagePath);

    const db = getDb();
    const scanned = getPhotoById('local6', db)!;
    upsertPhoto({ ...scanned, facesLocked: false }, db);

    // Seed a stale face mark as if it survived from before the file changed
    // — proceeding to a genuine re-detection must discard this, not carry
    // it forward through clustering.
    const staleFace: DetectedFace = {
      id: 'stale_face_1',
      photoId: 'local6',
      box: { x: 1, y: 1, width: 10, height: 10 },
      descriptor: new Array(512).fill(0.01),
      confidence: 0.9,
      isConfirmed: false,
      isManual: false,
    };
    replaceFacesForPhoto('local6', [staleFace], false, db);
    expect(getAllFaces(db).some((f) => f.id === 'stale_face_1')).toBe(true);

    // A later, different mtime simulates the source file actually changing.
    const changedPhoto: Photo = { ...photo, originalMtimeMs: mtimeMs + 60000 };
    const result = await detectFacesForPhoto(changedPhoto, imagePath, db);

    expect(result.ran).toBe(true);
    expect(result.skippedReason).not.toBe('unchanged');
    // The faceless fixture finds nothing new, but the stale mark must be
    // gone rather than surviving alongside (or instead of) a fresh result.
    expect(getAllFaces(db).some((f) => f.id === 'stale_face_1')).toBe(false);
    expect(getAllFaces(db).filter((f) => f.photoId === 'local6').length).toBe(0);
  }, 30000);

  // Regression: the per-photo "Detect Faces" button (forceRedetectFacesForPhoto)
  // used to write/read via getDb()'s ambient "active library" pointer, which
  // is a single mutable value shared across the whole main process. Found
  // against a real library: a user clicked "Detect Faces" on a virtual/
  // network storage photo while some OTHER library happened to be "active"
  // — the engine correctly detected a face ("1 face detected"), but it was
  // persisted to (and immediately read back from) the wrong database, so it
  // never appeared as a marker or in the people panel. resolveDbForPhoto
  // must derive the photo's OWN storage database directly from its file
  // path, ignoring whatever's currently "active".
  it('forceRedetectFacesForPhoto targets the photo\'s own storage database, not whichever library is "active"', async () => {
    // beforeEach already called setActiveLibrary(libraryDir) — simulating
    // the renderer having some unrelated local library open right now.
    const mirrorRoot = path.join(tempDir, 'Mirrors');
    const storageName = 'TestStorage';
    const mirrorFolder = path.join(mirrorRoot, storageName);
    fs.mkdirSync(mirrorFolder, { recursive: true });

    const virtualPhoto: Photo = {
      id: 'virtual_forced_1',
      filePath: path.join(mirrorFolder, 'blank.jpg'),
      fileName: 'blank.jpg',
      fileSize: 1000,
      fileDate: '',
      dateTaken: '2026-01-01T00:00:00Z',
      year: 2026,
      month: 1,
      day: 1,
      isVirtual: true,
      originalRemotePath: imagePath,
      storageName,
    };

    const result = await forceRedetectFacesForPhoto(virtualPhoto);
    expect(result.ran).toBe(true);

    const ownDb = getDbForLibraryPath(mirrorFolder);
    const storedInOwnDb = getPhotoById('virtual_forced_1', ownDb);
    expect(storedInOwnDb).not.toBeNull();
    expect(storedInOwnDb?.faceScanCompleted).toBe(true);

    const storedInActiveDb = getPhotoById('virtual_forced_1', getDb());
    expect(storedInActiveDb).toBeNull();

    expect(resolveDbForPhoto(virtualPhoto)).toBe(ownDb);
  }, 30000);
});
