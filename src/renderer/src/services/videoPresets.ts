// Pure helpers behind the video wizard's one-click choices: templates (a saved bundle of look and pacing), export presets
// (WhatsApp / Reel / YouTube ...), a file-size estimate, and "auto-pick the best shots". No React, no I/O.
import type { Photo, VideoAspectRatio, VideoResolutionTier, VideoQuality, VideoTransition } from '../../../types';
import type { VideoFilterName, VideoMotionName } from '../../../types/videoFormat';
import type { CaptionOptions } from './videoCaption';

export interface VideoTemplate {
  id: string;
  label: string;
  description: string;
  aspectRatio: VideoAspectRatio;
  resolution: VideoResolutionTier;
  /** One effect for every cut, or a random pick from this pool. */
  transition: VideoTransition | VideoTransition[];
  transitionDurationSec: number;
  secondsPerItem: number;
  filter: VideoFilterName;
  motion: VideoMotionName;
  captions: CaptionOptions;
  /** Cap the whole video at this many seconds (Reels / status). */
  maxTotalSec?: number;
}

const caps = (o: Partial<CaptionOptions>): CaptionOptions => ({ place: false, date: false, people: false, chapter: false, ...o });

export const VIDEO_TEMPLATES: VideoTemplate[] = [
  { id: 'trip', label: 'Trip', description: 'Calm pacing, gentle zoom, place and date captions', aspectRatio: '16:9', resolution: '1080p', transition: 'fade', transitionDurationSec: 0.8, secondsPerItem: 3.5, filter: 'none', motion: 'zoomin', captions: caps({ place: true, date: true }) },
  { id: 'birthday', label: 'Birthday', description: 'Bright and lively, names on screen', aspectRatio: '16:9', resolution: '1080p', transition: ['circleopen', 'zoomin', 'pixelize', 'radial', 'wipeleft'], transitionDurationSec: 0.6, secondsPerItem: 2.5, filter: 'vivid', motion: 'zoomin', captions: caps({ people: true }) },
  { id: 'wedding', label: 'Wedding', description: 'Slow dissolves, warm look, follows the faces', aspectRatio: '16:9', resolution: '1080p', transition: 'dissolve', transitionDurationSec: 1.2, secondsPerItem: 4.5, filter: 'warm', motion: 'face', captions: caps({ people: true }) },
  { id: 'reel', label: 'Reel (vertical, 30 s)', description: 'Vertical, quick cuts, capped at 30 seconds', aspectRatio: '9:16', resolution: '1080p', transition: 'slideup', transitionDurationSec: 0.4, secondsPerItem: 1.8, filter: 'vivid', motion: 'zoomin', captions: caps({}), maxTotalSec: 30 },
  { id: 'memories', label: 'Memories', description: 'Vintage look, chapter titles as captions', aspectRatio: '16:9', resolution: '1080p', transition: 'dissolve', transitionDurationSec: 1, secondsPerItem: 4, filter: 'vintage', motion: 'zoomout', captions: caps({ chapter: true, date: true }) },
];

export interface ExportPreset {
  id: string;
  label: string;
  aspectRatio: VideoAspectRatio;
  resolution: VideoResolutionTier;
  quality: VideoQuality;
  /** The platform's length limit, if any. */
  maxSec?: number;
}

export const EXPORT_PRESETS: ExportPreset[] = [
  { id: 'whatsapp', label: 'WhatsApp status (720p, 30 s)', aspectRatio: '9:16', resolution: '720p', quality: 'draft', maxSec: 30 },
  { id: 'reel', label: 'Instagram Reel (1080p, 90 s)', aspectRatio: '9:16', resolution: '1080p', quality: 'good', maxSec: 90 },
  { id: 'youtube', label: 'YouTube (1080p, high quality)', aspectRatio: '16:9', resolution: '1080p', quality: 'best' },
  { id: 'share', label: 'Small file to share (720p)', aspectRatio: '16:9', resolution: '720p', quality: 'draft' },
];

/** Rough video bitrate (Mbps) of the encoder settings the exporter uses, for a size estimate. Audio adds ~0.19 Mbps. */
const BITRATE_MBPS: Record<VideoResolutionTier, Record<VideoQuality, number>> = {
  '360p': { draft: 0.5, good: 1, best: 2 },
  '720p': { draft: 1.2, good: 2.5, best: 5 },
  '1080p': { draft: 2.5, good: 5, best: 10 },
};

/** Estimated size of the finished file in MB (slideshows compress well; treat it as a ballpark, not a promise). */
export function estimateSizeMB(durationSec: number, resolution: VideoResolutionTier, quality: VideoQuality, hasAudio = false): number {
  const mbps = BITRATE_MBPS[resolution][quality] + (hasAudio ? 0.19 : 0);
  return Math.max(0.1, (Math.max(0, durationSec) * mbps) / 8);
}

export function formatSizeMB(mb: number): string {
  return mb >= 1000 ? `${(mb / 1024).toFixed(1)} GB` : mb >= 10 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
}

/**
 * Picks the best `targetCount` photos / clips out of an album, keeping the album's own order:
 * near-duplicates and bursts (shots within `burstSec` of each other) collapse to their best one, and the rest are ranked
 * by favourites, people in the shot and sharpness. Videos are always eligible (they add variety) but score a little lower
 * than a favourite photo, so a trip is not all clips.
 */
export function autoPickIds(photos: Photo[], targetCount: number, burstSec = 4): string[] {
  const usable = photos.filter((p) => !p.isExcluded);
  if (usable.length <= targetCount) return usable.map((p) => p.id);

  const sharp = usable.map((p) => p.sharpnessScore).filter((v): v is number => typeof v === 'number').sort((a, b) => a - b);
  const sharpRank = (v: number | undefined) => (v === undefined || sharp.length === 0 ? 0.5 : sharp.filter((x) => x <= v).length / sharp.length);
  const score = (p: Photo) => (p.isFavorite ? 3 : 0) + Math.min(3, p.faces?.length ?? 0) * 0.8 + 2 * sharpRank(p.sharpnessScore) + (p.isVideo ? 1 : 0);

  // Collapse bursts: consecutive shots (in time order) within burstSec of the previous one form a group; keep its best.
  const byTime = [...usable].sort((a, b) => new Date(a.dateTaken).getTime() - new Date(b.dateTaken).getTime());
  const groups: Photo[][] = [];
  for (const p of byTime) {
    const g = groups[groups.length - 1];
    const prev = g && g[g.length - 1];
    const gap = prev ? Math.abs(new Date(p.dateTaken).getTime() - new Date(prev.dateTaken).getTime()) / 1000 : Infinity;
    if (g && gap <= burstSec && !p.isVideo && !prev.isVideo) g.push(p);
    else groups.push([p]);
  }
  const candidates = groups.map((g) => g.reduce((best, p) => (score(p) > score(best) ? p : best)));

  const chosen = new Set(candidates.sort((a, b) => score(b) - score(a)).slice(0, targetCount).map((p) => p.id));
  return usable.filter((p) => chosen.has(p.id)).map((p) => p.id); // back in the album's order
}
