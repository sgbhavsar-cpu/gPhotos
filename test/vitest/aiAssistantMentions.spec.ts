// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AiAssistantModal } from '../../src/renderer/src/components/AiAssistantModal';
import { recordFinding, resetForTests as resetPhotoContentCache } from '../../src/renderer/src/services/photoContentCache';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const person = (id: string, name: string) => ({ id, name, faceCount: 1, photoCount: 1, createdAt: 'x' }) as any;
const place = (id: string, name: string) => ({ id, name, latitude: 0, longitude: 0, photoCount: 1, coverPhotoId: 'p1' }) as any;

describe('AiAssistantModal: @person / #place mention autocomplete', () => {
  let root: Root;
  let host: HTMLElement;
  const people = [person('u1', 'Sachin Bhavsar'), person('u2', 'Bhavsar Tarun'), person('u3', 'Person 7')];
  const places = [place('l1', 'Udaipur'), place('l2', 'Andaman')];

  beforeEach(() => {
    (window as any).electronAPI = { loadLibraryData: async () => null, saveLibraryData: async () => true };
    Element.prototype.scrollIntoView = vi.fn(); // jsdom has no layout engine, so this is never implemented
    localStorage.clear();
    resetPhotoContentCache();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = '';
    delete (window as any).electronAPI;
  });

  const mount = async () => {
    await act(async () => {
      root.render(React.createElement(AiAssistantModal, { isOpen: true, onClose: vi.fn(), onApplyFilter: vi.fn(), photos: [], people, places }));
    });
  };
  const searchInput = () => host.querySelector('input[placeholder*="Ask AI"]') as HTMLInputElement;
  const options = () => Array.from(host.querySelectorAll('[data-testid="mention-option"]')) as HTMLButtonElement[];
  const type = async (text: string) => {
    const el = searchInput();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => { setter.call(el, text); el.setSelectionRange(text.length, text.length); el.dispatchEvent(new Event('input', { bubbles: true })); });
  };

  it('"@" lists real people, filtered by "contains", with auto-generated "Person N" placeholders left out', async () => {
    await mount();
    await type('@bhav');
    expect(options().map((o) => o.textContent)).toEqual(['Bhavsar Tarun', 'Sachin Bhavsar']);
    expect(host.textContent).not.toContain('Person 7');
  });

  it('"#" lists places', async () => {
    await mount();
    await type('#u');
    expect(options().map((o) => o.textContent)).toEqual(['Udaipur']);
  });

  it('picking a person inserts their plain name into the search box', async () => {
    await mount();
    await type('Find photos of @tarun');
    await act(async () => { options()[0].click(); });
    expect(searchInput().value).toBe('Find photos of Bhavsar Tarun ');
  });

  it('with no places passed at all, "#" still opens with an empty-state message instead of erroring', async () => {
    await act(async () => {
      root.render(React.createElement(AiAssistantModal, { isOpen: true, onClose: vi.fn(), onApplyFilter: vi.fn(), photos: [], people, places: undefined }));
    });
    await type('#nowhere');
    expect(host.textContent).toContain('No places found');
  });

  it('"&" lists Smart Flow content tags recorded in a past run', async () => {
    recordFinding('photo1', 'x', { match: true, confidence: 0.9, tags: ['receipt', 'bill'] });
    await mount();
    await type('&re');
    expect(options().map((o) => o.textContent)).toEqual(['receipt']);
  });

  it('with no tags recorded yet, "&" opens with an empty-state message instead of erroring', async () => {
    await mount();
    await type('&anything');
    expect(host.textContent).toContain('No tags found');
  });
});
