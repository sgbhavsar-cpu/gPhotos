import './browserShim';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { MobileAuthGate } from './components/MobileAuthGate';
import { NoticeHost } from './components/NoticeHost';
import { installUserActionLogger } from './services/userActionLogger';
import { logger } from './services/logger';
import { notifyError } from './services/notifications';
import './index.css';

// Logs every click/navigation + unhandled error to the same file-backed log
// the main process and IPC timing (preload.ts) write to — see
// userActionLogger.ts for why this exists (diagnosing "window not
// responding" reports needs a click-by-click, IPC-call-by-IPC-call timeline).
installUserActionLogger();

// Global error handlers to prevent silent failures and ensure diagnostics
if (typeof window !== 'undefined') {
  window.addEventListener('error', (event) => {
    console.error('[Global Unhandled Window Error]:', event.error || event.message, event);
    notifyError('Unexpected error', event.error || event.message);
  });

  window.addEventListener('unhandledrejection', (event) => {
    console.error('[Global Unhandled Promise Rejection]:', event.reason);
    notifyError('Operation failed', event.reason);
  });

  // Register client-side Service Worker for blazing-fast photo thumbnail caching
  if ('serviceWorker' in navigator && window.location?.protocol?.startsWith('http')) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch((err) => {
        console.warn('[ServiceWorker] Registration notice:', err);
      });
    });
  }
}

const rootElement = document.getElementById('root');
if (rootElement) {
  ReactDOM.createRoot(rootElement, {
    // Errors an ErrorBoundary caught never reach window.onerror; log them so they land in main.log.
    onCaughtError: (err) => logger.error('ErrorBoundary', String((err as Error)?.stack || err)),
    onUncaughtError: (err) => notifyError('Application error', err),
  }).render(
    <React.StrictMode>
      <ErrorBoundary fallbackTitle="Application Encountered an Error">
        <MobileAuthGate>
          <App />
        </MobileAuthGate>
      </ErrorBoundary>
      <NoticeHost />
    </React.StrictMode>
  );
}

