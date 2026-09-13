import fs from 'fs';
import path from 'path';
import os from 'os';
import { Photo } from '../../types';
import { getOrGenerateCachedThumbnail } from './thumbnailCacheService';
import { generateSpriteSheet } from './spriteService';

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
  lastError?: string;
}

class ThumbnailWorkerService {
  private queue: Photo[] = [];
  private queuedPaths = new Set<string>();
  private isProcessing = false;
  private isPaused = false;
  private totalQueuedCount = 0;
  private processedCount = 0;

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
    // Start periodic resource monitoring (every 2 seconds)
    setInterval(() => {
      this.updateResourceMetrics();
    }, 2000);
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
   * Enqueues photos for background thumbnail pre-caching.
   */
  public enqueuePhotos(photos: Photo[]): void {
    if (!photos || photos.length === 0) return;

    let addedCount = 0;
    for (const photo of photos) {
      if (!photo || !photo.filePath) continue;
      const key = photo.filePath.toLowerCase();
      if (!this.queuedPaths.has(key)) {
        this.queuedPaths.add(key);
        this.queue.push(photo);
        addedCount++;
      }
    }

    if (addedCount > 0) {
      this.totalQueuedCount = this.processedCount + this.queue.length;
      console.log(`[ThumbnailWorker] Enqueued ${addedCount} photos for background pre-caching (Total queue: ${this.queue.length}).`);
      this.notifyStatus();

      if (this.limits.enabled && !this.isProcessing && !this.isPaused) {
        this.processQueue();
      }
    }
  }

  public pause(): void {
    this.isPaused = true;
    console.log('[ThumbnailWorker] Background pre-caching paused.');
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
   * Core processing loop with duty-cycle CPU regulation and RAM backoff
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      while (this.queue.length > 0 && !this.isPaused && this.limits.enabled) {
        const photo = this.queue.shift()!;
        this.queuedPaths.delete(photo.filePath.toLowerCase());

        // 1. RAM Safety Check: if current RAM exceeds limit, pause and back off
        const currentRssMb = Math.round(process.memoryUsage().rss / (1024 * 1024));
        if (currentRssMb >= this.limits.maxRamMb) {
          console.warn(`[ThumbnailWorker] RAM reached ${currentRssMb}MB (limit: ${this.limits.maxRamMb}MB). Backing off for 3 seconds...`);
          if (sharp?.cache) sharp.cache(false);
          await new Promise((r) => setTimeout(r, 3000));
          // Put photo back at front of queue to retry
          this.queue.unshift(photo);
          this.queuedPaths.add(photo.filePath.toLowerCase());
          continue;
        }

        // 2. Measure execution time of thumbnail generation
        const t0 = Date.now();
        try {
          // Pre-cache 250px grid thumbnail
          await getOrGenerateCachedThumbnail(photo.filePath, 250);
        } catch (thumbErr) {
          // Ignore individual photo errors and continue
        }
        const tWork = Math.max(1, Date.now() - t0);

        this.processedCount++;
        if (this.processedCount % 10 === 0) {
          this.notifyStatus();
        }

        // 3. CPU Duty Cycle Throttling (Cap CPU <= maxCpuPercent)
        // Formula: sleepTime = tWork * ((100 - maxCpuPercent) / maxCpuPercent)
        // Example: at 40% CPU, sleepTime = tWork * (60 / 40) = tWork * 1.5
        const cpuCap = Math.max(10, Math.min(90, this.limits.maxCpuPercent));
        let sleepMs = Math.round(tWork * ((100 - cpuCap) / cpuCap));

        // Ensure minimum 8ms rest to allow the Node.js event loop to process UI and IPC events
        sleepMs = Math.max(8, sleepMs);

        // Adaptive regulation: if overall process CPU is running hot, increase sleep
        if (this.currentCalculatedCpuPercent > cpuCap) {
          sleepMs += Math.round((this.currentCalculatedCpuPercent - cpuCap) * 5);
        }

        await new Promise((r) => setTimeout(r, sleepMs));
      }
    } finally {
      this.isProcessing = false;
      this.notifyStatus();
      if (this.queue.length === 0) {
        console.log(`[ThumbnailWorker] All ${this.processedCount} queued photos have been pre-cached to disk!`);
      }
    }
  }
}

export const thumbnailWorker = new ThumbnailWorkerService();
export default thumbnailWorker;
