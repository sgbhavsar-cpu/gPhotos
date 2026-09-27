// Keeps the same photo in view when the thumbnail size changes.
//
// The gallery lays photos out as month groups: [header][grid of rows][margin], stacked from `top`. Changing the
// zoom changes the column count, the row pitch and therefore every group's height, so the old scroll offset points
// at something else. These helpers turn "where was the user looking" into an ANCHOR (a photo, or the start of a
// month group) in the old layout, and turn an anchor back into a scroll offset in the new layout.

export interface AnchorLayoutGroup {
  key: string;
  /** Y of the group's top edge inside the scroll content. */
  top: number;
  bottom: number;
  headerHeight: number;
  photos: ReadonlyArray<{ id: string }>;
}

export interface AnchorMetrics {
  cols: number;
  itemHeight: number;
  gap: number;
}

export type ZoomAnchor =
  /** The viewport top was on a month header (or its first row): keep that month's start at the top. */
  | { kind: 'group'; groupKey: string }
  /** A specific photo; `fracY` is how far down inside its thumbnail the anchor point is (0 = top edge, 1 = bottom edge). */
  | { kind: 'photo'; photoId: string; groupKey: string; fracY: number };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Group containing content-Y `y` (the first/last group when `y` is above/below everything). */
function groupAt(groups: ReadonlyArray<AnchorLayoutGroup>, y: number): AnchorLayoutGroup | null {
  if (groups.length === 0) return null;
  let lo = 0;
  let hi = groups.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (groups[mid].top <= y) lo = mid;
    else hi = mid - 1;
  }
  return groups[lo];
}

/**
 * The anchor for content-Y `contentY` in the OLD layout.
 *  - `topLeft` (toolbar zoom): the thumbnail at the top-left of the viewport. At a month header, or within the
 *    first row after it, the month start itself is the anchor so its header stays visible.
 *  - otherwise (wheel zoom at the pointer): the thumbnail under `contentY` in column `col` (default 0).
 */
export function anchorAtY(
  groups: ReadonlyArray<AnchorLayoutGroup>,
  m: AnchorMetrics,
  contentY: number,
  opts: { topLeft?: boolean; col?: number } = {}
): ZoomAnchor | null {
  const g = groupAt(groups, contentY);
  if (!g || g.photos.length === 0) return g ? { kind: 'group', groupKey: g.key } : null;
  const pitch = m.itemHeight + m.gap;
  const yInGroup = contentY - g.top;
  if (yInGroup < 0) return { kind: 'group', groupKey: g.key };

  const gridY = yInGroup - g.headerHeight;
  if (gridY < 0) return { kind: 'group', groupKey: g.key };
  const rows = Math.ceil(g.photos.length / m.cols);
  const row = clamp(Math.floor(gridY / pitch), 0, rows - 1);
  if (opts.topLeft && row === 0 && gridY < pitch / 2) return { kind: 'group', groupKey: g.key };

  const rowOffset = gridY - row * pitch;
  const col = clamp(opts.col ?? 0, 0, m.cols - 1);
  const idx = Math.min(row * m.cols + col, g.photos.length - 1);
  // Toolbar zoom lines the thumbnail's top edge up with the viewport top; the wheel keeps the exact spot under the pointer.
  const fracY = opts.topLeft ? 0 : clamp(rowOffset / m.itemHeight, 0, 1);
  return { kind: 'photo', photoId: g.photos[idx].id, groupKey: g.key, fracY };
}

/** Content-Y of a photo's top edge in a layout, or null when the photo is not in it. */
export function photoTop(groups: ReadonlyArray<AnchorLayoutGroup>, m: AnchorMetrics, groupKey: string, photoId: string): number | null {
  const g = groups.find((x) => x.key === groupKey) || groups.find((x) => x.photos.some((p) => p.id === photoId));
  if (!g) return null;
  const idx = g.photos.findIndex((p) => p.id === photoId);
  if (idx < 0) return null;
  return g.top + g.headerHeight + Math.floor(idx / m.cols) * (m.itemHeight + m.gap);
}

/**
 * Scroll offset in the NEW layout that puts the anchor `viewportY` pixels below the top of the viewport
 * (0 for the toolbar case: the anchor goes to the top-left; the pointer's Y for the wheel case).
 */
export function scrollTopFor(
  groups: ReadonlyArray<AnchorLayoutGroup>,
  m: AnchorMetrics,
  anchor: ZoomAnchor,
  viewportY: number
): number | null {
  if (anchor.kind === 'group') {
    const g = groups.find((x) => x.key === anchor.groupKey);
    return g ? Math.max(0, g.top - viewportY) : null;
  }
  const top = photoTop(groups, m, anchor.groupKey, anchor.photoId);
  return top === null ? null : Math.max(0, top + anchor.fracY * m.itemHeight - viewportY);
}
