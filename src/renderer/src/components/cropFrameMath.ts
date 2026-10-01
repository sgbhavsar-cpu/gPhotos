// PowerPoint-style crop frame math for the lightbox's photo editor. The frame is always
// shown as a full rect with 8 handles (not drawn from scratch); dragging the body moves it,
// dragging a handle resizes it from the opposite edge/corner.
export type CropDragMode = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
export type CropRect = { x: number; y: number; width: number; height: number };

const clamp01 = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

/**
 * Given the rect at drag-start, a handle (or 'move'), and how far the pointer has moved
 * (as a fraction of the image box), returns the new crop rect. Every edge is independently
 * clamped to stay within [0,1] and no smaller than `min`, so a fast drag past the image
 * edge or the opposite handle can't invert or escape the rect.
 */
export function computeCropDragRect(mode: CropDragMode, start: CropRect, dxN: number, dyN: number, min: number): CropRect {
  let { x, y, width, height } = start;
  if (mode === 'move') {
    x = clamp01(start.x + dxN, 0, 1 - start.width);
    y = clamp01(start.y + dyN, 0, 1 - start.height);
    return { x, y, width, height };
  }
  if (mode.includes('e')) width = clamp01(start.width + dxN, min, 1 - start.x);
  if (mode.includes('s')) height = clamp01(start.height + dyN, min, 1 - start.y);
  if (mode.includes('w')) {
    const newX = clamp01(start.x + dxN, 0, start.x + start.width - min);
    width = start.width + (start.x - newX);
    x = newX;
  }
  if (mode.includes('n')) {
    const newY = clamp01(start.y + dyN, 0, start.y + start.height - min);
    height = start.height + (start.y - newY);
    y = newY;
  }
  return { x, y, width, height };
}
