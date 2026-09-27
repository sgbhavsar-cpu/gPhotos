// One app-wide, user-visible notice channel (toasts). No React here so stores,
// services and the browser shim can report failures without importing UI code;
// <NoticeHost/> renders whatever is published. Errors also go to the log file.
import { logger } from './logger';

export type NoticeKind = 'error' | 'warning' | 'success' | 'info';
export interface Notice {
  id: number;
  kind: NoticeKind;
  message: string;
  detail?: string;
  count: number;
}

// Replaced (never mutated) so useSyncExternalStore sees a new snapshot per change.
let notices: Notice[] = [];
let nextId = 1;
const subscribers = new Set<() => void>();
const emit = () => subscribers.forEach((fn) => fn());

export const subscribeNotices = (fn: () => void) => {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
};
export const getNotices = () => notices;
// Auto-dismiss timers by notice id, so a repeat can reschedule and a manual dismiss can cancel.
const dismissTimers = new Map<number, ReturnType<typeof setTimeout>>();
export const dismissNotice = (id: number) => {
  clearTimeout(dismissTimers.get(id));
  dismissTimers.delete(id);
  notices = notices.filter((n) => n.id !== id);
  emit();
};

export function notify(kind: NoticeKind, message: string, detail?: string) {
  const dup = notices.find((n) => n.kind === kind && n.message === message);
  let id: number;
  if (dup) {
    id = dup.id; // identical notice: bump a counter instead of flooding the screen
    notices = notices.map((n) => (n === dup ? { ...n, count: n.count + 1 } : n));
  } else {
    id = nextId++;
    notices = [...notices, { id, kind, message, detail, count: 1 }].slice(-4);
  }
  emit();
  // Errors stay until dismissed; everything else clears itself.
  // A repeat restarts the countdown (the first occurrence's timer would otherwise remove it early).
  if (kind !== 'error') {
    clearTimeout(dismissTimers.get(id));
    dismissTimers.set(id, setTimeout(() => dismissNotice(id), 4500));
  }
}

// Noise that must never reach the user.
const BENIGN = /ResizeObserver loop|AbortError|aborted a request|The operation was aborted/i;

/** Log + show an error. `context` says what the user was trying to do. */
export function notifyError(context: string, err: unknown) {
  const e = err as { message?: string; stack?: string; name?: string } | null | undefined;
  const msg = e?.message || (typeof err === 'string' ? err : '') || 'Unknown error';
  if (e?.name === 'AbortError' || BENIGN.test(msg)) return;
  try {
    logger.error('UI', `${context}: ${msg}`, { stack: e?.stack });
  } catch {}
  notify('error', `${context}: ${msg}`, e?.stack);
}

/** Wrap an async handler so a rejection becomes a visible notice instead of an unhandled rejection. */
export const runAction =
  <A extends unknown[]>(label: string, fn: (...args: A) => unknown) =>
  async (...args: A): Promise<void> => {
    try {
      await fn(...args);
    } catch (err) {
      notifyError(label, err);
    }
  };
