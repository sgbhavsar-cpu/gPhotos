import { isMainThread, parentPort } from 'worker_threads';
import type { LogLevel } from './logger';

// logger.ts talks to electron-log, which is configured (rotated log file,
// level overrides) once at main-process startup — that setup never runs
// inside a worker_threads Worker, and a worker's own electron-log import is
// an unconfigured, unrelated instance. Any module that might run inside a
// worker (faceDetectionEngine.ts) should import `logger` from here instead
// of directly from './logger': on the main thread it's a passthrough, and
// inside a worker it forwards each call over parentPort to the real logger
// in faceDetectionWorkerClient.ts, so log lines still land in the one
// rotated main.log file with correct formatting either way.

type LogMeta = Record<string, unknown> | undefined;

function post(level: LogLevel, scope: string, message: string, meta?: LogMeta): void {
  parentPort!.postMessage({ log: true, level, scope, message, meta });
}

export const logger = isMainThread
  ? (require('./logger').logger as {
      debug: (scope: string, message: string, meta?: LogMeta) => void;
      info: (scope: string, message: string, meta?: LogMeta) => void;
      warn: (scope: string, message: string, meta?: LogMeta) => void;
      error: (scope: string, message: string, meta?: LogMeta) => void;
    })
  : {
      debug: (scope: string, message: string, meta?: LogMeta) => post('debug', scope, message, meta),
      info: (scope: string, message: string, meta?: LogMeta) => post('info', scope, message, meta),
      warn: (scope: string, message: string, meta?: LogMeta) => post('warn', scope, message, meta),
      error: (scope: string, message: string, meta?: LogMeta) => post('error', scope, message, meta),
    };
