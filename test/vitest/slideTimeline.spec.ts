// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { SlideTimeline, timelineLayout, type TimelineItem } from '../../src/renderer/src/components/SlideTimeline';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const items: TimelineItem[] = [
  { id: 'a', kind: 'photo', label: 'A', seconds: 3, included: true },
  { id: 'b', kind: 'clip', label: 'B', seconds: 8, included: true },
  { id: 'c', kind: 'photo', label: 'C', seconds: 2, included: false },
  { id: 'd', kind: 'collage', label: 'D', seconds: 4, included: true },
];

describe('timelineLayout', () => {
  it('blocks are as wide as they are long, and a slide left out takes no time on the ruler', () => {
    const l = timelineLayout(items, 10);
    expect(l.map((x) => x.width)).toEqual([30, 80, 24, 40]); // 24 = minimum width so a short block is still clickable
    expect(l.map((x) => x.start)).toEqual([0, 3, 11, 11]);   // c is left out, so d starts where c would have
  });
});

describe('SlideTimeline', () => {
  let root: Root; let host: HTMLElement;
  beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
  afterEach(() => { act(() => root.unmount()); document.body.innerHTML = ''; });
  const mount = (props: Partial<React.ComponentProps<typeof SlideTimeline>> = {}) => {
    const p = { items, selectedId: null, onSelect: vi.fn(), onReorder: vi.fn(), onResize: vi.fn(), ...props };
    act(() => { root.render(React.createElement(SlideTimeline, p)); });
    return p;
  };
  const blocks = () => Array.from(host.querySelectorAll('[data-testid="timeline-block"]')) as HTMLElement[];

  it('shows a block per slide with the total length of the included ones', () => {
    mount();
    expect(blocks()).toHaveLength(4);
    expect(host.textContent).toContain('about 15.0 s'); // 3 + 8 + 4
  });

  it('clicking a block selects it', () => {
    const p = mount();
    act(() => { blocks()[1].click(); });
    expect(p.onSelect).toHaveBeenCalledWith('b');
  });

  it('dragging one block onto another reorders', () => {
    const p = mount();
    const fire = (el: HTMLElement, type: string) => act(() => { el.dispatchEvent(new Event(type, { bubbles: true, cancelable: true })); });
    fire(blocks()[0], 'dragstart');
    fire(blocks()[3], 'dragover');
    fire(blocks()[3], 'drop');
    expect(p.onReorder).toHaveBeenCalledWith(0, 3);
  });

  it('dragging the right edge of a photo block changes its time, in half seconds; a clip has no handle', () => {
    const p = mount();
    expect(blocks()[1].querySelector('[data-testid="timeline-resize"]')).toBeNull(); // clip: trim it instead
    const handle = blocks()[0].querySelector('[data-testid="timeline-resize"]') as HTMLElement;
    const ptr = (type: string, x: number) => act(() => { handle.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x })); });
    ptr('pointerdown', 100);
    ptr('pointermove', 172); // +72 px at 36 px/s = +2 s
    expect(p.onResize).toHaveBeenLastCalledWith('a', 5);
    ptr('pointermove', 0);   // far left: never below the minimum
    expect(p.onResize).toHaveBeenLastCalledWith('a', 0.5);
  });
});
