import fs from 'fs';
import path from 'path';
import type { DatabaseSync } from 'node:sqlite';
import { VirtualStorageConfig, VirtualPhotoMetadata, Photo, DetectedFace, Person } from '../../types';
import { detectFaces } from './faceDetectionWorkerClient';
import { clusterFaces, peopleNeedingWrite } from './faceClustering';
import { getHeicFullResolutionBufferForDetection } from './heicService';
import { isPathReachable } from './networkReachabilityCache';
import { isOneDrivePath, markFilesForSpaceReclaim, isReclaimEnabled } from './oneDriveService';
import { getDb, getDbForLibraryPath, resolveDbForPhoto, getFacesPeopleRevision } from './db';

export { resolveDbForPhoto } from './db';
import {
  getPhotoById,
  upsertPhoto,
  getAllFaces,
  getAllPeople,
  replaceFacesForPhoto,
  upsertPeople,
  markOneDriveReleased,
} from './libraryRepository';
import { logger } from './logger';

// The single face-detection step of the unified per-photo pipeline (see
// docs/PIPELINE_REDESIGN_DEV_DOC.md §3.3): thumbnail caching happens first
// (processOneMirrorFile in virtualMirrorService.ts, unchanged), then this
// runs immediately after for that SAME photo — before moving on to the
// next one — so an OneDrive original never sits hydrated waiting for a
// second sweep, and the daemon (no renderer/DOM) can run it unattended.
// Shared by network/virtual storage sync (runFaceDetectionStep below) AND
// local (non-network) libraries (detectFacesForPhoto), via the "onedrive"
// bulk face-detection IPC handler in main.ts — one engine, one code path,
// regardless of where a photo lives.

export interface FaceStepResult {
  ran: boolean;
  faceCount: number;
  locked: boolean;
  skippedReason?: 'locked' | 'offline' | 'decode-failed' | 'unchanged';
}

/**
 * Lets a caller that's about to run detectFacesForPhoto over MANY photos in
 * one sitting (syncVirtualStorage's per-file loop, the faces:detect-batch
 * IPC handler) avoid re-fetching and re-clustering the library's ENTIRE
 * face/people set from scratch for every single photo.
 *
 * Without this, a real run measured a single already-slow photo's face
 * detection climbing to 6+ seconds purely from getAllFaces(db) re-reading
 * and re-mapping every row in the faces table on every call, then
 * clusterFaces() re-scanning that same growing set again — for a library
 * with thousands of already-detected faces, that cost is paid identically
 * for the 1st and the 20,000th photo in a batch, even though the "existing
 * faces" set barely changed between them. clusterFaces()'s own output
 * (updatedFaces/people) is already the complete, authoritative new state —
 * exactly what the next photo in the same batch needs — so this just keeps
 * it in memory across calls instead of discarding and re-reading it.
 *
 * Scoped to the lifetime of ONE caller-owned batch (one syncVirtualStorage
 * run, one detect-batch IPC call) — never persisted beyond that, so it
 * can't ever go stale from unrelated concurrent activity outstaying its
 * welcome. A caller processing a single one-off photo should simply not
 * create or pass one; detectFacesForPhoto falls back to its original
 * always-fresh DB reads.
 */
export interface FaceClusterCache {
  faces: DetectedFace[];
  people: Person[];
  /** faces/people revision this copy reflects (see db.ts getFacesPeopleRevision); set by createFaceClusterCache. */
  rev?: number;
}

export function createFaceClusterCache(db: DatabaseSync = getDb()): FaceClusterCache {
  const rev = getFacesPeopleRevision(); // read BEFORE loading — a later write must invalidate, never be missed
  return { faces: getAllFaces(db), people: getAllPeople(), rev };
}

const sharedFaceClusterCaches = new WeakMap<DatabaseSync, FaceClusterCache>();

/**
 * Like createFaceClusterCache, but reuses one long-lived copy per database
 * for as long as NOTHING else has written to the faces/people tables since
 * it was built (revision check) — a single-photo faces:detect-batch call
 * (the renderer's face queue) otherwise reloaded all ~28K faces + JSON
 * descriptors from SQLite per photo (~1.6s of synchronous main-thread time,
 * several times that under load). Any write elsewhere (rename, reassign,
 * reset, another storage's scan...) bumps the revision and forces a fresh
 * load. ponytail: holds ~100+MB of descriptors in memory per library while
 * scanning; drop the WeakMap entry if that ever matters.
 */
export function getSharedFaceClusterCache(db: DatabaseSync): FaceClusterCache {
  const hit = sharedFaceClusterCaches.get(db);
  if (hit && hit.rev === getFacesPeopleRevision()) return hit;
  const fresh = createFaceClusterCache(db);
  sharedFaceClusterCaches.set(db, fresh);
  return fresh;
}

/**
 * True for errors that mean "this file's bytes can't be decoded" (permanent),
 * as opposed to environmental failures (worker died, out of memory, timeout)
 * that a retry could fix.
 */
export function isPermanentDecodeError(err: unknown): boolean {
  const msg = String((err as any)?.message ?? err ?? '');
  return /tiff2vips|jpeg2vips|heif2vips|webp2vips|png2vips|magick2vips|vipsjpeg|unsupported image format|input (buffer|file) contains unsupported|compression scheme .* not implemented|premature end of (jpeg|input)|corrupt|bad seek|invalid (jpeg|png|tiff|heif)|unable to (read|decode) image/i.test(msg);
}

/** Same id scheme scanVirtualMirrorDirectory() uses, so rows this pipeline writes match what the renderer later reads from the same sidecar. */
export function photoIdForSidecar(thumbnailPath: string): string {
  return Buffer.from(thumbnailPath).toString('base64');
}

function sidecarToPhoto(sidecar: VirtualPhotoMetadata): Photo {
  const date = new Date(sidecar.dateTaken);
  return {
    id: photoIdForSidecar(sidecar.thumbnailPath),
    filePath: sidecar.thumbnailPath,
    fileName: sidecar.fileName,
    fileSize: sidecar.originalFileSize,
    fileDate: sidecar.dateTaken,
    dateTaken: sidecar.dateTaken,
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
    width: sidecar.width,
    height: sidecar.height,
    exif: sidecar.exif,
    location: sidecar.location,
    isVirtual: true,
    originalRemotePath: sidecar.originalFilePath,
    storageName: sidecar.storageName,
    isFavorite: false,
    rotation: sidecar.rotation,
    isHeicRotated: sidecar.isHeicRotated,
    heicRotation: sidecar.heicRotation,
    originalMtimeMs: sidecar.sourceMtimeMs,
  };
}

/**
 * Runs the face-detection step for one photo, local or virtual/network alike:
 * skips cleanly if the photo is locked (all faces already confirmed) or, for
 * a virtual photo, if its storage isn't currently reachable (requirement:
 * never face-detect an ad-hoc/offline photo — local photos have no such
 * gate, they're always on disk). Detects on the full-resolution source (a
 * full HEIC decode for .heic/.heif, bypassing the embedded-thumbnail
 * shortcut — see heicService.getHeicFullResolutionBufferForDetection),
 * clusters against this library's existing people, persists, and — for a
 * OneDrive-backed source — requests space reclaim immediately afterward.
 *
 * `sourceFilePath` is the actual file to read pixels from (the true
 * original — photo.filePath for a local photo, photo.originalRemotePath for
 * a virtual one, since photo.filePath there is only the local thumbnail).
 *
 * `db` targets a SPECIFIC library's database explicitly, instead of
 * whatever the ambient "active library" pointer happens to be (getDb()'s
 * default) — critical for virtual/network storages, each of which has its
 * OWN database at <mirrorRoot>/<name>/.gphotos_catalog/gphotos.db (same one
 * switchLibrary()/getStorageDetails() read from). Without this, a sync
 * triggered while a *different* library is active in the renderer (or no
 * library is active yet) would write faces into the wrong database — they'd
 * persist, but the storage's own status card (and browsing that storage)
 * would never see them, showing "0 faces detected" forever. See
 * runFaceDetectionStep below, which resolves this for the sync pipeline.
 */
export async function detectFacesForPhoto(
  photo: Photo,
  sourceFilePath: string,
  db: DatabaseSync = getDb(),
  cache?: FaceClusterCache
): Promise<FaceStepResult> {
  const photoId = photo.id;

  const existing = getPhotoById(photoId, db);
  const working: Photo = { ...photo };
  // upsertPhoto() also replaces a photo's faces if .faces is set on the
  // object passed to it (even an empty array — truthy in JS) — a
  // convenience for callers that want to atomically save a photo and its
  // faces together. Every upsertPhoto(working, db) call below exists only
  // to persist working's metadata flags (faceScanCompleted/facesLocked/
  // etc.); faces themselves are managed explicitly by this function's own
  // replaceFacesForPhoto call further down. Leaving working.faces set to
  // whatever the caller happened to pass in (the renderer's possibly-stale
  // local snapshot) turned every one of those metadata-only upserts into a
  // silent overwrite of whatever was actually just, correctly persisted —
  // this is the exact bug behind "N faces detected" with nothing to show
  // for it: the fresh faces were written, then immediately overwritten by
  // this same function moments later.
  delete working.faces;

  if (existing) {
    working.faceScanCompleted = existing.faceScanCompleted;
    working.facesLocked = existing.facesLocked;
    working.isFavorite = existing.isFavorite;
  }

  if (working.facesLocked) {
    upsertPhoto(working, db);
    return { ran: false, faceCount: existing?.faces?.length || 0, locked: true, skippedReason: 'locked' };
  }

  // Change-detection skip: the source file's size and modified-time are
  // captured every time it's actually read (see processOneMirrorFile in
  // virtualMirrorService.ts, which stats the file unconditionally on every
  // sync pass anyway for its own thumbnail incremental check). If neither
  // has moved since the last completed detection pass, the file's bytes
  // cannot have changed, so there is nothing new for detection to find —
  // skip without opening/hydrating/decoding it at all. This is independent
  // of facesLocked: a photo can be unlocked (faces awaiting confirmation)
  // and still be skipped here every rescan until the user either confirms
  // the faces (locking it) or the file itself actually changes.
  if (
    existing?.faceScanCompleted &&
    typeof existing.originalMtimeMs === 'number' &&
    typeof working.originalMtimeMs === 'number' &&
    existing.originalMtimeMs === working.originalMtimeMs &&
    existing.fileSize === working.fileSize
  ) {
    upsertPhoto(working, db);
    return { ran: false, faceCount: existing.faces?.length || 0, locked: !!working.facesLocked, skippedReason: 'unchanged' };
  }

  if (working.isVirtual) {
    const reachabilityTarget = path.dirname(sourceFilePath);
    const reachable = await isPathReachable(reachabilityTarget);
    if (!reachable) {
      upsertPhoto(working, db);
      logger.debug('Pipeline', 'Storage unreachable — face detection deferred', { sourceFilePath });
      return { ran: false, faceCount: 0, locked: false, skippedReason: 'offline' };
    }
  }

  let detectionBuffer: Buffer | null = null;
  try {
    // Async read: for a OneDrive/network source this can block on hydration
    // for seconds — fs.promises.readFile offloads that wait to libuv's
    // thread pool instead of the single Electron main-process JS thread, so
    // every other IPC handler (renderer requests, menu actions) stays
    // responsive while it waits.
    detectionBuffer = /\.(heic|heif)$/i.test(sourceFilePath)
      ? await getHeicFullResolutionBufferForDetection(sourceFilePath)
      : await fs.promises.readFile(sourceFilePath);
  } catch (err) {
    logger.warn('Pipeline', 'Failed to read source for face detection', { sourceFilePath, err: String(err) });
  }

  if (!detectionBuffer) {
    // Attempted (so this doesn't retry forever), but nothing detected — not
    // locked, so an explicit per-photo "Detect Faces" retry can still fix it.
    working.faceScanCompleted = true;
    working.facesLocked = false;
    upsertPhoto(working, db);
    return { ran: true, faceCount: 0, locked: false, skippedReason: 'decode-failed' };
  }

  logger.debug('Pipeline', 'Running face detection', { sourceFilePath, photoId });
  let detectionResult: Awaited<ReturnType<typeof detectFaces>>;
  try {
    detectionResult = await detectFaces(detectionBuffer);
  } catch (err) {
    // A file the image decoder can never read (e.g. a ProRAW .dng with an
    // unsupported TIFF compression) would otherwise throw out of here on
    // every cycle and stay "pending" forever, so the library never reads as
    // fully scanned. Same treatment as an unreadable source above: attempted,
    // nothing detected, not locked (a manual per-photo retry still works).
    // Anything that isn't clearly a decode problem (worker crash, timeout)
    // still throws so it's retried.
    if (!isPermanentDecodeError(err)) throw err;
    logger.warn('Pipeline', 'Source cannot be decoded — marking scanned with no faces', { sourceFilePath, err: String(err).slice(0, 200) });
    working.faceScanCompleted = true;
    working.facesLocked = false;
    upsertPhoto(working, db);
    return { ran: true, faceCount: 0, locked: false, skippedReason: 'decode-failed' };
  }
  const { faces: detected, imageWidth, imageHeight } = detectionResult;
  const newFaces: DetectedFace[] = detected.map((d, idx) => ({
    id: `${photoId}_face_${idx}`,
    photoId,
    box: d.box,
    confidence: d.confidence,
    descriptor: d.descriptor,
    isConfirmed: false,
    isManual: false,
    // Reference frame the box above was measured in — lets a viewer scale it
    // correctly even when showing a smaller cached thumbnail instead of this
    // exact full-resolution decode (see PhotoLightbox.tsx's OneDrive
    // cached-vs-full-res toggle).
    imageWidth,
    imageHeight,
  }));

  // Cluster against this library's full existing face set so new faces can
  // match already-known people (see faceClustering.ts) — excluding this
  // photo's OWN existing faces first: reaching this point means the source
  // file is new or has genuinely changed since it was last scanned, so its
  // old face marks are stale and must be fully discarded, not fed back into
  // clustering (which would let a stale mark ride along into the "new"
  // result instead of being replaced). replaceFacesForPhoto below deletes
  // this photo's rows outright, then inserts only what comes out of this
  // clustering pass, so the DB ends up holding exactly the fresh detections.
  // The cache was handed in before this photo's awaited decode/inference; if
  // anything wrote faces/people meanwhile (e.g. a rename), refresh it in
  // place so clustering + the upsertPeople below can't clobber that write.
  if (cache && cache.rev !== undefined && cache.rev !== getFacesPeopleRevision()) {
    Object.assign(cache, createFaceClusterCache(db));
  }
  const existingFaces = (cache ? cache.faces : getAllFaces(db)).filter((f) => f.photoId !== photoId);
  const existingPeople = cache ? cache.people : getAllPeople();
  const { people, updatedFaces } = clusterFaces([...existingFaces, ...newFaces], existingPeople);
  const thisPhotoFaces = updatedFaces.filter((f) => f.photoId === photoId);

  const revBeforeOwnWrite = getFacesPeopleRevision();
  replaceFacesForPhoto(photoId, thisPhotoFaces, false, db);
  // Only the people this photo actually changed — see peopleNeedingWrite.
  const changedPeople = peopleNeedingWrite(existingPeople, people);
  if (changedPeople.length > 0) upsertPeople(changedPeople);

  // clusterFaces' own output is already the complete, authoritative new
  // state (every face across the whole set it was given, every person with
  // freshly-recomputed counts) — exactly what the NEXT photo in this same
  // batch should see, so just keep it rather than re-reading the DB again.
  if (cache) {
    cache.faces = updatedFaces;
    cache.people = people;
    // Our own writes above bumped the revision, but the cache already
    // reflects them — adopt the new revision, unless something ELSE had
    // written since the cache was built (then stay stale and reload).
    if (cache.rev === revBeforeOwnWrite) cache.rev = getFacesPeopleRevision();
  }

  working.faceScanCompleted = true;
  working.facesLocked = thisPhotoFaces.length === 0; // trivially locked when nothing to confirm
  upsertPhoto(working, db);

  if (isOneDrivePath(sourceFilePath) && isReclaimEnabled()) {
    try {
      await markFilesForSpaceReclaim([sourceFilePath]);
      markOneDriveReleased(photoId, db);
    } catch (err) {
      logger.warn('Pipeline', 'OneDrive space-reclaim request failed', { sourceFilePath, err: String(err) });
    }
  }

  logger.info('Pipeline', 'Face detection step complete', { sourceFilePath, faceCount: thisPhotoFaces.length, locked: working.facesLocked });
  return { ran: true, faceCount: thisPhotoFaces.length, locked: !!working.facesLocked };
}

/**
 * Sidecar-specific entry point used by syncVirtualStorage's per-photo loop.
 * Resolves and targets THIS storage's own per-mirror-folder database
 * explicitly (see detectFacesForPhoto's doc comment) — the sync can run
 * while the renderer has a completely different library open (or none),
 * so it must never depend on the ambient "active library" pointer.
 */
export async function runFaceDetectionStep(
  remoteFile: string,
  sidecar: VirtualPhotoMetadata,
  config: VirtualStorageConfig,
  cache?: FaceClusterCache
): Promise<FaceStepResult> {
  const photo = sidecarToPhoto(sidecar);
  const mirrorFolder = path.join(config.localMirrorRoot, config.name);
  const db = getDbForLibraryPath(mirrorFolder);
  return detectFacesForPhoto(photo, remoteFile, db, cache);
}

/**
 * Forces a re-detection of one specific photo regardless of its current
 * lock state — backs the per-photo "Detect Faces" button (requirement: a
 * locked photo stays locked until the user explicitly asks to rescan it).
 */
export async function forceRedetectFacesForPhoto(photo: Photo): Promise<FaceStepResult> {
  const db = resolveDbForPhoto(photo);
  const unlocked: Photo = { ...photo, facesLocked: false, faceScanCompleted: false };
  // See detectFacesForPhoto's matching comment — this call exists only to
  // persist the unlock flags, not to touch faces (a real detection pass,
  // or one of detectFacesForPhoto's own early-return skip paths, is the
  // sole owner of what actually ends up in the faces table from here on).
  delete unlocked.faces;
  upsertPhoto(unlocked, db);
  const sourceFilePath = photo.isVirtual ? photo.originalRemotePath || photo.filePath : photo.filePath;
  return detectFacesForPhoto(unlocked, sourceFilePath, db);
}
