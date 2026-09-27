// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const store = vi.hoisted(() => ({
  reassignFaceToPerson: vi.fn(() => ({ success: true })),
  canMergePeople: vi.fn(() => ({ canMerge: true })),
  mergePeople: vi.fn(() => true),
  getState: vi.fn(() => ({ people: [], photos: [] })),
}));

vi.mock('../../src/renderer/src/services/libraryStore', () => ({
  libraryStore: store,
  getLocalPhotoUrl: () => '',
}));
vi.mock('../../src/renderer/src/components/FaceAvatar', async () => {
  const R = await import('react');
  return { FaceAvatar: () => R.createElement('span', { 'data-face-avatar': '1' }) };
});

import { rankPeopleByQuery, PersonPicker } from '../../src/renderer/src/components/PersonPicker';
import { ReassignFaceModal } from '../../src/renderer/src/components/ReassignFaceModal';
import { MergePeopleModal } from '../../src/renderer/src/components/MergePeopleModal';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const person = (id: string, name: string, photoCount = 3) =>
  ({ id, name, faceCount: photoCount, photoCount, createdAt: '2026-01-01T00:00:00Z' }) as any;

const PEOPLE = [person('p_alice', 'Alice Smith'), person('p_bob', 'Bob'), person('p_alicia', 'Alicia'), person('p_malice', 'Malice')];

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
  vi.clearAllMocks();
  store.canMergePeople.mockReturnValue({ canMerge: true });
  store.mergePeople.mockReturnValue(true);
  store.reassignFaceToPerson.mockReturnValue({ success: true });
});

function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const pressEnter = (el: Element) =>
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  });
const $ = (host: ParentNode, sel: string) => host.querySelector(sel) as HTMLElement;
const $$ = (host: ParentNode, sel: string) => Array.from(host.querySelectorAll(sel)) as HTMLElement[];

describe('rankPeopleByQuery', () => {
  it('puts exact matches first, then names starting with the text, then names containing it (stable)', () => {
    const names = (q: string) => rankPeopleByQuery(PEOPLE, q).map((p) => p.name);
    expect(names('ali')).toEqual(['Alice Smith', 'Alicia', 'Malice']);
    expect(names('ALICIA')).toEqual(['Alicia']);
    expect(names('alice')).toEqual(['Alice Smith', 'Malice']);
    expect(names('bob')).toEqual(['Bob']);
    expect(names('  ')).toEqual(PEOPLE.map((p) => p.name)); // empty query: everyone, original order
    expect(names('zzz')).toEqual([]);
    // an exact name outranks a name that merely starts with it
    const ppl = [person('1', 'Anna Maria'), person('2', 'Anna')];
    expect(rankPeopleByQuery(ppl, 'anna').map((p) => p.id)).toEqual(['2', '1']);
  });
});

describe('PersonPicker', () => {
  it('Enter picks the first match, a click picks that person, and the first match is marked', () => {
    const onPick = vi.fn();
    const host = mount(React.createElement(PersonPicker, { people: PEOPLE, photos: [], onPick }));
    const input = $(host, '[data-testid="person-picker-input"]') as HTMLInputElement;

    typeInto(input, 'ali');
    expect($(host, '[data-first-match="true"]').textContent).toContain('Alice Smith');
    expect($(host, '[data-testid="person-picker-hint"]').textContent).toContain('Alice Smith');
    pressEnter(input);
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0][0].id).toBe('p_alice');

    act(() => $$(host, '[data-testid="person-picker-card"]')[1].click()); // "Alicia"
    expect(onPick.mock.calls[1][0].id).toBe('p_alicia');
  });

  it('with no match Enter creates a new person (when allowed) and does nothing otherwise', () => {
    const onPick = vi.fn();
    const onCreateNew = vi.fn();
    const host = mount(React.createElement(PersonPicker, { people: PEOPLE, photos: [], onPick, onCreateNew }));
    const input = $(host, '[data-testid="person-picker-input"]') as HTMLInputElement;
    typeInto(input, 'Zed');
    pressEnter(input);
    expect(onCreateNew).toHaveBeenCalledWith('Zed');
    expect(onPick).not.toHaveBeenCalled();

    const host2 = mount(React.createElement(PersonPicker, { people: PEOPLE, photos: [], onPick }));
    const input2 = $(host2, '[data-testid="person-picker-input"]') as HTMLInputElement;
    typeInto(input2, 'Zed');
    pressEnter(input2);
    expect(onPick).not.toHaveBeenCalled();
  });

  it('a partial match still picks the first match on Enter, and offers "Create new" as a click target', () => {
    const onPick = vi.fn();
    const onCreateNew = vi.fn();
    const host = mount(React.createElement(PersonPicker, { people: PEOPLE, photos: [], onPick, onCreateNew }));
    const input = $(host, '[data-testid="person-picker-input"]') as HTMLInputElement;
    typeInto(input, 'Ali');
    act(() => $(host, '[data-testid="person-picker-create"]').click());
    expect(onCreateNew).toHaveBeenCalledWith('Ali');
    pressEnter(input);
    expect(onPick.mock.calls[0][0].id).toBe('p_alice');
    // an exact name already exists -> no create row
    typeInto(input, 'Bob');
    expect($(host, '[data-testid="person-picker-create"]')).toBeNull();
  });
});

describe('ReassignFaceModal: assigning a face', () => {
  const face = { id: 'face1', personId: 'p_current', photoId: 'ph1', box: { x: 0, y: 0, width: 1, height: 1 } } as any;
  const photo = { id: 'ph1', fileName: 'a.jpg', faces: [face] } as any;
  const props = () => ({
    face,
    photo,
    currentPersonName: 'Current',
    people: [...PEOPLE, person('p_current', 'Current', 7)],
    onClose: vi.fn(),
    onSuccess: vi.fn(),
  });

  it('typing a partial name and pressing Enter assigns to the first matching person, without any confirm button', () => {
    const p = props();
    const host = mount(React.createElement(ReassignFaceModal, p));
    expect(host.textContent).not.toContain('Confirm Reassignment');
    typeInto($(host, '[data-testid="person-picker-input"]') as HTMLInputElement, 'ali');
    pressEnter($(host, '[data-testid="person-picker-input"]'));
    expect(store.reassignFaceToPerson).toHaveBeenCalledWith('face1', 'p_alice');
    expect(p.onSuccess).toHaveBeenCalled();
    expect(p.onClose).toHaveBeenCalled();
  });

  it('clicking a person assigns immediately (one click, no confirmation step)', () => {
    const p = props();
    const host = mount(React.createElement(ReassignFaceModal, p));
    const bob = $$(host, '[data-testid="person-picker-card"]').find((c) => c.textContent?.includes('Bob'))!;
    act(() => bob.click());
    expect(store.reassignFaceToPerson).toHaveBeenCalledWith('face1', 'p_bob');
    expect(p.onClose).toHaveBeenCalled();
  });

  it('a name matching nobody creates a new person on Enter', () => {
    const p = props();
    const host = mount(React.createElement(ReassignFaceModal, p));
    typeInto($(host, '[data-testid="person-picker-input"]') as HTMLInputElement, 'Zed');
    pressEnter($(host, '[data-testid="person-picker-input"]'));
    expect(store.reassignFaceToPerson).toHaveBeenCalledWith('face1', 'Zed');
  });

  it('"merge the whole person" (set before picking) merges instead of moving one face', () => {
    const p = props();
    const host = mount(React.createElement(ReassignFaceModal, p));
    act(() => $(host, '[data-testid="reassign-merge-toggle"]').click());
    typeInto($(host, '[data-testid="person-picker-input"]') as HTMLInputElement, 'bob');
    pressEnter($(host, '[data-testid="person-picker-input"]'));
    expect(store.mergePeople).toHaveBeenCalledWith('p_bob', 'p_current');
    expect(store.reassignFaceToPerson).not.toHaveBeenCalled();
  });

  it('shows the reason and stays open when the assignment is refused', () => {
    store.reassignFaceToPerson.mockReturnValue({ success: false, error: 'Already in this photo' } as any);
    const p = props();
    const host = mount(React.createElement(ReassignFaceModal, p));
    typeInto($(host, '[data-testid="person-picker-input"]') as HTMLInputElement, 'bob');
    pressEnter($(host, '[data-testid="person-picker-input"]'));
    expect(host.textContent).toContain('Already in this photo');
    expect(p.onClose).not.toHaveBeenCalled();
  });
});

describe('MergePeopleModal: choosing the second person', () => {
  const personA = person('p_a', 'Anna', 5);
  const others = [person('p_bob', 'Bob'), person('p_bea', 'Beatrice')];
  const base = () => ({
    personA,
    allPeople: [personA, ...others],
    photos: [] as any[],
    onClose: vi.fn(),
    onSuccess: vi.fn(),
  });

  it('is searchable like assigning: Enter selects the first match; Enter again merges', () => {
    const p = base();
    const host = mount(React.createElement(MergePeopleModal, p));
    const input = $(host, '[data-testid="person-picker-input"]') as HTMLInputElement;
    expect(host.textContent).not.toContain('Valid merge'); // nothing pre-selected any more
    expect($(host, 'button[type="submit"]').hasAttribute('disabled')).toBe(true);

    typeInto(input, 'be');
    pressEnter(input);
    expect(store.mergePeople).not.toHaveBeenCalled();
    expect(host.textContent).toContain('Valid merge');
    expect(host.textContent).toContain('Keep: Beatrice');

    pressEnter(input); // the first match is now the selected person -> confirm
    expect(store.mergePeople).toHaveBeenCalledWith('p_a', 'p_bea', 'Anna');
    expect(p.onClose).toHaveBeenCalled();
  });

  it('a click selects the person; the merge still needs the Confirm button', () => {
    const p = base();
    const host = mount(React.createElement(MergePeopleModal, p));
    const bob = $$(host, '[data-testid="person-picker-card"]').find((c) => c.textContent?.includes('Bob'))!;
    act(() => bob.click());
    expect(store.mergePeople).not.toHaveBeenCalled();
    act(() => $(host, 'button[type="submit"]').click());
    expect(store.mergePeople).toHaveBeenCalledWith('p_a', 'p_bob', 'Anna');
  });

  it('Enter does not merge when the two people appear in the same photo', () => {
    store.canMergePeople.mockReturnValue({ canMerge: false, conflictPhotoName: 'x.jpg' } as any);
    const p = base();
    const host = mount(React.createElement(MergePeopleModal, p));
    const input = $(host, '[data-testid="person-picker-input"]') as HTMLInputElement;
    typeInto(input, 'bob');
    pressEnter(input);
    pressEnter(input);
    expect(store.mergePeople).not.toHaveBeenCalled();
    expect(host.textContent).toContain('Cannot merge');
  });

  it('keeps the fixed second person when the caller supplies one (no picker)', () => {
    const p = { ...base(), personB: others[0] };
    const host = mount(React.createElement(MergePeopleModal, p));
    expect($(host, '[data-testid="person-picker-input"]')).toBeNull();
    expect(host.textContent).toContain('Keep: Bob');
  });
});
