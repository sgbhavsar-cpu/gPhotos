import fs from 'fs';
import path from 'path';
import os from 'os';
import { Photo, ThumbnailWorkerCheckpoint } from '../../types';
import { getOrGenerateCachedThumbnail, onThumbnailCacheCleared, getCacheKey } from './thumbnailCacheService';
import { libraryStatusService } from './libraryStatusService';
import { getDefaultMirrorRoot } from './pathSecurity';

let sharp: any = null;
try {
  sharp = require('sharp');
  // Configure Sharp memory cache strictly to avoid memory bloat
  // files:0 — sharp's file cache keeps source files open, which on Windows
  // locks the user's photos (rotate/delete fails with EBUSY).
  if (sharp.cache) {
    sharp.cache({ memory: 64, files: 0, items: 200 });
  }
} catch {}

interface WorkerLimits {
  maxCpuPercent: number; // e.g. 40
  maxRamMb: number; // e.g. 1024
  enabled: boolean;
  concurrency: number; // photos generated in parallel per batch, e.g. 1 (default) or cpu count (Turbo Mode)
}

interface WorkerStatus {
  isRunning: boolean;
  paused: boolean;
  current: number;
  total: number;
  cpuPercent: number;
  ramMb: number;
  currentFile?: string;
  lastError?: string;
  /** Photos whose thumbnail could not be generated this session (corrupt/missing/unwritable). */
  failed: number;
  /** True while the worker is deliberately slowed because process RSS reached the RAM limit. */
  ramThrottled: boolean;
}

// How many queued photos are checked for "already cached?" at once. The check is two cheap
// stats (IO only, no decode/CPU), so it runs far wider than `limits.concurrency` (1 in
// Background mode) — a 100k re-walk of an already-cached library would otherwise be serial IO.
const CACHE_PROBE_WINDOW = 32;

// Mirrors thumbnailCacheService's private getGlobalCacheDir()/cache-file layout. If they ever
// drift the probe just reports "not cached" and the normal path still does the right thing
// (a test guards the two staying in sync).
function getThumbnailCacheDir(): string {
  try {
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') {
      return path.join(app.getPath('userData'), 'cache', 'thumbnails');
    }
  } catch {}
  const appData =
    process.env.APPDATA ||
    (process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library/Application Support')
      : path.join(os.homedir(), '.config'));
  return path.join(appData, 'gPhotos', 'cache', 'thumbnails');
}

/** True if a non-empty cached thumbnail already exists for `sourcePath` at `size` (never generates). */
export async function isThumbnailCached(sourcePath: string, size: number = 250): Promise<boolean> {
  try {
    const src = await fs.promises.stat(sourcePath);
    const cached = path.join(getThumbnailCacheDir(), `${size}`, `${getCacheKey(sourcePath, src.mtimeMs, size)}.jpg`);
    return (await fs.promises.stat(cached)).size > 0;
  } catch {
    return false;
  }
}

const FAILED_RETRY_AFTER_MS = 10 * 60 * 1000;
const FAILED_MAX_ATTEMPTS = 3;

class ThumbnailWorkerService {
  private queue: Photo[] = [];
  private queuedPaths = new Set<string>();
  // Photos confirmed cached (fast-forwarded or freshly generated) THIS
  // session — unlike queuedPaths (which only tracks current queue
  // membership and is cleared as each item finishes), this persists for the
  // life of the process, so re-enqueuing the same library later (e.g. on
  // every idle-timer tick, or re-navigating to it) doesn't re-add and
  // re-count photos whose thumbnails are already known-good, which used to
  // make "Total" grow indefinitely across repeated enqueue calls even
  // though nothing new was actually happening.
  private confirmedCachedPaths = new Set<string>();
  // Photos whose thumbnail generation failed this session — not retried on
  // every re-enqueue (a corrupt file would fail identically each time) and
  // deliberately NOT in confirmedCachedPaths, since they are not cached.
  // path -> how often generation failed and when. A failure may be transient (share briefly offline,
  // file locked), so a path is retried after FAILED_RETRY_AFTER_MS, and only given up on after
  // FAILED_MAX_ATTEMPTS failures.
  private failedPaths = new Map<string, { attempts: number; lastAt: number }>();
  private failedCount = 0;
  private lastError?: string;
  private ramThrottled = false;
  private lastRamBackoffAt = 0;
  // Set once the disk cache is cleared: the persisted "library already 100%
  // pre-cached" status is then stale, so enqueuePhotos must not trust it.
  private cacheCleared = false;
  private isProcessing = false;
  private isPaused = false;
  // Separate from isPaused (the user's own manual Settings toggle) so the
  // two never stomp on each other — auto-pausing while the user is
  // interacting with the app must not clear a pause they set deliberately,
  // and the reverse: resuming after 15s of inactivity must not override an
  // explicit manual pause. The loop only runs while BOTH are false.
  private activityPaused = false;
  private totalQueuedCount = 0;
  private processedCount = 0;
  private currentFileName?: string;
  private currentLibraryPath?: string;
  private testCheckpointDir: string | null = null;

  private limits: WorkerLimits = {
    maxCpuPercent: 40,
    maxRamMb: 1024,
    enabled: true,
    concurrency: 1,
  };

  private lastCpuUsage = process.cpuUsage();
  private lastCpuCheckTime = Date.now();
  private currentCalculatedCpuPercent = 0;
  private statusListeners: Set<(status: WorkerStatus) => void> = new Set();

  constructor() {
    this.loadCheckpoint();
    // Start periodic resource monitoring (every 2 seconds)
    const metricsTimer = setInterval(() => {
      try {
        this.updateResourceMetrics();
      } catch (err) {
        console.warn('[ThumbnailWorker] Resource metrics update failed:', err);
      }
    }, 2000);
    metricsTimer.unref?.();

    // The disk cache was emptied — forget everything we believed was cached.
    onThumbnailCacheCleared(() => {
      this.confirmedCachedPaths.clear();
      this.failedPaths.clear();
      this.failedCount = 0;
      this.processedCount = 0;
      this.cacheCleared = true;
    });
  }

  private getCheckpointFilePath(): string {
    if (this.testCheckpointDir) {
      return path.join(this.testCheckpointDir, 'thumbnail_worker_checkpoint.json');
    }

    try {
      const electron = require('electron');
      if (electron.app && typeof electron.app.getPath === 'function' && electron.app.isReady()) {
        return path.join(electron.app.getPath('userData'), 'thumbnail_worker_checkpoint.json');
      }
    } catch {}
    const fallback = process.env.APPDATA
      ? path.join(process.env.APPDATA, 'gPhotos')
      : path.join(process.cwd(), '.temp');
    if (!fs.existsSync(fallback)) {
      try { fs.mkdirSync(fallback, { recursive: true }); } catch {}
    }
    return path.join(fallback, 'thumbnail_worker_checkpoint.json');
  }

  /**
   * Test-only: points this worker's checkpoint at an isolated directory (never
   * the real userData/APPDATA checkpoint) and resets in-memory queue/progress
   * state, so tests never read or write a real user's pre-cache progress.
   */
  public useIsolatedStateForTests(dir: string): void {
    this.testCheckpointDir = dir;
    this.queue = [];
    this.queuedPaths.clear();
    this.confirmedCachedPaths.clear();
    this.failedPaths.clear();
    this.failedCount = 0;
    this.lastError = undefined;
    this.ramThrottled = false;
    this.cacheCleared = false;
    this.isProcessing = false;
    this.isPaused = false;
    this.totalQueuedCount = 0;
    this.processedCount = 0;
    this.currentFileName = undefined;
    this.currentLibraryPath = undefined;
    this.loadCheckpoint();
  }

  public loadCheckpoint(targetLibraryPath?: string): void {
    try {
      // 1. Check per-library status first if available
      const libPath = targetLibraryPath || this.currentLibraryPath;
      if (libPath) {
        const libStatus = libraryStatusService.getLibraryStatus(libPath);
        if (libStatus && libStatus.totalPhotos > 0) {
          this.processedCount = libStatus.thumbnailCachedCount;
          this.totalQueuedCount = libStatus.totalPhotos;
          this.currentFileName = libStatus.thumbnailLastFile;
          console.log(`[ThumbnailWorker] Restored library status for ${libPath}: ${this.processedCount}/${this.totalQueuedCount} (${libStatus.thumbnailPercent}%) cached.`);
          return;
        }
      }

      // 2. Global worker checkpoint fallback
      const p = this.getCheckpointFilePath();
      if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p, 'utf-8');
        const data: ThumbnailWorkerCheckpoint = JSON.parse(raw);
        if (data && typeof data.processedCount === 'number') {
          this.processedCount = data.processedCount;
          this.totalQueuedCount = data.totalQueuedCount || data.processedCount;
          this.currentFileName = data.currentFileName;
          if (data.libraryPath) this.currentLibraryPath = data.libraryPath;
          console.log(`[ThumbnailWorker] Checkpoint restored: ${this.processedCount} of ${this.totalQueuedCount} photos pre-cached.`);
        }
      }
    } catch (err) {
      console.warn('[ThumbnailWorker] Failed to read checkpoint:', err);
    }
  }

  public saveCheckpoint(isFinished = false): void {
    try {
      const p = this.getCheckpointFilePath();
      const dir = path.dirname(p);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const checkpoint: ThumbnailWorkerCheckpoint = {
        processedCount: this.processedCount,
        totalQueuedCount: this.totalQueuedCount,
        currentFileName: this.currentFileName,
        lastSavedTime: Date.now(),
        isFinished,
        libraryPath: this.currentLibraryPath,
      };
      fs.writeFileSync(p, JSON.stringify(checkpoint, null, 2), 'utf-8');

      // Also persist to library status if libraryPath is known
      if (this.currentLibraryPath) {
        // Cross-validate total: If the library actually has fewer photos on record, don't artificially blow it up
        const existingStatus = libraryStatusService.getLibraryStatus(this.currentLibraryPath);
        const effectiveTotal = (existingStatus?.totalPhotos && existingStatus.totalPhotos > 0 && existingStatus.totalPhotos < this.totalQueuedCount)
          ? existingStatus.totalPhotos
          : this.totalQueuedCount;
        const effectiveCached = Math.min(this.processedCount, effectiveTotal);
        const pct = effectiveTotal > 0 ? Math.round((effectiveCached / effectiveTotal) * 100) : 0;

        libraryStatusService.saveLibraryStatus({
          libraryPath: this.currentLibraryPath,
          totalPhotos: effectiveTotal,
          thumbnailCachedCount: effectiveCached,
          thumbnailTotalCount: effectiveTotal,
          thumbnailLastFile: this.currentFileName,
          thumbnailCompleted: isFinished || (effectiveTotal > 0 && effectiveCached >= effectiveTotal),
          thumbnailPercent: pct,
          phase: isFinished ? 'completed' : (this.isPaused || this.activityPaused) ? 'paused' : 'thumbnails',
        });
      }
    } catch (err) {
      console.warn('[ThumbnailWorker] Failed to save checkpoint:', err);
    }
  }

  public flushCheckpoint(): void {
    this.saveCheckpoint(this.queue.length === 0);
  }

  /**
   * Updates CPU % and RAM metrics
   */
  private updateResourceMetrics(): void {
    const mem = process.memoryUsage();
    const rssMb = Math.round(mem.rss / (1024 * 1024));

    const now = Date.now();
    const elapsedMs = now - this.lastCpuCheckTime;
    if (elapsedMs >= 1000) {
      const diffCpu = process.cpuUsage(this.lastCpuUsage);
      const userMs = diffCpu.user / 1000;
      const sysMs = diffCpu.system / 1000;
      const numCores = os.cpus().length || 1;
      // Normalized CPU percentage across available cores
      const totalCpuMs = userMs + sysMs;
      this.currentCalculatedCpuPercent = Math.min(100, Math.round((totalCpuMs / (elapsedMs * numCores)) * 100));

      this.lastCpuUsage = process.cpuUsage();
      this.lastCpuCheckTime = now;
    }

    // Safety RAM check: if exceeding 85% of limit, clear Sharp cache
    if (rssMb > this.limits.maxRamMb * 0.85) {
      if (sharp && typeof sharp.cache === 'function') {
        sharp.cache(false);
        sharp.cache({ memory: 32, files: 0, items: 100 });
      }
      if (typeof (global as any).gc === 'function') {
        try {
          (global as any).gc();
        } catch {}
      }
    }

    this.notifyStatus();
  }

  public getStatus(): WorkerStatus {
    const mem = process.memoryUsage();
    return {
      isRunning: this.isProcessing,
      paused: this.isPaused || this.activityPaused,
      current: this.processedCount,
      total: this.totalQueuedCount,
      cpuPercent: this.currentCalculatedCpuPercent,
      ramMb: Math.round(mem.rss / (1024 * 1024)),
      currentFile: this.isProcessing ? (this.currentFileName || 'Processing...') : undefined,
      lastError: this.lastError,
      failed: this.failedCount,
      ramThrottled: this.ramThrottled,
    };
  }

  public subscribeStatus(listener: (status: WorkerStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  private notifyStatus(): void {
    const status = this.getStatus();
    for (const listener of this.statusListeners) {
      try {
        listener(status);
      } catch {}
    }
  }

  public setResourceLimits(limits: Partial<WorkerLimits>): void {
    if (typeof limits.maxCpuPercent === 'number') {
      // 100 is a legitimate ceiling for Turbo Mode (exclusive PC use) — the
      // 8ms sleep floor in processQueue's duty cycle still prevents a true
      // busy-loop even at 100.
      this.limits.maxCpuPercent = Math.max(10, Math.min(100, limits.maxCpuPercent));
    }
    if (typeof limits.maxRamMb === 'number') {
      this.limits.maxRamMb = Math.max(256, Math.min(8192, limits.maxRamMb));
    }
    if (typeof limits.enabled === 'boolean') {
      this.limits.enabled = limits.enabled;
    }
    if (typeof limits.concurrency === 'number') {
      this.limits.concurrency = Math.max(1, Math.min(os.cpus().length || 1, Math.floor(limits.concurrency) || 1));
    }
    console.log(`[ThumbnailWorker] Limits updated: Max CPU=${this.limits.maxCpuPercent}%, Max RAM=${this.limits.maxRamMb}MB, Enabled=${this.limits.enabled}, Concurrency=${this.limits.concurrency}`);
    this.notifyStatus();

    if (this.limits.enabled && !this.isProcessing && this.queue.length > 0) {
      this.processQueue();
    }
  }

  /**
   * Enqueues photos for background thumbnail pre-caching with library tracking.
   */
  /** True while a path that failed recently (or too many times) should not be queued again. */
  private isGivenUpOn(key: string): boolean {
    const f = this.failedPaths.get(key);
    if (!f) return false;
    return f.attempts >= FAILED_MAX_ATTEMPTS || Date.now() - f.lastAt < FAILED_RETRY_AFTER_MS;
  }

  public enqueuePhotos(photos: Photo[], libraryPath?: string): void {
    if (!photos || photos.length === 0) return;

    if (libraryPath) {
      this.currentLibraryPath = libraryPath;
    } else if (photos.length > 0 && photos[0]?.storageName && photos.every(p => p.storageName === photos[0].storageName)) {
      // storageName is always a bare folder name (e.g. "OndrivePhotos"), never
      // a full path — libraryStatusService's normalizeKey() does
      // path.resolve() on whatever it's given, so a bare name silently
      // resolved against process.cwd(), which differs between the installed
      // app, and every different way of launching in dev. That fragmented a
      // single real virtual storage's tracked status across several
      // permanently-disconnected records (one per cwd ever used), each stuck
      // at whatever it last saw — which is exactly what made "Resume
      // Pre-Caching" keep reporting stale/wrong totals no matter how many
      // times it re-ran. Every virtual storage lives under the one shared,
      // stable mirror root, so join with that instead of resolving the bare
      // name on its own.
      this.currentLibraryPath = path.join(getDefaultMirrorRoot(), photos[0].storageName);
    } else {
      this.currentLibraryPath = undefined;
    }

    // Check existing library status to preserve accurate previous progress
    if (this.currentLibraryPath) {
      const existingStatus = libraryStatusService.getLibraryStatus(this.currentLibraryPath);
      if (existingStatus) {
        if (!this.cacheCleared && existingStatus.thumbnailCompleted && existingStatus.totalPhotos === photos.length) {
          // Accumulate, don't overwrite — service:start-precache's "resume
          // all storages" path calls enqueuePhotos once per storage in a
          // loop, and processedCount/totalQueuedCount are running totals
          // across that whole loop (see the matching Math.max accumulation
          // just below for the normal add-to-queue path). Overwriting here
          // clobbered whatever total earlier, still-pending storages in the
          // same loop had already contributed — e.g. a small already-cached
          // storage processed after a huge pending one reset "18368 total"
          // down to just its own tiny count, making the status badge falsely
          // read "100% done" while thousands of photos were still queued.
          //
          // But only credit it ONCE ever, not once per call: this branch is
          // a shortcut that skips the normal per-photo queuedPaths/
          // confirmedCachedPaths bookkeeping below, which is what makes the
          // normal path naturally idempotent against redundant re-scans of
          // the same library (already-confirmed photos just don't get
          // re-added). Without an equivalent guard here, every redundant
          // rescan of an already-cached library — e.g. several overlapping
          // "Resume Pre-Caching" clicks re-walking every storage — re-added
          // that library's full count again and again, inflating the totals
          // without bound.
          const alreadyCounted = photos.every((p) => p?.filePath && this.confirmedCachedPaths.has(p.filePath.toLowerCase()));
          if (!alreadyCounted) {
            this.processedCount += photos.length;
            this.totalQueuedCount = Math.max(this.totalQueuedCount, this.processedCount + this.queue.length);
            for (const photo of photos) {
              if (photo?.filePath) this.confirmedCachedPaths.add(photo.filePath.toLowerCase());
            }
          }
          console.log(`[ThumbnailWorker] Library ${this.currentLibraryPath} is already 100% pre-cached (${photos.length} photos). Skipping redundant queueing.`);
          this.notifyStatus();
          return;
        }
        if (!this.cacheCleared && existingStatus.thumbnailCachedCount > 0) {
          this.processedCount = Math.max(this.processedCount, existingStatus.thumbnailCachedCount);
        }
      }
    }

    let addedCount = 0;
    for (const photo of photos) {
      if (!photo || !photo.filePath) continue;
      const key = photo.filePath.toLowerCase();
      if (this.confirmedCachedPaths.has(key) || this.isGivenUpOn(key)) continue;
      if (!this.queuedPaths.has(key)) {
        this.queuedPaths.add(key);
        this.queue.push(photo);
        addedCount++;
      }
    }

    if (addedCount > 0) {
      this.totalQueuedCount = Math.max(this.totalQueuedCount, photos.length, this.processedCount + this.queue.length);
      console.log(`[ThumbnailWorker] Enqueued ${addedCount} photos for background pre-caching (Total queue: ${this.queue.length}, Processed: ${this.processedCount}, Total: ${this.totalQueuedCount}).`);
      this.saveCheckpoint(false);
      this.notifyStatus();

      if (this.limits.enabled && !this.isProcessing && !this.isPaused && !this.activityPaused) {
        this.processQueue();
      }
    }
  }

  public pause(): void {
    this.isPaused = true;
    console.log('[ThumbnailWorker] Background pre-caching paused.');
    this.saveCheckpoint(false);
    this.notifyStatus();
  }

  public resume(): void {
    this.isPaused = false;
    console.log('[ThumbnailWorker] Background pre-caching resumed.');
    this.notifyStatus();
    if (this.limits.enabled && !this.isProcessing && !this.activityPaused && this.queue.length > 0) {
      this.processQueue();
    }
  }

  /** Auto-pause while the user is actively using the app — see activityPaused's doc comment. */
  public pauseForActivity(): void {
    if (this.activityPaused) return;
    this.activityPaused = true;
  }

  /** Auto-resume after the user has been idle for a while — see activityPaused's doc comment. */
  public resumeFromActivity(): void {
    if (!this.activityPaused) return;
    this.activityPaused = false;
    if (this.limits.enabled && !this.isProcessing && !this.isPaused && this.queue.length > 0) {
      this.processQueue();
    }
  }

  /**
   * Core processing loop with:
   * 1. Fast-forward (0ms delay) on already-cached photos!
   * 2. Duty-cycle CPU regulation on new thumbnail generations.
   * 3. RAM backoff protection.
   *
   * Photos are pulled off the queue in batches of `limits.concurrency` and
   * generated in parallel (Promise.all) — with the default concurrency of 1
   * this degenerates to exactly the old one-at-a-time behavior; Turbo Mode
   * raises it so sharp/libvips actually uses multiple cores at once instead
   * of one thumbnail at a time.
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    let fastForwardCount = 0;
    // Photos probed as NOT cached, waiting for their turn at `concurrency`. They stay in
    // queuedPaths (so a concurrent enqueuePhotos can't duplicate them) and are put back at the
    // head of the queue if the loop exits early (pause, disable).
    const carry: Photo[] = [];

    const recordCached = (photo: Photo) => {
      fastForwardCount++;
      this.confirmedCachedPaths.add(photo.filePath.toLowerCase());
      this.processedCount = Math.min(this.totalQueuedCount, this.processedCount + 1);
      // Periodically save and notify every 50 fast-forwarded photos to avoid UI overhead
      if (fastForwardCount % 50 === 0 || (this.queue.length === 0 && carry.length === 0)) {
        this.saveCheckpoint(false);
        this.notifyStatus();
      }
    };

    try {
      while ((this.queue.length > 0 || carry.length > 0) && !this.isPaused && !this.activityPaused && this.limits.enabled) {
        // Wide, IO-only "already cached?" pass over the next window of the queue; cached photos are
        // fast-forwarded right here, the rest are carried on to the normal `concurrency`-wide path.
        if (carry.length < this.limits.concurrency && this.queue.length > 0) {
          const window = this.queue.splice(0, CACHE_PROBE_WINDOW);
          const cachedFlags = await Promise.all(window.map((p) => isThumbnailCached(p.filePath, 250)));
          window.forEach((photo, i) => {
            if (cachedFlags[i]) {
              this.queuedPaths.delete(photo.filePath.toLowerCase());
              recordCached(photo);
            } else {
              carry.push(photo);
            }
          });
          if (carry.length === 0) continue;
          if (this.isPaused || this.activityPaused || !this.limits.enabled) continue;
        }

        const batch = carry.splice(0, Math.max(1, Math.min(this.limits.concurrency, carry.length)));
        for (const p of batch) this.queuedPaths.delete(p.filePath.toLowerCase());

        const t0 = Date.now();
        const outcomes = await Promise.all(
          batch.map(async (photo) => {
            try {
              const res = await getOrGenerateCachedThumbnail(photo.filePath, 250);
              // null = generation failed (missing/corrupt/unwritable) — distinct
              // from a freshly generated thumbnail.
              return { photo, isCached: !!res?.isFromCache, failed: !res, error: undefined as unknown };
            } catch (error) {
              return { photo, isCached: false, failed: true, error };
            }
          })
        );

        let didRealWork = false;
        for (const { photo, isCached, failed, error } of outcomes) {
          if (failed) {
            didRealWork = true;
            const key = photo.filePath.toLowerCase();
            const prior = this.failedPaths.get(key);
            this.failedPaths.set(key, { attempts: (prior?.attempts ?? 0) + 1, lastAt: Date.now() });
            this.failedCount++;
            this.lastError = `Thumbnail failed: ${photo.fileName || path.basename(photo.filePath)}${error ? ` (${String((error as any)?.message ?? error)})` : ''}`;
            if (this.failedCount <= 5 || this.failedCount % 100 === 0) {
              console.warn(`[ThumbnailWorker] ${this.lastError} (${this.failedCount} failed so far)`);
            }
            continue;
          }
          if (isCached) {
            recordCached(photo);
            continue;
          }

          didRealWork = true;
          this.currentFileName = photo.fileName || path.basename(photo.filePath);
          this.confirmedCachedPaths.add(photo.filePath.toLowerCase());
          this.processedCount = Math.min(this.totalQueuedCount, this.processedCount + 1);

          if (this.processedCount % 5 === 0) {
            this.saveCheckpoint(false);
            this.notifyStatus();
          }
        }

        // All fast-forwarded (already cached) — skip straight to the next batch, no sleep.
        if (!didRealWork) continue;

        const tWork = Math.max(1, Date.now() - t0);

        // 2. RAM Safety Check: if current RAM exceeds limit, back off briefly.
        // Rate-limited (at most one 3s back-off per 30s) so a main process that
        // simply sits above the limit (RSS includes everything in the process,
        // not just this worker) can't throttle pre-caching to a crawl forever;
        // the state is exposed via status (ramThrottled / lastError) instead.
        const currentRssMb = Math.round(process.memoryUsage().rss / (1024 * 1024));
        if (currentRssMb >= this.limits.maxRamMb) {
          if (!this.ramThrottled) {
            this.lastError = `Memory use ${currentRssMb}MB reached the ${this.limits.maxRamMb}MB limit — pre-caching is being slowed`;
          }
          this.ramThrottled = true;
          if (Date.now() - this.lastRamBackoffAt >= 30_000) {
            this.lastRamBackoffAt = Date.now();
            console.warn(`[ThumbnailWorker] RAM reached ${currentRssMb}MB (limit: ${this.limits.maxRamMb}MB). Backing off for 3 seconds...`);
            if (sharp?.cache) {
              sharp.cache(false);
              sharp.cache({ memory: 32, files: 0, items: 100 }); // shrink, don't leave the cache disabled
            }
            await new Promise((r) => setTimeout(r, 3000));
          }
        } else if (this.ramThrottled) {
          this.ramThrottled = false;
          if (this.lastError?.startsWith('Memory use')) this.lastError = undefined;
        }

        // 3. CPU Duty Cycle Throttling on actual work (Cap CPU <= maxCpuPercent)
        const cpuCap = Math.max(10, Math.min(100, this.limits.maxCpuPercent));
        let sleepMs = Math.round(tWork * ((100 - cpuCap) / cpuCap));
        sleepMs = Math.max(8, sleepMs);

        if (this.currentCalculatedCpuPercent > cpuCap) {
          sleepMs += Math.round((this.currentCalculatedCpuPercent - cpuCap) * 5);
        }

        await new Promise((r) => setTimeout(r, sleepMs));
      }
    } finally {
      if (carry.length > 0) this.queue.unshift(...carry);
      this.isProcessing = false;
      this.currentFileName = undefined;
      const isDone = this.queue.length === 0;
      this.saveCheckpoint(isDone);
      this.notifyStatus();
      if (isDone) {
        console.log(`[ThumbnailWorker] All ${this.processedCount} queued photos have been pre-cached to disk!`);
      }
    }
  }
}

export const thumbnailWorker = new ThumbnailWorkerService();
export default thumbnailWorker;
