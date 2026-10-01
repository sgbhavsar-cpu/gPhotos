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
  id: `p${n}`, filePath: `C:\\p${n}.jpg`, fileName: `p${n}.jpg`, fileSize: 1,
  dateTaken: '2026-01-01', year: 2026, month: 1, day: 1,
}) as any;

describe('SmartFlowsModal: flows created in an earlier session actually show up', () => {
  let root: Root;
  let host: HTMLElement;
  let SmartFlowsModal: any;
  let flowsMod: any;
  const photos = [photo(1)];

  beforeEach(async () => {
    localStorage.clear();
    vi.resetModules();
    // The real service (not mocked) — the bug is specifically about listFlows()'s read TIMING
    // relative to isOpen, which a static mock would paper over.
    flowsMod = await import('../../src/renderer/src/services/smartFlowsService');
    ({ SmartFlowsModal } = await import('../../src/renderer/src/components/SmartFlowsModal'));
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => { act(() => root.unmount()); document.body.innerHTML = ''; });

  const render = async (isOpen: boolean) => {
    await act(async () => {
      root.render(React.createElement(SmartFlowsModal, { isOpen, onClose: vi.fn(), photos, albums: [] }));
    });
  };

  it('a flow saved to storage AFTER the (always-mounted) modal first rendered still appears the next time it is opened', async () => {
    // App.tsx mounts this modal once at startup, closed — exactly like the library not having
    // finished loading yet, so listFlows() (keyed by the library folder) reads an empty list.
    await render(false);
    expect(host.innerHTML).toBe(''); // isOpen=false renders nothing, but the useState initializer already ran

    // A flow now gets created — either from an earlier session (localStorage already had it once
    // the library finished loading) or from this one; either way, the modal's own React state was
    // never told about it yet.
    flowsMod.createFlow('Food dishes', 'a plated food dish', { type: 'album', albumName: 'Food dishes' });
    expect(flowsMod.listFlows()).toHaveLength(1); // sanity: storage really does have it now

    await render(true); // the user actually opens it from the sidebar (or the selection button)
    expect(host.textContent).toContain('Food dishes');
  });

  it('re-opening after closing picks up a flow created via a second entry point in between (sidebar vs. selection button share the same modal instance)', async () => {
    await render(true); // nothing created yet
    expect(host.textContent).toContain('No flows yet.');
    await render(false); // closed
    flowsMod.createFlow('Receipts', 'a receipt', { type: 'album', albumName: 'Receipts' });
    await render(true); // opened again (e.g. via the other entry point)
    expect(host.textContent).toContain('Receipts');
  });
});
