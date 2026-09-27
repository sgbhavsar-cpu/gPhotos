import { Worker } from 'worker_threads';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { logger, type LogLevel } from './logger';
import type { DetectedFace, DetectFacesResult, OrientationProbe } from './faceDetectionEngine';

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

// Each pending entry remembers WHICH worker it went to, so a crash/timeout of
// one worker fails only that worker's requests instead of every in-flight one.
interface PendingEntry {
  resolve: (r: any) => void;
  reject: (e: Error) => void;
  worker: Worker;
  timer: NodeJS.Timeout;
}
const pending = new Map<number, PendingEntry>();

// A request that hasn't answered in this long means the worker is wedged
// (native ORT/sharp hang) — reject it, terminate that worker, let the pool respawn.
const REQUEST_TIMEOUT_MS = 3 * 60 * 1000;
// Idle workers each hold their own ONNX sessions (~100+MB); release them after this long unused.
const IDLE_TERMINATE_MS = 60 * 1000;

// Workers we shut down on purpose (idle / retired / app quit) — their exit is not a crash.
const intentionalExit = new WeakSet<Worker>();
const idleTimers = new Map<Worker, NodeJS.Timeout>();
// Retired workers still finishing in-flight requests; terminated once they drain.
const retiring = new Set<Worker>();

/** Failure of the worker itself (crash, wedge/timeout, shutdown) as opposed to a bad image. */
export class FaceWorkerError extends Error {
  /**
   * True only when this request is plausibly the CAUSE of the failure (it timed out, or it was
   * the only request on a worker that crashed). A crash rejects every request queued on that
   * worker, so for the others the failure says nothing about their own file and must not
   * count toward marking it undecodable.
   */
  readonly attributable: boolean;
  constructor(message: string, attributable = false) {
    super(message);
    this.name = 'FaceWorkerError';
    this.attributable = attributable;
  }
}

function pendingCountFor(worker: Worker): number {
  let n = 0;
  for (const entry of pending.values()) if (entry.worker === worker) n++;
  return n;
}

function failWorkerPending(worker: Worker, err: Error | ((soleRequest: boolean) => Error)): void {
  const entries = [...pending.entries()].filter(([, entry]) => entry.worker === worker);
  for (const [id, entry] of entries) {
    clearTimeout(entry.timer);
    pending.delete(id);
    entry.reject(typeof err === 'function' ? err(entries.length === 1) : err);
  }
}

function clearIdleTimer(worker: Worker): void {
  const t = idleTimers.get(worker);
  if (t) clearTimeout(t);
  idleTimers.delete(worker);
}

function dropWorker(worker: Worker): void {
  clearIdleTimer(worker);
  workers = workers.filter((w) => w !== worker);
}

function terminateWorker(worker: Worker): void {
  intentionalExit.add(worker);
  dropWorker(worker);
  worker.terminate().catch(() => {});
}

function scheduleIdleTerminate(worker: Worker): void {
  clearIdleTimer(worker);
  const t = setTimeout(() => {
    idleTimers.delete(worker);
    if (pendingCountFor(worker) === 0) terminateWorker(worker);
  }, IDLE_TERMINATE_MS);
  t.unref?.();
  idleTimers.set(worker, t);
}

/**
 * Sets how many worker threads to run face detection on. Clamped to [1, cpu count].
 * A CHANGE retires every current worker (each was spawned with an intra-op thread
 * count sized for the old pool size): they leave the pool immediately, finish
 * whatever they're running, then exit — new requests spawn fresh, correctly-sized ones.
 */
export function setFaceDetectionPoolSize(n: number): void {
  const next = Math.max(1, Math.min(os.cpus().length || 1, Math.floor(n) || 1));
  if (next === desiredPoolSize) return;
  desiredPoolSize = next;
  for (const w of [...workers]) {
    dropWorker(w);
    intentionalExit.add(w);
    if (pendingCountFor(w) === 0) w.terminate().catch(() => {});
    else retiring.add(w);
  }
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
  spawned.unref();

  spawned.on(
    'message',
    (msg: { id: number; result?: unknown; error?: string } | { log: true; level: LogLevel; scope: string; message: string; meta?: Record<string, unknown> }) => {
      if ('log' in msg) {
        logger[msg.level](msg.scope, msg.message, msg.meta);
        return;
      }
      const entry = pending.get(msg.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(msg.error));
      else entry.resolve(msg.result);

      if (pendingCountFor(spawned) === 0) {
        if (retiring.has(spawned)) {
          retiring.delete(spawned);
          spawned.terminate().catch(() => {});
        } else if (workers.includes(spawned)) {
          scheduleIdleTerminate(spawned);
        }
      }
    }
  );

  spawned.on('error', (err) => {
    logger.error('FaceDetectionWorker', 'Worker thread crashed', { err: String(err) });
    dropWorker(spawned);
    failWorkerPending(spawned, (sole) => new FaceWorkerError(`Face detection worker crashed: ${err instanceof Error ? err.message : String(err)}`, sole));
  });

  spawned.on('exit', (code) => {
    if (code !== 0 && !intentionalExit.has(spawned)) {
      logger.warn('FaceDetectionWorker', 'Worker thread exited unexpectedly', { code });
    }
    retiring.delete(spawned);
    dropWorker(spawned);
    // Anything still waiting on this worker will never be answered — fail it now
    // (also covers a clean exit with requests outstanding).
    failWorkerPending(spawned, (sole) => new FaceWorkerError(`Face detection worker exited with code ${code}`, sole));
  });

  return spawned;
}

/** Lazily grows the pool to desiredPoolSize (a size change retires the old workers, see setFaceDetectionPoolSize). */
function getPool(): Worker[] {
  while (workers.length < desiredPoolSize) workers.push(spawnWorker());
  return workers;
}

// Each worker decodes full-resolution images (100MB+ each) and runs one request at a time, so
// when the process is already over its RAM budget hold new work back (bounded) instead of
// piling on. Worker threads share the process RSS, so process.memoryUsage().rss covers them.
let maxRamMb = (() => {
  const env = Number(process.env.GPHOTOS_FACE_MAX_RAM_MB);
  if (Number.isFinite(env) && env >= 512) return env;
  return Math.max(2048, Math.min(8192, Math.round((os.totalmem() / (1024 * 1024)) * 0.6)));
})();
const RAM_BACKOFF_STEP_MS = 500;
const RAM_BACKOFF_MAX_MS = 15_000;

/** Process RSS (MB) above which new face requests wait. Clamped to [512, 16384]. */
export function setFaceDetectionMaxRamMb(mb: number): void {
  if (Number.isFinite(mb)) maxRamMb = Math.max(512, Math.min(16384, Math.floor(mb)));
}

export function getFaceDetectionMaxRamMb(): number {
  return maxRamMb;
}

async function waitForRamHeadroom(): Promise<void> {
  let waited = 0;
  while (waited < RAM_BACKOFF_MAX_MS && process.memoryUsage().rss / (1024 * 1024) > maxRamMb) {
    await new Promise<void>((r) => setTimeout(r, RAM_BACKOFF_STEP_MS));
    waited += RAM_BACKOFF_STEP_MS;
  }
}

async function callWorker<T>(message: Record<string, unknown>): Promise<T> {
  await waitForRamHeadroom();
  return dispatch<T>(message);
}

function dispatch<T>(message: Record<string, unknown>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const pool = getPool();
    // Workers process one request at a time: prefer the least-loaded one (round-robin breaks ties).
    let target = pool[roundRobinIndex % pool.length];
    let best = pendingCountFor(target);
    for (const w of pool) {
      const n = pendingCountFor(w);
      if (n < best) { target = w; best = n; }
    }
    roundRobinIndex++;
    clearIdleTimer(target);
    const id = nextRequestId++;
    const timer = setTimeout(() => {
      const entry = pending.get(id);
      if (!entry) return;
      logger.error('FaceDetectionWorker', 'Request timed out — terminating wedged worker', { timeoutMs: REQUEST_TIMEOUT_MS });
      pending.delete(id);
      entry.reject(new FaceWorkerError(`Face detection worker timed out after ${Math.round(REQUEST_TIMEOUT_MS / 1000)}s`, true));
      // The worker may be stuck in native code: kill it, drop it from the pool
      // (the next call respawns), and fail whatever else was queued on it.
      terminateWorker(target);
      failWorkerPending(target, new FaceWorkerError('Face detection worker was terminated after another request timed out'));
    }, REQUEST_TIMEOUT_MS);
    timer.unref?.();
    pending.set(id, { resolve, reject, worker: target, timer });
    try {
      target.postMessage({ id, ...message });
    } catch (err) {
      clearTimeout(timer);
      pending.delete(id);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

export function detectFaces(imageBuffer: Buffer): Promise<DetectFacesResult> {
  return callWorker<DetectFacesResult>({ kind: 'detect', buffer: imageBuffer });
}

/** Detector-only orientation probe (see faceDetectionEngine.probeOrientation). Same pool/timeout/RAM rules as detectFaces. */
export function probeFaceOrientation(imageBuffer: Buffer): Promise<OrientationProbe> {
  return callWorker<OrientationProbe>({ kind: 'probeOrientation', buffer: imageBuffer });
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
  const all = new Set<Worker>([...workers, ...retiring]);
  for (const w of all) terminateWorker(w);
  workers = [];
  retiring.clear();
  const err = new FaceWorkerError('Face detection worker terminated');
  for (const w of new Set([...pending.values()].map((e) => e.worker))) failWorkerPending(w, err);
}
