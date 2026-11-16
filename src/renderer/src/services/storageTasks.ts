// Renderer side of per-storage task control (see src/main/services/storageTaskControl.ts).
// The user's pause choices are persisted here (localStorage) and mirrored to the main process,
// which gates the sync pipeline / thumbnail worker. Face queue + AI auto-index consult this directly.
export type StorageTask = 'caching' | 'faces' | 'ai';

const PAUSED_KEY = 'gphotos_storage_task_paused_v1';
const KNOWN_KEY = 'gphotos_storage_known_keys_v1';

const read = <T,>(key: string, fallback: T): T => {
  try { return JSON.parse(localStorage.getItem(key) || '') as T; } catch { return fallback; }
};
const write = (key: string, v: unknown) => { try { localStorage.setItem(key, JSON.stringify(v)); } catch {} };

let paused: Record<string, StorageTask[]> = read(PAUSED_KEY, {});
let known: string[] = read(KNOWN_KEY, []);
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
export const subscribeStorageTasks = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

// Windows app: normalise to backslashes + lower case, which is what path.join(...).toLowerCase() gives in main.
const norm = (p: string) => p.replace(/\//g, '\\').toLowerCase();
/** Same key the main process uses: mirror dir, normalised. */
export const storageTaskKey = (localMirrorRoot: string, name: string) => norm(`${localMirrorRoot.replace(/[\\/]+$/, '')}\\${name}`);

export const isTaskPausedForKey = (key: string, task: StorageTask) => !!paused[key]?.includes(task);

export function setTaskPaused(key: string, task: StorageTask, value: boolean): void {
  const set = new Set(paused[key] || []);
  if (value) set.add(task); else set.delete(task);
  paused = { ...paused, [key]: Array.from(set) };
  write(PAUSED_KEY, paused);
  void window.electronAPI?.setStorageTaskPaused?.(key, task, value);
  notify();
}

/** Remember storages so background tasks can attribute photos to them; also re-pushes pause state to main. */
export function registerStorages(keys: string[]): void {
  known = Array.from(new Set([...known, ...keys]));
  write(KNOWN_KEY, known);
  void window.electronAPI?.registerStorageTaskKeys?.(known);
  pushPausedToMain();
}

/** Main holds pause state in memory only — call at startup and whenever storages load. */
export function pushPausedToMain(): void {
  for (const [key, tasks] of Object.entries(paused)) {
    for (const t of tasks) void window.electronAPI?.setStorageTaskPaused?.(key, t, true);
  }
}

/** The registered storage key whose mirror dir contains this file, if any. */
export function storageKeyForFile(filePath: string | undefined): string | null {
  if (!filePath) return null;
  const p = norm(filePath);
  return known.find((k) => p.startsWith(k + '\\')) ?? null;
}

export const isFileTaskPaused = (filePath: string | undefined, task: StorageTask) => {
  const k = storageKeyForFile(filePath);
  return !!k && isTaskPausedForKey(k, task);
};

/** Report/clear a fault for a task on every known storage (used for global dependencies like Ollama). */
export function setFaultForAll(task: StorageTask, message?: string): void {
  for (const k of known) void window.electronAPI?.setStorageTaskFault?.(k, task, message);
}

export const logForFile = (filePath: string | undefined, task: StorageTask, level: 'info' | 'warn' | 'error', message: string) => {
  const k = storageKeyForFile(filePath);
  if (k) void window.electronAPI?.logStorageTask?.(k, task, level, message);
};

// Main only learns storage keys when told; do it at startup so background workers can attribute log lines.
if (known.length) { void window.electronAPI?.registerStorageTaskKeys?.(known); pushPausedToMain(); }
