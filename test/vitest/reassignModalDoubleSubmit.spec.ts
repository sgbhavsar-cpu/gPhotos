// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// Reported bug: reassigning a face now genuinely takes a few seconds (clusterFacesAsync's worker
// round-trip + propagateLearnedFaces — see CODE_REVIEW §55), and ReassignFaceModal shows NO loading
// state while that's in flight. The user, seeing what looks like a frozen modal, pressed Enter a
// second time — by then PersonPicker's own `people` prop had already re-rendered mid-flight (the
// first reassignFaceToPerson call's own cluster() step calls notify() well before the whole async
// chain resolves), which can make an exact match look like "no match" for a moment. The second Enter
// then matched the "create new person" branch instead, actually creating a stray new person.
const store = vi.hoisted(() => ({
  reassignFaceToPerson: vi.fn(),
  canMergePeople: vi.fn(() => ({ canMerge: true })),
  mergePeople: vi.fn(() => Promise.resolve(true)),
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

import { ReassignFaceModal } from '../../src/renderer/src/components/ReassignFaceModal';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const person = (id: string, name: string, photoCount = 3) =>
  ({ id, name, faceCount: photoCount, photoCount, createdAt: '2026-01-01T00:00:00Z' }) as any;

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
});

function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const pressEnterSync = (el: Element) =>
  act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
const $ = (host: ParentNode, sel: string) => host.querySelector(sel) as HTMLElement;

describe('ReassignFaceModal: a second Enter pressed while the first assignment is still in flight', () => {
  const face = { id: 'face1', personId: undefined, photoId: 'ph1', box: { x: 0, y: 0, width: 1, height: 1 } } as any;
  const photo = { id: 'ph1', fileName: 'a.jpg', faces: [face] } as any;
  const misti = person('p_misti', 'Misti Parimal');
  const props = () => ({
    face,
    photo,
    currentPersonName: 'Unknown',
    people: [misti],
    onClose: vi.fn(),
    onSuccess: vi.fn(),
  });

  it('does not fire a second reassignFaceToPerson call for a real-world-length pending request', async () => {
    // Simulates the worker round-trip + clustering taking real wall-clock time (per §55) — long
    // enough that a confused user's second Enter press happens while the first is still pending.
    let resolveFirst!: (v: any) => void;
    store.reassignFaceToPerson.mockImplementation(
      () => new Promise((resolve) => { resolveFirst = resolve; })
    );

    const p = props();
    const host = mount(React.createElement(ReassignFaceModal, p));
    const input = $(host, '[data-testid="person-picker-input"]') as HTMLInputElement;

    typeInto(input, 'misti');
    expect($(host, '[data-testid="person-picker-hint"]')?.textContent).toContain('Misti Parimal');

    // First Enter: starts the (still-pending) assignment.
    pressEnterSync(input);
    expect(store.reassignFaceToPerson).toHaveBeenCalledTimes(1);
    expect(store.reassignFaceToPerson).toHaveBeenCalledWith('face1', 'p_misti', { photoId: 'ph1', box: face.box });

    // The user, seeing no loading indicator, presses Enter again before the first call resolves.
    pressEnterSync(input);

    // The bug: without a submit-in-progress guard, this second Enter is free to fire another
    // reassignFaceToPerson call — in the worst case with a *different* argument (e.g. 'misti' as a
    // literal new-person name) if the picker's own re-render during the pending call changed what
    // "the first match" looks like. Either way, a second real call must never happen.
    expect(store.reassignFaceToPerson).toHaveBeenCalledTimes(1);

    act(() => resolveFirst({ success: true }));
    await act(async () => {});
    expect(p.onSuccess).toHaveBeenCalledTimes(1);
    expect(p.onClose).toHaveBeenCalledTimes(1);
  });
});
