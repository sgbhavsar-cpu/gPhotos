import { app, BrowserWindow, ipcMain, dialog, protocol, net, shell, Menu } from 'electron';
import path from 'path';
import fs from 'fs';
import { pathToFileURL } from 'url';
import exifr from 'exifr';
import { parsePhotoMetadata } from './services/exifParser';
import {
  scanDirectoryRecursive,
  generateDryRun,
  executeOrganization
} from './services/fileOrganizer';
import {
  syncVirtualStorage,
  scanVirtualMirrorDirectory,
  discoverStoredMirrors,
  readDirectoryTree,
  readFolderPhotos,
  generateThumbnailOnTheFly,
  editPhotoFile,
  trashFiles,
  generateThumbnailBuffer
} from './services/virtualMirrorService';
import { Photo, OrganizeOptions, VirtualStorageConfig, EditPhotoOptions, BackgroundServiceSettings } from '../types';
import {
  initBackgroundDaemon,
  getBackgroundServiceStatus,
  updateBackgroundServiceSettings,
  runBackgroundSyncCycle,
  markAsQuitting,
  installSystemServiceDaemon,
  uninstallSystemServiceDaemon,
  getServiceLogs,
} from './services/backgroundDaemon';
import { exportLibraryBackupZip } from './services/zipBackupService';

app.name = 'gPhotos';
app.setName('gPhotos');
if (process.platform === 'win32') {
  app.setAppUserModelId('gPhotos');
}

// Global Exception and Promise Rejection Handlers to eliminate unhandled errors
process.on('uncaughtException', (error) => {
  console.error('[CRITICAL MAIN PROCESS EXCEPTION]:', error);
});

process.on('unhandledRejection', (reason) => {
  console.error('[CRITICAL MAIN PROCESS UNHANDLED REJECTION]:', reason);
});

// Single Instance Lock: Ensure only one copy of application runs
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  console.log('Another instance of gPhotos is already running. Quitting duplicate instance.');
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    }
  });
}

let mainWindow: BrowserWindow | null = null;

// Register custom protocol scheme before app is ready
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'gphoto',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      bypassCSP: true,
      stream: true,
    },
  },
]);

function getStoragePath(): string {
  const userDir = app.getPath('userData');
  if (!fs.existsSync(userDir)) {
    fs.mkdirSync(userDir, { recursive: true });
  }
  return path.join(userDir, 'library.json');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: 'gPhotos',
    backgroundColor: '#0f172a', // sleek dark slate
    icon: path.join(__dirname, '../../public/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
    },
  });

  // Ensure Window and WebContents receive native keyboard focus on show and focus
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    mainWindow?.focus();
    mainWindow?.webContents.focus();
  });

  mainWindow.on('focus', () => {
    mainWindow?.webContents.focus();
  });

  // Renderer crash recovery & responsiveness monitoring
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[CRITICAL] Renderer process gone:', details);
    if (details.reason !== 'clean-exit') {
      dialog
        .showMessageBox(mainWindow || undefined as any, {
          type: 'error',
          title: 'gPhotos - Renderer Issue',
          message: `The application view process encountered an issue (${details.reason}). Click Reload to restore.`,
          buttons: ['Reload Application', 'Close'],
        })
        .then(({ response }) => {
          if (response === 0) {
            mainWindow?.reload();
          } else {
            app.quit();
          }
        })
        .catch((err) => console.error('Error displaying crash dialog:', err));
    }
  });

  mainWindow.webContents.on('unresponsive', () => {
    console.warn('[WARN] Renderer process temporarily unresponsive');
  });

  // Standard Edit & View menu to guarantee native text editing accelerators (Cut, Copy, Paste, Select All)
  const menuTemplate: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));

  // Enable F12 to toggle DevTools for inspection
  mainWindow.webContents.on('before-input-event', (_event, input) => {
    if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) {
      mainWindow?.webContents.toggleDevTools();
    }
  });

  // Handle local photo and AI model protocol
  protocol.handle('gphoto', async (request) => {
    try {
      const url = new URL(request.url);

      // 1. Serving AI models: gphoto://models/<model-filename>
      if (url.hostname === 'models' || url.pathname.startsWith('/models/')) {
        const filename = path.basename(url.pathname);
        const searchPaths = [
          path.join(__dirname, '../../dist/models', filename),
          path.join(__dirname, '../../public/models', filename),
          path.join(app.getAppPath(), 'dist/models', filename),
          path.join(app.getAppPath(), 'public/models', filename),
        ];

        for (const p of searchPaths) {
          if (fs.existsSync(p)) {
            const buffer = fs.readFileSync(p);
            const contentType = filename.endsWith('.json')
              ? 'application/json'
              : 'application/octet-stream';
            return new Response(buffer, {
              headers: {
                'Content-Type': contentType,
                'Access-Control-Allow-Origin': '*',
              },
            });
          }
        }
        return new Response(`Model file ${filename} not found`, { status: 404 });
      }

      // Serving Help documentation: gphoto://help or gphoto://help.html
      if (url.hostname === 'help' || url.pathname.includes('help.html') || url.pathname === '/help') {
        const helpPaths = [
          path.join(__dirname, '../../dist/help.html'),
          path.join(__dirname, '../../public/help.html'),
          path.join(app.getAppPath(), 'dist/help.html'),
          path.join(app.getAppPath(), 'public/help.html'),
        ];
        for (const p of helpPaths) {
          if (fs.existsSync(p)) {
            const buffer = fs.readFileSync(p);
            return new Response(buffer, {
              headers: {
                'Content-Type': 'text/html; charset=utf-8',
                'Access-Control-Allow-Origin': '*',
              },
            });
          }
        }
        return new Response('Help file not found', { status: 404 });
      }

      // 2. Serving Photos: gphoto://load?path=C%3A%5C... or gphoto://photo?path=...
      const filePath = url.searchParams.get('path');
      const originalPath = url.searchParams.get('originalPath');
      const preferOriginal =
        url.searchParams.get('preferOriginal') === '1' ||
        url.searchParams.get('preferOriginal') === 'true';

      let targetPath: string | null = null;
      // When network storage source is available, serve original high-res photo!
      if (preferOriginal && originalPath && fs.existsSync(originalPath)) {
        targetPath = originalPath;
      } else if (filePath && fs.existsSync(filePath)) {
        targetPath = filePath;
      } else if (originalPath && fs.existsSync(originalPath)) {
        targetPath = originalPath;
      }

      if (targetPath && fs.existsSync(targetPath)) {
        const ext = path.extname(targetPath).toLowerCase();

        // Direct support for Apple iPhone HEIC/HEIF files:
        // Automatically extract the embedded JPEG preview thumbnail generated by iOS
        if (ext === '.heic' || ext === '.heif') {
          try {
            const thumbBuffer = await exifr.thumbnail(targetPath);
            if (thumbBuffer && thumbBuffer.length > 0) {
              return new Response(thumbBuffer as any, {
                headers: {
                  'Content-Type': 'image/jpeg',
                  'Access-Control-Allow-Origin': '*',
                },
              });
            }
          } catch (heicErr) {
            console.warn(`Could not extract embedded JPEG preview from HEIC ${targetPath}:`, heicErr);
          }
        }

        const mimeMap: Record<string, string> = {
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.png': 'image/png',
          '.webp': 'image/webp',
          '.gif': 'image/gif',
          '.bmp': 'image/bmp',
        };
        const contentType = mimeMap[ext] || 'image/jpeg';
        const buffer = fs.readFileSync(targetPath);
        return new Response(buffer, {
          headers: {
            'Content-Type': contentType,
            'Access-Control-Allow-Origin': '*',
          },
        });
      }

      return new Response('File Not Found', { status: 404 });
    } catch (err: any) {
      console.error('Error in gphoto protocol handler:', err);
      return new Response(`Error loading asset: ${err.message}`, { status: 500 });
    }
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../../dist/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Initialize System Tray and background scanning daemon
  initBackgroundDaemon(mainWindow);
}

app.on('before-quit', () => {
  markAsQuitting();
});

app.whenReady().then(() => {
  const isHeadlessService = process.argv.includes('--background-service');

  if (isHeadlessService) {
    // Run autonomous daemon without opening the GUI window
    initBackgroundDaemon(null);
  } else {
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// ---------------- IPC Handlers ----------------

ipcMain.handle('dialog:select-directory', async () => {
  try {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: 'Select Folder',
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  } catch (err) {
    console.error('dialog:select-directory error:', err);
    return null;
  }
});

ipcMain.handle('scanner:scan-directory', async (_event, dirPath: string): Promise<Photo[]> => {
  try {
    const filePaths = scanDirectoryRecursive(dirPath);
    const photos: Photo[] = [];

    for (const filePath of filePaths) {
      try {
        const stats = fs.statSync(filePath);
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
  } catch (err) {
    console.error(`Failed to scan directory ${dirPath}:`, err);
    return [];
  }
});

ipcMain.handle('scanner:read-exif', async (_event, filePath: string) => {
  try {
    return await parsePhotoMetadata(filePath);
  } catch (err) {
    console.error(`Failed to read exif for ${filePath}:`, err);
    return {};
  }
});

ipcMain.handle('organizer:analyze-dryrun', async (_event, options: OrganizeOptions) => {
  try {
    return await generateDryRun(options);
  } catch (err: any) {
    console.error('organizer:analyze-dryrun error:', err);
    return { totalFiles: 0, byYearMonth: {}, duplicateCount: 0, previewFiles: [], error: err.message };
  }
});

ipcMain.handle('organizer:execute', async (event, options: OrganizeOptions) => {
  try {
    return await executeOrganization(options, (progress) => {
      try {
        event.sender.send('organizer:progress', progress);
      } catch {}
    });
  } catch (err: any) {
    console.error('organizer:execute error:', err);
    return { success: false, processedCount: 0, errors: [err.message] };
  }
});

ipcMain.handle('file:read-base64', async (_event, filePath: string) => {
  try {
    const data = fs.readFileSync(filePath);
    const ext = path.extname(filePath).slice(1).toLowerCase();
    const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
    return `data:${mime};base64,${data.toString('base64')}`;
  } catch (err: any) {
    console.error(`Failed to read file ${filePath}:`, err);
    return '';
  }
});

ipcMain.handle('storage:save', async (_event, key: string, data: any) => {
  try {
    const storePath = getStoragePath();
    let currentData: Record<string, any> = {};
    if (fs.existsSync(storePath)) {
      try {
        currentData = JSON.parse(fs.readFileSync(storePath, 'utf-8'));
      } catch (parseErr) {
        console.warn('Failed to parse existing library.json, starting fresh:', parseErr);
      }
    }
    currentData[key] = data;
    const tempPath = `${storePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(currentData, null, 2), 'utf-8');
    fs.renameSync(tempPath, storePath);
    return true;
  } catch (err) {
    console.error('Failed to save library data:', err);
    return false;
  }
});

ipcMain.handle('storage:load', async (_event, key: string) => {
  try {
    const storePath = getStoragePath();
    if (fs.existsSync(storePath)) {
      const currentData = JSON.parse(fs.readFileSync(storePath, 'utf-8'));
      return currentData[key] ?? null;
    }
    return null;
  } catch (err) {
    console.error('Failed to load library data:', err);
    return null;
  }
});

// Virtual Mirror & Network Storage Handlers
ipcMain.handle('mirror:sync-storage', async (event, config: VirtualStorageConfig) => {
  try {
    return await syncVirtualStorage(config, (progress) => {
      try {
        event.sender.send('mirror:progress', progress);
      } catch {}
    });
  } catch (err: any) {
    console.error('mirror:sync-storage error:', err);
    return { success: false, newMirroredCount: 0, totalMirroredCount: 0, totalSizeSaved: 0, error: err.message };
  }
});

ipcMain.handle('mirror:scan-virtual-mirror', async (_event, mirrorDirPath: string) => {
  try {
    return scanVirtualMirrorDirectory(mirrorDirPath);
  } catch (err) {
    console.error('mirror:scan-virtual-mirror error:', err);
    return [];
  }
});

ipcMain.handle('mirror:list-stored-mirrors', async (_event, rootPath?: string) => {
  try {
    return discoverStoredMirrors(rootPath);
  } catch (err) {
    console.error('mirror:list-stored-mirrors error:', err);
    return [];
  }
});

ipcMain.handle('mirror:open-original', async (_event, filePath: string) => {
  try {
    if (fs.existsSync(filePath)) {
      shell.showItemInFolder(filePath);
      return true;
    }
    return false;
  } catch (err) {
    console.error(`Failed to open original file ${filePath}:`, err);
    return false;
  }
});

ipcMain.handle('file:check-exists', async (_event, filePath: string) => {
  if (!filePath) return false;
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
});

// ---------------- New Storage & Photo Intelligence Handlers ----------------

// Active background scan jobs
const activeScanJobs = new Map<string, boolean>();

ipcMain.handle('mirror:start-bg-scan', async (event, sourcePath: string, mirrorRoot?: string, storageName?: string) => {
  const jobId = `job_${Date.now()}`;
  activeScanJobs.set(jobId, true);

  const finalMirrorRoot = mirrorRoot || 'C:\\GPhotos_VirtualMirrors';
  const name = storageName || path.basename(sourcePath) || 'Storage';
  const targetMirrorDir = path.join(finalMirrorRoot, name);

  if (!fs.existsSync(targetMirrorDir)) {
    fs.mkdirSync(targetMirrorDir, { recursive: true });
  }

  // Non-blocking asynchronous background scan
  setTimeout(async () => {
    try {
      const allFiles = scanDirectoryRecursive(sourcePath);
      const total = allFiles.length;
      let batch: Photo[] = [];

      for (let i = 0; i < total; i++) {
        if (!activeScanJobs.get(jobId)) break;

        const remoteFile = allFiles[i];
        const fileName = path.basename(remoteFile);
        const relFromRoot = path.relative(sourcePath, remoteFile);
        const relDir = path.dirname(relFromRoot);
        const targetLocalDir = path.join(targetMirrorDir, relDir);
        if (!fs.existsSync(targetLocalDir)) {
          fs.mkdirSync(targetLocalDir, { recursive: true });
        }

        const localThumbPath = path.join(targetLocalDir, fileName);
        const baseName = path.basename(fileName, path.extname(fileName));
        const localMetaPath = path.join(targetLocalDir, `${baseName}.json`);

        let photoEntry: Photo | null = null;

        if (fs.existsSync(localMetaPath) && fs.existsSync(localThumbPath)) {
          try {
            const meta = JSON.parse(fs.readFileSync(localMetaPath, 'utf-8'));
            photoEntry = {
              id: `photo_${Buffer.from(remoteFile).toString('base64').replace(/[/+=]/g, '_')}`,
              filePath: localThumbPath,
              fileName,
              fileSize: meta.originalFileSize || 0,
              fileDate: meta.dateTaken || new Date().toISOString(),
              dateTaken: meta.dateTaken || new Date().toISOString(),
              year: new Date(meta.dateTaken || Date.now()).getFullYear(),
              month: new Date(meta.dateTaken || Date.now()).getMonth() + 1,
              day: new Date(meta.dateTaken || Date.now()).getDate(),
              width: meta.width,
              height: meta.height,
              exif: meta.exif,
              location: meta.location,
              isVirtual: true,
              originalRemotePath: remoteFile,
              storageName: name,
            };
          } catch {}
        } else {
          const thumbBuf = generateThumbnailBuffer(remoteFile, 500);
          if (thumbBuf) {
            fs.writeFileSync(localThumbPath, thumbBuf);
            const exif = await parsePhotoMetadata(remoteFile);
            const stat = fs.statSync(remoteFile);
            const dateTaken = exif.dateTaken || stat.mtime.toISOString();
            const d = new Date(dateTaken);
            const safeDate = isNaN(d.getTime()) ? new Date() : d;

            const metaToSave = {
              fileName,
              originalFilePath: remoteFile,
              originalFileSize: stat.size,
              dateTaken: safeDate.toISOString(),
              width: exif.width,
              height: exif.height,
              thumbnailPath: localThumbPath,
              storageName: name,
              storageRoot: sourcePath,
              relativePath: relFromRoot,
              exif: exif.exif,
              location: exif.location,
            };
            fs.writeFileSync(localMetaPath, JSON.stringify(metaToSave, null, 2), 'utf-8');

            photoEntry = {
              id: `photo_${Buffer.from(remoteFile).toString('base64').replace(/[/+=]/g, '_')}`,
              filePath: localThumbPath,
              fileName,
              fileSize: stat.size,
              fileDate: stat.mtime.toISOString(),
              dateTaken: safeDate.toISOString(),
              year: safeDate.getFullYear(),
              month: safeDate.getMonth() + 1,
              day: safeDate.getDate(),
              width: exif.width,
              height: exif.height,
              exif: exif.exif,
              location: exif.location,
              isVirtual: true,
              originalRemotePath: remoteFile,
              storageName: name,
            };
          }
        }

        if (photoEntry) {
          batch.push(photoEntry);
        }

        if (batch.length >= 15 || i === total - 1) {
          event.sender.send('mirror:bg-scan-progress', {
            jobId,
            sourcePath,
            currentFile: fileName,
            processedCount: i + 1,
            totalDiscovered: total,
            isComplete: i === total - 1,
            newlyAddedPhotos: [...batch],
          });
          batch = [];
          await new Promise((r) => setTimeout(r, 6));
        }
      }

      event.sender.send('mirror:bg-scan-progress', {
        jobId,
        sourcePath,
        currentFile: 'Complete',
        processedCount: total,
        totalDiscovered: total,
        isComplete: true,
      });
    } catch (err: any) {
      console.error('Background scan error:', err);
      event.sender.send('mirror:bg-scan-progress', {
        jobId,
        sourcePath,
        currentFile: '',
        processedCount: 0,
        totalDiscovered: 0,
        isComplete: true,
        error: err.message,
      });
    } finally {
      activeScanJobs.delete(jobId);
    }
  }, 20);

  return { jobId };
});

ipcMain.handle('storage:read-directory-tree', async (_event, dirPath: string) => {
  try {
    return readDirectoryTree(dirPath);
  } catch (err) {
    console.error('storage:read-directory-tree error:', err);
    return { name: path.basename(dirPath || ''), path: dirPath || '', subdirs: [], photoCount: 0 };
  }
});

ipcMain.handle('storage:read-folder-photos', async (_event, folderPath: string) => {
  try {
    return await readFolderPhotos(folderPath);
  } catch (err) {
    console.error('storage:read-folder-photos error:', err);
    return [];
  }
});

ipcMain.handle('storage:generate-thumb-on-the-fly', async (_event, sourceFilePath: string, mirrorDirPath?: string) => {
  try {
    return await generateThumbnailOnTheFly(sourceFilePath, mirrorDirPath);
  } catch (err) {
    console.error('storage:generate-thumb-on-the-fly error:', err);
    return null;
  }
});

ipcMain.handle('photo:edit', async (_event, options: EditPhotoOptions) => {
  try {
    return await editPhotoFile(options);
  } catch (err: any) {
    console.error('photo:edit error:', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('file:trash-files', async (_event, filePaths: string[]) => {
  try {
    return await trashFiles(filePaths);
  } catch (err: any) {
    console.error('file:trash-files error:', err);
    return { success: false, trashedCount: 0, errors: [err.message] };
  }
});

ipcMain.handle('mirror:delete-storage', async (_event, params: { storageName: string; localMirrorRoot?: string; deleteDiskFiles: boolean }) => {
  try {
    const { storageName, localMirrorRoot, deleteDiskFiles } = params;
    const finalRoot = localMirrorRoot || 'C:\\GPhotos_VirtualMirrors';
    const mirrorDir = path.join(finalRoot, storageName);

    if (deleteDiskFiles && fs.existsSync(mirrorDir)) {
      try {
        await shell.trashItem(mirrorDir);
      } catch (trashErr) {
        console.warn(`shell.trashItem failed on ${mirrorDir}, falling back to fs.rmSync:`, trashErr);
        fs.rmSync(mirrorDir, { recursive: true, force: true });
      }
    }
    return { success: true };
  } catch (err: any) {
    console.error(`Failed to delete virtual storage ${params?.storageName}:`, err);
    return { success: false, error: err.message };
  }
});

// Background Daemon & Service Handlers
ipcMain.handle('service:get-status', async () => {
  try {
    return getBackgroundServiceStatus();
  } catch (err) {
    console.error('service:get-status error:', err);
    return { isRunning: false, mode: 'thread', lastSyncTime: null, lastError: String(err) };
  }
});

ipcMain.handle('service:set-settings', async (_event, settings: Partial<BackgroundServiceSettings>) => {
  try {
    return updateBackgroundServiceSettings(settings, mainWindow);
  } catch (err) {
    console.error('service:set-settings error:', err);
    return false;
  }
});

ipcMain.handle('service:trigger-sync', async () => {
  try {
    runBackgroundSyncCycle(mainWindow);
    return { started: true };
  } catch (err: any) {
    console.error('service:trigger-sync error:', err);
    return { started: false, error: err.message };
  }
});

ipcMain.handle('service:install-system-service', async () => {
  try {
    return installSystemServiceDaemon();
  } catch (err: any) {
    console.error('service:install-system-service error:', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('service:uninstall-system-service', async () => {
  try {
    return uninstallSystemServiceDaemon();
  } catch (err: any) {
    console.error('service:uninstall-system-service error:', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('service:get-logs', async () => {
  try {
    return getServiceLogs();
  } catch (err) {
    console.error('service:get-logs error:', err);
    return [];
  }
});

ipcMain.handle('help:open-in-browser', async () => {
  try {
    const helpPaths = [
      path.join(__dirname, '../../dist/help.html'),
      path.join(__dirname, '../../public/help.html'),
      path.join(app.getAppPath(), 'dist/help.html'),
      path.join(app.getAppPath(), 'public/help.html'),
    ];
    for (const p of helpPaths) {
      if (fs.existsSync(p)) {
        await shell.openPath(p);
        return true;
      }
    }
    return false;
  } catch (err) {
    console.error('help:open-in-browser error:', err);
    return false;
  }
});

// Library Backup (.zip) & File Explorer Handlers
ipcMain.handle('backup:export-zip', async (_event, customTargetZipPath?: string) => {
  try {
    return await exportLibraryBackupZip(mainWindow, customTargetZipPath);
  } catch (err: any) {
    console.error('backup:export-zip error:', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('shell:show-item-in-folder', async (_event, filePath: string) => {
  try {
    if (fs.existsSync(filePath)) {
      shell.showItemInFolder(filePath);
      return true;
    }
    return false;
  } catch (err) {
    console.error('Failed to show item in folder:', err);
    return false;
  }
});




