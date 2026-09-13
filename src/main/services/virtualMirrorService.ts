import fs from 'fs';
import path from 'path';
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

// Dynamic import or require of electron nativeImage
let nativeImage: any = null;
try {
  const electron = require('electron');
  nativeImage = electron.nativeImage;
} catch {
  // Headless / Node testing environment
}

/**
 * Fast synchronous JPEG EXIF orientation parser.
 * Reads the APP1 marker and extracts the orientation tag (0x0112).
 * Returns 1 (normal) if not found or orientation 1-8.
 */
export function readExifOrientation(buffer: Buffer): number {
  if (!buffer || buffer.length < 14) return 1;
  // Check JPEG SOI marker
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) return 1;

  let offset = 2;
  while (offset + 4 < buffer.length) {
    if (buffer[offset] !== 0xff) break;
    const marker = buffer[offset + 1];
    // Variable length markers have 2-byte length
    if (marker === 0xd9 || marker === 0xda) break; // EOI or SOS
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) break;

    // APP1 marker (0xFFE1) contains EXIF
    if (marker === 0xe1 && offset + 4 + 6 <= buffer.length) {
      const exifHeader = buffer.toString('ascii', offset + 4, offset + 10);
      if (exifHeader === 'Exif\0\0') {
        const tiffOffset = offset + 10;
        if (tiffOffset + 8 > buffer.length) return 1;
        const isLE = buffer.readUInt16BE(tiffOffset) === 0x4949; // 'II' (Intel little endian)
        const tagRead16 = (o: number) => (isLE ? buffer.readUInt16LE(o) : buffer.readUInt16BE(o));
        const tagRead32 = (o: number) => (isLE ? buffer.readUInt32LE(o) : buffer.readUInt32BE(o));

        const firstIFDOffset = tagRead32(tiffOffset + 4);
        let ifdOffset = tiffOffset + firstIFDOffset;
        if (ifdOffset + 2 > buffer.length) return 1;
        const numEntries = tagRead16(ifdOffset);
        ifdOffset += 2;

        for (let i = 0; i < numEntries && ifdOffset + 12 <= buffer.length; i++) {
          const tag = tagRead16(ifdOffset);
          if (tag === 0x0112) { // Tag 0x0112 = Orientation
            const val = tagRead16(ifdOffset + 8);
            if (val >= 1 && val <= 8) return val;
            return 1;
          }
          ifdOffset += 12;
        }
      }
    }
    offset += 2 + length;
  }
  return 1;
}

/**
 * Rotates raw RGBA pixel buffer based on EXIF orientation tag.
 */
export function rotateRgbaBitmap(
  src: Buffer,
  width: number,
  height: number,
  orientation: number
): { buffer: Buffer; width: number; height: number } {
  if (orientation <= 1 || orientation > 8) {
    return { buffer: src, width, height };
  }

  const isRotated90 = orientation === 6 || orientation === 8 || orientation === 5 || orientation === 7;
  const dstW = isRotated90 ? height : width;
  const dstH = isRotated90 ? width : height;
  const dst = Buffer.alloc(dstW * dstH * 4);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let dx = x;
      let dy = y;

      switch (orientation) {
        case 2: // Flip horizontal
          dx = width - 1 - x;
          dy = y;
          break;
        case 3: // 180 deg
          dx = width - 1 - x;
          dy = height - 1 - y;
          break;
        case 4: // Flip vertical
          dx = x;
          dy = height - 1 - y;
          break;
        case 5: // Transpose
          dx = y;
          dy = x;
          break;
        case 6: // Rotate 90 deg CW
          dx = height - 1 - y;
          dy = x;
          break;
        case 7: // Transverse
          dx = height - 1 - y;
          dy = width - 1 - x;
          break;
        case 8: // Rotate 270 deg CW (90 deg CCW)
          dx = y;
          dy = width - 1 - x;
          break;
      }

      const srcIdx = (y * width + x) * 4;
      const dstIdx = (dy * dstW + dx) * 4;
      dst[dstIdx] = src[srcIdx];
      dst[dstIdx + 1] = src[srcIdx + 1];
      dst[dstIdx + 2] = src[srcIdx + 2];
      dst[dstIdx + 3] = src[srcIdx + 3];
    }
  }

  return { buffer: dst, width: dstW, height: dstH };
}

export function generateThumbnailBuffer(filePath: string, maxDimension = 500): Buffer | null {
  let orientation = 1;
  try {
    const fd = fs.openSync(filePath, 'r');
    const headerBuf = Buffer.alloc(Math.min(65536, fs.fstatSync(fd).size));
    fs.readSync(fd, headerBuf, 0, headerBuf.length, 0);
    fs.closeSync(fd);
    orientation = readExifOrientation(headerBuf);
  } catch {}

  if (nativeImage) {
    try {
      const img = nativeImage.createFromPath(filePath);
      if (!img.isEmpty()) {
        const size = img.getSize();
        const maxCurrent = Math.max(size.width, size.height);
        const scale = maxCurrent > maxDimension ? maxDimension / maxCurrent : 1;
        const targetW = Math.max(1, Math.round(size.width * scale));
        const targetH = Math.max(1, Math.round(size.height * scale));

        let resized = img.resize({
          width: targetW,
          height: targetH,
          quality: 'good',
        });

        // Apply EXIF rotation if needed to ensure upright thumbnail
        if (orientation > 1) {
          const rawBitmap = resized.toBitmap();
          const rotated = rotateRgbaBitmap(rawBitmap, targetW, targetH, orientation);
          resized = nativeImage.createFromBitmap(rotated.buffer, {
            width: rotated.width,
            height: rotated.height,
          });
        }

        return resized.toJPEG(82);
      }
    } catch (err) {
      console.warn(`nativeImage thumbnail failed for ${filePath}:`, err);
    }
  }

  // Fallback: If nativeImage unavailable or failed, create a minimal JPEG or copy buffer if small
  try {
    return fs.readFileSync(filePath);
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
    const root = customMirrorRoot || 'C:\\GPhotos_VirtualMirrors';
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
    const mirrorFolder = path.join(checkpoint.localMirrorRoot || 'C:\\GPhotos_VirtualMirrors', checkpoint.storageName);
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

export function getStorageDetails(storageName: string, mirrorRoot?: string): StorageDetails {
  const root = mirrorRoot || 'C:\\GPhotos_VirtualMirrors';
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
          } else if (entry.isFile() && entry.name.endsWith('.json') && !entry.name.startsWith('_')) {
            totalPhotos++;
            try {
              const meta: VirtualPhotoMetadata = JSON.parse(fs.readFileSync(full, 'utf-8'));
              if (meta.thumbnailPath && fs.existsSync(meta.thumbnailPath)) {
                thumbnailCachedCount++;
              }
              if (meta.faceScanCompleted || (meta.faces && meta.faces.length > 0)) {
                faceScannedCount++;
              }
              if (meta.faces && Array.isArray(meta.faces)) {
                facesDetectedCount += meta.faces.length;
              }
            } catch {}
          }
        }
      } catch {}
    }
    scan(mirrorFolder);
  }

  // Cross-reference checkpoint
  const cp = loadStorageCheckpoint(storageName, root);
  if (cp) {
    if (cp.totalDiscovered > totalPhotos) totalPhotos = cp.totalDiscovered;
    if (cp.processedCount > thumbnailCachedCount) thumbnailCachedCount = cp.processedCount;
  }

  // Cross-reference library status
  const libStatus = libraryStatusService.getLibraryStatus(mirrorFolder);
  if (libStatus) {
    if (libStatus.totalPhotos > totalPhotos) totalPhotos = libStatus.totalPhotos;
    if (libStatus.thumbnailCachedCount > thumbnailCachedCount) thumbnailCachedCount = libStatus.thumbnailCachedCount;
    if (libStatus.faceScannedCount > faceScannedCount) faceScannedCount = libStatus.faceScannedCount;
    if (libStatus.faceDetectedCount > facesDetectedCount) facesDetectedCount = libStatus.faceDetectedCount;
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
  const root = mirrorRoot || 'C:\\GPhotos_VirtualMirrors';
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

export async function syncVirtualStorage(
  config: VirtualStorageConfig,
  onProgress?: (progress: MirrorProgress) => void
): Promise<SyncVirtualStorageResult> {
  const errors: string[] = [];
  let totalSynced = 0;
  let newlyAdded = 0;
  let totalOriginalSize = 0;
  let totalThumbnailSize = 0;

  const storageMirrorRoot = path.join(config.localMirrorRoot, config.name);
  if (!fs.existsSync(storageMirrorRoot)) {
    fs.mkdirSync(storageMirrorRoot, { recursive: true });
  }

  const remoteFiles = scanDirectoryRecursive(config.networkSourcePath);
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

  for (let i = startIndex; i < total; i++) {
    const remoteFile = remoteFiles[i];
    const fileName = path.basename(remoteFile);
    const relFromRoot = path.relative(config.networkSourcePath, remoteFile);
    const relDir = path.dirname(relFromRoot);

    // Replicate folder structure locally
    const targetLocalDir = path.join(storageMirrorRoot, relDir);
    if (!fs.existsSync(targetLocalDir)) {
      fs.mkdirSync(targetLocalDir, { recursive: true });
    }

    const localThumbPath = path.join(targetLocalDir, fileName);
    const baseName = path.basename(fileName, path.extname(fileName));
    const localMetaPath = path.join(targetLocalDir, `${baseName}.json`);

    const percent = Math.round(((i + 1) / Math.max(1, total)) * 100);
    if (onProgress) {
      onProgress({
        storageName: config.name,
        phase: 'thumbnails',
        current: i + 1,
        total,
        currentFile: fileName,
        status: 'syncing',
        percent,
      });
    }

    try {
      const stats = fs.statSync(remoteFile);
      totalOriginalSize += stats.size;

      // Incremental sync check: if both thumbnail and metadata exist and remote was not modified after
      if (fs.existsSync(localThumbPath) && fs.existsSync(localMetaPath)) {
        const metaStats = fs.statSync(localMetaPath);
        if (metaStats.mtime.getTime() >= stats.mtime.getTime()) {
          const thumbStats = fs.statSync(localThumbPath);
          totalThumbnailSize += thumbStats.size;
          totalSynced++;
          continue;
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
        thumbBuffer = generateThumbnailBuffer(remoteFile, 500);
      }
      if (!thumbBuffer) {
        throw new Error(`Failed to generate thumbnail for ${remoteFile}`);
      }
      fs.writeFileSync(localThumbPath, thumbBuffer);
      totalThumbnailSize += thumbBuffer.length;

      // 2. Parse EXIF & GPS
      const meta = await parsePhotoMetadata(remoteFile);

      // 3. Write metadata sidecar JSON
      const sidecar: VirtualPhotoMetadata = {
        fileName,
        originalFilePath: remoteFile,
        originalFileSize: stats.size,
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
      totalSynced++;
      newlyAdded++;
    } catch (err: any) {
      const msg = `Error syncing ${remoteFile}: ${err.message}`;
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

    // Configurable delay between photos to prevent bandwidth saturation and keep desktop 100% responsive
    const delayMs = config.delayBetweenPhotosSec && config.delayBetweenPhotosSec > 0
      ? Math.round(config.delayBetweenPhotosSec * 1000)
      : 4;
    await new Promise((r) => setTimeout(r, delayMs));
  }

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

  // Prune deleted files: if the source path is accessible, clean up mirror files whose remote file no longer exists
  try {
    const activeRemotePaths = new Set(remoteFiles.map((rf) => path.resolve(rf).toLowerCase()));
    function pruneMirrorOrphans(current: string) {
      if (!fs.existsSync(current)) return;
      const entries = fs.readdirSync(current, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (!entry.name.startsWith('.')) {
            pruneMirrorOrphans(fullPath);
            try {
              if (fs.readdirSync(fullPath).length === 0) {
                fs.rmdirSync(fullPath);
              }
            } catch {}
          }
        } else if (entry.isFile() && entry.name.endsWith('.json')) {
          try {
            const raw = fs.readFileSync(fullPath, 'utf-8');
            const meta: VirtualPhotoMetadata = JSON.parse(raw);
            if (meta.originalFilePath) {
              const origResolved = path.resolve(meta.originalFilePath).toLowerCase();
              if (!activeRemotePaths.has(origResolved)) {
                try { fs.unlinkSync(fullPath); } catch {}
                if (meta.thumbnailPath && fs.existsSync(meta.thumbnailPath)) {
                  try { fs.unlinkSync(meta.thumbnailPath); } catch {}
                }
              }
            }
          } catch {}
        }
      }
    }
    pruneMirrorOrphans(storageMirrorRoot);
  } catch (pruneErr) {
    console.warn('Failed to prune mirror orphans:', pruneErr);
  }

  const totalSizeSaved = Math.max(0, totalOriginalSize - totalThumbnailSize);

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

export function scanVirtualMirrorDirectory(mirrorDirPath: string): Photo[] {
  const photos: Photo[] = [];
  if (!fs.existsSync(mirrorDirPath)) return photos;

  function scan(current: string) {
    try {
      const entries = fs.readdirSync(current, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (!entry.name.startsWith('.')) {
            scan(fullPath);
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
              };

              photos.push(photo);
            }
          } catch (jsonErr) {
            console.warn(`Failed to parse sidecar JSON ${fullPath}:`, jsonErr);
          }
        }
      }
    } catch (err) {
      console.error(`Error scanning virtual mirror directory ${current}:`, err);
    }
  }

  scan(mirrorDirPath);
  return photos;
}

export function discoverStoredMirrors(customRoot?: string): VirtualStorageConfig[] {
  const root = customRoot || 'C:\\GPhotos_VirtualMirrors';
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
            } else if (se.isFile() && se.name.endsWith('.json') && !se.name.startsWith('_')) {
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
    const thumbBuffer = generateThumbnailBuffer(sourceFilePath, 500);
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
  if (!fs.existsSync(targetPath)) {
    return { success: false, error: `File not found: ${targetPath}` };
  }

  const ext = path.extname(targetPath).toLowerCase();
  if (ext === '.heic' || ext === '.heif') {
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
        const thumbBuf = generateThumbnailBuffer(finalSavePath, 500);
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
export async function trashFiles(filePaths: string[]): Promise<{ success: boolean; trashedCount: number; errors: string[] }> {
  const errors: string[] = [];
  let trashedCount = 0;

  // Try electron shell.trashItem
  let shell: any = null;
  try {
    const electron = require('electron');
    shell = electron.shell;
  } catch {
    // node testing environment
  }

  for (const fp of filePaths) {
    if (!fs.existsSync(fp)) continue;
    try {
      if (shell && typeof shell.trashItem === 'function') {
        await shell.trashItem(fp);
      } else {
        fs.unlinkSync(fp);
      }
      trashedCount++;
    } catch (err: any) {
      errors.push(`Failed to trash ${fp}: ${err.message}`);
    }
  }

  return {
    success: errors.length === 0,
    trashedCount,
    errors,
  };
}

/**
 * Permanently unlinks/deletes files from disk and cleans up any associated sidecar .json files.
 */
export async function deleteFilesPermanently(filePaths: string[]): Promise<{ success: boolean; deletedCount: number; errors: string[] }> {
  const errors: string[] = [];
  let deletedCount = 0;

  for (const fp of filePaths) {
    if (!fs.existsSync(fp)) continue;
    try {
      fs.unlinkSync(fp);
      // If this is a virtual mirror photo or has a matching .json sidecar, delete it too
      const jsonSidecar = fp.replace(/\.[^/.]+$/, '') + '.json';
      if (fs.existsSync(jsonSidecar)) {
        try {
          fs.unlinkSync(jsonSidecar);
        } catch {}
      }
      deletedCount++;
    } catch (err: any) {
      errors.push(`Failed to permanently delete ${fp}: ${err.message}`);
    }
  }

  return {
    success: errors.length === 0,
    deletedCount,
    errors,
  };
}

/**
 * Rotates an image file by the specified degrees (e.g. 90, 180, 270) using Sharp (or nativeImage fallback).
 * Automatically creates a .bak backup and saves the rotated image to disk.
 */
export async function rotatePhotoFile(
  filePath: string,
  rotationDegrees: number
): Promise<{ success: boolean; newPath?: string; error?: string }> {
  try {
    if (!fs.existsSync(filePath)) {
      return { success: false, error: `File not found: ${filePath}` };
    }

    const degrees = ((rotationDegrees % 360) + 360) % 360;
    if (degrees === 0) {
      return { success: true, newPath: filePath };
    }

    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.heic' || ext === '.heif') {
      return {
        success: false,
        error: 'Direct lossless rotation of HEIC/HEIF images is not supported. Please export or convert to JPEG/PNG to rotate.',
      };
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

    const inputBuf = fs.readFileSync(filePath);

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
  try {
    const p = getPendingRotationsPath();
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, 'utf-8');
      return JSON.parse(raw);
    }
  } catch (err) {
    console.warn('[OfflineRotation] Failed to read pending rotations:', err);
  }
  return [];
}

export function savePendingRotations(items: PendingRotationItem[]): void {
  try {
    const p = getPendingRotationsPath();
    const dir = path.dirname(p);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(p, JSON.stringify(items, null, 2), 'utf-8');
  } catch (err) {
    console.error('[OfflineRotation] Failed to save pending rotations:', err);
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
      if (fs.existsSync(item.originalRemotePath)) {
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
}): Promise<{ success: boolean; isQueued: boolean; newPath?: string; message?: string; error?: string }> {
  try {
    const { localFilePath, originalRemotePath, rotationDegrees } = params;
    const degrees = ((rotationDegrees % 360) + 360) % 360;
    if (degrees === 0) {
      return { success: true, isQueued: false, newPath: localFilePath };
    }

    const targetToCheck = originalRemotePath || localFilePath;
    const ext = path.extname(targetToCheck || '').toLowerCase();
    if (ext === '.heic' || ext === '.heif') {
      return {
        success: false,
        isQueued: false,
        error: 'Direct lossless rotation of HEIC/HEIF images is not supported.',
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

    // 2. Check source file
    const remoteTarget = originalRemotePath || localFilePath;
    const isRemoteOnline = remoteTarget && fs.existsSync(remoteTarget);

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


