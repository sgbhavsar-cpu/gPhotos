// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { TrimRange } from '../../src/renderer/src/components/TrimRange';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const setup = (start: number, end: number) => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const onChange = vi.fn();
  const root = createRoot(host);
  act(() => { root.render(React.createElement(TrimRange, { duration: 10, start, end, onChange })); });
  const input = (label: string) => host.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement;
  const set = (el: HTMLInputElement, v: string) => act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  return { input, set, onChange };
};

describe('TrimRange', () => {
  it('moving a handle reports the new start / end', () => {
    const { input, set, onChange } = setup(2, 8);
    set(input('Clip start'), '3');
    expect(onChange).toHaveBeenLastCalledWith(3, 8);
    set(input('Clip end'), '9');
    expect(onChange).toHaveBeenLastCalledWith(2, 9);
  });

  it('the handles cannot cross: at least half a second is kept', () => {
    const { input, set, onChange } = setup(2, 8);
    set(input('Clip start'), '9');
    expect(onChange).toHaveBeenLastCalledWith(7.5, 8);
    set(input('Clip end'), '1');
    expect(onChange).toHaveBeenLastCalledWith(2, 2.5);
  });
});
