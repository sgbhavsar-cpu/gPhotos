import { useEffect, useState } from 'react';
import { faceQueue, QueueStatus } from '../services/faceQueue';

export interface BackgroundActivitySummary {
  /** Something is actually running right now (not just queued/paused). */
  isActive: boolean;
  /** Work is queued/known-incomplete but currently paused (idle auto-pause or manual). */
  isPaused: boolean;
  /** Empty string when there's nothing to show at all. */
  label: string;
}

interface ThumbnailStatus {
  isRunning: boolean;
  current: number;
  total: number;
  paused: boolean;
}

const THUMBNAIL_POLL_MS = 3000;
const IDLE_STATUS: BackgroundActivitySummary = { isActive: false, isPaused: false, label: '' };

/**
 * Feeds the sidebar's library-card activity indicator — see App.tsx's 15s
 * idle-detector effect for the pause/resume logic this is just reflecting.
 * Three independent sources feed into one summary, in priority order:
 *   1. The post-library-switch face-detection sweep (runFaceDetectionForPhotos)
 *   2. faceQueue's own idle-driven one-photo-at-a-time queue
 *   3. Thumbnail pre-caching (polled — the main process has no push channel
 *      for this status today, and a 3s poll is more than fine for a status
 *      label no one is watching frame-by-frame).
 */
export function useBackgroundActivityStatus(
  isDetectingFacesSweep: boolean,
  faceSweepProgress: { current: number; total: number } | null
): BackgroundActivitySummary {
  const [faceQueueStatus, setFaceQueueStatus] = useState<QueueStatus>(() => faceQueue.getStatus());
  const [thumbStatus, setThumbStatus] = useState<ThumbnailStatus | null>(null);

  useEffect(() => faceQueue.subscribe(setFaceQueueStatus), []);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const status = await window.electronAPI?.getThumbnailPreCacheStatus?.();
        if (!cancelled && status) setThumbStatus(status);
      } catch {
        // Best-effort status only — leaves the previous value in place.
      }
    };
    poll();
    const interval = setInterval(poll, THUMBNAIL_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  if (isDetectingFacesSweep && faceSweepProgress && faceSweepProgress.total > 0) {
    return {
      isActive: true,
      isPaused: false,
      label: `Detecting faces… ${faceSweepProgress.current}/${faceSweepProgress.total}`,
    };
  }

  if (faceQueueStatus.total > 0 && faceQueueStatus.completed < faceQueueStatus.total) {
    return faceQueueStatus.isPaused
      ? { isActive: false, isPaused: true, label: 'Face detection paused — resumes when idle' }
      : { isActive: true, isPaused: false, label: `Detecting faces… ${faceQueueStatus.completed}/${faceQueueStatus.total}` };
  }

  if (thumbStatus && thumbStatus.total > thumbStatus.current) {
    return thumbStatus.paused
      ? { isActive: false, isPaused: true, label: 'Caching paused — resumes when idle' }
      : { isActive: true, isPaused: false, label: `Caching thumbnails… ${thumbStatus.current}/${thumbStatus.total}` };
  }

  return IDLE_STATUS;
}
