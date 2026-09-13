/**
 * webAuthClient.ts
 *
 * Handles the PIN-pairing session token used when the app is loaded over the
 * embedded LAN web server (mobile/browser mode) rather than inside Electron.
 * No-op in Electron, where window.electronAPI talks over IPC instead of HTTP.
 */

const TOKEN_STORAGE_KEY = 'gphotos_web_auth_token_v1';
export const AUTH_REQUIRED_EVENT = 'gphotos:auth-required';

export function isBrowserMode(): boolean {
  return (
    typeof window !== 'undefined' &&
    !!(window.electronAPI && (window.electronAPI as any).isBrowserShim)
  );
}

export function getStoredAuthToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setStoredAuthToken(token: string): void {
  try {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, token);
  } catch {}
}

export function clearStoredAuthToken(): void {
  try {
    window.localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {}
}

/** Appends the stored auth token as a query param, for URLs used directly in <img src>. */
export function appendAuthToken(url: string): string {
  if (!isBrowserMode()) return url;
  const token = getStoredAuthToken();
  if (!token) return url;
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}token=${encodeURIComponent(token)}`;
}

/**
 * fetch() wrapper for JSON/API calls in browser mode: attaches the bearer
 * token, and on a 401 clears the stale token and notifies the app so it can
 * re-show the PIN screen.
 */
export async function authFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const token = getStoredAuthToken();
  const headers = new Headers(init.headers || {});
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  const res = await fetch(input, { ...init, headers });
  if (res.status === 401 && isBrowserMode()) {
    clearStoredAuthToken();
    try {
      window.dispatchEvent(new CustomEvent(AUTH_REQUIRED_EVENT));
    } catch {}
  }
  return res;
}

export async function pairWithPin(pin: string): Promise<{ success: boolean; error?: string }> {
  try {
    const label = typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 80) : 'Unknown device';
    const res = await fetch('/api/auth/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin, deviceLabel: label }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.token) {
      return { success: false, error: data.error || 'Pairing failed' };
    }
    setStoredAuthToken(data.token);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message || 'Network error' };
  }
}

export async function checkAuthRequired(): Promise<boolean> {
  if (!isBrowserMode()) return false;
  try {
    const res = await fetch('/api/auth/status');
    if (!res.ok) return false;
    const data = await res.json();
    return !!data.pinRequired;
  } catch {
    return false;
  }
}

/** Verifies the currently stored token (if any) is still accepted by the server. */
export async function hasValidStoredToken(): Promise<boolean> {
  const token = getStoredAuthToken();
  if (!token) return false;
  try {
    const res = await authFetch('/api/auth/verify');
    return res.ok;
  } catch {
    return false;
  }
}
