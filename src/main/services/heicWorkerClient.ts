import { Worker } from 'worker_threads';
import fs from 'fs';
import path from 'path';

// Client for heicWorker.ts: runs heic-convert (libheif WASM) on a worker thread
// so a multi-second HEVC decode no longer freezes the main process.
//
// - Pool of HEIC_POOL_SIZE workers (1 by default, max 2), one decode in flight
//   per worker, so at most HEIC_POOL_SIZE full-res decodes exist at any time.
// - Two FIFO queues: 'high' (500px thumbnails) is served before 'low' (full-res
//   / HQ), but after MAX_HIGH_STREAK consecutive highs one low job goes next so
//   a thumbnail flood can't starve full-res work forever.
// - A worker error/exit/timeout fails only the job running on it; the slot
//   respawns lazily on the next job. Idle workers are terminated.
// - If a worker cannot be started at all, the decode runs in-process (serialized)
//   so functionality is never lost.

export type HeicPriority = 'high' | 'low';

/** The worker thread itself could not be started (as opposed to a decode failing). */
export class HeicWorkerUnavailableError extends Error {}

const HEIC_POOL_SIZE = 1; // max 2 (each worker holds its own libheif WASM heap, hundreds of MB during a decode)
const REQUEST_TIMEOUT_MS = 2 * 60 * 1000;
const IDLE_TERMINATE_MS = 60 * 1000;
const MAX_HIGH_STREAK = 8;

const cfg: { poolSize: number; timeoutMs: number; idleMs: number; workerPath?: string } = {
  poolSize: Math.min(2, Math.max(1, HEIC_POOL_SIZE)),
  timeoutMs: REQUEST_TIMEOUT_MS,
  idleMs: IDLE_TERMINATE_MS,
};

interface Job {
  id: number;
  buffer: Buffer;
  quality: number;
  resolve: (b: Buffer) => void;
  reject: (e: Error) => void;
  timer?: NodeJS.Timeout;
}
interface Slot {
  worker: Worker | null;
  job: Job | null;
  idle: NodeJS.Timeout | null;
}

let slots: Slot[] = [];
const high: Job[] = [];
const low: Job[] = [];
let highStreak = 0;
let nextId = 1;
let broken = false; // worker threads can't start in this environment: use the in-process path

function getSlots(): Slot[] {
  while (slots.length < cfg.poolSize) slots.push({ worker: null, job: null, idle: null });
  return slots;
}

/** Compiled dist-electron has heicWorker.js next to this file; under vitest only the .ts exists, so load it through tsx. */
function resolveWorkerSpec(): { path: string; execArgv?: string[] } {
  if (cfg.workerPath) return { path: cfg.workerPath };
  const compiled = path.join(__dirname, 'heicWorker.js');
  if (fs.existsSync(compiled)) return { path: compiled };
  return { path: path.join(__dirname, 'heicWorker.ts'), execArgv: ['--import', 'tsx'] };
}

function clearIdle(slot: Slot) {
  if (slot.idle) clearTimeout(slot.idle);
  slot.idle = null;
}

function scheduleIdle(slot: Slot) {
  clearIdle(slot);
  slot.idle = setTimeout(() => {
    slot.idle = null;
    if (slot.job || !slot.worker) return;
    const w = slot.worker;
    slot.worker = null;
    w.terminate().catch(() => {});
  }, cfg.idleMs);
  slot.idle.unref?.();
}

/** Fails only the job running on `w` (if it is still the slot's worker) and drops the worker; the slot respawns lazily. */
function failWorker(slot: Slot, w: Worker, err: Error, unavailable: boolean) {
  if (slot.worker !== w) return; // already retired / replaced
  slot.worker = null;
  clearIdle(slot);
  const job = slot.job;
  slot.job = null;
  w.terminate().catch(() => {});
  if (unavailable) broken = true;
  if (job) {
    if (job.timer) clearTimeout(job.timer);
    job.reject(unavailable ? new HeicWorkerUnavailableError(err.message) : err);
  }
  pump();
}

function spawn(slot: Slot): Worker {
  const { path: workerPath, execArgv } = resolveWorkerSpec();
  const w = new Worker(workerPath, execArgv ? { execArgv } : {});
  w.unref();
  let ready = false; // worker script loaded (it posts {ready:true}); an error before that means it can't run here
  w.on('message', (msg: { ready?: boolean; id: number; result?: Uint8Array; error?: string }) => {
    if (msg.ready) { ready = true; return; }
    const job = slot.worker === w ? slot.job : null;
    if (!job || msg.id !== job.id) return;
    if (job.timer) clearTimeout(job.timer);
    slot.job = null;
    if (msg.error !== undefined || !msg.result) job.reject(new Error(msg.error ?? 'HEIC worker returned no data'));
    else job.resolve(Buffer.from(msg.result.buffer, msg.result.byteOffset, msg.result.byteLength));
    scheduleIdle(slot);
    pump();
  });
  // Never let a worker failure escape as an uncaught exception in the main process.
  w.on('error', (err) => {
    console.error('[heicWorker] worker thread error:', err);
    failWorker(slot, w, err instanceof Error ? err : new Error(String(err)), !ready);
  });
  w.on('exit', (code) => failWorker(slot, w, new Error(`HEIC worker exited with code ${code}`), false));
  return w;
}

function dispatch(slot: Slot, job: Job) {
  clearIdle(slot);
  let w: Worker;
  try {
    w = slot.worker ?? (slot.worker = spawn(slot));
  } catch (err) {
    slot.worker = null;
    broken = true;
    job.reject(new HeicWorkerUnavailableError(err instanceof Error ? err.message : String(err)));
    return;
  }
  slot.job = job;
  job.timer = setTimeout(() => {
    console.error(`[heicWorker] decode timed out after ${cfg.timeoutMs}ms; terminating worker`);
    failWorker(slot, w, new Error(`HEIC decode timed out after ${Math.round(cfg.timeoutMs / 1000)}s`), false);
  }, cfg.timeoutMs);
  job.timer.unref?.();
  try {
    // Input is copied (a few MB, ~ms); the large result comes back transferred.
    w.postMessage({ id: job.id, buffer: job.buffer, quality: job.quality });
  } catch (err) {
    failWorker(slot, w, err instanceof Error ? err : new Error(String(err)), false);
  }
}

function nextJob(): Job | undefined {
  if (high.length && (highStreak < MAX_HIGH_STREAK || !low.length)) {
    highStreak++;
    return high.shift();
  }
  highStreak = 0;
  return low.shift();
}

function pump() {
  if (broken) {
    for (const j of [...high.splice(0), ...low.splice(0)]) j.reject(new HeicWorkerUnavailableError('HEIC worker unavailable'));
    return;
  }
  for (;;) {
    const slot = getSlots().find((s) => !s.job);
    if (!slot) return;
    const job = nextJob();
    if (!job) return;
    dispatch(slot, job);
    if (broken) return pump();
  }
}

// ponytail: in-process fallback is a simple serial chain; it only runs when worker threads cannot start at all.
let inProcessChain: Promise<unknown> = Promise.resolve();
let warnedFallback = false;
function decodeInProcess(buffer: Buffer, quality: number): Promise<Buffer> {
  if (!warnedFallback) {
    warnedFallback = true;
    console.warn('[heicWorker] worker unavailable; decoding HEIC in-process (main thread)');
  }
  const p = inProcessChain
    .then(() => require('heic-convert')({ buffer, format: 'JPEG', quality }))
    .then((converted: Uint8Array) => Buffer.from(converted));
  inProcessChain = p.catch(() => {});
  return p;
}

/**
 * Full-bitstream heic-convert decode to JPEG on the worker thread.
 * 'high' = small/interactive work (500px thumbnails), 'low' = full-resolution work.
 * Rejects with the decode error (like heic-convert would); falls back to the
 * in-process path only when the worker cannot be started.
 */
export function decodeHeicToJpeg(buffer: Buffer, quality: number, priority: HeicPriority = 'low'): Promise<Buffer> {
  if (broken) return decodeInProcess(buffer, quality);
  return new Promise<Buffer>((resolve, reject) => {
    (priority === 'high' ? high : low).push({ id: nextId++, buffer, quality, resolve, reject });
    pump();
  }).catch((err) => {
    if (err instanceof HeicWorkerUnavailableError) return decodeInProcess(buffer, quality);
    throw err;
  });
}

export function getHeicWorkerStats(): { workers: number; busy: number; queuedHigh: number; queuedLow: number; broken: boolean } {
  return {
    workers: slots.filter((s) => s.worker).length,
    busy: slots.filter((s) => s.job).length,
    queuedHigh: high.length,
    queuedLow: low.length,
    broken,
  };
}

/** Test hook: override the worker script / limits and reset all state (terminates current workers). */
export function configureHeicWorker(opts: { poolSize?: number; timeoutMs?: number; idleMs?: number; workerPath?: string }): void {
  for (const s of slots) {
    clearIdle(s);
    if (s.job?.timer) clearTimeout(s.job.timer);
    s.worker?.terminate().catch(() => {});
  }
  slots = [];
  high.length = 0;
  low.length = 0;
  highStreak = 0;
  broken = false;
  if (opts.poolSize !== undefined) cfg.poolSize = Math.min(2, Math.max(1, opts.poolSize));
  if (opts.timeoutMs !== undefined) cfg.timeoutMs = opts.timeoutMs;
  if (opts.idleMs !== undefined) cfg.idleMs = opts.idleMs;
  cfg.workerPath = opts.workerPath;
}
