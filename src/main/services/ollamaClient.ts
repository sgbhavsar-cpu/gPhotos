// All traffic to a local Ollama server goes through here (the main process), never straight from the
// renderer. The packaged app's window is loaded from file://, so a renderer fetch carries
// `Origin: null`, which Ollama rejects with 403 (its default allow-list is localhost/127.0.0.1/file://-ish
// origins, not "null") — listing models and downloading them both failed for that reason. Node's fetch
// sends no Origin header at all, so the check never applies.

export interface OllamaRequest {
  baseUrl: string;
  /** Must start with /api/ (e.g. /api/tags). */
  path: string;
  method?: 'GET' | 'POST';
  body?: unknown;
  timeoutMs?: number;
}

export interface OllamaResponse {
  ok: boolean;
  status: number;
  data?: any;
  error?: string;
}

export interface OllamaPullEvent {
  status: string;
  completed?: number;
  total?: number;
  digest?: string;
}

export type OllamaPullResult = { result: 'success' | 'failed' | 'cancelled'; error?: string };

/** Validates and builds the request URL; throws a readable Error for anything that is not an http(s) Ollama /api/ call. */
export function ollamaEndpoint(baseUrl: string, apiPath: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(`"${baseUrl}" is not a valid Ollama address (expected something like http://127.0.0.1:11434).`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('The Ollama address must start with http:// or https://.');
  if (typeof apiPath !== 'string' || !apiPath.startsWith('/api/') || apiPath.includes('..')) throw new Error('Only Ollama /api/ endpoints can be called.');
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}${apiPath}`;
}

function describeNetworkError(err: any): string {
  const code = err?.cause?.code || err?.code;
  if (code === 'ECONNREFUSED') return 'Could not connect to Ollama — is it running? (connection refused)';
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return 'Ollama did not answer in time.';
  return err?.cause?.message || err?.message || String(err);
}

/** A plain JSON request/response call. Never throws — failures come back as `{ ok: false, error }`. */
export async function ollamaRequest(req: OllamaRequest): Promise<OllamaResponse> {
  try {
    const url = ollamaEndpoint(req.baseUrl, req.path);
    const res = await fetch(url, {
      method: req.method || (req.body === undefined ? 'GET' : 'POST'),
      headers: req.body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: req.body === undefined ? undefined : JSON.stringify(req.body),
      signal: AbortSignal.timeout(req.timeoutMs ?? 30000),
    });
    const text = await res.text();
    let data: any;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = undefined;
    }
    if (!res.ok) return { ok: false, status: res.status, data, error: data?.error || text.slice(0, 300) || `HTTP ${res.status}` };
    return { ok: true, status: res.status, data };
  } catch (err: any) {
    return { ok: false, status: 0, error: describeNetworkError(err) };
  }
}

/**
 * Downloads a model with Ollama's streaming pull API, calling `onEvent` for every progress line.
 * Never throws; `signal` cancels a download in progress.
 */
export async function ollamaPull(
  baseUrl: string,
  model: string,
  onEvent: (e: OllamaPullEvent) => void,
  signal?: AbortSignal
): Promise<OllamaPullResult> {
  try {
    if (!model || typeof model !== 'string') return { result: 'failed', error: 'No model name given.' };
    const url = ollamaEndpoint(baseUrl, '/api/pull');
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream: true }),
      signal,
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      let msg = text.slice(0, 300);
      try { msg = JSON.parse(text)?.error || msg; } catch {}
      return { result: 'failed', error: msg || `HTTP ${res.status}` };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // the last line may be cut mid-way — finish it with the next chunk
      for (const line of lines) {
        if (!line.trim()) continue;
        let evt: any;
        try {
          evt = JSON.parse(line);
        } catch {
          continue; // a stray non-JSON line must not fail a multi-GB download
        }
        if (evt.error) return { result: 'failed', error: String(evt.error) };
        onEvent(evt);
      }
    }
    return { result: 'success' };
  } catch (err: any) {
    if (signal?.aborted || err?.name === 'AbortError') return { result: 'cancelled' };
    return { result: 'failed', error: describeNetworkError(err) };
  }
}
