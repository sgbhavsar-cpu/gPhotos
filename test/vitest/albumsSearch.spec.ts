// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const album = (id: string, title: string) => ({ id, title, photoIds: [], createdAt: 'x', updatedAt: 'x' });

describe('AlbumsView: search box filters the albums grid by title', () => {
  let root: Root;
  let host: HTMLElement;
  let AlbumsView: any;
  const albums = [album('a1', 'Goa Trip 2024'), album('a2', "Grandma's Birthday"), album('a3', 'Diwali 2023')];

  beforeEach(async () => {
    (window as any).electronAPI = { loadLibraryData: async () => null, saveLibraryData: async () => true };
    localStorage.clear();
    vi.resetModules();
    AlbumsView = (await import('../../src/renderer/src/views/AlbumsView')).AlbumsView;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(AlbumsView, { photos: [], albums, onSelectPhoto: vi.fn() }));
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = '';
    delete (window as any).electronAPI;
  });

  const searchInput = () => host.querySelector('input[placeholder="Search albums..."]') as HTMLInputElement;
  const typeInto = (input: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => { setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
  };

  it('shows every album with no query typed', () => {
    expect(host.textContent).toContain('Goa Trip 2024');
    expect(host.textContent).toContain("Grandma's Birthday");
    expect(host.textContent).toContain('Diwali 2023');
  });

  it('narrows the grid to albums whose title matches, case-insensitively', () => {
    typeInto(searchInput(), 'goa');
    expect(host.textContent).toContain('Goa Trip 2024');
    expect(host.textContent).not.toContain("Grandma's Birthday");
    expect(host.textContent).not.toContain('Diwali 2023');
  });

  it('shows a "no matches" state for a query that matches nothing, distinct from the true-empty-library state', () => {
    typeInto(searchInput(), 'nonexistent');
    expect(host.textContent).toContain('No albums match "nonexistent"');
    expect(host.textContent).not.toContain('No Albums Created Yet');
  });

  it('clearing the query restores the full grid', () => {
    typeInto(searchInput(), 'goa');
    expect(host.textContent).not.toContain('Diwali 2023');
    typeInto(searchInput(), '');
    expect(host.textContent).toContain('Diwali 2023');
  });
});
