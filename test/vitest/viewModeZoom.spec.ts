import { describe, it, expect } from 'vitest';
import { zoomForViewMode } from '../../src/renderer/src/components/viewModeZoom';

// A 4000x3000 photo shown fitted at 1200x900 in a 1500x1000 area.
const big = { shownW: 1200, shownH: 900, naturalW: 4000, boxW: 1500, boxH: 1000 };
// A 300x200 thumbnail-sized picture, shown at its own size (the fitted view never enlarges).
const small = { shownW: 300, shownH: 200, naturalW: 300, boxW: 1500, boxH: 1000 };

describe('zoomForViewMode', () => {
  it('"fit" is the plain fitted view, whatever the photo', () => {
    expect(zoomForViewMode('fit', big)).toBe(1);
    expect(zoomForViewMode('fit', small)).toBe(1);
  });

  it('"fill" enlarges a small photo until one side reaches the edge (keeping its shape)', () => {
    const z = zoomForViewMode('fill', small);
    // limited by the tighter of width (1468/300 = 4.89) and height (968/200 = 4.84)
    expect(z).toBeCloseTo(968 / 200, 5);
    expect(300 * z).toBeLessThanOrEqual(1500 - 32 + 0.001);
    expect(200 * z).toBeLessThanOrEqual(1000 - 32 + 0.001);
  });

  it('"fill" never shrinks a photo that already fills the area', () => {
    expect(zoomForViewMode('fill', { ...big, shownW: 1468, shownH: 968 })).toBeGreaterThanOrEqual(1);
    expect(zoomForViewMode('fill', { ...big, boxW: 500, boxH: 400 })).toBe(1);
  });

  it('"original" shows real pixels: zoom = natural width / shown width', () => {
    expect(zoomForViewMode('original', big)).toBeCloseTo(4000 / 1200, 5);
  });

  it('"original" of a photo smaller than its fitted view stays at 1 (it is already 1:1)', () => {
    expect(zoomForViewMode('original', small)).toBe(1);
  });

  it('is safe before the picture has a size (not loaded yet)', () => {
    expect(zoomForViewMode('fill', { shownW: 0, shownH: 0, naturalW: 0, boxW: 800, boxH: 600 })).toBe(1);
    expect(zoomForViewMode('original', { ...big, shownW: 0 })).toBe(1);
  });
});
