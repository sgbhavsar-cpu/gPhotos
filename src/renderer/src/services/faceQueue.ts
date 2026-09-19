import { Photo } from '../../types';
import { libraryStore } from './libraryStore';

// Detection, clustering and persistence all happen in the main process now
// (see src/main/services/faceDetectionEngine.ts + pipelineOrchestrator.ts) —
// this queue just keeps its own pause/resume/priority scheduling (used by
// App.tsx's idle-detection auto-start, which needs to pause instantly the
// moment the user interacts again) and adopts each result as authoritative.

export interface QueueStatus {
  isRunning: boolean;
  isPaused: boolean;
  total: number;
  completed: number;
  currentFileName?: string;
}

export type QueueStatusListener = (status: QueueStatus) => void;

class FaceQueueService {
  private queue: Array<{ photo: Photo; priority: 'high' | 'normal' | 'low' }> = [];
  private processingPhotoId: string | null = null;
  private isRunning = false;
  private isPaused = false;
  private totalInSession = 0;
  private completedInSession = 0;
  private listeners: Set<QueueStatusListener> = new Set();
  private queuedPhotoIds: Set<string> = new Set();

  public subscribe(listener: QueueStatusListener): () => void {
    this.listeners.add(listener);
    listener(this.getStatus());
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify() {
    const status = this.getStatus();
    this.listeners.forEach((l) => l(status));
  }

  public getStatus(): QueueStatus {
    const current = this.queue[0]?.photo;
    return {
      isRunning: this.isRunning,
      isPaused: this.isPaused,
      total: this.totalInSession,
      completed: this.completedInSession,
      currentFileName: current ? current.fileName : undefined,
    };
  }

  public getQueueLength(): number {
    return this.queue.length;
  }

  public enqueue(photos: Photo[], priority: 'high' | 'normal' | 'low' = 'normal') {
    let added = 0;
    for (const photo of photos) {
      if (this.queuedPhotoIds.has(photo.id)) {
        if (priority === 'high') {
          // Promote existing item to head of queue
          const idx = this.queue.findIndex((item) => item.photo.id === photo.id);
          if (idx > 0) {
            const [item] = this.queue.splice(idx, 1);
            item.priority = 'high';
            this.queue.unshift(item);
          }
        }
        continue;
      }

      this.queuedPhotoIds.add(photo.id);
      if (priority === 'high') {
        this.queue.unshift({ photo, priority });
      } else {
        this.queue.push({ photo, priority });
      }
      added++;
    }

    if (added > 0) {
      this.totalInSession += added;
      this.notify();
      this.processNext();
    }
  }

  public prioritize(photoId: string) {
    const idx = this.queue.findIndex((item) => item.photo.id === photoId);
    if (idx > 0) {
      const [item] = this.queue.splice(idx, 1);
      item.priority = 'high';
      this.queue.unshift(item);
      this.notify();
    }
  }

  public pause() {
    this.isPaused = true;
    this.notify();
  }

  public resume() {
    if (this.isPaused) {
      this.isPaused = false;
      this.notify();
      this.processNext();
    }
  }

  public clear() {
    this.queue = [];
    this.queuedPhotoIds.clear();
    this.totalInSession = 0;
    this.completedInSession = 0;
    this.isRunning = false;
    this.notify();
  }

  private async processNext() {
    if (this.isRunning || this.isPaused || this.queue.length === 0) {
      return;
    }

    this.isRunning = true;
    this.notify();

    const item = this.queue.shift();
    if (!item) {
      this.isRunning = false;
      this.notify();
      return;
    }

    const { photo } = item;
    this.processingPhotoId = photo.id;

    try {
      if (window.electronAPI?.detectFacesBatch) {
        const { results, people } = await window.electronAPI.detectFacesBatch([photo]);
        const [result] = results;
        if (result) {
          libraryStore.applyServerDetectedFaces(
            [{ photoId: result.photoId, faces: result.faces, faceScanCompleted: true, facesLocked: result.locked }],
            people
          );
        }
      }
      this.completedInSession++;
    } catch (err) {
      console.warn(`Error processing face queue for ${photo.fileName}:`, err);
    } finally {
      this.queuedPhotoIds.delete(photo.id);
      this.processingPhotoId = null;
      this.isRunning = false;
      this.notify();

      if (this.queue.length > 0) {
        // Yield 35ms to event loop so browser / UI never lags at 60fps
        setTimeout(() => this.processNext(), 35);
      } else {
        this.totalInSession = 0;
        this.completedInSession = 0;
        this.notify();
      }
    }
  }
}

export const faceQueue = new FaceQueueService();
