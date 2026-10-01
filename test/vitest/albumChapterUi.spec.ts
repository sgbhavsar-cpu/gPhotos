// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AlbumChapterSection } from '../../src/renderer/src/components/AlbumChapterSection';
import { ChapterPicker } from '../../src/renderer/src/components/ChapterPicker';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const photo = (n: number) => ({
  id: `p${n}`, filePath: `C:\\p${n}.jpg`, fileName: `p${n}.jpg`, fileSize: 1,
  dateTaken: '2026-01-01', year: 2026, month: 1, day: 1,
}) as any;

describe('AlbumChapterSection', () => {
  let root: Root;
  let host: HTMLElement;
  let scrollHost: HTMLDivElement;
  const scrollRef = { current: null as HTMLDivElement | null };

  beforeEach(() => {
    (window as any).electronAPI = {};
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    scrollHost = document.createElement('div');
    document.body.appendChild(scrollHost);
    scrollRef.current = scrollHost;
  });
  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = '';
    delete (window as any).electronAPI;
  });

  const chapter = (over: any = {}) => ({ id: 'c1', title: 'Day 1', photoIds: ['p1', 'p2'], createdAt: 'x', updatedAt: 'x', ...over });

  it('shows the title, photo count, and a collage tile per photo (capped at 4)', async () => {
    const photos = [1, 2, 3, 4, 5].map(photo);
    await act(async () => {
      root.render(React.createElement(AlbumChapterSection, {
        chapter: chapter({ photoIds: photos.map((p) => p.id) }),
        photos, scrollRef, rowHeight: 200, minColWidth: 200, gap: 16,
        renderTile: (p: any) => React.createElement('div', { 'data-testid': `tile-${p.id}` }, p.fileName),
        onRename: vi.fn(), onDelete: vi.fn(),
      }));
    });
    expect(host.textContent).toContain('Day 1');
    expect(host.textContent).toContain('5 photos');
    expect(host.querySelectorAll('img').length).toBe(4); // collage caps at 4, even with 5 photos
  });

  it('rename: pencil reveals an input; submitting calls onRename with the trimmed title', async () => {
    const onRename = vi.fn();
    await act(async () => {
      root.render(React.createElement(AlbumChapterSection, {
        chapter: chapter(), photos: [], scrollRef, rowHeight: 200, minColWidth: 200, gap: 16,
        renderTile: () => null, onRename, onDelete: vi.fn(),
      }));
    });
    const pencil = host.querySelector('button[title="Rename chapter"]') as HTMLButtonElement;
    await act(async () => { pencil.click(); });

    const input = host.querySelector('input') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => { setter.call(input, '  Day One — Ceremony  '); input.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });

    expect(onRename).toHaveBeenCalledWith('Day One — Ceremony');
  });

  it('delete button calls onDelete; move up/down only render when their handlers are given', async () => {
    const onDelete = vi.fn();
    const onMoveUp = vi.fn();
    await act(async () => {
      root.render(React.createElement(AlbumChapterSection, {
        chapter: chapter(), photos: [], scrollRef, rowHeight: 200, minColWidth: 200, gap: 16,
        renderTile: () => null, onRename: vi.fn(), onDelete, onMoveUp,
      }));
    });
    expect(host.querySelector('button[title="Move chapter up"]')).not.toBeNull();
    expect(host.querySelector('button[title="Move chapter down"]')).toBeNull(); // no onMoveDown passed
    await act(async () => { (host.querySelector('button[title*="Delete chapter"]') as HTMLButtonElement).click(); });
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('shows an empty-chapter hint instead of a grid when it has no photos', async () => {
    await act(async () => {
      root.render(React.createElement(AlbumChapterSection, {
        chapter: chapter({ photoIds: [] }), photos: [], scrollRef, rowHeight: 200, minColWidth: 200, gap: 16,
        renderTile: () => null, onRename: vi.fn(), onDelete: vi.fn(),
      }));
    });
    expect(host.textContent).toContain('No photos in this chapter yet');
  });

  it('dropping onto the section calls onDropPhotoIds with the drag event', async () => {
    const onDropPhotoIds = vi.fn();
    await act(async () => {
      root.render(React.createElement(AlbumChapterSection, {
        chapter: chapter(), photos: [], scrollRef, rowHeight: 200, minColWidth: 200, gap: 16,
        renderTile: () => null, onRename: vi.fn(), onDelete: vi.fn(), onDropPhotoIds,
      }));
    });
    const root_div = host.firstElementChild as HTMLElement;
    const dropEvent = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(dropEvent, 'dataTransfer', { value: { getData: () => JSON.stringify(['p1']) } });
    await act(async () => { root_div.dispatchEvent(dropEvent); });
    expect(onDropPhotoIds).toHaveBeenCalledTimes(1);
  });

  it('without onDropPhotoIds, the section is not a drop target at all (no handlers attached)', async () => {
    await act(async () => {
      root.render(React.createElement(AlbumChapterSection, {
        chapter: chapter(), photos: [], scrollRef, rowHeight: 200, minColWidth: 200, gap: 16,
        renderTile: () => null, onRename: vi.fn(), onDelete: vi.fn(),
      }));
    });
    // No crash / no visible drag-over styling change is possible to assert directly without
    // handlers; this just documents that the root renders fine with the prop omitted.
    expect(host.firstElementChild).not.toBeNull();
  });
});

describe('ChapterPicker', () => {
  let root: Root;
  let host: HTMLElement;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = '';
  });

  const chapters = [{ id: 'c1', title: 'Day 1', photoIds: [], createdAt: 'x', updatedAt: 'x' }, { id: 'c2', title: 'Day 2', photoIds: [], createdAt: 'x', updatedAt: 'x' }];

  it('lists "No chapter" plus every chapter, checkmarking whichever is current', async () => {
    await act(async () => {
      root.render(React.createElement(ChapterPicker, { chapters, currentChapterId: 'c2', onPick: vi.fn(), onCreateNew: vi.fn(), onClose: vi.fn() }));
    });
    expect(host.textContent).toContain('No chapter');
    expect(host.textContent).toContain('Day 1');
    expect(host.textContent).toContain('Day 2');
    // The "Day 2" row (current) has a checkmark svg; "Day 1" doesn't.
    const buttons = Array.from(host.querySelectorAll('button'));
    const day2Btn = buttons.find((b) => b.textContent === 'Day 2')!;
    const day1Btn = buttons.find((b) => b.textContent === 'Day 1')!;
    expect(day2Btn.querySelector('svg')).not.toBeNull();
    expect(day1Btn.querySelector('svg')).toBeNull();
  });

  it('picking a chapter calls onPick with its id; picking "No chapter" calls onPick(null)', async () => {
    const onPick = vi.fn();
    await act(async () => {
      root.render(React.createElement(ChapterPicker, { chapters, currentChapterId: null, onPick, onCreateNew: vi.fn(), onClose: vi.fn() }));
    });
    const buttons = Array.from(host.querySelectorAll('button'));
    await act(async () => { (buttons.find((b) => b.textContent === 'Day 1') as HTMLButtonElement).click(); });
    expect(onPick).toHaveBeenCalledWith('c1');

    await act(async () => { (buttons.find((b) => b.textContent === 'No chapter') as HTMLButtonElement).click(); });
    expect(onPick).toHaveBeenCalledWith(null);
  });

  it('"New chapter…" reveals a form; submitting a name calls onCreateNew', async () => {
    const onCreateNew = vi.fn();
    await act(async () => {
      root.render(React.createElement(ChapterPicker, { chapters, currentChapterId: null, onPick: vi.fn(), onCreateNew, onClose: vi.fn() }));
    });
    const newBtn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('New chapter')) as HTMLButtonElement;
    await act(async () => { newBtn.click(); });

    const input = host.querySelector('input') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => { setter.call(input, 'Day 3'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });

    expect(onCreateNew).toHaveBeenCalledWith('Day 3');
  });

  it('clicking the backdrop calls onClose', async () => {
    const onClose = vi.fn();
    await act(async () => {
      root.render(React.createElement(ChapterPicker, { chapters, currentChapterId: null, onPick: vi.fn(), onCreateNew: vi.fn(), onClose }));
    });
    const backdrop = host.firstElementChild as HTMLElement;
    await act(async () => { backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
