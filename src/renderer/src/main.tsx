import './browserShim';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { MobileAuthGate } from './components/MobileAuthGate';
import './index.css';

// Global error handlers to prevent silent failures and ensure diagnostics
if (typeof window !== 'undefined') {
  window.addEventListener('error', (event) => {
    console.error('[Global Unhandled Window Error]:', event.error || event.message, event);
  });

  window.addEventListener('unhandledrejection', (event) => {
    console.error('[Global Unhandled Promise Rejection]:', event.reason);
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
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <ErrorBoundary fallbackTitle="Application Encountered an Error">
        <MobileAuthGate>
          <App />
        </MobileAuthGate>
      </ErrorBoundary>
    </React.StrictMode>
  );
}

