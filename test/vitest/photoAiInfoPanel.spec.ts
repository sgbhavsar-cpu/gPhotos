// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PhotoContentEntry } from '../../src/types';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const flow = (id: string, name: string, description: string) => ({
  id, name, description, action: { type: 'album', albumName: 'x' }, consented: true, matches: {}, classifiedIds: {}, createdAt: 'x',
});

describe('PhotoAiInfoPanel', () => {
  let root: Root;
  let host: HTMLElement;
  let PhotoAiInfoPanel: any;
  let flows: any[];

  beforeEach(async () => {
    flows = [];
    vi.resetModules();
    vi.doMock('../../src/renderer/src/services/smartFlowsService', () => ({ listFlows: () => flows }));
    ({ PhotoAiInfoPanel } = await import('../../src/renderer/src/components/PhotoAiInfoPanel'));
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = '';
  });

  const entry = (over: Partial<PhotoContentEntry> = {}): PhotoContentEntry => ({
    caption: '', tags: [], embedding: null, verdicts: {}, updatedAt: 'x', ...over,
  });
  const mount = async (e: PhotoContentEntry) => { await act(async () => { root.render(React.createElement(PhotoAiInfoPanel, { entry: e })); }); };
  const tabButtons = () => Array.from(host.querySelectorAll('[role="tab"]'));
  const click = async (el: HTMLElement) => { await act(async () => { el.click(); }); };

  it('with a caption and tags but no matching flows, shows just an Overview — no tab bar needed', async () => {
    await mount(entry({ caption: 'A birthday cake', tags: ['cake', 'party'] }));
    expect(host.textContent).toContain('A birthday cake');
    expect(host.textContent).toContain('cake');
    expect(host.textContent).toContain('party');
    expect(tabButtons()).toHaveLength(0); // one section of content: no tabs to switch between
  });

  it('with nothing extracted yet, says so instead of an empty card', async () => {
    await mount(entry());
    expect(host.textContent).toContain('No caption or tags recorded yet.');
  });

  it('a photo with Smart Flow verdicts gets a second tab, closed by default, showing name/match/confidence', async () => {
    flows = [flow('f1', 'Screenshots', 'a screenshot'), flow('f2', 'Receipts', 'a receipt')];
    await mount(entry({
      caption: 'A phone screenshot',
      verdicts: { 'a screenshot': { match: true, confidence: 0.93 }, 'a receipt': { match: false, confidence: 0.6 } },
    }));
    expect(tabButtons().map((b) => b.textContent)).toEqual(['Overview', 'Smart Flows (2)']);
    expect(host.textContent).toContain('A phone screenshot'); // Overview is the default tab

    await click(tabButtons()[1] as HTMLElement);
    expect(host.textContent).toContain('Screenshots');
    expect(host.textContent).toContain('93%');
    expect(host.textContent).toContain('Receipts');
    expect(host.textContent).toContain('60%');
  });

  it('only flows this photo actually has a verdict for are listed — an unrelated flow is left out', async () => {
    flows = [flow('f1', 'Screenshots', 'a screenshot'), flow('f2', 'Never Checked This', 'something else entirely')];
    await mount(entry({ verdicts: { 'a screenshot': { match: true, confidence: 0.8 } } }));
    await click(tabButtons()[1] as HTMLElement);
    expect(host.textContent).toContain('Screenshots');
    expect(host.textContent).not.toContain('Never Checked This');
  });

  it('the description is normalized before matching against a flow (case/whitespace-insensitive), matching photoContentCache', async () => {
    flows = [flow('f1', 'Screenshots', '  A Screenshot  ')];
    await mount(entry({ verdicts: { 'a screenshot': { match: true, confidence: 0.5 } } }));
    expect(tabButtons()).toHaveLength(2);
  });
});
