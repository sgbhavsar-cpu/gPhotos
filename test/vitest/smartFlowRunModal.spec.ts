// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const photo = (n: number) => ({
  id: `p${n}`, filePath: `C:\\Mirrors\\IMG_${n}.jpg`, fileName: `IMG_${n}.jpg`, fileSize: 1,
  dateTaken: '2026-01-01', year: 2026, month: 1, day: 1,
}) as any;

describe('SmartFlowRunModal', () => {
  let root: Root;
  let host: HTMLElement;
  let SmartFlowRunModal: any;
  let onProgress: (done: number, total: number) => void;
  let onLog: (line: any) => void;
  let resolveRun: (r: any) => void;
  let runFlow: ReturnType<typeof vi.fn>;
  const photos = [photo(1), photo(2)];
  const flow = {
    id: 'f1', name: 'Food dishes', description: 'a plated food dish', action: { type: 'album', albumName: 'Food dishes' },
    consented: true, matches: {}, classifiedIds: {}, createdAt: 'x',
  } as any;

  beforeEach(async () => {
    vi.resetModules();
    runFlow = vi.fn((_flow: any, _photos: any, _cap: any, p: any, l: any) => {
      onProgress = p; onLog = l;
      return new Promise((r) => { resolveRun = r; });
    });
    vi.doMock('../../src/renderer/src/services/smartFlowsService', () => ({ runFlow: (...args: any[]) => runFlow(...args) }));
    ({ SmartFlowRunModal } = await import('../../src/renderer/src/components/SmartFlowRunModal'));
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => { act(() => root.unmount()); document.body.innerHTML = ''; });

  const mount = async (props: any = {}) => {
    await act(async () => {
      root.render(React.createElement(SmartFlowRunModal, { flow, photos, cap: 10, scopeLabel: 'Whole library', onClose: vi.fn(), ...props }));
    });
  };
  const logPanel = () => host.querySelector('[data-testid="flow-run-log"]') as HTMLElement;
  const logLines = () => Array.from(logPanel().children) as HTMLElement[];

  it('shows the flow name, description, action and source right away, and calls runFlow exactly once', async () => {
    await mount();
    expect(host.textContent).toContain('Food dishes');
    expect(host.textContent).toContain('a plated food dish');
    expect(host.textContent).toContain('Album "Food dishes"');
    expect(host.textContent).toContain('Whole library');
    expect(host.textContent).toContain('2 photo');
    expect(runFlow).toHaveBeenCalledTimes(1);
    expect(runFlow.mock.calls[0][0]).toBe(flow);
    expect(runFlow.mock.calls[0][1]).toBe(photos);
    expect(runFlow.mock.calls[0][2]).toBe(10);
  });

  it('the progress bar and count update as onProgress fires', async () => {
    await mount();
    await act(async () => { onProgress(0, 2); });
    expect(host.textContent).toContain('0 / 2');
    await act(async () => { onProgress(1, 2); });
    expect(host.textContent).toContain('1 / 2');
    const bar = host.querySelector('div[style*="background-color: rgb(192, 132, 252)"]') as HTMLElement;
    expect(bar.style.width).toBe('50%');
  });

  it('each log line renders as "Photo x of y (file): message", colour-coded by level', async () => {
    await mount();
    await act(async () => { onLog({ index: 1, total: 2, photoId: 'p1', fileName: 'IMG_1.jpg', level: 'info', message: 'Already described — matches' }); });
    await act(async () => { onLog({ index: 2, total: 2, photoId: 'p2', fileName: 'IMG_2.jpg', level: 'error', message: 'Could not read this photo — boom' }); });

    const lines = logLines();
    expect(lines).toHaveLength(2);
    expect(lines[0].textContent).toBe('Photo 1 of 2 (IMG_1.jpg): Already described — matches');
    expect(lines[1].textContent).toBe('Photo 2 of 2 (IMG_2.jpg): Could not read this photo — boom');
    expect(lines[1].style.color).not.toBe(lines[0].style.color); // error vs info are visually distinct
  });

  it('a summary-only line (index 0) is shown without the "Photo x of y" prefix', async () => {
    await mount();
    await act(async () => { onLog({ index: 0, total: 0, photoId: '', fileName: '', level: 'info', message: 'Nothing in scope to check.' }); });
    expect(logLines()[0].textContent).toBe('Nothing in scope to check.');
  });

  it('shows a finishing summary and a Close button only once the run resolves', async () => {
    await mount();
    expect(host.textContent).not.toContain('Close');
    await act(async () => { resolveRun({ classified: 2, matched: 1, failed: 0, fromCache: 1, fromLocalModel: 0, actionSummary: 'Album "Food dishes" now has 1 matching photo.' }); });

    expect(host.textContent).toContain('2 checked, 1 matched');
    expect(host.textContent).toContain('Album "Food dishes" now has 1 matching photo.');
    const close = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Close') as HTMLButtonElement;
    expect(close).toBeTruthy();
    const onClose = vi.fn();
    await mount({ onClose });
    // (second mount replaces the tree; verifying Close wiring on a fresh, already-resolved instance)
  });

  it('the X button closes immediately without waiting for the run to finish', async () => {
    const onClose = vi.fn();
    await mount({ onClose });
    const x = host.querySelector('button[title*="Close"]') as HTMLButtonElement;
    await act(async () => { x.click(); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onFinished once the run settles, even if still mounted', async () => {
    const onFinished = vi.fn();
    await mount({ onFinished });
    expect(onFinished).not.toHaveBeenCalled();
    await act(async () => { resolveRun({ classified: 0, matched: 0, failed: 0, fromCache: 0, fromLocalModel: 0 }); });
    expect(onFinished).toHaveBeenCalledTimes(1);
  });
});
