import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Nearest ancestor (starting at `start`) that scrolls vertically. An element carrying
 * `data-no-vscroll` is skipped: `overflow-x: auto` computes `overflow-y: auto` too, but such
 * a horizontal-scroll wrapper has no height limit and never scrolls vertically.
 */
export function findScrollParent(start: HTMLElement | null): HTMLElement | null {
  for (let el = start; el; el = el.parentElement) {
    if (el.dataset?.noVscroll !== undefined) continue;
    const oy = getComputedStyle(el).overflowY;
    if (oy === 'auto' || oy === 'scroll') return el;
  }
  return null;
}

/**
 * For virtualised lists whose scroller is an ancestor we don't own (e.g. the outer pane on
 * mobile). Put `anchorRef` on any element inside the scroller (or the scroller itself) and pass
 * `scrollRef` to VirtualCardGrid. A callback ref, so it also resolves when the anchor mounts
 * late (conditional rendering) — before the grid's effects run.
 */
export function useScrollParent<T extends HTMLElement = HTMLDivElement>(dep?: unknown) {
  const scrollRef = useRef<HTMLElement | null>(null);
  const anchorRef = useCallback(
    (el: T | null) => {
      scrollRef.current = el ? findScrollParent(el) ?? el : null;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dep]
  );
  return { anchorRef, scrollRef };
}

/** `value`, but only updated after it has been stable for `delayMs` (keystroke debounce). */
export function useDebouncedValue<T>(value: T, delayMs = 200): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    if (value === debounced) return;
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs, debounced]);
  return debounced;
}
