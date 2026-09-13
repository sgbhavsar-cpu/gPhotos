import { Photo, DetectedFace } from '../../types';
import { libraryStore } from './libraryStore';
import { detectFacesInImage, loadFaceModels } from './faceEngine';
import { clusterFaces } from './clustering';

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

  private newFacesBatch: DetectedFace[] = [];

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
      await loadFaceModels();

      // Check if original high-res photo should be preferred
      const preferOriginal = !!(
        photo.originalRemotePath &&
        (!photo.isVirtual || (typeof window !== 'undefined' && window.electronAPI))
      );

      const detectedFaces = await detectFacesInImage(
        photo.filePath,
        photo.id,
        photo.originalRemotePath,
        preferOriginal
      );

      // Attach detected faces and flag completion
      photo.faces = detectedFaces;
      photo.faceScanCompleted = true;

      // Update libraryStore photo state quietly (in memory)
      libraryStore.updatePhotoQuietly(photo);

      if (detectedFaces.length > 0) {
        this.newFacesBatch.push(...detectedFaces);
      }

      this.completedInSession++;

      // Batch clustering: re-cluster only every 8 photos, or when queue empties, or when 10+ new faces are found
      const shouldCluster =
        this.newFacesBatch.length >= 10 ||
        this.completedInSession % 8 === 0 ||
        this.queue.length === 0;

      if (shouldCluster) {
        const state = libraryStore.getState();
        const allFaces: DetectedFace[] = [];
        for (const p of state.photos) {
          if (p.faces) {
            allFaces.push(...p.faces);
          }
        }
        const { people, updatedFaces } = clusterFaces(allFaces, state.people, 0.55, true);
        state.people = people;
        state.faces = updatedFaces;

        // Sync photo.faces with newly assigned personIds
        const photoFaceMap = new Map<string, DetectedFace[]>();
        for (const f of updatedFaces) {
          if (!photoFaceMap.has(f.photoId)) photoFaceMap.set(f.photoId, []);
          photoFaceMap.get(f.photoId)!.push(f);
        }
        for (const p of state.photos) {
          if (photoFaceMap.has(p.id)) {
            p.faces = photoFaceMap.get(p.id)!;
          }
        }

        this.newFacesBatch = [];
        libraryStore.notify(true);
      } else {
        // Lightweight UI repaint without full cluster and without disk write
        libraryStore.notifyListeners();
      }
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
        // Flush any remaining cluster and reset session counts when queue is empty
        if (this.newFacesBatch.length > 0) {
          const state = libraryStore.getState();
          const allFaces: DetectedFace[] = [];
          for (const p of state.photos) {
            if (p.faces) allFaces.push(...p.faces);
          }
          const { people, updatedFaces } = clusterFaces(allFaces, state.people, 0.55, true);
          state.people = people;
          state.faces = updatedFaces;

          const photoFaceMap = new Map<string, DetectedFace[]>();
          for (const f of updatedFaces) {
            if (!photoFaceMap.has(f.photoId)) photoFaceMap.set(f.photoId, []);
            photoFaceMap.get(f.photoId)!.push(f);
          }
          for (const p of state.photos) {
            if (photoFaceMap.has(p.id)) {
              p.faces = photoFaceMap.get(p.id)!;
            }
          }

          this.newFacesBatch = [];
          libraryStore.notify(true);
        }
        this.totalInSession = 0;
        this.completedInSession = 0;
        this.notify();
      }
    }
  }
}

export const faceQueue = new FaceQueueService();
