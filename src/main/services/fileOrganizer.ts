import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { parsePhotoMetadata } from './exifParser';
import {
  FolderStructure,
  OrganizeOptions,
  DryRunItem,
  DryRunSummary,
  OrganizeProgress
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

export function scanDirectoryRecursive(dirPath: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dirPath)) return results;

  function scan(current: string) {
    try {
      const entries = fs.readdirSync(current, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          // Skip hidden system or app folders
          if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
            scan(fullPath);
          }
        } else if (entry.isFile() && isImageFile(fullPath)) {
          results.push(fullPath);
        }
      }
    } catch (err) {
      console.error(`Error scanning ${current}:`, err);
    }
  }

  scan(dirPath);
  return results;
}

export function computeFileHash(filePath: string): string {
  try {
    const fileBuffer = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(fileBuffer).digest('hex');
  } catch {
    return '';
  }
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

export function getUniqueTargetFilePath(targetFolder: string, originalFileName: string): string {
  const ext = path.extname(originalFileName);
  const baseName = path.basename(originalFileName, ext);
  let counter = 1;
  let candidate = path.join(targetFolder, originalFileName);

  while (fs.existsSync(candidate)) {
    candidate = path.join(targetFolder, `${baseName}_${counter}${ext}`);
    counter++;
  }

  return candidate;
}

export async function generateDryRun(
  options: OrganizeOptions,
  onProgress?: (current: number, total: number) => void
): Promise<DryRunSummary> {
  const files = scanDirectoryRecursive(options.sourceDir);
  const items: DryRunItem[] = [];
  const targetFolderSet = new Set<string>();
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
          const srcHash = computeFileHash(src);
          const tgtHash = computeFileHash(expectedTarget);
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

      items.push({
        sourceFile: src,
        targetFile: finalTarget,
        date: date.toISOString(),
        isDuplicate,
        conflictAction,
        fileSize: stats.size,
      });
    } catch (err) {
      console.error(`Failed to analyze file ${src}:`, err);
    }
  }

  return {
    totalFiles: files.length,
    items,
    totalSize,
    duplicateCount,
    targetFolders: Array.from(targetFolderSet),
  };
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

  const errors: string[] = [];
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

      if (options.mode === 'move') {
        try {
          fs.renameSync(item.sourceFile, item.targetFile);
        } catch (renameErr: any) {
          // If moving across drives, fallback to copy + unlink
          if (renameErr.code === 'EXDEV') {
            fs.copyFileSync(item.sourceFile, item.targetFile);
            fs.unlinkSync(item.sourceFile);
          } else {
            throw renameErr;
          }
        }
      } else {
        fs.copyFileSync(item.sourceFile, item.targetFile);
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
