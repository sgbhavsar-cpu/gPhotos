// Single scalar preference, same localStorage-backed pattern as ollamaVisionService's config
// (getOllamaConfig/saveOllamaConfig) — no settings database needed for one string.
const STORAGE_KEY = 'gphotos_external_editor_path';

export function getExternalEditorPath(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

export function setExternalEditorPath(path: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, path.trim());
  } catch (e) {
    console.warn('Failed to save external editor path:', e);
  }
}
