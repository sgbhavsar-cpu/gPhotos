// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// A stand-in that exposes exactly what these tests need: one "select" button per photo, wired to
// the real onToggleSelect callback GalleryView passes down — everything else is the real component.
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

describe('GalleryView: "Run Smart Flow" on a selection', () => {
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
  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = '';
    delete (window as any).electronAPI;
  });

  const render = async (onRunSmartFlow?: any) => {
    await act(async () => {
      root.render(React.createElement(GalleryView, { photos, onSelectPhoto: vi.fn(), onToggleFavorite: vi.fn(), onOpenFolder: vi.fn(), onRunSmartFlow }));
    });
  };
  const select = async (id: string) => { await act(async () => { (host.querySelector(`[data-testid="select-${id}"]`) as HTMLElement).click(); }); };
  const runFlowButton = () => Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('Run Smart Flow')) as HTMLButtonElement | undefined;

  it('is not shown at all when the caller has no Smart Flows handler to offer', async () => {
    await render(undefined);
    await select('p1');
    expect(runFlowButton()).toBeUndefined();
  });

  it('appears once something is selected, disabled with nothing selected', async () => {
    const onRunSmartFlow = vi.fn();
    await render(onRunSmartFlow);
    await select('p1');
    const btn = runFlowButton()!;
    expect(btn).toBeTruthy();
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toContain('(1)');
  });

  it('clicking it hands back the actual selected Photo objects, not just ids', async () => {
    const onRunSmartFlow = vi.fn();
    await render(onRunSmartFlow);
    await select('p1');
    await select('p3');
    const btn = runFlowButton()!;
    expect(btn.textContent).toContain('(2)');
    await act(async () => { btn.click(); });
    expect(onRunSmartFlow).toHaveBeenCalledTimes(1);
    expect(onRunSmartFlow.mock.calls[0][0]).toEqual([photos[0], photos[2]]);
  });

  it('is disabled while in Select mode with nothing selected yet', async () => {
    const onRunSmartFlow = vi.fn();
    await render(onRunSmartFlow);
    const selectMode = Array.from(host.querySelectorAll('button')).find((b) => b.title === 'Select photos') as HTMLButtonElement;
    await act(async () => { selectMode.click(); });
    expect(runFlowButton()!.disabled).toBe(true);
  });
});
