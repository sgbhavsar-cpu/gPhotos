import { Worker } from 'worker_threads';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { logger, type LogLevel } from './logger';
import type { DetectedFace, DetectFacesResult } from './faceDetectionEngine';

// Main-process-side handle for faceDetectionWorker.ts — see that file for why
// this exists. Every exported function here has the exact same signature as
// its faceDetectionEngine.ts counterpart, so callers (pipelineOrchestrator.ts,
// main.ts) just swap the import instead of restructuring their own code.
//
// Runs a small POOL of these workers (default size 1, i.e. today's behavior)
// instead of a single one — Turbo Mode raises the pool size so multiple
// photos' ONNX inference actually runs on separate cores at once, instead of
// serializing through one worker's message loop. Each worker loads its own
// ONNX sessions (module state isn't shared across worker_threads), and gets
// told via workerData how many intra-op threads to give each session, so
// N workers don't each try to claim every core and thrash each other.

let workers: Worker[] = [];
let desiredPoolSize = 1;
let roundRobinIndex = 0;
let nextRequestId = 1;
const pending = new Map<number, { resolve: (r: any) => void; reject: (e: Error) => void }>();

function failAllPending(err: Error): void {
  for (const entry of pending.values()) entry.reject(err);
  pending.clear();
}

/** Sets how many worker threads to run face detection on; takes effect for newly-spawned workers (call before a batch starts). Clamped to [1, cpu count]. */
export function setFaceDetectionPoolSize(n: number): void {
  desiredPoolSize = Math.max(1, Math.min(os.cpus().length || 1, Math.floor(n) || 1));
}

export function getFaceDetectionPoolSize(): number {
  return desiredPoolSize;
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

function spawnWorker(): Worker {
  const { path: workerPath, execArgv } = resolveWorkerSpec();
  // Split available cores across the pool so N workers' ONNX sessions don't
  // each default to "all cores" and oversubscribe the machine.
  const intraOpNumThreads = Math.max(1, Math.floor((os.cpus().length || 1) / desiredPoolSize));
  const spawned = new Worker(workerPath, {
    ...(execArgv ? { execArgv } : {}),
    workerData: { intraOpNumThreads },
  });

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
    workers = workers.filter((w) => w !== spawned);
  });

  spawned.on('exit', (code) => {
    if (code !== 0) {
      logger.warn('FaceDetectionWorker', 'Worker thread exited unexpectedly', { code });
      failAllPending(new Error(`Face detection worker exited with code ${code}`));
    }
    workers = workers.filter((w) => w !== spawned);
  });

  return spawned;
}

/** Lazily grows the pool to desiredPoolSize; never shrinks a live pool (mid-batch resize isn't worth the complexity — set pool size before starting a scan). */
function getPool(): Worker[] {
  while (workers.length < desiredPoolSize) workers.push(spawnWorker());
  return workers;
}

function callWorker<T>(message: Record<string, unknown>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const pool = getPool();
    const target = pool[roundRobinIndex % pool.length];
    roundRobinIndex++;
    const id = nextRequestId++;
    pending.set(id, { resolve, reject });
    try {
      target.postMessage({ id, ...message });
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
  for (const w of workers) w.terminate().catch(() => {});
  workers = [];
  failAllPending(new Error('Face detection worker terminated'));
}
