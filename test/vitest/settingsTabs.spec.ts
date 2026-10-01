// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SettingsView } from '../../src/renderer/src/views/SettingsView';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('SettingsView: tabbed page', () => {
  let root: Root;
  let host: HTMLElement;

  beforeEach(() => {
    (window as any).electronAPI = { triggerBackgroundServiceSync: vi.fn(async () => {}) }; // everything else is optional-chained
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = '';
    delete (window as any).electronAPI;
  });

  const mount = async () => { await act(async () => { root.render(React.createElement(SettingsView, {})); }); };
  const tab = (label: string) => Array.from(host.querySelectorAll('[role="tab"]')).find((b) => b.textContent === label) as HTMLButtonElement;
  const click = async (el: HTMLElement) => { await act(async () => { el.click(); }); };

  it('shows one top tab bar with all six sections, "General" active by default', async () => {
    await mount();
    const labels = ['General', 'Mobile & Sharing', 'Search with AI', 'Duplicates', 'Backup', 'Logs'];
    for (const l of labels) expect(tab(l)).toBeTruthy();
    expect(tab('General').getAttribute('aria-selected')).toBe('true');
    expect(host.textContent).toContain('Background Synchronization Engine');
    expect(host.textContent).not.toContain('Mobile Access');
  });

  it('only the active tab\'s content is in the DOM, and switching tabs swaps it', async () => {
    await mount();
    expect(host.textContent).not.toContain('Local Web Server');

    await click(tab('Mobile & Sharing'));
    expect(tab('Mobile & Sharing').getAttribute('aria-selected')).toBe('true');
    expect(tab('General').getAttribute('aria-selected')).toBe('false');
    expect(host.textContent).toContain('Local Web Server');
    expect(host.textContent).not.toContain('Background Synchronization Engine');

    await click(tab('Search with AI'));
    expect(host.textContent).toContain('AI Photo Search & LLM Configuration');
    expect(host.textContent).toContain('Local AI Model');
    expect(host.textContent).not.toContain('Local Web Server');

    await click(tab('Duplicates'));
    expect(host.textContent).toContain('Burst Cleaner');

    await click(tab('Backup'));
    expect(host.textContent).toContain('Library Data Backup');

    await click(tab('Logs'));
    expect(host.textContent).toContain('Activity Logs');
  });

  it('a General-tab action (e.g. a feedback message) still shows even after switching tabs', async () => {
    // The autosync feedback banner sits above the tab content and isn't tied to any one tab, so it must
    // survive a tab switch instead of only being visible while "General" happens to be active.
    await mount();
    const runNow = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('Run Sync Cycle Now')) as HTMLButtonElement;
    await click(runNow);
    expect(host.textContent).toContain('Background synchronization cycle triggered.');
    await click(tab('Backup'));
    expect(host.textContent).toContain('Background synchronization cycle triggered.');
  });
});
