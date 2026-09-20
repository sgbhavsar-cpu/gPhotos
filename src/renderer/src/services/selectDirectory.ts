import { requestFolderBrowser } from './folderBrowserController';

/**
 * Resolves a folder path the user wants to point the app at: a native OS
 * folder dialog on real Electron, or the shared FolderBrowserModal (see
 * FolderBrowserModalHost, mounted once at the app root) everywhere else —
 * window.electronAPI.selectDirectory always resolves to null in the
 * browser/mobile client (browserShim.ts), since a browser has no way to
 * hand back an absolute filesystem path on the machine actually running the
 * server. Without a fallback here, every "browse for a folder" button
 * silently did nothing when clicked from a phone or another browser.
 *
 * Falls back further to a plain text prompt only if even the browse-dialog
 * capability is unavailable (e.g. a very old cached client bundle talking
 * to a newer/older server) — the browse dialog itself always tries first.
 */
export async function selectDirectoryOrPrompt(promptMessage: string, title?: string): Promise<string | null> {
  if (window.electronAPI?.selectDirectory && !window.electronAPI.isBrowserShim) {
    return window.electronAPI.selectDirectory();
  }
  if (window.electronAPI?.browseDirectory) {
    return requestFolderBrowser({ title });
  }
  const entered = window.prompt(promptMessage);
  return entered && entered.trim() ? entered.trim() : null;
}
