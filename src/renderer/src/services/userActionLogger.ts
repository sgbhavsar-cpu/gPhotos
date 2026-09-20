// Logs every click and navigation action to the same rotated log file as
// everything else (via logger.ts -> electronAPI.logFromRenderer -> main
// process electron-log), timestamped, so a user-reported "it froze after I
// clicked X" can be matched second-for-second against the IPC timing
// (PerfIPC entries from preload.ts) and main-process hang-watchdog output in
// the same file. Fire-and-forget (logger.debug uses ipcRenderer.send, not
// invoke), so this adds no latency to the click it's describing.

import { logger } from './logger';

let installed = false;

function describeTarget(el: Element | null): string {
  if (!el) return 'unknown';
  let node: Element | null = el;
  // Walk up a few levels to find the nearest element with an identifiable
  // label — a raw click often lands on an <svg>/<path> icon inside a button.
  for (let depth = 0; node && depth < 5; depth++, node = node.parentElement) {
    const tag = node.tagName.toLowerCase();
    const isInteractive = tag === 'button' || tag === 'a' || node.getAttribute('role') === 'button' || (node as HTMLElement).onclick;
    if (isInteractive || depth === 0) {
      const label =
        node.getAttribute('aria-label') ||
        node.getAttribute('title') ||
        (node as HTMLElement).innerText?.trim().slice(0, 40) ||
        node.getAttribute('class')?.toString().slice(0, 60) ||
        tag;
      if (label) return `<${tag}> "${label}"`;
      if (isInteractive) return `<${tag}>`;
    }
  }
  return el.tagName.toLowerCase();
}

/** Call once at app startup (see main.tsx). Safe to call more than once. */
export function installUserActionLogger(): void {
  if (installed || typeof document === 'undefined') return;
  installed = true;

  document.addEventListener(
    'click',
    (event) => {
      try {
        const target = event.target as Element | null;
        logger.debug('UserAction', `click: ${describeTarget(target)}`);
      } catch {}
    },
    { capture: true, passive: true }
  );

  window.addEventListener('error', (event) => {
    logger.error('UserAction', `Unhandled window error: ${event.message}`, {
      filename: event.filename,
      lineno: event.lineno,
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    logger.error('UserAction', `Unhandled promise rejection: ${String(event.reason?.message || event.reason)}`);
  });
}

/** Explicit, semantic navigation logging — clearer signal than a raw click on a tab icon. */
export function logNavigation(toTab: string, fromTab?: string): void {
  logger.debug('UserAction', `navigate: ${fromTab ? `${fromTab} -> ` : ''}${toTab}`);
}

/** Wraps an async action (button handler, IPC-triggering function, etc.) with entry/exit timing. */
export async function logTimedAction<T>(name: string, action: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  logger.debug('UserAction', `start: ${name}`);
  try {
    const result = await action();
    logger.debug('UserAction', `end: ${name} (${Date.now() - startedAt}ms)`);
    return result;
  } catch (err: any) {
    logger.error('UserAction', `failed: ${name} (${Date.now() - startedAt}ms)`, { error: String(err?.message || err) });
    throw err;
  }
}
