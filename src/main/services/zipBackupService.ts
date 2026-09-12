import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { app, dialog, BrowserWindow } from 'electron';

export interface ZipFileEntry {
  name: string;
  content: string | Buffer;
}

/**
 * Pure Node.js standard PKZIP archive generator.
 * Produces 100% compliant .zip archives compatible with Windows Explorer, WinRAR, and 7-Zip.
 */
export function createZipArchive(files: ZipFileEntry[]): Buffer {
  const localHeaders: Buffer[] = [];
  const centralHeaders: Buffer[] = [];
  let offset = 0;

  // DOS timestamp conversion
  const now = new Date();
  const dosTime =
    (now.getHours() << 11) | (now.getMinutes() << 5) | (Math.floor(now.getSeconds() / 2));
  const dosDate =
    ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

  for (const file of files) {
    const nameBuf = Buffer.from(file.name.replace(/\\/g, '/'), 'utf8');
    const rawData = Buffer.isBuffer(file.content)
      ? file.content
      : Buffer.from(file.content, 'utf8');

    const crc = zlib.crc32(rawData);
    const compressed = zlib.deflateRawSync(rawData);

    // Local file header (30 bytes + filename)
    const lHeader = Buffer.alloc(30 + nameBuf.length);
    lHeader.writeUInt32LE(0x04034b50, 0); // Local header signature
    lHeader.writeUInt16LE(20, 4);          // Version needed (2.0)
    lHeader.writeUInt16LE(0x0800, 6);       // General purpose bit flag (UTF-8)
    lHeader.writeUInt16LE(8, 8);           // Compression method (Deflate)
    lHeader.writeUInt16LE(dosTime, 10);     // Last mod file time
    lHeader.writeUInt16LE(dosDate, 12);     // Last mod file date
    lHeader.writeUInt32LE(crc, 14);         // CRC-32
    lHeader.writeUInt32LE(compressed.length, 18); // Compressed size
    lHeader.writeUInt32LE(rawData.length, 22);    // Uncompressed size
    lHeader.writeUInt16LE(nameBuf.length, 26);    // Filename length
    lHeader.writeUInt16LE(0, 28);                 // Extra field length
    nameBuf.copy(lHeader, 30);

    localHeaders.push(Buffer.concat([lHeader, compressed]));

    // Central directory header (46 bytes + filename)
    const cHeader = Buffer.alloc(46 + nameBuf.length);
    cHeader.writeUInt32LE(0x02014b50, 0); // Central directory signature
    cHeader.writeUInt16LE(20, 4);          // Version made by (2.0)
    cHeader.writeUInt16LE(20, 6);          // Version needed (2.0)
    cHeader.writeUInt16LE(0x0800, 8);       // General purpose bit flag (UTF-8)
    cHeader.writeUInt16LE(8, 10);          // Compression method (Deflate)
    cHeader.writeUInt16LE(dosTime, 12);     // Last mod file time
    cHeader.writeUInt16LE(dosDate, 14);     // Last mod file date
    cHeader.writeUInt32LE(crc, 16);         // CRC-32
    cHeader.writeUInt32LE(compressed.length, 20); // Compressed size
    cHeader.writeUInt32LE(rawData.length, 24);    // Uncompressed size
    cHeader.writeUInt16LE(nameBuf.length, 28);    // Filename length
    cHeader.writeUInt16LE(0, 30);                 // Extra field length
    cHeader.writeUInt16LE(0, 32);                 // File comment length
    cHeader.writeUInt16LE(0, 34);                 // Disk number start
    cHeader.writeUInt16LE(0, 36);                 // Internal file attributes
    cHeader.writeUInt32LE(0, 38);                 // External file attributes
    cHeader.writeUInt32LE(offset, 42);            // Relative offset of local header
    nameBuf.copy(cHeader, 46);

    centralHeaders.push(cHeader);
    offset += lHeader.length + compressed.length;
  }

  const centralDir = Buffer.concat(centralHeaders);

  // End of central directory record (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);       // EOCD signature
  eocd.writeUInt16LE(0, 4);                 // Number of this disk
  eocd.writeUInt16LE(0, 6);                 // Disk where central directory starts
  eocd.writeUInt16LE(files.length, 8);      // Number of central directory records on this disk
  eocd.writeUInt16LE(files.length, 10);     // Total number of central directory records
  eocd.writeUInt32LE(centralDir.length, 12); // Size of central directory
  eocd.writeUInt32LE(offset, 16);           // Offset of start of central directory
  eocd.writeUInt16LE(0, 20);                // Comment length

  return Buffer.concat([...localHeaders, centralDir, eocd]);
}

/**
 * Creates and exports a full library backup in .zip format.
 */
export async function exportLibraryBackupZip(
  window: BrowserWindow | null,
  customTargetZipPath?: string
): Promise<{
  success: boolean;
  filePath?: string;
  fileSize?: number;
  totalPhotos?: number;
  totalPeople?: number;
  totalAlbums?: number;
  canceled?: boolean;
  error?: string;
}> {
  try {
    const userDir = app.getPath('userData');
    const libraryPath = path.join(userDir, 'library.json');

    let libraryData: any = {};
    if (fs.existsSync(libraryPath)) {
      try {
        libraryData = JSON.parse(fs.readFileSync(libraryPath, 'utf-8'));
      } catch (e) {
        console.warn('Failed to parse existing library.json:', e);
      }
    }

    const libState = libraryData.gphotos_library_v1 || {};
    const totalPhotos = (libState.photos || []).length;
    const totalPeople = (libState.people || []).length;
    const totalAlbums = (libState.albums || []).length;

    let targetZipPath = customTargetZipPath;

    if (!targetZipPath) {
      const now = new Date();
      const dateStr = now.toISOString().slice(0, 10);
      const timeStr = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
      const defaultFilename = `gPhotos_Library_Backup_${dateStr}_${timeStr}.zip`;

      const dialogResult = await dialog.showSaveDialog(window || undefined as any, {
        title: 'Save Library Backup (.zip)',
        defaultPath: path.join(app.getPath('documents') || app.getPath('downloads'), defaultFilename),
        filters: [
          { name: 'ZIP Archive (*.zip)', extensions: ['zip'] },
          { name: 'All Files (*.*)', extensions: ['*'] },
        ],
      });

      if (dialogResult.canceled || !dialogResult.filePath) {
        return { success: false, canceled: true };
      }

      targetZipPath = dialogResult.filePath;
    }

    // Prepare backup entries
    const manifest = {
      appName: 'gPhotos Desktop',
      version: app.getVersion() || '1.0.0',
      backupCreatedAt: new Date().toISOString(),
      activeFolder: libState.selectedFolder || libState.currentDirectory || null,
      summary: {
        totalPhotos,
        totalPeople,
        totalAlbums,
        totalFaces: (libState.faces || []).length,
        totalPlaces: (libState.places || []).length,
      },
    };

    const readmeText = `=====================================================
gPhotos Desktop - Library Backup Archive (.zip)
=====================================================
Created on: ${new Date().toLocaleString()}
Application: gPhotos Desktop Edition

Archive Contents:
- backup_manifest.json : Metadata summary of this backup
- library.json         : Complete database (photos, faces, people, albums, places, tags, favorites)
- settings.json        : Background synchronization and service daemon settings

To Restore:
Place the library.json back into %APPDATA%\\gPhotos\\library.json
or use the in-app restore mechanism.
=====================================================`;

    const entries: ZipFileEntry[] = [
      {
        name: 'backup_manifest.json',
        content: JSON.stringify(manifest, null, 2),
      },
      {
        name: 'library.json',
        content: JSON.stringify(libraryData, null, 2),
      },
      {
        name: 'README.txt',
        content: readmeText,
      },
    ];

    // Check for optional daemon settings file
    const settingsPath = path.join(userDir, 'settings.json');
    if (fs.existsSync(settingsPath)) {
      try {
        entries.push({
          name: 'settings.json',
          content: fs.readFileSync(settingsPath),
        });
      } catch {}
    }

    // Build the ZIP binary buffer
    const zipBuffer = createZipArchive(entries);

    // Write to destination
    fs.writeFileSync(targetZipPath, zipBuffer);
    const stats = fs.statSync(targetZipPath);

    return {
      success: true,
      filePath: targetZipPath,
      fileSize: stats.size,
      totalPhotos,
      totalPeople,
      totalAlbums,
    };
  } catch (err: any) {
    console.error('Error creating library backup .zip:', err);
    return {
      success: false,
      error: err.message,
    };
  }
}
