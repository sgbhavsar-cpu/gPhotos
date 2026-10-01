// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PromptModal } from '../../src/renderer/src/components/PromptModal';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('PromptModal', () => {
  let root: Root;
  let host: HTMLElement;
  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = '';
  });

  const mount = async (props: Partial<React.ComponentProps<typeof PromptModal>> = {}) => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    await act(async () => {
      root.render(React.createElement(PromptModal, { title: 'New Chapter', onSubmit, onCancel, ...props }));
    });
    return { onSubmit, onCancel };
  };

  it('submitting with typed text calls onSubmit with the trimmed value', async () => {
    const { onSubmit } = await mount({ initialValue: '' });
    const input = host.querySelector('input') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => { setter.call(input, '  Day 1 — Ceremony  '); input.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(onSubmit).toHaveBeenCalledWith('Day 1 — Ceremony');
  });

  it('the confirm button is disabled for empty/whitespace-only input', async () => {
    await mount({ initialValue: '   ' });
    const confirmBtn = Array.from(host.querySelectorAll('button')).find((b) => b.type === 'submit') as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);
  });

  it('Cancel button and clicking the backdrop both call onCancel without submitting', async () => {
    const { onCancel, onSubmit } = await mount({ initialValue: 'x' });
    const cancelBtn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Cancel') as HTMLButtonElement;
    await act(async () => { cancelBtn.click(); });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('Escape calls onCancel', async () => {
    const { onCancel } = await mount({ initialValue: 'x' });
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('renders the optional message and a custom confirm label', async () => {
    await mount({ message: 'e.g. "Day 1"', confirmLabel: 'Create' });
    expect(host.textContent).toContain('e.g. "Day 1"');
    expect(Array.from(host.querySelectorAll('button')).some((b) => b.textContent === 'Create')).toBe(true);
  });
});
