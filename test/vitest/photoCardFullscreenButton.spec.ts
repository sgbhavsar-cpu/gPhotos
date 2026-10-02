// @vitest-environment jsdom
// "View full screen" button that stays reachable while a selection is active — see the gallery
// selection-mode UX fix (clicking a photo tile toggles selection instead of opening the lightbox
// once anything is selected; this button is the escape hatch).
import { describe, it, expect, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../../src/renderer/src/services/asyncImageLoader', () => ({
  requestBatchThumbnails: vi.fn(),
  useBatchThumbnail: () => ({ src: null, isLoading: false, hasError: false }),
  useSpriteCoordinate: () => null,
  getSpriteUrl: () => '',
  batchThumbnailStore: new Map(),
  evictAndRefreshThumbnail: vi.fn(),
}));

import { PhotoCard } from '../../src/renderer/src/components/PhotoCard';
import type { Photo } from '../../src/types';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const photo: Photo = {
  id: 'p1', filePath: 'C:\\Photos\\p1.jpg', fileName: 'p1.jpg', fileSize: 1,
  dateTaken: '2026-01-01', year: 2026, month: 1, day: 1, isFavorite: false,
} as Photo;

describe('PhotoCard: full-screen button during selection', () => {
  let root: Root;
  let host: HTMLElement;

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = '';
  });

  const mount = async (props: Partial<React.ComponentProps<typeof PhotoCard>> = {}) => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const onClick = vi.fn();
    const onToggleSelect = vi.fn();
    const onOpenFullscreen = vi.fn();
    await act(async () => {
      root.render(React.createElement(PhotoCard, {
        photo, onClick, onToggleFavorite: () => {}, onToggleSelect, onOpenFullscreen, ...props,
      }));
    });
    return { onClick, onToggleSelect, onOpenFullscreen };
  };

  it('is not shown for a plain, unselected tile (nothing to escape from)', async () => {
    await mount();
    expect(host.querySelector('[title="View full screen"]')).toBeNull();
  });

  it('appears once the tile is selected, and clicking it opens the lightbox without toggling selection', async () => {
    const { onOpenFullscreen, onToggleSelect, onClick } = await mount({ isSelected: true });
    const btn = host.querySelector('[title="View full screen"]') as HTMLElement;
    expect(btn).not.toBeNull();

    await act(async () => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    expect(onOpenFullscreen).toHaveBeenCalledTimes(1);
    expect(onToggleSelect).not.toHaveBeenCalled();
    expect(onClick).not.toHaveBeenCalled();
  });

  it('also appears in select mode even for an unselected tile', async () => {
    await mount({ isSelectMode: true, isSelected: false });
    expect(host.querySelector('[title="View full screen"]')).not.toBeNull();
  });
});
