import './browserShim';
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

