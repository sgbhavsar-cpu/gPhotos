import { useSyncExternalStore } from 'react';
import { authFetch } from './webAuthClient';
import { storageKeyForFile, isTaskPausedForKey } from './storageTasks';

/**
 * Deletes files ONE AT A TIME (so the UI never freezes on one huge IPC call), publishing a live log
 * for DeleteProgressModal. After the first failure it asks the user to abort or continue.
 */
export interface DeleteLine { path: string; status: 'deleting' | 'ok' | 'failed'; message?: string }
export interface DeleteState {
  total: number; done: number; current: string | null; lines: DeleteLine[];
  /** Set while waiting for the user to answer abort/continue after a failure. */
  prompt: { path: string; message: string } | null;
  finished: boolean;
}

let state: DeleteState | null = null;
let abortRequested = false;
let resolvePrompt: ((abort: boolean) => void) | null = null;
const listeners = new Set<() => void>();
const set = (s: DeleteState | null) => { state = s; listeners.forEach((l) => l()); };
const patch = (p: Partial<DeleteState>) => state && set({ ...state, ...p });

export const useDeleteState = () =>
  useSyncExternalStore((fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; }, () => state);
export const answerDeletePrompt = (abort: boolean) => { patch({ prompt: null }); resolvePrompt?.(abort); resolvePrompt = null; };
/** Stops after the photo currently being deleted (an in-flight delete can't be cancelled). */
export const abortDelete = () => { abortRequested = true; if (state?.prompt) answerDeletePrompt(true); };
export const closeDeleteWindow = () => set(null);

const PER_FILE_TIMEOUT_MS = 30000;
const timeout = <T,>(p: Promise<T>) => new Promise<T>((res, rej) => {
  const t = setTimeout(() => rej(new Error(`Timed out after ${PER_FILE_TIMEOUT_MS / 1000}s — the drive is not responding`)), PER_FILE_TIMEOUT_MS);
  p.then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); });
});

async function deleteOne(path: string, trash: boolean): Promise<{ ok: boolean; message?: string }> {
  try {
    if (trash && window.electronAPI?.trashFiles) {
      const r = await timeout(window.electronAPI.trashFiles([path]));
      return r.trashedPaths.includes(path) ? { ok: true } : { ok: false, message: r.errors[0] || 'Not moved to Recycle Bin' };
    }
    if (window.electronAPI?.deleteFilesPermanently) {
      const r = await timeout(window.electronAPI.deleteFilesPermanently([path]));
      return r.deletedPaths.includes(path) ? { ok: true } : { ok: false, message: r.errors[0] || 'Not deleted' };
    }
    const res = await authFetch('/api/delete-files', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePaths: [path], permanent: true }),
    });
    if (!res.ok) return { ok: false, message: `HTTP ${res.status}` };
    const body = await res.json().catch(() => null);
    return body && Array.isArray(body.deletedPaths) && !body.deletedPaths.includes(path)
      ? { ok: false, message: body.errors?.[0] || 'Not deleted' } : { ok: true };
  } catch (e: any) {
    return { ok: false, message: e?.message || String(e) };
  }
}

const CONCURRENCY = 5;

export async function deleteFilesWithProgress(paths: string[], opts: { trash?: boolean } = {}): Promise<{ deletedPaths: string[]; errors: string[]; aborted: boolean }> {
  const deletedPaths: string[] = [];
  const errors: string[] = [];
  let aborted = false;
  abortRequested = false;
  set({ total: paths.length, done: 0, current: null, lines: [], prompt: null, finished: false });

  // Background caching/face work on the same share slows every delete: pause it (main side, in memory only)
  // for the storages involved, unless the user already paused it, and restore afterwards.
  const temporarilyPaused: Array<[string, 'caching' | 'faces']> = [];
  for (const k of new Set(paths.map((p) => storageKeyForFile(p)).filter((k): k is string => !!k))) {
    for (const t of ['caching', 'faces'] as const) {
      if (isTaskPausedForKey(k, t)) continue;
      void window.electronAPI?.setStorageTaskPaused?.(k, t, true);
      temporarilyPaused.push([k, t]);
    }
  }

  // A few deletes in flight at once hide the per-file network latency; progress/abort stay per file.
  let next = 0;
  let done = 0;
  let gate: Promise<void> | null = null; // set while the abort/continue prompt is open
  const worker = async () => {
    while (!aborted) {
      if (gate) { await gate; continue; }
      if (abortRequested) { aborted = true; break; }
      if (next >= paths.length) break;
      const p = paths[next++];
      patch({ current: p, lines: [...state!.lines, { path: p, status: 'deleting' as const }].slice(-200) });
      const r = await deleteOne(p, !!opts.trash);
      const lines: DeleteLine[] = state!.lines.map((l) => (l.path === p && l.status === 'deleting' ? { path: p, status: r.ok ? 'ok' : 'failed', message: r.message } : l));
      patch({ lines, done: ++done });
      if (r.ok) { deletedPaths.push(p); continue; }
      errors.push(r.message || p);
      // Ask only on the FIRST failure; "Continue" then means continue for the rest of the batch.
      if (errors.length === 1 && next < paths.length) {
        patch({ prompt: { path: p, message: r.message || 'Unknown error' } });
        gate = new Promise<void>((open) => {
          resolvePrompt = (abort) => { if (abort) aborted = true; gate = null; open(); };
        });
        await gate;
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, paths.length) }, worker));
  } finally {
    for (const [k, t] of temporarilyPaused) void window.electronAPI?.setStorageTaskPaused?.(k, t, false);
  }
  if (errors.length === 0) set(null); // clean run: no need to keep the window open
  else patch({ current: null, finished: true });
  return { deletedPaths, errors, aborted };
}
