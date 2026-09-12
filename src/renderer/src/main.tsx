import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import './index.css';

// Global error handlers to prevent silent failures and ensure diagnostics
if (typeof window !== 'undefined') {
  window.addEventListener('error', (event) => {
    console.error('[Global Unhandled Window Error]:', event.error || event.message, event);
  });

  window.addEventListener('unhandledrejection', (event) => {
    console.error('[Global Unhandled Promise Rejection]:', event.reason);
  });
}

// Browser fallback shim for testing outside Electron
if (typeof window !== 'undefined' && !(window as any).electronAPI) {
  (window as any).electronAPI = {
    loadLibraryData: async (key: string) => {
      try {
        const res = await fetch('/api/library');
        if (!res.ok) return null;
        const data = await res.json();
        if (data[key]) return data[key];
        if (key === 'gphotos_library_v1' && (data.photos || data.people)) return data;
        return null;
      } catch {
        return null;
      }
    },
    saveLibraryData: async (key: string, data: any) => {
      try {
        await fetch('/api/library', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key, data }),
        });
        return true;
      } catch {
        return false;
      }
    },
    checkFileExists: async (p: string) => {
      try {
        const res = await fetch(`/api/file-exists?path=${encodeURIComponent(p)}`);
        const data = await res.json();
        return !!data.exists;
      } catch {
        return false;
      }
    },
    discoverMirrors: async () => {
      try {
        const res = await fetch('/api/discover-mirrors');
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
        const res = await fetch(`/api/heic/prepare-hq?path=${encodeURIComponent(filePath)}&id=${encodeURIComponent(photoId)}`);
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
    readExif: async () => ({}),
    analyzeDryRun: async () => ({ totalFiles: 0, byYearMonth: {}, duplicateCount: 0, previewFiles: [] }),
    executeOrganize: async () => ({ success: true, processedCount: 0, errors: [] }),
    onOrganizeProgress: () => () => {},
    readFileAsBase64: async () => '',
    syncVirtualStorage: async () => ({ success: true, newMirroredCount: 0, totalMirroredCount: 0, totalSizeSaved: 0 }),
    scanVirtualMirror: async () => [],
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
  };
}

const rootElement = document.getElementById('root');
if (rootElement) {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <ErrorBoundary fallbackTitle="Application Encountered an Error">
        <App />
      </ErrorBoundary>
    </React.StrictMode>
  );
}

