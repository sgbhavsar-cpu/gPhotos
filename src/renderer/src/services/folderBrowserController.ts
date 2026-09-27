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
  /** Only this folder and the folders below it can be browsed to and chosen. */
  restrictToRoot?: string;
  /** Label of the confirm button (default "Select This Folder"). */
  confirmLabel?: string;
  /** One line of explanation shown under the title. */
  hint?: string;
  /** Show a "new folder" name box: the chosen path becomes <current folder>/<name>. */
  allowNewFolder?: boolean;
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
    // A newer request replaces the pending one: settle the old promise so its awaiting caller isn't stuck forever.
    activeResolve?.(null);
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
