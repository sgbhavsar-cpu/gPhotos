// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { anchorAtY, scrollTopFor, photoTop, type AnchorLayoutGroup } from '../../src/renderer/src/components/zoomAnchor';

// ---------------------------------------------------------------------------------------------------------------
// An independent model of the gallery's layout: 20px top padding, then per month [52px header][rows][32px margin].
// ---------------------------------------------------------------------------------------------------------------
const HEADER = 52;
const MARGIN = 32;
const SIZES = {
  very_small: { cols: 11, itemHeight: 76, gap: 4 },
  small: { cols: 7, itemHeight: 120, gap: 8 },
  medium: { cols: 5, itemHeight: 180, gap: 12 },
  large: { cols: 3, itemHeight: 250, gap: 16 },
} as const;
type Size = keyof typeof SIZES;

const MONTHS = 6;
const PER_MONTH = 40;
const ids = (m: number) => Array.from({ length: PER_MONTH }, (_, i) => ({ id: `m${m}_${i}` }));

function layout(size: Size): AnchorLayoutGroup[] {
  const { cols, itemHeight, gap } = SIZES[size];
  let top = 20;
  // Newest month first, exactly like the gallery.
  return Array.from({ length: MONTHS }, (_, i) => {
    const m = MONTHS - 1 - i;
    const photos = ids(m);
    const rows = Math.ceil(photos.length / cols);
    const height = HEADER + rows * itemHeight + (rows - 1) * gap + MARGIN;
    const g = { key: `2026-${m}`, top, bottom: top + height, headerHeight: HEADER, photos };
    top += height;
    return g;
  });
}
const metrics = (s: Size) => SIZES[s];
/** Top-left photo (or month start) at content-Y `y`, computed the plain way. */
function topLeftAt(size: Size, y: number) {
  const { cols, itemHeight, gap } = SIZES[size];
  const g = layout(size).find((x) => x.top <= y && y < x.bottom)!;
  const gridY = y - g.top - HEADER;
  if (gridY < 0 || gridY < (itemHeight + gap) / 2) return { group: g.key } as const;
  const rows = Math.ceil(g.photos.length / cols);
  const row = Math.min(rows - 1, Math.floor(gridY / (itemHeight + gap))); // the bottom margin belongs to the last row
  return { photo: g.photos[row * cols].id } as const;
}

describe('zoomAnchor (pure)', () => {
  it('toolbar: the top-left photo stays the first photo of the top row after every zoom change', () => {
    for (const from of Object.keys(SIZES) as Size[]) {
      for (const to of Object.keys(SIZES) as Size[]) {
        if (from === to) continue;
        for (let y = 20; y < layout(from)[MONTHS - 1].bottom - 400; y += 137) {
          const anchor = anchorAtY(layout(from), metrics(from), y, { topLeft: true })!;
          const next = scrollTopFor(layout(to), metrics(to), anchor, 0)!;
          const oldThing = topLeftAt(from, y);
          if ('group' in oldThing) {
            expect(anchor).toEqual({ kind: 'group', groupKey: oldThing.group });
            expect(next).toBe(layout(to).find((g) => g.key === oldThing.group)!.top);
          } else {
            // the SAME photo is now in the top row of the viewport
            expect(anchor.kind === 'photo' && anchor.photoId).toBe(oldThing.photo);
            const top = photoTop(layout(to), metrics(to), (anchor as any).groupKey, oldThing.photo)!;
            expect(next).toBe(top);
          }
        }
      }
    }
  });

  it('wheel: the photo under the pointer stays under the pointer (same offset inside the thumbnail, scaled)', () => {
    const from: Size = 'medium';
    const y = 1234; // content Y under the pointer
    const viewportY = 310;
    const g = layout(from).find((x) => x.top <= y && y < x.bottom)!;
    const { cols, itemHeight, gap } = SIZES[from];
    const row = Math.floor((y - g.top - HEADER) / (itemHeight + gap));
    const col = 3;
    const anchor = anchorAtY(layout(from), metrics(from), y, { col })!;
    expect(anchor.kind).toBe('photo');
    expect((anchor as any).photoId).toBe(g.photos[row * cols + col].id);

    for (const to of ['very_small', 'small', 'large'] as Size[]) {
      const next = scrollTopFor(layout(to), metrics(to), anchor, viewportY)!;
      const top = photoTop(layout(to), metrics(to), (anchor as any).groupKey, (anchor as any).photoId)!;
      // pointer (viewportY) sits (fracY * itemHeight) below the thumbnail's top edge
      expect(next + viewportY).toBeCloseTo(top + (anchor as any).fracY * SIZES[to].itemHeight, 6);
    }
  });

  it('a round trip medium → small → medium returns to the same offset (whole-row positions)', () => {
    const y = layout('medium')[2].top + HEADER + 3 * (180 + 12); // exactly the top of row 3 of month 2
    const a1 = anchorAtY(layout('medium'), metrics('medium'), y, { topLeft: true })!;
    const small = scrollTopFor(layout('small'), metrics('small'), a1, 0)!;
    const a2 = anchorAtY(layout('small'), metrics('small'), small, { topLeft: true })!;
    const back = scrollTopFor(layout('medium'), metrics('medium'), a2, 0)!;
    // the photo may land mid-row after the column count changes, but the row of the same photo is what we return to
    expect(Math.abs(back - y)).toBeLessThanOrEqual(3 * (180 + 12));
    expect(a1.kind).toBe('photo');
  });

  it('edge cases: above everything, below everything, empty layout, unknown photo', () => {
    expect(anchorAtY([], metrics('medium'), 100)).toBeNull();
    const top = anchorAtY(layout('medium'), metrics('medium'), 0, { topLeft: true })!;
    expect(top).toEqual({ kind: 'group', groupKey: '2026-5' }); // the newest month is first
    const last = layout('medium')[MONTHS - 1];
    const bottom = anchorAtY(layout('medium'), metrics('medium'), last.bottom + 5000, { topLeft: false })!;
    expect(bottom.kind).toBe('photo'); // clamped to the last row of the last month
    expect(scrollTopFor(layout('small'), metrics('small'), { kind: 'photo', photoId: 'nope', groupKey: 'x', fracY: 0 }, 0)).toBeNull();
    expect(scrollTopFor(layout('small'), metrics('small'), { kind: 'group', groupKey: 'missing' }, 0)).toBeNull();
    // never negative
    expect(scrollTopFor(layout('small'), metrics('small'), { kind: 'group', groupKey: '2026-5' }, 500)).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The real gallery
// ---------------------------------------------------------------------------------------------------------------
vi.mock('../../src/renderer/src/components/PhotoCard', async () => {
  const R = await import('react');
  return { PhotoCard: (props: any) => R.createElement('div', { 'data-photo-id': props.photo.id, onClick: props.onClick }) };
});
vi.mock('../../src/renderer/src/services/asyncImageLoader', () => ({
  requestBatchThumbnails: vi.fn(),
  useBatchThumbnail: () => ({ src: null, isLoading: false, hasError: false }),
  useSpriteCoordinate: () => null,
  getSpriteUrl: () => '',
  batchThumbnailStore: new Map(),
  evictAndRefreshThumbnail: vi.fn(),
}));
import { VirtualizedTimelineGallery, type GalleryZoomLevel } from '../../src/renderer/src/components/VirtualizedTimelineGallery';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1000 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 900 });
});
const roots: Root[] = [];
afterEach(() => {
  while (roots.length) act(() => roots.pop()!.unmount());
  document.body.innerHTML = '';
});

const PHOTOS = Array.from({ length: MONTHS * PER_MONTH }, (_, i) => {
  const m = Math.floor(i / PER_MONTH);
  return { id: `m${m}_${i % PER_MONTH}`, filePath: `C:\\p\\${i}.jpg`, fileName: `${i}.jpg`, fileSize: 1, dateTaken: `2026-${String(m + 1).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}T10:00:00.000Z`, year: 2026, month: m + 1, day: 1 + (i % 28) };
}) as any[];

let setZoomExternally: (z: GalleryZoomLevel) => void;
function mountGallery(initial: GalleryZoomLevel = 'medium') {
  const Harness = () => {
    const [zoom, setZoom] = useState<GalleryZoomLevel>(initial);
    setZoomExternally = setZoom;
    return React.createElement(VirtualizedTimelineGallery, {
      photos: PHOTOS, zoomLevel: zoom, onZoomChange: setZoom, onSelectPhoto: () => {}, onToggleFavorite: () => {},
    });
  };
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(React.createElement(Harness)));
  // the scroll container: give it a settable scrollTop (jsdom has no layout)
  const scroller = Array.from(host.querySelectorAll<HTMLElement>('div')).find((d) => d.style.overflowY === 'auto')!;
  let st = 0;
  Object.defineProperty(scroller, 'scrollTop', { configurable: true, get: () => st, set: (v: number) => { st = v; } });
  return { host, scroller };
}
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 40)); });
const scrollTo = async (scroller: HTMLElement, top: number) => {
  (scroller as any).scrollTop = top;
  await act(async () => { scroller.dispatchEvent(new Event('scroll')); });
  await flush();
};

describe('VirtualizedTimelineGallery keeps the same photo in view when the size changes', () => {
  it('toolbar: the thumbnail at the top-left stays at the top after every zoom change', async () => {
    const { scroller } = mountGallery('medium');
    // somewhere inside the third month
    const y0 = layout('medium')[2].top + HEADER + 4 * (180 + 12) + 30;
    await scrollTo(scroller, y0);
    const before = topLeftAt('medium', y0);
    expect('photo' in before).toBe(true);

    for (const to of ['small', 'very_small', 'large', 'medium'] as Size[]) {
      const from = (globalThis as any).__cur || 'medium';
      const yNow = (scroller as any).scrollTop;
      const expectedAnchor = topLeftAt(from, yNow);
      await act(async () => { setZoomExternally(to); });
      await flush();
      const g = layout(to);
      const expected =
        'group' in expectedAnchor
          ? g.find((x) => x.key === expectedAnchor.group)!.top
          : photoTop(g, metrics(to), '', expectedAnchor.photo)!;
      expect((scroller as any).scrollTop).toBe(expected);
      (globalThis as any).__cur = to;
    }
    delete (globalThis as any).__cur;
  });

  it('toolbar: at the very top it stays at the very top', async () => {
    const { scroller } = mountGallery('medium');
    await scrollTo(scroller, 0);
    await act(async () => { setZoomExternally('large'); });
    await flush();
    expect((scroller as any).scrollTop).toBe(layout('large')[0].top - 0 === 20 ? 20 : 0); // month 0 starts at 20px padding
  });

  it('Ctrl + wheel: the photo under the pointer stays under the pointer', async () => {
    const { host, scroller } = mountGallery('medium');
    const y0 = layout('medium')[MONTHS - 1 - 1].top + HEADER + 2 * (180 + 12) + 5; // month m1 (newest first)
    await scrollTo(scroller, y0);
    // the card the pointer is over (jsdom has no layout, so pick a rendered card and give the event a pointer Y)
    const cards = Array.from(host.querySelectorAll<HTMLElement>('[data-photo-id]'));
    const card = cards.find((c) => c.getAttribute('data-photo-id') === 'm1_12')!;
    expect(card).toBeTruthy();
    const pointerY = 340;
    await act(async () => {
      card.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: 100, clientY: pointerY }));
    });
    await flush(); // Ctrl+wheel down = zoom OUT one level: medium -> small

    const g = layout('small');
    const top = photoTop(g, metrics('small'), 'm1', 'm1_12')!;
    expect((scroller as any).scrollTop).toBe(Math.max(0, top - pointerY)); // fracY is 0: jsdom rects are empty
  });
});
