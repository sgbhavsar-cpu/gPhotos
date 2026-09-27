// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// A minimal card that forwards exactly what the gallery's drag-select relies on.
vi.mock('../../src/renderer/src/components/PhotoCard', async () => {
  const R = await import('react');
  return {
    PhotoCard: (props: any) =>
      R.createElement('div', {
        'data-photo-id': props.photo.id,
        'data-selected': props.isSelected ? '1' : '0',
        onMouseDown: (e: any) => props.onCardMouseDown?.(props.photo.id, e),
        onMouseEnter: (e: any) => props.onCardMouseEnter?.(props.photo.id, e),
        onClick: (e: any) => props.onClick?.(e),
      }),
  };
});
vi.mock('../../src/renderer/src/services/asyncImageLoader', () => ({
  requestBatchThumbnails: vi.fn(),
  useBatchThumbnail: () => ({ src: null, isLoading: false, hasError: false }),
  useSpriteCoordinate: () => null,
  getSpriteUrl: () => '',
  batchThumbnailStore: new Map(),
  evictAndRefreshThumbnail: vi.fn(),
}));

import { VirtualizedTimelineGallery } from '../../src/renderer/src/components/VirtualizedTimelineGallery';

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

const PHOTOS = Array.from({ length: 24 }, (_, i) => ({
  id: `p${i}`, filePath: `C:\\p\\p${i}.jpg`, fileName: `p${i}.jpg`, fileSize: 1,
  dateTaken: `2026-03-${String(1 + (i % 28)).padStart(2, '0')}T10:00:00.000Z`, year: 2026, month: 3, day: 1 + (i % 28),
})) as any[];

let latest: { selected: Set<string>; changes: number };

function mount(initial: string[] = []) {
  latest = { selected: new Set(initial), changes: 0 };
  const Harness = () => {
    const [selected, setSelected] = useState<Set<string>>(new Set(initial));
    latest.selected = selected;
    return React.createElement(VirtualizedTimelineGallery, {
      photos: PHOTOS,
      zoomLevel: 'medium',
      onZoomChange: () => {},
      onSelectPhoto: () => {},
      onToggleFavorite: () => {},
      isSelectMode: selected.size > 0,
      selectedIds: selected,
      onToggleSelect: (id: string) =>
        setSelected((prev) => {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        }),
      onSelectionChange: (s: Set<string>) => {
        latest.changes++;
        setSelected(new Set(s));
      },
    });
  };
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(React.createElement(Harness)));
  return host;
}

const card = (host: HTMLElement, id: string) => host.querySelector(`[data-photo-id="${id}"]`) as HTMLElement;
const colsOf = (host: HTMLElement) => {
  const grid = Array.from(host.querySelectorAll<HTMLElement>('div')).find((d) => /repeat\(\d+, 1fr\)/.test(d.style.gridTemplateColumns))!;
  return Number(/repeat\((\d+),/.exec(grid.style.gridTemplateColumns)![1]);
};
const press = (host: HTMLElement, id: string, opts: { ctrl?: boolean } = {}) =>
  act(() => {
    card(host, id).dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, ctrlKey: !!opts.ctrl }));
  });
const enter = (host: HTMLElement, id: string) =>
  act(() => {
    card(host, id).dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
  });
const release = () => act(() => { window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); });
const idx = (id: string) => Number(id.slice(1));
/** ids in the rectangle between two photos on a grid `cols` wide. */
const rect = (cols: number, a: string, b: string) => {
  const r0 = Math.min(Math.floor(idx(a) / cols), Math.floor(idx(b) / cols));
  const r1 = Math.max(Math.floor(idx(a) / cols), Math.floor(idx(b) / cols));
  const c0 = Math.min(idx(a) % cols, idx(b) % cols);
  const c1 = Math.max(idx(a) % cols, idx(b) % cols);
  return PHOTOS.filter((_, i) => { const r = Math.floor(i / cols), c = i % cols; return r >= r0 && r <= r1 && c >= c0 && c <= c1; }).map((p) => p.id);
};
const sel = () => Array.from(latest.selected).sort((a, b) => idx(a) - idx(b));

describe('drag selection in the gallery', () => {
  it('with nothing selected, press + drag selects the grid block between the two photos', () => {
    const host = mount();
    const cols = colsOf(host);
    expect(cols).toBeGreaterThanOrEqual(3);
    press(host, 'p0');
    enter(host, `p${cols + 2}`); // one row down, two columns across
    release();
    expect(sel()).toEqual(rect(cols, 'p0', `p${cols + 2}`));
    expect(sel().length).toBe(6);
  });

  it('shrinking the drag back removes what only the drag had selected', () => {
    const host = mount();
    const cols = colsOf(host);
    press(host, 'p0');
    enter(host, `p${cols + 2}`);
    enter(host, 'p1');
    release();
    expect(sel()).toEqual(rect(cols, 'p0', 'p1'));
  });

  it('Ctrl + press + drag ADDS a new block and leaves the earlier selection exactly as it was', () => {
    const host = mount(['p0', 'p1', 'p2']);
    const cols = colsOf(host);
    const start = `p${2 * cols}`; // two rows below the first block
    const end = `p${2 * cols + 1}`;
    press(host, start, { ctrl: true });
    enter(host, end);
    release();
    expect(sel()).toEqual(['p0', 'p1', 'p2', ...rect(cols, start, end)].sort((a, b) => idx(a) - idx(b)));
  });

  it('Ctrl + drag over already-selected photos never deselects them', () => {
    const host = mount(['p0', 'p1', 'p2', 'p3']);
    const cols = colsOf(host);
    press(host, 'p1', { ctrl: true }); // starts ON a selected photo and sweeps across selected and new ones
    enter(host, `p${cols + 2}`);
    enter(host, `p${cols + 3}`);
    release();
    const expected = new Set(['p0', 'p1', 'p2', 'p3', ...rect(cols, 'p1', `p${cols + 3}`)]);
    expect(new Set(sel())).toEqual(expected);
    for (const id of ['p0', 'p1', 'p2', 'p3']) expect(latest.selected.has(id)).toBe(true);
  });

  it('shrinking a Ctrl drag keeps the original selection and only drops the dragged block', () => {
    const host = mount(['p0']);
    const cols = colsOf(host);
    const start = `p${3 * cols}`;
    press(host, start, { ctrl: true });
    enter(host, `p${3 * cols + 2}`);
    enter(host, start);
    release();
    expect(sel()).toEqual(['p0', start]);
  });

  it('a plain drag while photos are selected starts a NEW selection (Ctrl is what keeps the old one)', () => {
    const host = mount(['p0', 'p1', 'p2']);
    const cols = colsOf(host);
    const start = `p${2 * cols}`;
    press(host, start);
    enter(host, `p${2 * cols + 1}`);
    release();
    expect(sel()).toEqual(rect(cols, start, `p${2 * cols + 1}`));
    expect(latest.selected.has('p0')).toBe(false);
  });

  it('a press without moving never changes the selection by itself; clicks still toggle as before', () => {
    const host = mount(['p0']);
    press(host, 'p5', { ctrl: true });
    release();
    expect(sel()).toEqual(['p0']); // nothing happened until the click
    act(() => card(host, 'p5').dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true })));
    expect(sel()).toEqual(['p0', 'p5']);
    act(() => card(host, 'p5').dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true })));
    expect(sel()).toEqual(['p0']);
  });

  it('the click that ends a drag does not toggle the photo it lands on', async () => {
    const host = mount(['p0']);
    const cols = colsOf(host);
    press(host, `p${2 * cols}`, { ctrl: true });
    enter(host, `p${2 * cols + 1}`);
    release();
    const before = sel();
    act(() => card(host, `p${2 * cols + 1}`).dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true })));
    expect(sel()).toEqual(before);
  });
});
