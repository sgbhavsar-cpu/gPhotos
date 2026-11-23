// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DeletePersonDialog } from '../../src/renderer/src/components/DeletePersonDialog';
import { ResetFacesDialog } from '../../src/renderer/src/components/ResetFacesDialog';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
const q = (host: HTMLElement, id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement;

describe('face dialogs', () => {
  let host: HTMLElement; let root: Root;
  beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
  afterEach(() => { act(() => root.unmount()); document.body.innerHTML = ''; delete (window as any).electronAPI; });

  it('delete person: "look again" is on by default, can be unticked, and Escape cancels', async () => {
    const onConfirm = vi.fn(), onCancel = vi.fn();
    await act(async () => { root.render(React.createElement(DeletePersonDialog, { personName: 'Ann', faceCount: 12, onConfirm, onCancel })); });
    expect(host.textContent).toContain('12 faces');
    const box = q(host, 'delete-person-rematch') as HTMLInputElement;
    expect(box.checked).toBe(true);
    await act(async () => { q(host, 'delete-person-confirm').click(); });
    expect(onConfirm).toHaveBeenLastCalledWith(true);
    await act(async () => { box.click(); });
    await act(async () => { q(host, 'delete-person-confirm').click(); });
    expect(onConfirm).toHaveBeenLastCalledWith(false);
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  const mountReset = async (isOneDrive: boolean, onConfirm = vi.fn()) => {
    (window as any).electronAPI = { previewFaceReset: vi.fn(async () => ({ success: true, total: 1000, confirmed: 120 })) };
    await act(async () => { root.render(React.createElement(ResetFacesDialog, { storageName: 'onedrivephoto', isOneDrive, onConfirm, onCancel: vi.fn() })); });
    await flush();
    return onConfirm;
  };

  it('reset: shows what will be deleted and kept, and the tick boxes decide the extras', async () => {
    const onConfirm = await mountReset(false);
    expect(q(host, 'reset-faces-counts').textContent).toContain('880');
    expect(q(host, 'reset-faces-counts').textContent).toContain('120');
    expect(q(host, 'reset-faces-counts').textContent).toContain('will be kept');
    expect((q(host, 'reset-start-scanning') as HTMLInputElement).checked).toBe(true); // local: scanning on
    await act(async () => { q(host, 'reset-delete-confirmed').click(); });
    expect(q(host, 'reset-faces-counts').textContent).toContain('1,000');
    expect(q(host, 'reset-faces-counts').textContent).toContain('will be deleted too');
    await act(async () => { q(host, 'reset-faces-confirm').click(); });
    expect(onConfirm).toHaveBeenCalledWith({ deleteConfirmed: true, startScanning: true });
  });

  it('reset: OneDrive-backed storages default to NOT scanning again', async () => {
    const onConfirm = await mountReset(true);
    expect((q(host, 'reset-start-scanning') as HTMLInputElement).checked).toBe(false);
    expect(host.textContent).toContain('downloads the original photos again');
    await act(async () => { q(host, 'reset-faces-confirm').click(); });
    expect(onConfirm).toHaveBeenCalledWith({ deleteConfirmed: false, startScanning: false });
  });

  it('reset: the button stays disabled when the face data cannot be read', async () => {
    (window as any).electronAPI = { previewFaceReset: vi.fn(async () => ({ success: false, error: 'This storage has no face database yet.' })) };
    await act(async () => { root.render(React.createElement(ResetFacesDialog, { storageName: 'x', isOneDrive: false, onConfirm: vi.fn(), onCancel: vi.fn() })); });
    await flush();
    expect(host.textContent).toContain('no face database yet');
    expect((q(host, 'reset-faces-confirm') as HTMLButtonElement).disabled).toBe(true);
  });
});
