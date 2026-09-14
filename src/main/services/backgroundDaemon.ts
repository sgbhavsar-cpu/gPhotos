import { app, BrowserWindow, Tray, Menu, nativeImage, shell } from 'electron';
import path from 'path';
import fs from 'fs';
import { spawn, execSync } from 'child_process';
import { BackgroundServiceStatus, BackgroundServiceSettings, VirtualStorageConfig } from '../../types';
import { scanDirectoryRecursive } from './fileOrganizer';
import { parsePhotoMetadata } from './exifParser';
import { generateThumbnailBuffer, scanVirtualMirrorDirectory, processPendingRotations } from './virtualMirrorService';
import { thumbnailWorker } from './thumbnailWorkerService';
import { getSetting, setSetting } from './libraryRepository';

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

  // Draw colorful modern Google Photos style camera/flower pinwheel icon
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

  // Periodic offline rotation sync check (every 30 seconds)
  setInterval(async () => {
    try {
      await processPendingRotations();
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

    const storages = getSetting<VirtualStorageConfig[]>('gphotos_virtual_storages_v1', []);
    const unlinked = getSetting<string[]>('gphotos_unlinked_storages_v1', []);
    const unlinkedSet = new Set(unlinked.map((n) => n.toLowerCase()));

    const activeStorages = storages.filter((s) => !unlinkedSet.has(s.name.toLowerCase()));

    for (const storage of activeStorages) {
      if (!fs.existsSync(storage.networkSourcePath)) {
        continue; // Network storage offline / unavailable right now
      }

      activeScanStorage = storage.name;
      if (mainWindow) updateTrayMenu(mainWindow);

      const mirrorDir = path.join(storage.localMirrorRoot || 'C:\\GPhotos_VirtualMirrors', storage.name);
      if (!fs.existsSync(mirrorDir)) {
        fs.mkdirSync(mirrorDir, { recursive: true });
      }

      // Scan source folder
      const allFiles = scanDirectoryRecursive(storage.networkSourcePath);
      let newlySynced = 0;

      for (const filePath of allFiles) {
        const rel = path.relative(storage.networkSourcePath, filePath);
        const relNoExt = rel.replace(/\.[^/.]+$/, '');
        const jsonSidecar = path.join(mirrorDir, `${relNoExt}.json`);
        const thumbPath = path.join(mirrorDir, `${relNoExt}.jpg`);

        // If thumbnail and sidecar already exist, it is up-to-date
        if (fs.existsSync(jsonSidecar) && fs.existsSync(thumbPath)) {
          continue;
        }

        try {
          const thumbDir = path.dirname(thumbPath);
          if (!fs.existsSync(thumbDir)) fs.mkdirSync(thumbDir, { recursive: true });

          const thumbBuffer = generateThumbnailBuffer(filePath, 500);
          if (thumbBuffer) {
            fs.writeFileSync(thumbPath, thumbBuffer);
            const stats = fs.statSync(filePath);
            const meta = await parsePhotoMetadata(filePath);

            const sidecar = {
              originalFilePath: filePath,
              thumbnailPath: thumbPath,
              fileName: path.basename(filePath),
              originalFileSize: stats.size,
              dateTaken: meta.dateTaken || stats.mtime.toISOString(),
              width: meta.width,
              height: meta.height,
              storageName: storage.name,
              storageRoot: storage.networkSourcePath,
              lastSynced: new Date().toISOString(),
            };

            fs.writeFileSync(jsonSidecar, JSON.stringify(sidecar, null, 2), 'utf-8');
            newlySynced++;
          }
        } catch {
          // Continue to next photo on error
        }

        // Brief yield to avoid starving I/O
        await new Promise((r) => setTimeout(r, 8));
      }

      // Always reflect the live source-folder count, never accumulate on top
      // of the previous value — otherwise a single cycle that (for any
      // reason, e.g. the two mirror-sync code paths disagreeing on a
      // thumbnail's file extension) misclassifies already-mirrored files as
      // "new" permanently inflates this storage's reported total.
      storage.totalItems = allFiles.length;

      if (newlySynced > 0) {
        storage.lastSynced = new Date().toISOString();
        try {
          const mirroredPhotos = scanVirtualMirrorDirectory(mirrorDir);
          if (mirroredPhotos && mirroredPhotos.length > 0) {
            thumbnailWorker.enqueuePhotos(mirroredPhotos);
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

