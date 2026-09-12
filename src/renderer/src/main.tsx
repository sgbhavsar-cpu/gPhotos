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
        return data[key] || null;
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
    scanDirectory: async () => [],
    readExif: async () => ({}),
    analyzeDryRun: async () => ({ totalFiles: 0, byYearMonth: {}, duplicateCount: 0, previewFiles: [] }),
    executeOrganize: async () => ({ success: true, processedCount: 0, errors: [] }),
    onOrganizeProgress: () => () => {},
    readFileAsBase64: async () => '',
    syncVirtualStorage: async () => ({ success: true, newMirroredCount: 0, totalMirroredCount: 0, totalSizeSaved: 0 }),
    scanVirtualMirror: async () => [],
    openOriginalFile: async () => {},
    onMirrorProgress: () => () => {},
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

