// Per-storage run/pause control, fault state and a log ring buffer for the three background tasks
// (thumbnail caching, face detection, AI description). Keyed by the storage's mirror dir
// (path.join(localMirrorRoot, name), lower-cased) — the same key virtualMirrorService uses for activeSyncs.
// In-memory only: the renderer owns persistence of the user's pause choices and re-pushes them at startup.
import path from 'path';

export type StorageTask = 'caching' | 'faces' | 'ai';
export type TaskLogLevel = 'info' | 'warn' | 'error';
export interface TaskLogEntry { ts: number; task: StorageTask; level: TaskLogLevel; message: string }

const MAX_LOG = 500;
const paused = new Map<string, Set<StorageTask>>();
const faults = new Map<string, Partial<Record<StorageTask, string>>>();
const logs = new Map<string, TaskLogEntry[]>();
const knownKeys = new Set<string>();

export const registerStorageKeys = (keys: string[]) => keys.forEach((k) => knownKeys.add(k));
/** The registered storage whose mirror dir contains this file (background workers only know file paths). */
export function keyForFile(filePath: string | undefined): string | null {
  if (!filePath) return null;
  const p = filePath.toLowerCase();
  for (const k of knownKeys) if (p.startsWith(k + path.sep)) return k;
  return null;
}
/** Log against whichever storage owns this file; silently ignored for files outside any known storage. */
export function addFileTaskLog(filePath: string | undefined, task: StorageTask, level: TaskLogLevel, message: string): void {
  const k = keyForFile(filePath);
  if (k) addTaskLog(k, task, level, message);
}

export const storageKey = (localMirrorRoot: string, name: string) => path.join(localMirrorRoot, name).toLowerCase();

export function setTaskPaused(key: string, task: StorageTask, value: boolean): void {
  const set = paused.get(key) ?? new Set<StorageTask>();
  if (value) set.add(task); else set.delete(task);
  paused.set(key, set);
  addTaskLog(key, task, 'info', value ? 'Paused by user' : 'Resumed by user');
}

export const isTaskPaused = (key: string, task: StorageTask) => !!paused.get(key)?.has(task);

/** Blocks (cheap 500ms poll) while the task is paused for this storage. */
export async function waitWhileTaskPaused(key: string, task: StorageTask): Promise<void> {
  while (isTaskPaused(key, task)) await new Promise((r) => setTimeout(r, 500));
}

/** Passing undefined clears the fault. A fault is logged only when it changes, so a retry loop can't flood the log. */
export function setTaskFault(key: string, task: StorageTask, message?: string): void {
  const f = faults.get(key) ?? {};
  if (f[task] === message) return;
  if (message) f[task] = message; else delete f[task];
  faults.set(key, f);
  addTaskLog(key, task, message ? 'error' : 'info', message ? `Fault: ${message}` : 'Fault cleared');
}

export function addTaskLog(key: string, task: StorageTask, level: TaskLogLevel, message: string): void {
  knownKeys.add(key);
  const list = logs.get(key) ?? [];
  list.push({ ts: Date.now(), task, level, message });
  if (list.length > MAX_LOG) list.splice(0, list.length - MAX_LOG);
  logs.set(key, list);
}

export const getTaskControl = (key: string) => ({
  paused: Array.from(paused.get(key) ?? []),
  faults: { ...(faults.get(key) ?? {}) },
});

export const getTaskLogs = (key: string, task?: StorageTask): TaskLogEntry[] =>
  (logs.get(key) ?? []).filter((e) => !task || e.task === task);

/** True when filePath lies inside the storage's mirror dir (used to scope background queues per storage). */
export function isFileTaskPaused(filePath: string | undefined, task: StorageTask): boolean {
  if (!filePath) return false;
  const p = filePath.toLowerCase();
  for (const [key, set] of paused) if (set.has(task) && p.startsWith(key + path.sep)) return true;
  return false;
}
