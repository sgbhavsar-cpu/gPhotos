/**
 * browserShim.ts
 *
 * Provides fallback implementations for window.electronAPI when running
 * in a web browser (e.g. mobile browser or desktop browser over HTTP/HTTPS).
 * MUST BE IMPORTED FIRST before any React components or stores initialize!
 */

import { authFetch } from './services/webAuthClient';

if (typeof window !== 'undefined' && !(window as any).electronAPI) {
  (window as any).electronAPI = {
    isBrowserShim: true,
    isElectron: false,

    loadLibraryData: async (key: string, libraryDir?: string) => {
      try {
        const dirParam = libraryDir ? `?libraryDir=${encodeURIComponent(libraryDir)}` : '';
        const res = await authFetch(`/api/library${dirParam}`);
        if (!res.ok) return null;
        const data = await res.json();
        if (data && data[key] !== undefined) return data[key];
        if (key === 'gphotos_library_v1' && (data.photos || data.people)) return data;
        return null;
      } catch (err) {
        console.warn('[browserShim] Failed to fetch /api/library:', err);
        return null;
      }
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
      try {
        const res = await authFetch(`/api/file-exists?path=${encodeURIComponent(p)}`);
        if (!res.ok) return false;
        const data = await res.json();
        return !!data.exists;
      } catch {
        return false;
      }
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
      try {
        if (!dirPath) return [];
        const res = await authFetch(`/api/scan?path=${encodeURIComponent(dirPath)}`);
        if (!res.ok) return [];
        return await res.json();
      } catch {
        return [];
      }
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
      try {
        const res = await authFetch('/api/sync-virtual-storage', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(config),
        });
        if (!res.ok) return { success: false, newMirroredCount: 0, totalMirroredCount: 0, totalSizeSaved: 0 };
        return await res.json();
      } catch {
        return { success: false, newMirroredCount: 0, totalMirroredCount: 0, totalSizeSaved: 0 };
      }
    },
    detectFacesBatch: async (photos: any[]) => {
      try {
        const res = await authFetch('/api/faces/detect-batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(photos),
        });
        if (res.ok) return await res.json();
      } catch {}
      return { results: photos.map((p) => ({ photoId: p.id, ran: false, faceCount: 0, locked: false, skippedReason: 'decode-failed', faces: [] })), people: [] };
    },

    scanStorageInventory: async (networkSourcePath: string) => {
      try {
        const res = await authFetch(`/api/scan-storage-inventory?path=${encodeURIComponent(networkSourcePath)}`);
        if (res.ok) return await res.json();
      } catch {}
      return { status: 'failed', totalFiles: 0, error: 'Inventory scan request failed' };
    },

    scanVirtualMirror: async (dirPath?: string) => {
      try {
        if (!dirPath) return [];
        const res = await authFetch(`/api/scan-mirror?path=${encodeURIComponent(dirPath)}`);
        if (!res.ok) return [];
        return await res.json();
      } catch (err) {
        console.warn('[browserShim] Failed to scan virtual mirror:', err);
        return [];
      }
    },
    openOriginalFile: async () => {},
    onMirrorProgress: () => () => {},
    getStorageCheckpoints: async () => ({}),
    getLibraryStatus: async () => null,
    saveLibraryStatus: async (s: any) => s,
    getAllLibraryStatuses: async () => ({}),

    trashFiles: async (filePaths: string[]) => {
      try {
        const res = await authFetch('/api/delete-files', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filePaths, permanent: false }),
        });
        if (res.ok) return await res.json();
      } catch {}
      return { success: true, trashedCount: filePaths.length, trashedPaths: filePaths, errors: [] };
    },

    deleteFilesPermanently: async (filePaths: string[]) => {
      try {
        const res = await authFetch('/api/delete-files', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filePaths, permanent: true }),
        });
        if (res.ok) return await res.json();
      } catch {}
      return { success: true, deletedCount: filePaths.length, deletedPaths: filePaths, errors: [] };
    },

    rotatePhoto: async (filePath: string, rotationDegrees: number, originalRemotePath?: string) => {
      try {
        const res = await authFetch('/api/rotate-photo', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filePath, rotationDegrees, originalRemotePath }),
        });
        if (res.ok) return await res.json();
      } catch {}
      return { success: true, newPath: filePath };
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

    getBackgroundServiceStatus: async () => ({
      isRunning: false,
      minimizeToTray: false,
      autoLaunchOnStartup: false,
      syncIntervalMinutes: 30,
      lastSyncTime: Date.now(),
    }),
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
    getCatalogMeta: async () => {
      try {
        const res = await authFetch('/api/catalog-meta');
        if (res.ok) return await res.json();
      } catch {}
      return {
        version: 2,
        totalPhotos: 0,
        totalAlbums: 0,
        totalPeople: 0,
        totalPlaces: 0,
        timelineSummary: [],
        placesSummary: [],
        albumsSummary: [],
        peopleSummary: [],
        recentLibraries: [],
        currentDirectory: null,
        selectedFolder: null,
        pageSize: 100,
        totalPages: 0,
        lastUpdated: new Date().toISOString(),
      };
    },
    getCatalogPage: async (params: { pageIndex: number; pageSize?: number; libraryDir?: string }) => {
      try {
        const libraryDirParam = params.libraryDir ? `&libraryDir=${encodeURIComponent(params.libraryDir)}` : '';
        const res = await authFetch(`/api/catalog-page?page=${params.pageIndex}&size=${params.pageSize || 100}${libraryDirParam}`);
        if (res.ok) return await res.json();
      } catch {}
      return { photos: [], totalPages: 0, totalPhotos: 0 };
    },
    switchLibrary: async (targetPath: string) => {
      try {
        const res = await authFetch('/api/switch-library', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetPath }),
        });
        if (res.ok) return await res.json();
      } catch {}
      return null;
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
  };
}
