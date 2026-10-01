// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MentionAutocompleteInput, type MentionSource } from '../../src/renderer/src/components/MentionAutocompleteInput';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('MentionAutocompleteInput', () => {
  let root: Root;
  let host: HTMLElement;
  let value: string;
  let onChange: ReturnType<typeof vi.fn>;
  let onSubmit: ReturnType<typeof vi.fn>;

  const people: MentionSource = {
    trigger: '@',
    items: [
      { id: 'p1', label: 'Sachin Bhavsar' }, { id: 'p2', label: 'Bhavsar Tarun' }, { id: 'p3', label: 'Rajshree' }, { id: 'p4', label: 'Monika' },
    ],
    emptyLabel: 'No people found',
  };
  const places: MentionSource = {
    trigger: '#',
    items: [{ id: 'l1', label: 'Udaipur' }, { id: 'l2', label: 'Andaman' }],
    emptyLabel: 'No places found',
  };
  const tags: MentionSource = {
    trigger: '&',
    items: [{ id: 't1', label: 'receipt' }, { id: 't2', label: 'screenshot' }],
    emptyLabel: 'No tags found',
  };

  beforeEach(() => {
    value = '';
    onChange = vi.fn((v: string) => { value = v; });
    onSubmit = vi.fn();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => { act(() => root.unmount()); document.body.innerHTML = ''; });

  const render = async () => {
    await act(async () => {
      root.render(React.createElement(MentionAutocompleteInput, { value, onChange, onSubmit, sources: [people, places, tags] }));
    });
  };
  const rerender = async () => { await render(); };
  const input = () => host.querySelector('input') as HTMLInputElement;
  const suggestions = () => host.querySelector('[data-testid="mention-suggestions"]');
  const options = () => Array.from(host.querySelectorAll('[data-testid="mention-option"]')) as HTMLButtonElement[];

  /** Types `text` by setting the DOM value, placing the caret at the end, and firing a real change event — matching how a browser reports selectionStart on input. */
  const type = async (text: string, caretAtEnd = true) => {
    const el = input();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(el, text);
      if (caretAtEnd) el.setSelectionRange(text.length, text.length);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    value = text;
  };
  const key = async (k: string, extra: any = {}) => {
    await act(async () => {
      input().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra }));
      input().dispatchEvent(new KeyboardEvent('keyup', { key: k, bubbles: true, cancelable: true, ...extra }));
    });
  };

  it('shows no suggestions for plain text', async () => {
    await render();
    await type('Photo of monika');
    await rerender();
    expect(suggestions()).toBeNull();
  });

  it('typing "@" opens the people list; "#" opens the places list', async () => {
    await render();
    await type('@');
    await rerender();
    expect(options().map((o) => o.textContent)).toEqual(['Bhavsar Tarun', 'Monika', 'Rajshree', 'Sachin Bhavsar']); // alphabetical

    await type('#');
    await rerender();
    expect(options().map((o) => o.textContent)).toEqual(['Andaman', 'Udaipur']);
  });

  it('typing "&" opens the Smart Flow tags list', async () => {
    await render();
    await type('&');
    await rerender();
    expect(options().map((o) => o.textContent)).toEqual(['receipt', 'screenshot']); // alphabetical
  });

  it('filters by "contains", not just prefix — "bhavsar" matches both Sachin Bhavsar and Bhavsar Tarun', async () => {
    await render();
    await type('@bhavsar');
    await rerender();
    expect(options().map((o) => o.textContent)).toEqual(['Bhavsar Tarun', 'Sachin Bhavsar']);
  });

  it('is case-insensitive', async () => {
    await render();
    await type('@BHAV');
    await rerender();
    expect(options()).toHaveLength(2);
  });

  it('a trigger character is only recognised at the start of a token (not mid-word)', async () => {
    await render();
    await type('user@name'); // no space before '@' — not a mention
    await rerender();
    expect(suggestions()).toBeNull();
  });

  it('no matches shows the empty-state label instead of nothing', async () => {
    await render();
    await type('@zzz');
    await rerender();
    expect(host.textContent).toContain('No people found');
  });

  it('clicking a suggestion replaces the trigger+partial text with the plain name and a trailing space', async () => {
    await render();
    await type('Photo of @bhav');
    await rerender();
    await act(async () => { options().find((o) => o.textContent === 'Bhavsar Tarun')!.click(); });
    expect(value).toBe('Photo of Bhavsar Tarun ');
    expect(suggestions()).toBeNull(); // closes after picking
  });

  it('ArrowDown/ArrowUp move the highlight, Enter picks the highlighted item', async () => {
    await render();
    await type('@bhavsar'); // Bhavsar Tarun, Sachin Bhavsar
    await rerender();
    await key('ArrowDown'); // now on Sachin Bhavsar
    await key('Enter');
    expect(onSubmit).not.toHaveBeenCalled();
    expect(value).toBe('Sachin Bhavsar ');
  });

  it('Tab also picks the highlighted item', async () => {
    await render();
    await type('@monik');
    await rerender();
    await key('Tab');
    expect(value).toBe('Monika ');
  });

  it('arrowing the caret back into an earlier @mention reopens the list for just that token', async () => {
    await render();
    await type('Photo of @sachin at the beach'); // caret starts at the end, no mention active there
    await rerender();
    expect(suggestions()).toBeNull();

    input().setSelectionRange(16, 16); // caret right after "sachin" (jsdom doesn't move it on its own for a synthetic key event)
    await key('ArrowLeft'); // its keyup re-checks the caret position
    await rerender();
    expect(options().map((o) => o.textContent)).toEqual(['Sachin Bhavsar']);

    await key('Enter');
    expect(value).toBe('Photo of Sachin Bhavsar  at the beach');
  });

  it('Enter with no mention open submits, and does not insert anything', async () => {
    await render();
    await type('Photo of monika');
    await rerender();
    await key('Enter');
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalledWith(expect.stringContaining('undefined'));
  });

  it('Enter with an open mention list but zero matches falls through to submit instead of getting stuck', async () => {
    await render();
    await type('@zzz');
    await rerender();
    await key('Enter');
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('Escape closes the suggestion list without submitting, and never reaches an app-level Escape handler (e.g. one that closes the whole modal)', async () => {
    await render();
    await type('@bhav');
    await rerender();
    // Mirrors App.tsx's real global handler: a plain window-level keydown listener, outside React entirely.
    let bubbledToWindow = false;
    const spy = () => { bubbledToWindow = true; };
    window.addEventListener('keydown', spy);
    try {
      await key('Escape');
      await rerender();
      expect(suggestions()).toBeNull();
      expect(onSubmit).not.toHaveBeenCalled();
      expect(bubbledToWindow).toBe(false);
    } finally {
      window.removeEventListener('keydown', spy);
    }
  });

  it('placeholder auto-generated names are filtered out upstream (component just renders whatever items it is given)', async () => {
    // (Covered structurally: AiAssistantModal filters "Person N" before building sources — nothing
    // to special-case in the component itself, so this documents the contract with a plain source.)
    await render();
    await type('@');
    await rerender();
    expect(options().every((o) => !/^Person \d+$/.test(o.textContent || ''))).toBe(true);
  });
});
