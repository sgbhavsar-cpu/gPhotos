import { describe, it, expect } from 'vitest';
import { createMonthGrouper, monthRowWindow, photoMonthInfo } from '../../src/renderer/src/components/timelineGrouping';

// Reference: the original from-scratch grouping the gallery used to run on every photos change.
function fullRegroup(photos: any[]) {
  const map = new Map<string, { key: string; label: string; year: number; photos: any[] }>();
  for (const p of photos) {
    const date = new Date(p.dateTaken);
    const yr = date.getFullYear() || 1970;
    const key = `${yr}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    let g = map.get(key);
    if (!g) {
      g = { key, label: date.toLocaleDateString(undefined, { year: 'numeric', month: 'long' }), year: yr, photos: [] };
      map.set(key, g);
    }
    g.photos.push(p);
  }
  return Array.from(map.values()).sort((a, b) => b.key.localeCompare(a.key));
}

const summarize = (groups: any[]) => groups.map((g) => ({ key: g.key, label: g.label, year: g.year, ids: g.photos.map((p: any) => p.id) }));

// Small deterministic PRNG so failures are reproducible.
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

let nextId = 0;
function randomPhoto(rand: () => number): any {
  const r = rand();
  // Mostly newest-first-ish clustered dates, some anywhere, a few unparseable ones.
  const dateTaken =
    r < 0.03
      ? 'not-a-date'
      : new Date(2015 + Math.floor(rand() * 10), Math.floor(rand() * 12), 1 + Math.floor(rand() * 28), 12).toISOString();
  return { id: `p${nextId++}`, dateTaken, fileName: 'x.jpg', filePath: 'x' };
}

describe('incremental month grouping equals a full regroup', () => {
  it('for random photo sequences appended page by page (catalog loading)', () => {
    for (const seed of [1, 2, 3, 42, 1234]) {
      const rand = rng(seed);
      const group = createMonthGrouper();
      const all: any[] = [];
      let photos: any[] = [];
      while (all.length < 1500) {
        const page = Array.from({ length: 1 + Math.floor(rand() * 100) }, () => randomPhoto(rand));
        all.push(...page);
        photos = [...photos, ...page]; // a new array identity per page, like the store does
        expect(summarize(group(photos))).toEqual(summarize(fullRegroup(photos)));
      }
    }
  });

  it('for non-append changes: edited object, removals, reordering, reset to empty and back', () => {
    const rand = rng(7);
    const group = createMonthGrouper();
    const base = Array.from({ length: 400 }, () => randomPhoto(rand));
    expect(summarize(group(base))).toEqual(summarize(fullRegroup(base)));

    const edited = base.map((p, i) => (i === 10 ? { ...p, isFavorite: true, dateTaken: '2001-05-05T00:00:00.000Z' } : p));
    expect(summarize(group(edited))).toEqual(summarize(fullRegroup(edited)));

    const removed = edited.filter((_, i) => i % 3 !== 0);
    expect(summarize(group(removed))).toEqual(summarize(fullRegroup(removed)));

    const reordered = [...removed].reverse();
    expect(summarize(group(reordered))).toEqual(summarize(fullRegroup(reordered)));

    expect(group([])).toEqual([]);
    expect(summarize(group(base))).toEqual(summarize(fullRegroup(base)));
  });

  it('an appended page rebuilds only the groups it lands in; untouched groups keep identity', () => {
    const group = createMonthGrouper();
    const jan = { id: 'a', dateTaken: new Date(2020, 0, 5, 12).toISOString() };
    const feb = { id: 'b', dateTaken: new Date(2020, 1, 5, 12).toISOString() };
    const first = group([jan, feb] as any[]);
    const janGroup = first.find((g) => g.key === '2020-01')!;
    const febGroup = first.find((g) => g.key === '2020-02')!;

    const more = { id: 'c', dateTaken: new Date(2020, 1, 20, 12).toISOString() };
    const second = group([jan, feb, more] as any[]);
    expect(second.find((g) => g.key === '2020-01')).toBe(janGroup); // untouched
    const newFeb = second.find((g) => g.key === '2020-02')!;
    expect(newFeb).not.toBe(febGroup); // rebuilt (new identity so memoised consumers refresh)
    expect(newFeb.photos.map((p) => p.id)).toEqual(['b', 'c']);
    expect(febGroup.photos.map((p) => p.id)).toEqual(['b']); // previous result never mutated
  });

  it('returns the identical result for the identical array', () => {
    const group = createMonthGrouper();
    const photos = [{ id: 'a', dateTaken: '2020-03-03T12:00:00.000Z' }] as any[];
    expect(group(photos)).toBe(group(photos));
  });

  it('computes each photo month key once (cached) but notices an edited dateTaken', () => {
    const p: any = { id: 'x', dateTaken: '2020-03-03T12:00:00.000Z' };
    const a = photoMonthInfo(p);
    expect(photoMonthInfo(p)).toBe(a);
    p.dateTaken = '2019-01-15T12:00:00.000Z';
    expect(photoMonthInfo(p).key).toBe('2019-01');
  });
});

describe('monthRowWindow (per-group visible rows, shared by render and thumbnail prefetch)', () => {
  const item = { top: 1000, bottom: 1000 + 52 + 10 * 130 + 32, headerHeight: 52, rows: 11 };
  it('is null when the group is entirely outside the viewport', () => {
    expect(monthRowWindow(item, 0, 900, 120, 10)).toBeNull();
    expect(monthRowWindow(item, item.bottom + 1, item.bottom + 800, 120, 10)).toBeNull();
  });
  it('covers exactly the rows intersecting the viewport, clamped to the group', () => {
    expect(monthRowWindow(item, 0, 1052 + 130 * 2, 120, 10)).toEqual({ startRow: 0, endRow: 2 });
    expect(monthRowWindow(item, 1052 + 130 * 3 + 5, 1052 + 130 * 5, 120, 10)).toEqual({ startRow: 3, endRow: 5 });
    expect(monthRowWindow(item, 900, 1e9, 120, 10)).toEqual({ startRow: 0, endRow: 11 });
  });
});
