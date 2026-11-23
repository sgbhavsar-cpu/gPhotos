// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { useEscapeLayer, escapeLayerCount, observeEscape } from '../../src/renderer/src/services/escapeStack';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const Layer = ({ on, fn }: { on: boolean; fn: () => void }) => { useEscapeLayer(on, fn); return null; };
const esc = () => act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });

describe('escape stack', () => {
  it('only the front-most layer gets Escape, then the one below, and nothing leaks to older listeners', async () => {
    const host = document.createElement('div'); document.body.appendChild(host);
    const root = createRoot(host);
    const a = vi.fn(), b = vi.fn(), legacy = vi.fn();
    window.addEventListener('keydown', legacy, { capture: true }); // an older-style listener attached later
    const render = (aOn: boolean, bOn: boolean) => act(async () => { root.render(React.createElement(React.Fragment, null, React.createElement(Layer, { on: aOn, fn: a }), React.createElement(Layer, { on: bOn, fn: b }))); });
    await render(true, false);
    await render(true, true);
    expect(escapeLayerCount()).toBe(2);
    await esc();
    expect(b).toHaveBeenCalledTimes(1); expect(a).not.toHaveBeenCalled();
    await render(true, false);
    await esc();
    expect(a).toHaveBeenCalledTimes(1);
    expect(legacy).not.toHaveBeenCalled();
    await render(false, false);
    expect(escapeLayerCount()).toBe(0);
    await esc();
    expect(legacy).toHaveBeenCalledTimes(1); // with no layers, Escape reaches the ordinary handlers again
    window.removeEventListener('keydown', legacy, { capture: true });
    act(() => root.unmount());
  });

  it('a layer registered later is in front even if it re-renders with a new handler', async () => {
    const host = document.createElement('div'); document.body.appendChild(host);
    const root = createRoot(host);
    const first = vi.fn(), second1 = vi.fn(), second2 = vi.fn();
    await act(async () => { root.render(React.createElement(React.Fragment, null, React.createElement(Layer, { on: true, fn: first }), React.createElement(Layer, { on: true, fn: second1 }))); });
    await act(async () => { root.render(React.createElement(React.Fragment, null, React.createElement(Layer, { on: true, fn: first }), React.createElement(Layer, { on: true, fn: second2 }))); });
    await esc();
    expect(second2).toHaveBeenCalledTimes(1); expect(second1).not.toHaveBeenCalled(); expect(first).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it('a layer that opts in leaves Escape to a text box being typed in; observers hear every Escape', async () => {
    const host = document.createElement('div'); document.body.appendChild(host);
    const root = createRoot(host);
    const fn = vi.fn(), seen = vi.fn();
    const stop = observeEscape(seen);
    const Typing = () => { useEscapeLayer(true, fn, { unlessTyping: true }); return React.createElement('input'); };
    await act(async () => { root.render(React.createElement(Typing)); });
    const input = host.querySelector('input') as HTMLInputElement;
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(fn).not.toHaveBeenCalled();
    expect(seen).toHaveBeenCalledTimes(1);
    await esc();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenCalledTimes(2);
    stop();
    act(() => root.unmount());
  });
});
