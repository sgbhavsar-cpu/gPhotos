// How a photo is sized when the lightbox opens it. The lightbox always lays the picture out "fitted"
// (shrunk to fit, never enlarged) and then scales that whole stage by `zoom`, so each view mode is just
// a zoom factor computed from what is currently on screen.
export type LightboxViewMode = 'fit' | 'fill' | 'original';

export interface ViewModeMeasure {
  /** The picture's laid-out size at zoom 1 (CSS px). */
  shownW: number;
  shownH: number;
  /** The image file's real pixel width. */
  naturalW: number;
  /** The space available for the picture (CSS px). */
  boxW: number;
  boxH: number;
}

const MARGIN = 32; // breathing room around a "fill" picture

export function zoomForViewMode(mode: LightboxViewMode, m: ViewModeMeasure): number {
  if (mode === 'fit' || m.shownW <= 0 || m.shownH <= 0) return 1;
  const target =
    mode === 'fill'
      ? Math.min((m.boxW - MARGIN) / m.shownW, (m.boxH - MARGIN) / m.shownH) // enlarge until one side touches the edge
      : m.naturalW / m.shownW; // real pixels
  // Never smaller than the fitted view (a small photo at 1:1 is just itself), never NaN/Infinity.
  return Number.isFinite(target) ? Math.max(1, target) : 1;
}
