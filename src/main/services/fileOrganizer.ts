import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { parsePhotoMetadata } from './exifParser';
import {
  FolderStructure,
  OrganizeOptions,
  DryRunItem,
  DryRunSummary,
  OrganizeProgress,
  Photo
} from '../../types';

const SUPPORTED_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.heic', '.heif', '.tiff', '.tif', '.dng', '.raw', '.cr2', '.nef'
]);

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

export function isImageFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return SUPPORTED_EXTENSIONS.has(ext);
}

const IGNORED_DIRECTORY_NAMES = new Set([
  'node_modules',
  '@eadir',
  'thumbnails',
  'thumbs',
  'thumb',
  '_thumbnails',
  '_thumbs',
  '.thumbnails',
  '.thumbs',
  '.gphotos',
  'gphotos_virtualmirrors',
  'virtualmirrors',
  'virtual_mirror',
  'virtual_mirrors',
  'temp_hq',
  'cache',
  '.cache',
  'preview',
  'previews',
  '.preview',
  '#recycle',
  '@recycle',
  '$recycle.bin',
  'system volume information',
  '.trashes',
  '.trash',
  'deriveddata',
  'previews.lrdata',
  'appdata',
  '.appdata',
]);

const RAW_OR_MASTER_EXTS = new Set([
  '.heic', '.heif', '.dng', '.raw', '.cr2', '.nef', '.tif', '.tiff'
]);

// How many directory entries to process before yielding back to the event
// loop. A synchronous walk over a large or network-mounted tree otherwise
// blocks the main process's message pump for its entire duration — the
// actual mechanism behind Electron windows going "Not Responding" — since
// nothing else (IPC replies, window painting, the hang-detector ping) can
// run until a JS callback returns control.
const SCAN_YIELD_EVERY_ENTRIES = 200;

/**
 * `scanInfo` (optional out-param) is set to `{ hadErrors: true }` when the
 * result may be incomplete — the root is missing, or any subfolder could not
 * be read. Callers that DELETE things based on "not in this list" (mirror
 * pruning) must not trust a scan that reports errors.
 */
export async function scanDirectoryRecursive(dirPath: string, scanInfo?: { hadErrors: boolean }): Promise<string[]> {
  const results: string[] = [];
  // Async access (not existsSync): a sync stat on a dead SMB share blocks the main thread.
  try {
    await fs.promises.access(dirPath, fs.constants.F_OK);
  } catch {
    if (scanInfo) scanInfo.hadErrors = true;
    return results;
  }

  let processedSinceYield = 0;
  const yieldToEventLoop = () => {
    processedSinceYield = 0;
    return new Promise<void>((resolve) => setImmediate(resolve));
  };

  async function scan(current: string) {
    try {
      const entries = await fs.promises.readdir(current, { withFileTypes: true });
      const dirImages: string[] = [];

      for (const entry of entries) {
        processedSinceYield++;
        if (processedSinceYield >= SCAN_YIELD_EVERY_ENTRIES) {
          await yieldToEventLoop();
        }

        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          const lowerName = entry.name.toLowerCase();
          // Skip hidden, system, NAS thumbnail, and cache folders
          if (!entry.name.startsWith('.') && !IGNORED_DIRECTORY_NAMES.has(lowerName)) {
            await scan(fullPath);
          }
        } else if (entry.isFile()) {
          // Skip hidden files, system stream files (Synology NAS), and thumbnail artifacts
          if (entry.name.startsWith('.') || entry.name.includes('@SynoEAStream')) continue;

          const lowerName = entry.name.toLowerCase();
          if (
            lowerName.startsWith('synophoto_thumb_') ||
            lowerName.includes('_thumb.') ||
            lowerName.includes('_thumb_') ||
            lowerName.endsWith('_500.jpg') ||
            lowerName.endsWith('_250.jpg') ||
            lowerName.endsWith('_500.webp') ||
            lowerName.endsWith('_250.webp')
          ) {
            continue;
          }

          if (isImageFile(fullPath)) {
            dirImages.push(fullPath);
          }
        }
      }

      // Deduplicate companion RAW/HEIC + JPEG pairs with the same base name in the same folder
      const baseMap = new Map<string, string[]>();
      for (const imgPath of dirImages) {
        const ext = path.extname(imgPath).toLowerCase();
        const base = path.basename(imgPath, ext).toLowerCase();
        if (!baseMap.has(base)) baseMap.set(base, []);
        baseMap.get(base)!.push(imgPath);
      }

      for (const [_, paths] of baseMap.entries()) {
        if (paths.length === 1) {
          results.push(paths[0]);
        } else {
          // Multiple companion files found (e.g. IMG_0001.HEIC and IMG_0001.JPG)
          // Prefer the master RAW/HEIC original file over the companion JPEG
          const master = paths.find((p) => RAW_OR_MASTER_EXTS.has(path.extname(p).toLowerCase()));
          results.push(master || paths[0]);
        }
      }
    } catch (err) {
      console.error(`Error scanning ${current}:`, err);
      if (scanInfo) scanInfo.hadErrors = true;
    }
  }

  await scan(dirPath);
  return results;
}

export async function scanPhotoDirectory(dirPath: string): Promise<Photo[]> {
  const filePaths = await scanDirectoryRecursive(dirPath);
  const photos: Photo[] = [];

  for (const filePath of filePaths) {
    try {
      const stats = await fs.promises.stat(filePath);
      const meta = await parsePhotoMetadata(filePath);
      const date = new Date(meta.dateTaken);

      const photo: Photo = {
        id: Buffer.from(filePath).toString('base64'),
        filePath,
        fileName: path.basename(filePath),
        fileSize: stats.size,
        fileDate: stats.mtime.toISOString(),
        dateTaken: date.toISOString(),
        year: date.getFullYear(),
        month: date.getMonth() + 1,
        day: date.getDate(),
        width: meta.width,
        height: meta.height,
        exif: meta.exif,
        location: meta.location,
        isFavorite: false,
      };

      photos.push(photo);
    } catch (err) {
      console.error(`Failed to scan photo ${filePath}:`, err);
    }
  }

  return photos;
}

/** Streaming SHA-256 — never holds a whole (possibly 100MB+ RAW) file in memory or blocks the main thread. */
export function computeFileHash(filePath: string): Promise<string> {
  return new Promise((resolve) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', () => resolve(''));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export function formatTargetDirectory(targetBase: string, date: Date, structure: FolderStructure): string {
  const year = date.getFullYear().toString();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const monthName = MONTH_NAMES[date.getMonth()];

  let relFolder = '';
  switch (structure) {
    case 'YYYY/YYYY-MM':
      relFolder = path.join(year, `${year}-${month}`);
      break;
    case 'YYYY/MM - Month':
      relFolder = path.join(year, `${month} - ${monthName}`);
      break;
    case 'YYYY/YYYY-MM-DD':
      relFolder = path.join(year, `${year}-${month}-${day}`);
      break;
    case 'YYYY/MM/DD':
      relFolder = path.join(year, month, day);
      break;
    default:
      relFolder = path.join(year, `${year}-${month}`);
  }

  return path.join(targetBase, relFolder);
}

/** `reserved` (optional) holds lower-cased targets already claimed earlier in the same run but not yet on disk. */
export function getUniqueTargetFilePath(targetFolder: string, originalFileName: string, reserved?: Set<string>): string {
  const ext = path.extname(originalFileName);
  const baseName = path.basename(originalFileName, ext);
  let counter = 1;
  let candidate = path.join(targetFolder, originalFileName);

  while (fs.existsSync(candidate) || reserved?.has(candidate.toLowerCase())) {
    candidate = path.join(targetFolder, `${baseName}_${counter}${ext}`);
    counter++;
  }

  return candidate;
}

export async function generateDryRun(
  options: OrganizeOptions,
  onProgress?: (current: number, total: number) => void
): Promise<DryRunSummary> {
  const files = await scanDirectoryRecursive(options.sourceDir);
  const items: DryRunItem[] = [];
  const targetFolderSet = new Set<string>();
  const analysisErrors: string[] = [];
  // Targets already claimed by earlier items in THIS run (not on disk yet) —
  // without this, two sources that map to the same target both pass the
  // existsSync check and the second silently overwrites the first.
  const claimedTargets = new Set<string>();
  let totalSize = 0;
  let duplicateCount = 0;

  for (let i = 0; i < files.length; i++) {
    const src = files[i];
    if (onProgress) onProgress(i + 1, files.length);

    try {
      const stats = fs.statSync(src);
      totalSize += stats.size;
      const meta = await parsePhotoMetadata(src);
      const date = new Date(meta.dateTaken);

      const targetFolder = formatTargetDirectory(options.targetDir, date, options.structure);
      targetFolderSet.add(targetFolder);

      const fileName = path.basename(src);
      const expectedTarget = path.join(targetFolder, fileName);

      let isDuplicate = false;
      let conflictAction: DryRunItem['conflictAction'] = options.mode;
      let finalTarget = expectedTarget;

      if (fs.existsSync(expectedTarget)) {
        const targetStats = fs.statSync(expectedTarget);
        if (targetStats.size === stats.size) {
          // Verify with hash
          const srcHash = await computeFileHash(src);
          const tgtHash = await computeFileHash(expectedTarget);
          if (srcHash && srcHash === tgtHash) {
            isDuplicate = true;
            conflictAction = 'skip';
            duplicateCount++;
          }
        }

        if (!isDuplicate) {
          if (options.conflictResolution === 'rename') {
            finalTarget = getUniqueTargetFilePath(targetFolder, fileName);
            conflictAction = 'rename';
          } else if (options.conflictResolution === 'skip') {
            conflictAction = 'skip';
          }
        }
      }

      if (conflictAction !== 'skip' && !isDuplicate) {
        if (claimedTargets.has(finalTarget.toLowerCase())) {
          // Another file in this same run already targets this path.
          if (options.conflictResolution === 'skip') {
            conflictAction = 'skip';
          } else {
            finalTarget = getUniqueTargetFilePath(targetFolder, fileName, claimedTargets);
            conflictAction = 'rename';
          }
        }
        if (conflictAction !== 'skip') claimedTargets.add(finalTarget.toLowerCase());
      }

      items.push({
        sourceFile: src,
        targetFile: finalTarget,
        date: date.toISOString(),
        isDuplicate,
        conflictAction,
        fileSize: stats.size,
      });
    } catch (err: any) {
      console.error(`Failed to analyze file ${src}:`, err);
      analysisErrors.push(`Could not analyze ${src}: ${err?.message || err}`);
    }
  }

  // `errors` is an optional extra field (existing consumers ignore it).
  const summary: DryRunSummary & { errors: string[] } = {
    totalFiles: files.length,
    items,
    totalSize,
    duplicateCount,
    targetFolders: Array.from(targetFolderSet),
    errors: analysisErrors,
  };
  return summary;
}

export async function executeOrganization(
  options: OrganizeOptions,
  onProgress: (progress: OrganizeProgress) => void
): Promise<{ success: boolean; movedCount: number; errors: string[] }> {
  const dryRun = await generateDryRun(options, (cur, tot) => {
    onProgress({
      current: cur,
      total: tot,
      currentFile: 'Analyzing source directory...',
      status: 'scanning',
    });
  });

  const errors: string[] = [...((dryRun as DryRunSummary & { errors?: string[] }).errors || [])];
  let movedCount = 0;
  const total = dryRun.items.length;

  for (let i = 0; i < total; i++) {
    const item = dryRun.items[i];
    const fileName = path.basename(item.sourceFile);

    onProgress({
      current: i + 1,
      total,
      currentFile: fileName,
      status: 'organizing',
    });

    if (item.conflictAction === 'skip') {
      continue;
    }

    try {
      const targetDir = path.dirname(item.targetFile);
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }

      // Re-check right before writing: the target may have appeared since
      // analysis (another process, or an earlier item in this run), and
      // renameSync/copyFileSync silently replace an existing file.
      let targetFile = item.targetFile;
      const overwrite = options.conflictResolution === 'overwrite';
      if (!overwrite && fs.existsSync(targetFile)) {
        if (options.conflictResolution === 'skip') continue;
        targetFile = getUniqueTargetFilePath(path.dirname(targetFile), path.basename(targetFile));
      }
      const copyFlags = overwrite ? 0 : fs.constants.COPYFILE_EXCL;

      if (options.mode === 'move') {
        try {
          fs.renameSync(item.sourceFile, targetFile);
        } catch (renameErr: any) {
          // If moving across drives, fallback to copy + verify + unlink
          if (renameErr.code === 'EXDEV') {
            // Only a copy that actually created the target may be cleaned up: if copyFileSync
            // itself failed (e.g. EEXIST because another writer got there first), the file at
            // targetFile belongs to someone else and must not be deleted.
            let created = false;
            try {
              fs.copyFileSync(item.sourceFile, targetFile, copyFlags);
              created = true;
              if (fs.statSync(targetFile).size !== fs.statSync(item.sourceFile).size) {
                throw new Error('copy size mismatch');
              }
            } catch (copyErr) {
              try { if (created && !overwrite) fs.unlinkSync(targetFile); } catch {}
              throw copyErr;
            }
            fs.unlinkSync(item.sourceFile);
          } else {
            throw renameErr;
          }
        }
      } else {
        fs.copyFileSync(item.sourceFile, targetFile, copyFlags);
      }

      movedCount++;
    } catch (err: any) {
      const msg = `Error ${options.mode === 'move' ? 'moving' : 'copying'} ${item.sourceFile}: ${err.message}`;
      console.error(msg);
      errors.push(msg);
    }
  }

  onProgress({
    current: total,
    total,
    currentFile: 'Completed',
    status: 'completed',
  });

  return {
    success: errors.length === 0,
    movedCount,
    errors,
  };
}
