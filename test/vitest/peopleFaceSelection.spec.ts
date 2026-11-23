// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../../src/renderer/src/components/FaceAvatar', async () => {
  const R = await import('react');
  return { FaceAvatar: () => R.createElement('span', { 'data-face-avatar': '1' }) };
});

import { PeopleView } from '../../src/renderer/src/views/PeopleView';
import { libraryStore } from '../../src/renderer/src/services/libraryStore';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const person: any = { id: 'P', name: 'Ann', faceCount: 5, photoCount: 5, createdAt: '2026-01-01T00:00:00Z' };
const mkPhoto = (n: number, confirmed = false): any => ({
  id: `p${n}`, filePath: `C:\\p\\IMG_${n}.jpg`, fileName: `IMG_${n}.jpg`, fileSize: 1, dateTaken: `2026-01-0${n}T00:00:00Z`, year: 2026, month: 1, day: n,
  isFavorite: false, faceScanCompleted: true, facesLocked: false,
  faces: [{ id: `f${n}`, photoId: `p${n}`, personId: 'P', isConfirmed: confirmed, box: { x: 10, y: 10, width: 50, height: 50 }, imageWidth: 400, imageHeight: 300, descriptor: [] }],
});

describe('People → Zoomed Faces: tick boxes', () => {
  let host: HTMLElement; let root: Root;
  const photos = [1, 2, 3, 4, 5].map((n) => mkPhoto(n));
  beforeEach(async () => {
    (window as any).electronAPI = { onFaceQueueUpdate: undefined };
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(PeopleView, {
        people: [person], photos, onUpdatePersonName: vi.fn(), onMergePeople: vi.fn(), onSelectPhoto: vi.fn(), onToggleFavorite: vi.fn(),
        onTriggerFaceDetection: vi.fn(), isDetectingFaces: false, initialSelectedPersonId: 'P',
      }));
    });
    const faces = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('Zoomed Faces')) as HTMLButtonElement;
    await act(async () => { faces.click(); });
  });
  afterEach(() => { act(() => root.unmount()); document.body.innerHTML = ''; delete (window as any).electronAPI; vi.restoreAllMocks(); });

  const boxes = () => Array.from(host.querySelectorAll('[data-testid="face-checkbox"]')) as HTMLElement[];
  const ticked = () => boxes().map((b) => b.getAttribute('aria-checked') === 'true');
  const picture = (i: number) => (host.querySelectorAll('[data-face-card]')[i].querySelector('[data-face-avatar]') as HTMLElement).parentElement as HTMLElement;
  const count = () => host.querySelector('[data-testid="face-selected-count"]')?.textContent ?? '';
  const click = (el: Element, shiftKey = false) => act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey })); });

  it('every face card has a checkbox, and ticking one shows a count without opening the photo', async () => {
    expect(boxes()).toHaveLength(5);
    expect(host.querySelector('[data-testid="face-selected-count"]')).toBeNull();
    await click(boxes()[1]);
    expect(count()).toBe('1 selected');
    expect(ticked()[1]).toBe(true);
  });

  it('Shift+click ticks the whole range, and Select all / Clear work', async () => {
    await click(boxes()[0]);
    await click(boxes()[3], true);
    expect(count()).toBe('4 selected');
    expect(ticked()).toEqual([true, true, true, true, false]);
    await click(host.querySelector('[data-testid="face-select-all"]')!);
    expect(count()).toBe('5 selected');
    const clear = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Clear')!;
    await click(clear);
    expect(host.querySelector('[data-testid="face-selected-count"]')).toBeNull();
  });

  it('once a face is ticked, a click anywhere on any picture ticks or unticks it (otherwise it opens the photo)', async () => {
    const onSelect = vi.fn();
    await act(async () => {
      root.render(React.createElement(PeopleView, {
        people: [person], photos, onUpdatePersonName: vi.fn(), onMergePeople: vi.fn(), onSelectPhoto: onSelect, onToggleFavorite: vi.fn(),
        onTriggerFaceDetection: vi.fn(), isDetectingFaces: false, initialSelectedPersonId: 'P',
      }));
    });
    await click(picture(2));                       // nothing ticked yet: opens the photo
    expect(onSelect).toHaveBeenCalledTimes(1);
    await click(boxes()[0]);                       // tick the first face
    await click(picture(3));                       // now any click on a picture ticks it...
    expect(ticked()).toEqual([true, false, false, true, false]);
    expect(onSelect).toHaveBeenCalledTimes(1);
    await click(picture(3));                       // ...and unticks it again
    expect(ticked()).toEqual([true, false, false, false, false]);
    await click(picture(1), true);                 // Shift+click on a picture: range from the last one clicked (3) back to this one
    expect(ticked()).toEqual([true, true, true, true, false]);
  });

  it('a rubber band dragged over the faces selects the ones it touches, like the main photo list', async () => {
    const cards = Array.from(host.querySelectorAll('[data-face-card]')) as HTMLElement[];
    // jsdom has no layout: put the five cards in a row, 100 px wide each
    cards.forEach((c, i) => { c.getBoundingClientRect = () => ({ left: i * 100, right: i * 100 + 90, top: 0, bottom: 90, width: 90, height: 90, x: i * 100, y: 0, toJSON: () => ({}) }) as DOMRect; });
    const area = host.querySelector('[data-testid="faces-scroll-area"]') as HTMLElement;
    area.getBoundingClientRect = () => ({ left: 0, right: 600, top: 0, bottom: 400, width: 600, height: 400, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    await act(async () => { area.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientX: 5, clientY: 200 })); });
    await act(async () => { window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 250, clientY: 40 })); });
    expect(ticked()).toEqual([true, true, true, false, false]);
    expect(host.querySelector('[data-testid="marquee-box"]')).toBeTruthy();
    await act(async () => { window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 250, clientY: 40 })); });
    expect(host.querySelector('[data-testid="marquee-box"]')).toBeNull();
    expect(count()).toBe('3 selected');
    // a plain click on empty space clears it
    await act(async () => { area.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientX: 590, clientY: 390 })); });
    await act(async () => { window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 590, clientY: 390 })); });
    expect(host.querySelector('[data-testid="face-selected-count"]')).toBeNull();
  });

  it('pressing the scroll bar does not clear the selection or start a band', async () => {
    await click(boxes()[0]);
    const area = host.querySelector('[data-testid="faces-scroll-area"]') as HTMLElement;
    area.getBoundingClientRect = () => ({ left: 0, right: 600, top: 0, bottom: 400, width: 600, height: 400, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    Object.defineProperty(area, 'clientWidth', { value: 585, configurable: true });   // 15 px of scroll bar on the right
    Object.defineProperty(area, 'clientHeight', { value: 400, configurable: true });
    await act(async () => { area.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientX: 595, clientY: 200 })); });
    await act(async () => { window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 595, clientY: 200 })); });
    expect(count()).toBe('1 selected');
    // ...whereas a press on empty space inside the content still clears it
    await act(async () => { area.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientX: 300, clientY: 390 })); });
    await act(async () => { window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 300, clientY: 390 })); });
    expect(host.querySelector('[data-testid="face-selected-count"]')).toBeNull();
  });

  it('the Correct / Not this person bar sits outside the scrolling area, so it stays put while the faces scroll', async () => {
    await click(boxes()[0]);
    const bar = host.querySelector('[data-testid="face-select-bar"]') as HTMLElement;
    expect(bar.closest('[data-testid="faces-scroll-area"]')).toBeNull();
    expect(bar.querySelector('[data-testid="face-confirm-selected"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="faces-scroll-area"]')!.contains(boxes()[0])).toBe(true);
  });

  it('"Show confirmed photos" hides the confirmed faces (and drops them from the selection); the choice is remembered', async () => {
    localStorage.removeItem('gphotos_faces_show_confirmed');
    const mixed = [mkPhoto(1), mkPhoto(2, true), mkPhoto(3), mkPhoto(4, true), mkPhoto(5)];
    await act(async () => {
      root.render(React.createElement(PeopleView, {
        people: [person], photos: mixed, onUpdatePersonName: vi.fn(), onMergePeople: vi.fn(), onSelectPhoto: vi.fn(), onToggleFavorite: vi.fn(),
        onTriggerFaceDetection: vi.fn(), isDetectingFaces: false, initialSelectedPersonId: 'P',
      }));
    });
    const toggle = () => host.querySelector('[data-testid="face-show-confirmed"]') as HTMLInputElement;
    expect(toggle().checked).toBe(true);
    expect(boxes()).toHaveLength(5);
    await click(host.querySelector('[data-testid="face-select-all"]')!);
    expect(count()).toBe('5 selected');

    await click(toggle());
    expect(toggle().checked).toBe(false);
    expect(boxes()).toHaveLength(3);                                   // only the unconfirmed faces
    expect(count()).toBe('3 selected');                                // the hidden ones left the selection
    expect(host.querySelector('[data-testid="face-select-all"]')!.textContent).toContain('3');
    expect(localStorage.getItem('gphotos_faces_show_confirmed')).toBe('0');

    const confirm = vi.spyOn(libraryStore, 'confirmFace').mockResolvedValue(undefined as any);
    await click(host.querySelector('[data-testid="face-confirm-selected"]')!);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(confirm.mock.calls.map((c) => c[0]).sort()).toEqual(['f1', 'f3', 'f5']);

    await click(toggle());
    expect(boxes()).toHaveLength(5);
  });

  it('"Show confirmed photos" starts unticked when that was the last choice, and says so when nothing is left to review', async () => {
    localStorage.setItem('gphotos_faces_show_confirmed', '0');
    const allDone = [mkPhoto(1, true), mkPhoto(2, true)];
    await act(async () => {
      root.render(React.createElement(PeopleView, {
        people: [person], photos: allDone, onUpdatePersonName: vi.fn(), onMergePeople: vi.fn(), onSelectPhoto: vi.fn(), onToggleFavorite: vi.fn(),
        onTriggerFaceDetection: vi.fn(), isDetectingFaces: false, initialSelectedPersonId: 'P',
      }));
    });
    // PeopleView keeps its own state across re-renders; a fresh mount reads the saved choice
    act(() => root.unmount());
    root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(PeopleView, {
        people: [person], photos: allDone, onUpdatePersonName: vi.fn(), onMergePeople: vi.fn(), onSelectPhoto: vi.fn(), onToggleFavorite: vi.fn(),
        onTriggerFaceDetection: vi.fn(), isDetectingFaces: false, initialSelectedPersonId: 'P',
      }));
    });
    const faces = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('Zoomed Faces')) as HTMLButtonElement;
    await act(async () => { faces.click(); });
    expect((host.querySelector('[data-testid="face-show-confirmed"]') as HTMLInputElement).checked).toBe(false);
    expect(boxes()).toHaveLength(0);
    expect(host.querySelector('[data-testid="face-all-confirmed"]')).toBeTruthy();
    localStorage.removeItem('gphotos_faces_show_confirmed');
  });

  it('"Correct" confirms every ticked face together and clears the selection', async () => {
    const confirm = vi.spyOn(libraryStore, 'confirmFace').mockResolvedValue(undefined as any);
    await click(boxes()[0]);
    await click(boxes()[2]);
    await click(host.querySelector('[data-testid="face-confirm-selected"]')!);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(confirm.mock.calls.map((c) => c[0]).sort()).toEqual(['f1', 'f3']);
    expect(host.querySelector('[data-testid="face-selected-count"]')).toBeNull();
  });

  it('"Not this person" removes only the ticked faces from the person, after asking', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const unassign = vi.spyOn(libraryStore, 'unassignFaceFromPerson').mockResolvedValue(undefined as any);
    await click(boxes()[1]);
    await click(boxes()[4]);
    await click(host.querySelector('[data-testid="face-reject-selected"]')!);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(unassign.mock.calls.map((c) => c[0]).sort()).toEqual(['f2', 'f5']);
  });

  it('declining the question removes nothing', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const unassign = vi.spyOn(libraryStore, 'unassignFaceFromPerson').mockResolvedValue(undefined as any);
    await click(boxes()[0]);
    await click(host.querySelector('[data-testid="face-reject-selected"]')!);
    expect(unassign).not.toHaveBeenCalled();
    expect(count()).toBe('1 selected');
  });
});
