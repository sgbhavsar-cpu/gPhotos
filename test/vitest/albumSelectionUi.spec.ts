// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// The real grid mounts only the rows it can measure; jsdom has no layout, so mount every tile.
vi.mock('../../src/renderer/src/components/VirtualCardGrid', () => ({
  VirtualCardGrid: (props: any) =>
    React.createElement('div', null, props.items.map((it: any) => React.createElement('div', { key: props.getKey(it) }, props.renderItem(it)))),
}));

const photo = (n: number) => ({
  id: `p${n}`, filePath: `C:\\p${n}.jpg`, fileName: `p${n}.jpg`, fileSize: 1,
  dateTaken: '2026-01-01', year: 2026, month: 1, day: 1,
}) as any;

const CONTAINER = { left: 0, top: 0, right: 1000, bottom: 600, width: 1000, height: 600 };
const TILE_W = 90;

describe('Album: selecting photos (checkbox, rubber band) and dragging them to chapters', () => {
  let root: Root;
  let host: HTMLElement;
  let lib: any;
  let AlbumsView: any;
  let onSelectPhoto: ReturnType<typeof vi.fn>;
  const photos = [1, 2, 3, 4, 5, 6].map(photo);
  let realRect: typeof HTMLElement.prototype.getBoundingClientRect;

  const chapter = (id: string, title: string, photoIds: string[]) => ({ id, title, photoIds, createdAt: 'x', updatedAt: 'x' });
  const setAlbum = (chapters?: any[]) => {
    lib.getState().albums = [{ id: 'a1', title: 'Trip', photoIds: photos.map((p) => p.id), createdAt: 'x', updatedAt: 'x', ...(chapters ? { chapters } : {}) }];
  };
  const render = async () => {
    await act(async () => {
      root.render(React.createElement(AlbumsView, { photos, albums: lib.getState().albums, onSelectPhoto }));
    });
  };
  const openAlbum = async () => {
    const title = Array.from(host.querySelectorAll('*')).find((e) => e.children.length === 0 && e.textContent?.trim() === 'Trip') as HTMLElement;
    await act(async () => { title.click(); });
  };
  const tile = (n: number) => host.querySelector(`[data-album-photo-id="p${n}"]`) as HTMLElement;
  const checkbox = (n: number) => tile(n).querySelector('[data-testid="tile-checkbox"]') as HTMLElement;
  const scrollArea = () => host.querySelector('[data-testid="album-scroll-area"]') as HTMLElement;
  const isChecked = (n: number) => checkbox(n).getAttribute('aria-checked') === 'true';
  const checkedNumbers = () => photos.map((_, i) => i + 1).filter(isChecked);
  const bar = () => host.ownerDocument.querySelector('[data-testid="album-selection-bar"]');

  const mouse = (type: string, target: EventTarget, x: number, y: number, extra: any = {}) =>
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, ...extra }));
  /** Press on `target`, drag to (x2,y2) through `via`, and (unless keepDown) release. */
  const drag = async (target: EventTarget, from: [number, number], to: [number, number], { keepDown = false, extra = {} }: any = {}) => {
    await act(async () => { mouse('mousedown', target, from[0], from[1], extra); });
    await act(async () => { mouse('mousemove', window, to[0], to[1]); });
    if (!keepDown) await act(async () => { mouse('mouseup', window, to[0], to[1]); });
  };

  beforeEach(async () => {
    (window as any).electronAPI = { loadLibraryData: async () => null, saveLibraryData: async () => true };
    localStorage.clear();
    vi.resetModules();
    lib = (await import('../../src/renderer/src/services/libraryStore')).libraryStore;
    AlbumsView = (await import('../../src/renderer/src/views/AlbumsView')).AlbumsView;
    onSelectPhoto = vi.fn();

    // Layout for jsdom: tiles sit in one row, 100px apart (tile n at x = (n-1)*100 .. +90, y 0..90); the scroll area is 1000x600.
    realRect = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      const id = this.getAttribute?.('data-album-photo-id');
      if (id) {
        const n = Number(id.slice(1)) - 1;
        return { left: n * 100, right: n * 100 + TILE_W, top: 0, bottom: 90, width: TILE_W, height: 90, x: n * 100, y: 0, toJSON() {} } as DOMRect;
      }
      if (this.getAttribute?.('data-testid') === 'album-scroll-area') return { ...CONTAINER, x: 0, y: 0, toJSON() {} } as DOMRect;
      return { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {} } as DOMRect;
    };

    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    HTMLElement.prototype.getBoundingClientRect = realRect;
    act(() => root.unmount());
    document.body.innerHTML = '';
    delete (window as any).electronAPI;
  });

  describe('checkbox selection', () => {
    beforeEach(async () => { setAlbum(); await render(); await openAlbum(); });

    it('every photo has a checkbox, even in an album with no chapters', () => {
      expect(host.querySelectorAll('[data-testid="tile-checkbox"]')).toHaveLength(6);
      expect(checkedNumbers()).toEqual([]);
      expect(bar()).toBeNull();
    });

    it('ticking checkboxes selects several photos and shows how many are selected', async () => {
      await act(async () => { checkbox(1).click(); });
      await act(async () => { checkbox(3).click(); });
      expect(checkedNumbers()).toEqual([1, 3]);
      expect(bar()!.textContent).toContain('2 selected');
      expect(onSelectPhoto).not.toHaveBeenCalled(); // the checkbox never opens the photo
    });

    it('with nothing selected a click opens the photo; once something is selected a click toggles instead (like the gallery)', async () => {
      await act(async () => { tile(2).click(); });
      expect(onSelectPhoto).toHaveBeenCalledTimes(1);

      await act(async () => { checkbox(1).click(); });
      await act(async () => { tile(4).click(); });
      expect(onSelectPhoto).toHaveBeenCalledTimes(1); // unchanged
      expect(checkedNumbers()).toEqual([1, 4]);
      await act(async () => { tile(4).click(); });
      expect(checkedNumbers()).toEqual([1]);
    });

    it('Ctrl-click selects without opening', async () => {
      await act(async () => { tile(5).dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true })); });
      expect(checkedNumbers()).toEqual([5]);
      expect(onSelectPhoto).not.toHaveBeenCalled();
    });

    it('the X on the selection bar clears it', async () => {
      await act(async () => { checkbox(1).click(); });
      await act(async () => { (bar()!.querySelector('[aria-label="Clear selection"]') as HTMLElement).click(); });
      expect(checkedNumbers()).toEqual([]);
      expect(bar()).toBeNull();
    });
  });

  describe('press and drag across photos (rubber band)', () => {
    beforeEach(async () => { setAlbum(); await render(); await openAlbum(); });

    it('dragging from empty space selects every photo the band touches — and only those', async () => {
      // band x 150..320 covers tiles 2 (100-190), 3 (200-290) and 4 (300-390); tile 1 (0-90) is left of it
      await drag(scrollArea(), [150, 20], [320, 80], { keepDown: true });
      expect(checkedNumbers()).toEqual([2, 3, 4]);
      expect(host.ownerDocument.querySelector('[data-testid="marquee-box"]')).not.toBeNull();

      // shrinking the band takes the last photo back out
      await act(async () => { mouse('mousemove', window, 250, 80); });
      expect(checkedNumbers()).toEqual([2, 3]);
      await act(async () => { mouse('mouseup', window, 250, 80); });
      expect(host.ownerDocument.querySelector('[data-testid="marquee-box"]')).toBeNull();
      expect(checkedNumbers()).toEqual([2, 3]); // stays selected after release
    });

    it('a new band replaces the old selection; Ctrl adds to it', async () => {
      await drag(scrollArea(), [10, 20], [150, 80]); // tiles 1, 2
      expect(checkedNumbers()).toEqual([1, 2]);
      await drag(scrollArea(), [410, 20], [520, 80]); // tiles 5, 6 replace
      expect(checkedNumbers()).toEqual([5, 6]);
      await drag(scrollArea(), [10, 20], [50, 80], { extra: { ctrlKey: true } }); // + tile 1
      expect(checkedNumbers()).toEqual([1, 5, 6]);
    });

    it('a band that touches nothing selects nothing', async () => {
      await drag(scrollArea(), [10, 200], [500, 400]);
      expect(checkedNumbers()).toEqual([]);
    });

    it('starting on a checkbox adds to what is already selected and rubber-bands onward', async () => {
      await act(async () => { checkbox(1).click(); });
      await drag(checkbox(4), [310, 80], [520, 20]); // press on tile 4's checkbox, drag right over tiles 5 and 6
      expect(checkedNumbers()).toEqual([1, 4, 5, 6]);
    });

    it('the click that follows a drag which began on a checkbox does not toggle that photo back', async () => {
      await drag(checkbox(4), [310, 80], [520, 20], { keepDown: true });
      // a browser fires the click in the same task as the mouseup
      await act(async () => { mouse('mouseup', window, 520, 20); checkbox(4).click(); });
      expect(checkedNumbers()).toContain(4);
    });

    it('pressing on a photo itself does not start a band (it opens / drags the photo as before)', async () => {
      await drag(tile(2), [150, 40], [520, 80]);
      expect(checkedNumbers()).toEqual([]);
      expect(host.ownerDocument.querySelector('[data-testid="marquee-box"]')).toBeNull();
    });

    it('a plain click on empty space clears the selection; a tiny wobble is still a click', async () => {
      await drag(scrollArea(), [10, 20], [150, 80]);
      expect(checkedNumbers()).toEqual([1, 2]);
      await drag(scrollArea(), [700, 300], [702, 301]);
      expect(checkedNumbers()).toEqual([]);
    });

    it('buttons are not the start of a band', async () => {
      const button = host.querySelector('[data-testid="album-scroll-area"] button') || host.querySelector('button')!;
      await drag(button, [10, 20], [520, 80]);
      expect(checkedNumbers()).toEqual([]);
    });
  });

  describe('dragging photos to a chapter', () => {
    // A minimal DataTransfer: jsdom has none.
    const makeDt = () => {
      const store = new Map<string, string>();
      return { setData: (k: string, v: string) => store.set(k, v), getData: (k: string) => store.get(k) ?? '', effectAllowed: '', dropEffect: '', setDragImage: vi.fn() } as any;
    };
    const fire = async (type: string, target: EventTarget, dt: any) => {
      const ev = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'dataTransfer', { value: dt });
      await act(async () => { target.dispatchEvent(ev); });
    };
    const dropBar = () => host.ownerDocument.querySelector('[data-testid="chapter-drop-bar"]') as HTMLElement | null;
    const flushTimers = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 5)); }); };
    const chapterIds = (id: string) => lib.getState().albums[0].chapters.find((c: any) => c.id === id).photoIds;

    beforeEach(async () => {
      setAlbum([chapter('c1', 'Day 1', ['p1', 'p2']), chapter('c2', 'Day 2', ['p3']), chapter('c3', 'Day 3', [])]);
      await render();
      await openAlbum();
    });

    it('starting to drag a photo puts EVERY chapter (and "Other Photos") in a bar at the top as drop targets', async () => {
      const dt = makeDt();
      expect(dropBar()).toBeNull();
      await fire('dragstart', tile(1), dt);
      await flushTimers();
      const bar = dropBar()!;
      expect(bar).not.toBeNull();
      expect(bar.textContent).toContain('Drop 1 photo');
      for (const id of ['c1', 'c2', 'c3', 'none']) expect(bar.querySelector(`[data-testid="drop-chapter-${id}"]`)).not.toBeNull();
      expect(bar.textContent).toContain('Day 3');
      expect(dt.effectAllowed).toBe('move');
    });

    it('dropping on a chapter in the bar moves the photo there and puts the bar away', async () => {
      const dt = makeDt();
      await fire('dragstart', tile(1), dt); // p1 lives in Day 1
      await flushTimers();
      await fire('dragover', dropBar()!.querySelector('[data-testid="drop-chapter-c3"]')!, dt);
      await fire('drop', dropBar()!.querySelector('[data-testid="drop-chapter-c3"]')!, dt);
      await render();
      expect(chapterIds('c3')).toEqual(['p1']);
      expect(chapterIds('c1')).toEqual(['p2']);
      expect(dropBar()).toBeNull();
    });

    it('several selected photos are dragged together and all land in the chosen chapter', async () => {
      await act(async () => { checkbox(1).click(); });
      await act(async () => { checkbox(2).click(); });
      await act(async () => { checkbox(3).click(); });
      const dt = makeDt();
      await fire('dragstart', tile(2), dt);
      await flushTimers();
      expect(dropBar()!.textContent).toContain('Drop 3 photos');
      expect(dt.setDragImage).toHaveBeenCalled(); // a "3 photos" badge instead of one thumbnail
      await fire('drop', dropBar()!.querySelector('[data-testid="drop-chapter-c3"]')!, dt);
      await render();
      expect(chapterIds('c3').sort()).toEqual(['p1', 'p2', 'p3']);
      expect(chapterIds('c1')).toEqual([]);
      expect(chapterIds('c2')).toEqual([]);
      expect(checkedNumbers()).toEqual([]); // selection is cleared after the move
      expect(bar()).toBeNull();
    });

    it('dragging a photo that is NOT part of the selection moves just that one', async () => {
      await act(async () => { checkbox(1).click(); });
      await act(async () => { checkbox(2).click(); });
      const dt = makeDt();
      await fire('dragstart', tile(5), dt);
      await flushTimers();
      expect(dropBar()!.textContent).toContain('Drop 1 photo');
      await fire('drop', dropBar()!.querySelector('[data-testid="drop-chapter-c2"]')!, dt);
      await render();
      expect(chapterIds('c2')).toEqual(['p3', 'p5']);
      expect(chapterIds('c1')).toEqual(['p1', 'p2']);
    });

    it('"Other Photos" in the bar takes photos out of their chapter', async () => {
      const dt = makeDt();
      await fire('dragstart', tile(1), dt);
      await flushTimers();
      await fire('drop', dropBar()!.querySelector('[data-testid="drop-chapter-none"]')!, dt);
      await render();
      expect(chapterIds('c1')).toEqual(['p2']);
    });

    it('cancelling the drag (dragend) puts the bar away and moves nothing', async () => {
      const dt = makeDt();
      await fire('dragstart', tile(1), dt);
      await flushTimers();
      expect(dropBar()).not.toBeNull();
      await fire('dragend', tile(1), dt);
      expect(dropBar()).toBeNull();
      expect(chapterIds('c1')).toEqual(['p1', 'p2']);
    });

    it('the bar is also put away when the drag ends on an element that is gone (the windowed grid unmounted the tile)', async () => {
      const dt = makeDt();
      await fire('dragstart', tile(1), dt);
      await flushTimers();
      await fire('dragend', document.body, dt);
      expect(dropBar()).toBeNull();
    });

    it('the selection bar is not shown while dragging (the drop bar is)', async () => {
      await act(async () => { checkbox(1).click(); });
      expect(bar()).not.toBeNull();
      const dt = makeDt();
      await fire('dragstart', tile(1), dt);
      await flushTimers();
      expect(bar()).toBeNull();
      expect(dropBar()).not.toBeNull();
    });

    it('a photo is not draggable from its checkbox press (that starts a rubber band instead)', async () => {
      // pressing a checkbox is default-prevented, which stops the browser starting a native drag from it
      const ev = new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: 10, clientY: 10, button: 0 });
      await act(async () => { checkbox(1).dispatchEvent(ev); });
      expect(ev.defaultPrevented).toBe(true);
      await act(async () => { mouse('mouseup', window, 10, 10); });
    });
  });

  describe('the selection bar (works without dragging, e.g. on a touch screen)', () => {
    beforeEach(async () => {
      setAlbum([chapter('c1', 'Day 1', ['p1']), chapter('c2', 'Day 2', [])]);
      await render();
      await openAlbum();
      await act(async () => { checkbox(2).click(); });
      await act(async () => { checkbox(3).click(); });
    });
    const moveButton = () => Array.from(bar()!.querySelectorAll('button')).find((b) => b.textContent?.includes('Move to chapter')) as HTMLButtonElement;

    it('"Move to chapter…" lists the chapters and moves the whole selection', async () => {
      await act(async () => { moveButton().click(); });
      const day2 = Array.from(host.ownerDocument.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Day 2') as HTMLButtonElement;
      await act(async () => { day2.click(); });
      await render();
      expect(lib.getState().albums[0].chapters[1].photoIds).toEqual(['p2', 'p3']);
      expect(checkedNumbers()).toEqual([]);
    });

    it('"New chapter" in that menu creates a chapter that already contains the selected photos', async () => {
      await act(async () => { moveButton().click(); });
      const create = Array.from(bar()!.querySelectorAll('button')).find((b) => /new chapter/i.test(b.textContent || '')) as HTMLButtonElement; // the picker's, not the header's
      await act(async () => { create.click(); });
      const input = bar()!.querySelector('form input') as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      await act(async () => { setter.call(input, 'Reception'); input.dispatchEvent(new Event('input', { bubbles: true })); });
      await act(async () => { input.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
      const created = lib.getState().albums[0].chapters.find((c: any) => c.title === 'Reception');
      expect(created.photoIds).toEqual(['p2', 'p3']);
    });
  });

  describe('"Run Smart Flow" on the selection bar', () => {
    let onRunSmartFlow: ReturnType<typeof vi.fn>;
    const flowBtn = () => Array.from(bar()!.querySelectorAll('button')).find((b) => b.textContent?.includes('Run Smart Flow')) as HTMLButtonElement | undefined;

    it('is not shown when the caller offers no Smart Flows handler', async () => {
      setAlbum();
      await act(async () => { root.render(React.createElement(AlbumsView, { photos, albums: lib.getState().albums, onSelectPhoto })); });
      await openAlbum();
      await act(async () => { checkbox(1).click(); });
      expect(flowBtn()).toBeUndefined();
    });

    it('appears on the selection bar and hands back the selected Photo objects', async () => {
      onRunSmartFlow = vi.fn();
      setAlbum();
      await act(async () => { root.render(React.createElement(AlbumsView, { photos, albums: lib.getState().albums, onSelectPhoto, onRunSmartFlow })); });
      await openAlbum();
      await act(async () => { checkbox(1).click(); });
      await act(async () => { checkbox(3).click(); });
      const btn = flowBtn()!;
      expect(btn).toBeTruthy();
      await act(async () => { btn.click(); });
      expect(onRunSmartFlow).toHaveBeenCalledTimes(1);
      expect(onRunSmartFlow.mock.calls[0][0].map((p: any) => p.id).sort()).toEqual(['p1', 'p3']);
    });
  });
});
