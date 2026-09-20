import { Worker } from 'worker_threads';
import path from 'path';
import fs from 'fs';
import { logger, type LogLevel } from './logger';
import type { DetectedFace, DetectFacesResult } from './faceDetectionEngine';

// Main-process-side handle for faceDetectionWorker.ts — see that file for why
// this exists. Every exported function here has the exact same signature as
// its faceDetectionEngine.ts counterpart, so callers (pipelineOrchestrator.ts,
// main.ts) just swap the import instead of restructuring their own code.

let worker: Worker | null = null;
let nextRequestId = 1;
const pending = new Map<number, { resolve: (r: any) => void; reject: (e: Error) => void }>();

function failAllPending(err: Error): void {
  for (const entry of pending.values()) entry.reject(err);
  pending.clear();
}

/**
 * The real app always runs the tsc-compiled dist-electron output, where
 * faceDetectionWorker.js sits right next to this file — that's the plain,
 * fast path. The vitest suite instead runs pipelineOrchestrator.spec.ts
 * straight against TypeScript source (no build step), where only the .ts
 * sibling exists; there, spawn it through tsx's loader so the worker thread
 * can still require() a .ts file directly.
 */
function resolveWorkerSpec(): { path: string; execArgv?: string[] } {
  const compiled = path.join(__dirname, 'faceDetectionWorker.js');
  if (fs.existsSync(compiled)) return { path: compiled };
  return { path: path.join(__dirname, 'faceDetectionWorker.ts'), execArgv: ['--import', 'tsx'] };
}

function getWorker(): Worker {
  if (worker) return worker;

  const { path: workerPath, execArgv } = resolveWorkerSpec();
  const spawned = new Worker(workerPath, execArgv ? { execArgv } : undefined);

  spawned.on(
    'message',
    (msg: { id: number; result?: unknown; error?: string } | { log: true; level: LogLevel; scope: string; message: string; meta?: Record<string, unknown> }) => {
      if ('log' in msg) {
        logger[msg.level](msg.scope, msg.message, msg.meta);
        return;
      }
      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(msg.error));
      else entry.resolve(msg.result);
    }
  );

  spawned.on('error', (err) => {
    logger.error('FaceDetectionWorker', 'Worker thread crashed', { err: String(err) });
    failAllPending(err instanceof Error ? err : new Error(String(err)));
    if (worker === spawned) worker = null;
  });

  spawned.on('exit', (code) => {
    if (code !== 0) {
      logger.warn('FaceDetectionWorker', 'Worker thread exited unexpectedly', { code });
      failAllPending(new Error(`Face detection worker exited with code ${code}`));
    }
    if (worker === spawned) worker = null;
  });

  worker = spawned;
  return spawned;
}

function callWorker<T>(message: Record<string, unknown>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = nextRequestId++;
    pending.set(id, { resolve, reject });
    try {
      getWorker().postMessage({ id, ...message });
    } catch (err) {
      pending.delete(id);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

export function detectFaces(imageBuffer: Buffer): Promise<DetectFacesResult> {
  return callWorker<DetectFacesResult>({ kind: 'detect', buffer: imageBuffer });
}

export function detectFaceInRegion(
  imageBuffer: Buffer,
  box: { x: number; y: number; width: number; height: number },
  marginRatio = 0.2
): Promise<DetectedFace | null> {
  return callWorker<DetectedFace | null>({ kind: 'detectRegion', buffer: imageBuffer, box, marginRatio });
}

/** Best-effort shutdown, called on app quit so the process can exit cleanly. */
export function terminateFaceDetectionWorker(): void {
  if (worker) {
    worker.terminate().catch(() => {});
    worker = null;
  }
  failAllPending(new Error('Face detection worker terminated'));
}
