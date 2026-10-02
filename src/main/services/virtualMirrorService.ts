import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { parsePhotoMetadata } from './exifParser';
import { isImageFile, isVideoFile, scanDirectoryRecursive } from './fileOrganizer';
import { getOrGenerateHeicThumbnail500 } from './heicService';
import { probeMedia, grabVideoFrame } from './videoExportService';
import {
  VirtualStorageConfig,
  SyncVirtualStorageResult,
  VirtualPhotoMetadata,
  MirrorProgress,
  Photo,
  FolderTreeNode,
  EditPhotoOptions,
  EditPhotoResult,
  StorageSyncCheckpoint,
  StorageDetails,
} from '../../types';
import { libraryStatusService } from './libraryStatusService';
import { getFaceStatsForLibrary, getTotalPhotoCount } from './libraryRepository';
import { readJsonSafe, writeJsonAtomic, writeJsonAtomicAsync, writeFileAtomic, writeFileAtomicAsync } from './jsonFile';
import { addSavedRotation, getHeicSavedRotation } from './heicRotationStore';
import { getDefaultMirrorRoot } from './pathSecurity';
import { isPathReachable, isNetworkPath } from './networkReachabilityCache';
import { runFaceDetectionStep, photoIdForSidecar, createFaceClusterCache, type FaceClusterCache, type FaceStepResult } from './pipelineOrchestrator';
import { getFaceDetectionPoolSize } from './faceDetectionWorkerClient';
import { logger } from './logger';
import { getDbForLibraryPath } from './db';
import { deletePhotos } from './libraryRepository';
import { writePhotoMetadata, PhotoMetadataUpdate } from './exifWriter';

// The exact housekeeping filenames written alongside real photo sidecars in
// a mirror folder (see saveStorageCheckpoint / discoverStoredMirrors) — NOT
// a "starts with underscore" pattern, which used to also exclude any real
// photo sidecar for a source file whose own name starts with an underscore
// (a real, common camera-JPEG naming convention — e.g. Sony/Nikon bodies
// write "_DSC1234.JPG" for Adobe RGB shots). That broader pattern silently
// undercounted a library's real photos whenever any of them had such a
// filename — exactly the mismatch between the sidebar/mirrored-count and
// the Virtual Storage card's "X/Y" progress bars this rewrite was meant to
// eliminate elsewhere, just via a different mechanism.
const MIRROR_HOUSEKEEPING_FILENAMES = new Set(['_sync_checkpoint.json', '_mirror_summary.json']);

function isMirrorHousekeepingFile(fileName: string): boolean {
  return MIRROR_HOUSEKEEPING_FILENAMES.has(fileName) || fileName.startsWith('.');
}

/** True when `target` is strictly inside `root` (after resolving) — guards deletes driven by paths read from JSON/DB. */
function isInsideDir(root: string, target: string): boolean {
  if (!root || !target) return false;
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// Dynamic import or require of electron nativeImage
let nativeImage: any = null;
try {
  const electron = require('electron');
  nativeImage = electron.nativeImage;
} catch {
  // Headless / Node testing environment
}

/**
 * Generates a resized JPEG thumbnail via sharp's async pipeline — including
 * the file read itself, sharp/libvips does the whole decode+resize+encode on
 * its own native thread pool, never blocking Electron's single main-process
 * JS thread. This matters most for a network/OneDrive source file: reading
 * one that isn't hydrated locally yet can take seconds while Windows fetches
 * it, and previously that wait happened via fs.openSync/readSync plus
 * Electron's synchronous nativeImage decode — both fully blocking every
 * other IPC handler (list photos, open a menu, anything) for the duration.
 * EXIF auto-orientation replaces the old hand-rolled orientation parser +
 * pixel-rotation loop (also synchronous, also now unnecessary).
 */
export async function generateThumbnailBuffer(filePath: string, maxDimension = 500): Promise<Buffer | null> {
  // A video's own bytes never decode as a still image — grab one representative frame via
  // ffmpeg first (same approach as thumbnailCacheService's main cache path) and feed THAT to
  // sharp instead. See docs/FEATURE_VIDEO_LIBRARY_SUPPORT.md §2.4.
  let source: string | Buffer = filePath;
  if (isVideoFile(filePath)) {
    try {
      const info = await probeMedia(filePath);
      const seekAt = info.durationSec ? Math.min(1, info.durationSec * 0.1) : 0;
      const frame = await grabVideoFrame(filePath, seekAt);
      if (!frame) return null; // raw video bytes would never decode below either — give up cleanly
      source = frame;
    } catch {
      return null;
    }
  }

  try {
    return await sharp(source, { failOn: 'none' })
      .rotate()
      .resize(maxDimension, maxDimension, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toBuffer();
  } catch (err) {
    console.warn(`sharp thumbnail generation failed for ${filePath}:`, err);
  }

  if (source !== filePath) return null; // already a video frame buffer — no raw-bytes fallback makes sense

  // Fallback: sharp couldn't process it at all (e.g. an unsupported/corrupt
  // format) — return the raw file bytes rather than nothing.
  try {
    return await fs.promises.readFile(filePath);
  } catch {
    return null;
  }
}

function getGlobalCheckpointsPath(): string {
  try {
    const electron = require('electron');
    if (electron.app) {
      return path.join(electron.app.getPath('userData'), 'storage_sync_checkpoints.json');
    }
  } catch {}
  const fallback = process.env.APPDATA
    ? path.join(process.env.APPDATA, 'gPhotos')
    : path.join(process.cwd(), '.temp');
  if (!fs.existsSync(fallback)) {
    try { fs.mkdirSync(fallback, { recursive: true }); } catch {}
  }
  return path.join(fallback, 'storage_sync_checkpoints.json');
}

export function getAllStorageCheckpoints(customMirrorRoot?: string): Record<string, StorageSyncCheckpoint> {
  const result: Record<string, StorageSyncCheckpoint> = {};
  try {
    const p = getGlobalCheckpointsPath();
    const map = readJsonSafe<Record<string, StorageSyncCheckpoint> | null>(p, null);
    if (map && typeof map === 'object') {
      Object.assign(result, map);
    }
  } catch (err) {
    console.warn('[StorageSync] Failed to load global checkpoints:', err);
  }

  try {
    const root = customMirrorRoot || getDefaultMirrorRoot();
    if (fs.existsSync(root)) {
      const entries = fs.readdirSync(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const cpFile = path.join(root, entry.name, '_sync_checkpoint.json');
        if (fs.existsSync(cpFile)) {
          try {
            const cp = readJsonSafe<StorageSyncCheckpoint | null>(cpFile, null);
            if (cp && cp.storageName) {
              result[cp.storageName] = cp;
            }
          } catch {}
        }
      }
    }
  } catch {}

  return result;
}

export function loadStorageCheckpoint(storageName: string, localMirrorRoot?: string): StorageSyncCheckpoint | null {
  const all = getAllStorageCheckpoints(localMirrorRoot);
  return all[storageName] || null;
}

export function saveStorageCheckpoint(checkpoint: StorageSyncCheckpoint): void {
  try {
    const mirrorFolder = path.join(checkpoint.localMirrorRoot || getDefaultMirrorRoot(), checkpoint.storageName);
    if (!fs.existsSync(mirrorFolder)) {
      try { fs.mkdirSync(mirrorFolder, { recursive: true }); } catch {}
    }
    const localCpPath = path.join(mirrorFolder, '_sync_checkpoint.json');
    writeJsonAtomic(localCpPath, checkpoint);

    // Unparseable global file -> moved aside (.corrupt-<ts>), never silently
    // overwritten; an unreadable one throws into the catch below, which skips
    // the write rather than wiping every other storage's checkpoint.
    const globalPath = getGlobalCheckpointsPath();
    const currentMap = readJsonSafe<Record<string, StorageSyncCheckpoint>>(globalPath, {});
    currentMap[checkpoint.storageName] = checkpoint;
    writeJsonAtomic(globalPath, currentMap);
  } catch (err) {
    console.warn(`[StorageSync] Failed to save checkpoint for ${checkpoint.storageName}:`, err);
  }
}

export interface InventoryScanResult {
  status: 'completed' | 'failed';
  totalFiles: number;
  completedAt?: string;
  error?: string;
}

/**
 * Counts every eligible photo file under a storage's source folder,
 * including subfolders — the inventory gate (see
 * docs/PIPELINE_REDESIGN_DEV_DOC.md §3.2). Until this completes, nothing
 * else should process this storage's photos, and once it completes, the
 * resulting count becomes the single fixed number every UI surface shows
 * (no more independently-computed, possibly-disagreeing counts).
 */
export async function scanStorageInventory(networkSourcePath: string): Promise<InventoryScanResult> {
  if (!networkSourcePath) {
    return { status: 'failed', totalFiles: 0, error: 'No source path configured' };
  }

  const reachable = await isPathReachable(networkSourcePath);
  if (!reachable) {
    return { status: 'failed', totalFiles: 0, error: 'Storage is not reachable' };
  }

  try {
    const files = await scanDirectoryRecursive(networkSourcePath);
    return { status: 'completed', totalFiles: files.length, completedAt: new Date().toISOString() };
  } catch (err) {
    return { status: 'failed', totalFiles: 0, error: String(err) };
  }
}

/**
 * Counts one mirror folder from its DIRECTORY LISTING only (no file is opened): a sidecar is
 * `<baseName>.json` and its thumbnail is the sibling `<originalFileName>` (see
 * processOneMirrorFile), so "thumbnail cached" == a non-json sibling with the same base name.
 * Excludes the housekeeping files that live alongside sidecars (they would otherwise count as
 * a photo that never gets a thumbnail, capping progress just under 100%).
 * Shared by the sync and async walks below.
 */
function tallyMirrorListing(dir: string, entries: fs.Dirent[]): { total: number; cached: number; subdirs: string[] } {
  const mediaBases = new Set<string>(); // lower-cased base names of non-json files in this folder
  const sidecarBases: string[] = [];
  const subdirs: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!entry.name.startsWith('.')) subdirs.push(path.join(dir, entry.name));
    } else if (entry.isFile()) {
      if (entry.name.endsWith('.json')) {
        if (!isMirrorHousekeepingFile(entry.name)) sidecarBases.push(entry.name.slice(0, -'.json'.length).toLowerCase());
      } else {
        mediaBases.add(path.parse(entry.name).name.toLowerCase());
      }
    }
  }
  let cached = 0;
  for (const base of sidecarBases) if (mediaBases.has(base)) cached++;
  return { total: sidecarBases.length, cached, subdirs };
}

const MIRROR_WALK_MAX_DEPTH = 6;

/** Synchronous listing-only walk (~1 readdir per folder, no per-sidecar open/parse/stat). */
function scanMirrorFolderSync(dir: string, depth = 0): { total: number; cached: number } {
  if (depth > MIRROR_WALK_MAX_DEPTH) return { total: 0, cached: 0 };
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { total: 0, cached: 0 };
  }
  const t = tallyMirrorListing(dir, entries);
  let total = t.total;
  let cached = t.cached;
  for (const sub of t.subdirs) {
    const r = scanMirrorFolderSync(sub, depth + 1);
    total += r.total;
    cached += r.cached;
  }
  return { total, cached };
}

/** Async listing-only walk that yields to the event loop between folders. */
async function scanMirrorFolderAsync(dir: string, depth = 0): Promise<{ total: number; cached: number }> {
  if (depth > MIRROR_WALK_MAX_DEPTH) return { total: 0, cached: 0 };
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return { total: 0, cached: 0 };
  }
  const t = tallyMirrorListing(dir, entries);
  let total = t.total;
  let cached = t.cached;
  await new Promise((resolve) => setImmediate(resolve)); // let the event loop breathe between folders
  for (const sub of t.subdirs) {
    const r = await scanMirrorFolderAsync(sub, depth + 1);
    total += r.total;
    cached += r.cached;
  }
  return { total, cached };
}

/**
 * The single place storage details are assembled, given whatever the live folder walk found
 * (0/0 when no walk was done — the Fast path).
 *
 * The live walk is ground truth (it counts sidecars that physically exist right now). The
 * persisted checkpoint / library-status estimates are used only when it found nothing at all
 * (e.g. a sync is in progress and hasn't written any sidecars yet) — never "whichever is larger",
 * which let a stale/inflated persisted total permanently beat the real count.
 * Face-detection results live only in the storage's own SQLite catalog (never in sidecar JSON),
 * so those two counts always come from getFaceStatsForLibrary.
 */
function resolveStorageDetails(storageName: string, root: string, liveTotal: number, liveCached: number): StorageDetails {
  const mirrorFolder = path.join(root, storageName);
  let totalPhotos = liveTotal;
  let thumbnailCachedCount = liveCached;
  let faceScannedCount = 0;
  let facesDetectedCount = 0;

  const cp = loadStorageCheckpoint(storageName, root);
  if (totalPhotos === 0 && cp) {
    totalPhotos = cp.totalDiscovered;
    thumbnailCachedCount = cp.processedCount;
  }

  const libStatus = libraryStatusService.getLibraryStatus(mirrorFolder);
  if (totalPhotos === 0 && libStatus) {
    totalPhotos = libStatus.totalPhotos;
    thumbnailCachedCount = libStatus.thumbnailCachedCount;
    faceScannedCount = libStatus.faceScannedCount;
    facesDetectedCount = libStatus.faceDetectedCount;
  }

  if (totalPhotos > 0) {
    const faceStats = getFaceStatsForLibrary(mirrorFolder);
    // Capped to totalPhotos: the catalog can briefly disagree with the sidecar count (e.g. right
    // after a source folder shrinks, before a sync has pruned stale rows).
    faceScannedCount = Math.min(faceStats.faceScannedCount, totalPhotos);
    facesDetectedCount = faceStats.facesDetectedCount;
  }

  return computeStorageDetails(storageName, totalPhotos, thumbnailCachedCount, faceScannedCount, facesDetectedCount, cp?.phase);
}

/**
 * Live folder walk, synchronous. Listing-only (no sidecar is opened/parsed), so it is ~100x
 * cheaper than the old readFileSync+JSON.parse+existsSync-per-sidecar walk, but it still blocks
 * the calling thread for the readdirs. Prefer `await scanStorageDetailsPhysical(...)` from IPC
 * handlers / the background daemon; this stays for synchronous callers and tests.
 */
export function getStorageDetails(storageName: string, mirrorRoot?: string): StorageDetails {
  const root = mirrorRoot || getDefaultMirrorRoot();
  const live = scanMirrorFolderSync(path.join(root, storageName));
  return resolveStorageDetails(storageName, root, live.total, live.cached);
}

export function getAllStorageDetails(mirrorRoot?: string): Record<string, StorageDetails> {
  const root = mirrorRoot || getDefaultMirrorRoot();
  const result: Record<string, StorageDetails> = {};
  if (!fs.existsSync(root)) return result;

  try {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        result[entry.name] = getStorageDetails(entry.name, root);
      }
    }
  } catch (err) {
    console.warn('[StorageSync] Failed to scan storage details:', err);
  }
  return result;
}

function computeStorageDetails(
  storageName: string,
  totalPhotos: number,
  thumbnailCachedCount: number,
  faceScannedCount: number,
  facesDetectedCount: number,
  checkpointPhase: StorageSyncCheckpoint['phase'] | undefined
): StorageDetails {
  let phase: 'completed' | 'thumbnails' | 'faces' | 'interrupted' | 'idle' = 'idle';
  if (totalPhotos > 0) {
    if (thumbnailCachedCount >= totalPhotos && faceScannedCount >= totalPhotos) {
      phase = 'completed';
    } else if (checkpointPhase === 'interrupted' || (thumbnailCachedCount > 0 && thumbnailCachedCount < totalPhotos && checkpointPhase !== 'completed')) {
      phase = 'interrupted';
    } else if (thumbnailCachedCount >= totalPhotos && faceScannedCount < totalPhotos) {
      phase = 'faces';
    } else {
      phase = 'thumbnails';
    }
  }

  const percent = totalPhotos > 0
    ? Math.round(((thumbnailCachedCount + faceScannedCount) / (totalPhotos * 2)) * 100)
    : 0;

  return {
    storageName,
    totalPhotos,
    thumbnailCachedCount,
    thumbnailTotalCount: totalPhotos,
    faceScannedCount,
    faceTotalCount: totalPhotos,
    facesDetectedCount,
    phase,
    percent,
    canResume: phase === 'interrupted' || (totalPhotos > 0 && phase !== 'completed'),
  };
}

/**
 * Same result shape as getStorageDetails, but WITHOUT the live sidecar-folder
 * walk — reads only the sync checkpoint (one small JSON file, all storages
 * combined) and the SQLite catalog's own COUNT/SUM aggregates, both of which
 * are already kept live by the actual sync/detection pipeline as it runs.
 * getAllStorageDetails' live scan is the real ground truth (catches drift a
 * stale checkpoint wouldn't), but doing that full recursive
 * readdir+readFile+JSON.parse walk of every synced photo's sidecar on every
 * call is what made polling it every 2 seconds (VirtualStorageView's status
 * refresh) block the main process repeatedly. Use this for anything that
 * polls frequently; reserve the live scan (or scanStorageDetailsPhysical
 * below) for a one-time confirmation instead.
 */
export function getStorageDetailsFast(storageName: string, mirrorRoot?: string): StorageDetails {
  const root = mirrorRoot || getDefaultMirrorRoot();
  return resolveStorageDetails(storageName, root, 0, 0);
}

/** Bulk form of getStorageDetailsFast — see its doc comment. Safe to poll often. */
export function getAllStorageDetailsFast(mirrorRoot?: string): Record<string, StorageDetails> {
  const root = mirrorRoot || getDefaultMirrorRoot();
  const result: Record<string, StorageDetails> = {};
  if (!fs.existsSync(root)) return result;

  try {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        result[entry.name] = getStorageDetailsFast(entry.name, root);
      }
    }
  } catch (err) {
    console.warn('[StorageSync] Failed to scan storage details (fast):', err);
  }
  return result;
}

/**
 * The ground-truth count of a mirror's synced photos and cached thumbnails,
 * from DIRECTORY LISTINGS ONLY (no file is opened). A sidecar is
 * `<baseName>.json` and its thumbnail is the sibling `<originalFileName>`
 * (see processOneMirrorFile), so "thumbnail cached" == a non-json sibling
 * with the same base name exists in that folder.
 *
 * This used to open and JSON.parse every sidecar and existsSync its
 * thumbnail: ~6ms per file on a real 24K-photo mirror (each open gets
 * virus-scanned) = 144s of grinding, on every visit to the Network Mirrors
 * screen, competing with the face pipeline for the main process. The listing
 * walk does the same job in well under a second. Runs once per screen load
 * as a background confirmation over what getAllStorageDetailsFast already
 * showed from the checkpoint — never on a tight poll.
 */
export async function scanStorageDetailsPhysical(storageName: string, mirrorRoot?: string): Promise<StorageDetails> {
  const root = mirrorRoot || getDefaultMirrorRoot();
  const live = await scanMirrorFolderAsync(path.join(root, storageName));
  return resolveStorageDetails(storageName, root, live.total, live.cached);
}

/**
 * Runs scanStorageDetailsPhysical for every configured storage, one at a
 * time, yielding between each — the "physical confirmation" background pass
 * meant to run once after the storage screen's initial (fast, checkpoint-
 * based) load, per the yield/chunk pattern already used elsewhere
 * (getAllPhotosChunked, scanVirtualMirrorDirectory).
 */
export async function confirmAllStorageDetailsPhysical(mirrorRoot?: string): Promise<Record<string, StorageDetails>> {
  const root = mirrorRoot || getDefaultMirrorRoot();
  const result: Record<string, StorageDetails> = {};

  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch (err: any) {
    if (err?.code !== 'ENOENT') console.warn('[StorageSync] Failed to list storages for physical confirmation:', err);
    return result;
  }

  for (const entry of entries) {
    if (entry.isDirectory() && !entry.name.startsWith('.')) {
      result[entry.name] = await scanStorageDetailsPhysical(entry.name, root);
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  return result;
}

interface OneFileSyncResult {
  success: boolean;
  skipped: boolean;
  bytesRead: number;
  originalSize: number;
  thumbnailSize: number;
  localThumbPath?: string;
  localMetaPath?: string;
  sidecar?: VirtualPhotoMetadata;
  error?: string;
}

/**
 * Thumbnail + EXIF sidecar generation for exactly one source file. Shared by
 * the bulk syncVirtualStorage loop below and by mirror:sync-one-photo, which
 * the renderer uses to interleave this step with face detection one photo at
 * a time (rather than two full passes over the whole library) — important
 * for OneDrive-backed sources, where every read here hydrates the file, and
 * doing all files' thumbnails before any face detection would leave every
 * file hydrated at once instead of one at a time.
 */
async function processOneMirrorFile(
  remoteFile: string,
  config: VirtualStorageConfig,
  storageMirrorRoot: string
): Promise<OneFileSyncResult> {
  const fileName = path.basename(remoteFile);
  const relFromRoot = path.relative(config.networkSourcePath, remoteFile);
  const relDir = path.dirname(relFromRoot);

  const targetLocalDir = path.join(storageMirrorRoot, relDir);
  const localThumbPath = path.join(targetLocalDir, fileName);
  const baseName = path.basename(fileName, path.extname(fileName));
  const localMetaPath = path.join(targetLocalDir, `${baseName}.json`);

  try {
    // Inside the try: a vanished/read-only mirror drive must yield a per-file
    // failure result, not a rejection that aborts the whole batch.
    if (!fs.existsSync(targetLocalDir)) {
      fs.mkdirSync(targetLocalDir, { recursive: true });
    }
    const stats = fs.statSync(remoteFile);
    const bytesRead = stats.size;

    // Incremental sync check: if both thumbnail and metadata exist and the
    // remote file's current size+mtime match what was persisted the last
    // time it was actually synced, skip it. Reads the sidecar first (needed
    // for the skip return anyway) and compares its own stored
    // originalFileSize/sourceMtimeMs against the remote's current stat —
    // not a proxy comparison — so a same-size-different-content edit that
    // preserves mtime (or vice versa) still gets caught by the other field.
    if (fs.existsSync(localThumbPath) && fs.existsSync(localMetaPath)) {
      // Still parse and return the existing sidecar even though the
      // thumbnail step itself is skipped — the caller's face-detection
      // step (see syncVirtualStorage) needs it to know which photo this
      // is. Without this, any already-thumbnailed file (the overwhelming
      // common case on every sync after the first) would never even be
      // considered for face detection, since "skipped" previously meant
      // "no sidecar returned" — silently starving the whole face pipeline.
      let existingSidecar: VirtualPhotoMetadata | undefined;
      try {
        existingSidecar = JSON.parse(fs.readFileSync(localMetaPath, 'utf-8'));
      } catch (parseErr) {
        console.warn(`Failed to parse existing sidecar ${localMetaPath}, face detection will be skipped for this file this pass:`, parseErr);
      }

      // A sidecar written before originalFileSize/sourceMtimeMs existed has
      // neither field — fall back to the old local-sidecar-mtime-vs-remote
      // proxy for exactly that one pass, then self-heal below so every
      // subsequent pass uses the real size+mtime comparison.
      const hasPersistedStat = existingSidecar?.sourceMtimeMs != null && existingSidecar?.originalFileSize != null;
      const sizeAndMtimeMatch = hasPersistedStat
        && existingSidecar!.originalFileSize === stats.size
        && existingSidecar!.sourceMtimeMs === stats.mtime.getTime();
      const legacyProxyMatch = !hasPersistedStat
        && fs.statSync(localMetaPath).mtime.getTime() >= stats.mtime.getTime();

      if (sizeAndMtimeMatch || legacyProxyMatch) {
        const thumbStats = fs.statSync(localThumbPath);
        // Backfill originalFileSize/sourceMtimeMs for a sidecar written
        // before those fields existed (i.e. every file already synced
        // before this fix shipped) — one-time self-heal using the stat()
        // already done above, no extra I/O. Without this, detectFacesForPhoto's
        // "file unchanged, skip re-detection" check can never activate for any
        // already-synced photo (originalMtimeMs stays permanently null),
        // so an unlocked-but-already-detected photo gets fully re-detected
        // by EVERY future sync pass forever — including the background
        // daemon's own periodic cycle, which can run within seconds of a
        // user manually detecting faces on that exact photo and silently
        // replace the result with whatever that pass independently found.
        if (existingSidecar && !hasPersistedStat) {
          existingSidecar.sourceMtimeMs = stats.mtime.getTime();
          existingSidecar.originalFileSize = stats.size;
          try {
            writeJsonAtomic(localMetaPath, existingSidecar);
          } catch (writeErr) {
            console.warn(`Failed to backfill originalFileSize/sourceMtimeMs into sidecar ${localMetaPath}:`, writeErr);
          }
        }
        return {
          success: true,
          skipped: true,
          bytesRead: 0,
          originalSize: stats.size,
          thumbnailSize: thumbStats.size,
          localThumbPath,
          localMetaPath,
          sidecar: existingSidecar,
        };
      }
    }

    // 1. Generate 500px thumbnail (supporting HEIC and standard formats)
    let thumbBuffer: Buffer | null = null;
    const isHeic = /\.(heic|heif)$/i.test(remoteFile);
    if (isHeic) {
      try {
        thumbBuffer = await getOrGenerateHeicThumbnail500(remoteFile);
      } catch (heicErr) {
        console.warn(`HEIC thumbnail generation notice for ${remoteFile}:`, heicErr);
      }
    }
    if (!thumbBuffer) {
      thumbBuffer = await generateThumbnailBuffer(remoteFile, 500);
    }
    if (!thumbBuffer) {
      throw new Error(`Failed to generate thumbnail for ${remoteFile}`);
    }
    writeFileAtomic(localThumbPath, thumbBuffer);

    // 2. Parse EXIF & GPS
    const meta = await parsePhotoMetadata(remoteFile);

    // 3. Write metadata sidecar JSON
    const sidecar: VirtualPhotoMetadata = {
      fileName,
      originalFilePath: remoteFile,
      originalFileSize: stats.size,
      sourceMtimeMs: stats.mtime.getTime(),
      dateTaken: meta.dateTaken,
      width: meta.width,
      height: meta.height,
      thumbnailPath: localThumbPath,
      storageName: config.name,
      storageRoot: config.networkSourcePath,
      relativePath: relFromRoot,
      exif: meta.exif,
      location: meta.location,
    };
    writeJsonAtomic(localMetaPath, sidecar);

    return {
      success: true,
      skipped: false,
      bytesRead,
      originalSize: stats.size,
      thumbnailSize: thumbBuffer.length,
      localThumbPath,
      localMetaPath,
      sidecar,
    };
  } catch (err: any) {
    return { success: false, skipped: false, bytesRead: 0, originalSize: 0, thumbnailSize: 0, error: err.message };
  }
}

/**
 * Same as processOneMirrorFile, but for a caller (mirror:sync-one-photo) that
 * only has a single remote file and config, not a pre-resolved mirror root —
 * ensures the mirror root directory exists first.
 */
export async function syncOnePhoto(
  remoteFile: string,
  config: VirtualStorageConfig
): Promise<OneFileSyncResult> {
  const storageMirrorRoot = path.join(config.localMirrorRoot, config.name);
  try {
    if (!fs.existsSync(storageMirrorRoot)) {
      fs.mkdirSync(storageMirrorRoot, { recursive: true });
    }
  } catch (err: any) {
    return { success: false, skipped: false, bytesRead: 0, originalSize: 0, thumbnailSize: 0, error: err?.message || String(err) };
  }
  return processOneMirrorFile(remoteFile, config, storageMirrorRoot);
}

// When files keep failing one after another, check whether the SOURCE storage itself is still
// reachable; if it is not, stop the run instead of failing (and logging) every remaining file.
const SOURCE_PROBE_EVERY_N_FAILURES = 3;
// Failures kept in the result/log; beyond this only a count is reported (a lost 800k-photo share
// would otherwise produce 800k error strings).
const MAX_REPORTED_ERRORS = 50;

/**
 * Stable in-place partition: items for which `isFirst` is true move to the front, the rest follow,
 * each group keeping its original order. The array keeps its length at every step and is never
 * spread into a function call: `arr.push(...bigArray)` passes every element as an argument and
 * overflows the call stack ("Maximum call stack size exceeded") from roughly 120k entries, which a
 * large library exceeds. If `isFirst` throws, the array has not been modified.
 */
export function partitionInPlace<T>(items: T[], isFirst: (item: T) => boolean): { first: number; rest: number } {
  const first: T[] = [];
  const rest: T[] = [];
  for (const item of items) (isFirst(item) ? first : rest).push(item);
  let n = 0;
  for (const item of first) items[n++] = item;
  for (const item of rest) items[n++] = item;
  return { first: first.length, rest: rest.length };
}

// One sync per storage at a time: the IPC handler, the background daemon and the
// web server can all start one, and two overlapping runs write the same
// thumbnails / sidecars / checkpoint and race each other's prune. A second
// caller WAITS for the run in flight and then runs its own pass, so it still gets
// its own options (e.g. face detection on), progress callback and result — the
// incremental checks make that follow-up pass cheap when nothing changed.
const activeSyncs = new Map<string, Promise<SyncVirtualStorageResult>>();

/** True while a sync of this storage is running (or queued). Used to keep photo moves from racing a sync. */
export function isStorageSyncInProgress(localMirrorRoot: string, name: string): boolean {
  return activeSyncs.has(path.join(localMirrorRoot, name).toLowerCase());
}

export async function syncVirtualStorage(
  config: VirtualStorageConfig,
  onProgress?: (progress: MirrorProgress) => void,
  options?: { runFaceDetection?: boolean }
): Promise<SyncVirtualStorageResult> {
  const key = path.join(config.localMirrorRoot, config.name).toLowerCase();
  const previous = activeSyncs.get(key);
  if (previous) {
    logger.info('Sync', `Sync for ${config.name} already in progress — this request will run right after it.`);
  }
  const run: Promise<SyncVirtualStorageResult> = (
    previous ? previous.then(() => undefined, () => undefined) : Promise.resolve()
  )
    .then(() => syncVirtualStorageImpl(config, onProgress, options))
    .finally(() => {
      if (activeSyncs.get(key) === run) activeSyncs.delete(key);
    });
  activeSyncs.set(key, run);
  return run;
}

async function syncVirtualStorageImpl(
  config: VirtualStorageConfig,
  onProgress?: (progress: MirrorProgress) => void,
  options?: { runFaceDetection?: boolean }
): Promise<SyncVirtualStorageResult> {
  // Unified per-photo pipeline (see docs/PIPELINE_REDESIGN_DEV_DOC.md §3.3):
  // thumbnail+sidecar then, immediately for that same photo, face detection
  // + lock + OneDrive reclaim — one shared implementation for plain network
  // storages, OneDrive-backed ones, and the background daemon alike, instead
  // of three divergent code paths. Callers that can't safely touch the
  // shared per-library database right now (the daemon while a renderer
  // window is visibly open — see backgroundDaemon.ts) pass
  // runFaceDetection: false to fall back to thumbnail-only, unchanged.
  const runFaceDetection = options?.runFaceDetection ?? true;
  const errors: string[] = [];
  const warnings: string[] = [];
  let totalSynced = 0;
  let newlyAdded = 0;
  let totalOriginalSize = 0;
  let totalThumbnailSize = 0;

  const storageMirrorRoot = path.join(config.localMirrorRoot, config.name);
  if (!fs.existsSync(storageMirrorRoot)) {
    fs.mkdirSync(storageMirrorRoot, { recursive: true });
  }

  logger.info('Sync', `Checking library ${config.name} — scanning ${config.networkSourcePath}`);
  const scanInfo = { hadErrors: false };
  // Bounded reachability probe first: a dead/offline share short-circuits (same result as the
  // scan's own missing-root path: empty list + hadErrors) instead of tying up a libuv thread
  // for the full SMB timeout inside readdir.
  let remoteFiles: string[] = [];
  if (await isPathReachable(config.networkSourcePath)) {
    remoteFiles = await scanDirectoryRecursive(config.networkSourcePath, scanInfo);
  } else {
    scanInfo.hadErrors = true;
  }
  const total = remoteFiles.length;

  // Intermittent checkpoint resumption check:
  // If an interrupted checkpoint exists with the same total, resume directly from where it stopped!
  const existingCp = loadStorageCheckpoint(config.name, config.localMirrorRoot);
  let startIndex = 0;
  if (
    existingCp &&
    existingCp.phase !== 'completed' &&
    existingCp.lastProcessedIndex > 0 &&
    existingCp.lastProcessedIndex < total &&
    existingCp.totalDiscovered === total
  ) {
    startIndex = existingCp.lastProcessedIndex + 1;
    totalSynced = existingCp.processedCount || startIndex;
    console.log(`[StorageSync] Resuming sync for ${config.name} from photo ${startIndex + 1} of ${total} (Saved progress: ${existingCp.percent}%)`);
  }

  // Prioritize files whose face scan the catalog already shows complete, so
  // their (fast) re-verification happens first — leaving whatever genuinely
  // needs real detection clearly isolated as what's actually left, instead
  // of the two being interleaved in arbitrary filesystem order. That
  // interleaving is what made a rescan look like it "starts from zero" even
  // when a real library had, say, 40% of its photos already fully done:
  // the walk would hit a long unlucky stretch of never-scanned photos and
  // sit there, with no way to tell from the outside that a large chunk of
  // "easy" confirmations were still waiting later in the list.
  //
  // Only safe to do on a FRESH pass (no valid resume checkpoint, i.e.
  // startIndex === 0): the checkpoint below tracks progress by ARRAY
  // POSITION, and completion status changes AS the pass runs — re-sorting
  // mid-resume could shift a file that's never been visited behind the
  // resume point, silently skipping it forever. A fresh pass (including the
  // common case of clicking Rescan again after a previous pass completed)
  // has no such risk, since it always walks the whole list from the start.
  if (runFaceDetection && startIndex === 0) {
    try {
      const db = getDbForLibraryPath(storageMirrorRoot);
      const doneRows = db.prepare('SELECT id FROM photos WHERE face_scan_completed = 1').all() as Array<{ id: string }>;
      const doneIds = new Set(doneRows.map((r) => r.id));
      if (doneIds.size > 0) {
        const { first: alreadyDoneCount, rest: needsWorkCount } = partitionInPlace(remoteFiles, (remoteFile) => {
          const fileName = path.basename(remoteFile);
          const relFromRoot = path.relative(config.networkSourcePath, remoteFile);
          const localThumbPath = path.join(storageMirrorRoot, path.dirname(relFromRoot), fileName);
          return doneIds.has(photoIdForSidecar(localThumbPath));
        });
        logger.info(
          'Sync',
          `Prioritizing ${alreadyDoneCount} already-scanned photo(s) for quick re-verification before ${needsWorkCount} still needing face detection.`
        );
      }
    } catch (err) {
      console.warn(`[StorageSync] Failed to prioritize already-scanned photos for ${config.name}:`, err);
    }
  }

  if (onProgress) {
    onProgress({
      storageName: config.name,
      phase: startIndex > 0 ? 'thumbnails' : 'scanning',
      current: totalSynced,
      total,
      currentFile: startIndex > 0 ? `Resuming from photo ${startIndex + 1}...` : 'Scanning network storage...',
      status: startIndex > 0 ? 'syncing' : 'scanning',
      percent: Math.round((totalSynced / Math.max(1, total)) * 100),
    });
  }

  let skippedCount = 0;
  let lastProgressEmitTime = 0;
  let lastLoggedSummaryAt = Date.now();

  // Built once for this whole run, not per photo — see createFaceClusterCache's
  // doc comment for why: without it, a photo late in a large batch pays for
  // re-reading and re-clustering every face detected so far by THIS SAME run,
  // on top of every face already in the library, which is what made a single
  // photo's detection step climb into multiple seconds on a large library.
  const faceCache: FaceClusterCache | undefined = runFaceDetection
    ? createFaceClusterCache(getDbForLibraryPath(storageMirrorRoot))
    : undefined;

  // The absolute, library-wide count this run STARTS from — not 0. Without
  // this, a resumed run (starting partway through the file list) reported
  // facesCompletedCount as "however many this run itself walked", which for
  // a run resuming at photo 4311 could show something like "41/23887" after
  // a few seconds — technically accurate for THIS run alone, but exactly
  // the kind of number that doesn't match what's shown anywhere else and
  // means nothing to a user watching it. facesCompletedCount below is
  // seeded from this and only ever counts genuinely NEW detections on top
  // of it, so it always reads as "how many of this storage's photos have a
  // completed face scan right now" — the same number getStorageDetailsFast
  // and getAllStorageDetailsFast already compute independently, so every
  // surface showing "faces done" agrees.
  const facesCompletedBaseline = runFaceDetection ? getFaceStatsForLibrary(storageMirrorRoot).faceScannedCount : 0;

  // Distinct from skippedCount/newlyAdded (thumbnail step outcomes) — a
  // thumbnail being skipped says nothing about whether THIS photo's face
  // scan is actually done, and the two were previously conflated into one
  // "unchanged (skipped)" label that claimed nothing was happening even
  // while real, multi-second face detection was actively running.
  let facesAlreadyDoneCount = 0;
  let facesDetectedThisRunCount = 0;
  let facesDeferredCount = 0; // offline/locked/error — genuinely not attempted

  // Files within a batch are dispatched concurrently (Promise.all); the
  // bookkeeping below (counters, logging, progress, checkpoint) stays
  // sequential over each batch's results — cheap synchronous work with
  // nothing to gain from parallelizing it. At concurrency 1 (default,
  // Background Mode) a "batch" is always exactly one file, so this is
  // byte-for-byte the original one-at-a-time loop; Turbo Mode raises
  // concurrency so multiple files' thumbnail+face-detection pipelines run at
  // once, each face-detection call landing on a different pool worker (see
  // faceDetectionWorkerClient.ts). Safe to run detectFacesForPhoto concurrently
  // across different files — see its own doc comment: the only await in it
  // happens before the cluster-cache read/mutate section, which is fully
  // synchronous, so JS's run-to-completion semantics make concurrent calls
  // atomic with respect to that shared faceCache.
  const concurrency = Math.max(1, getFaceDetectionPoolSize());

  let consecutiveFailures = 0;
  let firstFailureInStreak = -1;
  let suppressedErrors = 0;
  let sourceLost = false;
  let lastSuccessfulIndex = startIndex - 1;

  syncLoop: for (let i = startIndex; i < total; i += concurrency) {
    const batchStartTime = Date.now();
    const batchIndices: number[] = [];
    for (let k = i; k < Math.min(i + concurrency, total); k++) batchIndices.push(k);

    const batchOutcomes = await Promise.all(
      batchIndices.map(async (idx) => {
        const remoteFile = remoteFiles[idx];
        if (typeof remoteFile !== 'string' || !remoteFile) {
          // Never let one bad list entry abort the whole storage sync.
          const bad: OneFileSyncResult = { success: false, skipped: false, bytesRead: 0, originalSize: 0, thumbnailSize: 0, error: `Invalid file list entry at position ${idx}` };
          return { idx, remoteFile: '', result: bad, faceResult: null as FaceStepResult | null, faceErr: null as unknown };
        }
        const result = await processOneMirrorFile(remoteFile, config, storageMirrorRoot);
        let faceResult: FaceStepResult | null = null;
        let faceErr: unknown = null;
        if (result.success && runFaceDetection && result.sidecar) {
          try {
            faceResult = await runFaceDetectionStep(remoteFile, result.sidecar, config, faceCache);
          } catch (err) {
            faceErr = err;
          }
        }
        return { idx, remoteFile, result, faceResult, faceErr };
      })
    );

    let batchBytesRead = 0;
    let batchDidRealWork = false;

    for (const { idx: i, remoteFile, result, faceResult, faceErr } of batchOutcomes) {
      const fileName = path.basename(remoteFile);
      const percent = Math.round(((i + 1) / Math.max(1, total)) * 100);

      if (result.success) {
        consecutiveFailures = 0;
        firstFailureInStreak = -1;
        lastSuccessfulIndex = Math.max(lastSuccessfulIndex, i);
        totalOriginalSize += result.originalSize;
        totalThumbnailSize += result.thumbnailSize;
        totalSynced++;
        batchBytesRead += result.bytesRead;
        if (!result.skipped) {
          newlyAdded++;
          logger.info('Sync', `Background scan — Photo ${i + 1}/${total}: ${fileName}`);
          logger.info('Sync', `  caching thumbnail ..... ${Math.round(result.thumbnailSize / 1024)}kb done`);
        } else {
          skippedCount++;
        }

        if (faceErr) {
          console.error(`Face detection step failed for ${remoteFile}:`, faceErr);
          errors.push(`Face detection failed for ${fileName}: ${String(faceErr)}`);
        } else if (runFaceDetection && result.sidecar && faceResult) {
          if (faceResult.ran) {
            facesDetectedThisRunCount++;
            logger.info('Sync', `  detecting faces ..... ${faceResult.faceCount} detected`);
          } else if (faceResult.skippedReason === 'unchanged' || faceResult.skippedReason === 'locked') {
            facesAlreadyDoneCount++;
          } else {
            // 'offline' or 'decode-failed' — genuinely not attempted, not
            // the same as "already done" (a later pass still needs to try).
            facesDeferredCount++;
            if (!result.skipped) {
              logger.info('Sync', `  detecting faces ..... skipped (${faceResult.skippedReason})`);
            }
          }
        }

        // The loop still has to walk every file to verify it (there's no way
        // to know a file is unchanged without checking) — but emitting one
        // IPC/UI update per already-cached file made a fast verify-only pass
        // look identical to a slow full reprocess, which is exactly what made
        // this look like "it always starts from zero". A file only counts as
        // fully "quiet" (skip the throttle) when NEITHER step did real work;
        // real work (a new/changed thumbnail OR an actual detection pass)
        // always updates immediately so the UI reflects it live.
        const now = Date.now();
        const isLastFile = i === total - 1;
        const didRealWork = !result.skipped || !!faceResult?.ran;
        if (didRealWork) batchDidRealWork = true;
        const bothConfirmedDone = result.skipped && (!runFaceDetection || !result.sidecar || (faceResult && !faceResult.ran && faceResult.skippedReason !== 'offline'));
        const currentFileLabel = faceResult?.ran
          ? `Detecting faces… (${facesDetectedThisRunCount} scanned this pass)`
          : bothConfirmedDone
            ? `Verifying cached photos… (${skippedCount} confirmed unchanged)`
            : fileName;

        if (onProgress && (didRealWork || isLastFile || now - lastProgressEmitTime >= 200)) {
          lastProgressEmitTime = now;
          onProgress({
            storageName: config.name,
            phase: faceResult ? 'faces' : 'thumbnails',
            current: i + 1,
            total,
            currentFile: currentFileLabel,
            status: 'syncing',
            percent,
            // Baseline (what the library already had before this run started)
            // plus only genuinely NEW detections — NOT facesAlreadyDoneCount,
            // which is already included in the baseline and would double-count.
            facesCompletedCount: facesCompletedBaseline + facesDetectedThisRunCount,
          });
        }

        // A verify-only pass over a fully-synced storage can walk thousands of
        // files with nothing else logged at all, which reads as "did this
        // actually do anything?" just as much as the progress bar did — a
        // periodic summary makes both skip checks' actual effect visible
        // without spamming a line per (near-instant) skipped file.
        if (now - lastLoggedSummaryAt >= 5000 || isLastFile) {
          lastLoggedSummaryAt = now;
          logger.info(
            'Sync',
            `  checked ${i + 1}/${total} — thumbnails: ${skippedCount} cached, ${newlyAdded} new/changed; faces: ${facesAlreadyDoneCount} already done, ${facesDetectedThisRunCount} detected this pass, ${facesDeferredCount} deferred`
          );
        }
      } else {
        const msg = `Error syncing ${remoteFile}: ${result.error}`;
        if (errors.length < MAX_REPORTED_ERRORS) {
          console.error(msg);
          errors.push(msg);
        } else {
          suppressedErrors++;
        }
        if (consecutiveFailures === 0) firstFailureInStreak = i;
        consecutiveFailures++;
        // Circuit breaker: a run of failures may be one bad file, or the whole source going away
        // (unplugged drive, NAS asleep, VPN dropped). isPathReachable is bounded by a timeout and
        // caches an offline verdict, so this never hangs and never re-probes needlessly.
        if (
          consecutiveFailures % SOURCE_PROBE_EVERY_N_FAILURES === 0 &&
          !(await isPathReachable(config.networkSourcePath))
        ) {
          sourceLost = true;
          break;
        }
      }

      // Intermittent checkpoint save every 10 photos or on last photo
      if ((i + 1) % 10 === 0 || i === total - 1) {
        saveStorageCheckpoint({
          storageName: config.name,
          networkSourcePath: config.networkSourcePath,
          localMirrorRoot: config.localMirrorRoot,
          phase: i === total - 1 ? 'completed' : 'thumbnails',
          processedCount: i + 1,
          totalDiscovered: total,
          lastProcessedIndex: i,
          lastProcessedFile: fileName,
          percent,
          timestamp: Date.now(),
          updatedAt: new Date().toISOString(),
        });
      }
    }

    if (sourceLost) break syncLoop;

    // Bandwidth cap + inter-batch delay — applied once per BATCH using
    // aggregate bytes/elapsed time, not per file, so concurrent files in the
    // same batch don't each separately pay the full sleep (which would just
    // cancel out the concurrency gain). At concurrency 1 this reduces to
    // exactly the original per-file pacing.
    if (config.bandwidthLimitMbps && config.bandwidthLimitMbps > 0 && batchBytesRead > 0) {
      const bytesPerSecondLimit = (config.bandwidthLimitMbps * 1_000_000) / 8;
      const targetMs = (batchBytesRead / bytesPerSecondLimit) * 1000;
      const elapsedMs = Date.now() - batchStartTime;
      const bandwidthSleepMs = targetMs - elapsedMs;
      if (bandwidthSleepMs > 0) {
        await new Promise((r) => setTimeout(r, bandwidthSleepMs));
      }
    }

    // Configurable delay between batches to prevent bandwidth saturation and
    // keep desktop 100% responsive — only meaningful when this batch actually
    // did real network I/O (skipped means the incremental check found
    // everything already up to date and touched nothing). Without this guard, a
    // periodic re-verification pass over an already-fully-synced storage —
    // every file skipped, zero bytes transferred — still paid the full
    // configured delay on every single one, turning a should-be-instant
    // "nothing changed" confirmation into minutes of pure waiting.
    const delayMs = batchDidRealWork && config.delayBetweenPhotosSec && config.delayBetweenPhotosSec > 0
      ? Math.round(config.delayBetweenPhotosSec * 1000)
      : 4;
    await new Promise((r) => setTimeout(r, delayMs));
  }

  if (sourceLost) {
    const stoppedAt = firstFailureInStreak >= 0 ? firstFailureInStreak : Math.max(0, lastSuccessfulIndex + 1);
    const message = `Source storage "${config.name}" became unavailable after ${stoppedAt} of ${total} files — sync stopped. It will continue automatically once the storage is reachable again.`;
    logger.warn('Sync', message);
    // Deliberately NOT a resumable position (lastProcessedIndex 0): the file list is re-ordered per pass
    // (already-scanned photos first), so a saved array index would point at a different file next time.
    // The next pass simply re-walks from the start; unchanged files are skipped cheaply.
    saveStorageCheckpoint({
      storageName: config.name,
      networkSourcePath: config.networkSourcePath,
      localMirrorRoot: config.localMirrorRoot,
      phase: 'interrupted',
      processedCount: totalSynced,
      totalDiscovered: total,
      lastProcessedIndex: 0,
      lastProcessedFile: 'Source unavailable',
      percent: Math.round((stoppedAt / Math.max(1, total)) * 100),
      timestamp: Date.now(),
      updatedAt: new Date().toISOString(),
    });
    if (onProgress) {
      try {
        onProgress({
          storageName: config.name,
          phase: 'error',
          current: stoppedAt,
          total,
          currentFile: 'Source storage unavailable — sync stopped',
          status: 'error',
          errorMessage: message,
          percent: Math.round((stoppedAt / Math.max(1, total)) * 100),
        });
      } catch {}
    }
    errors.unshift(message);
    if (suppressedErrors > 0) errors.push(`…and ${suppressedErrors} more file error(s) not listed.`);
    return {
      success: false,
      totalSynced,
      newlyAdded,
      totalSizeSaved: Math.max(0, totalOriginalSize - totalThumbnailSize),
      errors,
      warnings,
      sourceUnavailable: true,
    };
  }

  if (suppressedErrors > 0) errors.push(`…and ${suppressedErrors} more file error(s) not listed.`);

  logger.info(
    'Sync',
    `Rescan complete for ${config.name}: ${total} files checked — thumbnails: ${skippedCount} already cached, ${newlyAdded} new or changed; faces: ${facesAlreadyDoneCount} already done, ${facesDetectedThisRunCount} detected this pass, ${facesDeferredCount} deferred.`
  );

  // Final checkpoint mark as completed
  saveStorageCheckpoint({
    storageName: config.name,
    networkSourcePath: config.networkSourcePath,
    localMirrorRoot: config.localMirrorRoot,
    phase: 'completed',
    processedCount: total,
    totalDiscovered: total,
    lastProcessedIndex: total - 1,
    lastProcessedFile: 'Completed',
    percent: 100,
    timestamp: Date.now(),
    updatedAt: new Date().toISOString(),
  });

  if (onProgress) {
    onProgress({
      storageName: config.name,
      phase: 'completed',
      current: total,
      total,
      currentFile: 'Completed',
      status: 'completed',
      percent: 100,
    });
  }

  // Prune deleted files: if the source path is accessible, clean up mirror files whose remote file no longer exists.
  // Walks the LOCAL mirror (not the network path), but still yields periodically since a large
  // library can mean thousands of sidecar JSON files to stat/parse in one pass.
  //
  // Also removes the catalog row (and its faces/album links) for each pruned
  // photo — the mirror folder's sidecar+thumbnail files were always cleaned
  // up here, but the SQLite row survived, so a deleted source photo (and
  // anyone tagged in it) kept showing up when browsing this storage, with a
  // thumbnail path that no longer existed on disk.
  //
  // Safety: only prune when the source folder was genuinely reachable this
  // pass. scanDirectoryRecursive returns an empty list both for "the source
  // is really empty" and "the source is temporarily unreachable" (dropped
  // network drive, sleeping NAS, etc.) — pruning on the latter would treat
  // every real photo as deleted and wipe the whole library's cached data
  // and face tags over a connectivity blip.
  //
  // Also skipped when the scan was PARTIAL (a subfolder failed to read — its
  // files would look "deleted") or came back EMPTY while the mirror/catalog
  // still holds photos (an unmounted/not-yet-populated source looks empty).
  const sourceReachableForPrune = await isPathReachable(config.networkSourcePath);
  let emptyScanGuard = false;
  if (total === 0) {
    try {
      emptyScanGuard =
        getTotalPhotoCount(getDbForLibraryPath(storageMirrorRoot)) > 0 ||
        (fs.existsSync(storageMirrorRoot) &&
          fs.readdirSync(storageMirrorRoot).some((n) => !n.startsWith('.') && !isMirrorHousekeepingFile(n)));
    } catch {
      emptyScanGuard = true;
    }
  }
  if (!sourceReachableForPrune) {
    logger.warn('Sync', `Skipping delete-detection for ${config.name} — source folder was not reachable this pass.`);
  } else if (scanInfo.hadErrors || emptyScanGuard) {
    logger.warn(
      'Sync',
      `Skipping delete-detection for ${config.name} — the source scan was ${scanInfo.hadErrors ? 'incomplete (a folder could not be read)' : 'empty while the mirror still holds photos'}.`
    );
  } else {
    try {
      const activeRemotePaths = new Set(remoteFiles.map((rf) => path.resolve(rf).toLowerCase()));
      const pruneDb = getDbForLibraryPath(storageMirrorRoot);
      let prunedCount = 0;
      let pruneFailures = 0;
      let prunedSinceYield = 0;
      const pruneMirrorOrphans = async (current: string): Promise<void> => {
        if (!fs.existsSync(current)) return;
        const entries = fs.readdirSync(current, { withFileTypes: true });
        for (const entry of entries) {
          prunedSinceYield++;
          if (prunedSinceYield >= 200) {
            prunedSinceYield = 0;
            await new Promise<void>((resolve) => setImmediate(resolve));
          }

          const fullPath = path.join(current, entry.name);
          if (entry.isDirectory()) {
            if (!entry.name.startsWith('.')) {
              await pruneMirrorOrphans(fullPath);
              try {
                if (fs.readdirSync(fullPath).length === 0) {
                  fs.rmdirSync(fullPath);
                }
              } catch {}
            }
          } else if (entry.isFile() && entry.name.endsWith('.json') && !isMirrorHousekeepingFile(entry.name)) {
            try {
              const raw = fs.readFileSync(fullPath, 'utf-8');
              const meta: VirtualPhotoMetadata = JSON.parse(raw);
              if (meta.originalFilePath) {
                const origResolved = path.resolve(meta.originalFilePath).toLowerCase();
                if (!activeRemotePaths.has(origResolved)) {
                  try { fs.unlinkSync(fullPath); } catch (unlinkErr) { pruneFailures++; console.warn(`Could not remove stale sidecar ${fullPath}:`, unlinkErr); }
                  if (meta.thumbnailPath && isInsideDir(storageMirrorRoot, meta.thumbnailPath)) {
                    try {
                      deletePhotos([photoIdForSidecar(meta.thumbnailPath)], pruneDb);
                    } catch (dbErr) {
                      console.warn(`Failed to remove catalog row for deleted photo ${meta.originalFilePath}:`, dbErr);
                    }
                    if (fs.existsSync(meta.thumbnailPath)) {
                      try { fs.unlinkSync(meta.thumbnailPath); } catch (unlinkErr) { pruneFailures++; console.warn(`Could not remove stale thumbnail ${meta.thumbnailPath}:`, unlinkErr); }
                    }
                  }
                  prunedCount++;
                }
              }
            } catch {}
          }
        }
      };
      await pruneMirrorOrphans(storageMirrorRoot);

      // Catalog rows whose sidecar/thumbnail were ALREADY gone from disk
      // before this fix existed (the mirror-file cleanup above used to run
      // on its own, deleting sidecar+thumbnail but never the catalog row —
      // so a photo removed from the source before this database-cleanup
      // existed left an orphaned row with no file to walk to and therefore
      // nothing to trigger the check above). Comparing every row's
      // original_remote_path against the current source listing directly
      // catches these regardless of what's left on disk.
      const staleRows = pruneDb
        .prepare('SELECT id, file_path, original_remote_path FROM photos WHERE original_remote_path IS NOT NULL')
        .all() as Array<{ id: string; file_path: string; original_remote_path: string }>;
      const staleIds: string[] = [];
      for (const row of staleRows) {
        const origResolved = path.resolve(row.original_remote_path).toLowerCase();
        if (!activeRemotePaths.has(origResolved)) {
          staleIds.push(row.id);
          try {
            if (row.file_path && isInsideDir(storageMirrorRoot, row.file_path)) {
              if (fs.existsSync(row.file_path)) fs.unlinkSync(row.file_path);
              const sidecarPath = path.join(path.dirname(row.file_path), `${path.basename(row.file_path, path.extname(row.file_path))}.json`);
              if (fs.existsSync(sidecarPath)) fs.unlinkSync(sidecarPath);
            }
          } catch (unlinkErr) {
            pruneFailures++;
            console.warn(`Could not remove stale mirror files for ${row.file_path}:`, unlinkErr);
          }
        }
      }
      if (staleIds.length > 0) {
        deletePhotos(staleIds, pruneDb);
        prunedCount += staleIds.length;
      }

      if (prunedCount > 0) {
        logger.info('Sync', `Library ${config.name} — removed ${prunedCount} photo(s) no longer present in the source folder.`);
      }
      if (pruneFailures > 0) {
        // A warning, not an error: every photo mirrored fine, and treating a locked stale file as a
        // failed sync made the caller skip saving totals and repeat the failure on every sync.
        warnings.push(`Could not remove ${pruneFailures} stale mirror file(s) for photos no longer in the source folder.`);
        logger.warn('Sync', `Library ${config.name}: ${warnings[warnings.length - 1]}`);
      }
    } catch (pruneErr) {
      console.warn('Failed to prune mirror orphans:', pruneErr);
      warnings.push(`Cleanup of removed photos failed: ${(pruneErr as any)?.message || pruneErr}`);
    }
  }

  const totalSizeSaved = Math.max(0, totalOriginalSize - totalThumbnailSize);

  if (newlyAdded === 0 && total > 0) {
    logger.info('Sync', `Checking library ${config.name} — old count: ${total}, new count: ${total} — nothing to do`);
  } else if (runFaceDetection) {
    try {
      const db = getDbForLibraryPath(storageMirrorRoot);
      const faceCount = (db.prepare('SELECT COUNT(*) as c FROM faces').get() as any)?.c ?? 0;
      const personCount = (db.prepare('SELECT COUNT(DISTINCT person_id) as c FROM faces WHERE person_id IS NOT NULL').get() as any)?.c ?? 0;
      logger.info(
        'Sync',
        `Library ${config.name} completed — ${total} photos scanned, ${totalSynced} thumbnails cached, ${faceCount} faces detected for ${personCount} people in total.`
      );
    } catch (summaryErr) {
      logger.warn('Sync', 'Could not compute completion summary', { err: String(summaryErr) });
    }
  }

  if (onProgress) {
    onProgress({
      current: total,
      total,
      currentFile: 'Sync completed',
      status: 'completed',
    });
  }

  return {
    success: errors.length === 0,
    totalSynced,
    newlyAdded,
    totalSizeSaved,
    errors,
    warnings,
  };
}

// How many sidecar JSON files to process before yielding to the event loop —
// see the doc comment on scanVirtualMirrorDirectory below for why this
// exists at all. 50 keeps the gap between yields well under what it takes
// for Windows to mark the window "Not Responding" (~5s), even on a slow
// disk, while still batching enough work per tick to stay fast overall.
const MIRROR_SCAN_YIELD_EVERY = 50;
const MIRROR_SCAN_CONCURRENCY = 16;
const FOLDER_READ_CONCURRENCY = 6;

function pathExists(p: string): Promise<boolean> {
  return fs.promises.access(p, fs.constants.F_OK).then(() => true, () => false);
}

/**
 * Walks a virtual mirror's sidecar JSON files into Photo records, using async fs
 * (readdir/readFile/access run on the libuv pool, not the main thread) with up to
 * MIRROR_SCAN_CONCURRENCY sidecars in flight, and yielding to the event loop every
 * MIRROR_SCAN_YIELD_EVERY files for the JSON.parse/CPU part. The old fully synchronous walk was
 * ~55s of continuous main-thread blocking for a 3,106-photo library (per-file open cost incl.
 * antivirus), long past the point Windows reports the app "Not Responding". Result order is
 * identical to the old walk (readdir order, subfolders in place).
 */
export async function scanVirtualMirrorDirectory(mirrorDirPath: string): Promise<Photo[]> {
  const startedAt = Date.now();
  const photos: Photo[] = [];
  try {
    await fs.promises.access(mirrorDirPath, fs.constants.F_OK);
  } catch {
    return photos;
  }

  let sinceYield = 0;
  const maybeYield = async (n: number) => {
    sinceYield += n;
    if (sinceYield >= MIRROR_SCAN_YIELD_EVERY) {
      sinceYield = 0;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  };

  /** Reads one sidecar into a Photo (null when its thumbnail is gone or the JSON is unusable). */
  async function readSidecar(fullPath: string): Promise<Photo | null> {
    try {
      const raw = await fs.promises.readFile(fullPath, 'utf-8');
      const meta: VirtualPhotoMetadata = JSON.parse(raw);

      // Confirm corresponding local thumbnail exists
      if (typeof meta.thumbnailPath !== 'string' || !(await pathExists(meta.thumbnailPath))) return null;

      let date = new Date(meta.dateTaken);
      if (isNaN(date.getTime())) {
        // Missing/garbled date in the sidecar: fall back to the thumbnail's mtime
        // rather than emitting NaN year/month/day.
        try { date = new Date((await fs.promises.stat(meta.thumbnailPath)).mtimeMs); } catch {}
        if (isNaN(date.getTime())) date = new Date();
      }
      const dateTaken = date.toISOString();

      const faces = (meta.faces && meta.faces.length > 0) ? meta.faces : undefined;
      const faceScanCompleted = Boolean(meta.faceScanCompleted || (faces && faces.length > 0));

      return {
        id: Buffer.from(meta.thumbnailPath).toString('base64'),
        filePath: meta.thumbnailPath,
        fileName: meta.fileName,
        fileSize: meta.originalFileSize,
        fileDate: dateTaken,
        dateTaken,
        year: date.getFullYear(),
        month: date.getMonth() + 1,
        day: date.getDate(),
        width: meta.width,
        height: meta.height,
        exif: meta.exif,
        location: meta.location,
        isVirtual: true,
        originalRemotePath: meta.originalFilePath,
        storageName: meta.storageName,
        isFavorite: false,
        faces,
        faceScanCompleted,
        rotation: meta.rotation,
        isHeicRotated: meta.isHeicRotated,
        heicRotation: meta.heicRotation,
      };
    } catch (jsonErr) {
      console.warn(`Failed to parse sidecar JSON ${fullPath}:`, jsonErr);
      return null;
    }
  }

  // Sidecars are read MIRROR_SCAN_CONCURRENCY at a time (Promise.all keeps their order), and
  // subfolders are visited sequentially in readdir position — so `photos` comes out in exactly
  // the order the old one-at-a-time walk produced.
  async function scan(current: string): Promise<void> {
    try {
      const entries = await fs.promises.readdir(current, { withFileTypes: true });
      let batch: Promise<Photo | null>[] = [];
      const flush = async () => {
        if (batch.length === 0) return;
        const n = batch.length;
        const results = await Promise.all(batch);
        batch = [];
        for (const r of results) if (r) photos.push(r);
        await maybeYield(n);
      };
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (!entry.name.startsWith('.')) {
            await flush();
            await scan(path.join(current, entry.name));
          }
        } else if (entry.isFile() && entry.name.endsWith('.json')) {
          batch.push(readSidecar(path.join(current, entry.name)));
          if (batch.length >= MIRROR_SCAN_CONCURRENCY) await flush();
        }
      }
      await flush();
    } catch (err) {
      console.error(`Error scanning virtual mirror directory ${current}:`, err);
    }
  }

  await scan(mirrorDirPath);
  logger.debug('VirtualMirror', `scanVirtualMirrorDirectory found ${photos.length} photos`, {
    mirrorDirPath,
    durationMs: Date.now() - startedAt,
  });
  return photos;
}

export function discoverStoredMirrors(customRoot?: string): VirtualStorageConfig[] {
  const root = customRoot || getDefaultMirrorRoot();
  if (!fs.existsSync(root)) return [];

  const storages: VirtualStorageConfig[] = [];
  try {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;

      const subDir = path.join(root, entry.name);
      const summaryFile = path.join(subDir, '_mirror_summary.json');

      // Fast-path 1: Instant load from cached summary (<0.2ms)
      if (fs.existsSync(summaryFile)) {
        try {
          const cached: VirtualStorageConfig = JSON.parse(fs.readFileSync(summaryFile, 'utf-8'));
          if (cached && cached.name) {
            storages.push(cached);
            continue;
          }
        } catch {}
      }

      // Fast-path 2: Find sample sidecar for metadata + count json files quickly
      let detectedName = entry.name;
      let networkSourcePath = '';
      let sampleMetaFound = false;
      let totalPhotos = 0;
      let sampleOrigSize = 0;
      let sampleThumbSize = 0;
      let latestMtime = 0;

      function quickScan(dir: string, depth = 0) {
        if (depth > 6) return;
        try {
          const subEntries = fs.readdirSync(dir, { withFileTypes: true });
          for (const se of subEntries) {
            const p = path.join(dir, se.name);
            if (se.isDirectory() && !se.name.startsWith('.')) {
              quickScan(p, depth + 1);
            } else if (se.isFile() && se.name.endsWith('.json') && !isMirrorHousekeepingFile(se.name)) {
              totalPhotos++;
              if (!sampleMetaFound) {
                try {
                  const stat = fs.statSync(p);
                  if (stat.mtimeMs > latestMtime) latestMtime = stat.mtimeMs;
                  const meta: VirtualPhotoMetadata = JSON.parse(fs.readFileSync(p, 'utf-8'));
                  if (meta.storageName) detectedName = meta.storageName;
                  if (meta.storageRoot) networkSourcePath = meta.storageRoot;
                  sampleOrigSize = meta.originalFileSize || 3500000;
                  if (meta.thumbnailPath && fs.existsSync(meta.thumbnailPath)) {
                    sampleThumbSize = fs.statSync(meta.thumbnailPath).size;
                  }
                  sampleMetaFound = true;
                } catch {}
              }
            }
          }
        } catch {}
      }

      quickScan(subDir);

      if (totalPhotos > 0) {
        const estOriginal = totalPhotos * (sampleOrigSize || 3500000);
        const estThumb = totalPhotos * (sampleThumbSize || 65000);
        const config: VirtualStorageConfig = {
          id: `storage_${entry.name}`,
          name: detectedName,
          networkSourcePath: networkSourcePath || subDir,
          localMirrorRoot: root,
          lastSynced: latestMtime > 0 ? new Date(latestMtime).toISOString() : new Date().toISOString(),
          totalItems: totalPhotos,
          totalSizeSaved: Math.max(0, estOriginal - estThumb),
        };
        storages.push(config);

        // Save lightweight summary file asynchronously so subsequent startups take 0ms
        try {
          writeJsonAtomic(summaryFile, config);
        } catch {}
      }
    }
  } catch (err) {
    console.error('Failed to discover stored mirrors:', err);
  }

  return storages;
}

export const SYSTEM_IGNORED_FOLDERS = new Set([
  '$recycle.bin',
  'system volume information',
  'windows',
  'program files',
  'program files (x86)',
  'programdata',
  'msocache',
  'recovery',
  'perflogs',
  'appdata',
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  '.vscode',
  '.gemini',
]);

/**
 * Reads direct children directories of dirPath for the lazy-loading Folder Tree Explorer.
 */
export function readDirectoryTree(dirPath: string): FolderTreeNode[] {
  const result: FolderTreeNode[] = [];
  if (!dirPath || !fs.existsSync(dirPath)) return result;

  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const lower = entry.name.toLowerCase();
      if (SYSTEM_IGNORED_FOLDERS.has(lower) || entry.name.startsWith('$') || entry.name.startsWith('.')) {
        continue;
      }

      const fullPath = path.join(dirPath, entry.name);
      let hasChildren = false;
      let photoCount = 0;

      try {
        const subEntries = fs.readdirSync(fullPath, { withFileTypes: true });
        for (const se of subEntries) {
          if (se.isDirectory()) {
            const subLower = se.name.toLowerCase();
            if (!SYSTEM_IGNORED_FOLDERS.has(subLower) && !se.name.startsWith('$') && !se.name.startsWith('.')) {
              hasChildren = true;
            }
          } else if (se.isFile() && isImageFile(se.name)) {
            photoCount++;
          }
        }
      } catch {
        // Protected / unreadable folder
      }

      result.push({
        name: entry.name,
        path: fullPath,
        hasChildren,
        photoCount,
      });
    }
  } catch (err) {
    console.error(`Error reading directory tree at ${dirPath}:`, err);
  }

  return result;
}

/**
 * Reads direct image files in a specific folder on the fly for instant browsing before scan completes.
 */
export async function readFolderPhotos(folderPath: string, mirrorRoot?: string): Promise<Photo[]> {
  const photos: Photo[] = [];
  if (!folderPath || !(await pathExists(folderPath))) return photos;

  try {
    const entries = (await fs.promises.readdir(folderPath, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && (isImageFile(entry.name) || isVideoFile(entry.name)));

    // Up to FOLDER_READ_CONCURRENCY files in flight (each is a stat + EXIF header read, latency-bound
    // on a network folder); results are collected by index so the output order matches readdir order.
    const results: (Photo | null)[] = new Array(entries.length).fill(null);
    let next = 0;
    const worker = async () => {
      while (next < entries.length) {
        const idx = next++;
        const entry = entries[idx];
        const fullPath = path.join(folderPath, entry.name);
        try {
          const stat = await fs.promises.stat(fullPath);
          const meta = await parsePhotoMetadata(fullPath);

          const dateTaken = meta.dateTaken || (stat.mtime ? stat.mtime.toISOString() : new Date().toISOString());
          const d = new Date(dateTaken);
          const safeDate = isNaN(d.getTime()) ? new Date() : d;

          results[idx] = {
            id: `photo_${Buffer.from(fullPath).toString('base64').replace(/[/+=]/g, '_')}`,
            filePath: fullPath,
            fileName: entry.name,
            fileSize: stat.size,
            fileDate: stat.mtime.toISOString(),
            dateTaken: safeDate.toISOString(),
            year: safeDate.getFullYear(),
            month: safeDate.getMonth() + 1,
            day: safeDate.getDate(),
            width: meta.width,
            height: meta.height,
            exif: meta.exif,
            location: meta.location,
            isVirtual: false,
            originalRemotePath: fullPath,
            // Duration left unset here deliberately — this path is "instant browsing before the
            // full scan completes" (see doc comment above), and probing every video with ffmpeg
            // would defeat that. The thumbnail/preview pipeline probes lazily when it needs it.
            ...(isVideoFile(entry.name) ? { isVideo: true } : {}),
          };
        } catch {
          // Skip unreadable individual photo
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(FOLDER_READ_CONCURRENCY, entries.length) }, worker));
    for (const r of results) if (r) photos.push(r);
  } catch (err) {
    console.error(`Error reading photos in folder ${folderPath}:`, err);
  }

  return photos;
}

/**
 * Generates an on-demand 500px thumbnail for an un-mirrored photo and saves it to cache.
 */
export async function generateThumbnailOnTheFly(
  sourceFilePath: string,
  mirrorDirPath?: string
): Promise<string | null> {
  if (!fs.existsSync(sourceFilePath)) return null;

  try {
    const thumbBuffer = await generateThumbnailBuffer(sourceFilePath, 500);
    if (!thumbBuffer) return null;

    let targetDir = mirrorDirPath;
    if (!targetDir) {
      targetDir = path.join(process.cwd(), '.thumb_cache');
    }
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    const fileName = path.basename(sourceFilePath);
    const targetPath = path.join(targetDir, fileName);
    fs.writeFileSync(targetPath, thumbBuffer);
    return targetPath;
  } catch (err) {
    console.error(`Error generating thumbnail on the fly for ${sourceFilePath}:`, err);
    return null;
  }
}

/**
 * Performs in-app photo editing (Rotate, Crop) and safely saves to the source or creates a copy.
 */
export async function editPhotoFile(options: EditPhotoOptions): Promise<EditPhotoResult> {
  const targetPath = options.originalPath || options.filePath;
  if (!(await isPathReachable(targetPath))) {
    return {
      success: false,
      error: isNetworkPath(targetPath)
        ? 'Network storage is not available (offline).'
        : `File not found: ${targetPath}`,
    };
  }

  const ext = path.extname(targetPath).toLowerCase();
  if (ext === '.heic' || ext === '.heif') {
    const thumbTarget = options.mirrorThumbnailPath || (options.filePath !== targetPath ? options.filePath : null);
    if (thumbTarget && fs.existsSync(thumbTarget) && options.base64Data) {
      try {
        const cleaned = options.base64Data.replace(/^data:image\/\w+;base64,/, '');
        const outputBuffer = Buffer.from(cleaned, 'base64');
        writeFileAtomic(thumbTarget, outputBuffer);

        // The saved bytes are a baked preview of the LOCAL mirror thumbnail
        // only — the remote .heic master (targetPath) is never touched. If
        // this edit included a rotation, record it in the shared rotation
        // flag store under both paths, the same way the quick-rotate path
        // does, so viewing the photo at full resolution later (which reads
        // the untouched remote master) still reflects it instead of the
        // rotation silently reverting.
        let totalRotation: number | undefined;
        if (options.rotationDegrees) {
          try {
            totalRotation = addSavedRotation([thumbTarget, targetPath], options.rotationDegrees).get(thumbTarget);
          } catch (err) {
            console.warn('[editPhotoFile] Failed persisting HEIC rotation flag:', err);
          }
        }

        return {
          success: true,
          newPhoto: {
            filePath: thumbTarget,
            originalRemotePath: targetPath,
            ...(totalRotation !== undefined
              ? { isHeicRotated: totalRotation !== 0, heicRotation: totalRotation, rotation: totalRotation }
              : {}),
          } as any,
        };
      } catch (e: any) {
        return { success: false, error: e.message };
      }
    }
    return {
      success: false,
      error: 'Direct editing of HEIC/HEIF images is not supported. Please export or convert to JPEG/PNG to edit.',
    };
  }

  try {
    let outputBuffer: Buffer | null = null;

    // 1. If base64Data was provided from renderer canvas
    if (options.base64Data) {
      const cleaned = options.base64Data.replace(/^data:image\/\w+;base64,/, '');
      outputBuffer = Buffer.from(cleaned, 'base64');
    } else if (nativeImage) {
      // 2. Fallback to nativeImage crop/rotate
      let img = nativeImage.createFromPath(targetPath);
      if (options.cropBox) {
        img = img.crop({
          x: Math.round(options.cropBox.x),
          y: Math.round(options.cropBox.y),
          width: Math.round(options.cropBox.width),
          height: Math.round(options.cropBox.height),
        });
      }
      outputBuffer = img.toJPEG(95);
    }

    if (!outputBuffer) {
      return { success: false, error: 'Could not process image data' };
    }

    let finalSavePath = targetPath;
    if (options.saveAsCopy) {
      const dir = path.dirname(targetPath);
      const ext = path.extname(targetPath);
      const base = path.basename(targetPath, ext);
      finalSavePath = path.join(dir, `${base}_edited_${Date.now()}${ext}`);
    } else {
      // Safe Overwrite: a .bak of the original is REQUIRED — if it can't be
      // made, refuse rather than overwrite the only copy.
      const bakPath = `${targetPath}.bak`;
      if (!fs.existsSync(bakPath)) {
        try {
          fs.copyFileSync(targetPath, bakPath);
        } catch (bakErr: any) {
          return { success: false, error: `Could not create a backup of the original before editing (${bakErr?.message || bakErr}); nothing was changed.` };
        }
      }
    }

    // Temp file + rename: a crash / network drop mid-write can't truncate the original.
    writeFileAtomic(finalSavePath, outputBuffer);

    // Also update mirror thumbnail if provided
    if (options.mirrorThumbnailPath && fs.existsSync(options.mirrorThumbnailPath)) {
      try {
        const thumbBuf = await generateThumbnailBuffer(finalSavePath, 500);
        if (thumbBuf) {
          writeFileAtomic(options.mirrorThumbnailPath, thumbBuf);
        }
      } catch {
        // ignore
      }
    }

    const stat = fs.statSync(finalSavePath);
    const meta = await parsePhotoMetadata(finalSavePath);
    const dateTaken = meta.dateTaken || stat.mtime.toISOString();
    const d = new Date(dateTaken);
    const safeDate = isNaN(d.getTime()) ? new Date() : d;

    const newPhoto: Photo = {
      id: `photo_${Buffer.from(finalSavePath).toString('base64').replace(/[/+=]/g, '_')}`,
      filePath: finalSavePath,
      fileName: path.basename(finalSavePath),
      fileSize: stat.size,
      fileDate: stat.mtime.toISOString(),
      dateTaken: safeDate.toISOString(),
      year: safeDate.getFullYear(),
      month: safeDate.getMonth() + 1,
      day: safeDate.getDate(),
      width: meta.width,
      height: meta.height,
      exif: meta.exif,
      location: meta.location,
      isVirtual: !!options.originalPath,
      originalRemotePath: finalSavePath,
    };

    return {
      success: true,
      savedPath: finalSavePath,
      newPhoto,
    };
  } catch (err: any) {
    console.error(`Error saving edited photo ${targetPath}:`, err);
    return { success: false, error: err.message };
  }
}

/**
 * Moves multiple duplicate/inferior photos safely to the OS Recycle Bin.
 */
export async function trashFiles(filePaths: string[]): Promise<{ success: boolean; trashedCount: number; trashedPaths: string[]; errors: string[] }> {
  const errors: string[] = [];
  const trashedPaths: string[] = [];

  // Try electron shell.trashItem
  let shell: any = null;
  try {
    const electron = require('electron');
    shell = electron.shell;
  } catch {
    // node testing environment
  }

  for (const fp of filePaths) {
    // isPathReachable (not fs.existsSync) so an offline network share never
    // gets attempted — it's a bounded, cached probe instead of a sync call
    // that can hang the main process for the OS's full network timeout.
    if (!(await isPathReachable(fp))) {
      errors.push(
        isNetworkPath(fp)
          ? `${path.basename(fp)}: network storage is not available (offline). Skipped.`
          : `${path.basename(fp)}: file not found. Skipped.`
      );
      continue;
    }
    try {
      if (shell && typeof shell.trashItem === 'function') {
        await shell.trashItem(fp);
      } else {
        fs.unlinkSync(fp);
      }
      trashedPaths.push(fp);
    } catch (err: any) {
      errors.push(`Failed to trash ${fp}: ${err.message}`);
    }
  }

  return {
    success: errors.length === 0,
    trashedCount: trashedPaths.length,
    trashedPaths,
    errors,
  };
}

/**
 * Permanently unlinks/deletes files from disk and cleans up any associated sidecar .json files.
 */
export async function deleteFilesPermanently(filePaths: string[]): Promise<{ success: boolean; deletedCount: number; deletedPaths: string[]; errors: string[] }> {
  const errors: string[] = [];
  const deletedPaths: string[] = [];

  for (const fp of filePaths) {
    // Same reachability-first check as trashFiles — never attempt a delete
    // against a path whose network storage is offline.
    if (!(await isPathReachable(fp))) {
      errors.push(
        isNetworkPath(fp)
          ? `${path.basename(fp)}: network storage is not available (offline). Skipped.`
          : `${path.basename(fp)}: file not found. Skipped.`
      );
      continue;
    }
    try {
      fs.unlinkSync(fp);
      // If this is a virtual mirror photo or has a matching .json sidecar, delete it too
      const jsonSidecar = fp.replace(/\.[^/.]+$/, '') + '.json';
      if (fs.existsSync(jsonSidecar)) {
        try {
          // Only remove a sidecar that is this app's own mirror sidecar FOR this
          // file — never an unrelated same-named .json sitting next to a photo.
          const meta = JSON.parse(fs.readFileSync(jsonSidecar, 'utf-8'));
          if (
            meta &&
            typeof meta.thumbnailPath === 'string' &&
            path.resolve(meta.thumbnailPath).toLowerCase() === path.resolve(fp).toLowerCase()
          ) {
            fs.unlinkSync(jsonSidecar);
          }
        } catch (sidecarErr) {
          console.warn(`Could not remove sidecar ${jsonSidecar}:`, sidecarErr);
        }
      }
      deletedPaths.push(fp);
    } catch (err: any) {
      errors.push(`Failed to permanently delete ${fp}: ${err.message}`);
    }
  }

  return {
    success: errors.length === 0,
    deletedCount: deletedPaths.length,
    deletedPaths,
    errors,
  };
}

/**
 * Rotates an image file by the specified degrees (e.g. 90, 180, 270) using Sharp (or nativeImage fallback).
 * Automatically creates a .bak backup and saves the rotated image to disk.
 */
const RAW_EXTENSIONS = new Set(['.dng', '.raw', '.cr2', '.cr3', '.nef', '.nrw', '.arw', '.orf', '.rw2', '.raf', '.pef', '.srw']);

export async function rotatePhotoFile(
  filePath: string,
  rotationDegrees: number,
  secondaryPath?: string
): Promise<{ success: boolean; newPath?: string; error?: string; delegatedToCacheRotation?: boolean; unsupported?: boolean }> {
  try {
    if (!(await isPathReachable(filePath))) {
      return {
        success: false,
        error: isNetworkPath(filePath)
          ? 'Network storage is not available (offline).'
          : `File not found: ${filePath}`,
      };
    }

    const degrees = ((rotationDegrees % 360) + 360) % 360;
    if (degrees === 0) {
      return { success: true, newPath: filePath };
    }

    const ext = path.extname(filePath).toLowerCase();
    let isRawHeic = ext === '.heic' || ext === '.heif';

    // Check if the file buffer is actually a JPEG/WebP thumbnail (often named after source photo)
    // Async, not readFileSync: filePath can be on a slow/degraded network mount, and a sync read
    // there blocks the WHOLE main process — every IPC call, menu action, window repaint — for as
    // long as that read takes (seen in practice: a 20s+ "MAIN PROCESS STALL" attributed to
    // photo:rotate). An async read still takes as long for THIS call, but lets everything else
    // keep running meanwhile.
    const inputBuf = await fs.promises.readFile(filePath);
    const isJpegBuffer = inputBuf.length > 2 && inputBuf[0] === 0xff && inputBuf[1] === 0xd8;
    const isWebpBuffer = inputBuf.length > 12 && inputBuf.slice(0, 4).toString() === 'RIFF';

    // Camera RAW originals (.nef, .dng, .cr2, ...) are TIFF-based containers: re-encoding them with sharp would
    // overwrite the master with different pixel data (or fail). Only rotate such a file in place when its bytes
    // really are a plain JPEG/WebP/PNG (a mirror thumbnail that is merely NAMED after the RAW file).
    const isPngBuffer = inputBuf.length > 8 && inputBuf[0] === 0x89 && inputBuf.slice(1, 4).toString() === 'PNG';
    if (RAW_EXTENSIONS.has(ext) && !isJpegBuffer && !isWebpBuffer && !isPngBuffer) {
      return {
        success: false,
        unsupported: true,
        error: `"${path.basename(filePath)}" is a camera RAW file and cannot be rotated in place; it was left unchanged.`,
      };
    }

    if (isRawHeic && !isJpegBuffer && !isWebpBuffer) {
      // Raw HEIC files cannot be re-encoded on Windows with Sharp.
      // Delegate to rotating multi-tier cached thumbnails and recording in
      // heicRotationStore — under BOTH filePath and secondaryPath (e.g. a
      // distinct remote/original path), since callers may look the saved
      // rotation up under either one.
      try {
        const { rotateCachedHeicThumbnail } = require('./thumbnailCacheService');
        await rotateCachedHeicThumbnail(filePath, degrees, secondaryPath);
        return {
          success: true,
          newPath: filePath,
          delegatedToCacheRotation: true,
        };
      } catch (rotErr: any) {
        return {
          success: false,
          error: `Failed rotating cached thumbnail for HEIC: ${rotErr.message}`,
        };
      }
    }

    // Create .bak backup if it doesn't already exist — required: without it
    // a failed/interrupted write would leave no recoverable copy.
    const bakPath = `${filePath}.bak`;
    const bakAlreadyExists = await fs.promises.access(bakPath).then(() => true, () => false);
    if (!bakAlreadyExists) {
      try {
        await fs.promises.copyFile(filePath, bakPath);
      } catch (bakErr: any) {
        return { success: false, error: `Could not create a backup before rotating (${bakErr?.message || bakErr}); file left unchanged.` };
      }
    }

    let outputBuffer: Buffer | null = null;
    let sharpLib: any = null;
    try {
      sharpLib = require('sharp');
    } catch {}

    let prevMtime: number | undefined;
    try {
      prevMtime = (await fs.promises.stat(filePath)).mtimeMs;
    } catch {}

    if (sharpLib) {
      // .rotate() first bakes in any EXIF Orientation; an explicit-angle rotate
      // alone ignores the tag, so a phone photo (orientation 6/8/3) would come
      // out wrong once the tag is reset to 1.
      outputBuffer = await sharpLib(inputBuf)
        .rotate()
        .rotate(degrees)
        .withMetadata({ orientation: 1 })
        .toBuffer();
    } else if (nativeImage) {
      let img = nativeImage.createFromBuffer(inputBuf);
      outputBuffer = img.toJPEG(95);
    }

    if (!outputBuffer) {
      return { success: false, error: 'Could not process image rotation' };
    }

    await writeFileAtomicAsync(filePath, outputBuffer);

    // Purge cached thumbnails on disk so fresh orientation displays immediately
    try {
      const { purgeCachedThumbnailsForFile } = require('./thumbnailCacheService');
      await purgeCachedThumbnailsForFile(filePath, prevMtime);
    } catch {}

    return { success: true, newPath: filePath };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export interface PendingRotationItem {
  id: string;
  originalRemotePath: string;
  localFilePath?: string;
  rotationDegrees: number;
  timestamp: number;
  /** How many times a reachable-but-failing rotation has actually been attempted (not counted while
   *  simply offline — that's an expected, indefinite wait, not a failure). Past MAX_ROTATION_ATTEMPTS
   *  the item is dropped, its local thumbnail reverted, and the user notified instead of retrying forever. */
  attempts?: number;
}

export const MAX_ROTATION_ATTEMPTS = 5;

// Told about a queued original rotation that never made it (format unsupported, or persistently
// failing) after its local mirror thumbnail was already optimistically rotated — main.ts forwards
// this to the renderer as a toast + a thumbnail refresh, so the UI stops showing pixels the actual
// file was never able to match. A plain listener set (not a direct Electron import) keeps this file
// testable without a BrowserWindow, same pattern as thumbnailCacheService's onThumbnailCacheCleared.
export interface RotationFailureInfo {
  originalRemotePath: string;
  localFilePath?: string;
  rotationDegrees: number;
  reason: string;
}
const rotationFailureListeners = new Set<(info: RotationFailureInfo) => void>();
export function onRotationFailure(listener: (info: RotationFailureInfo) => void): () => void {
  rotationFailureListeners.add(listener);
  return () => rotationFailureListeners.delete(listener);
}
function emitRotationFailure(info: RotationFailureInfo): void {
  for (const l of rotationFailureListeners) {
    try { l(info); } catch {}
  }
}

/** Undoes a local mirror thumbnail's optimistic rotation once its matching original rotation has
 *  given up for good, so the thumbnail stops disagreeing with the original it was never able to
 *  update, and tells whoever's listening (the renderer, normally) why. */
async function revertLocalThumbnailAndNotify(item: PendingRotationItem, reason: string): Promise<void> {
  if (item.localFilePath) {
    try {
      const undoDegrees = (360 - (item.rotationDegrees % 360)) % 360;
      if (undoDegrees !== 0) await rotatePhotoFile(item.localFilePath, undoDegrees);
    } catch (err) {
      console.warn('[OfflineRotationSync] Failed to revert local thumbnail after giving up:', err);
    }
  }
  emitRotationFailure({ originalRemotePath: item.originalRemotePath, localFilePath: item.localFilePath, rotationDegrees: item.rotationDegrees, reason });
}

export function getPendingRotationsPath(): string {
  try {
    const electron = require('electron');
    if (electron.app) {
      return path.join(electron.app.getPath('userData'), 'pending_rotations.json');
    }
  } catch {}
  const fallback = process.env.APPDATA
    ? path.join(process.env.APPDATA, 'gPhotos')
    : path.join(process.cwd(), '.temp');
  if (!fs.existsSync(fallback)) {
    try {
      fs.mkdirSync(fallback, { recursive: true });
    } catch {}
  }
  return path.join(fallback, 'pending_rotations.json');
}

export function getPendingRotations(): PendingRotationItem[] {
  const p = getPendingRotationsPath();
  try {
    const items = readJsonSafe<PendingRotationItem[]>(p, []);
    return Array.isArray(items) ? items : [];
  } catch {
    return [];
  }
}

/** Returns false if the queue could not be persisted. */
export function savePendingRotations(items: PendingRotationItem[]): boolean {
  const p = getPendingRotationsPath();
  try {
    writeJsonAtomic(p, items);
    return true;
  } catch (err) {
    console.warn('[OfflineRotationSync] Failed to save pending rotations:', err);
    return false;
  }
}

export function enqueuePendingRotation(
  originalRemotePath: string,
  rotationDegrees: number,
  localFilePath?: string
): void {
  const items = getPendingRotations();
  const normTarget = originalRemotePath.toLowerCase().replace(/\\/g, '/');
  const existingIdx = items.findIndex(
    (i) => i.originalRemotePath.toLowerCase().replace(/\\/g, '/') === normTarget
  );

  const degrees = ((rotationDegrees % 360) + 360) % 360;
  if (degrees === 0) return;

  if (existingIdx !== -1) {
    const combinedDegrees = (items[existingIdx].rotationDegrees + degrees) % 360;
    if (combinedDegrees === 0) {
      // Rotations cancelled out back to original
      items.splice(existingIdx, 1);
    } else {
      items[existingIdx].rotationDegrees = combinedDegrees;
      items[existingIdx].timestamp = Date.now();
      items[existingIdx].attempts = 0; // a newly-requested rotation amount gets a fresh retry budget
      if (localFilePath) items[existingIdx].localFilePath = localFilePath;
    }
  } else {
    items.push({
      id: Buffer.from(originalRemotePath).toString('base64').replace(/[/+=]/g, '_'),
      originalRemotePath,
      localFilePath,
      rotationDegrees: degrees,
      timestamp: Date.now(),
      attempts: 0,
    });
  }

  savePendingRotations(items);
}

function normQueuePath(p: string): string {
  return p.toLowerCase().replace(/\\/g, '/');
}

// Re-entrancy guard: overlapping runs (daemon cycle + IPC + web server) would
// each read the same queue and apply the same rotation twice (rotation is not idempotent).
let pendingRotationsRun: Promise<{ processed: number; remaining: number }> | null = null;

export function processPendingRotations(): Promise<{ processed: number; remaining: number }> {
  if (!pendingRotationsRun) {
    pendingRotationsRun = runPendingRotations().finally(() => {
      pendingRotationsRun = null;
    });
  }
  return pendingRotationsRun;
}

async function runPendingRotations(): Promise<{ processed: number; remaining: number }> {
  const items = getPendingRotations();
  if (items.length === 0) return { processed: 0, remaining: 0 };

  let processed = 0;

  for (const item of items) {
    if (!(await isPathReachable(item.originalRemotePath))) continue; // still offline — an expected, indefinite wait, not a failure

    let res: { success: boolean; error?: string; unsupported?: boolean };
    try {
      console.log(`[OfflineRotationSync] Applying pending rotation (${item.rotationDegrees}°) to reconnected source: ${item.originalRemotePath}`);
      res = await rotatePhotoFile(item.originalRemotePath, item.rotationDegrees);
    } catch (err: any) {
      res = { success: false, error: err?.message || String(err) };
    }

    // Re-read first for every outcome below — enqueuePendingRotation may have combined more rotation
    // into this same entry (or reset its attempts) while we were awaiting the rotate above.
    const current = getPendingRotations();
    const idx = current.findIndex((i) => normQueuePath(i.originalRemotePath) === normQueuePath(item.originalRemotePath));

    if (res.success) {
      processed++;
    } else if (!res.unsupported) {
      // A real, reachable-but-failing rotation (lock held by another process, a momentary permission
      // error, ...) gets a few tries across cycles before giving up, rather than either retrying
      // forever with the user none the wiser, or giving up on the very first transient hiccup.
      const attempts = ((idx !== -1 ? current[idx].attempts : item.attempts) ?? 0) + 1;
      if (attempts < MAX_ROTATION_ATTEMPTS) {
        if (idx !== -1) {
          current[idx].attempts = attempts;
          savePendingRotations(current);
        }
        continue; // still queued for the next cycle
      }
      console.warn(`[OfflineRotationSync] Giving up on ${item.originalRemotePath} after ${attempts} failed attempts: ${res.error}`);
    } else {
      // An unsupported format (camera RAW) can never succeed no matter how many times it's retried.
      console.warn(`[OfflineRotationSync] Dropping queued rotation, ${res.error}`);
    }

    // Reached for success, an unsupported drop, or giving up after MAX_ROTATION_ATTEMPTS — in the
    // latter two cases the original was never actually rotated, so the local thumbnail's earlier
    // optimistic rotation now disagrees with it and must be undone, and the user told why.
    if (!res.success) await revertLocalThumbnailAndNotify(item, res.error || 'This file could not be rotated.');
    if (idx !== -1) {
      const left = (((current[idx].rotationDegrees - item.rotationDegrees) % 360) + 360) % 360;
      if (left === 0) current.splice(idx, 1);
      else current[idx].rotationDegrees = left;
      if (!savePendingRotations(current)) break; // can't record it -> stop rather than double-apply later
    }
  }

  return { processed, remaining: getPendingRotations().length };
}

export interface PendingMetadataItem {
  id: string;
  originalRemotePath: string;
  dateIso?: string;
  latitude?: number;
  longitude?: number;
  timestamp: number;
}

export function getPendingMetadataPath(): string {
  try {
    const electron = require('electron');
    if (electron.app) {
      return path.join(electron.app.getPath('userData'), 'pending_metadata.json');
    }
  } catch {}
  const fallback = process.env.APPDATA
    ? path.join(process.env.APPDATA, 'gPhotos')
    : path.join(process.cwd(), '.temp');
  if (!fs.existsSync(fallback)) {
    try {
      fs.mkdirSync(fallback, { recursive: true });
    } catch {}
  }
  return path.join(fallback, 'pending_metadata.json');
}

export function getPendingMetadata(): PendingMetadataItem[] {
  const p = getPendingMetadataPath();
  try {
    const items = readJsonSafe<PendingMetadataItem[]>(p, []);
    return Array.isArray(items) ? items : [];
  } catch {
    return [];
  }
}

/** Returns false if the queue could not be persisted. */
export function savePendingMetadata(items: PendingMetadataItem[]): boolean {
  const p = getPendingMetadataPath();
  try {
    writeJsonAtomic(p, items);
    return true;
  } catch (err) {
    console.warn('[OfflineMetadataSync] Failed to save pending metadata:', err);
    return false;
  }
}

/**
 * Queues a date and/or location update for an original file that's
 * currently unreachable. Merges into any existing pending entry for the
 * same path so, e.g., editing the date twice while still offline doesn't
 * leave two stale queue entries — the latest value per field wins.
 */
export function enqueuePendingMetadata(originalRemotePath: string, update: PhotoMetadataUpdate): void {
  const items = getPendingMetadata();
  const normTarget = originalRemotePath.toLowerCase().replace(/\\/g, '/');
  const existingIdx = items.findIndex(
    (i) => i.originalRemotePath.toLowerCase().replace(/\\/g, '/') === normTarget
  );

  if (existingIdx !== -1) {
    const existing = items[existingIdx];
    if (update.dateIso !== undefined) existing.dateIso = update.dateIso;
    if (update.latitude !== undefined) existing.latitude = update.latitude;
    if (update.longitude !== undefined) existing.longitude = update.longitude;
    existing.timestamp = Date.now();
  } else {
    items.push({
      id: Buffer.from(originalRemotePath).toString('base64').replace(/[/+=]/g, '_'),
      originalRemotePath,
      dateIso: update.dateIso,
      latitude: update.latitude,
      longitude: update.longitude,
      timestamp: Date.now(),
    });
  }

  savePendingMetadata(items);
}

let pendingMetadataRun: Promise<{ processed: number; remaining: number }> | null = null;

export function processPendingMetadata(): Promise<{ processed: number; remaining: number }> {
  if (!pendingMetadataRun) {
    pendingMetadataRun = runPendingMetadata().finally(() => {
      pendingMetadataRun = null;
    });
  }
  return pendingMetadataRun;
}

async function runPendingMetadata(): Promise<{ processed: number; remaining: number }> {
  const items = getPendingMetadata();
  if (items.length === 0) return { processed: 0, remaining: 0 };

  let processed = 0;

  for (const item of items) {
    try {
      if (await isPathReachable(item.originalRemotePath)) {
        console.log(`[OfflineMetadataSync] Applying pending date/location update to reconnected source: ${item.originalRemotePath}`);
        const res = writePhotoMetadata(item.originalRemotePath, {
          dateIso: item.dateIso,
          latitude: item.latitude,
          longitude: item.longitude,
        });
        if (res.success) {
          processed++;
          // Persist immediately; re-read so entries queued/merged meanwhile aren't dropped.
          // An entry updated after we started (newer timestamp) stays queued — applying
          // metadata is idempotent, so it just gets re-applied with the latest values.
          const current = getPendingMetadata();
          const idx = current.findIndex((i) => normQueuePath(i.originalRemotePath) === normQueuePath(item.originalRemotePath));
          if (idx !== -1 && current[idx].timestamp === item.timestamp) {
            current.splice(idx, 1);
            if (!savePendingMetadata(current)) break;
          }
        }
      }
    } catch (err) {
      console.warn(`[OfflineMetadataSync] Error applying metadata to ${item.originalRemotePath}:`, err);
    }
  }

  return { processed, remaining: getPendingMetadata().length };
}

/**
 * Writes a date/location update to a photo with offline queue durability:
 * 1. Immediately writes to the local mirror file (always reachable).
 * 2. If an original remote path is given and reachable, writes it too.
 * 3. If the original is unreachable, queues it in pending_metadata.json to
 *    be applied automatically once the storage reconnects (same pattern as
 *    rotatePhotoWithOfflineQueue above).
 */
export async function writePhotoMetadataWithOfflineQueue(params: {
  localFilePath: string;
  originalRemotePath?: string;
  update: PhotoMetadataUpdate;
}): Promise<{ success: boolean; wroteExif: boolean; wroteOriginal: boolean; isQueued: boolean; error?: string }> {
  const { localFilePath, originalRemotePath, update } = params;
  const localResult = writePhotoMetadata(localFilePath, update);

  let wroteOriginal = false;
  let isQueued = false;

  if (originalRemotePath && originalRemotePath !== localFilePath) {
    if (await isPathReachable(originalRemotePath)) {
      const originalResult = writePhotoMetadata(originalRemotePath, update);
      wroteOriginal = originalResult.success;
      if (!originalResult.success) {
        enqueuePendingMetadata(originalRemotePath, update);
        isQueued = true;
      }
    } else {
      enqueuePendingMetadata(originalRemotePath, update);
      isQueued = true;
    }
  }

  return { ...localResult, wroteOriginal, isQueued };
}

/**
 * Rotates photo file with offline queue durability:
 * 1. Immediately rotates the local mirror thumbnail on disk so it appears rotated in the gallery.
 * 2. If original remote file is online, rotates it immediately on disk.
 * 3. If original remote file is offline, enqueues the rotation task in pending_rotations.json to be applied when reconnected.
 */
export async function rotatePhotoWithOfflineQueue(params: {
  localFilePath: string;
  originalRemotePath?: string;
  rotationDegrees: number;
}): Promise<{ success: boolean; isQueued: boolean; newPath?: string; message?: string; error?: string; isHeic?: boolean; isHeicRotated?: boolean; heicRotation?: number; rotation?: number }> {
  try {
    const { localFilePath, originalRemotePath, rotationDegrees } = params;
    const degrees = ((rotationDegrees % 360) + 360) % 360;
    if (degrees === 0) {
      return { success: true, isQueued: false, newPath: localFilePath };
    }

    const targetToCheck = originalRemotePath || localFilePath;
    const ext = path.extname(targetToCheck || '').toLowerCase();
    const isHeicByExtension = ext === '.heic' || ext === '.heif';

    if (isHeicByExtension) {
      // A Virtual Mirror local thumbnail is always JPEG bytes regardless of the
      // remote master's real format (the mirror sync pipeline generates a JPEG
      // preview for every source, HEIC included, and names it after the source
      // file). So when `originalRemotePath` points at a distinct master file,
      // `localFilePath` is that JPEG mirror thumbnail and can be rotated in
      // place like any other image. When there is no separate remote master,
      // `localFilePath` IS the original file itself, which for a genuine
      // `.heic`/`.heif` photo is raw HEIC/HEIF container bytes that Sharp
      // cannot re-encode on this platform — that case must go through the
      // cache-only rotation path instead.
      const isMirrorThumbnail = !!originalRemotePath && originalRemotePath !== localFilePath;
      const isRawHeic = !isMirrorThumbnail;

      const sidecarJson = localFilePath ? localFilePath.replace(/\.[^/.]+$/, '.json') : '';
      const hasSidecar = !!sidecarJson && (await fs.promises.access(sidecarJson).then(() => true, () => false));

      let totalRot = degrees;
      let sidecarWarning = '';

      if (isMirrorThumbnail && localFilePath && (await fs.promises.access(localFilePath).then(() => true, () => false))) {
        // Physically rotate the real JPEG bytes on disk (also purges
        // derived thumbnail-cache tiers so they regenerate with the new
        // orientation). "Mirror thumbnail" here is a path-based guess — the
        // local file is sometimes actually genuine raw HEIC bytes copied
        // as-is (e.g. HEIC decoding failed during sync), in which case
        // rotatePhotoFile detects that by sniffing the bytes and delegates
        // to rotateCachedHeicThumbnail itself, passing the remote path
        // through so both paths' flags get recorded in one place.
        const rotateResult = await rotatePhotoFile(localFilePath, degrees, originalRemotePath);
        if (!rotateResult.success) {
          return { success: false, isQueued: false, error: rotateResult.error || 'Rotation failed' };
        }

        if (!rotateResult.delegatedToCacheRotation) {
          // Genuine physical rotation happened — rotatePhotoFile only
          // rewrote the local file's pixels, it doesn't touch the rotation
          // flag store. Persist the accumulated rotation under BOTH the
          // local mirror thumbnail path and the remote original path here.
          // Code that displays the photo at full resolution (the
          // Lightbox's "preferOriginal" path) loads directly from the
          // remote original whenever it's reachable — that file is never
          // physically rotated — and its saved-rotation lookup is keyed by
          // that same remote path. Without recording it there too, the
          // rotation looked up 0° and the photo appeared to silently
          // revert the next time that code path ran (e.g. opening the
          // Lightbox once the network share was reachable again).
          try {
            const totals = addSavedRotation([localFilePath, originalRemotePath], degrees);
            totalRot = totals.get(localFilePath) ?? degrees;
          } catch (err) {
            console.warn('[rotatePhotoWithOfflineQueue] Failed persisting mirror rotation flag:', err);
          }
        } else {
          // rotatePhotoFile already recorded the accumulated rotation
          // (under both paths) via rotateCachedHeicThumbnail — read it back
          // rather than writing the delta again, which would double-count it.
          try {
            totalRot = getHeicSavedRotation(localFilePath);
          } catch {}
        }
      } else {
        // Genuinely raw HEIC/HEIF bytes cannot be re-encoded via Sharp on this
        // platform. Rotate the multi-tier cached thumbnails instead and record
        // the rotation persistently so it survives future re-reads.
        const sourceHeicPath = (originalRemotePath && (await isPathReachable(originalRemotePath)))
          ? originalRemotePath
          : localFilePath;
        try {
          const { rotateCachedHeicThumbnail } = require('./thumbnailCacheService');
          const secondary = (originalRemotePath && originalRemotePath !== localFilePath) ? originalRemotePath : undefined;
          totalRot = await rotateCachedHeicThumbnail(localFilePath || sourceHeicPath, degrees, secondary);
        } catch (err) {
          console.warn('[rotatePhotoWithOfflineQueue] Failed rotating cached HEIC thumbnail:', err);
        }
      }

      // Update sidecar metadata JSON if present, for either case above.
      if (hasSidecar) {
        try {
          const meta = JSON.parse(await fs.promises.readFile(sidecarJson, 'utf-8'));
          if (degrees === 90 || degrees === 270) {
            const oldW = meta.width;
            meta.width = meta.height;
            meta.height = oldW;
          }
          meta.rotation = (((meta.rotation || 0) + degrees) % 360 + 360) % 360;
          meta.isHeicRotated = meta.rotation !== 0;
          meta.heicRotation = meta.rotation;
          if (isMirrorThumbnail) totalRot = meta.rotation;
          await writeJsonAtomicAsync(sidecarJson, meta);
        } catch (sidecarErr: any) {
          console.warn('[rotatePhotoWithOfflineQueue] Failed updating sidecar:', sidecarErr);
          sidecarWarning = ` (Warning: could not update photo metadata file: ${sidecarErr?.message || sidecarErr})`;
        }
      }

      return {
        success: true,
        isQueued: false,
        isHeic: isRawHeic,
        isHeicRotated: totalRot !== 0,
        heicRotation: totalRot,
        rotation: totalRot,
        newPath: localFilePath,
        message: isMirrorThumbnail
          ? 'Rotated local mirror thumbnail on disk.' + sidecarWarning
          : 'Rotated and cached local thumbnail for HEIC image.' + sidecarWarning,
      };
    }

    // 1. Rotate local thumbnail on disk immediately
    if (localFilePath && (await fs.promises.access(localFilePath).then(() => true, () => false))) {
      const localRotate = await rotatePhotoFile(localFilePath, degrees);
      if (!localRotate.success) {
        // A local path that is itself on an offline share fails only because it is offline:
        // fall through to the offline queue (below) instead of losing the rotation. Any other
        // failure is a real error the user must see.
        if (await isPathReachable(localFilePath)) {
          return { success: false, isQueued: false, error: localRotate.error || 'Rotation failed' };
        }
      } else {
        // Update sidecar metadata JSON if present
        const sidecarJson = localFilePath.replace(/\.[^/.]+$/, '.json');
        const sidecarExists = await fs.promises.access(sidecarJson).then(() => true, () => false);
        if (sidecarExists) {
          try {
            const meta = JSON.parse(await fs.promises.readFile(sidecarJson, 'utf-8'));
            if (degrees === 90 || degrees === 270) {
              const oldW = meta.width;
              meta.width = meta.height;
              meta.height = oldW;
            }
            await writeJsonAtomicAsync(sidecarJson, meta);
          } catch (sidecarErr) {
            console.warn('[rotatePhotoWithOfflineQueue] Failed updating sidecar:', sidecarErr);
          }
        }
      }
    }

    // 2. The remote/original — if there even is a separate one — is NEVER rotated inline here. The
    // local mirror thumbnail above is already rotated and on screen; re-encoding a possibly-large
    // original on a possibly-slow network mount here would block this whole request for however long
    // that takes (the ~20s main-process freeze this exists to prevent), regardless of whether the
    // source happens to be reachable right now or not. It's always handed to the background queue
    // instead, which processPendingRotations (already driven periodically by backgroundDaemon.ts)
    // drains independently of any particular rotate request. If it's still reachable, that happens
    // on the very next cycle; if it never manages to rotate within its retry budget (see
    // MAX_ROTATION_ATTEMPTS / revertLocalThumbnailAndNotify), the local thumbnail is reverted and the
    // user is told why, instead of the two silently disagreeing forever.
    const remoteTarget = originalRemotePath || localFilePath;
    if (remoteTarget === localFilePath) {
      // No separate original at all — the one rotation there is to do already happened above.
      return { success: true, isQueued: false, newPath: localFilePath };
    }

    // A RAW extension on the ORIGINAL (unlike the local mirror thumbnail, which is always a JPEG
    // regardless of the source's real format) is a reliable, zero-I/O signal that this can never
    // succeed — sharp cannot re-encode a RAW container — so say so immediately instead of queuing
    // something doomed to fail only after the fact.
    if (RAW_EXTENSIONS.has(path.extname(remoteTarget).toLowerCase())) {
      return {
        success: true,
        isQueued: false,
        newPath: localFilePath,
        message: `"${path.basename(remoteTarget)}" is a camera RAW file and cannot be rotated in place; the local thumbnail was rotated.`,
      };
    }

    enqueuePendingRotation(remoteTarget, degrees, localFilePath);
    // Kick the drain now rather than letting it sit until backgroundDaemon's next 30s tick — fire
    // and forget (never awaited, so this request still returns immediately): a fast/reachable
    // original then finishes in a second or two instead of up to 30s, while a genuinely slow one
    // just proceeds exactly as it would have on the next scheduled tick anyway.
    processPendingRotations().catch(() => {});
    return {
      success: true,
      isQueued: true,
      newPath: localFilePath,
      message: 'Rotated locally — the full-resolution original is finishing in the background.',
    };
  } catch (err: any) {
    return { success: false, isQueued: false, error: err.message };
  }
}


