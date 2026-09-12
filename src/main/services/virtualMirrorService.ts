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
  EditPhotoResult
} from '../../types';

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

  if (onProgress) {
    onProgress({
      storageName: config.name,
      phase: 'scanning',
      current: 0,
      total: 0,
      currentFile: 'Scanning network storage...',
      status: 'scanning',
      percent: 0,
    });
  }

  const remoteFiles = scanDirectoryRecursive(config.networkSourcePath);
  const total = remoteFiles.length;

  for (let i = 0; i < total; i++) {
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

    // Micro-yield to Node/Electron event loop every file so UI remains 100% responsive
    await new Promise((r) => setTimeout(r, 4));
  }

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
              // If source folder is mounted/online, verify the original file still exists
              if (meta.originalFilePath) {
                const parentDir = path.dirname(meta.originalFilePath);
                if (fs.existsSync(parentDir) && !fs.existsSync(meta.originalFilePath)) {
                  // File was deleted from the source folder - prune local mirror copy
                  try {
                    fs.unlinkSync(fullPath);
                    if (fs.existsSync(meta.thumbnailPath)) fs.unlinkSync(meta.thumbnailPath);
                  } catch {}
                  continue;
                }
              }

              const thumbStats = fs.statSync(meta.thumbnailPath);
              const date = new Date(meta.dateTaken);

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
      let totalPhotos = 0;
      let totalOriginalSize = 0;
      let totalThumbSize = 0;
      let detectedName = entry.name;
      let networkSourcePath = '';
      let latestMtime = 0;

      function scanDir(dir: string) {
        try {
          const subEntries = fs.readdirSync(dir, { withFileTypes: true });
          for (const se of subEntries) {
            const p = path.join(dir, se.name);
            if (se.isDirectory() && !se.name.startsWith('.')) {
              scanDir(p);
            } else if (se.isFile() && se.name.endsWith('.json')) {
              try {
                const stat = fs.statSync(p);
                if (stat.mtimeMs > latestMtime) latestMtime = stat.mtimeMs;
                const meta: VirtualPhotoMetadata = JSON.parse(fs.readFileSync(p, 'utf-8'));
                totalPhotos++;
                totalOriginalSize += (meta.originalFileSize || 0);
                if (meta.storageName) detectedName = meta.storageName;
                if (meta.storageRoot && !networkSourcePath) networkSourcePath = meta.storageRoot;

                if (meta.thumbnailPath && fs.existsSync(meta.thumbnailPath)) {
                  totalThumbSize += fs.statSync(meta.thumbnailPath).size;
                }
              } catch {
                // skip malformed json
              }
            }
          }
        } catch {
          // ignore
        }
      }

      scanDir(subDir);

      if (totalPhotos > 0) {
        storages.push({
          id: `storage_${entry.name}`,
          name: detectedName,
          networkSourcePath: networkSourcePath || subDir,
          localMirrorRoot: root,
          lastSynced: latestMtime > 0 ? new Date(latestMtime).toISOString() : new Date().toISOString(),
          totalItems: totalPhotos,
          totalSizeSaved: Math.max(0, totalOriginalSize - totalThumbSize),
        });
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

