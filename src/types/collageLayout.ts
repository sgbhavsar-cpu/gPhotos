// Pure collage layout math, shared by the main-process renderer (videoExportService.ts) and the
// wizard's style-picker previews (VideoWizardModal.tsx), so what the popup shows is exactly what
// gets rendered. No I/O, no dependencies.
export const MAX_COLLAGE_PHOTOS = 4; // the album chapter's auto-generated cover collage
/** A collage frame in a generated video may hold more: up to 3 x 3. */
export const MAX_VIDEO_COLLAGE_PHOTOS = 9;

export type CollageStyle = 'grid' | 'sideBySide' | 'stacked' | 'featured';

export interface CollageTile {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 5-9 photos: the most square-looking rows x columns for the frame's shape (a wide frame gets more columns), filled row
 * by row. A last row with fewer photos shares the full width between them, so no gap is left at the edge.
 */
function evenGrid(n: number, width: number, height: number, gap: number): CollageTile[] {
  const cols = Math.min(n, Math.max(2, Math.round(Math.sqrt((n * width) / height))));
  const rows = Math.ceil(n / cols);
  const rowH = Math.floor((height - gap * (rows - 1)) / rows);
  const tiles: CollageTile[] = [];
  for (let r = 0; r < rows; r++) {
    const inRow = r === rows - 1 ? n - cols * (rows - 1) : cols;
    const w = Math.floor((width - gap * (inRow - 1)) / inRow);
    for (let c = 0; c < inRow; c++) {
      tiles.push({ x: c * (w + gap), y: r * (rowH + gap), w: c === inRow - 1 ? width - c * (w + gap) : w, h: r === rows - 1 ? height - r * (rowH + gap) : rowH });
    }
  }
  return tiles;
}

/**
 * Pure layout math (no I/O, no sharp) for a collage of `count` photos (1-4) in a `width`x`height`
 * frame — kept separate from the rendering so the arrangement of each style can be unit-tested
 * exactly. Styles:
 *  - grid:       the default — aspect-aware (2 = side-by-side or stacked by orientation, 3 = one big +
 *                two small, 4 = 2x2).
 *  - sideBySide: N equal full-height columns.
 *  - stacked:    N equal full-width rows.
 *  - featured:   the first photo big across the top (~65%), the rest as an equal-width strip below.
 */
export function computeCollageTiles(count: number, style: CollageStyle, width: number, height: number, gap = 4): CollageTile[] {
  const n = Math.min(Math.max(count, 1), MAX_VIDEO_COLLAGE_PHOTOS);
  if (n === 1) return [{ x: 0, y: 0, w: width, h: height }];

  if (style === 'sideBySide') {
    const w = Math.floor((width - gap * (n - 1)) / n);
    return Array.from({ length: n }, (_, i) => ({ x: i * (w + gap), y: 0, w: i === n - 1 ? width - i * (w + gap) : w, h: height }));
  }

  if (style === 'stacked') {
    const h = Math.floor((height - gap * (n - 1)) / n);
    return Array.from({ length: n }, (_, i) => ({ x: 0, y: i * (h + gap), w: width, h: i === n - 1 ? height - i * (h + gap) : h }));
  }

  if (style === 'featured') {
    const bigH = Math.floor((height - gap) * 0.65);
    const smallCount = n - 1;
    const smallW = Math.floor((width - gap * (smallCount - 1)) / smallCount);
    const smallH = height - bigH - gap;
    const tiles: CollageTile[] = [{ x: 0, y: 0, w: width, h: bigH }];
    for (let i = 0; i < smallCount; i++) {
      tiles.push({ x: i * (smallW + gap), y: bigH + gap, w: i === smallCount - 1 ? width - i * (smallW + gap) : smallW, h: smallH });
    }
    return tiles;
  }

  // 'grid' (default)
  const portrait = height >= width;
  if (n === 2) {
    if (portrait) {
      const h0 = Math.floor((height - gap) / 2);
      return [{ x: 0, y: 0, w: width, h: h0 }, { x: 0, y: h0 + gap, w: width, h: height - h0 - gap }];
    }
    const w0 = Math.floor((width - gap) / 2);
    return [{ x: 0, y: 0, w: w0, h: height }, { x: w0 + gap, y: 0, w: width - w0 - gap, h: height }];
  }
  if (n === 3) {
    if (portrait) {
      const bigH = Math.floor((height - gap) * 0.6);
      const smallH = height - bigH - gap;
      const halfW = Math.floor((width - gap) / 2);
      return [
        { x: 0, y: 0, w: width, h: bigH },
        { x: 0, y: bigH + gap, w: halfW, h: smallH },
        { x: halfW + gap, y: bigH + gap, w: width - halfW - gap, h: smallH },
      ];
    }
    const bigW = Math.floor((width - gap) * 0.6);
    const smallW = width - bigW - gap;
    const halfH = Math.floor((height - gap) / 2);
    return [
      { x: 0, y: 0, w: bigW, h: height },
      { x: bigW + gap, y: 0, w: smallW, h: halfH },
      { x: bigW + gap, y: halfH + gap, w: smallW, h: height - halfH - gap },
    ];
  }
  if (n > 4) return evenGrid(n, width, height, gap);
  const halfW = Math.floor((width - gap) / 2);
  const halfH = Math.floor((height - gap) / 2);
  return [
    { x: 0, y: 0, w: halfW, h: halfH },
    { x: halfW + gap, y: 0, w: width - halfW - gap, h: halfH },
    { x: 0, y: halfH + gap, w: halfW, h: height - halfH - gap },
    { x: halfW + gap, y: halfH + gap, w: width - halfW - gap, h: height - halfH - gap },
  ];
}
