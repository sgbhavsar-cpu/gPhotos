/**
 * browserShim.ts
 *
 * Provides fallback implementations for window.electronAPI when running
 * in a web browser (e.g. mobile browser or desktop browser over HTTP/HTTPS).
 * MUST BE IMPORTED FIRST before any React components or stores initialize!
 */

if (typeof window !== 'undefined' && !(window as any).electronAPI) {
  (window as any).electronAPI = {
    isBrowserShim: true,
    isElectron: false,

    loadLibraryData: async (key: string) => {
      try {
        const res = await fetch('/api/library');
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
        const res = await fetch('/api/library', {
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
        const res = await fetch(`/api/file-exists?path=${encodeURIComponent(p)}`);
        if (!res.ok) return false;
        const data = await res.json();
        return !!data.exists;
      } catch {
        return false;
      }
    },

    discoverMirrors: async () => {
      try {
        const res = await fetch('/api/discover-mirrors');
        if (!res.ok) return [];
        return await res.json();
      } catch {
        return [];
      }
    },

    selectDirectory: async () => null,

    scanDirectory: async (dirPath?: string) => {
      try {
        if (!dirPath) return [];
        const res = await fetch(`/api/scan?path=${encodeURIComponent(dirPath)}`);
        if (!res.ok) return [];
        return await res.json();
      } catch {
        return [];
      }
    },

    prepareHeicHq: async (filePath: string, photoId: string) => {
      try {
        const res = await fetch(
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
        await fetch(`/api/heic/cleanup-hq?id=${encodeURIComponent(photoId)}`);
      } catch {}
    },

    getBatchThumbnails: async (params: { items: Array<{ path: string; originalPath?: string }>; size?: number }) => {
      try {
        const res = await fetch('/api/batch-thumbnails', {
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
        const res = await fetch('/api/sync-virtual-storage', {
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
    scanVirtualMirror: async (dirPath?: string) => {
      try {
        if (!dirPath) return [];
        const res = await fetch(`/api/scan-mirror?path=${encodeURIComponent(dirPath)}`);
        if (!res.ok) return [];
        return await res.json();
      } catch (err) {
        console.warn('[browserShim] Failed to scan virtual mirror:', err);
        return [];
      }
    },
    openOriginalFile: async () => {},
    onMirrorProgress: () => () => {},

    getWebServerStatus: async () => {
      try {
        const res = await fetch('/api/status');
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
        const res = await fetch('/api/webserver-settings', {
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
  };
}
