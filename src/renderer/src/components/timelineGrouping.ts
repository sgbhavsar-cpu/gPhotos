import type { Photo } from '../../../types';

// Month grouping for the timeline gallery. The catalog loads ~100 photos per page and every
// page hands the gallery a new (longer) photos array, so a naive regroup did a full
// `new Date()` pass over all N photos per page (~O(N^2/100) total). Here each photo's
// year/month key is computed once (cached per object) and pages that merely append to the
// previous array only touch the groups the new photos land in.

export interface MonthGroup {
  key: string;
  label: string;
  year: number;
  photos: Photo[];
}

interface MonthInfo {
  /** dateTaken the cached key was derived from, so an in-place edit invalidates it. */
  d: unknown;
  key: string;
  year: number;
}

const infoCache = new WeakMap<object, MonthInfo>();

export function photoMonthInfo(p: Photo): { key: string; year: number } {
  const hit = infoCache.get(p);
  if (hit && hit.d === p.dateTaken) return hit;
  const date = new Date(p.dateTaken);
  const year = date.getFullYear() || 1970;
  const info = { d: p.dateTaken, key: `${year}-${String(date.getMonth() + 1).padStart(2, '0')}`, year };
  infoCache.set(p, info);
  return info;
}

const monthLabel = (p: Photo) => new Date(p.dateTaken).toLocaleDateString(undefined, { year: 'numeric', month: 'long' });

/**
 * Returns a grouper that memoises across calls: same array -> same result; an array that
 * extends the previous one (same objects in the same positions) -> only affected groups are
 * rebuilt (untouched groups keep their identity); anything else -> a full regroup, which is
 * still cheap because per-photo keys come from the cache. Output is always identical to a
 * from-scratch grouping: groups newest-first, photos in input order.
 */
export function createMonthGrouper(): (photos: Photo[]) => MonthGroup[] {
  let prevPhotos: Photo[] = [];
  let prevGroups: MonthGroup[] = [];
  return (photos) => {
    if (photos === prevPhotos) return prevGroups;
    const n = prevPhotos.length;
    let isAppend = n > 0 && photos.length >= n;
    for (let i = 0; isAppend && i < n; i++) if (photos[i] !== prevPhotos[i]) isAppend = false;

    const base = new Map<string, MonthGroup>();
    if (isAppend) for (const g of prevGroups) base.set(g.key, g);
    const start = isAppend ? n : 0;

    const touched = new Map<string, { year: number; first: Photo; list: Photo[] }>();
    for (let i = start; i < photos.length; i++) {
      const p = photos[i];
      const info = photoMonthInfo(p);
      let t = touched.get(info.key);
      if (!t) touched.set(info.key, (t = { year: info.year, first: p, list: [] }));
      t.list.push(p);
    }
    for (const [key, t] of touched) {
      const g = base.get(key);
      base.set(key, g ? { ...g, photos: g.photos.concat(t.list) } : { key, label: monthLabel(t.first), year: t.year, photos: t.list });
    }
    prevPhotos = photos;
    prevGroups = Array.from(base.values()).sort((a, b) => b.key.localeCompare(a.key));
    return prevGroups;
  };
}

/** Row window [startRow, endRow) of a month group that intersects [viewportTop, viewportBottom], or null if the group is off-screen. */
export function monthRowWindow(
  item: { top: number; bottom: number; headerHeight: number; rows: number },
  viewportTop: number,
  viewportBottom: number,
  itemHeight: number,
  gap: number
): { startRow: number; endRow: number } | null {
  if (!(item.bottom >= viewportTop && item.top <= viewportBottom)) return null;
  const pitch = itemHeight + gap;
  const relTop = Math.max(0, viewportTop - item.top - item.headerHeight);
  const relBottom = Math.max(0, viewportBottom - item.top - item.headerHeight);
  return {
    startRow: Math.max(0, Math.floor(relTop / pitch)),
    endRow: Math.min(item.rows, Math.ceil(relBottom / pitch)),
  };
}
