// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { isPathInsideRoot, isValidFolderName, joinChildPath } from '../../src/renderer/src/services/pathUtils';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const B = String.fromCharCode(92);
const w = (...parts: string[]) => parts.join(B);

describe('path helpers for the restricted folder browser', () => {
  it('isPathInsideRoot: same folder or below, any separator or case, never a sibling with the same prefix', () => {
    const root = w('Z:', 'Photos');
    expect(isPathInsideRoot(root, root)).toBe(true);
    expect(isPathInsideRoot(w('Z:', 'Photos', '2024', 'Trip'), root)).toBe(true);
    expect(isPathInsideRoot('z:/photos/2024/', root + B)).toBe(true);
    expect(isPathInsideRoot(w('Z:', 'PhotosOld'), root)).toBe(false);
    expect(isPathInsideRoot(w('Z:'), root)).toBe(false);
    expect(isPathInsideRoot(null, root)).toBe(false);
    expect(isPathInsideRoot(root, '')).toBe(false);
  });
  it('isValidFolderName / joinChildPath', () => {
    for (const ok of ['Trip 2024', 'Ünïcode', 'a.b']) expect(isValidFolderName(ok)).toBe(true);
    for (const bad of ['', '  ', '.', '..', 'a/b', 'a' + B + 'b', 'a:b', 'x*', 'q?', 'a<b', 'trail.']) expect(isValidFolderName(bad)).toBe(false);
    expect(joinChildPath(w('Z:', 'Photos'), ' New ')).toBe(w('Z:', 'Photos', 'New'));
    expect(joinChildPath('/mnt/photos/', 'New')).toBe('/mnt/photos/New');
  });
});

describe('FolderBrowserModal in restricted mode', () => {
  let root: Root;
  let host: HTMLElement;
  const ROOT = w('Z:', 'Photos');
  const listings: Record<string, any> = {
    [ROOT]: { path: ROOT, parent: w('Z:'), entries: [{ name: 'Trips', path: w(ROOT, 'Trips') }] },
    [w(ROOT, 'Trips')]: { path: w(ROOT, 'Trips'), parent: ROOT, entries: [] },
    [w('Z:')]: { path: w('Z:'), parent: null, entries: [{ name: 'Photos', path: ROOT }, { name: 'Secret', path: w('Z:', 'Secret') }] },
  };
  const browse = vi.fn(async (p?: string) => listings[p || ''] || { path: p, parent: null, entries: [], error: 'nope' });

  beforeEach(() => {
    browse.mockClear();
    (window as any).electronAPI = { browseDirectory: browse };
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = '';
    delete (window as any).electronAPI;
  });

  const mountModal = async (props: Record<string, any>) => {
    const { FolderBrowserModal } = await import('../../src/renderer/src/components/FolderBrowserModal');
    const onSelect = vi.fn();
    await act(async () => {
      root.render(React.createElement(FolderBrowserModal, { onSelect, onCancel: vi.fn(), ...props } as any));
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    return onSelect;
  };
  const buttonByText = (t: string) => Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes(t)) as HTMLButtonElement;

  it('starts in the root, cannot go above it, and picks the current folder with a custom label', async () => {
    const onSelect = await mountModal({ restrictToRoot: ROOT, confirmLabel: 'Move Here' });
    expect(browse).toHaveBeenCalledWith(ROOT);
    const up = host.querySelector('button[title="Go up one level"]') as HTMLButtonElement;
    expect(up.disabled).toBe(true); // the parent (Z:\) is outside the root
    expect(host.textContent).toContain('Only folders inside');
    await act(async () => { buttonByText('Move Here').click(); });
    expect(onSelect).toHaveBeenCalledWith(ROOT);
  });

  it('can go up again from a sub-folder but never past the root', async () => {
    await mountModal({ restrictToRoot: ROOT, initialPath: w(ROOT, 'Trips') });
    const up = host.querySelector('button[title="Go up one level"]') as HTMLButtonElement;
    expect(up.disabled).toBe(false);
    await act(async () => { up.click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(browse).toHaveBeenLastCalledWith(ROOT);
    expect((host.querySelector('button[title="Go up one level"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('a path typed outside the root is not followed', async () => {
    await mountModal({ restrictToRoot: ROOT });
    const input = host.querySelector('input[placeholder^="Type or paste"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => { setter.call(input, w('Z:', 'Secret')); input.dispatchEvent(new Event('input', { bubbles: true })); });
    browse.mockClear();
    await act(async () => { buttonByText('Go').click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(browse).toHaveBeenCalledTimes(1);
    expect(browse).toHaveBeenCalledWith(ROOT); // sent back to the root instead of Z:\Secret
  });

  it('a new folder name becomes <current>/<name>; an invalid name blocks the button', async () => {
    const onSelect = await mountModal({ restrictToRoot: ROOT, allowNewFolder: true, confirmLabel: 'Move Here' });
    const name = host.querySelector('[data-testid="new-folder-name"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => { setter.call(name, 'Best of 2024'); name.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => { buttonByText('Move Here').click(); });
    expect(onSelect).toHaveBeenCalledWith(w(ROOT, 'Best of 2024'));

    onSelect.mockClear();
    await act(async () => { setter.call(name, 'bad/name'); name.dispatchEvent(new Event('input', { bubbles: true })); });
    expect(buttonByText('Move Here').disabled).toBe(true);
    await act(async () => { buttonByText('Move Here').click(); });
    expect(onSelect).not.toHaveBeenCalled();
  });
});
