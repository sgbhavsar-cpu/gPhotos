// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../src/renderer/src/services/ollamaVisionService', () => ({ isVisionAvailable: vi.fn(async () => false) }));
vi.mock('../../src/renderer/src/services/aiSearchService', () => ({
  aiSearchService: {
    getConfig: () => ({ provider: 'gemini', geminiApiKey: 'k', openaiApiKey: '' }),
    getSmartFlowsConfig: () => ({ provider: 'gemini', geminiApiKey: 'k', openaiApiKey: '' }),
  },
}));

const photo = (n: number) => ({
  id: `p${n}`, filePath: `C:\\Mirrors\\IMG_${n}.jpg`, fileName: `IMG_${n}.jpg`, fileSize: 1,
  dateTaken: '2026-01-01', year: 2026, month: 1, day: 1,
}) as any;

describe('SmartFlowsModal: running a flow against just one album', () => {
  let root: Root;
  let host: HTMLElement;
  let SmartFlowsModal: any;
  let runFlow: ReturnType<typeof vi.fn>;
  const photos = [1, 2, 3, 4].map(photo);
  const albums = [
    { id: 'a1', title: 'Goa Trip', photoIds: ['p1', 'p3'], createdAt: 'x', updatedAt: 'x' },
    { id: 'a2', title: 'Empty Album', photoIds: [], createdAt: 'x', updatedAt: 'x' },
  ];
  let flow: any;

  beforeEach(async () => {
    vi.resetModules();
    runFlow = vi.fn(async () => ({ classified: 0, matched: 0, failed: 0, fromCache: 0, fromLocalModel: 0 }));
    flow = {
      id: 'f1', name: 'Screenshots', description: 'a screenshot', action: { type: 'album', albumName: 'Screens' },
      consented: true, matches: {}, classifiedIds: {}, createdAt: 'x',
    };
    vi.doMock('../../src/renderer/src/services/smartFlowsService', () => ({
      listFlows: () => [flow],
      createFlow: vi.fn(),
      deleteFlow: vi.fn(),
      setFlowConsent: vi.fn(),
      runFlow: (...args: any[]) => runFlow(...args),
    }));
    ({ SmartFlowsModal } = await import('../../src/renderer/src/components/SmartFlowsModal'));
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = '';
  });

  const mount = async () => {
    await act(async () => {
      root.render(React.createElement(SmartFlowsModal, { isOpen: true, onClose: vi.fn(), photos, albums }));
    });
  };
  const btn = (t: string) => Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes(t)) as HTMLButtonElement;
  const scopeSelect = () => host.querySelector('[aria-label="Run flows against"]') as HTMLSelectElement;
  const setSelect = async (el: HTMLSelectElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
    await act(async () => { setter.call(el, value); el.dispatchEvent(new Event('change', { bubbles: true })); });
  };
  const runViaCapPrompt = async () => {
    await act(async () => { btn('Run now').click(); });
    const runSubmit = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Run') as HTMLButtonElement;
    await act(async () => { runSubmit.click(); });
  };

  it('offers a scope picker listing the whole library and every album, defaulting to the whole library', async () => {
    await mount();
    const opts = Array.from(scopeSelect().options).map((o) => o.textContent);
    expect(opts).toEqual(['Whole library (4)', 'Goa Trip (2)', 'Empty Album (0)']);
    expect(scopeSelect().value).toBe('all');
  });

  it('defaults to sending every photo when the scope is "whole library"', async () => {
    await mount();
    await runViaCapPrompt();
    expect(runFlow).toHaveBeenCalledTimes(1);
    expect(runFlow.mock.calls[0][1].map((p: any) => p.id)).toEqual(['p1', 'p2', 'p3', 'p4']);
  });

  it('picking an album scopes the run to just that album\'s photos', async () => {
    await mount();
    await setSelect(scopeSelect(), 'a1');
    await runViaCapPrompt();
    expect(runFlow.mock.calls[0][1].map((p: any) => p.id)).toEqual(['p1', 'p3']);
  });

  it('the cap prompt mentions the album name and counts only that album\'s not-yet-checked photos', async () => {
    flow.classifiedIds = { p1: true }; // already checked, so only p3 should count as "left" for Goa Trip
    await mount();
    await setSelect(scopeSelect(), 'a1');
    await act(async () => { btn('Run now').click(); });
    expect(host.textContent).toContain('in "Goa Trip"');
    expect(host.textContent).toContain('(1 left)');
  });

  it('an album with no matching photos sends nothing', async () => {
    await mount();
    await setSelect(scopeSelect(), 'a2');
    await runViaCapPrompt();
    expect(runFlow.mock.calls[0][1]).toEqual([]);
  });

  it('with no albums in the library the scope picker is not shown at all', async () => {
    await act(async () => { root.render(React.createElement(SmartFlowsModal, { isOpen: true, onClose: vi.fn(), photos, albums: [] })); });
    expect(scopeSelect()).toBeNull();
    await runViaCapPrompt();
    expect(runFlow.mock.calls[0][1]).toEqual(photos);
  });
});

describe('SmartFlowsModal: opened from a "Run Smart Flow" button on a selection', () => {
  let root: Root;
  let host: HTMLElement;
  let SmartFlowsModal: any;
  let runFlow: ReturnType<typeof vi.fn>;
  const photos = [1, 2, 3, 4].map(photo);
  const albums = [{ id: 'a1', title: 'Goa Trip', photoIds: ['p1', 'p2'], createdAt: 'x', updatedAt: 'x' }];
  let flow: any;

  beforeEach(async () => {
    vi.resetModules();
    runFlow = vi.fn(async () => ({ classified: 0, matched: 0, failed: 0, fromCache: 0, fromLocalModel: 0 }));
    flow = { id: 'f1', name: 'Screenshots', description: 'a screenshot', action: { type: 'album', albumName: 'Screens' }, consented: true, matches: {}, classifiedIds: {}, createdAt: 'x' };
    vi.doMock('../../src/renderer/src/services/smartFlowsService', () => ({
      listFlows: () => [flow], createFlow: vi.fn(), deleteFlow: vi.fn(), setFlowConsent: vi.fn(),
      runFlow: (...args: any[]) => runFlow(...args),
    }));
    ({ SmartFlowsModal } = await import('../../src/renderer/src/components/SmartFlowsModal'));
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => { act(() => root.unmount()); document.body.innerHTML = ''; });

  const mount = async (preselectedPhotos?: any[]) => {
    await act(async () => { root.render(React.createElement(SmartFlowsModal, { isOpen: true, onClose: vi.fn(), photos, albums, preselectedPhotos })); });
  };
  const btn = (t: string) => Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes(t)) as HTMLButtonElement;
  const scopeSelect = () => host.querySelector('[aria-label="Run flows against"]') as HTMLSelectElement;
  const runViaCapPrompt = async () => {
    await act(async () => { btn('Run now').click(); });
    const runSubmit = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Run') as HTMLButtonElement;
    await act(async () => { runSubmit.click(); });
  };

  it('defaults the scope to "Selected photos" and lists it first, ahead of the whole library and any album', async () => {
    await mount([photos[1], photos[3]]); // p2, p4
    expect(scopeSelect().value).toBe('selection');
    const opts = Array.from(scopeSelect().options).map((o) => o.textContent);
    expect(opts).toEqual(['Selected photos (2)', 'Whole library (4)', 'Goa Trip (2)']);
  });

  it('running with the default scope checks only the selected photos', async () => {
    await mount([photos[1], photos[3]]);
    await runViaCapPrompt();
    expect(runFlow.mock.calls[0][1].map((p: any) => p.id)).toEqual(['p2', 'p4']);
  });

  it('can still be switched to the whole library or an album instead', async () => {
    await mount([photos[1], photos[3]]);
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
    await act(async () => { setter.call(scopeSelect(), 'all'); scopeSelect().dispatchEvent(new Event('change', { bubbles: true })); });
    await runViaCapPrompt();
    expect(runFlow.mock.calls[0][1].map((p: any) => p.id)).toEqual(['p1', 'p2', 'p3', 'p4']);
  });

  it('with no selection passed, the picker still offers the whole library and albums, defaulting to whole library', async () => {
    await mount(undefined);
    expect(scopeSelect().value).toBe('all');
    expect(Array.from(scopeSelect().options).map((o) => o.textContent)).toEqual(['Whole library (4)', 'Goa Trip (2)']);
  });

  it('the cap prompt mentions "your selection"', async () => {
    await mount([photos[0]]);
    await act(async () => { btn('Run now').click(); });
    expect(host.textContent).toContain('in your selection');
  });
});

describe('SmartFlowsModal: Run works without a cloud provider configured (the reported bug)', () => {
  let root: Root;
  let host: HTMLElement;
  let SmartFlowsModal: any;
  let runFlow: ReturnType<typeof vi.fn>;
  let resolveRun: (r: any) => void;
  const photos = [1, 2].map(photo);
  let flowA: any;
  let flowB: any;

  beforeEach(async () => {
    vi.resetModules();
    runFlow = vi.fn(() => new Promise((r) => { resolveRun = r; }));
    flowA = { id: 'fa', name: 'Food dishes', description: 'a plated food dish', action: { type: 'album', albumName: 'Food dishes' }, consented: true, matches: {}, classifiedIds: {}, createdAt: 'x' };
    flowB = { id: 'fb', name: 'Receipts', description: 'a receipt', action: { type: 'album', albumName: 'Receipts' }, consented: true, matches: {}, classifiedIds: {}, createdAt: 'x' };
    vi.doMock('../../src/renderer/src/services/smartFlowsService', () => ({
      listFlows: () => [flowA, flowB],
      createFlow: vi.fn(), deleteFlow: vi.fn(), setFlowConsent: vi.fn(),
      runFlow: (...args: any[]) => runFlow(...args),
    }));
    // Override this file's top-level "a key is set" mock — this describe is specifically about the
    // case where NEITHER a cloud key NOR Ollama is configured.
    vi.doMock('../../src/renderer/src/services/aiSearchService', () => ({
      aiSearchService: {
        getConfig: () => ({ provider: 'gemini', geminiApiKey: '', openaiApiKey: '' }),
        getSmartFlowsConfig: () => ({ provider: 'gemini', geminiApiKey: '', openaiApiKey: '' }),
      },
    }));
    vi.doMock('../../src/renderer/src/services/ollamaVisionService', () => ({ isVisionAvailable: vi.fn(async () => false) }));
    ({ SmartFlowsModal } = await import('../../src/renderer/src/components/SmartFlowsModal'));
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => { act(() => root.unmount()); document.body.innerHTML = ''; });

  const mount = async () => { await act(async () => { root.render(React.createElement(SmartFlowsModal, { isOpen: true, onClose: vi.fn(), photos, albums: [] })); }); };
  const btn = (t: string) => Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes(t)) as HTMLButtonElement;
  const runButtons = () => Array.from(host.querySelectorAll('button')).filter((b) => b.textContent === 'Run now' || b.textContent === 'Running...');

  it('the info banner is shown, but Run is enabled anyway — it used to be disabled until a cloud key was set', async () => {
    await mount();
    expect(host.textContent).toContain('No Gemini/OpenAI API key is set');
    expect(host.textContent).not.toContain("can't run yet"); // old, incorrect wording
    expect(runButtons().every((b) => !b.disabled)).toBe(true);
  });

  it('Run now opens a run modal with the flow\'s own name/description/action and a live log panel', async () => {
    await mount();
    await act(async () => { runButtons()[0].click(); });
    const runSubmit = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Run') as HTMLButtonElement;
    await act(async () => { runSubmit.click(); });

    expect(host.textContent).toContain('Food dishes');
    expect(host.textContent).toContain('a plated food dish');
    expect(host.textContent).toContain('Album "Food dishes"');
    expect(host.querySelector('[data-testid="flow-run-log"]')).not.toBeNull();
    resolveRun({ classified: 0, matched: 0, failed: 0, fromCache: 0, fromLocalModel: 0 });
    await act(async () => { await Promise.resolve(); });
  });

  it('while one flow is running, every flow\'s Run button is disabled (only one run at a time)', async () => {
    await mount();
    await act(async () => { btn('Run now').click(); });
    const runSubmit = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Run') as HTMLButtonElement;
    await act(async () => { runSubmit.click(); });

    const buttons = runButtons();
    expect(buttons).toHaveLength(2);
    expect(buttons[0].textContent).toBe('Running...');
    expect(buttons[0].disabled).toBe(true);
    expect(buttons[1].textContent).toBe('Run now');
    expect(buttons[1].disabled).toBe(true); // the other flow can't be started mid-run either

    resolveRun({ classified: 0, matched: 0, failed: 0, fromCache: 0, fromLocalModel: 0 });
    await act(async () => { await Promise.resolve(); });
  });

  it('closing the run modal re-enables the buttons', async () => {
    await mount();
    await act(async () => { btn('Run now').click(); });
    const runSubmit = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Run') as HTMLButtonElement;
    await act(async () => { runSubmit.click(); });
    resolveRun({ classified: 1, matched: 1, failed: 0, fromCache: 1, fromLocalModel: 0 });
    await act(async () => { await Promise.resolve(); });

    const closeBtn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Close') as HTMLButtonElement;
    await act(async () => { closeBtn.click(); });
    expect(runButtons().every((b) => !b.disabled)).toBe(true);
  });
});
