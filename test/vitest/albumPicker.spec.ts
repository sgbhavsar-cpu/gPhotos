// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../../src/renderer/src/services/libraryStore', () => ({ getLocalPhotoUrl: () => '' }));

import { rankAlbumsByQuery, AlbumPicker } from '../../src/renderer/src/components/AlbumPicker';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const album = (id: string, title: string, photoIds: string[] = []) =>
  ({ id, title, photoIds, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }) as any;

const ALBUMS = [album('a_goa', 'Goa Trip', ['p1']), album('a_wed', 'Wedding'), album('a_gt2', 'Goa Trip 2026'), album('a_fam', 'Family Album')];

const roots: Root[] = [];
function mount(el: React.ReactElement) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(el));
  return host;
}
afterEach(() => {
  while (roots.length) act(() => roots.pop()!.unmount());
  document.body.innerHTML = '';
});

function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => { setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
}
const pressEnter = (el: Element) => act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
const $ = (host: ParentNode, sel: string) => host.querySelector(sel) as HTMLElement;
const $$ = (host: ParentNode, sel: string) => Array.from(host.querySelectorAll(sel)) as HTMLElement[];

describe('rankAlbumsByQuery', () => {
  it('puts an exact title first, then titles starting with the text, then titles containing it', () => {
    const titles = (q: string) => rankAlbumsByQuery(ALBUMS, q).map((a) => a.title);
    expect(titles('goa')).toEqual(['Goa Trip', 'Goa Trip 2026']);
    expect(titles('wedding')).toEqual(['Wedding']);
    expect(titles('  ')).toEqual(ALBUMS.map((a) => a.title));
    expect(titles('zzz')).toEqual([]);
    const albums = [album('1', 'Family Reunion'), album('2', 'Family')];
    expect(rankAlbumsByQuery(albums, 'family').map((a) => a.id)).toEqual(['2', '1']); // exact outranks prefix
  });
});

describe('AlbumPicker', () => {
  it('is focused on mount, Enter picks the first match, a click picks that album, and the first match is marked', () => {
    const onPick = vi.fn();
    const host = mount(React.createElement(AlbumPicker, { albums: ALBUMS, photos: [], onPick, onCreateNew: vi.fn() }));
    const input = $(host, '[data-testid="album-picker-input"]') as HTMLInputElement;
    expect(document.activeElement).toBe(input);

    typeInto(input, 'goa');
    expect($(host, '[data-first-match="true"]').textContent).toContain('Goa Trip');
    expect($(host, '[data-testid="album-picker-hint"]').textContent).toContain('Goa Trip');
    pressEnter(input);
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0][0].id).toBe('a_goa');

    act(() => $$(host, '[data-testid="album-picker-card"]')[1].click()); // "Goa Trip 2026"
    expect(onPick.mock.calls[1][0].id).toBe('a_gt2');
  });

  it('with no match, Enter (or clicking the row) creates a new album instead of picking one', () => {
    const onPick = vi.fn();
    const onCreateNew = vi.fn();
    const host = mount(React.createElement(AlbumPicker, { albums: ALBUMS, photos: [], onPick, onCreateNew }));
    const input = $(host, '[data-testid="album-picker-input"]') as HTMLInputElement;
    typeInto(input, 'Summer Roadtrip');
    expect($(host, '[data-testid="album-picker-create"]').textContent).toContain('Summer Roadtrip');
    pressEnter(input);
    expect(onCreateNew).toHaveBeenCalledWith('Summer Roadtrip');
    expect(onPick).not.toHaveBeenCalled();
  });

  it('a partial match still picks the first match on Enter, even though "Create new" is also offered', () => {
    const onPick = vi.fn();
    const onCreateNew = vi.fn();
    const host = mount(React.createElement(AlbumPicker, { albums: ALBUMS, photos: [], onPick, onCreateNew }));
    const input = $(host, '[data-testid="album-picker-input"]') as HTMLInputElement;
    typeInto(input, 'Goa');
    expect($(host, '[data-testid="album-picker-create"]')).not.toBeNull(); // no EXACT "Goa" album, so still offered
    pressEnter(input);
    expect(onPick.mock.calls[0][0].id).toBe('a_goa'); // but Enter still picks the best match, not create
    expect(onCreateNew).not.toHaveBeenCalled();

    typeInto(input, 'Wedding');
    expect($(host, '[data-testid="album-picker-create"]')).toBeNull(); // exact title match hides it
  });

  it('shows an empty-library message, or "no matching albums" once something is typed', () => {
    const host = mount(React.createElement(AlbumPicker, { albums: [], photos: [], onPick: vi.fn(), onCreateNew: vi.fn(), emptyText: 'No albums yet.' }));
    expect(host.textContent).toContain('No albums yet.');
    typeInto($(host, '[data-testid="album-picker-input"]') as HTMLInputElement, 'x');
    expect(host.textContent).toContain('create a new album named "x"');
  });
});
