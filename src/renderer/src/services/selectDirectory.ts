/**
 * Resolves a folder path the user wants to point the app at, using a native
 * OS folder dialog when running as real Electron, or a plain text prompt
 * when running over HTTP (mobile/LAN browser) — window.electronAPI.selectDirectory
 * always resolves to null there (browserShim.ts), since a browser has no way
 * to hand back an absolute filesystem path on the machine actually running
 * the server. Without this fallback, every "browse for a folder" button
 * silently did nothing at all when clicked from a phone or another browser.
 */
export async function selectDirectoryOrPrompt(promptMessage: string): Promise<string | null> {
  if (window.electronAPI?.selectDirectory && !window.electronAPI.isBrowserShim) {
    return window.electronAPI.selectDirectory();
  }
  const entered = window.prompt(promptMessage);
  return entered && entered.trim() ? entered.trim() : null;
}
