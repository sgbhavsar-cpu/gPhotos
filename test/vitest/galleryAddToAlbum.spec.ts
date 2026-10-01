// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../src/renderer/src/components/VirtualizedTimelineGallery', () => ({
  ZOOM_LEVELS: ['years', 'months', 'very_small', 'small', 'medium', 'large'],
  VirtualizedTimelineGallery: (props: any) =>
    React.createElement('div', { 'data-testid': 'shown' },
      props.photos.map((p: any) => React.createElement('button', {
        key: p.id, 'data-testid': `select-${p.id}`, onClick: () => props.onToggleSelect(p.id),
      }, p.id))),
}));

const photo = (n: number) => ({
  id: `p${n}`, filePath: `C:\\p${n}.jpg`, fileName: `p${n}.jpg`, fileSize: 1,
  dateTaken: '2026-01-01', year: 2026, month: 1, day: 1,
}) as any;

describe('GalleryView: Add to Album — pick the album, then which chapter', () => {
  let root: Root;
  let host: HTMLElement;
  let lib: any;
  let GalleryView: any;
  const photos = [photo(1), photo(2)];

  beforeEach(async () => {
    (window as any).electronAPI = { loadLibraryData: async () => null, saveLibraryData: async () => true };
    localStorage.clear();
    vi.resetModules();
    lib = (await import('../../src/renderer/src/services/libraryStore')).libraryStore;
    lib.getState().albums = [
      {
        id: 'a1', title: 'Goa Trip', photoIds: ['p1'], createdAt: 'x', updatedAt: 'x',
        chapters: [
          { id: 'c1', title: 'Beach Day', photoIds: ['p1'], createdAt: 'x', updatedAt: 'x' },
          { id: 'c2', title: 'Night Out', photoIds: [], createdAt: 'x', updatedAt: 'x' },
        ],
      },
      { id: 'a2', title: 'Wedding', photoIds: [], createdAt: 'x', updatedAt: 'x' }, // no chapters yet
    ];
    GalleryView = (await import('../../src/renderer/src/views/GalleryView')).GalleryView;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => { act(() => root.unmount()); document.body.innerHTML = ''; delete (window as any).electronAPI; });

  const render = async () => {
    await act(async () => {
      root.render(React.createElement(GalleryView, { photos, onSelectPhoto: vi.fn(), onToggleFavorite: vi.fn(), onOpenFolder: vi.fn() }));
    });
  };
  const select = async (id: string) => { await act(async () => { (host.querySelector(`[data-testid="select-${id}"]`) as HTMLElement).click(); }); };
  const openDialog = async () => {
    const btn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('Add to Album')) as HTMLButtonElement;
    await act(async () => { btn.click(); });
  };
  const pickerInput = () => host.querySelector('[data-testid="album-picker-input"]') as HTMLInputElement;
  const chapterInput = () => host.querySelector('[data-testid="chapter-select-input"]') as HTMLInputElement;
  const typeInto = async (input: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => { setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
  };
  const pressEnter = async (el: Element) => { await act(async () => { el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); }); };
  const pickAlbumCard = async (titleContains: string) => {
    const card = Array.from(host.querySelectorAll('[data-testid="album-picker-card"]')).find((c) => c.textContent?.includes(titleContains)) as HTMLElement;
    await act(async () => { card.click(); });
  };

  it('opening the dialog focuses the search box directly, listing every album with its cover and title', async () => {
    await render();
    await select('p1');
    await openDialog();
    expect(document.activeElement).toBe(pickerInput());
    const cards = Array.from(host.querySelectorAll('[data-testid="album-picker-card"]'));
    expect(cards.map((c) => c.textContent)).toEqual(expect.arrayContaining([expect.stringContaining('Goa Trip'), expect.stringContaining('Wedding')]));
  });

  it('picking an album moves to a chapter-selection step instead of adding right away', async () => {
    await render();
    await select('p2');
    await openDialog();
    await pickAlbumCard('Goa Trip');

    expect(lib.getState().albums.find((a: any) => a.id === 'a1').photoIds).not.toContain('p2'); // not added yet
    expect(chapterInput()).toBeTruthy();
    expect(host.textContent).toContain('Beach Day');
    expect(host.textContent).toContain('Night Out');
  });

  it('picking a specific chapter by typing + Enter adds the selection to it', async () => {
    await render();
    await select('p2');
    await openDialog();
    await pickAlbumCard('Goa Trip');
    await typeInto(chapterInput(), 'night');
    await pressEnter(chapterInput());

    expect(lib.getState().albums.find((a: any) => a.id === 'a1').chapters.find((c: any) => c.id === 'c2').photoIds).toEqual(['p2']);
    expect(lib.getState().albums.find((a: any) => a.id === 'a1').photoIds.sort()).toEqual(['p1', 'p2']); // album-level membership too
    expect(chapterInput()).toBeNull(); // dialog fully closed
    expect(host.textContent).toContain('Added 1 photo(s) to "Goa Trip" → "Night Out"');
  });

  it('pressing Enter with nothing typed adds to "Others", creating that chapter since the album has none named that', async () => {
    await render();
    await select('p2');
    await openDialog();
    await pickAlbumCard('Goa Trip');
    await pressEnter(chapterInput());

    const album = lib.getState().albums.find((a: any) => a.id === 'a1');
    const others = album.chapters.find((c: any) => c.title === 'Others');
    expect(others).toBeTruthy();
    expect(others.photoIds).toEqual(['p2']);
    expect(host.textContent).toContain('→ "Others"');
  });

  it('pressing Enter with nothing typed reuses an existing "Others" chapter instead of creating a duplicate', async () => {
    lib.getState().albums[0].chapters.push({ id: 'c3', title: 'Others', photoIds: ['p1'], createdAt: 'x', updatedAt: 'x' });
    await render();
    await select('p2');
    await openDialog();
    await pickAlbumCard('Goa Trip');
    await pressEnter(chapterInput());

    const album = lib.getState().albums.find((a: any) => a.id === 'a1');
    expect(album.chapters.filter((c: any) => c.title === 'Others')).toHaveLength(1);
    expect(album.chapters.find((c: any) => c.id === 'c3').photoIds.sort()).toEqual(['p1', 'p2']);
  });

  it('an album with no chapters yet still lands in "Others" on plain Enter', async () => {
    await render();
    await select('p1');
    await openDialog();
    await pickAlbumCard('Wedding');
    expect(host.textContent).toContain('no chapters yet'); // the empty-state hint
    await pressEnter(chapterInput());

    const album = lib.getState().albums.find((a: any) => a.id === 'a2');
    expect(album.chapters?.[0]?.title).toBe('Others');
    expect(album.chapters?.[0]?.photoIds).toEqual(['p1']);
  });

  it('typing a chapter name that matches nothing creates a new chapter and adds to it', async () => {
    await render();
    await select('p1');
    await openDialog();
    await pickAlbumCard('Goa Trip');
    await typeInto(chapterInput(), 'Sunset Drinks');
    await pressEnter(chapterInput());

    const album = lib.getState().albums.find((a: any) => a.id === 'a1');
    const created = album.chapters.find((c: any) => c.title === 'Sunset Drinks');
    expect(created).toBeTruthy();
    expect(created.photoIds).toEqual(['p1']);
  });

  it('clicking the pinned "Others" card works the same as pressing Enter with nothing typed', async () => {
    await render();
    await select('p2');
    await openDialog();
    await pickAlbumCard('Wedding');
    const othersCard = host.querySelector('[data-testid="chapter-select-others"]') as HTMLElement;
    await act(async () => { othersCard.click(); });

    const album = lib.getState().albums.find((a: any) => a.id === 'a2');
    expect(album.chapters?.[0]?.title).toBe('Others');
    expect(album.chapters?.[0]?.photoIds).toEqual(['p2']);
  });

  it('the Back button returns to album selection without adding anything', async () => {
    await render();
    await select('p2'); // not already in a1, unlike p1 (part of the beforeEach fixture)
    await openDialog();
    await pickAlbumCard('Goa Trip');
    const backBtn = host.querySelector('[title="Back to album selection"]') as HTMLElement;
    await act(async () => { backBtn.click(); });

    expect(pickerInput()).toBeTruthy(); // back on step 1
    expect(lib.getState().albums.find((a: any) => a.id === 'a1').photoIds).not.toContain('p2');
  });

  it('typing an album name that matches nothing creates a new album, then still asks which chapter', async () => {
    await render();
    await select('p1');
    await openDialog();
    await typeInto(pickerInput(), 'Summer Roadtrip');
    await pressEnter(pickerInput());

    expect(lib.getState().albums.find((a: any) => a.title === 'Summer Roadtrip')).toBeTruthy();
    expect(chapterInput()).toBeTruthy(); // step 2, not finished yet
    await pressEnter(chapterInput());

    const created = lib.getState().albums.find((a: any) => a.title === 'Summer Roadtrip');
    expect(created.chapters?.[0]?.title).toBe('Others');
    expect(created.photoIds).toEqual(['p1']);
  });
});
