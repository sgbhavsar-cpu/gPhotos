/**
 * Response Latency Tracker Service
 * 
 * Detects when backend requests are not served within 20 to 50 milliseconds (threshold: 35ms).
 * Informs the UI to show a small animated wait icon in the top portion of the application.
 * Guarantees that when all requests complete or are cancelled by the user, the icon is immediately removed/hidden.
 */

import { useState, useEffect } from 'react';

export interface ResponseTrackerState {
  isWaitingBackend: boolean; // active when pending request exceeds 20-50ms threshold
  activeCount: number;
  label: string;
}

type Listener = (state: ResponseTrackerState) => void;

interface ActiveOp {
  label: string;
  startTime: number;
  safetyTimer: any;
  abortController?: AbortController;
}

class ResponseTrackerService {
  private activeOperations = new Map<number, ActiveOp>();
  private nextOpId = 1;
  private listeners = new Set<Listener>();

  private timerThreshold: any = null;

  // 35ms threshold (within the 20 to 50 ms window requested by user)
  private readonly LATENCY_THRESHOLD_MS = 35;
  private readonly OP_SAFETY_TIMEOUT_MS = 5000; // Auto-cancel if backend hangs > 5s

  private state: ResponseTrackerState = {
    isWaitingBackend: false,
    activeCount: 0,
    label: '',
  };

  private interceptorsInstalled = false;

  public getState(): ResponseTrackerState {
    return this.state;
  }

  public subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.state);
      } catch (err) {
        console.error('[ResponseTracker] Listener error:', err);
      }
    }
  }

  /**
   * Immediately resets and cancels all pending operations, hiding the wait icon.
   * Invoked when the user clicks cancel, switches tabs, changes libraries, or navigates.
   */
  public clearAll(): void {
    for (const op of this.activeOperations.values()) {
      if (op.safetyTimer) clearTimeout(op.safetyTimer);
      if (op.abortController) {
        try {
          op.abortController.abort();
        } catch {}
      }
    }
    this.activeOperations.clear();
    this.clearTimers();
    this.state.isWaitingBackend = false;
    this.state.activeCount = 0;
    this.state.label = '';
    this.notify();
  }

  /**
   * Alias for clearAll()
   */
  public cancelAll(): void {
    this.clearAll();
  }

  /**
   * Starts tracking an operation. Returns a function to complete the operation.
   */
  public startOperation(label: string = 'Waiting for backend...', abortController?: AbortController): () => void {
    const opId = this.nextOpId++;
    const now = Date.now();

    // Auto-timeout safety so an unhandled or hung request never keeps the wait icon stuck
    const safetyTimer = setTimeout(() => {
      if (this.activeOperations.has(opId)) {
        endOp();
      }
    }, this.OP_SAFETY_TIMEOUT_MS);

    this.activeOperations.set(opId, { label, startTime: now, safetyTimer, abortController });
    this.state.activeCount = this.activeOperations.size;
    this.state.label = label;

    if (this.activeOperations.size === 1) {
      this.scheduleTimers();
    }

    let ended = false;
    const endOp = () => {
      if (ended) return;
      ended = true;

      const op = this.activeOperations.get(opId);
      if (op && op.safetyTimer) {
        clearTimeout(op.safetyTimer);
      }

      this.activeOperations.delete(opId);
      this.state.activeCount = this.activeOperations.size;

      // When all requests are completed or cancelled, immediately remove and hide the wait icon
      if (this.activeOperations.size === 0) {
        this.clearTimers();
        this.state.isWaitingBackend = false;
        this.state.label = '';
        this.notify();
      } else {
        const remaining = Array.from(this.activeOperations.values());
        this.state.label = remaining[remaining.length - 1].label;
        this.notify();
      }
    };

    return endOp;
  }

  /**
   * Wraps an async Promise and tracks its latency. Supports AbortSignal / AbortController for user cancellation.
   */
  public async trackPromise<T>(
    promise: Promise<T>,
    label?: string,
    signalOrController?: AbortSignal | AbortController
  ): Promise<T> {
    let controller: AbortController | undefined;
    let signal: AbortSignal | undefined;

    if (signalOrController instanceof AbortController) {
      controller = signalOrController;
      signal = controller.signal;
    } else if (signalOrController && typeof (signalOrController as any).addEventListener === 'function') {
      signal = signalOrController as AbortSignal;
    }

    const endOp = this.startOperation(label, controller);

    if (signal) {
      if (signal.aborted) {
        endOp();
        return promise;
      }
      signal.addEventListener('abort', () => endOp(), { once: true });
    }

    try {
      return await promise;
    } finally {
      endOp();
    }
  }

  private scheduleTimers(): void {
    this.clearTimers();

    // 20-50ms latency threshold (35ms)
    this.timerThreshold = setTimeout(() => {
      if (this.activeOperations.size > 0) {
        this.state.isWaitingBackend = true;
        this.notify();
      }
    }, this.LATENCY_THRESHOLD_MS);
  }

  private clearTimers(): void {
    if (this.timerThreshold) {
      clearTimeout(this.timerThreshold);
      this.timerThreshold = null;
    }
  }

  /**
   * Safe fetch interceptor for HTTP API calls (never mutates frozen Electron objects).
   * Only intercepts primary data-loading operations to avoid false positives on background image loads.
   */
  public installSafeFetchInterceptor(): void {
    if (this.interceptorsInstalled || typeof window === 'undefined') return;
    this.interceptorsInstalled = true;

    try {
      if (typeof window.fetch === 'function') {
        const origFetch = window.fetch;
        window.fetch = async (...args) => {
          const url = typeof args[0] === 'string' ? args[0] : (args[0] as any)?.url || '';
          
          let label: string | null = null;
          if (url.includes('/api/catalog-page')) label = 'Loading photos...';
          else if (url.includes('/api/catalog-meta')) label = 'Loading catalog...';
          else if (url.includes('/api/switch-library')) label = 'Switching library...';
          else if (url.includes('/api/scan') || url.includes('/api/scan-mirror') || url.includes('/api/scan-directory')) label = 'Scanning photos...';
          else if (url.includes('/api/sync-virtual-storage')) label = 'Syncing storage...';
          else if (url.includes('/api/library') && !url.includes('/api/photo')) label = 'Loading library...';

          // Do NOT intercept background photo blobs (/api/photo), sprite coords, or status polling
          if (!label) {
            return origFetch.apply(window, args);
          }

          const existingSignal = (args[1] as RequestInit | undefined)?.signal;
          return this.trackPromise(origFetch.apply(window, args), label, existingSignal as AbortSignal | undefined);
        };
      }
    } catch (err) {
      console.warn('[ResponseTracker] Could not install fetch interceptor:', err);
    }
  }
}

export const responseTracker = new ResponseTrackerService();

/**
 * Convenience helper to wrap any async backend or IPC call
 */
export function trackBackendCall<T>(
  promise: Promise<T>,
  label?: string,
  signalOrController?: AbortSignal | AbortController
): Promise<T> {
  return responseTracker.trackPromise(promise, label, signalOrController);
}

/**
 * React hook to listen to backend waiting status
 */
export function useResponseTracker(): ResponseTrackerState {
  const [state, setState] = useState<ResponseTrackerState>(() => responseTracker.getState());

  useEffect(() => {
    return responseTracker.subscribe((newState) => {
      setState({ ...newState });
    });
  }, []);

  return state;
}

export default responseTracker;
