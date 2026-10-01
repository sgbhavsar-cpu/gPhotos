// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../src/renderer/src/components/VirtualizedTimelineGallery', () => ({
  ZOOM_LEVELS: ['years', 'months', 'very_small', 'small', 'medium', 'large'],
  VirtualizedTimelineGallery: (props: any) => React.createElement('div', { 'data-testid': 'shown' }, props.photos.map((p: any) => p.id).join(',')),
}));

const photo = (n: number) => ({
  id: `p${n}`, filePath: `C:\\p${n}.jpg`, fileName: `p${n}.jpg`, fileSize: 1,
  dateTaken: '2026-01-01', year: 2026, month: 1, day: 1,
}) as any;

describe('GalleryView header: library name instead of "Timeline (count)"', () => {
  let root: Root;
  let host: HTMLElement;
  let GalleryView: any;
  const photos = [photo(1), photo(2), photo(3)];

  beforeEach(async () => {
    (window as any).electronAPI = { loadLibraryData: async () => null, saveLibraryData: async () => true };
    localStorage.clear();
    vi.resetModules();
    (await import('../../src/renderer/src/services/libraryStore')).libraryStore.getState().albums = [];
    GalleryView = (await import('../../src/renderer/src/views/GalleryView')).GalleryView;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => { act(() => root.unmount()); document.body.innerHTML = ''; delete (window as any).electronAPI; });

  const render = async (props: any = {}) => {
    await act(async () => {
      root.render(React.createElement(GalleryView, { photos, onSelectPhoto: vi.fn(), onToggleFavorite: vi.fn(), onOpenFolder: vi.fn(), ...props }));
    });
  };

  it('shows the library\'s folder name (last path segment) instead of "Timeline", with no photo count next to it', async () => {
    await render({ libraryFolder: 'C:\\Users\\sac\\Photos\\Goa Trip 2026' });
    expect(host.textContent).toContain('Goa Trip 2026');
    expect(host.textContent).not.toContain('Timeline');
    expect(host.textContent).not.toMatch(/\(\d+\)/); // no "(3)" style count right after the title
  });

  it('works with a forward-slash path too', async () => {
    await render({ libraryFolder: '/home/sac/Photos/Goa Trip' });
    expect(host.textContent).toContain('Goa Trip');
  });

  it('falls back to "Library" when no folder is known yet', async () => {
    await render({ libraryFolder: null });
    expect(host.textContent).toContain('Library');
  });

  it('the Favorites view keeps its own "Favorite Photos" label instead of the library name', async () => {
    await render({ libraryFolder: 'C:\\Photos\\Goa Trip', filterFavorite: true });
    expect(host.textContent).toContain('Favorite Photos');
    expect(host.textContent).not.toContain('Goa Trip');
  });
});
