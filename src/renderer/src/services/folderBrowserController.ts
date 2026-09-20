/**
 * Lets selectDirectoryOrPrompt() (called from several unrelated view
 * components) trigger the single shared <FolderBrowserModalHost/> mounted
 * once at the app root, without each caller having to manage its own modal
 * state — request/resolve here, the host just renders whatever the latest
 * pending request is.
 */
export interface FolderBrowserRequest {
  title?: string;
  initialPath?: string;
}

type Listener = (request: FolderBrowserRequest | null) => void;

let activeResolve: ((path: string | null) => void) | null = null;
let listeners: Listener[] = [];

export function subscribeFolderBrowser(listener: Listener): () => void {
  listeners.push(listener);
  return () => {
    listeners = listeners.filter((l) => l !== listener);
  };
}

export function requestFolderBrowser(request?: FolderBrowserRequest): Promise<string | null> {
  return new Promise((resolve) => {
    activeResolve = resolve;
    listeners.forEach((l) => l(request || {}));
  });
}

export function resolveFolderBrowser(path: string | null): void {
  const resolve = activeResolve;
  activeResolve = null;
  listeners.forEach((l) => l(null));
  resolve?.(path);
}
