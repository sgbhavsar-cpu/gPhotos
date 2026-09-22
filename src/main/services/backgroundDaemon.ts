import { app, BrowserWindow, Tray, Menu, nativeImage, shell } from 'electron';
import path from 'path';
import fs from 'fs';
import { spawn, execSync } from 'child_process';
import { BackgroundServiceStatus, BackgroundServiceSettings, VirtualStorageConfig } from '../../types';
import { scanVirtualMirrorDirectory, processPendingRotations, processPendingMetadata, syncVirtualStorage, getStorageDetails } from './virtualMirrorService';
import { thumbnailWorker } from './thumbnailWorkerService';
import { getSetting, setSetting } from './libraryRepository';
import { setActiveLibrary } from './db';
import { isPathReachable } from './networkReachabilityCache';
import { isOneDrivePath, markFilesForSpaceReclaim, runReclaimHealthCheck, getReclaimHealth } from './oneDriveService';
import { libraryStatusService } from './libraryStatusService';
import { getDefaultMirrorRoot } from './pathSecurity';

let tray: Tray | null = null;
let syncTimer: NodeJS.Timeout | null = null;
let isScanningNow = false;
let activeScanStorage: string | undefined = undefined;
let isQuitting = false;

// Default background service settings with 40% CPU cap and 1GB RAM cap
let serviceSettings: BackgroundServiceSettings = {
  runAtStartup: false,
  minimizeToTray: true,
  isPaused: false,
  syncIntervalMinutes: 15,
  maxCpuPercent: 40,
  maxRamMb: 1024,
  enableThumbnailPreCache: true,
};

let lastSyncTime: string | undefined = undefined;

function loadSavedSettings() {
  try {
    const saved = getSetting<BackgroundServiceSettings | null>('gphotos_service_settings_v1', null);
    if (saved) {
      serviceSettings = { ...serviceSettings, ...saved };
      thumbnailWorker.setResourceLimits({
        maxCpuPercent: serviceSettings.maxCpuPercent,
        maxRamMb: serviceSettings.maxRamMb,
        enabled: serviceSettings.enableThumbnailPreCache,
      });
    }
    const savedLastSync = getSetting<string | null>('gphotos_service_last_sync', null);
    if (savedLastSync) {
      lastSyncTime = savedLastSync;
    }
  } catch (err) {
    console.warn('Failed to load background service settings:', err);
  }
}

function saveSettings() {
  try {
    setSetting('gphotos_service_settings_v1', serviceSettings);
    if (lastSyncTime) {
      setSetting('gphotos_service_last_sync', lastSyncTime);
    }
  } catch (err) {
    console.warn('Failed to persist background service settings:', err);
  }
}

/**
 * Creates a crisp 32x32 RGBA pinwheel camera icon for the system tray
 */
function createTrayIcon(): Electron.NativeImage {
  const iconPaths = [
    path.join(__dirname, '../../public/icon.png'),
    path.join(__dirname, '../../dist/icon.png'),
    path.join(app.getAppPath(), 'public/icon.png'),
    path.join(app.getAppPath(), 'dist/icon.png'),
  ];
  for (const p of iconPaths) {
    if (fs.existsSync(p)) {
      try {
        const img = nativeImage.createFromPath(p);
        if (!img.isEmpty()) {
          return img.resize({ width: 32, height: 32 });
        }
      } catch {}
    }
  }

  const size = 32;
  const canvas = Buffer.alloc(size * size * 4);

  // Draw colorful modern camera/flower pinwheel icon
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const dx = x - size / 2;
      const dy = y - size / 2;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < 13) {
        if (dx < 0 && dy < 0) {
          canvas[idx] = 239; canvas[idx + 1] = 68; canvas[idx + 2] = 68; canvas[idx + 3] = 255;
        } else if (dx >= 0 && dy < 0) {
          canvas[idx] = 245; canvas[idx + 1] = 158; canvas[idx + 2] = 11; canvas[idx + 3] = 255;
        } else if (dx >= 0 && dy >= 0) {
          canvas[idx] = 16; canvas[idx + 1] = 185; canvas[idx + 2] = 129; canvas[idx + 3] = 255;
        } else {
          canvas[idx] = 59; canvas[idx + 1] = 130; canvas[idx + 2] = 246; canvas[idx + 3] = 255;
        }
      } else if (dist < 15) {
        canvas[idx] = 255; canvas[idx + 1] = 255; canvas[idx + 2] = 255; canvas[idx + 3] = 180;
      } else {
        canvas[idx + 3] = 0;
      }
    }
  }

  return nativeImage.createFromBuffer(canvas, { width: size, height: size });
}

export function initBackgroundDaemon(mainWindow?: BrowserWindow | null) {
  loadSavedSettings();

  // Create Tray Icon
  const icon = createTrayIcon();
  tray = new Tray(icon);
  tray.setToolTip('gPhotos - Background Service');

  updateTrayMenu(mainWindow);

  tray.on('double-click', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    } else {
      const exe = process.execPath;
      const args = !app.isPackaged ? [app.getAppPath()] : [];
      spawn(exe, args, { detached: true, stdio: 'ignore' }).unref();
    }
  });

  // Intercept window close to minimize to tray if enabled
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.on('close', (e) => {
      if (!isQuitting && serviceSettings.minimizeToTray) {
        e.preventDefault();
        mainWindow.hide();

        if (tray) {
          tray.displayBalloon({
            title: 'gPhotos',
            content: 'Running in the background. Double-click tray icon to open.',
            iconType: 'info',
          });
        }
      }
    });
  }

  // Start periodic background scanner
  restartSyncTimer(mainWindow);

  // The interval timer above only fires *after* a full syncIntervalMinutes
  // (15 min by default) has elapsed — so newly-added photos in a configured
  // storage's source folder went undiscovered for up to that long after
  // every single app launch, with nothing to explain why "background
  // activity" (the separate, much-faster-resuming thumbnail pre-cache
  // queue) wasn't also picking them up. Run one cycle shortly after
  // startup — not immediately, so it doesn't compete with initial
  // catalog/thumbnail loading for CPU/IO — then fall back to the interval.
  setTimeout(() => {
    if (!serviceSettings.isPaused) {
      runBackgroundSyncCycle(mainWindow);
    }
  }, 45_000);

  // Periodic offline rotation sync check (every 30 seconds)
  setInterval(async () => {
    try {
      await processPendingRotations();
    } catch {}
  }, 30000);

  // Periodic offline date/location sync check (every 30 seconds)
  setInterval(async () => {
    try {
      await processPendingMetadata();
    } catch {}
  }, 30000);
}

function updateTrayMenu(mainWindow?: BrowserWindow | null) {
  if (!tray) return;

  const statusText = isScanningNow
    ? `Scanning: ${activeScanStorage || 'Photos'}...`
    : serviceSettings.isPaused
    ? 'Sync Status: Paused'
    : `Sync Status: Active (Every ${serviceSettings.syncIntervalMinutes}m)`;

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Open gPhotos',
      click: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          if (mainWindow.isMinimized()) mainWindow.restore();
          mainWindow.show();
          mainWindow.focus();
        } else {
          const exe = process.execPath;
          const args = !app.isPackaged ? [app.getAppPath()] : [];
          spawn(exe, args, { detached: true, stdio: 'ignore' }).unref();
        }
      },
    },
    { type: 'separator' },
    {
      label: statusText,
      enabled: false,
    },
    {
      label: 'Scan All Storages Now',
      enabled: !isScanningNow,
      click: () => {
        runBackgroundSyncCycle(mainWindow);
      },
    },
    {
      label: serviceSettings.isPaused ? 'Resume Background Sync' : 'Pause Background Sync',
      click: () => {
        serviceSettings.isPaused = !serviceSettings.isPaused;
        saveSettings();
        updateTrayMenu(mainWindow);
        restartSyncTimer(mainWindow);
      },
    },
    { type: 'separator' },
    {
      label: 'Run at Windows Startup',
      type: 'checkbox',
      checked: serviceSettings.runAtStartup,
      click: (item) => {
        serviceSettings.runAtStartup = item.checked;
        app.setLoginItemSettings({
          openAtLogin: serviceSettings.runAtStartup,
          openAsHidden: true,
        });
        saveSettings();
      },
    },
    {
      label: 'Keep Running in Background on Close',
      type: 'checkbox',
      checked: serviceSettings.minimizeToTray,
      click: (item) => {
        serviceSettings.minimizeToTray = item.checked;
        saveSettings();
      },
    },
    { type: 'separator' },
    {
      label: 'Quit gPhotos Completely',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
}

function restartSyncTimer(mainWindow?: BrowserWindow | null) {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }

  if (serviceSettings.isPaused) return;

  const ms = Math.max(5, serviceSettings.syncIntervalMinutes) * 60 * 1000;
  syncTimer = setInterval(() => {
    runBackgroundSyncCycle(mainWindow);
  }, ms);
}

/**
 * Runs a non-blocking background synchronization cycle across all configured network storages
 */
export async function runBackgroundSyncCycle(mainWindow?: BrowserWindow | null): Promise<void> {
  if (isScanningNow || serviceSettings.isPaused) return;

  isScanningNow = true;
  if (mainWindow) updateTrayMenu(mainWindow);

  try {
    // First drain any pending offline rotations if storage is available
    await processPendingRotations();
    await processPendingMetadata();

    // Self-healing OneDrive reclaim check: evaluate whatever's already
    // pending BEFORE deciding whether reclaim still looks broken — this is
    // the one thing that was missing before. The renderer's sync loop
    // refuses to even start while broken, so it could never generate fresh
    // evidence that things had recovered, permanently stuck until someone
    // clicked "Retry" by hand. Running the check here, on the daemon's own
    // timer, means it keeps re-evaluating on its own regardless of whether
    // the app window is even open.
    await runReclaimHealthCheck().catch(() => {});
    let reclaimHealth = getReclaimHealth();

    const storages = getSetting<VirtualStorageConfig[]>('gphotos_virtual_storages_v1', []);
    const unlinked = getSetting<string[]>('gphotos_unlinked_storages_v1', []);
    const unlinkedSet = new Set(unlinked.map((n) => n.toLowerCase()));

    const activeStorages = storages.filter((s) => !unlinkedSet.has(s.name.toLowerCase()));

    for (const storage of activeStorages) {
      // isPathReachable (not fs.existsSync) so a stale/disconnected mapped
      // drive or dead UNC share can't hang this periodic cycle for the OS's
      // full network timeout — and once a storage is found offline, this
      // skips re-checking it (near-instantly) for a while instead of
      // repeating that risk on every subsequent cycle.
      if (!(await isPathReachable(storage.networkSourcePath))) {
        continue; // Network storage offline / unavailable right now
      }

      activeScanStorage = storage.name;
      if (mainWindow) updateTrayMenu(mainWindow);

      const mirrorDir = path.join(storage.localMirrorRoot || getDefaultMirrorRoot(), storage.name);
      if (!fs.existsSync(mirrorDir)) {
        fs.mkdirSync(mirrorDir, { recursive: true });
      }

      // Still "paused" from a previous cycle — re-probe a small sample of
      // this storage's already-mirrored files instead of doing nothing and
      // waiting for a manual "Retry". A storage that's already fully synced
      // has nothing new to unpin, so without this there would never be any
      // fresh evidence for the check at the top of this cycle to evaluate,
      // and reclaim could never recover on its own even if OneDrive started
      // working again. Safe to re-request on the same files repeatedly —
      // unpinning is idempotent.
      if (reclaimHealth.broken && isOneDrivePath(storage.networkSourcePath)) {
        try {
          const mirrored = await scanVirtualMirrorDirectory(mirrorDir);
          const probeSample = mirrored
            .map((p) => p.originalRemotePath)
            .filter((p): p is string => !!p)
            .slice(0, 5);
          if (probeSample.length > 0) {
            await markFilesForSpaceReclaim(probeSample);
          }
        } catch {}
      }

      // Delegate to the same sync implementation the manual "Sync Now" button
      // uses, instead of a separate reimplementation — the two used to
      // disagree on thumbnail file naming (this one forced .jpg, the other
      // preserved the source extension), which made each pass misclassify
      // the other's already-mirrored files as new and permanently inflate
      // the reported total. Using one implementation also means
      // delayBetweenPhotosSec / bandwidthLimitMbps apply here automatically.
      //
      // Face detection now writes straight to the active library's SQLite
      // database (see pipelineOrchestrator.ts) — safe to do unattended only
      // when no renderer window is visibly open to race against for which
      // library is "active" right now. When the window IS open, this falls
      // back to thumbnail-only, same as before; face detection for that
      // content still runs normally the next time the app (or this cycle,
      // once the window is hidden/closed again) processes it.
      const safeToRunFacePipeline = !mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible();
      if (safeToRunFacePipeline) {
        const selectedFolder = getSetting<string | null>('selectedFolder', null);
        if (selectedFolder) setActiveLibrary(selectedFolder);
      }
      // Forward progress on the same 'mirror:progress' channel a manual
      // sync uses, so the sidebar/Virtual Storage screen's live indicators
      // (spinner, "Caching Thumbnails (X/Y)" banner) also light up during an
      // unattended daemon cycle — previously this ran completely silently
      // from the renderer's point of view, with the visible photo count
      // only jumping once the whole storage finished, however long that took.
      const result = await syncVirtualStorage(
        storage,
        mainWindow && !mainWindow.isDestroyed()
          ? (progress) => {
              try {
                mainWindow!.webContents.send('mirror:progress', progress);
              } catch {}
            }
          : undefined,
        { runFaceDetection: safeToRunFacePipeline }
      );
      if (result.errors.length > 0) {
        console.warn(`[BackgroundSync] ${storage.name}: ${result.errors.length} error(s) during sync.`);
      }
      // Reflect the catalog's own authoritative count, NOT result.totalSynced
      // — that only counts how many source files THIS pass touched, which
      // silently undercounts whenever the network/OneDrive source listing is
      // briefly incomplete (a transient hiccup mid-cycle). That smaller
      // number would otherwise permanently stick as the sidebar's displayed
      // total until some later cycle happened to see every file again (the
      // catalog itself never regresses this way, since it only grows via
      // confirmed processed photos).
      try {
        const details = getStorageDetails(storage.name, storage.localMirrorRoot);
        storage.totalItems = details.totalPhotos > 0 ? details.totalPhotos : result.totalSynced;
      } catch {
        storage.totalItems = result.totalSynced;
      }
      storage.totalSizeSaved = result.totalSizeSaved;

      // Keep .gphotos_status.json's thumbnail fields in step with what this
      // cycle actually found — this file is otherwise only ever written by
      // the renderer's face-detection pass, so a storage that's only ever
      // synced via this unattended background cycle (app never opened onto
      // its screen) would leave it permanently stuck at whatever the very
      // first partial sync happened to report. saveLibraryStatus merges
      // rather than replaces, so this can't clobber the face-related fields
      // below it — those are simply left untouched here.
      try {
        libraryStatusService.saveLibraryStatus({
          libraryPath: mirrorDir,
          libraryName: storage.name,
          totalPhotos: result.totalSynced,
          thumbnailCachedCount: result.totalSynced,
          thumbnailTotalCount: result.totalSynced,
          thumbnailCompleted: result.errors.length === 0,
          thumbnailPercent: result.totalSynced > 0 ? 100 : 0,
          phase: result.errors.length === 0 ? 'thumbnails' : 'interrupted',
        });
      } catch {}

      if (result.newlyAdded > 0) {
        storage.lastSynced = new Date().toISOString();
        try {
          const mirroredPhotos = await scanVirtualMirrorDirectory(mirrorDir);
          if (mirroredPhotos && mirroredPhotos.length > 0) {
            thumbnailWorker.enqueuePhotos(mirroredPhotos);

            // When this cycle couldn't safely run the full pipeline (a
            // renderer window is visibly open — see safeToRunFacePipeline
            // above), it only hydrated these files for thumbnails, and
            // nothing else will unpin them until face detection eventually
            // runs. Unpin now on the thumbnail work alone in that case; when
            // the full pipeline DID run, it already requested reclaim itself
            // per photo immediately after detection, so doing it again here
            // would just be redundant (harmless, but pointless).
            if (!safeToRunFacePipeline) {
              const oneDrivePaths = mirroredPhotos
                .map((p) => p.originalRemotePath)
                .filter((p): p is string => !!p && isOneDrivePath(p));
              if (oneDrivePaths.length > 0) {
                markFilesForSpaceReclaim(oneDrivePaths).catch(() => {});
              }
            }
          }
        } catch {}
      }
    }

    lastSyncTime = new Date().toISOString();
    setSetting('gphotos_virtual_storages_v1', storages);
    saveSettings();
  } catch (err) {
    console.error('Error during background daemon sync cycle:', err);
  } finally {
    isScanningNow = false;
    activeScanStorage = undefined;
    if (mainWindow && !mainWindow.isDestroyed()) {
      updateTrayMenu(mainWindow);
      if (tray) {
        tray.setToolTip(`gPhotos - Synced at ${new Date().toLocaleTimeString()}`);
      }
    }
  }
}

const REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const REG_VALUE = 'GPhotosBackgroundSyncService';

function getLogFilePath(): string {
  const userDir = app.getPath('userData');
  if (!fs.existsSync(userDir)) fs.mkdirSync(userDir, { recursive: true });
  return path.join(userDir, 'daemon.log');
}

export function appendDaemonLog(message: string): void {
  try {
    const logFile = getLogFilePath();
    const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
    fs.appendFileSync(logFile, `[${timestamp}] ${message}\n`, 'utf-8');
  } catch (err) {
    console.warn('Failed to write daemon log:', err);
  }
}

export function getServiceLogs(): string[] {
  try {
    const logFile = getLogFilePath();
    if (!fs.existsSync(logFile)) return ['[Info] No daemon logs recorded yet.'];
    const content = fs.readFileSync(logFile, 'utf-8');
    const lines = content.split('\n').filter((l) => l.trim().length > 0);
    return lines.slice(-100);
  } catch {
    return ['[Error] Failed to read daemon logs.'];
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    const stdout = execSync(`tasklist /FI "PID eq ${pid}" /NH`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    return stdout.includes(String(pid));
  } catch {
    return false;
  }
}

function killProcess(pid: number): void {
  try {
    execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' });
  } catch {}
}

export function isSystemServiceRegistryInstalled(): boolean {
  try {
    const out = execSync(`reg query "${REG_KEY}" /v "${REG_VALUE}"`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    return out.includes(REG_VALUE);
  } catch {
    return false;
  }
}

function getServicePidFilePath(): string {
  return path.join(app.getPath('userData'), 'service.pid');
}

export function getSystemServicePid(): number | undefined {
  try {
    const pidFile = getServicePidFilePath();
    if (fs.existsSync(pidFile)) {
      const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
      if (!isNaN(pid) && isProcessRunning(pid)) {
        return pid;
      }
    }
  } catch {}
  return undefined;
}

export function installSystemServiceDaemon(): { success: boolean; error?: string } {
  try {
    const exePath = process.execPath;
    let cmd = `"${exePath}" --background-service`;
    if (!app.isPackaged) {
      cmd = `"${exePath}" "${app.getAppPath()}" --background-service`;
    }

    execSync(`reg add "${REG_KEY}" /v "${REG_VALUE}" /t REG_SZ /d "${cmd.replace(/"/g, '\\"')}" /f`, {
      stdio: ['pipe', 'pipe', 'ignore'],
    });

    let existingPid = getSystemServicePid();
    if (!existingPid) {
      const args = !app.isPackaged
        ? [app.getAppPath(), '--background-service']
        : ['--background-service'];

      const child = spawn(exePath, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();

      if (child.pid) {
        fs.writeFileSync(getServicePidFilePath(), String(child.pid), 'utf-8');
        existingPid = child.pid;
      }
    }

    appendDaemonLog(`System Service installed successfully (Auto-run on logon). Daemon PID: ${existingPid || 'detached'}`);
    return { success: true };
  } catch (err: any) {
    appendDaemonLog(`Failed to install System Service: ${err.message}`);
    return { success: false, error: err.message };
  }
}

export function uninstallSystemServiceDaemon(): { success: boolean; error?: string } {
  try {
    try {
      execSync(`reg delete "${REG_KEY}" /v "${REG_VALUE}" /f`, {
        stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch {}

    const pid = getSystemServicePid();
    if (pid) {
      killProcess(pid);
      try {
        fs.unlinkSync(getServicePidFilePath());
      } catch {}
    }

    appendDaemonLog('System Service uninstalled successfully. Autonomous daemon terminated.');
    return { success: true };
  } catch (err: any) {
    appendDaemonLog(`Failed to uninstall System Service: ${err.message}`);
    return { success: false, error: err.message };
  }
}

export function getBackgroundServiceStatus(): BackgroundServiceStatus {
  const isInstalled = isSystemServiceRegistryInstalled();
  const pid = getSystemServicePid();
  const isRunning = Boolean(pid);
  const status: 'running' | 'stopped' | 'not_installed' = isInstalled
    ? (isRunning ? 'running' : 'stopped')
    : 'not_installed';

  const workerStatus = thumbnailWorker.getStatus();

  return {
    isRunning: true,
    isPaused: serviceSettings.isPaused,
    runAtStartup: serviceSettings.runAtStartup,
    minimizeToTray: serviceSettings.minimizeToTray,
    syncIntervalMinutes: serviceSettings.syncIntervalMinutes,
    lastSyncTime,
    isScanningNow,
    activeScanStorage,
    isSystemServiceInstalled: isInstalled,
    systemServiceStatus: status,
    systemServicePid: pid,
    executionMode: isInstalled && isRunning ? 'system_service' : 'app_thread',
    maxCpuPercent: serviceSettings.maxCpuPercent ?? 40,
    maxRamMb: serviceSettings.maxRamMb ?? 1024,
    enableThumbnailPreCache: serviceSettings.enableThumbnailPreCache ?? true,
    currentCpuPercent: workerStatus.cpuPercent,
    currentRamMb: workerStatus.ramMb,
    thumbnailsPreCachedCount: workerStatus.current,
    thumbnailsPreCachedTotal: workerStatus.total,
    isPreCachingActive: workerStatus.isRunning,
    currentPreCacheFile: workerStatus.currentFile,
  };
}

export function updateBackgroundServiceSettings(
  settings: Partial<BackgroundServiceSettings>,
  mainWindow?: BrowserWindow | null
): boolean {
  serviceSettings = { ...serviceSettings, ...settings };
  if (settings.runAtStartup !== undefined) {
    app.setLoginItemSettings({
      openAtLogin: serviceSettings.runAtStartup,
      openAsHidden: true,
    });
  }

  // Update resource throttling limits for the background thumbnail worker
  thumbnailWorker.setResourceLimits({
    maxCpuPercent: serviceSettings.maxCpuPercent,
    maxRamMb: serviceSettings.maxRamMb,
    enabled: serviceSettings.enableThumbnailPreCache,
  });

  saveSettings();
  if (mainWindow && !mainWindow.isDestroyed()) {
    updateTrayMenu(mainWindow);
    restartSyncTimer(mainWindow);
  }
  return true;
}

export function markAsQuitting() {
  isQuitting = true;
}

