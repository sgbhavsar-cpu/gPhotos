// sharp + fs share libuv's default 4 threads; long resizes would otherwise starve UI file IO.
process.env.UV_THREADPOOL_SIZE ||= '16';
import { app, BrowserWindow, ipcMain, dialog, protocol, net, shell, Menu } from 'electron';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { parsePhotoMetadata } from './services/exifParser';
import {
  scanDirectoryRecursive,
  isVideoFile,
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
  rotatePhotoWithOfflineQueue,
  processPendingRotations,
  onRotationFailure,
  writePhotoMetadataWithOfflineQueue,
  processPendingMetadata,
  generateThumbnailBuffer,
  saveStorageCheckpoint,
  loadStorageCheckpoint,
  getAllStorageCheckpoints,
  scanStorageDetailsPhysical,
  isStorageSyncInProgress,
  getAllStorageDetailsFast,
  confirmAllStorageDetailsPhysical,
  syncOnePhoto,
  scanStorageInventory
} from './services/virtualMirrorService';
import { Photo, OrganizeOptions, VirtualStorageConfig, EditPhotoOptions, BackgroundServiceSettings, OrientationInput, OrientationResult, RelocationPhotoInput } from '../types';
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
  getOrGenerateHeicThumbnail500,
  getHeicHighQualityJpegBuffer,
  prepareHeicHqTemp,
  cleanupHeicHqTemp,
  getHeicFullResolutionBufferForDetection,
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
  flushWebAuthConfig,
} from './services/webAuthService';
import { getOrGenerateCachedThumbnail, refreshThumbnailsFromSource } from './services/thumbnailCacheService';
import {
  getCatalogMeta,
  getCatalogPage,
  switchCatalogLibrary,
  rescanLocalLibrary,
} from './services/catalogService';
import { handleStorageSave, handleStorageLoad } from './services/storageHandlers';
import {
  getPhotosByStorageName,
  getFacesForPhoto,
  getAllPeople,
  getSetting,
  getPhotoContentEntry,
  getAllPhotoContentEntries,
  upsertPhotoContentEntry,
} from './services/libraryRepository';
import type { PhotoContentEntry } from '../types';
import { getDbForLibraryPath } from './services/db';
import type { DatabaseSync } from 'node:sqlite';
import { detectFacesForPhoto, forceRedetectFacesForPhoto, resolveDbForPhoto, getSharedFaceClusterCache, type FaceClusterCache } from './services/pipelineOrchestrator';
import { detectFaceInRegion, terminateFaceDetectionWorker, getFaceDetectionPoolSize } from './services/faceDetectionWorkerClient';
import { assertPathsAllowed, isPathAllowed, getDefaultMirrorRoot } from './services/pathSecurity';
import { exportVideo, getFfmpegPath, probeMedia, makeAudioPreview } from './services/videoExportService';
import { getOrGenerateVideoPreview } from './services/videoPreviewService';
import { serveFileWithRangeSupport } from './services/rangeFileServer';
import { resolveYtDlp, installYtDlp, downloadYouTubeAudio } from './services/ytDlpService';
import { fetchMusicTrack, listCachedTrackIds } from './services/musicLibraryService';
import { findMusicTrack } from '../types/musicCatalog';
import { ollamaRequest, ollamaPull, type OllamaRequest } from './services/ollamaClient';
import type { VideoExportRequest } from '../types';
import { detectUprightRotations } from './services/orientationService';
import { planRelocation, relocatePhotos } from './services/photoRelocation';
import { browseDirectory } from './services/directoryBrowser';
import {
  getSpriteCoordinate,
  getSpriteCoordinatesBatch,
  getSpritePath,
  invalidateSpriteCoordinate,
} from './services/spriteService';
import { thumbnailWorker } from './services/thumbnailWorkerService';
import { libraryStatusService } from './services/libraryStatusService';
import { isPathReachable, isPathReachableForServing, clearOfflineCache } from './services/networkReachabilityCache';
import { installHangWatchdog, attachRendererHangDetection } from './services/hangWatchdog';
import { initLogger, applyStoredLogLevelOverride, getLogLevelOverride, setLogLevelOverride, logger } from './services/logger';
import { getPersonAvatarPath, savePersonAvatar, deletePersonAvatar } from './services/personAvatarService';
import { getAvatarSprites } from './services/avatarSpriteService';
import {
  getOneDriveStatus,
  setReclaimEnabled,
  markFilesForSpaceReclaim,
  runReclaimHealthCheck,
  getReclaimHealth,
  resetReclaimHealth,
} from './services/oneDriveService';

// Smoke-test userData redirect and the single-instance check must run BEFORE the logger
// starts: initLogger rotates main.log, which would otherwise touch the real (or the
// already-running instance's) log files.
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
} else {
  initLogger();
  installHangWatchdog();
  // A queued original-photo rotation that never made it (unsupported format, or persistently
  // failing) after its local thumbnail was already optimistically rotated — forward it to the
  // renderer as a toast + a thumbnail refresh, so the grid stops showing pixels the real file never
  // actually matched.
  onRotationFailure((info) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('photo:rotation-failed', info);
    }
  });
}

app.name = 'gPhotos';
app.setName('gPhotos');
if (process.platform === 'win32') {
  app.setAppUserModelId('gPhotos');
}

const startupStartTime = Date.now();
console.log(`[STARTUP AUDIT] T+0ms: Main process initialized.`);

// Global Exception and Promise Rejection Handlers to eliminate unhandled errors
// Errors are written to main.log (a packaged app has no console) and the user
// is told at most once a minute, so a failing timer can't spam dialogs.
let lastErrorDialogAt = 0;
function reportUnexpectedError(kind: string, err: unknown) {
  const detail = String((err as any)?.stack || err);
  console.error(`[CRITICAL MAIN PROCESS ${kind}]:`, err);
  try {
    logger.error('Fatal', kind, { err: detail });
  } catch {}
  const now = Date.now();
  if (app.isReady() && now - lastErrorDialogAt > 60_000) {
    lastErrorDialogAt = now;
    dialog
      .showMessageBox({
        type: 'error',
        title: 'gPhotos - Unexpected Error',
        message: `An unexpected error occurred (${kind}). If problems continue, restart gPhotos.`,
        detail: detail.slice(0, 600),
        buttons: ['OK'],
      })
      .catch(() => {});
  }
}
process.on('uncaughtException', (error) => reportUnexpectedError('EXCEPTION', error));
process.on('unhandledRejection', (reason) => reportUnexpectedError('UNHANDLED REJECTION', reason));

// A storage name becomes a directory under the mirror root. Reject anything that
// resolves to the root itself (".") or escapes it, so recursive create/delete
// stays inside one storage folder.
function assertValidStorageName(root: string, name: unknown): string {
  if (typeof name !== 'string' || !name.trim() || /[\\/]/.test(name)) {
    throw new Error(`Invalid storage name: "${String(name)}"`);
  }
  const rel = path.relative(root, path.join(root, name));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Invalid storage name: "${name}"`);
  }
  return name;
}

// Single Instance Lock: Ensure only one copy of application runs in production, while allowing isolated smoke tests
if (gotSingleInstanceLock && !isSmokeTest) {
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

const IMAGE_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.heic': 'image/jpeg',
  '.heif': 'image/jpeg',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.avif': 'image/avif',
  '.dng': 'image/jpeg',
  '.raw': 'image/jpeg',
  '.cr2': 'image/jpeg',
  '.nef': 'image/jpeg',
};

// Video library items (see docs/FEATURE_VIDEO_LIBRARY_SUPPORT.md) — served through the SAME
// gphoto:// protocol as photos, but via the Range-aware branch below (§2.6), never the
// whole-file-into-memory image branches: a <video> element needs Range support to seek.
const VIDEO_MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.avi': 'video/x-msvideo',
  '.wmv': 'video/x-ms-wmv',
  '.m4v': 'video/x-m4v',
};

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
      // The renderer's idle timer + face queue drive background scanning via
      // setTimeout; a minimized/hidden window otherwise throttles those to
      // ~1 tick/min, so a scan left running "in the background" crawled.
      backgroundThrottling: false,
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

  attachRendererHangDetection(mainWindow, 'main');

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
  // createWindow can run again (macOS activate, second-instance); protocol.handle throws on re-register.
  if (!protocol.isProtocolHandled('gphoto')) protocol.handle('gphoto', async (request) => {
    try {
      const url = new URL(request.url);

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
      // Clamped: every distinct size creates its own cache tier on disk.
      const requestedSize = sizeParam ? Math.min(Math.max(parseInt(sizeParam, 10) || 0, 0), 2048) : 0;
      const quality = url.searchParams.get('quality');

      let targetPath: string | null = null;
      // When network storage source is available, serve original high-res photo!
      // isPathReachable (not fs.existsSync) is what keeps an offline network
      // share from hanging the whole app: it bounds each check to ~1.5s and,
      // once a storage is found offline, skips checking it again for a
      // while instead of blocking on the OS's full network timeout on
      // every single photo request.
      // App-owned local files (avatars, mirror thumbnails) skip the timeout
      // race — see isPathReachableForServing for why it caused permanent 404s.
      const appOwnedRoots = [app.getPath('userData'), getDefaultMirrorRoot()];
      if (preferOriginal && originalPath && (await isPathReachableForServing(originalPath, appOwnedRoots))) {
        targetPath = originalPath;
      } else if (filePath && (await isPathReachableForServing(filePath, appOwnedRoots))) {
        targetPath = filePath;
      } else if (originalPath && (await isPathReachableForServing(originalPath, appOwnedRoots))) {
        targetPath = originalPath;
      }

      if (targetPath) {
        const ext = path.extname(targetPath).toLowerCase();
        // Only image/video files are ever served: this scheme has bypassCSP + CORS *, so it
        // must not be usable to read arbitrary files (keys, library.json, ...).
        if (!IMAGE_MIME[ext] && !VIDEO_MIME[ext]) return new Response('Unsupported file type', { status: 403 });

        // Video playback — only when the caller actually asked for the original (preferOriginal,
        // exactly like a full-res photo request), Range-aware so a <video> element can seek
        // (§2.6 of the feature doc). A plain thumbnail request for a video (preferOriginal
        // false, the grid's normal getLocalPhotoUrl call) falls through to the SAME cached-
        // thumbnail branch below as any photo — getOrGenerateCachedThumbnail already knows how
        // to extract a JPEG frame for a video source — so that branch is unchanged.
        if (VIDEO_MIME[ext] && preferOriginal) {
          return serveFileWithRangeSupport(targetPath, VIDEO_MIME[ext], request.headers.get('range'));
        }

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

          const buffer = await fs.promises.readFile(targetPath);
          return new Response(buffer, {
            headers: {
              'Content-Type': IMAGE_MIME[ext],
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

        // 3. Fallback direct file read — image sources only. A video whose thumbnail couldn't be
        // generated (corrupt file) has no meaningful raw-bytes fallback as a "thumbnail" response.
        if (!IMAGE_MIME[ext]) return new Response('Thumbnail could not be generated', { status: 404 });
        const buffer = await fs.promises.readFile(targetPath);
        return new Response(buffer as any, {
          headers: {
            'Content-Type': IMAGE_MIME[ext],
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

  // If the UI can't load (missing dist, dev server down) the always-on-top splash
  // would stay forever with no window behind it: tell the user and get out of the way.
  const onLoadFailure = (err: unknown) => {
    reportUnexpectedError('UI LOAD FAILURE', err);
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
  };
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (isMainFrame && code !== -3) onLoadFailure(new Error(`${desc} (${code}) loading ${url}`));
  });
  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL).catch(onLoadFailure);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../../dist/index.html')).catch(onLoadFailure);
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Initialize System Tray and background scanning daemon
  initBackgroundDaemon(mainWindow);
}

app.on('before-quit', () => {
  for (const step of [markAsQuitting, stopEmbeddedWebServer, flushWebAuthConfig, () => thumbnailWorker.flushCheckpoint(), terminateFaceDetectionWorker]) {
    try {
      step();
    } catch (err) {
      console.warn('[Quit] shutdown step failed:', err);
    }
  }
});

app.whenReady().then(() => {
  if (!gotSingleInstanceLock) return;
  applyStoredLogLevelOverride();

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
}).catch((err) => reportUnexpectedError('STARTUP FAILURE', err));

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

// Renderer -> main log bridge (see docs/PIPELINE_REDESIGN_DEV_DOC.md §3.8):
// fire-and-forget so a debug log call from the renderer never adds IPC
// round-trip latency to whatever action triggered it.
ipcMain.on('logger:write', (_event, level: 'debug' | 'info' | 'warn' | 'error', scope: string, message: string, meta?: Record<string, unknown>) => {
  if (level !== 'debug' && level !== 'info' && level !== 'warn' && level !== 'error') return;
  try {
    logger[level](scope, message, meta);
  } catch {}
});

ipcMain.handle('logger:get-level-override', async () => {
  try {
    return getLogLevelOverride();
  } catch (err) {
    logger.error('Logger', 'Failed to read log level override setting', { err: String(err) });
    return false;
  }
});

ipcMain.handle('logger:set-level-override', async (_event, overrideDebug: boolean) => {
  try {
    setLogLevelOverride(overrideDebug);
    logger.info('Logger', `Debug logging override set to ${overrideDebug}`);
    return true;
  } catch (err) {
    logger.error('Logger', 'Failed to set log level override setting', { err: String(err) });
    return false;
  }
});

// Worked example of the standard error-handling/logging pattern documented
// in logger.ts: debug-level entry/exit for the user action, error-level +
// {success:false} shape on failure, so it's always visible in the log file
// (not just console) without any commented-out debug code.
ipcMain.handle('dialog:select-directory', async () => {
  logger.debug('Dialog', 'User requested folder picker (select-directory)');
  try {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: 'Select Folder',
    });
    if (result.canceled || result.filePaths.length === 0) {
      logger.debug('Dialog', 'Folder picker canceled by user');
      return null;
    }
    logger.debug('Dialog', 'Folder picker selection made', { selectedPath: result.filePaths[0] });
    return result.filePaths[0];
  } catch (err) {
    logger.error('Dialog', 'select-directory failed', { err: String(err) });
    return null;
  }
});

ipcMain.handle('scanner:scan-directory', async (_event, dirPath: string): Promise<Photo[]> => {
  try {
    const filePaths = await scanDirectoryRecursive(dirPath);
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

        const isVideo = isVideoFile(filePath);
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
        // This handler builds its own Photo objects rather than reusing fileOrganizer's
        // scanPhotoDirectory (a separate, duplicated implementation — see
        // docs/FEATURE_VIDEO_LIBRARY_SUPPORT.md for the equivalent fix in that one), so video
        // support needs the same isVideo/videoDurationSec handling applied here too.
        if (isVideo) {
          photo.isVideo = true;
          try {
            const info = await probeMedia(filePath);
            if (info.durationSec != null) photo.videoDurationSec = info.durationSec;
          } catch {}
        }

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

// Serialized save queue to guarantee atomic sequential writes without race conditions
let savePromiseQueue: Promise<boolean> = Promise.resolve(true);

ipcMain.handle('storage:save', async (_event, key: string, data: any) => {
  const op = async (): Promise<boolean> => {
    try {
      const result = handleStorageSave(key, data);
      if (result.enqueuePhotos) {
        thumbnailWorker.enqueuePhotos(result.enqueuePhotos, result.enqueueLibraryPath || undefined);
      }
      return result.success;
    } catch (err) {
      console.error('Failed to save library data:', err);
      logger.error('Storage', `Failed to save "${key}"`, { err: String((err as any)?.stack || err) });
      return false;
    }
  };

  savePromiseQueue = savePromiseQueue.then(op, op);
  return savePromiseQueue;
});

ipcMain.handle('storage:load', async (_event, key: string, libraryDir?: string, options?: { includePhotos?: boolean; compactDescriptors?: boolean }) => {
  try {
    return await handleStorageLoad(key, libraryDir, options);
  } catch (err) {
    // Rethrown (not null): a failed load must not look like an empty library, or the
    // renderer would save that emptiness over the real data.
    console.error('Failed to load library data:', err);
    logger.error('Storage', `Failed to load "${key}"`, { err: String((err as any)?.stack || err) });
    throw err;
  }
});

// 500K Scalable Catalog & Sprite IPC Handlers
ipcMain.handle('catalog:get-meta', async (_event, customDir?: string) => {
  try {
    return await getCatalogMeta(customDir);
  } catch (err) {
    console.error('catalog:get-meta error:', err);
    logger.error('Catalog', 'get-meta failed', { err: String((err as any)?.stack || err) });
    throw err;
  }
});

ipcMain.handle(
  'catalog:get-page',
  async (_event, params: { pageIndex: number; pageSize?: number; libraryDir?: string }) => {
    try {
      return await getCatalogPage(params.pageIndex, params.pageSize, params.libraryDir);
    } catch (err) {
      console.error('catalog:get-page error:', err);
      logger.error('Catalog', 'get-page failed', { err: String((err as any)?.stack || err) });
      throw err;
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
    logger.error('Catalog', 'switch-library failed', { err: String((err as any)?.stack || err) });
    return null;
  }
});

// Re-walks an already-indexed local library's folder on disk (see catalogService.rescanLocalLibrary's
// doc comment) — the local-library counterpart to "Rescan" on a virtual/network mirror, needed so an
// existing local library can pick up newly-supported file types (e.g. videos) added after it was
// first opened, since nothing else watches an arbitrary local folder for changes.
ipcMain.handle('catalog:rescan-library', async (_event, targetPath: string) => {
  try {
    const res = await rescanLocalLibrary(targetPath);
    if (res && res.firstPage && res.firstPage.length > 0) {
      thumbnailWorker.enqueuePhotos(res.firstPage);
    }
    return res;
  } catch (err) {
    console.error('catalog:rescan-library error:', err);
    logger.error('Catalog', 'rescan-library failed', { err: String((err as any)?.stack || err) });
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

ipcMain.handle('sprite:get-coordinates-batch', async (_event, photoPaths: string[]) => {
  try {
    return getSpriteCoordinatesBatch(Array.isArray(photoPaths) ? photoPaths : []);
  } catch {
    return {};
  }
});

ipcMain.handle('sprite:invalidate', async (_event, photoPath: string) => {
  try {
    invalidateSpriteCoordinate(photoPath);
    return true;
  } catch (err) {
    console.error('sprite:invalidate error:', err);
    return false;
  }
});

// Virtual Mirror & Network Storage Handlers
ipcMain.handle('mirror:sync-storage', async (event, config: VirtualStorageConfig) => {
  try {
    // A manual sync/rescan IS the user explicitly asking to check this
    // storage again — clear any cached "known offline" flag so the
    // reachability checks below actually probe it fresh, instead of
    // skipping straight to "offline" from a stale earlier result. The
    // periodic background sync cycle deliberately does NOT do this, so an
    // offline storage stays skipped there until the user does this.
    if (config.networkSourcePath) {
      clearOfflineCache(config.networkSourcePath);
    }
    const result = await syncVirtualStorage(config, (progress) => {
      try {
        event.sender.send('mirror:progress', progress);
      } catch {}
    });

    try {
      const storageMirrorRoot = path.join(config.localMirrorRoot, config.name);
      const mirroredPhotos = await scanVirtualMirrorDirectory(storageMirrorRoot);
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
    const photos = await scanVirtualMirrorDirectory(mirrorDirPath);
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

ipcMain.handle('mirror:get-default-root', async () => {
  return getDefaultMirrorRoot();
});

ipcMain.handle('fs:browse-directory', async (_event, targetPath?: string) => {
  return browseDirectory(targetPath);
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
    return await scanStorageDetailsPhysical(storageName, mirrorRoot); // async listing walk: never blocks the main thread
  } catch (err) {
    console.error('mirror:get-storage-details error:', err);
    return null;
  }
});

ipcMain.handle('mirror:get-all-storage-details', async (_event, mirrorRoot?: string) => {
  try {
    return await confirmAllStorageDetailsPhysical(mirrorRoot);
  } catch (err) {
    console.error('mirror:get-all-storage-details error:', err);
    return {};
  }
});

// Checkpoint/SQLite-only version of the above — no sidecar-folder walk, safe
// to poll frequently (see getStorageDetailsFast's doc comment).
ipcMain.handle('mirror:get-all-storage-details-fast', async (_event, mirrorRoot?: string) => {
  try {
    return getAllStorageDetailsFast(mirrorRoot);
  } catch (err) {
    console.error('mirror:get-all-storage-details-fast error:', err);
    return {};
  }
});

// One-time, yielding physical confirmation pass — run once after the
// storage screen's initial fast load, not on any recurring poll.
ipcMain.handle('mirror:confirm-all-storage-details-physical', async (_event, mirrorRoot?: string) => {
  try {
    return await confirmAllStorageDetailsPhysical(mirrorRoot);
  } catch (err) {
    console.error('mirror:confirm-all-storage-details-physical error:', err);
    return {};
  }
});

// Unified pipeline (see docs/PIPELINE_REDESIGN_DEV_DOC.md §3.3): the renderer
// calls this after syncVirtualStorage to pick up faces the pipeline already
// wrote straight to SQLite, without re-reading the whole library.
ipcMain.handle('mirror:get-photos-by-storage', async (_event, storageName: string, mirrorRoot?: string) => {
  try {
    // Each virtual storage has its own database at
    // <mirrorRoot>/<name>/.gphotos_catalog/gphotos.db (see
    // pipelineOrchestrator.ts's runFaceDetectionStep, which writes there) —
    // must resolve the SAME path here, not the ambient active library, or
    // this returns stale/empty results right after a sync.
    const mirrorFolder = path.join(mirrorRoot || getDefaultMirrorRoot(), storageName);
    return getPhotosByStorageName(storageName, getDbForLibraryPath(mirrorFolder));
  } catch (err) {
    logger.error('Pipeline', 'mirror:get-photos-by-storage failed', { storageName, err: String(err) });
    return [];
  }
});

// Bulk face detection for local (or already-thumbnailed virtual) photos —
// the engine runs off the main thread in a worker (see faceDetectionEngine.ts
// + faceDetectionWorkerClient.ts), so this replaces the renderer's old
// face-api.js-driven loop everywhere EXCEPT the virtual-storage sync
// pipeline, which calls pipelineOrchestrator.ts's detectFacesForPhoto
// directly per photo instead of round-tripping one at a time over IPC (see
// syncVirtualStorage).
// Moving photos to another folder of their own library / storage (photoRelocation.ts). The renderer asks for a plan
// first (which folder they live in, which can move), lets the user pick a destination inside it, then moves.
ipcMain.handle('photos:plan-relocation', async (_event, photos: RelocationPhotoInput[]) => {
  try {
    if (!Array.isArray(photos)) throw new Error('photos must be a list');
    return await planRelocation(photos);
  } catch (err: any) {
    console.error('photos:plan-relocation error:', err);
    logger.error('Relocation', 'plan failed', { err: String(err?.stack || err) });
    throw err;
  }
});

ipcMain.handle('photos:relocate', async (event, params: { photos: RelocationPhotoInput[]; targetDir: string }) => {
  try {
    if (!params || !Array.isArray(params.photos) || typeof params.targetDir !== 'string') throw new Error('invalid request');
    // A sync running at the same moment would act on the old folder layout and undo or duplicate the move.
    const storages = getSetting<VirtualStorageConfig[]>('gphotos_virtual_storages_v1', []);
    const busy = storages.find(
      (s) => s.localMirrorRoot && params.photos.some((p) => p.isVirtual && p.storageName === s.name) && isStorageSyncInProgress(s.localMirrorRoot, s.name)
    );
    if (busy) {
      return { results: [], root: null, error: `A sync of "${busy.name}" is running right now. Wait for it to finish, then try again.` };
    }
    const outcome = await relocatePhotos({
      photos: params.photos,
      targetDir: params.targetDir,
      onProgress: (done, total) => {
        try {
          if (!event.sender.isDestroyed()) event.sender.send('photos:relocate-progress', { done, total });
        } catch {}
      },
    });
    const moved = outcome.results.filter((r) => r.status === 'moved').length;
    logger.info('Relocation', `Moved ${moved} of ${outcome.results.length} photo(s)`, { targetDir: params.targetDir, error: outcome.error });
    return outcome;
  } catch (err: any) {
    console.error('photos:relocate error:', err);
    logger.error('Relocation', 'relocate failed', { err: String(err?.stack || err) });
    throw err;
  }
});

// Automatic "make it upright": which way must each photo turn so the people in it are upright (faces at all four
// orientations). Read-only: nothing is rotated here — the renderer applies rotations through photo:rotate.
ipcMain.handle('photos:detect-orientation', async (event, photos: OrientationInput[]) => {
  try {
    if (!Array.isArray(photos)) throw new Error('photos must be a list');
    const usable = photos.filter((p) => p && typeof p.id === 'string' && typeof p.filePath === 'string');
    const allowed = usable.filter((p) => isPathAllowed(p.filePath));
    const denied: OrientationResult[] = usable
      .filter((p) => !isPathAllowed(p.filePath))
      .map((p) => ({ id: p.id, status: 'failed', rotation: 0, confidence: 0, faces: 0, reason: 'outside the known library folders' }));
    const results = await detectUprightRotations(allowed, (done, total) => {
      try {
        if (!event.sender.isDestroyed()) event.sender.send('photos:orientation-progress', { done, total });
      } catch {}
    });
    return [...results, ...denied];
  } catch (err: any) {
    console.error('photos:detect-orientation error:', err);
    logger.error('Orientation', 'detect-orientation failed', { err: String(err?.stack || err) });
    throw err;
  }
});

// Paths the user explicitly picked in the native save dialog. Those may be anywhere on disk (like every
// other native-dialog pick in this app), so they're remembered here and accepted by video:export even
// though they aren't under a known library root; anything else must pass the normal allow-list.
const userApprovedVideoOutputs = new Set<string>();

ipcMain.handle('video:choose-output-path', async (_event, suggestedName: string) => {
  try {
    if (!mainWindow) return null;
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Save Video As',
      defaultPath: suggestedName || 'video.mp4',
      filters: [{ name: 'MP4 Video', extensions: ['mp4'] }],
    });
    if (result.canceled || !result.filePath) return null;
    userApprovedVideoOutputs.add(result.filePath);
    return result.filePath;
  } catch (err) {
    console.error('video:choose-output-path error:', err);
    return null;
  }
});

// ---- Video music: a picked file or a YouTube download (see ytDlpService.ts) ----
// Like the save dialog above, a file the user picked in the native dialog (or that we just downloaded)
// may live anywhere, so those paths are remembered and accepted by audio:preview / video:export.
const userApprovedAudioFiles = new Set<string>();
const audioInfo = async (filePath: string) => ({ filePath, name: path.basename(filePath), durationSec: (await probeMedia(filePath)).durationSec });

ipcMain.handle('audio:choose-file', async () => {
  try {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose music for the video',
      properties: ['openFile'],
      filters: [{ name: 'Audio', extensions: ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus', 'wma'] }, { name: 'All files', extensions: ['*'] }],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const filePath = result.filePaths[0];
    userApprovedAudioFiles.add(filePath);
    return await audioInfo(filePath);
  } catch (err) {
    console.error('audio:choose-file error:', err);
    return null;
  }
});

ipcMain.handle('audio:preview', async (_event, filePath: string, startSec: number, endSec: number | null) => {
  try {
    if (typeof filePath !== 'string' || !userApprovedAudioFiles.has(filePath)) return null;
    return await makeAudioPreview(filePath, Number(startSec) || 0, endSec == null ? null : Number(endSec));
  } catch (err) {
    console.error('audio:preview error:', err);
    return null;
  }
});

ipcMain.handle('audio:ytdlp-status', async () => (await resolveYtDlp(app.getPath('userData'))).status);

let currentAudioFetchAbort: AbortController | null = null;

ipcMain.handle('audio:ytdlp-install', async (event) => {
  if (currentAudioFetchAbort) return { ok: false, error: 'Another download is already running.' };
  const controller = new AbortController();
  currentAudioFetchAbort = controller;
  try {
    const r = await installYtDlp({
      userDataDir: app.getPath('userData'),
      signal: controller.signal,
      onProgress: (pct) => { try { if (!event.sender.isDestroyed()) event.sender.send('audio:fetch-progress', { kind: 'install', pct }); } catch {} },
    });
    logger.info('YtDlp', `Install: ${r.ok ? 'ok ' + (r.version || '') : 'failed'}`, { error: r.error });
    return r;
  } finally {
    if (currentAudioFetchAbort === controller) currentAudioFetchAbort = null;
  }
});

ipcMain.handle('audio:youtube-download', async (event, url: string) => {
  if (typeof url !== 'string') return { ok: false, error: 'Invalid link.' };
  if (currentAudioFetchAbort) return { ok: false, error: 'Another download is already running.' };
  const controller = new AbortController();
  currentAudioFetchAbort = controller;
  try {
    const { launcher, status } = await resolveYtDlp(app.getPath('userData'));
    if (!status.installed) return { ok: false, error: 'yt-dlp is not installed yet.' };
    const r = await downloadYouTubeAudio({
      url,
      outDir: path.join(app.getPath('userData'), 'audio_downloads'),
      launcher,
      ffmpegPath: getFfmpegPath(),
      signal: controller.signal,
      onProgress: (pct) => { try { if (!event.sender.isDestroyed()) event.sender.send('audio:fetch-progress', { kind: 'download', pct }); } catch {} },
    });
    if (!r.ok || !r.filePath) {
      logger.warn('YtDlp', 'YouTube audio download failed', { error: r.error });
      return { ok: false, error: r.error };
    }
    userApprovedAudioFiles.add(r.filePath);
    return { ok: true, file: await audioInfo(r.filePath) };
  } finally {
    if (currentAudioFetchAbort === controller) currentAudioFetchAbort = null;
  }
});

ipcMain.handle('music:cached', async () => listCachedTrackIds(app.getPath('userData')));

ipcMain.handle('music:fetch-track', async (event, trackId: string) => {
  const track = typeof trackId === 'string' ? findMusicTrack(trackId) : undefined;
  if (!track) return { ok: false, error: 'Unknown track.' };
  if (currentAudioFetchAbort) return { ok: false, error: 'Another download is already running.' };
  const controller = new AbortController();
  currentAudioFetchAbort = controller;
  try {
    const userDataDir = app.getPath('userData');
    const r = await fetchMusicTrack({
      userDataDir, track, signal: controller.signal,
      onProgress: (pct) => { try { if (!event.sender.isDestroyed()) event.sender.send('audio:fetch-progress', { kind: 'download', pct }); } catch {} },
    });
    if (!r.ok || !r.filePath) return { ok: false, error: r.error };
    const info = await probeMedia(r.filePath);
    if (!info.hasAudio) { // a damaged / replaced file must not stay cached
      try { fs.rmSync(r.filePath, { force: true }); } catch {}
      return { ok: false, error: `"${track.title}" did not download correctly — please try again.` };
    }
    userApprovedAudioFiles.add(r.filePath);
    return { ok: true, file: { filePath: r.filePath, name: `${track.title}.mp3`, durationSec: info.durationSec } };
  } finally {
    if (currentAudioFetchAbort === controller) currentAudioFetchAbort = null;
  }
});

ipcMain.handle('audio:youtube-cancel', async () => {
  currentAudioFetchAbort?.abort();
  return true;
});

// A shortened Google Maps link (maps.app.goo.gl, goo.gl/maps/…) carries no coordinates of its own —
// only the destination it redirects to does. Resolved here (not the renderer): the redirect target is
// a plain google.com URL with no CORS allowance, so a renderer `fetch` can't read `response.url` back;
// Node's fetch has no CORS concept at all and just follows the chain.
ipcMain.handle('location:resolve-maps-url', async (_event, url: string) => {
  try {
    if (typeof url !== 'string' || !url.trim()) return { ok: false, error: 'No link given.' };
    const res = await fetch(url.trim(), { redirect: 'follow' });
    return { ok: true, resolvedUrl: res.url };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
});

// Single-flight: the wizard only ever has one export running at a time, so one module-level
// controller is enough to let a later cancel call reach the render currently in progress.
let currentVideoExportAbort: AbortController | null = null;

ipcMain.handle('video:export', async (event, request: VideoExportRequest) => {
  try {
    const photoPaths = request.slides.flatMap((s) => s.photoPaths || []);
    assertPathsAllowed(photoPaths, 'video:export');
    if (typeof request.outputPath !== 'string' || !/.mp4$/i.test(request.outputPath)) throw new Error('The output file must be an .mp4 path.');
    if (!userApprovedVideoOutputs.has(request.outputPath)) assertPathsAllowed([request.outputPath], 'video:export');
    if (request.audio && !userApprovedAudioFiles.has(request.audio.filePath)) throw new Error('The chosen music file was not picked through the app.');

    const tempDir = path.join(os.tmpdir(), 'gphotos_video_export', `job_${Date.now()}`);
    const controller = new AbortController();
    currentVideoExportAbort = controller;
    try {
      return await exportVideo(
        { ...request, tempDir },
        (p) => {
          try {
            if (!event.sender.isDestroyed()) event.sender.send('video:export-progress', p);
          } catch {}
        },
        controller.signal
      );
    } finally {
      if (currentVideoExportAbort === controller) currentVideoExportAbort = null;
    }
  } catch (err: any) {
    console.error('video:export error:', err);
    logger.error('VideoExport', 'export failed', { err: String(err?.stack || err) });
    return { success: false, error: err.message || 'Video export failed', skippedSlides: 0 };
  }
});

ipcMain.handle('video:cancel-export', async () => {
  currentVideoExportAbort?.abort();
  return true;
});

// ---- Local Ollama (see ollamaClient.ts: why this is main-process only) ----
ipcMain.handle('ollama:request', async (_event, req: OllamaRequest) => {
  if (!req || typeof req.baseUrl !== 'string' || typeof req.path !== 'string') return { ok: false, status: 0, error: 'Invalid Ollama request.' };
  return ollamaRequest({ baseUrl: req.baseUrl, path: req.path, method: req.method, body: req.body, timeoutMs: req.timeoutMs });
});

// One download per model name at a time; a second click on the same model just reports the first one's result.
const ollamaPulls = new Map<string, AbortController>();

ipcMain.handle('ollama:pull', async (event, baseUrl: string, model: string) => {
  if (typeof baseUrl !== 'string' || typeof model !== 'string' || !model.trim()) return { result: 'failed', error: 'Invalid download request.' };
  if (ollamaPulls.has(model)) return { result: 'failed', error: `"${model}" is already downloading.` };
  const controller = new AbortController();
  ollamaPulls.set(model, controller);
  try {
    const outcome = await ollamaPull(baseUrl, model, (e) => {
      try {
        if (!event.sender.isDestroyed()) event.sender.send('ollama:pull-progress', { model, ...e });
      } catch {}
    }, controller.signal);
    logger.info('Ollama', `Download of "${model}": ${outcome.result}`, { error: outcome.error });
    return outcome;
  } finally {
    ollamaPulls.delete(model);
  }
});

ipcMain.handle('ollama:cancel-pull', async (_event, model: string) => {
  ollamaPulls.get(model)?.abort();
  return true;
});

ipcMain.handle('video:open-file', async (_event, filePath: string) => {
  try {
    if (!userApprovedVideoOutputs.has(filePath)) assertPathsAllowed([filePath], 'video:open-file');
    const err = await shell.openPath(filePath);
    return !err;
  } catch (err) {
    console.error('video:open-file error:', err);
    return false;
  }
});

ipcMain.handle('faces:detect-batch', async (_event, allPhotos: Photo[]) => {
  // A video file is never face-scanned (see docs/FEATURE_VIDEO_LIBRARY_SUPPORT.md §2.7) — filtered
  // centrally here rather than at every caller, since every caller routes through this one handler.
  const photos = allPhotos.filter((p) => !p.isVideo);
  const results: Array<{ photoId: string; ran: boolean; faceCount: number; locked: boolean; skippedReason?: string; faces: any[] }> = [];
  // Keyed by resolved db rather than shared as one cache — a batch can span
  // more than one library/storage (each with its own faces table), and a
  // cache built from one library's faces must never be used to cluster
  // another's. See createFaceClusterCache's doc comment for why this exists.
  const cachesByDb = new Map<DatabaseSync, FaceClusterCache>();

  async function runOne(photo: Photo) {
    try {
      const sourceFilePath = photo.isVirtual ? (photo.originalRemotePath || photo.filePath) : photo.filePath;
      // resolveDbForPhoto, not the ambient active-library pointer — see its
      // doc comment in pipelineOrchestrator.ts. This loop awaits real file
      // I/O and ONNX inference per photo, during which the active library
      // can legitimately change out from under a naive getDb() call.
      const db = resolveDbForPhoto(photo);
      let cache = cachesByDb.get(db);
      if (!cache) {
        cache = getSharedFaceClusterCache(db);
        cachesByDb.set(db, cache);
      }
      const result = await detectFacesForPhoto(photo, sourceFilePath, db, cache);
      results.push({ photoId: photo.id, ...result, faces: getFacesForPhoto(photo.id, db) });
    } catch (err) {
      logger.error('Pipeline', 'faces:detect-batch item failed', { photoId: photo.id, err: String(err) });
      results.push({ photoId: photo.id, ran: false, faceCount: 0, locked: false, skippedReason: 'decode-failed', faces: [] });
    }
  }

  // Dispatched in chunks matching the face-detection worker pool size
  // (1 outside Turbo Mode — identical to the old strictly-sequential loop;
  // Turbo Mode raises the pool size so multiple photos' ONNX inference runs
  // on separate cores at once). Safe to run concurrently: everything after
  // each photo's single `await` is synchronous (see detectFacesForPhoto),
  // so the per-db cluster cache is never touched by two photos at once —
  // JS's run-to-completion semantics make that section atomic.
  const chunkSize = Math.max(1, getFaceDetectionPoolSize());
  for (let i = 0; i < photos.length; i += chunkSize) {
    await Promise.all(photos.slice(i, i + chunkSize).map(runOne));
  }

  return { results, people: getAllPeople() };
});

// Per-photo forced re-scan (requirement: a locked photo only unlocks when
// the user explicitly asks to rescan it, via a "Detect Faces" button).
ipcMain.handle('faces:detect-one-forced', async (_event, photo: Photo) => {
  try {
    const result = await forceRedetectFacesForPhoto(photo);
    // Same database forceRedetectFacesForPhoto itself resolved and wrote
    // to (resolveDbForPhoto) — NOT getDb()'s ambient pointer, which can
    // have moved on by the time this read-back runs (see resolveDbForPhoto's
    // doc comment for the exact failure this caused: "1 face detected" with
    // no marker or people-panel entry to show for it).
    const db = resolveDbForPhoto(photo);
    const readBackFaces = getFacesForPhoto(photo.id, db);
    logger.info('Pipeline', 'faces:detect-one-forced: returning to renderer', {
      photoId: photo.id,
      storageName: photo.storageName,
      resultFaceCount: result.faceCount,
      readBackFacesLength: readBackFaces.length,
      readBackFaceIds: readBackFaces.map((f) => f.id),
      locked: result.locked,
      ran: result.ran,
      skippedReason: result.skippedReason,
    });
    return { ...result, faces: readBackFaces, people: getAllPeople() };
  } catch (err) {
    logger.error('Pipeline', 'faces:detect-one-forced failed', { photoId: photo.id, err: String(err) });
    return { ran: false, faceCount: 0, locked: false, skippedReason: 'decode-failed', faces: [], people: [] };
  }
});

// Manual face tagging: computes a descriptor for a user-drawn box (backs
// PhotoLightbox's "draw a box around a missed face" flow) by re-running
// detection constrained to just that region of the full-resolution source.
ipcMain.handle('faces:compute-descriptor-for-region', async (
  _event,
  sourceFilePath: string,
  box: { x: number; y: number; width: number; height: number }
) => {
  try {
    const buffer = /\.(heic|heif)$/i.test(sourceFilePath)
      ? await getHeicFullResolutionBufferForDetection(sourceFilePath)
      : await fs.promises.readFile(sourceFilePath);
    if (!buffer) return null;
    const face = await detectFaceInRegion(buffer, box);
    return face ? { descriptor: face.descriptor, confidence: face.confidence } : null;
  } catch (err) {
    logger.error('Pipeline', 'faces:compute-descriptor-for-region failed', { sourceFilePath, err: String(err) });
    return null;
  }
});

// Inventory gate (see docs/PIPELINE_REDESIGN_DEV_DOC.md §3.2): counts every
// eligible file under a storage's source path before any processing starts.
ipcMain.handle('mirror:scan-inventory', async (_event, networkSourcePath: string) => {
  logger.debug('Inventory', 'Starting inventory scan', { networkSourcePath });
  try {
    const result = await scanStorageInventory(networkSourcePath);
    logger.info('Inventory', 'Inventory scan finished', { networkSourcePath, ...result });
    return result;
  } catch (err) {
    logger.error('Inventory', 'Inventory scan failed', { networkSourcePath, err: String(err) });
    return { status: 'failed', totalFiles: 0, error: String(err) };
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

ipcMain.handle('onedrive:get-status', async () => {
  try {
    return getOneDriveStatus();
  } catch (err) {
    console.error('onedrive:get-status error:', err);
    return { detectedRoots: [], reclaimEnabled: true, supported: false };
  }
});

ipcMain.handle('onedrive:set-reclaim-enabled', async (_event, enabled: boolean) => {
  try {
    setReclaimEnabled(enabled);
    return true;
  } catch (err) {
    console.error('onedrive:set-reclaim-enabled error:', err);
    return false;
  }
});

ipcMain.handle('onedrive:mark-reclaimable', async (_event, filePaths: string[]) => {
  try {
    return await markFilesForSpaceReclaim(Array.isArray(filePaths) ? filePaths : []);
  } catch (err) {
    console.error('onedrive:mark-reclaimable error:', err);
    return { markedCount: 0 };
  }
});

ipcMain.handle('onedrive:run-health-check', async () => {
  try {
    return await runReclaimHealthCheck();
  } catch (err) {
    console.error('onedrive:run-health-check error:', err);
    return { checked: 0, stillHydrated: 0 };
  }
});

ipcMain.handle('onedrive:get-reclaim-health', async () => {
  try {
    return getReclaimHealth();
  } catch (err) {
    console.error('onedrive:get-reclaim-health error:', err);
    return { broken: false, pendingCount: 0, recentFailureRate: 0, checkedCount: 0 };
  }
});

ipcMain.handle('onedrive:reset-reclaim-health', async () => {
  try {
    resetReclaimHealth();
    return true;
  } catch (err) {
    console.error('onedrive:reset-reclaim-health error:', err);
    return false;
  }
});

ipcMain.handle('mirror:sync-one-photo', async (_event, config: VirtualStorageConfig, remoteFile: string) => {
  try {
    assertPathsAllowed([remoteFile, config.localMirrorRoot], 'mirror:sync-one-photo');
    return await syncOnePhoto(remoteFile, config);
  } catch (err: any) {
    console.error('mirror:sync-one-photo error:', err);
    return { success: false, skipped: false, bytesRead: 0, originalSize: 0, thumbnailSize: 0, error: err.message };
  }
});

ipcMain.handle('mirror:list-source-files', async (_event, sourcePath: string) => {
  try {
    assertPathsAllowed([sourcePath], 'mirror:list-source-files');
    return await scanDirectoryRecursive(sourcePath);
  } catch (err) {
    console.error('mirror:list-source-files error:', err);
    return [];
  }
});

ipcMain.handle('person:get-avatar-path', async (_event, personId: string, cacheKey: string) => {
  try {
    return getPersonAvatarPath(personId, cacheKey);
  } catch (err) {
    console.error('person:get-avatar-path error:', err);
    return null;
  }
});

ipcMain.handle('person:get-avatar-sprites', async (_event, items: Array<{ personId: string; cacheKey: string }>) => {
  try {
    // One screenful per call; cap so a bad caller can't queue thousands of sheet builds.
    return await getAvatarSprites(Array.isArray(items) ? items.slice(0, 200) : []);
  } catch (err) {
    console.error('person:get-avatar-sprites error:', err);
    return {};
  }
});

ipcMain.handle('person:save-avatar', async (_event, personId: string, cacheKey: string, dataUrl: string) => {
  try {
    return savePersonAvatar(personId, cacheKey, dataUrl);
  } catch (err: any) {
    console.error('person:save-avatar error:', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('photoContent:get', async (_event, photoId: string) => {
  try {
    return getPhotoContentEntry(photoId);
  } catch (err) {
    console.error('photoContent:get error:', err);
    return null;
  }
});

ipcMain.handle('photoContent:get-all', async () => {
  try {
    return getAllPhotoContentEntries();
  } catch (err) {
    console.error('photoContent:get-all error:', err);
    return {};
  }
});

ipcMain.handle('photoContent:upsert', async (_event, photoId: string, entry: PhotoContentEntry) => {
  try {
    upsertPhotoContentEntry(photoId, entry);
    return true;
  } catch (err) {
    console.error('photoContent:upsert error:', err);
    return false;
  }
});

ipcMain.handle('person:delete-avatar', async (_event, personId: string) => {
  try {
    deletePersonAvatar(personId);
    return true;
  } catch (err) {
    console.error('person:delete-avatar error:', err);
    return false;
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
  return isPathReachable(filePath);
});

// ---------------- New Storage & Photo Intelligence Handlers ----------------

// Active background scan jobs
const activeScanJobs = new Map<string, boolean>();

ipcMain.handle('mirror:start-bg-scan', async (event, sourcePath: string, mirrorRoot?: string, storageName?: string) => {
  const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const finalMirrorRoot = mirrorRoot || getDefaultMirrorRoot();
  const name = assertValidStorageName(finalMirrorRoot, storageName || path.basename(sourcePath) || 'Storage');
  activeScanJobs.set(jobId, true);
  // The renderer can be reloaded/closed mid-scan; sending to a destroyed
  // webContents throws and used to abort the whole scan.
  const sendProgress = (payload: Record<string, unknown>) => {
    try {
      if (!event.sender.isDestroyed()) event.sender.send('mirror:bg-scan-progress', payload);
    } catch {}
  };
  const targetMirrorDir = path.join(finalMirrorRoot, name);

  if (!fs.existsSync(targetMirrorDir)) {
    fs.mkdirSync(targetMirrorDir, { recursive: true });
  }

  // Non-blocking asynchronous background scan
  setTimeout(async () => {
    try {
      const allFiles = await scanDirectoryRecursive(sourcePath);
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
            thumbBuf = await generateThumbnailBuffer(remoteFile, 500);
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
          sendProgress({
            jobId,
            sourcePath,
            storageName: name,
            mirrorRoot: finalMirrorRoot,
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

      sendProgress({
        jobId,
        sourcePath,
        storageName: name,
        mirrorRoot: finalMirrorRoot,
        phase: 'completed',
        currentFile: 'Complete',
        processedCount: total,
        totalDiscovered: total,
        percent: 100,
        isComplete: true,
      });
    } catch (err: any) {
      console.error('Background scan error:', err);
      sendProgress({
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
    assertPathsAllowed([options?.filePath, options?.originalPath].filter(Boolean), 'photo:edit');
    return await editPhotoFile(options);
  } catch (err: any) {
    console.error('photo:edit error:', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('file:trash-files', async (_event, filePaths: string[]) => {
  try {
    assertPathsAllowed(filePaths, 'file:trash-files');
    return await trashFiles(filePaths);
  } catch (err: any) {
    console.error('file:trash-files error:', err);
    return { success: false, trashedCount: 0, trashedPaths: [], errors: [err.message] };
  }
});

ipcMain.handle('file:delete-permanently', async (_event, filePaths: string[]) => {
  try {
    assertPathsAllowed(filePaths, 'file:delete-permanently');
    return await deleteFilesPermanently(filePaths);
  } catch (err: any) {
    console.error('file:delete-permanently error:', err);
    return { success: false, deletedCount: 0, deletedPaths: [], errors: [err.message] };
  }
});

ipcMain.handle(
  'photo:rotate',
  async (
    _event,
    params: { filePath: string; rotationDegrees: number; originalRemotePath?: string }
  ) => {
    try {
      assertPathsAllowed([params?.filePath, params?.originalRemotePath].filter(Boolean), 'photo:rotate');
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
  'photo:write-metadata',
  async (
    _event,
    params: { filePath: string; originalRemotePath?: string; dateIso?: string; latitude?: number; longitude?: number }
  ) => {
    try {
      assertPathsAllowed([params?.filePath, params?.originalRemotePath].filter(Boolean), 'photo:write-metadata');
      const fail = (error: string) => ({ success: false, wroteExif: false, wroteOriginal: false, isQueued: false, error });
      if (params.dateIso !== undefined && isNaN(new Date(params.dateIso).getTime())) return fail('Invalid date');
      const validCoord = (v: unknown, max: number) => v === undefined || (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= max);
      if (!validCoord(params.latitude, 90) || !validCoord(params.longitude, 180)) return fail('Invalid coordinates');

      const res = await writePhotoMetadataWithOfflineQueue({
        localFilePath: params.filePath,
        originalRemotePath: params.originalRemotePath,
        update: {
          dateIso: params.dateIso,
          latitude: params.latitude,
          longitude: params.longitude,
        },
      });
      return res;
    } catch (err: any) {
      console.error('photo:write-metadata error:', err);
      return { success: false, wroteExif: false, wroteOriginal: false, isQueued: false, error: err.message };
    }
  }
);

ipcMain.handle('photo:process-pending-metadata', async () => {
  try {
    return await processPendingMetadata();
  } catch (err: any) {
    console.error('photo:process-pending-metadata error:', err);
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
    const finalRoot = localMirrorRoot || getDefaultMirrorRoot();
    assertValidStorageName(finalRoot, storageName);
    const mirrorDir = path.join(finalRoot, storageName);
    if (deleteDiskFiles) {
      assertPathsAllowed([mirrorDir], 'mirror:delete-storage');
    }

    if (deleteDiskFiles && fs.existsSync(mirrorDir)) {
      // No permanent-delete fallback: if the Recycle Bin refuses, the user is
      // told instead of the storage's catalog DB being silently destroyed.
      await shell.trashItem(mirrorDir);
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

// The "resume all storages" fallback below (no specific photo list given)
// walks and re-scans every configured virtual storage from scratch — for a
// large library (tens of thousands of OneDrive photos) that alone can take
// tens of seconds. The Settings button that calls this gives no loading
// feedback while its click is in flight, so a user who doesn't see anything
// happen reasonably clicks it again — and again — each click launching a
// SEPARATE full re-scan that runs concurrently with the ones still in
// flight, all mutating the same thumbnailWorker counters. That's what
// actually made "Resume Pre-Caching" look broken: not one slow call, but
// several redundant ones piling up (observed: 4 overlapping calls, one
// taking 104 seconds). This guard makes a second call while one full
// rescan is still running just await the SAME in-flight scan instead of
// starting another.
let inFlightFullRescan: Promise<void> | null = null;

ipcMain.handle('service:start-precache', async (_event, photos?: Photo[]) => {
  try {
    if (photos && photos.length > 0) {
      thumbnailWorker.enqueuePhotos(photos);
    } else {
      if (!inFlightFullRescan) {
        inFlightFullRescan = (async () => {
          try {
            const mirrorRoot = getDefaultMirrorRoot();
            if (fs.existsSync(mirrorRoot)) {
              const subdirs = fs.readdirSync(mirrorRoot, { withFileTypes: true });
              for (const dirent of subdirs) {
                if (dirent.isDirectory() && !dirent.name.startsWith('.')) {
                  const mirrorPhotos = await scanVirtualMirrorDirectory(path.join(mirrorRoot, dirent.name));
                  if (mirrorPhotos && mirrorPhotos.length > 0) {
                    thumbnailWorker.enqueuePhotos(mirrorPhotos);
                  }
                }
              }
            }
          } catch (mirrorErr) {
            console.warn('Auto-enqueuing mirrors for pre-caching failed:', mirrorErr);
          } finally {
            inFlightFullRescan = null;
          }
        })();
      }
      await inFlightFullRescan;
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

// Separate from service:start-precache/pause-precache (the user's own manual
// Settings toggle) — these back the renderer's 15s-idle auto-pause, which
// must never clear a pause the user set deliberately, and must never itself
// be overridden by the user simply moving the mouse. See
// thumbnailWorkerService.ts's activityPaused doc comment.
ipcMain.handle('service:activity-pause-precache', async () => {
  try {
    thumbnailWorker.pauseForActivity();
    return { paused: true };
  } catch (err: any) {
    return { paused: false, error: err.message };
  }
});

ipcMain.handle('service:activity-resume-precache', async () => {
  try {
    thumbnailWorker.resumeFromActivity();
    return { paused: false };
  } catch (err: any) {
    return { paused: true, error: err.message };
  }
});

// On-demand video hover-preview generation (see docs/FEATURE_VIDEO_LIBRARY_SUPPORT.md §2.5) —
// `filePath` is preferred when reachable (same preferOriginal-vs-local precedence as the gphoto://
// protocol handler above), falling back to `originalRemotePath`.
ipcMain.handle('video:get-preview', async (_event, filePath: string, originalRemotePath?: string) => {
  try {
    const appOwnedRoots = [app.getPath('userData'), getDefaultMirrorRoot()];
    const source = (originalRemotePath && !(await isPathReachableForServing(filePath, appOwnedRoots)) && (await isPathReachableForServing(originalRemotePath, appOwnedRoots)))
      ? originalRemotePath
      : filePath;
    const previewPath = await getOrGenerateVideoPreview(source);
    return previewPath ? { path: previewPath } : { error: 'Could not generate a preview for this video.' };
  } catch (err: any) {
    console.error('video:get-preview error:', err);
    return { error: err?.message || String(err) };
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

// Opens an arbitrary https:// URL in the user's default browser — e.g. a Google Maps search link
// from LocationPickerModal's "Search on Google Maps" button. Restricted to http(s) so this can
// never be used to launch an arbitrary local file/protocol handler from renderer-controlled input.
ipcMain.handle('shell:open-external', async (_event, url: string) => {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    await shell.openExternal(url);
    return true;
  } catch (err) {
    console.error('shell:open-external error:', err);
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
    const targetSize = typeof size === 'number' && size > 0 ? Math.min(size, 2048) : 250;
    const requestedItems = Array.isArray(items) ? items.slice(0, 100) : [];
    const thumbnails: Record<string, string> = {};

    await Promise.all(
      requestedItems.map(async (item) => {
        if (!item || !item.path) return;
        // Async + cached reachability (not existsSync): an offline NAS must not stall the main thread per item.
        const appOwnedRoots = [app.getPath('userData'), getDefaultMirrorRoot()];
        const targetPath = (await isPathReachableForServing(item.path, appOwnedRoots))
          ? item.path
          : (item.originalPath && (await isPathReachableForServing(item.originalPath, appOwnedRoots)) ? item.originalPath : null);

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





