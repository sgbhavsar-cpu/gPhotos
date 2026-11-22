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

/** Every ffmpeg `xfade` transition the wizard offers (value, label), 'none' = hard cut. Each name was checked against the bundled ffmpeg. */
export const VIDEO_TRANSITIONS = [
  ['none', 'None (hard cut)'], ['fade', 'Fade'], ['dissolve', 'Dissolve'], ['fadeblack', 'Fade through black'], ['fadewhite', 'Fade through white'], ['fadegrays', 'Fade through grey'],
  ['wipeleft', 'Wipe left'], ['wiperight', 'Wipe right'], ['wipeup', 'Wipe up'], ['wipedown', 'Wipe down'],
  ['slideleft', 'Slide left'], ['slideright', 'Slide right'], ['slideup', 'Slide up'], ['slidedown', 'Slide down'],
  ['smoothleft', 'Smooth left'], ['smoothright', 'Smooth right'], ['coverleft', 'Cover left'], ['revealright', 'Reveal right'],
  ['circleopen', 'Circle open'], ['circleclose', 'Circle close'], ['circlecrop', 'Circle crop'], ['rectcrop', 'Rectangle crop'],
  ['vertopen', 'Vertical open'], ['horzopen', 'Horizontal open'], ['radial', 'Radial'], ['zoomin', 'Zoom in'],
  ['pixelize', 'Pixelize'], ['hblur', 'Horizontal blur'], ['squeezeh', 'Squeeze horizontally'], ['squeezev', 'Squeeze vertically'],
  ['diagtl', 'Diagonal top-left'], ['diagbr', 'Diagonal bottom-right'], ['hlslice', 'Slice left'], ['vuslice', 'Slice up'],
] as const;
export type VideoTransitionName = (typeof VIDEO_TRANSITIONS)[number][0];
