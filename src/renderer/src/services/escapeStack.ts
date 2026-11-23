// One place decides what Escape does: the screen that most recently came to the front. Every dialog / overlay / selection that
// wants Escape registers a layer while it is showing (useEscapeLayer); this single window listener — attached when the module
// loads, so before any component's own listener — hands the key to the newest layer only and stops it going further. With no
// layer registered it does nothing, and the App's fallback handler (clear a filter, go back a tab) runs as usual.
import { useEffect, useRef } from 'react';

interface Layer { run: () => void; unlessTyping: boolean }
const stack: Layer[] = [];
const observers = new Set<() => void>();

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || !!(t as HTMLElement | null)?.isContentEditable;

if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    observers.forEach((o) => o());
    const top = stack[stack.length - 1];
    if (!top) return;
    // A layer that opted in leaves Escape to the text box being typed in (it cancels its own edit).
    if (top.unlessTyping && isTyping(e.target)) return;
    e.stopImmediatePropagation();
    top.run();
  }, { capture: true });
}

/** While `active`, this component is a layer on the Escape stack; Escape runs `onEscape` only when it is the front-most one. */
export function useEscapeLayer(active: boolean, onEscape: () => void, opts?: { unlessTyping?: boolean }): void {
  const cb = useRef(onEscape);
  cb.current = onEscape;
  const unlessTyping = !!opts?.unlessTyping;
  useEffect(() => {
    if (!active) return;
    const layer: Layer = { run: () => cb.current(), unlessTyping };
    stack.push(layer);
    return () => { const i = stack.indexOf(layer); if (i >= 0) stack.splice(i, 1); };
  }, [active, unlessTyping]);
}

/** Called on every Escape key press, whoever ends up handling it. Returns the unsubscribe function. */
export function observeEscape(fn: () => void): () => void {
  observers.add(fn);
  return () => { observers.delete(fn); };
}

/** Test helper: how many layers are registered. */
export const escapeLayerCount = () => stack.length;
