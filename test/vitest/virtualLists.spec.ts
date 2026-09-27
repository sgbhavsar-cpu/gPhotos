// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import React, { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { VirtualCardGrid, computeColumns } from '../../src/renderer/src/components/VirtualCardGrid';
import { VirtualHorizontalList, computeItemRange } from '../../src/renderer/src/components/VirtualHorizontalList';
import { findScrollParent, useDebouncedValue } from '../../src/renderer/src/components/listHooks';

// The face tiles each decode a full-resolution crop; stub the avatar so we can count how many
// would have been mounted (== decoded).
vi.mock('../../src/renderer/src/components/FaceAvatar', async () => {
  const R = await import('react');
  return { FaceAvatar: (props: any) => R.createElement('span', { 'data-face-avatar': props.face.id }) };
});

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no layout. Give every scroll container (inline overflow auto) a fixed viewport, and
// place non-scrollers relative to their nearest scroller's scroll offset — exactly what the
// windowing code reads (clientWidth/Height, getBoundingClientRect, scrollTop/Left).
const VIEW_W = 1000;
const VIEW_H = 600;
const isScroller = (el: HTMLElement) => el.style?.overflowY === 'auto' || el.style?.overflowX === 'auto';
const scrollParent = (el: HTMLElement) => {
  let p = el.parentElement;
  while (p && !isScroller(p)) p = p.parentElement;
  return p;
};
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return isScroller(this) ? VIEW_H : 0; } });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return VIEW_W; } });
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    const sp = isScroller(this) ? null : scrollParent(this);
    const top = -((sp as any)?.scrollTop || 0);
    const left = -((sp as any)?.scrollLeft || 0);
    return { top, left, bottom: top, right: left, width: 0, height: 0, x: left, y: top, toJSON() {} } as DOMRect;
  };
});

const roots: Root[] = [];
afterEach(() => {
  while (roots.length) act(() => roots.pop()!.unmount());
  document.body.innerHTML = '';
});
const mount = (el: React.ReactElement) => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(el));
  return host;
};
/** Let the rAF-batched scroll/measure handlers run and React commit. */
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 50)); });
const scrollTo = async (scroller: HTMLElement, pos: { top?: number; left?: number }) => {
  if (pos.top !== undefined) Object.defineProperty(scroller, 'scrollTop', { configurable: true, writable: true, value: pos.top });
  if (pos.left !== undefined) Object.defineProperty(scroller, 'scrollLeft', { configurable: true, writable: true, value: pos.left });
  scroller.dispatchEvent(new Event('scroll'));
  await flush();
};
/** Scroll to the real maximum offset (a browser clamps scrollTop; the virtual grid's spacer height is the content height). */
const scrollToEnd = (scroller: HTMLElement) =>
  scrollTo(scroller, {
    top: Math.max(...Array.from(scroller.querySelectorAll<HTMLElement>('div')).map((d) => parseFloat(d.style.height) || 0)) - VIEW_H,
  });
const scrollerOf = (host: HTMLElement) => Array.from(host.querySelectorAll<HTMLElement>('div')).find(isScroller)!;

describe('VirtualCardGrid mounts only the visible window (+ overscan) and reaches the end', () => {
  const N = 5000;
  const ROW_H = 100;
  const GAP = 10;
  const items = Array.from({ length: N }, (_, i) => ({ id: `i${i}` }));
  const Harness = () => {
    const ref = useRef<HTMLDivElement>(null);
    return React.createElement(
      'div', { ref, style: { overflowY: 'auto' } },
      React.createElement(VirtualCardGrid<{ id: string }>, {
        items, getKey: (i) => i.id, scrollRef: ref, rowHeight: ROW_H, minColWidth: 150, gap: GAP,
        renderItem: (i) => React.createElement('div', { 'data-i': i.id }),
      })
    );
  };
  const ids = (host: HTMLElement) => Array.from(host.querySelectorAll('[data-i]')).map((e) => e.getAttribute('data-i')!);

  it('at the top only ~a screen of tiles is in the DOM, not 5,000', async () => {
    const host = mount(React.createElement(Harness));
    await flush();
    const cols = computeColumns(VIEW_W, 150, GAP);
    const mounted = ids(host);
    expect(mounted.length).toBeGreaterThan(0);
    expect(mounted.length).toBeLessThanOrEqual((Math.ceil(VIEW_H / (ROW_H + GAP)) + 2 + 2) * cols); // visible + overscan rows
    expect(mounted[0]).toBe('i0');
    expect(mounted).not.toContain(`i${N - 1}`);
  });

  it('scrolling to the very end mounts the last item; mid-scroll mounts a window around it', async () => {
    const host = mount(React.createElement(Harness));
    await flush();
    const scroller = scrollerOf(host);
    const cols = computeColumns(VIEW_W, 150, GAP);
    const totalRows = Math.ceil(N / cols);
    const totalHeight = totalRows * ROW_H + (totalRows - 1) * GAP;

    await scrollTo(scroller, { top: 250 * (ROW_H + GAP) });
    const mid = ids(host);
    expect(mid).toContain(`i${250 * cols}`);
    expect(mid).not.toContain('i0');
    expect(mid.length).toBeLessThan(80);

    await scrollTo(scroller, { top: totalHeight - VIEW_H });
    const end = ids(host);
    expect(end).toContain(`i${N - 1}`);
    expect(end.length).toBeLessThan(80);
  });
});

describe('VirtualHorizontalList (cluster tray)', () => {
  it('computeItemRange windows along x with overscan and clamps to the list', () => {
    expect(computeItemRange(0, 900, 18, 150, 12, 1000, 3)).toEqual({ start: 0, end: 9 }); // ceil((900-18)/162)=6 visible + 3 overscan
    expect(computeItemRange(1e9, 900, 18, 150, 12, 1000, 3).end).toBe(1000);
    expect(computeItemRange(0, 900, 18, 150, 12, 0, 3)).toEqual({ start: 0, end: 0 });
  });

  const N = 2000;
  const items = Array.from({ length: N }, (_, i) => ({ id: `h${i}` }));
  const Tray = () => {
    const ref = useRef<HTMLDivElement>(null);
    return React.createElement(
      'div', { ref, style: { overflowX: 'auto', padding: '14px 18px' } },
      React.createElement(VirtualHorizontalList<{ id: string }>, {
        items, getKey: (i) => i.id, scrollRef: ref, itemWidth: 150, gap: 12,
        renderItem: (i) => React.createElement('div', { 'data-h': i.id, style: { minWidth: 150, maxWidth: 150 } }),
      })
    );
  };
  const ids = (host: HTMLElement) => Array.from(host.querySelectorAll('[data-h]')).map((e) => e.getAttribute('data-h')!);

  it('mounts a handful of cards, keeps the full scroll width via spacers, and reaches the last card', async () => {
    const host = mount(React.createElement(Tray));
    await flush();
    expect(ids(host).length).toBeGreaterThan(0);
    expect(ids(host).length).toBeLessThan(20);
    expect(ids(host)[0]).toBe('h0');

    const spacerWidth = () => {
      const strip = host.querySelector('[data-h]')!.parentElement!;
      return Array.from(strip.children).filter((c) => !c.hasAttribute('data-h')).reduce((w, c) => w + parseFloat((c as HTMLElement).style.width), 0);
    };
    const scroller = scrollerOf(host);
    await scrollTo(scroller, { left: 1000 * 162 });
    expect(ids(host)).toContain('h1000');
    expect(ids(host)).not.toContain('h0');
    // mounted cards + gaps + spacers always add up to the unwindowed strip width
    const mounted = ids(host).length;
    const strip = host.querySelector('[data-h]')!.parentElement!;
    const gaps = strip.children.length - 1;
    expect(mounted * 150 + gaps * 12 + spacerWidth()).toBe(N * 150 + (N - 1) * 12);

    await scrollTo(scroller, { left: N * 162 });
    expect(ids(host)).toContain(`h${N - 1}`);
  });
});

describe('ChangeCoverFaceModal is windowed: only visible faces mount (and decode)', () => {
  it('mounts a screenful of 800 faces, the footer still counts all, and scrolling reaches the last one', async () => {
    const { ChangeCoverFaceModal } = await import('../../src/renderer/src/components/ChangeCoverFaceModal');
    const person: any = { id: 'per1', name: 'Ann', faceCount: 800, photoCount: 800, createdAt: '2020-01-01' };
    const photos: any[] = Array.from({ length: 800 }, (_, i) => ({
      id: `ph${i}`, filePath: `C:\\p\\${i}.jpg`, fileName: `${i}.jpg`, fileSize: 1, dateTaken: '2020-01-01T00:00:00.000Z',
      faces: [{ id: `f${i}`, photoId: `ph${i}`, personId: 'per1', box: { x: 1, y: 1, width: 50, height: 60 }, confidence: 0.95 - i / 1000, descriptor: [] }],
    }));
    const host = mount(React.createElement(ChangeCoverFaceModal, { person, photos, onClose: () => {} }));
    await flush();

    const mounted = () => Array.from(host.querySelectorAll('[data-face-avatar]')).map((e) => e.getAttribute('data-face-avatar')!);
    expect(mounted().length).toBeGreaterThan(0);
    expect(mounted().length).toBeLessThan(60); // was 120 (capped) — now just the window
    expect(host.textContent).toContain('800 face instances available');

    // Ordered by score (confidence falls with i, ties keep input order), so the last tile is f799.
    const lowest = 'f799';
    expect(mounted()).not.toContain(lowest);
    const scroller = scrollerOf(host);
    await scrollToEnd(scroller);
    expect(mounted()).toContain(lowest);
    expect(mounted().length).toBeLessThan(60);
  });
});

describe('AlbumsView grids are windowed but every photo stays reachable', () => {
  const mkPhotos = (n: number): any[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `a${i}`, filePath: `C:\\p\\${i}.jpg`, fileName: `photo-${i}.jpg`, fileSize: 1,
      dateTaken: '2020-01-01T00:00:00.000Z', faces: [],
    }));
  const click = (el: Element) => act(() => { (el as HTMLElement).click(); });
  const byText = (host: HTMLElement, sel: string, text: string | RegExp) =>
    Array.from(host.querySelectorAll<HTMLElement>(sel)).find((e) => (typeof text === 'string' ? e.textContent === text : text.test(e.textContent || '')))!;

  it('album detail: mounts a window of a 3,000-photo album; the last photo is reachable by scrolling', async () => {
    const { AlbumsView } = await import('../../src/renderer/src/views/AlbumsView');
    const photos = mkPhotos(3000);
    const albums: any[] = [{ id: 'al1', title: 'Big Album', photoIds: photos.map((p) => p.id), createdAt: 'x', updatedAt: 'x' }];
    const host = mount(React.createElement(AlbumsView, { photos, albums, onSelectPhoto: () => {} }));
    click(byText(host, 'h3, h2, h4, div', 'Big Album'));
    await flush();

    const names = () => Array.from(host.querySelectorAll('img')).map((i) => i.getAttribute('alt')!);
    expect(names().length).toBeGreaterThan(0);
    expect(names().length).toBeLessThan(120); // was 500 + "Show more"
    expect(names()).toContain('photo-0.jpg');
    expect(host.textContent).not.toContain('Show more');

    const scroller = Array.from(host.querySelectorAll<HTMLElement>('div')).filter(isScroller).find((d) => d.querySelector('img'))!;
    await scrollToEnd(scroller);
    expect(names()).toContain('photo-2999.jpg');
    expect(names().length).toBeLessThan(120);
  });

  it('add-photos picker: windowed grid, and "Select All" selects every match (not just the mounted tiles)', async () => {
    const { AlbumsView } = await import('../../src/renderer/src/views/AlbumsView');
    const photos = mkPhotos(3000);
    const albums: any[] = [{ id: 'al1', title: 'Small Album', photoIds: ['a0', 'a1'], createdAt: 'x', updatedAt: 'x' }];
    const host = mount(React.createElement(AlbumsView, { photos, albums, onSelectPhoto: () => {} }));
    click(byText(host, 'h3, h2, h4, div', 'Small Album'));
    await flush();
    click(byText(host, 'button', 'Add Photos'));
    await flush();

    const available = 3000 - 2;
    const selectAll = byText(host, 'button', new RegExp(`Select All \\(${available}\\)`));
    expect(selectAll).toBeTruthy();

    const pickerScroller = Array.from(host.querySelectorAll<HTMLElement>('div')).filter(isScroller).find((d) => d.textContent?.includes('photo-2.jpg') || d.querySelector('img[alt="photo-2.jpg"]'))!;
    const tiles = () => pickerScroller.querySelectorAll('img').length;
    expect(tiles()).toBeGreaterThan(0);
    expect(tiles()).toBeLessThan(150); // was capped at 300

    click(selectAll);
    await flush();
    expect(host.textContent).toContain(`${available} photos selected`);
    expect(tiles()).toBeLessThan(150);

    await scrollToEnd(pickerScroller);
    expect(Array.from(pickerScroller.querySelectorAll('img')).map((i) => i.getAttribute('alt'))).toContain('photo-2999.jpg');
  });
});

describe('list hooks', () => {
  it('findScrollParent skips data-no-vscroll wrappers and returns the real vertical scroller', () => {
    const outer = document.createElement('div');
    outer.style.overflowY = 'auto';
    const hwrap = document.createElement('div');
    hwrap.style.overflowX = 'auto'; // computes overflow-y:auto too, but never scrolls vertically
    hwrap.setAttribute('data-no-vscroll', '');
    const inner = document.createElement('div');
    outer.appendChild(hwrap);
    hwrap.appendChild(inner);
    document.body.appendChild(outer);
    expect(findScrollParent(inner)).toBe(outer);
    expect(findScrollParent(outer)).toBe(outer);
    expect(findScrollParent(document.createElement('div'))).toBeNull();
  });

  it('useDebouncedValue only updates after the value has been stable', async () => {
    let latest = '';
    const Probe = ({ v }: { v: string }) => { latest = useDebouncedValue(v, 60); return null; };
    const host = document.createElement('div');
    const root = createRoot(host);
    roots.push(root);
    act(() => root.render(React.createElement(Probe, { v: 'a' })));
    expect(latest).toBe('a');
    for (const v of ['ab', 'abc', 'abcd']) {
      act(() => root.render(React.createElement(Probe, { v })));
    }
    expect(latest).toBe('a'); // keystrokes in flight: no refilter yet
    await act(async () => { await new Promise((r) => setTimeout(r, 120)); });
    expect(latest).toBe('abcd');
  });
});
