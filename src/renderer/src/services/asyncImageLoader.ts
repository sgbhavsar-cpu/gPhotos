/**
 * Asynchronous Non-Blocking Image Loader & Batch Thumbnail Service
 * 
 * Solves browser connection saturation by:
 * 1. BATCH FETCHING: Loads up to 100 thumbnails together in 1 single async request.
 * 2. Pre-populates memory cache so 100 cards render simultaneously in 0ms.
 * 3. Throttles individual fallback fetches (max 3 concurrent) leaving connection slots free.
 * 4. Provides instant AbortController cancellation and 6-second timeout.
 */

import { useState, useEffect, useRef } from 'react';
import { SpriteCoordinate } from '../../types';
import { trackBackendCall } from './responseTracker';

// ============================================================================
// 0. SPRITE COORDINATE STORE & HOOK (HIGH-SPEED 50-PHOTO STATIC SHEETS)
// ============================================================================

const spriteCoordCache = new Map<string, SpriteCoordinate | null>();
const pendingCoordRequests = new Map<string, Promise<SpriteCoordinate | null>>();

/**
 * Returns the optimized URL to access the sprite sheet.
 * In Electron uses gphoto://sprite?id=... and in web browser uses /api/sprites/...
 */
export function getSpriteUrl(coord: SpriteCoordinate): string {
  const isElectron =
    typeof window !== 'undefined' &&
    !!(window.electronAPI && !(window.electronAPI as any).isBrowserShim);
  if (isElectron) {
    return `gphoto://sprite?id=${encodeURIComponent(coord.spriteId)}`;
  }
  return `/api/sprites/${encodeURIComponent(coord.spriteId)}.webp`;
}

/**
 * Hook to retrieve pre-baked sprite coordinates for a photo thumbnail.
 * Renders instantly from memory cache if available, or queries main/web service asynchronously.
 */
export function useSpriteCoordinate(photoPath: string | undefined | null): SpriteCoordinate | null {
  const [coord, setCoord] = useState<SpriteCoordinate | null>(() => {
    if (!photoPath) return null;
    return spriteCoordCache.get(photoPath.toLowerCase()) || null;
  });

  useEffect(() => {
    if (!photoPath) {
      setCoord(null);
      return;
    }

    const key = photoPath.toLowerCase();
    if (spriteCoordCache.has(key)) {
      setCoord(spriteCoordCache.get(key) || null);
      return;
    }

    let isMounted = true;
    let fetchPromise = pendingCoordRequests.get(key);

    if (!fetchPromise) {
      fetchPromise = (async () => {
        try {
          if (window.electronAPI?.getSpriteCoordinate) {
            return await window.electronAPI.getSpriteCoordinate(photoPath);
          }
          if (window.location?.protocol?.startsWith('http')) {
            const res = await fetch(`/api/sprite-coord?path=${encodeURIComponent(photoPath)}`);
            if (res.ok) {
              return await res.json();
            }
          }
        } catch {}
        return null;
      })();
      pendingCoordRequests.set(key, fetchPromise);
    }

    fetchPromise.then((result) => {
      spriteCoordCache.set(key, result);
      pendingCoordRequests.delete(key);
      if (isMounted) {
        setCoord(result);
      }
    });

    return () => {
      isMounted = false;
    };
  }, [photoPath]);

  return coord;
}

// ============================================================================
// 1. GLOBAL BATCH THUMBNAIL STORE & BATCH REQUEST MANAGER
// ============================================================================

// Memory store of path -> dataUrl
export const batchThumbnailStore = new Map<string, string>();
const pendingBatchPaths = new Set<string>();
const batchListeners = new Set<(updatedPaths: Set<string>) => void>();

// Queue for batch requests to debounce rapid view updates
let batchTimeoutId: any = null;
let queuedBatchItems: Array<{ path: string; originalPath?: string }> = [];
let queuedBatchSize = 250;

/**
 * Subscribes to batch thumbnail store updates.
 */
export function subscribeToBatchThumbnails(callback: (updatedPaths: Set<string>) => void): () => void {
  batchListeners.add(callback);
  return () => {
    batchListeners.delete(callback);
  };
}

/**
 * Flushes the current queue and executes the batch fetch request.
 */
async function flushBatchQueue(): Promise<void> {
  if (queuedBatchItems.length === 0) return;

  const currentItems = queuedBatchItems;
  const currentSize = queuedBatchSize;
  queuedBatchItems = [];
  batchTimeoutId = null;

  // Chunk into batches of up to 100
  const CHUNK_SIZE = 100;
  for (let i = 0; i < currentItems.length; i += CHUNK_SIZE) {
    const chunk = currentItems.slice(i, i + CHUNK_SIZE);
    try {
      if (window.electronAPI?.getBatchThumbnails) {
        const res = await trackBackendCall(
          window.electronAPI.getBatchThumbnails({
            items: chunk,
            size: currentSize,
          }),
          'Loading thumbnail batch...'
        );

        if (res && res.thumbnails) {
          const updated = new Set<string>();
          for (const [filePath, dataUrl] of Object.entries(res.thumbnails)) {
            if (dataUrl) {
              batchThumbnailStore.set(filePath, dataUrl);
              updated.add(filePath);
            }
          }
          for (const l of batchListeners) {
            try { l(updated); } catch {}
          }
        }
      }
    } catch (err) {
      console.warn('[BatchThumbnailManager] Batch fetch error:', err);
    } finally {
      for (const item of chunk) {
        pendingBatchPaths.delete(item.path);
      }
    }
  }
}

/**
 * Requests a batch of photo thumbnails (e.g. 50-100 visible photos).
 * Pre-populates the cache in 1 single async network roundtrip!
 */
export function requestBatchThumbnails(
  items: Array<{ path: string; originalPath?: string }>,
  size: number = 250
): void {
  const needed: Array<{ path: string; originalPath?: string }> = [];

  for (const item of items) {
    if (!item || !item.path) continue;
    if (!batchThumbnailStore.has(item.path) && !pendingBatchPaths.has(item.path)) {
      needed.push(item);
      pendingBatchPaths.add(item.path);
    }
  }

  if (needed.length === 0) return;

  queuedBatchItems.push(...needed);
  queuedBatchSize = size;

  if (!batchTimeoutId) {
    batchTimeoutId = setTimeout(() => {
      flushBatchQueue();
    }, 15);
  }
}

/**
 * React hook that uses the batch thumbnail store.
 * Renders instantly from memory if available, or automatically requests via batch.
 */
export function useBatchThumbnail(
  path: string | undefined | null,
  originalPath?: string,
  size: number = 250
): { src: string | null; isLoading: boolean; hasError: boolean } {
  const [src, setSrc] = useState<string | null>(path ? batchThumbnailStore.get(path) || null : null);
  const [isLoading, setIsLoading] = useState<boolean>(!src);
  const [hasError, setHasError] = useState<boolean>(false);

  useEffect(() => {
    if (!path) {
      setSrc(null);
      setIsLoading(false);
      setHasError(false);
      return;
    }

    // Check if already in batch store
    if (batchThumbnailStore.has(path)) {
      setSrc(batchThumbnailStore.get(path)!);
      setIsLoading(false);
      setHasError(false);
      return;
    }

    setIsLoading(true);
    setHasError(false);

    // Subscribe to batch arrivals
    const unsubscribe = subscribeToBatchThumbnails((updatedPaths) => {
      if (updatedPaths.has(path)) {
        const dataUrl = batchThumbnailStore.get(path);
        if (dataUrl) {
          setSrc(dataUrl);
          setIsLoading(false);
          setHasError(false);
        }
      }
    });

    // Request as part of the debounced batch queue
    requestBatchThumbnails([{ path, originalPath }], size);

    // Timeout safety: if not loaded in 8 seconds, stop loading spinner
    const timeout = setTimeout(() => {
      if (!batchThumbnailStore.has(path)) {
        setIsLoading(false);
        setHasError(true);
      }
    }, 8000);

    return () => {
      unsubscribe();
      clearTimeout(timeout);
    };
  }, [path, originalPath, size]);

  return { src, isLoading, hasError };
}

// ============================================================================
// 2. INDIVIDUAL THROTTLED ASYNC IMAGE LOADER (FOR LIGHTBOX & FALLBACKS)
// ============================================================================

const MAX_CONCURRENT_FETCHES = 3;
let activeFetches = 0;
const fetchQueue: (() => void)[] = [];
const blobCache = new Map<string, string>();
const MAX_BLOB_CACHE = 250;

function acquireFetchSlot(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new DOMException('Aborted', 'AbortError'));
  }

  if (activeFetches < MAX_CONCURRENT_FETCHES) {
    activeFetches++;
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    const queueItem = () => {
      activeFetches++;
      resolve();
    };

    const onAbort = () => {
      const idx = fetchQueue.indexOf(queueItem);
      if (idx !== -1) fetchQueue.splice(idx, 1);
      reject(new DOMException('Aborted', 'AbortError'));
    };

    signal?.addEventListener('abort', onAbort, { once: true });

    fetchQueue.push(() => {
      signal?.removeEventListener('abort', onAbort);
      queueItem();
    });
  });
}

function releaseFetchSlot(): void {
  activeFetches = Math.max(0, activeFetches - 1);
  if (fetchQueue.length > 0 && activeFetches < MAX_CONCURRENT_FETCHES) {
    const next = fetchQueue.shift();
    if (next) next();
  }
}

export async function loadAsyncPhoto(url: string, signal?: AbortSignal): Promise<string> {
  if (!url) throw new Error('Empty URL');

  if (blobCache.has(url)) {
    return blobCache.get(url)!;
  }

  await acquireFetchSlot(signal);

  try {
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000);

    const onParentAbort = () => controller.abort();
    signal?.addEventListener('abort', onParentAbort, { once: true });

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        cache: 'default',
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} loading image`);
      }

      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);

      if (blobCache.size >= MAX_BLOB_CACHE) {
        const oldestKey = blobCache.keys().next().value;
        if (oldestKey) {
          const oldUrl = blobCache.get(oldestKey);
          if (oldUrl) URL.revokeObjectURL(oldUrl);
          blobCache.delete(oldestKey);
        }
      }
      blobCache.set(url, objectUrl);

      return objectUrl;
    } finally {
      clearTimeout(timeoutId);
      signal?.removeEventListener('abort', onParentAbort);
    }
  } finally {
    releaseFetchSlot();
  }
}

export interface UseAsyncPhotoResult {
  src: string | null;
  isLoading: boolean;
  hasError: boolean;
  retry: () => void;
}

export function useAsyncPhoto(url: string | null | undefined): UseAsyncPhotoResult {
  const [src, setSrc] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [hasError, setHasError] = useState<boolean>(false);
  const [retryKey, setRetryKey] = useState<number>(0);
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!url) {
      setSrc(null);
      setIsLoading(false);
      setHasError(false);
      return;
    }

    if (blobCache.has(url)) {
      setSrc(blobCache.get(url)!);
      setIsLoading(false);
      setHasError(false);
      return;
    }

    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    const controller = new AbortController();
    abortControllerRef.current = controller;

    setIsLoading(true);
    setHasError(false);

    loadAsyncPhoto(url, controller.signal)
      .then((objectUrl) => {
        if (!controller.signal.aborted) {
          setSrc(objectUrl);
          setIsLoading(false);
          setHasError(false);
        }
      })
      .catch((err) => {
        if (err.name === 'AbortError') {
          return;
        }
        if (!controller.signal.aborted) {
          console.warn(`[AsyncImageLoader] Failed loading ${url}:`, err.message);
          setHasError(true);
          setIsLoading(false);
        }
      });

    return () => {
      controller.abort();
    };
  }, [url, retryKey]);

  const retry = () => setRetryKey((k) => k + 1);

  return { src, isLoading, hasError, retry };
}
