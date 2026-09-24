// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import {
  VirtualizedTimelineGallery,
  ZOOM_LEVELS,
  type GalleryZoomLevel,
} from '../../src/renderer/src/components/VirtualizedTimelineGallery';

// Regression: clicking "Years" in the Photos toolbar crashed the whole app
// (React error #300, "Rendered fewer hooks than expected") because a useMemo
// sat after the 'years'/'months'/empty-list early returns. Any zoom change or
// empty<->non-empty change re-renders with a different hook count.
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const photo = (i: number): any => ({
  id: `p${i}`, filePath: `C:\\p\\${i}.jpg`, fileName: `${i}.jpg`, fileSize: 1,
  dateTaken: new Date(2020 + (i % 5), i % 12, 1 + (i % 27)).toISOString(),
  year: 2020 + (i % 5), month: (i % 12) + 1, day: 1 + (i % 27), faces: [],
});

describe('VirtualizedTimelineGallery keeps a stable hook count across zoom levels', () => {
  const render = (root: ReturnType<typeof createRoot>, photos: any[], zoomLevel: GalleryZoomLevel) =>
    act(() => {
      root.render(
        React.createElement(VirtualizedTimelineGallery, {
          photos, zoomLevel, onZoomChange: () => {}, onSelectPhoto: () => {}, onToggleFavorite: () => {},
        } as any)
      );
    });

  it('can switch between every zoom level, including Years and Months, without throwing', () => {
    const root = createRoot(document.createElement('div'));
    const photos = Array.from({ length: 200 }, (_, i) => photo(i));
    render(root, photos, 'medium');
    for (const level of [...ZOOM_LEVELS, 'medium' as GalleryZoomLevel, 'years' as GalleryZoomLevel, 'large' as GalleryZoomLevel]) {
      expect(() => render(root, photos, level)).not.toThrow();
    }
    act(() => root.unmount());
  });

  it('survives the photo list going empty and coming back', () => {
    const root = createRoot(document.createElement('div'));
    const photos = Array.from({ length: 50 }, (_, i) => photo(i));
    render(root, photos, 'medium');
    expect(() => render(root, [], 'medium')).not.toThrow();
    expect(() => render(root, photos, 'medium')).not.toThrow();
    expect(() => render(root, photos, 'years')).not.toThrow();
    act(() => root.unmount());
  });
});
