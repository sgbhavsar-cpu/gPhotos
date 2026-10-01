// Output frame sizes, shared by the export service (main) and the wizard's designer previews (renderer),
// so a title/credits card is designed and drawn at exactly the size the video will be.
import type { VideoAspectRatio, VideoResolutionTier } from './index';

// Real platform video sizes (Instagram/YouTube), not a mathematically-derived guess — "1080p" for a
// 9:16 reel means 1080x1920, not 1920x1080 scaled down.
const DIMENSIONS: Record<VideoAspectRatio, Record<VideoResolutionTier, { width: number; height: number }>> = {
  '16:9': { '720p': { width: 1280, height: 720 }, '1080p': { width: 1920, height: 1080 } },
  '9:16': { '720p': { width: 720, height: 1280 }, '1080p': { width: 1080, height: 1920 } },
  '1:1': { '720p': { width: 720, height: 720 }, '1080p': { width: 1080, height: 1080 } },
  '4:3': { '720p': { width: 960, height: 720 }, '1080p': { width: 1440, height: 1080 } },
};

export function computeDimensions(aspect: VideoAspectRatio, resolution: VideoResolutionTier): { width: number; height: number } {
  return DIMENSIONS[aspect][resolution];
}
