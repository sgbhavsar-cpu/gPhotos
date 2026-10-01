// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Sidebar } from '../../src/renderer/src/components/Sidebar';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('Sidebar: "Clean Duplicates" and "Search with AI" removed (now only in the Photos toolbar)', () => {
  let root: Root;
  let host: HTMLElement;
  const state = {
    photos: [{ id: 'p1' }, { id: 'p2' }] as any,
    people: [], places: [], albums: [], totalCount: 2, isDetectingFaces: false, faceDetectionProgress: null,
  } as any;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => { act(() => root.unmount()); document.body.innerHTML = ''; });

  it('no longer offers those two buttons, but Smart Flows and every nav tab remain', async () => {
    await act(async () => {
      root.render(React.createElement(Sidebar, {
        activeTab: 'photos', onSelectTab: vi.fn(), state, onOpenFolder: vi.fn(), onTriggerFaceDetection: vi.fn(),
        onOpenSmartFlows: vi.fn(),
      }));
    });
    expect(host.textContent).not.toContain('Clean Duplicates');
    expect(host.textContent).not.toContain('Search with AI');
    expect(host.textContent).toContain('Smart Flows');
    for (const tab of ['Photos', 'Albums', 'People', 'Places', 'Favorites', 'Settings']) {
      expect(host.textContent).toContain(tab);
    }
  });

  it('does not require the removed callback props at all (no crash without them)', async () => {
    await act(async () => {
      root.render(React.createElement(Sidebar, { activeTab: 'photos', onSelectTab: vi.fn(), state, onOpenFolder: vi.fn(), onTriggerFaceDetection: vi.fn() }));
    });
    expect(host.querySelector('aside')).toBeTruthy();
  });
});
