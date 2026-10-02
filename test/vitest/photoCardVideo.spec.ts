// @vitest-environment jsdom
// PhotoCard's video badge + hover-preview behavior (docs/FEATURE_VIDEO_LIBRARY_SUPPORT.md §2.5).
import { describe, it, expect, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// Same stub existing PhotoCard-adjacent tests (dragSelect.spec.ts) use — thumbnail loading itself
// is irrelevant here, only the video-specific badge/hover logic is under test.
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

const videoPhoto: Photo = {
  id: 'v1', filePath: 'C:\\Videos\\clip.mp4', fileName: 'clip.mp4', fileSize: 1,
  dateTaken: '2026-01-01', year: 2026, month: 1, day: 1, isVideo: true, videoDurationSec: 125,
} as Photo;

describe('PhotoCard: video badge and hover preview', () => {
  let root: Root;
  let host: HTMLElement;
  let getVideoPreview: ReturnType<typeof vi.fn>;

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = '';
    delete (window as any).electronAPI;
    vi.useRealTimers();
  });

  const mount = async (photo: Photo) => {
    getVideoPreview = vi.fn().mockResolvedValue({ path: 'C:\\cache\\preview.mp4' });
    (window as any).electronAPI = { getVideoPreview };
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(PhotoCard, { photo, onClick: () => {}, onToggleFavorite: () => {} }));
    });
  };

  it('shows an always-visible play badge with the formatted duration (2:05) for a video', async () => {
    await mount(videoPhoto);
    expect(host.textContent).toContain('2:05');
    expect(host.querySelector('[title="Video"]')).not.toBeNull();
  });

  it('shows no video badge for a plain photo', async () => {
    await mount({ ...videoPhoto, isVideo: undefined, videoDurationSec: undefined } as Photo);
    expect(host.querySelector('[title="Video"]')).toBeNull();
  });

  it('hovering a video tile for 2s plays a preview clip inline', async () => {
    vi.useFakeTimers();
    await mount(videoPhoto);
    const card = host.querySelector('[data-photo-id="v1"]') as HTMLElement;

    await act(async () => { card.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); });
    expect(host.querySelector('video')).toBeNull(); // not yet — the 2s delay hasn't elapsed

    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });

    expect(getVideoPreview).toHaveBeenCalledWith('C:\\Videos\\clip.mp4', undefined);
    expect(host.querySelector('video')).not.toBeNull();
  });

  it('moving the mouse away before 2s never shows a preview, and never even asks for one', async () => {
    vi.useFakeTimers();
    await mount(videoPhoto);
    const card = host.querySelector('[data-photo-id="v1"]') as HTMLElement;

    await act(async () => { card.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); });
    await act(async () => { vi.advanceTimersByTime(1000); }); // still within the 2s window
    await act(async () => { card.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });

    expect(getVideoPreview).not.toHaveBeenCalled();
    expect(host.querySelector('video')).toBeNull();
  });

  it('leaving right after a preview appeared reverts to the static thumbnail', async () => {
    vi.useFakeTimers();
    await mount(videoPhoto);
    const card = host.querySelector('[data-photo-id="v1"]') as HTMLElement;

    await act(async () => { card.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(host.querySelector('video')).not.toBeNull();

    await act(async () => { card.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })); });
    expect(host.querySelector('video')).toBeNull();
  });
});
