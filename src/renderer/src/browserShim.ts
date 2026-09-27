/**
 * browserShim.ts
 *
 * Provides fallback implementations for window.electronAPI when running
 * in a web browser (e.g. mobile browser or desktop browser over HTTP/HTTPS).
 * MUST BE IMPORTED FIRST before any React components or stores initialize!
 */

import { authFetch } from './services/webAuthClient';

/**
 * Turns a non-2xx response into a thrown Error, matching the Electron IPC contract (main rejects on
 * failure). The shim used to swallow these and return empty/fake-success values, so a failed delete,
 * rotate or scan looked like it worked and an unreachable server looked like an empty library.
 */
function assertOk(res: Response, what: string): void {
  if (res.ok) return;
  const err = new Error(`${what} failed (HTTP ${res.status})`);
  // A 401 already re-shows the PIN screen (authFetch); don't also pop an error over it.
  if (res.status === 401) err.name = 'AbortError';
  throw err;
}

if (typeof window !== 'undefined' && !(window as any).electronAPI) {
  (window as any).electronAPI = {
    isBrowserShim: true,
    isElectron: false,

    loadLibraryData: async (key: string, libraryDir?: string) => {
      // Throws on failure (like the IPC handler): null means "nothing stored", not "couldn't read it".
      const dirParam = libraryDir ? `?libraryDir=${encodeURIComponent(libraryDir)}` : '';
      const res = await authFetch(`/api/library${dirParam}`);
      assertOk(res, 'Loading the library');
      const data = await res.json();
      if (data && data[key] !== undefined) return data[key];
      if (key === 'gphotos_library_v1' && (data.photos || data.people)) return data;
      return null;
    },

    saveLibraryData: async (key: string, data: any) => {
      try {
        const res = await authFetch('/api/library', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key, data }),
        });
        return res.ok;
      } catch {
        return false;
      }
    },

    checkFileExists: async (p: string) => {
      // Throws when the check itself fails: callers treat that as "unknown" rather than "deleted".
      const res = await authFetch(`/api/file-exists?path=${encodeURIComponent(p)}`);
      assertOk(res, 'Checking a path');
      const data = await res.json();
      return !!data.exists;
    },

    discoverMirrors: async () => {
      try {
        const res = await authFetch('/api/discover-mirrors');
        if (!res.ok) return [];
        return await res.json();
      } catch {
        return [];
      }
    },

    browseDirectory: async (targetPath?: string) => {
      try {
        const qs = targetPath ? `?path=${encodeURIComponent(targetPath)}` : '';
        const res = await authFetch(`/api/browse-directory${qs}`);
        if (res.ok) return await res.json();
      } catch {}
      return { path: targetPath || null, parent: null, entries: [], error: 'Failed to browse directory' };
    },

    getDefaultMirrorRoot: async () => {
      try {
        const res = await authFetch('/api/default-mirror-root');
        if (!res.ok) return 'GPhotos_VirtualMirrors';
        const data = await res.json();
        return data.path || 'GPhotos_VirtualMirrors';
      } catch {
        return 'GPhotos_VirtualMirrors';
      }
    },

    selectDirectory: async () => null,

    scanDirectory: async (dirPath?: string) => {
      if (!dirPath) return [];
      const res = await authFetch(`/api/scan?path=${encodeURIComponent(dirPath)}`);
      assertOk(res, 'Scanning the folder');
      return await res.json();
    },

    prepareHeicHq: async (filePath: string, photoId: string) => {
      try {
        const res = await authFetch(
          `/api/heic/prepare-hq?path=${encodeURIComponent(filePath)}&id=${encodeURIComponent(photoId)}`
        );
        if (res.ok) {
          const data = await res.json();
          return data.url || null;
        }
      } catch {}
      return null;
    },

    cleanupHeicHq: async (photoId: string) => {
      try {
        await authFetch(`/api/heic/cleanup-hq?id=${encodeURIComponent(photoId)}`);
      } catch {}
    },

    getBatchThumbnails: async (params: { items: Array<{ path: string; originalPath?: string }>; size?: number }) => {
      try {
        const res = await authFetch('/api/batch-thumbnails', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(params),
        });
        if (res.ok) return await res.json();
      } catch (err) {
        console.warn('[browserShim] Batch thumbnails fetch failed:', err);
      }
      return { thumbnails: {} };
    },

    readExif: async () => ({}),
    analyzeDryRun: async () => ({ totalFiles: 0, byYearMonth: {}, duplicateCount: 0, previewFiles: [] }),
    executeOrganize: async () => ({ success: true, processedCount: 0, errors: [] }),
    onOrganizeProgress: () => () => {},
    readFileAsBase64: async () => '',
    syncVirtualStorage: async (config: any) => {
      const res = await authFetch('/api/sync-virtual-storage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      assertOk(res, 'Syncing the storage');
      return await res.json();
    },
    detectFacesBatch: async (photos: any[]) => {
      const res = await authFetch('/api/faces/detect-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(photos),
      });
      assertOk(res, 'Face detection');
      return await res.json();
    },

    scanStorageInventory: async (networkSourcePath: string) => {
      try {
        const res = await authFetch(`/api/scan-storage-inventory?path=${encodeURIComponent(networkSourcePath)}`);
        if (res.ok) return await res.json();
      } catch {}
      return { status: 'failed', totalFiles: 0, error: 'Inventory scan request failed' };
    },

    scanVirtualMirror: async (dirPath?: string) => {
      if (!dirPath) return [];
      const res = await authFetch(`/api/scan-mirror?path=${encodeURIComponent(dirPath)}`);
      assertOk(res, 'Scanning the mirror');
      return await res.json();
    },
    openOriginalFile: async () => {},
    onMirrorProgress: () => () => {},
    getStorageCheckpoints: async () => ({}),
    getLibraryStatus: async () => null,
    saveLibraryStatus: async (s: any) => s,
    getAllLibraryStatuses: async () => ({}),

    // Delete / rotate must throw on failure: they used to return { success: true } when the request
    // failed, so the UI removed or rotated a photo that was never touched on disk.
    trashFiles: async (filePaths: string[]) => {
      const res = await authFetch('/api/delete-files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePaths, permanent: false }),
      });
      assertOk(res, 'Moving files to the Recycle Bin');
      return await res.json();
    },

    deleteFilesPermanently: async (filePaths: string[]) => {
      const res = await authFetch('/api/delete-files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePaths, permanent: true }),
      });
      assertOk(res, 'Deleting files');
      return await res.json();
    },

    rotatePhoto: async (filePath: string, rotationDegrees: number, originalRemotePath?: string) => {
      const res = await authFetch('/api/rotate-photo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath, rotationDegrees, originalRemotePath }),
      });
      assertOk(res, 'Rotating the photo');
      return await res.json();
    },

    processPendingRotations: async () => {
      try {
        const res = await authFetch('/api/process-pending-rotations', { method: 'POST' });
        if (res.ok) return await res.json();
      } catch {}
      return { processed: 0, remaining: 0 };
    },

    getWebServerStatus: async () => {
      try {
        const res = await authFetch('/api/status');
        if (res.ok) return await res.json();
      } catch {}
      const port = window.location.port ? parseInt(window.location.port, 10) : 80;
      return {
        enabled: true,
        isRunning: true,
        port,
        primaryIp: window.location.hostname,
        primaryUrl: window.location.origin,
        allUrls: [{ name: 'Current', url: window.location.origin, ip: window.location.hostname }],
      };
    },

    setWebServerSettings: async (settings: { enabled: boolean; port: number }) => {
      try {
        const res = await authFetch('/api/webserver-settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(settings),
        });
        if (res.ok) return await res.json();
      } catch {}
      return {
        enabled: settings.enabled,
        isRunning: true,
        port: settings.port,
        primaryIp: window.location.hostname,
        primaryUrl: window.location.origin,
        allUrls: [{ name: 'Current', url: window.location.origin, ip: window.location.hostname }],
      };
    },

    setBackgroundServiceSettings: async () => true,
    triggerBackgroundServiceSync: async () => ({ started: false }),
    installSystemService: async () => ({ success: false }),
    uninstallSystemService: async () => ({ success: false }),
    getServiceLogs: async () => [],
    openHelpInBrowser: async () => {
      window.open('https://github.com/sgbhavsar-cpu/gPhotos', '_blank');
      return true;
    },
    sendAppReady: () => {},
    // Both reject on failure (as the IPC handlers now do): a fake empty catalog looked like an empty library.
    getCatalogMeta: async () => {
      const res = await authFetch('/api/catalog-meta');
      assertOk(res, 'Loading the catalog');
      return await res.json();
    },
    getCatalogPage: async (params: { pageIndex: number; pageSize?: number; libraryDir?: string }) => {
      const libraryDirParam = params.libraryDir ? `&libraryDir=${encodeURIComponent(params.libraryDir)}` : '';
      const res = await authFetch(`/api/catalog-page?page=${params.pageIndex}&size=${params.pageSize || 100}${libraryDirParam}`);
      assertOk(res, 'Loading photos');
      return await res.json();
    },
    switchLibrary: async (targetPath: string) => {
      // Rejects on failure (e.g. the server's 403) like the other shim calls; the store reports it.
      const res = await authFetch('/api/switch-library', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetPath }),
      });
      assertOk(res, 'Switching library');
      return await res.json();
    },
    getSpriteCoordinate: async (photoPath: string) => {
      try {
        const res = await authFetch(`/api/sprite-coord?path=${encodeURIComponent(photoPath)}`);
        if (res.ok) return await res.json();
      } catch {}
      return null;
    },
    getSpriteCoordinatesBatch: async (photoPaths: string[]) => {
      try {
        const res = await authFetch('/api/sprite-coords-batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paths: photoPaths }),
        });
        if (res.ok) return await res.json();
      } catch {}
      return {};
    },
    getThumbnailPreCacheStatus: async () => {
      try {
        const res = await authFetch('/api/precache-status');
        if (res.ok) return await res.json();
      } catch {}
      return {
        isRunning: false,
        paused: false,
        current: 0,
        total: 0,
        cpuPercent: 0,
        ramMb: 0,
      };
    },
    startThumbnailPreCache: async (photos?: any[]) => {
      try {
        const res = await authFetch('/api/start-precache', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ photos }),
        });
        if (res.ok) return await res.json();
      } catch {}
      return { started: true };
    },
    pauseThumbnailPreCache: async () => {
      try {
        const res = await authFetch('/api/pause-precache', { method: 'POST' });
        if (res.ok) return await res.json();
      } catch {}
      return { paused: true };
    },
    getBackgroundServiceStatus: async () => {
      try {
        const res = await authFetch('/api/background-service-status');
        if (res.ok) return await res.json();
      } catch {}
      return {
        isRunning: true,
        isPaused: false,
        runAtStartup: false,
        minimizeToTray: true,
        syncIntervalMinutes: 15,
        isScanningNow: false,
      };
    },
    refreshThumbnailsFromSource: async (items: Array<{ filePath: string; originalRemotePath?: string }>) => {
      try {
        const res = await authFetch('/api/thumbnails/refresh-from-source', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items }),
        });
        if (res.ok) return await res.json();
      } catch {}
      return { refreshedCount: 0, errors: [] };
    },
    getStorageDetails: async (_storageName: string) => null,
    getAllStorageDetails: async () => ({}),
    getAllStorageDetailsFast: async () => ({}),
    confirmAllStorageDetailsPhysical: async () => ({}),
  };
}
