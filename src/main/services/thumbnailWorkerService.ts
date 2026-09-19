import fs from 'fs';
import path from 'path';
import os from 'os';
import { Photo, ThumbnailWorkerCheckpoint } from '../../types';
import { getOrGenerateCachedThumbnail } from './thumbnailCacheService';
import { generateSpriteSheet } from './spriteService';
import { libraryStatusService } from './libraryStatusService';

let sharp: any = null;
try {
  sharp = require('sharp');
  // Configure Sharp memory cache strictly to avoid memory bloat
  if (sharp.cache) {
    sharp.cache({ memory: 64, files: 30, items: 200 });
  }
} catch {}

interface WorkerLimits {
  maxCpuPercent: number; // e.g. 40
  maxRamMb: number; // e.g. 1024
  enabled: boolean;
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
}

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
  private isProcessing = false;
  private isPaused = false;
  private totalQueuedCount = 0;
  private processedCount = 0;
  private currentFileName?: string;
  private currentLibraryPath?: string;
  private testCheckpointDir: string | null = null;

  private limits: WorkerLimits = {
    maxCpuPercent: 40,
    maxRamMb: 1024,
    enabled: true,
  };

  private lastCpuUsage = process.cpuUsage();
  private lastCpuCheckTime = Date.now();
  private currentCalculatedCpuPercent = 0;
  private statusListeners: Set<(status: WorkerStatus) => void> = new Set();

  constructor() {
    this.loadCheckpoint();
    // Start periodic resource monitoring (every 2 seconds)
    setInterval(() => {
      this.updateResourceMetrics();
    }, 2000);
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
          phase: isFinished ? 'completed' : this.isPaused ? 'paused' : 'thumbnails',
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
        sharp.cache({ memory: 32, files: 10, items: 100 });
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
      paused: this.isPaused,
      current: this.processedCount,
      total: this.totalQueuedCount,
      cpuPercent: this.currentCalculatedCpuPercent,
      ramMb: Math.round(mem.rss / (1024 * 1024)),
      currentFile: this.isProcessing ? (this.currentFileName || 'Processing...') : undefined,
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
      this.limits.maxCpuPercent = Math.max(10, Math.min(90, limits.maxCpuPercent));
    }
    if (typeof limits.maxRamMb === 'number') {
      this.limits.maxRamMb = Math.max(256, Math.min(4096, limits.maxRamMb));
    }
    if (typeof limits.enabled === 'boolean') {
      this.limits.enabled = limits.enabled;
    }
    console.log(`[ThumbnailWorker] Limits updated: Max CPU=${this.limits.maxCpuPercent}%, Max RAM=${this.limits.maxRamMb}MB, Enabled=${this.limits.enabled}`);
    this.notifyStatus();

    if (this.limits.enabled && !this.isProcessing && this.queue.length > 0) {
      this.processQueue();
    }
  }

  /**
   * Enqueues photos for background thumbnail pre-caching with library tracking.
   */
  public enqueuePhotos(photos: Photo[], libraryPath?: string): void {
    if (!photos || photos.length === 0) return;

    if (libraryPath) {
      this.currentLibraryPath = libraryPath;
    } else if (photos.length > 0 && photos[0]?.storageName && photos.every(p => p.storageName === photos[0].storageName)) {
      this.currentLibraryPath = photos[0].storageName;
    } else {
      this.currentLibraryPath = undefined;
    }

    // Check existing library status to preserve accurate previous progress
    if (this.currentLibraryPath) {
      const existingStatus = libraryStatusService.getLibraryStatus(this.currentLibraryPath);
      if (existingStatus) {
        if (existingStatus.thumbnailCompleted && existingStatus.totalPhotos === photos.length) {
          this.processedCount = photos.length;
          this.totalQueuedCount = photos.length;
          for (const photo of photos) {
            if (photo?.filePath) this.confirmedCachedPaths.add(photo.filePath.toLowerCase());
          }
          console.log(`[ThumbnailWorker] Library ${this.currentLibraryPath} is already 100% pre-cached (${photos.length} photos). Skipping redundant queueing.`);
          this.notifyStatus();
          return;
        }
        if (existingStatus.thumbnailCachedCount > 0) {
          this.processedCount = Math.max(this.processedCount, existingStatus.thumbnailCachedCount);
        }
      }
    }

    let addedCount = 0;
    for (const photo of photos) {
      if (!photo || !photo.filePath) continue;
      const key = photo.filePath.toLowerCase();
      if (this.confirmedCachedPaths.has(key)) continue;
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

      if (this.limits.enabled && !this.isProcessing && !this.isPaused) {
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
    if (this.limits.enabled && !this.isProcessing && this.queue.length > 0) {
      this.processQueue();
    }
  }

  /**
   * Core processing loop with:
   * 1. Fast-forward (0ms delay) on already-cached photos!
   * 2. Duty-cycle CPU regulation on new thumbnail generations.
   * 3. RAM backoff protection.
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    let fastForwardCount = 0;

    try {
      while (this.queue.length > 0 && !this.isPaused && this.limits.enabled) {
        const photo = this.queue.shift()!;
        this.queuedPaths.delete(photo.filePath.toLowerCase());

        // 1. Fast-path cache check: If already cached on disk, FAST FORWARD WITHOUT SLEEP!
        const t0 = Date.now();
        let isCached = false;
        try {
          const res = await getOrGenerateCachedThumbnail(photo.filePath, 250);
          if (res?.isFromCache) {
            isCached = true;
          }
        } catch {}

        if (isCached) {
          fastForwardCount++;
          this.confirmedCachedPaths.add(photo.filePath.toLowerCase());
          this.processedCount = Math.min(this.totalQueuedCount, this.processedCount + 1);

          // Periodically save and notify every 50 fast-forwarded photos to avoid UI overhead
          if (fastForwardCount % 50 === 0 || this.queue.length === 0) {
            this.saveCheckpoint(false);
            this.notifyStatus();
          }
          // Do NOT sleep! Continue immediately to next photo to skip already-cached files in milliseconds!
          continue;
        }

        // New photo generation required:
        this.currentFileName = photo.fileName || path.basename(photo.filePath);
        this.confirmedCachedPaths.add(photo.filePath.toLowerCase());
        this.processedCount = Math.min(this.totalQueuedCount, this.processedCount + 1);
        const tWork = Math.max(1, Date.now() - t0);

        if (this.processedCount % 5 === 0) {
          this.saveCheckpoint(false);
          this.notifyStatus();
        }

        // 2. RAM Safety Check: if current RAM exceeds limit, pause and back off
        const currentRssMb = Math.round(process.memoryUsage().rss / (1024 * 1024));
        if (currentRssMb >= this.limits.maxRamMb) {
          console.warn(`[ThumbnailWorker] RAM reached ${currentRssMb}MB (limit: ${this.limits.maxRamMb}MB). Backing off for 3 seconds...`);
          if (sharp?.cache) sharp.cache(false);
          await new Promise((r) => setTimeout(r, 3000));
        }

        // 3. CPU Duty Cycle Throttling on actual work (Cap CPU <= maxCpuPercent)
        const cpuCap = Math.max(10, Math.min(90, this.limits.maxCpuPercent));
        let sleepMs = Math.round(tWork * ((100 - cpuCap) / cpuCap));
        sleepMs = Math.max(8, sleepMs);

        if (this.currentCalculatedCpuPercent > cpuCap) {
          sleepMs += Math.round((this.currentCalculatedCpuPercent - cpuCap) * 5);
        }

        await new Promise((r) => setTimeout(r, sleepMs));
      }
    } finally {
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
