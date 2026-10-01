// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// The real timeline lays photos out with measured sizes; all this test needs from it is the list it was given.
vi.mock('../../src/renderer/src/components/VirtualizedTimelineGallery', () => ({
  ZOOM_LEVELS: ['years', 'months', 'very_small', 'small', 'medium', 'large'],
  VirtualizedTimelineGallery: (props: any) =>
    React.createElement('div', { 'data-testid': 'shown' }, props.photos.map((p: any) => p.id).join(',')),
}));

const photo = (n: number, extra: Record<string, any> = {}) => ({
  id: `p${n}`, filePath: `C:\\p${n}.jpg`, fileName: `p${n}.jpg`, fileSize: 1,
  dateTaken: '2026-01-01', year: 2026, month: 1, day: 1, ...extra,
}) as any;

describe('Gallery "No Album" filter', () => {
  let root: Root;
  let host: HTMLElement;
  let lib: any;
  let GalleryView: any;
  const photos = [photo(1), photo(2), photo(3), photo(4), photo(5, { isExcluded: true })];

  const render = async () => {
    await act(async () => {
      root.render(React.createElement(GalleryView, { photos, onSelectPhoto: vi.fn(), onToggleFavorite: vi.fn() }));
    });
  };
  const shown = () => host.querySelector('[data-testid="shown"]')?.textContent;
  const chip = () => host.querySelector('[data-testid="filter-no-album"]') as HTMLButtonElement;

  beforeEach(async () => {
    (window as any).electronAPI = { loadLibraryData: async () => null, saveLibraryData: async () => true };
    localStorage.clear();
    vi.resetModules();
    lib = (await import('../../src/renderer/src/services/libraryStore')).libraryStore;
    GalleryView = (await import('../../src/renderer/src/views/GalleryView')).GalleryView;
    lib.getState().albums = [];
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = '';
    delete (window as any).electronAPI;
  });

  it('shows only photos that are in no album (hidden photos stay hidden)', async () => {
    lib.getState().albums = [{ id: 'a1', title: 'Trip', photoIds: ['p1', 'p3'], createdAt: 'x', updatedAt: 'u1' }];
    await render();
    expect(shown()).toBe('p1,p2,p3,p4'); // "All": every visible photo

    await act(async () => { chip().click(); });

    expect(shown()).toBe('p2,p4'); // p1/p3 are in "Trip"; p5 is hidden
  });

  it('a photo in ANY album is excluded — including one only reachable through a chapter', async () => {
    lib.getState().albums = [
      { id: 'a1', title: 'Trip', photoIds: ['p1'], createdAt: 'x', updatedAt: 'u1' },
      { id: 'a2', title: 'Wedding', photoIds: ['p2', 'p4'], chapters: [{ id: 'c1', title: 'Day 1', photoIds: ['p4'], createdAt: 'x', updatedAt: 'x' }], createdAt: 'x', updatedAt: 'u2' },
    ];
    await render();
    await act(async () => { chip().click(); });
    expect(shown()).toBe('p3');
  });

  it('with no albums at all, every visible photo qualifies', async () => {
    await render();
    await act(async () => { chip().click(); });
    expect(shown()).toBe('p1,p2,p3,p4');
  });

  it('updates as photos are added to / removed from albums (albums are edited in place)', async () => {
    const album = lib.createAlbum('Trip');
    await render();
    await act(async () => { chip().click(); });
    expect(shown()).toBe('p1,p2,p3,p4');

    await act(async () => { lib.addPhotosToAlbum(album.id, ['p2']); });
    await render();
    expect(shown()).toBe('p1,p3,p4');

    await act(async () => { lib.removePhotosFromAlbum(album.id, ['p2']); });
    await render();
    expect(shown()).toBe('p1,p2,p3,p4');
  });

  it('All brings everything back', async () => {
    lib.getState().albums = [{ id: 'a1', title: 'Trip', photoIds: ['p1'], createdAt: 'x', updatedAt: 'u1' }];
    await render();
    await act(async () => { chip().click(); });
    expect(shown()).toBe('p2,p3,p4');
    const all = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'All') as HTMLButtonElement;
    await act(async () => { all.click(); });
    expect(shown()).toBe('p1,p2,p3,p4');
  });
});
