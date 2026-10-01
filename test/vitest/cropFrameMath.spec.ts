// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { computeCropDragRect } from '../../src/renderer/src/components/cropFrameMath';

const MIN = 0.04;
const full = { x: 0.1, y: 0.1, width: 0.6, height: 0.5 };

describe('computeCropDragRect (PowerPoint-style crop frame math)', () => {
  it('move: translates the whole rect and clamps to the image bounds', () => {
    expect(computeCropDragRect('move', full, 0.1, -0.05, MIN)).toEqual({ x: 0.2, y: 0.05, width: 0.6, height: 0.5 });
    // dragging far past the right/bottom edge clamps, it never pushes width/height past 1
    expect(computeCropDragRect('move', full, 5, 5, MIN)).toEqual({ x: 0.4, y: 0.5, width: 0.6, height: 0.5 });
    expect(computeCropDragRect('move', full, -5, -5, MIN)).toEqual({ x: 0, y: 0, width: 0.6, height: 0.5 });
  });

  it('e/s handles: grow or shrink from the fixed opposite corner', () => {
    expect(computeCropDragRect('e', full, 0.1, 0, MIN)).toEqual({ x: 0.1, y: 0.1, width: 0.7, height: 0.5 });
    expect(computeCropDragRect('s', full, 0, 0.1, MIN)).toEqual({ x: 0.1, y: 0.1, width: 0.6, height: 0.6 });
    // can't grow past the image edge (x=0.1, width capped at 1-0.1=0.9)
    expect(computeCropDragRect('e', full, 5, 0, MIN)).toEqual({ x: 0.1, y: 0.1, width: 0.9, height: 0.5 });
  });

  it('w/n handles: move the near edge, keep the far edge fixed', () => {
    // dragging w right by 0.2: x moves from 0.1 to 0.3, width shrinks by the same 0.2
    const rw = computeCropDragRect('w', full, 0.2, 0, MIN);
    expect(rw.x).toBeCloseTo(0.3, 10);
    expect(rw.width).toBeCloseTo(0.4, 10);
    const rn = computeCropDragRect('n', full, 0, 0.2, MIN);
    expect(rn.y).toBeCloseTo(0.3, 10);
    expect(rn.height).toBeCloseTo(0.3, 10);
  });

  it('a corner handle (nw) moves both its edges together, each independently clamped', () => {
    const r = computeCropDragRect('nw', full, 0.05, -0.05, MIN);
    expect(r.x).toBeCloseTo(0.15, 10);
    expect(r.y).toBeCloseTo(0.05, 10);
    expect(r.width).toBeCloseTo(0.55, 10);
    expect(r.height).toBeCloseTo(0.55, 10);
  });

  it('shrinking past the minimum size stops at min, never crosses or inverts the opposite edge', () => {
    const r = computeCropDragRect('e', full, -1, 0, MIN);
    expect(r.width).toBe(MIN);
    expect(r.x).toBe(full.x); // opposite (left) edge never moved
    const r2 = computeCropDragRect('w', full, 1, 0, MIN);
    // right edge (x+width) stays fixed at 0.7 regardless of how far w overshoots
    expect(r2.x + r2.width).toBeCloseTo(full.x + full.width, 10);
    expect(r2.width).toBeCloseTo(MIN, 10);
  });
});
