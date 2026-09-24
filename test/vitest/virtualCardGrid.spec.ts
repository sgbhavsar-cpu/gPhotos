import { describe, it, expect } from 'vitest';
import { computeColumns, computeRowRange } from '../../src/renderer/src/components/VirtualCardGrid';

describe('computeColumns matches CSS repeat(auto-fill, minmax(min, 1fr))', () => {
  it('reproduces the live People grid: 1030px wide, 180px min, 20px gap -> 5 columns', () => {
    expect(computeColumns(1030, 180, 20)).toBe(5);
  });
  it('is at least 1 column, and grows exactly when another min-width column fits', () => {
    expect(computeColumns(50, 180, 20)).toBe(1);
    expect(computeColumns(180, 180, 20)).toBe(1);
    expect(computeColumns(379, 180, 20)).toBe(1); // 2 cols need 180*2+20 = 380
    expect(computeColumns(380, 180, 20)).toBe(2);
  });
});

describe('computeRowRange mounts only the rows in view plus overscan', () => {
  const pitch = 266; // 246px card + 20px gap
  it('at the top of a 1,000-row grid mounts just the first few rows', () => {
    const r = computeRowRange(0, 780, 24, pitch, 1000, 2);
    expect(r.startRow).toBe(0);
    expect(r.endRow).toBeLessThanOrEqual(6); // ~3 rows visible + 2 overscan
  });
  it('mid-scroll returns a window around the viewport, sized to the viewport not the list', () => {
    const scrollTop = 500 * pitch; // ~row 500
    const r = computeRowRange(scrollTop, 780, 24, pitch, 1000, 2);
    expect(r.startRow).toBeGreaterThanOrEqual(497);
    expect(r.startRow).toBeLessThanOrEqual(500);
    expect(r.endRow - r.startRow).toBeLessThan(10);
  });
  it('clamps to the list bounds (past the end, before the start, empty grid)', () => {
    expect(computeRowRange(1e9, 780, 24, pitch, 40, 2).endRow).toBe(40);
    expect(computeRowRange(1e9, 780, 24, pitch, 40, 2).startRow).toBeLessThanOrEqual(40);
    expect(computeRowRange(0, 780, 500, pitch, 40, 2).startRow).toBe(0); // grid starts below the fold
    expect(computeRowRange(0, 780, 24, pitch, 0, 2)).toEqual({ startRow: 0, endRow: 0 });
  });
  it('never leaves a gap: every row intersecting the viewport is inside the window', () => {
    for (const scrollTop of [0, 137, 4000, 88888, 250000]) {
      const { startRow, endRow } = computeRowRange(scrollTop, 780, 24, pitch, 2000, 1);
      const firstVisible = Math.max(0, Math.floor((scrollTop - 24) / pitch));
      const lastVisible = Math.min(1999, Math.floor((scrollTop + 780 - 24) / pitch));
      expect(startRow).toBeLessThanOrEqual(firstVisible);
      expect(endRow).toBeGreaterThan(lastVisible);
    }
  });
});
