import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { parsePhotoMetadata } from './exifParser';
import { isImageFile, scanDirectoryRecursive } from './fileOrganizer';
import { getOrGenerateHeicThumbnail500 } from './heicService';
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
import { getFaceStatsForLibrary } from './libraryRepository';
import { getDefaultMirrorRoot } from './pathSecurity';
import { isPathReachable, isNetworkPath } from './networkReachabilityCache';
import { runFaceDetectionStep, photoIdForSidecar, createFaceClusterCache, type FaceClusterCache, type FaceStepResult } from './pipelineOrchestrator';
import { logger } from './logger';
import { getDbForLibraryPath } from './db';
import { deletePhotos } from './libraryRepository';

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
  try {
    return await sharp(filePath, { failOn: 'none' })
      .rotate()
      .resize(maxDimension, maxDimension, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toBuffer();
  } catch (err) {
    console.warn(`sharp thumbnail generation failed for ${filePath}:`, err);
  }

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
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, 'utf-8');
      const map = JSON.parse(raw);
      if (map && typeof map === 'object') {
        Object.assign(result, map);
      }
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
            const cp: StorageSyncCheckpoint = JSON.parse(fs.readFileSync(cpFile, 'utf-8'));
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
    fs.writeFileSync(localCpPath, JSON.stringify(checkpoint, null, 2), 'utf-8');

    const globalPath = getGlobalCheckpointsPath();
    let currentMap: Record<string, StorageSyncCheckpoint> = {};
    if (fs.existsSync(globalPath)) {
      try {
        currentMap = JSON.parse(fs.readFileSync(globalPath, 'utf-8'));
      } catch {}
    }
    currentMap[checkpoint.storageName] = checkpoint;
    fs.writeFileSync(globalPath, JSON.stringify(currentMap, null, 2), 'utf-8');
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

export function getStorageDetails(storageName: string, mirrorRoot?: string): StorageDetails {
  const root = mirrorRoot || getDefaultMirrorRoot();
  const mirrorFolder = path.join(root, storageName);

  let totalPhotos = 0;
  let thumbnailCachedCount = 0;
  let faceScannedCount = 0;
  let facesDetectedCount = 0;

  if (fs.existsSync(mirrorFolder)) {
    function scan(dir: string, depth = 0) {
      if (depth > 6) return;
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory() && !entry.name.startsWith('.')) {
            scan(full, depth + 1);
          } else if (
            entry.isFile() &&
            entry.name.endsWith('.json') &&
            !isMirrorHousekeepingFile(entry.name)
          ) {
            // Excludes the two known housekeeping files that live alongside
            // photo sidecars in the mirror folder — without this, they'd get
            // counted as an extra "photo" that never gets a thumbnail/face-
            // scan match, permanently capping progress just under 100% (e.g.
            // 21/22) even once every real photo is done.
            totalPhotos++;
            try {
              const meta: VirtualPhotoMetadata = JSON.parse(fs.readFileSync(full, 'utf-8'));
              if (meta.thumbnailPath && fs.existsSync(meta.thumbnailPath)) {
                thumbnailCachedCount++;
              }
              // Face-detection results are never written back to this sidecar
              // JSON (only to the SQLite catalog — see getFaceStatsForLibrary
              // below), so meta.faces/faceScanCompleted here would always
              // read as empty. Thumbnail caching is the only thing this
              // sidecar scan can answer accurately.
            } catch {}
          }
        }
      } catch {}
    }
    scan(mirrorFolder);
  }

  // The live scan above is ground truth (it's counting sidecar files that
  // physically exist right now). Only fall back to the persisted
  // checkpoint/library-status estimates when the live scan found nothing at
  // all — e.g. a sync is actively in progress and hasn't written any sidecars
  // yet. Previously this took whichever number was *larger*, which meant a
  // stale or inflated persisted total (e.g. left over from an earlier,
  // larger version of the source folder, or a past double-counting bug)
  // would permanently win over the real, current, accurate count.
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

  // Face-detection results live only in this storage's own SQLite catalog
  // (photos.face_scan_completed / the faces table) — never in the sidecar
  // JSON files scanned above — so that's the only accurate source for these
  // two counts, regardless of which sidecar-based numbers were used for
  // totalPhotos/thumbnailCachedCount just above.
  if (totalPhotos > 0) {
    const faceStats = getFaceStatsForLibrary(mirrorFolder);
    // Capped to totalPhotos: the catalog can briefly disagree in count with
    // the sidecar scan (e.g. right after a source folder shrinks, before a
    // fresh sync has pruned the stale catalog rows) — never let that make
    // faceScannedCount exceed the total it's a fraction of.
    faceScannedCount = Math.min(faceStats.faceScannedCount, totalPhotos);
    facesDetectedCount = faceStats.facesDetectedCount;
  }

  let phase: 'completed' | 'thumbnails' | 'faces' | 'interrupted' | 'idle' = 'idle';
  if (totalPhotos > 0) {
    if (thumbnailCachedCount >= totalPhotos && faceScannedCount >= totalPhotos) {
      phase = 'completed';
    } else if (cp?.phase === 'interrupted' || (thumbnailCachedCount > 0 && thumbnailCachedCount < totalPhotos && cp?.phase !== 'completed')) {
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
  const mirrorFolder = path.join(root, storageName);

  let totalPhotos = 0;
  let thumbnailCachedCount = 0;
  let faceScannedCount = 0;
  let facesDetectedCount = 0;

  const cp = loadStorageCheckpoint(storageName, root);
  if (cp) {
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
    faceScannedCount = Math.min(faceStats.faceScannedCount, totalPhotos);
    facesDetectedCount = faceStats.facesDetectedCount;
  }

  return computeStorageDetails(storageName, totalPhotos, thumbnailCachedCount, faceScannedCount, facesDetectedCount, cp?.phase);
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

const PHYSICAL_SCAN_YIELD_EVERY_FILES = 200;

/**
 * The actual ground-truth sidecar walk (identical logic to getStorageDetails'
 * live scan), as an async generator that yields to the event loop
 * periodically instead of running as one uninterrupted synchronous call —
 * for a mirror with many thousands of synced photos, the plain synchronous
 * version can block the main process for a very long time. Meant to be run
 * ONCE per storage screen load, as a background confirmation pass over
 * whatever getAllStorageDetailsFast already showed instantly from the
 * checkpoint — never on a tight poll (see confirmAllStorageDetailsPhysical).
 */
export async function scanStorageDetailsPhysical(storageName: string, mirrorRoot?: string): Promise<StorageDetails> {
  const root = mirrorRoot || getDefaultMirrorRoot();
  const mirrorFolder = path.join(root, storageName);

  let totalPhotos = 0;
  let thumbnailCachedCount = 0;

  if (fs.existsSync(mirrorFolder)) {
    let sinceYield = 0;
    const scan = async (dir: string, depth = 0): Promise<void> => {
      if (depth > 6) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          await scan(full, depth + 1);
        } else if (
          entry.isFile() &&
          entry.name.endsWith('.json') &&
          !isMirrorHousekeepingFile(entry.name)
        ) {
          totalPhotos++;
          try {
            const meta: VirtualPhotoMetadata = JSON.parse(fs.readFileSync(full, 'utf-8'));
            if (meta.thumbnailPath && fs.existsSync(meta.thumbnailPath)) {
              thumbnailCachedCount++;
            }
          } catch {}
          sinceYield++;
          if (sinceYield >= PHYSICAL_SCAN_YIELD_EVERY_FILES) {
            sinceYield = 0;
            await new Promise((resolve) => setImmediate(resolve));
          }
        }
      }
    };
    await scan(mirrorFolder);
  }

  const cp = loadStorageCheckpoint(storageName, root);
  if (totalPhotos === 0 && cp) {
    totalPhotos = cp.totalDiscovered;
    thumbnailCachedCount = cp.processedCount;
  }

  const libStatus = libraryStatusService.getLibraryStatus(mirrorFolder);
  let faceScannedCount = 0;
  let facesDetectedCount = 0;
  if (totalPhotos === 0 && libStatus) {
    totalPhotos = libStatus.totalPhotos;
    thumbnailCachedCount = libStatus.thumbnailCachedCount;
    faceScannedCount = libStatus.faceScannedCount;
    facesDetectedCount = libStatus.faceDetectedCount;
  }

  if (totalPhotos > 0) {
    const faceStats = getFaceStatsForLibrary(mirrorFolder);
    faceScannedCount = Math.min(faceStats.faceScannedCount, totalPhotos);
    facesDetectedCount = faceStats.facesDetectedCount;
  }

  return computeStorageDetails(storageName, totalPhotos, thumbnailCachedCount, faceScannedCount, facesDetectedCount, cp?.phase);
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
  if (!fs.existsSync(root)) return result;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (err) {
    console.warn('[StorageSync] Failed to list storages for physical confirmation:', err);
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
  if (!fs.existsSync(targetLocalDir)) {
    fs.mkdirSync(targetLocalDir, { recursive: true });
  }

  const localThumbPath = path.join(targetLocalDir, fileName);
  const baseName = path.basename(fileName, path.extname(fileName));
  const localMetaPath = path.join(targetLocalDir, `${baseName}.json`);

  try {
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
            fs.writeFileSync(localMetaPath, JSON.stringify(existingSidecar, null, 2), 'utf-8');
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
    fs.writeFileSync(localThumbPath, thumbBuffer);

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
    fs.writeFileSync(localMetaPath, JSON.stringify(sidecar, null, 2), 'utf-8');

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
  if (!fs.existsSync(storageMirrorRoot)) {
    fs.mkdirSync(storageMirrorRoot, { recursive: true });
  }
  return processOneMirrorFile(remoteFile, config, storageMirrorRoot);
}

export async function syncVirtualStorage(
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
  let totalSynced = 0;
  let newlyAdded = 0;
  let totalOriginalSize = 0;
  let totalThumbnailSize = 0;

  const storageMirrorRoot = path.join(config.localMirrorRoot, config.name);
  if (!fs.existsSync(storageMirrorRoot)) {
    fs.mkdirSync(storageMirrorRoot, { recursive: true });
  }

  logger.info('Sync', `Checking library ${config.name} — scanning ${config.networkSourcePath}`);
  const remoteFiles = await scanDirectoryRecursive(config.networkSourcePath);
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
        const alreadyDone: string[] = [];
        const needsWork: string[] = [];
        for (const remoteFile of remoteFiles) {
          const fileName = path.basename(remoteFile);
          const relFromRoot = path.relative(config.networkSourcePath, remoteFile);
          const localThumbPath = path.join(storageMirrorRoot, path.dirname(relFromRoot), fileName);
          const photoId = photoIdForSidecar(localThumbPath);
          (doneIds.has(photoId) ? alreadyDone : needsWork).push(remoteFile);
        }
        remoteFiles.length = 0;
        remoteFiles.push(...alreadyDone, ...needsWork);
        logger.info(
          'Sync',
          `Prioritizing ${alreadyDone.length} already-scanned photo(s) for quick re-verification before ${needsWork.length} still needing face detection.`
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

  // Distinct from skippedCount/newlyAdded (thumbnail step outcomes) — a
  // thumbnail being skipped says nothing about whether THIS photo's face
  // scan is actually done, and the two were previously conflated into one
  // "unchanged (skipped)" label that claimed nothing was happening even
  // while real, multi-second face detection was actively running.
  let facesAlreadyDoneCount = 0;
  let facesDetectedThisRunCount = 0;
  let facesDeferredCount = 0; // offline/locked/error — genuinely not attempted

  for (let i = startIndex; i < total; i++) {
    const remoteFile = remoteFiles[i];
    const fileName = path.basename(remoteFile);

    const percent = Math.round(((i + 1) / Math.max(1, total)) * 100);
    const fileStartTime = Date.now();

    const result = await processOneMirrorFile(remoteFile, config, storageMirrorRoot);
    let bytesReadForBandwidth = result.bytesRead;
    let faceResult: FaceStepResult | null = null;

    if (result.success) {
      totalOriginalSize += result.originalSize;
      totalThumbnailSize += result.thumbnailSize;
      totalSynced++;
      if (!result.skipped) {
        newlyAdded++;
        logger.info('Sync', `Background scan — Photo ${i + 1}/${total}: ${fileName}`);
        logger.info('Sync', `  caching thumbnail ..... ${Math.round(result.thumbnailSize / 1024)}kb done`);
      } else {
        skippedCount++;
      }

      if (runFaceDetection && result.sidecar) {
        try {
          faceResult = await runFaceDetectionStep(remoteFile, result.sidecar, config, faceCache);
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
        } catch (faceErr) {
          console.error(`Face detection step failed for ${remoteFile}:`, faceErr);
          errors.push(`Face detection failed for ${fileName}: ${String(faceErr)}`);
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
          facesCompletedCount: facesAlreadyDoneCount + facesDetectedThisRunCount,
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
      console.error(msg);
      errors.push(msg);
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

    // Bandwidth cap: enforce a minimum wall-clock time for this file based on
    // its size, so a fast local/cached read doesn't burst past the configured
    // rate. A read that was already slower than the target (a genuinely slow
    // network) needs no extra sleep — this only pumps the brakes when we're
    // running faster than the user's configured cap.
    if (config.bandwidthLimitMbps && config.bandwidthLimitMbps > 0 && bytesReadForBandwidth > 0) {
      const bytesPerSecondLimit = (config.bandwidthLimitMbps * 1_000_000) / 8;
      const targetMs = (bytesReadForBandwidth / bytesPerSecondLimit) * 1000;
      const elapsedMs = Date.now() - fileStartTime;
      const bandwidthSleepMs = targetMs - elapsedMs;
      if (bandwidthSleepMs > 0) {
        await new Promise((r) => setTimeout(r, bandwidthSleepMs));
      }
    }

    // Configurable delay between photos to prevent bandwidth saturation and
    // keep desktop 100% responsive — only meaningful when this file actually
    // did real network I/O (result.skipped means the incremental check found
    // it already up to date and touched nothing). Without this guard, a
    // periodic re-verification pass over an already-fully-synced storage —
    // every file skipped, zero bytes transferred — still paid the full
    // configured delay on every single one, turning a should-be-instant
    // "nothing changed" confirmation into minutes of pure waiting.
    const delayMs = !result.skipped && config.delayBetweenPhotosSec && config.delayBetweenPhotosSec > 0
      ? Math.round(config.delayBetweenPhotosSec * 1000)
      : 4;
    await new Promise((r) => setTimeout(r, delayMs));
  }

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
  const sourceReachableForPrune = await isPathReachable(config.networkSourcePath);
  if (!sourceReachableForPrune) {
    logger.warn('Sync', `Skipping delete-detection for ${config.name} — source folder was not reachable this pass.`);
  } else {
    try {
      const activeRemotePaths = new Set(remoteFiles.map((rf) => path.resolve(rf).toLowerCase()));
      const pruneDb = getDbForLibraryPath(storageMirrorRoot);
      let prunedCount = 0;
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
                  try { fs.unlinkSync(fullPath); } catch {}
                  if (meta.thumbnailPath) {
                    try {
                      deletePhotos([photoIdForSidecar(meta.thumbnailPath)], pruneDb);
                    } catch (dbErr) {
                      console.warn(`Failed to remove catalog row for deleted photo ${meta.originalFilePath}:`, dbErr);
                    }
                    if (fs.existsSync(meta.thumbnailPath)) {
                      try { fs.unlinkSync(meta.thumbnailPath); } catch {}
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
            if (row.file_path && fs.existsSync(row.file_path)) fs.unlinkSync(row.file_path);
            const sidecarPath = row.file_path
              ? path.join(path.dirname(row.file_path), `${path.basename(row.file_path, path.extname(row.file_path))}.json`)
              : null;
            if (sidecarPath && fs.existsSync(sidecarPath)) fs.unlinkSync(sidecarPath);
          } catch {}
        }
      }
      if (staleIds.length > 0) {
        deletePhotos(staleIds, pruneDb);
        prunedCount += staleIds.length;
      }

      if (prunedCount > 0) {
        logger.info('Sync', `Library ${config.name} — removed ${prunedCount} photo(s) no longer present in the source folder.`);
      }
    } catch (pruneErr) {
      console.warn('Failed to prune mirror orphans:', pruneErr);
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
  };
}

// How many sidecar JSON files to process before yielding to the event loop —
// see the doc comment on scanVirtualMirrorDirectory below for why this
// exists at all. 50 keeps the gap between yields well under what it takes
// for Windows to mark the window "Not Responding" (~5s), even on a slow
// disk, while still batching enough work per tick to stay fast overall.
const MIRROR_SCAN_YIELD_EVERY = 50;

/**
 * Walks a virtual mirror's sidecar JSON files into Photo records. Runs on
 * the main process's single thread with node:fs's *synchronous* calls
 * (readdirSync/readFileSync) — deliberately not converted to fs.promises,
 * since the cost here isn't that any one file read is slow, it's that a
 * library with thousands of files used to run this whole recursive walk as
 * ONE uninterrupted synchronous block with no opportunity for anything else
 * (an IPC reply, a window redraw, the tray) to happen in between. Confirmed
 * against real logs: ~55s of continuous blocking for a 3,106-photo library
 * during the periodic background sync cycle — long past the point Windows
 * reports the whole app as "Not Responding". Yielding every
 * MIRROR_SCAN_YIELD_EVERY files (same pattern already used by
 * getAllPhotosForSummary in catalogService.ts) breaks that up into many
 * short blocking bursts with real gaps in between, so the process stays
 * responsive throughout — at the cost of the scan itself taking slightly
 * longer in wall-clock time, which is the right tradeoff for a background
 * operation the user isn't directly waiting on.
 */
export async function scanVirtualMirrorDirectory(mirrorDirPath: string): Promise<Photo[]> {
  const startedAt = Date.now();
  const photos: Photo[] = [];
  if (!fs.existsSync(mirrorDirPath)) return photos;

  let sinceYield = 0;
  const maybeYield = async () => {
    sinceYield++;
    if (sinceYield >= MIRROR_SCAN_YIELD_EVERY) {
      sinceYield = 0;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  };

  async function scan(current: string): Promise<void> {
    try {
      const entries = fs.readdirSync(current, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (!entry.name.startsWith('.')) {
            await scan(fullPath);
          }
        } else if (entry.isFile() && entry.name.endsWith('.json')) {
          try {
            const raw = fs.readFileSync(fullPath, 'utf-8');
            const meta: VirtualPhotoMetadata = JSON.parse(raw);

            // Confirm corresponding local thumbnail exists
            if (fs.existsSync(meta.thumbnailPath)) {
              const date = new Date(meta.dateTaken);

              const faces = (meta.faces && meta.faces.length > 0) ? meta.faces : undefined;
              const faceScanCompleted = Boolean(meta.faceScanCompleted || (faces && faces.length > 0));

              const photo: Photo = {
                id: Buffer.from(meta.thumbnailPath).toString('base64'),
                filePath: meta.thumbnailPath,
                fileName: meta.fileName,
                fileSize: meta.originalFileSize,
                fileDate: meta.dateTaken,
                dateTaken: meta.dateTaken,
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

              photos.push(photo);
            }
          } catch (jsonErr) {
            console.warn(`Failed to parse sidecar JSON ${fullPath}:`, jsonErr);
          }
          await maybeYield();
        }
      }
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
          fs.writeFileSync(summaryFile, JSON.stringify(config, null, 2), 'utf-8');
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
  if (!folderPath || !fs.existsSync(folderPath)) return photos;

  try {
    const entries = fs.readdirSync(folderPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && isImageFile(entry.name)) {
        const fullPath = path.join(folderPath, entry.name);
        try {
          const stat = fs.statSync(fullPath);
          const meta = await parsePhotoMetadata(fullPath);

          const dateTaken = meta.dateTaken || (stat.mtime ? stat.mtime.toISOString() : new Date().toISOString());
          const d = new Date(dateTaken);
          const safeDate = isNaN(d.getTime()) ? new Date() : d;

          photos.push({
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
          });
        } catch {
          // Skip unreadable individual photo
        }
      }
    }
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
        fs.writeFileSync(thumbTarget, outputBuffer);

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
            const { saveHeicSavedRotation } = require('./heicRotationStore');
            totalRotation = saveHeicSavedRotation(thumbTarget, options.rotationDegrees);
            if (targetPath && targetPath !== thumbTarget) {
              saveHeicSavedRotation(targetPath, options.rotationDegrees);
            }
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
      // Safe Overwrite: Create .bak backup file
      try {
        const bakPath = `${targetPath}.bak`;
        if (!fs.existsSync(bakPath)) {
          fs.copyFileSync(targetPath, bakPath);
        }
      } catch {
        // Ignore backup failure
      }
    }

    fs.writeFileSync(finalSavePath, outputBuffer);

    // Also update mirror thumbnail if provided
    if (options.mirrorThumbnailPath && fs.existsSync(options.mirrorThumbnailPath)) {
      try {
        const thumbBuf = await generateThumbnailBuffer(finalSavePath, 500);
        if (thumbBuf) {
          fs.writeFileSync(options.mirrorThumbnailPath, thumbBuf);
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
          fs.unlinkSync(jsonSidecar);
        } catch {}
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
export async function rotatePhotoFile(
  filePath: string,
  rotationDegrees: number,
  secondaryPath?: string
): Promise<{ success: boolean; newPath?: string; error?: string; delegatedToCacheRotation?: boolean }> {
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
    const inputBuf = fs.readFileSync(filePath);
    const isJpegBuffer = inputBuf.length > 2 && inputBuf[0] === 0xff && inputBuf[1] === 0xd8;
    const isWebpBuffer = inputBuf.length > 12 && inputBuf.slice(0, 4).toString() === 'RIFF';

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

    // Create .bak backup if it doesn't already exist
    const bakPath = `${filePath}.bak`;
    if (!fs.existsSync(bakPath)) {
      try {
        fs.copyFileSync(filePath, bakPath);
      } catch {}
    }

    let outputBuffer: Buffer | null = null;
    let sharpLib: any = null;
    try {
      sharpLib = require('sharp');
    } catch {}

    let prevMtime: number | undefined;
    try {
      prevMtime = fs.statSync(filePath).mtimeMs;
    } catch {}

    if (sharpLib) {
      outputBuffer = await sharpLib(inputBuf)
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

    fs.writeFileSync(filePath, outputBuffer);

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
  if (!fs.existsSync(p)) return [];
  try {
    const raw = fs.readFileSync(p, 'utf-8');
    return JSON.parse(raw) || [];
  } catch {
    return [];
  }
}

export function savePendingRotations(items: PendingRotationItem[]): void {
  const p = getPendingRotationsPath();
  try {
    fs.writeFileSync(p, JSON.stringify(items, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[OfflineRotationSync] Failed to save pending rotations:', err);
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
      if (localFilePath) items[existingIdx].localFilePath = localFilePath;
    }
  } else {
    items.push({
      id: Buffer.from(originalRemotePath).toString('base64').replace(/[/+=]/g, '_'),
      originalRemotePath,
      localFilePath,
      rotationDegrees: degrees,
      timestamp: Date.now(),
    });
  }

  savePendingRotations(items);
}

export async function processPendingRotations(): Promise<{ processed: number; remaining: number }> {
  const items = getPendingRotations();
  if (items.length === 0) return { processed: 0, remaining: 0 };

  const remaining: PendingRotationItem[] = [];
  let processed = 0;

  for (const item of items) {
    try {
      if (await isPathReachable(item.originalRemotePath)) {
        console.log(`[OfflineRotationSync] Applying pending rotation (${item.rotationDegrees}°) to reconnected source: ${item.originalRemotePath}`);
        const res = await rotatePhotoFile(item.originalRemotePath, item.rotationDegrees);
        if (res.success) {
          processed++;
          continue; // successfully processed and drained
        }
      }
    } catch (err) {
      console.warn(`[OfflineRotationSync] Error applying rotation to ${item.originalRemotePath}:`, err);
    }
    remaining.push(item);
  }

  if (processed > 0) {
    savePendingRotations(remaining);
  }

  return { processed, remaining: remaining.length };
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
      const hasSidecar = !!sidecarJson && fs.existsSync(sidecarJson);

      let totalRot = degrees;

      if (isMirrorThumbnail && localFilePath && fs.existsSync(localFilePath)) {
        // Physically rotate the real JPEG bytes on disk (also purges
        // derived thumbnail-cache tiers so they regenerate with the new
        // orientation). "Mirror thumbnail" here is a path-based guess — the
        // local file is sometimes actually genuine raw HEIC bytes copied
        // as-is (e.g. HEIC decoding failed during sync), in which case
        // rotatePhotoFile detects that by sniffing the bytes and delegates
        // to rotateCachedHeicThumbnail itself, passing the remote path
        // through so both paths' flags get recorded in one place.
        const rotateResult = await rotatePhotoFile(localFilePath, degrees, originalRemotePath);

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
            const { saveHeicSavedRotation } = require('./heicRotationStore');
            totalRot = saveHeicSavedRotation(localFilePath, degrees);
            if (originalRemotePath && originalRemotePath !== localFilePath) {
              saveHeicSavedRotation(originalRemotePath, degrees);
            }
          } catch (err) {
            console.warn('[rotatePhotoWithOfflineQueue] Failed persisting mirror rotation flag:', err);
          }
        } else {
          // rotatePhotoFile already recorded the accumulated rotation
          // (under both paths) via rotateCachedHeicThumbnail — read it back
          // rather than writing the delta again, which would double-count it.
          try {
            const { getHeicSavedRotation } = require('./heicRotationStore');
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
          const meta = JSON.parse(fs.readFileSync(sidecarJson, 'utf-8'));
          if (degrees === 90 || degrees === 270) {
            const oldW = meta.width;
            meta.width = meta.height;
            meta.height = oldW;
          }
          meta.rotation = (((meta.rotation || 0) + degrees) % 360 + 360) % 360;
          meta.isHeicRotated = meta.rotation !== 0;
          meta.heicRotation = meta.rotation;
          if (isMirrorThumbnail) totalRot = meta.rotation;
          fs.writeFileSync(sidecarJson, JSON.stringify(meta, null, 2), 'utf-8');
        } catch {}
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
          ? 'Rotated local mirror thumbnail on disk.'
          : 'Rotated and cached local thumbnail for HEIC image.',
      };
    }

    // 1. Rotate local thumbnail on disk immediately
    if (localFilePath && fs.existsSync(localFilePath)) {
      await rotatePhotoFile(localFilePath, degrees);

      // Update sidecar metadata JSON if present
      const sidecarJson = localFilePath.replace(/\.[^/.]+$/, '.json');
      if (fs.existsSync(sidecarJson)) {
        try {
          const meta = JSON.parse(fs.readFileSync(sidecarJson, 'utf-8'));
          if (degrees === 90 || degrees === 270) {
            const oldW = meta.width;
            meta.width = meta.height;
            meta.height = oldW;
          }
          fs.writeFileSync(sidecarJson, JSON.stringify(meta, null, 2), 'utf-8');
        } catch {}
      }
    }

    // 2. Check source file — isPathReachable (not fs.existsSync) so a dead
    // network share can't block this for its full OS-level timeout.
    const remoteTarget = originalRemotePath || localFilePath;
    const isRemoteOnline = remoteTarget && (await isPathReachable(remoteTarget));

    if (isRemoteOnline) {
      // Source file is online: rotate remote file now
      if (remoteTarget !== localFilePath) {
        await rotatePhotoFile(remoteTarget, degrees);
      }
      return { success: true, isQueued: false, newPath: remoteTarget };
    } else {
      // Source file is offline: enqueue for background sync
      enqueuePendingRotation(remoteTarget, degrees, localFilePath);
      return {
        success: true,
        isQueued: true,
        newPath: localFilePath,
        message: 'Source file is currently offline. Rotation applied locally and queued to sync when storage reconnects.',
      };
    }
  } catch (err: any) {
    return { success: false, isQueued: false, error: err.message };
  }
}


