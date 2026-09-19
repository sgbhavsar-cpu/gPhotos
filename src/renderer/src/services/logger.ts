// Renderer-side logging wrapper matching the main-process logger's API
// (src/main/services/logger.ts), so call sites look identical regardless of
// which process they run in. Routes through electronAPI.logFromRenderer,
// which forwards into the same rotated log file the main process writes to
// (see docs/PIPELINE_REDESIGN_DEV_DOC.md §3.8). Falls back to console when
// running outside Electron (e.g. browser dev/tests) so this never throws.

type LogMeta = Record<string, unknown> | undefined;
type LogLevel = 'debug' | 'info' | 'warn' | 'error';

function write(level: LogLevel, scope: string, message: string, meta?: LogMeta): void {
  const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
  if (api?.logFromRenderer) {
    try {
      api.logFromRenderer(level, scope, message, meta);
      return;
    } catch {
      // fall through to console below
    }
  }
  const consoleMethod = level === 'debug' ? console.log : console[level];
  if (meta !== undefined) {
    consoleMethod(`[${scope}] ${message}`, meta);
  } else {
    consoleMethod(`[${scope}] ${message}`);
  }
}

export const logger = {
  debug: (scope: string, message: string, meta?: LogMeta) => write('debug', scope, message, meta),
  info: (scope: string, message: string, meta?: LogMeta) => write('info', scope, message, meta),
  warn: (scope: string, message: string, meta?: LogMeta) => write('warn', scope, message, meta),
  error: (scope: string, message: string, meta?: LogMeta) => write('error', scope, message, meta),
};
