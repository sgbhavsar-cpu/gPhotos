import { app, BrowserWindow, ipcMain, dialog, protocol, net, shell, Menu } from 'electron';
import path from 'path';
import fs from 'fs';
import os from 'os';
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
  deleteFilesPermanently,
  rotatePhotoFile,
  rotatePhotoWithOfflineQueue,
  processPendingRotations,
  generateThumbnailBuffer,
  saveStorageCheckpoint,
  loadStorageCheckpoint,
  getAllStorageCheckpoints,
  getStorageDetails,
  getAllStorageDetails
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
import {
  getHeicJpegBuffer,
  getOrGenerateHeicThumbnail500,
  getHeicHighQualityJpegBuffer,
  prepareHeicHqTemp,
  cleanupHeicHqTemp,
} from './services/heicService';
import {
  startEmbeddedWebServer,
  stopEmbeddedWebServer,
  getEmbeddedWebServerStatus,
  updateEmbeddedWebServerSettings,
  loadSavedWebServerSettings,
} from './services/embeddedWebServer';
import {
  getOrCreatePin,
  regeneratePin,
  listDevices,
  revokeDevice,
  revokeAllDevices,
} from './services/webAuthService';
import { getOrGenerateCachedThumbnail, clearThumbnailCache, refreshThumbnailsFromSource } from './services/thumbnailCacheService';
import {
  getCatalogMeta,
  getCatalogPage,
  switchCatalogLibrary,
  buildAndSaveCatalog,
} from './services/catalogService';
import {
  getSpriteCoordinate,
  getSpritePath,
} from './services/spriteService';
import { thumbnailWorker } from './services/thumbnailWorkerService';
import { libraryStatusService } from './services/libraryStatusService';

app.name = 'gPhotos';
app.setName('gPhotos');
if (process.platform === 'win32') {
  app.setAppUserModelId('gPhotos');
}

const startupStartTime = Date.now();
console.log(`[STARTUP AUDIT] T+0ms: Main process initialized.`);

// Global Exception and Promise Rejection Handlers to eliminate unhandled errors
process.on('uncaughtException', (error) => {
  console.error('[CRITICAL MAIN PROCESS EXCEPTION]:', error);
});

process.on('unhandledRejection', (reason) => {
  console.error('[CRITICAL MAIN PROCESS UNHANDLED REJECTION]:', reason);
});

// Single Instance Lock: Ensure only one copy of application runs in production, while allowing isolated smoke tests
const isSmokeTest = process.argv.includes('--smoke-test') || process.env.GPHOTOS_SMOKE_TEST === '1';
if (isSmokeTest) {
  try {
    const tempUserData = path.join(os.tmpdir(), `gphotos_smoke_ud_${Date.now()}`);
    fs.mkdirSync(tempUserData, { recursive: true });
    app.setPath('userData', tempUserData);
  } catch {}
}

const gotSingleInstanceLock = isSmokeTest ? true : app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  console.log('Another instance of gPhotos is already running. Quitting duplicate instance.');
  app.quit();
} else if (!isSmokeTest) {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    } else {
      createSplashWindow();
      createWindow();
    }
  });
}

let mainWindow: BrowserWindow | null = null;
let splashWindow: BrowserWindow | null = null;
let isAppReadyFired = false;

function createSplashWindow() {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.focus();
    return;
  }

  console.log(`[STARTUP AUDIT] T+${Date.now() - startupStartTime}ms: Creating frameless splash window with loading animation...`);

  splashWindow = new BrowserWindow({
    width: 440,
    height: 270,
    frame: false,
    transparent: true,
    resizable: false,
    center: true,
    show: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: '#00000000',
    icon: path.join(__dirname, '../../public/icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  const candidates = [
    path.join(__dirname, 'splash.html'),
    path.join(__dirname, '../main/splash.html'),
    path.join(__dirname, '../../src/main/splash.html'),
    path.join(__dirname, '../../public/splash.html'),
    path.join(app.getAppPath(), 'dist/splash.html'),
    path.join(app.getAppPath(), 'public/splash.html'),
    path.join(app.getAppPath(), 'src/main/splash.html'),
  ];

  let loaded = false;
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      splashWindow.loadFile(p);
      loaded = true;
      break;
    }
  }

  if (!loaded) {
    splashWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`
      <!DOCTYPE html><html><body style="background:#0f172a;color:white;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;border-radius:16px;border:1px solid #334155;">
      <div style="text-align:center;"><h2>gPhotos</h2><p style="color:#94a3b8;font-size:12px;">Starting services...</p></div>
      </body></html>
    `)}`);
  }

  splashWindow.once('ready-to-show', () => {
    console.log(`[STARTUP AUDIT] T+${Date.now() - startupStartTime}ms: Splash screen presented to user with smooth loading animation.`);
    splashWindow?.show();
  });

  splashWindow.on('closed', () => {
    splashWindow = null;
  });
}

function revealMainWindow() {
  if (isAppReadyFired) return;
  isAppReadyFired = true;

  console.log(`[STARTUP AUDIT] T+${Date.now() - startupStartTime}ms: Transitioning from splash to main application window...`);

  // Fast 50ms delay to ensure smooth visual transition
  setTimeout(() => {
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.close();
      splashWindow = null;
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
      mainWindow.webContents.focus();
      console.log(`[STARTUP AUDIT] T+${Date.now() - startupStartTime}ms: Main window revealed and focused. Application is fully responsive!`);
    }
  }, 50);
}

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
  const defaultPath = path.join(userDir, 'library.json');

  // Cross-compatibility between dev environment (gphotos-desktop) and packaged exe (gPhotos):
  if (!fs.existsSync(defaultPath)) {
    try {
      const appData = app.getPath('appData');
      const isAppGPhotos = path.basename(userDir).toLowerCase() === 'gphotos';
      const altDir = isAppGPhotos
        ? path.join(appData, 'gphotos-desktop')
        : path.join(appData, 'gPhotos');
      const altPath = path.join(altDir, 'library.json');
      if (fs.existsSync(altPath)) {
        fs.copyFileSync(altPath, defaultPath);
        console.log(`[Storage] Migrated library data from ${altPath} to ${defaultPath}`);
      }
    } catch (migErr) {
      console.warn('[Storage] Fallback migration check failed:', migErr);
    }
  }

  return defaultPath;
}

function createWindow() {
  isAppReadyFired = false;
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: 'gPhotos',
    show: false, // Keep hidden during startup while splash animation is showing
    backgroundColor: '#0f172a', // sleek dark slate
    icon: path.join(__dirname, '../../public/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
    },
  });

  // Safety fallback: if renderer doesn't send 'app:ready' within 3.0s, reveal main window automatically
  mainWindow.once('ready-to-show', () => {
    setTimeout(() => {
      revealMainWindow();
    }, 3000);
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

      // Serving Pre-baked Sprites: gphoto://sprite?id=page_sprite_0 or gphoto://sprites/page_sprite_0.webp
      if (url.hostname === 'sprite' || url.hostname === 'sprites' || url.pathname.startsWith('/sprite')) {
        const spriteId = url.searchParams.get('id') || path.basename(url.pathname, path.extname(url.pathname));
        const spriteFile = getSpritePath(spriteId);
        if (fs.existsSync(spriteFile)) {
          const buffer = await fs.promises.readFile(spriteFile);
          return new Response(buffer as any, {
            headers: {
              'Content-Type': 'image/webp',
              'Access-Control-Allow-Origin': '*',
              'Cache-Control': 'public, max-age=31536000, immutable',
            },
          });
        }
        return new Response('Sprite not found', { status: 404 });
      }

      // 2. Serving Photos: gphoto://load?path=C%3A%5C... or gphoto://photo?path=...
      const filePath = url.searchParams.get('path');
      const originalPath = url.searchParams.get('originalPath');
      const preferOriginal =
        url.searchParams.get('preferOriginal') === '1' ||
        url.searchParams.get('preferOriginal') === 'true';
      const sizeParam = url.searchParams.get('size');
      const requestedSize = sizeParam ? parseInt(sizeParam, 10) : 0;
      const quality = url.searchParams.get('quality');

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

        // 1. Raw original full resolution requested
        if (preferOriginal) {
          if (ext === '.heic' || ext === '.heif') {
            const heicBuf = await getHeicHighQualityJpegBuffer(targetPath);
            if (heicBuf && heicBuf.length > 0) {
              return new Response(heicBuf as any, {
                headers: {
                  'Content-Type': 'image/jpeg',
                  'Access-Control-Allow-Origin': '*',
                  'Cache-Control': 'public, max-age=31536000, immutable',
                },
              });
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
          const buffer = await fs.promises.readFile(targetPath);
          return new Response(buffer, {
            headers: {
              'Content-Type': contentType,
              'Access-Control-Allow-Origin': '*',
              'Cache-Control': 'public, max-age=31536000, immutable',
            },
          });
        }

        // 2. Fast multi-tier cached thumbnail (250px grid, 500px medium, 1600px preview)
        const targetSize = requestedSize > 0
          ? requestedSize
          : (quality === 'high' ? 1600 : 250);

        const thumbResult = await getOrGenerateCachedThumbnail(targetPath, targetSize);
        if (thumbResult) {
          const buf = thumbResult.buffer || (thumbResult.filePath ? await fs.promises.readFile(thumbResult.filePath) : null);
          if (buf) {
            return new Response(buf as any, {
              headers: {
                'Content-Type': thumbResult.mime || 'image/jpeg',
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'public, max-age=31536000, immutable',
                'ETag': thumbResult.etag,
              },
            });
          }
        }

        // 3. Fallback direct file read
        const mimeMap: Record<string, string> = {
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.png': 'image/png',
          '.webp': 'image/webp',
          '.gif': 'image/gif',
          '.bmp': 'image/bmp',
        };
        const buffer = await fs.promises.readFile(targetPath);
        return new Response(buffer as any, {
          headers: {
            'Content-Type': mimeMap[ext] || 'image/jpeg',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=31536000, immutable',
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
  stopEmbeddedWebServer();
  try {
    thumbnailWorker.flushCheckpoint();
  } catch {}
});

app.whenReady().then(() => {
  // Start embedded mobile web server automatically on launch
  const wsSettings = loadSavedWebServerSettings();
  if (wsSettings.enabled) {
    startEmbeddedWebServer(wsSettings.port).catch((err) => {
      console.warn('[EmbeddedWebServer] Startup notice:', err);
    });
  }

  const isHeadlessService = process.argv.includes('--background-service');

  if (isHeadlessService) {
    // Run autonomous daemon without opening the GUI window
    initBackgroundDaemon(null);
  } else {
    createSplashWindow();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createSplashWindow();
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

// Signal from renderer that UI has finished mounting and is ready to show
ipcMain.on('app:ready', () => {
  console.log(`[STARTUP AUDIT] T+${Date.now() - startupStartTime}ms: 'app:ready' signal received from renderer. First screen mounted.`);
  revealMainWindow();
});

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

        let isHeicRotated = false;
        let heicRotation = 0;
        if (/\.(heic|heif)$/i.test(filePath)) {
          try {
            const { getHeicSavedRotation } = require('./services/heicRotationStore');
            heicRotation = getHeicSavedRotation(filePath);
            isHeicRotated = heicRotation !== 0;
          } catch {}
        }

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
          isHeicRotated: isHeicRotated ? true : undefined,
          heicRotation: isHeicRotated ? heicRotation : undefined,
          rotation: isHeicRotated ? heicRotation : undefined,
        };

        photos.push(photo);
      } catch (err) {
        console.error(`Failed to scan photo ${filePath}:`, err);
      }
    }

    if (photos.length > 0) {
      thumbnailWorker.enqueuePhotos(photos);
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

// Serialized save queue to guarantee atomic sequential writes without race conditions
let savePromiseQueue: Promise<boolean> = Promise.resolve(true);

ipcMain.handle('storage:save', async (_event, key: string, data: any) => {
  const op = async (): Promise<boolean> => {
    try {
      const storePath = getStoragePath();
      let currentData: Record<string, any> = {};
      if (fs.existsSync(storePath)) {
        try {
          currentData = JSON.parse(await fs.promises.readFile(storePath, 'utf-8'));
        } catch (parseErr) {
          console.warn('Failed to parse existing library.json, starting fresh:', parseErr);
        }
      }
      // Merge guard: protect library data against inadvertent wiping or truncation
      if (key === 'gphotos_library_v1' && data) {
        const existingLib = currentData['gphotos_library_v1'];
        if (existingLib) {
          // If incoming photos is a small slice from catalog pagination, merge updates into existingLib.photos
          if (
            Array.isArray(data.photos) &&
            Array.isArray(existingLib.photos) &&
            existingLib.photos.length > data.photos.length &&
            data.photos.length <= 100
          ) {
            const incomingMap = new Map(data.photos.map((p: any) => [p.id, p]));
            data.photos = existingLib.photos.map((ep: any) => incomingMap.get(ep.id) || ep);
          }
          // Guard: do not wipe existing people if incoming has empty people but existing had people
          if (
            (!data.people || data.people.length === 0) &&
            existingLib.people &&
            existingLib.people.length > 0
          ) {
            data.people = existingLib.people;
          }
          // Guard: do not wipe existing faces if incoming has empty faces but existing had faces
          if (
            (!data.faces || data.faces.length === 0) &&
            existingLib.faces &&
            existingLib.faces.length > 0
          ) {
            data.faces = existingLib.faces;
          }
        }
      }

      currentData[key] = data;
      const tempPath = `${storePath}.tmp`;
      await fs.promises.writeFile(tempPath, JSON.stringify(currentData, null, 2), 'utf-8');
      await fs.promises.rename(tempPath, storePath);

      // Asynchronously update 500K catalog index in background without blocking response
      if (key === 'gphotos_library_v1' && data && Array.isArray(data.photos)) {
        buildAndSaveCatalog(data.photos, {
          recentLibraries: data.recentLibraries,
          selectedFolder: data.selectedFolder,
          currentDirectory: data.currentDirectory,
          albums: data.albums,
          people: data.people,
        }).catch((err) => console.warn('[CatalogService] Auto-indexing on save failed:', err));

        const libPath = data.selectedFolder || data.currentDirectory;
        thumbnailWorker.enqueuePhotos(data.photos, libPath);
      }

      return true;
    } catch (err) {
      console.error('Failed to save library data:', err);
      return false;
    }
  };

  savePromiseQueue = savePromiseQueue.then(op, op);
  return savePromiseQueue;
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

// 500K Scalable Catalog & Sprite IPC Handlers
ipcMain.handle('catalog:get-meta', async (_event, customDir?: string) => {
  try {
    return await getCatalogMeta(customDir);
  } catch (err) {
    console.error('catalog:get-meta error:', err);
    return null;
  }
});

ipcMain.handle(
  'catalog:get-page',
  async (_event, params: { pageIndex: number; pageSize?: number; libraryDir?: string }) => {
    try {
      return await getCatalogPage(params.pageIndex, params.pageSize, params.libraryDir);
    } catch (err) {
      console.error('catalog:get-page error:', err);
      return { photos: [], totalPages: 0, totalPhotos: 0 };
    }
  }
);

ipcMain.handle('catalog:switch-library', async (_event, targetPath: string) => {
  try {
    const res = await switchCatalogLibrary(targetPath);
    if (res && res.firstPage && res.firstPage.length > 0) {
      thumbnailWorker.enqueuePhotos(res.firstPage);
    }
    return res;
  } catch (err) {
    console.error('catalog:switch-library error:', err);
    return null;
  }
});

ipcMain.handle('sprite:get-coordinate', async (_event, photoPath: string) => {
  try {
    return getSpriteCoordinate(photoPath);
  } catch {
    return null;
  }
});

// Virtual Mirror & Network Storage Handlers
ipcMain.handle('mirror:sync-storage', async (event, config: VirtualStorageConfig) => {
  try {
    const result = await syncVirtualStorage(config, (progress) => {
      try {
        event.sender.send('mirror:progress', progress);
      } catch {}
    });

    try {
      const storageMirrorRoot = path.join(config.localMirrorRoot, config.name);
      const mirroredPhotos = scanVirtualMirrorDirectory(storageMirrorRoot);
      if (mirroredPhotos.length > 0) {
        thumbnailWorker.enqueuePhotos(mirroredPhotos);
      }
    } catch {}

    return result;
  } catch (err: any) {
    console.error('mirror:sync-storage error:', err);
    return { success: false, newMirroredCount: 0, totalMirroredCount: 0, totalSizeSaved: 0, error: err.message };
  }
});

ipcMain.handle('mirror:scan-virtual-mirror', async (_event, mirrorDirPath: string) => {
  try {
    const photos = scanVirtualMirrorDirectory(mirrorDirPath);
    if (photos && photos.length > 0) {
      // Defer thumbnail pre-caching so initial startup and gallery paint are 100% fluid
      setTimeout(() => {
        try {
          thumbnailWorker.enqueuePhotos(photos);
        } catch {}
      }, 4000);
    }
    return photos;
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

ipcMain.handle('mirror:get-storage-checkpoints', async (_event, mirrorRoot?: string) => {
  try {
    return getAllStorageCheckpoints(mirrorRoot);
  } catch (err) {
    console.error('mirror:get-storage-checkpoints error:', err);
    return {};
  }
});

ipcMain.handle('mirror:get-storage-details', async (_event, storageName: string, mirrorRoot?: string) => {
  try {
    return getStorageDetails(storageName, mirrorRoot);
  } catch (err) {
    console.error('mirror:get-storage-details error:', err);
    return null;
  }
});

ipcMain.handle('mirror:get-all-storage-details', async (_event, mirrorRoot?: string) => {
  try {
    return getAllStorageDetails(mirrorRoot);
  } catch (err) {
    console.error('mirror:get-all-storage-details error:', err);
    return {};
  }
});

ipcMain.handle('library:get-status', async (_event, libraryPath: string) => {
  try {
    return libraryStatusService.getLibraryStatus(libraryPath);
  } catch (err) {
    console.error('library:get-status error:', err);
    return null;
  }
});

ipcMain.handle('library:save-status', async (_event, status: any) => {
  try {
    return libraryStatusService.saveLibraryStatus(status);
  } catch (err) {
    console.error('library:save-status error:', err);
    return status;
  }
});

ipcMain.handle('library:get-all-statuses', async () => {
  try {
    return libraryStatusService.getAllLibraryStatuses();
  } catch (err) {
    console.error('library:get-all-statuses error:', err);
    return {};
  }
});

ipcMain.handle('mirror:open-original', async (_event, filePath: string) => {
  try {
    if (filePath && typeof filePath === 'string' && fs.existsSync(filePath)) {
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
  if (!filePath || typeof filePath !== 'string') return false;
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

      // Intermittent checkpoint resumption check:
      // If an interrupted checkpoint exists, resume directly from where it stopped!
      const existingCp = loadStorageCheckpoint(name, finalMirrorRoot);
      let startIndex = 0;
      if (
        existingCp &&
        existingCp.phase !== 'completed' &&
        existingCp.lastProcessedIndex > 0 &&
        existingCp.lastProcessedIndex < total &&
        existingCp.totalDiscovered === total
      ) {
        startIndex = existingCp.lastProcessedIndex + 1;
        console.log(`[BackgroundScan] Resuming scan for ${name} from photo ${startIndex + 1} of ${total} (Saved progress: ${existingCp.percent}%)`);
      }

      for (let i = startIndex; i < total; i++) {
        if (!activeScanJobs.get(jobId)) {
          // Interrupted / canceled midway: save checkpoint so it can resume next time!
          saveStorageCheckpoint({
            storageName: name,
            networkSourcePath: sourcePath,
            localMirrorRoot: finalMirrorRoot,
            phase: 'interrupted',
            processedCount: i,
            totalDiscovered: total,
            lastProcessedIndex: Math.max(0, i - 1),
            lastProcessedFile: path.basename(allFiles[Math.max(0, i - 1)]),
            percent: Math.round((i / Math.max(1, total)) * 100),
            timestamp: Date.now(),
            updatedAt: new Date().toISOString(),
          });
          break;
        }

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
          let thumbBuf: Buffer | null = null;
          const isHeic = /\.(heic|heif)$/i.test(remoteFile);
          if (isHeic) {
            try {
              thumbBuf = await getOrGenerateHeicThumbnail500(remoteFile);
            } catch (heicErr) {
              console.warn(`HEIC thumbnail generation notice for ${remoteFile}:`, heicErr);
            }
          }
          if (!thumbBuf) {
            thumbBuf = generateThumbnailBuffer(remoteFile, 500);
          }
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

        // Intermittent checkpoint save every 10 photos
        if ((i + 1) % 10 === 0 || i === total - 1) {
          saveStorageCheckpoint({
            storageName: name,
            networkSourcePath: sourcePath,
            localMirrorRoot: finalMirrorRoot,
            phase: i === total - 1 ? 'completed' : 'thumbnails',
            processedCount: i + 1,
            totalDiscovered: total,
            lastProcessedIndex: i,
            lastProcessedFile: fileName,
            percent: Math.round(((i + 1) / Math.max(1, total)) * 100),
            timestamp: Date.now(),
            updatedAt: new Date().toISOString(),
          });
        }

        if (batch.length >= 15 || i === total - 1) {
          try {
            thumbnailWorker.enqueuePhotos(batch);
          } catch {}
          event.sender.send('mirror:bg-scan-progress', {
            jobId,
            sourcePath,
            storageName: name,
            phase: 'thumbnails',
            currentFile: fileName,
            processedCount: i + 1,
            totalDiscovered: total,
            isComplete: i === total - 1,
            percent: Math.round(((i + 1) / Math.max(1, total)) * 100),
            newlyAddedPhotos: [...batch],
            newPhotos: [...batch],
          });
          batch = [];
          await new Promise((r) => setTimeout(r, 6));
        }
      }

      // Mark final completed checkpoint
      saveStorageCheckpoint({
        storageName: name,
        networkSourcePath: sourcePath,
        localMirrorRoot: finalMirrorRoot,
        phase: 'completed',
        processedCount: total,
        totalDiscovered: total,
        lastProcessedIndex: total - 1,
        lastProcessedFile: 'Complete',
        percent: 100,
        timestamp: Date.now(),
        updatedAt: new Date().toISOString(),
      });

      event.sender.send('mirror:bg-scan-progress', {
        jobId,
        sourcePath,
        storageName: name,
        phase: 'completed',
        currentFile: 'Complete',
        processedCount: total,
        totalDiscovered: total,
        percent: 100,
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

ipcMain.handle('file:delete-permanently', async (_event, filePaths: string[]) => {
  try {
    return await deleteFilesPermanently(filePaths);
  } catch (err: any) {
    console.error('file:delete-permanently error:', err);
    return { success: false, deletedCount: 0, errors: [err.message] };
  }
});

ipcMain.handle(
  'photo:rotate',
  async (
    _event,
    params: { filePath: string; rotationDegrees: number; originalRemotePath?: string }
  ) => {
    try {
      const res = await rotatePhotoWithOfflineQueue({
        localFilePath: params.filePath,
        originalRemotePath: params.originalRemotePath,
        rotationDegrees: params.rotationDegrees,
      });
      return res;
    } catch (err: any) {
      console.error('photo:rotate error:', err);
      return { success: false, isQueued: false, error: err.message };
    }
  }
);

ipcMain.handle('photo:process-pending-rotations', async () => {
  try {
    return await processPendingRotations();
  } catch (err: any) {
    console.error('photo:process-pending-rotations error:', err);
    return { processed: 0, remaining: 0, error: err.message };
  }
});

ipcMain.handle(
  'thumbnails:refresh-from-source',
  async (_event, items: Array<{ filePath: string; originalRemotePath?: string }>) => {
    try {
      return await refreshThumbnailsFromSource(items || []);
    } catch (err: any) {
      console.error('thumbnails:refresh-from-source error:', err);
      return { refreshedCount: 0, errors: [err.message] };
    }
  }
);

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

// Resource-Throttled Background Thumbnail Pre-Caching Handlers
ipcMain.handle('service:get-precache-status', async () => {
  try {
    return thumbnailWorker.getStatus();
  } catch (err) {
    return { isRunning: false, paused: false, current: 0, total: 0, cpuPercent: 0, ramMb: 0 };
  }
});

ipcMain.handle('service:start-precache', async (_event, photos?: Photo[]) => {
  try {
    if (photos && photos.length > 0) {
      thumbnailWorker.enqueuePhotos(photos);
    } else {
      try {
        const mirrorRoot = 'C:\\GPhotos_VirtualMirrors';
        if (fs.existsSync(mirrorRoot)) {
          const subdirs = fs.readdirSync(mirrorRoot, { withFileTypes: true });
          for (const dirent of subdirs) {
            if (dirent.isDirectory() && !dirent.name.startsWith('.')) {
              const mirrorPhotos = scanVirtualMirrorDirectory(path.join(mirrorRoot, dirent.name));
              if (mirrorPhotos && mirrorPhotos.length > 0) {
                thumbnailWorker.enqueuePhotos(mirrorPhotos);
              }
            }
          }
        }
      } catch (mirrorErr) {
        console.warn('Auto-enqueuing mirrors for pre-caching failed:', mirrorErr);
      }
    }
    thumbnailWorker.resume();
    return { started: true };
  } catch (err: any) {
    return { started: false, error: err.message };
  }
});

ipcMain.handle('service:pause-precache', async () => {
  try {
    thumbnailWorker.pause();
    return { paused: true };
  } catch (err: any) {
    return { paused: false, error: err.message };
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

// Mobile & Local Web Server IPC Handlers
ipcMain.handle('webserver:get-status', () => {
  try {
    return getEmbeddedWebServerStatus();
  } catch (err: any) {
    return {
      enabled: false,
      isRunning: false,
      port: 5173,
      primaryIp: 'localhost',
      primaryUrl: 'http://localhost:5173/',
      allUrls: [],
      error: err.message,
    };
  }
});

ipcMain.handle('webserver:set-settings', async (_event, settings: { enabled: boolean; port: number }) => {
  try {
    return await updateEmbeddedWebServerSettings(settings);
  } catch (err: any) {
    return {
      enabled: settings.enabled,
      isRunning: false,
      port: settings.port,
      primaryIp: 'localhost',
      primaryUrl: `http://localhost:${settings.port}/`,
      allUrls: [],
      error: err.message,
    };
  }
});

ipcMain.handle('webserver:get-pin', () => {
  try {
    return { pin: getOrCreatePin() };
  } catch (err: any) {
    return { pin: '', error: err.message };
  }
});

ipcMain.handle('webserver:regenerate-pin', () => {
  try {
    return { pin: regeneratePin() };
  } catch (err: any) {
    return { pin: '', error: err.message };
  }
});

ipcMain.handle('webserver:list-devices', () => {
  try {
    return listDevices();
  } catch {
    return [];
  }
});

ipcMain.handle('webserver:revoke-device', (_event, deviceId: string) => {
  try {
    return { success: revokeDevice(deviceId) };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('webserver:revoke-all-devices', () => {
  try {
    revokeAllDevices();
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('heic:prepare-hq', async (_event, filePath: string, photoId: string) => {
  try {
    return await prepareHeicHqTemp(filePath, photoId);
  } catch (err) {
    console.error('heic:prepare-hq error:', err);
    return null;
  }
});

ipcMain.handle('heic:cleanup-hq', async (_event, photoId: string) => {
  try {
    cleanupHeicHqTemp(photoId);
    return true;
  } catch (err) {
    console.error('heic:cleanup-hq error:', err);
    return false;
  }
});

ipcMain.handle('thumbnails:get-batch', async (_event, params: { items: Array<{ path: string; originalPath?: string }>; size?: number }) => {
  try {
    const { items, size } = params || {};
    const targetSize = typeof size === 'number' && size > 0 ? size : 250;
    const requestedItems = Array.isArray(items) ? items.slice(0, 100) : [];
    const thumbnails: Record<string, string> = {};

    await Promise.all(
      requestedItems.map(async (item) => {
        if (!item || !item.path) return;
        const targetPath = (item.path && fs.existsSync(item.path))
          ? item.path
          : (item.originalPath && fs.existsSync(item.originalPath) ? item.originalPath : null);

        if (!targetPath) return;

        try {
          const resThumb = await getOrGenerateCachedThumbnail(targetPath, targetSize);
          if (resThumb) {
            let buf: Buffer | null = resThumb.buffer || null;
            if (!buf && resThumb.filePath) {
              buf = await fs.promises.readFile(resThumb.filePath);
            }
            if (buf) {
              thumbnails[item.path] = `data:${resThumb.mime || 'image/jpeg'};base64,${buf.toString('base64')}`;
            }
          }
        } catch {}
      })
    );

    return { thumbnails };
  } catch (err: any) {
    console.error('thumbnails:get-batch error:', err);
    return { thumbnails: {} };
  }
});





