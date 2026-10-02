// Local first pass for Smart Flows classification, via a locally-running Ollama server
// (default http://localhost:11434) — no photo leaves the machine for whatever this handles.
// Purely a speed/cost/privacy optimization: when Ollama or its models aren't available, callers
// just treat this tier as unavailable and fall back to the cloud tier, exactly as before this
// existed. Configurable (host, vision model, embedding model) from the Smart Flows modal.
import { ClassifyDescribeResult, buildBatchClassifyPrompt, parseBatchClassifyResponse } from './visionClassify';

export interface OllamaConfig {
  baseUrl: string;
  visionModel: string;
  embedModel: string;
  /**
   * The context window (in tokens) to request on local vision calls, and what Smart Flows' local
   * batch size is computed from — see resolveEffectiveContext / computeLocalBatchSize below. Set
   * this to whatever you've configured Ollama itself to allow (OLLAMA_CONTEXT_LENGTH, or a custom
   * Modelfile's `PARAMETER num_ctx`); gPhotos has no way to read that setting back from a running
   * Ollama server (confirmed against a real server: neither /api/show nor /api/tags reports it —
   * both only report the MODEL's own architectural maximum, not what the server is actually
   * configured to allow), so it has to be told rather than detected.
   */
  contextWindow: number;
}

const DEFAULT_CONFIG: OllamaConfig = {
  // 127.0.0.1, not "localhost": on a dual-stack machine "localhost" can resolve to ::1 first,
  // which — if something else is also listening on the IPv6 loopback on the same port (observed
  // in practice: Ollama's own tray app and a manually-started `ollama serve` both bound to 11434,
  // on different stacks, with different model sets) — silently talks to the WRONG server, which
  // looks identical to "no models installed" from here. Pinning to the literal IPv4 address avoids
  // that ambiguity entirely.
  baseUrl: 'http://127.0.0.1:11434',
  visionModel: 'qwen2.5vl:7b',
  embedModel: 'nomic-embed-text',
  // What a real local Ollama 0.32 server reported (via /api/ps) as the running context for a model
  // loaded with no explicit override — a safe, conservative starting point. Raise it in Settings to
  // match whatever you've actually configured Ollama itself to allow, for a bigger local batch size.
  contextWindow: 4096,
};
const STORAGE_KEY = 'gphotos_ollama_config_v1';

let cachedConfig: OllamaConfig | null = null;

export function getOllamaConfig(): OllamaConfig {
  if (cachedConfig) return cachedConfig;
  let loaded: OllamaConfig;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    loaded = raw ? { ...DEFAULT_CONFIG, ...JSON.parse(raw) } : { ...DEFAULT_CONFIG };
  } catch (e) {
    console.warn('Failed to read Ollama config from localStorage:', e);
    loaded = { ...DEFAULT_CONFIG };
  }
  cachedConfig = loaded;
  return loaded;
}

export function saveOllamaConfig(config: Partial<OllamaConfig>): OllamaConfig {
  cachedConfig = { ...getOllamaConfig(), ...config };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cachedConfig));
  } catch (e) {
    console.warn('Failed to save Ollama config to localStorage:', e);
  }
  return cachedConfig;
}

/** Trims trailing slashes so `${baseUrl}/api/...` never ends up with a doubled slash. */
const trimBaseUrl = (url: string) => url.replace(/\/+$/, '');

let lastError: string | null = null;
/** The most recent failure detail from a listing/download/classify call (e.g. "connection refused"), for showing the user what actually went wrong. */
export function getLastOllamaError(): string | null {
  return lastError;
}

interface OllamaAnswer {
  ok: boolean;
  status: number;
  data?: any;
  error?: string;
}

/**
 * One JSON call to Ollama. In the desktop app this is made by the MAIN process: the window is loaded
 * from file://, so a request made here would carry `Origin: null`, which Ollama answers with 403 —
 * that is why listing and downloading models failed in the packaged app while working in dev. The
 * direct fetch below is only the fallback for a plain browser / the dev server / tests.
 */
async function ollamaCall(apiPath: string, body: unknown | undefined, timeoutMs: number): Promise<OllamaAnswer> {
  const { baseUrl } = getOllamaConfig();
  const api = (typeof window !== 'undefined' ? window.electronAPI : undefined) as any;
  if (api?.ollamaRequest && !api.isBrowserShim) {
    const answer: OllamaAnswer = await api.ollamaRequest({ baseUrl, path: apiPath, method: body === undefined ? 'GET' : 'POST', body, timeoutMs });
    lastError = answer.ok ? null : answer.error || `HTTP ${answer.status}`;
    return answer;
  }

  try {
    const res = await fetch(`${trimBaseUrl(baseUrl)}${apiPath}`, {
      method: body === undefined ? 'GET' : 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
    if (!res.ok) {
      const text = typeof res.text === 'function' ? await res.text() : '';
      lastError = text || `HTTP ${res.status}`;
      return { ok: false, status: res.status, error: lastError };
    }
    lastError = null;
    return { ok: true, status: res.status, data: await res.json() };
  } catch (err: any) {
    lastError = err?.message || String(err);
    return { ok: false, status: 0, error: lastError || undefined };
  }
}

/** Whether Ollama is reachable and has the configured vision model pulled. Never throws. */
export async function isVisionAvailable(): Promise<boolean> {
  const { visionModel } = getOllamaConfig();
  const models = await listModels();
  return models.some((m) => m.name === visionModel);
}

export interface OllamaModelInfo {
  name: string;
  sizeBytes: number;
  /** e.g. "vision", "embedding", "completion" — absent/empty on older Ollama servers that don't report it. */
  capabilities: string[];
}

/** Every model Ollama currently has pulled, with whatever capability info it reports. Never throws; [] when unreachable. */
export async function listModels(): Promise<OllamaModelInfo[]> {
  const answer = await ollamaCall('/api/tags', undefined, 3000);
  if (!answer.ok) return [];
  const models: Array<{ name?: string; model?: string; size?: number; capabilities?: string[] }> = answer.data?.models || [];
  return models.map((m) => ({
    name: m.name || m.model || '',
    sizeBytes: m.size || 0,
    capabilities: Array.isArray(m.capabilities) ? m.capabilities : [],
  })).filter((m) => m.name);
}

/**
 * The model's own architectural maximum context (from its GGUF metadata via /api/show) — a hard
 * ceiling, never what the server is actually configured to allow at runtime. Confirmed against a
 * real server: qwen2.5vl:7b reports 128000 here regardless of the server's actual OLLAMA_CONTEXT_LENGTH.
 * Never throws; null when the model/server info isn't available (unreachable, or an older Ollama
 * that doesn't report model_info at all) — callers fall back to trusting the configured value alone.
 */
export async function getModelMaxContext(modelName: string): Promise<number | null> {
  const answer = await ollamaCall('/api/show', { model: modelName }, 5000);
  if (!answer.ok) return null;
  const info: Record<string, unknown> = answer.data?.model_info || {};
  for (const [key, value] of Object.entries(info)) {
    if (key.endsWith('.context_length') && typeof value === 'number' && value > 0) return value;
  }
  return null;
}

/**
 * The context window to actually request: the configured value (Settings → Local AI Model →
 * Context Window — what you told gPhotos you set in Ollama), capped at the model's own real
 * maximum so a stale/mistaken setting can never ask for more than the model architecturally
 * supports. Never throws — a lookup failure just means the configured value is trusted as-is.
 */
export async function resolveEffectiveContext(config: OllamaConfig): Promise<number> {
  const configured = Math.max(512, config.contextWindow || DEFAULT_CONFIG.contextWindow);
  const modelMax = await getModelMaxContext(config.visionModel);
  return modelMax ? Math.min(configured, modelMax) : configured;
}

// Roughly what one photo costs in a local classify call, at the 512px thumbnail Smart Flows sends
// (see smartFlowsService.ts's toBase64): ~300 vision tokens for qwen2.5vl-class patching of a
// 512px-class image, + ~60 tokens for that photo's slice of the JSON response.
const TOKENS_PER_IMAGE = 360;
// The classify prompt itself + Ollama's chat-template scaffolding.
const FIXED_PROMPT_TOKENS = 350;
// Reserve headroom rather than sizing right to the edge of the context.
const CONTEXT_SAFETY_MARGIN = 0.9;
// Pinned to 1 — multi-image local batches are NOT reliable enough to trust the caption/tags this
// writes silently into the shared cache (photoContentCache), which every Smart Flow and the AI Info
// panel then display as fact with no human review in between. This used to be up to 20, with a
// self-reported per-image "image" index (visionClassify.parseBatchClassifyResponse) meant to catch a
// scrambled response order — but that mitigation only works when the model's self-reported indices
// are themselves correct. Confirmed via a real user report (two adjacent photos, each showing a
// caption that actually described a DIFFERENT photo in the same run) that a small (7B-class) local
// model can return a well-formed, correctly-sized, plausibly-indexed response that is nevertheless
// wrong — conflating which photo is which. One photo per local call makes that entire class of bug
// structurally impossible: there is no second image in the request for the model to confuse the
// first one with. The real cost is throughput (N calls instead of one batched call); correctness
// clearly outweighs it for data this is trusted at face value. See docs/FEATURE_AI_AUTO_TAGGING.md.
const MAX_LOCAL_BATCH_SIZE = 1;

/** How many photos fit in one local classify call at the given context window. Pinned to 1 — see
 *  MAX_LOCAL_BATCH_SIZE's doc comment for why. The context-window-based math below is kept (rather
 *  than deleted) as the sizing this would use again if a future, more reliable local model warrants
 *  re-enabling batching; for now `effectiveContext` only affects the single call's own token budget
 *  (resolveEffectiveContext / num_ctx), not how many photos go into it. */
export function computeLocalBatchSize(effectiveContext: number): number {
  const usable = effectiveContext * CONTEXT_SAFETY_MARGIN - FIXED_PROMPT_TOKENS;
  const byContext = Math.floor(usable / TOKENS_PER_IMAGE);
  return Math.max(1, Math.min(MAX_LOCAL_BATCH_SIZE, byContext));
}

export interface OllamaPullProgress {
  status: string;
  completed?: number;
  total?: number;
}

/**
 * Downloads a model via Ollama's own streaming pull API, reporting progress as it goes. Never
 * throws — callers get back which of the three ways it ended instead (`getLastOllamaError()` says why
 * a failure happened). Pass `signal` to let the user cancel a large download in progress.
 */
export async function pullModel(
  modelName: string,
  onProgress?: (p: OllamaPullProgress) => void,
  signal?: AbortSignal
): Promise<'success' | 'failed' | 'cancelled'> {
  const { baseUrl } = getOllamaConfig();
  const api = (typeof window !== 'undefined' ? window.electronAPI : undefined) as any;

  if (api?.ollamaPull && !api.isBrowserShim) {
    lastError = null;
    const unsubscribe = api.onOllamaPullProgress?.((p: any) => { if (p.model === modelName) onProgress?.(p); });
    const onAbort = () => { api.ollamaCancelPull?.(modelName); };
    signal?.addEventListener('abort', onAbort);
    try {
      const outcome: { result: 'success' | 'failed' | 'cancelled'; error?: string } = await api.ollamaPull(baseUrl, modelName);
      lastError = outcome.result === 'failed' ? outcome.error || 'The download failed.' : null;
      return outcome.result;
    } catch (err: any) {
      lastError = err?.message || String(err);
      return 'failed';
    } finally {
      signal?.removeEventListener('abort', onAbort);
      try { unsubscribe?.(); } catch {}
    }
  }

  // Fallback (plain browser / dev server): stream straight from here.
  try {
    const res = await fetch(`${trimBaseUrl(baseUrl)}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelName, stream: true }),
      signal,
    });
    if (!res.ok || !res.body) {
      lastError = `HTTP ${res.status}`;
      return 'failed';
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // the last line may be a partial chunk — keep it for next time
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const evt = JSON.parse(line);
          if (evt.error) {
            lastError = String(evt.error);
            return 'failed';
          }
          onProgress?.(evt);
        } catch {
          // a stray non-JSON line — ignore it rather than fail the whole download over it
        }
      }
    }
    lastError = null;
    return 'success';
  } catch (err: any) {
    if (err?.name === 'AbortError') return 'cancelled';
    lastError = err?.message || String(err);
    return 'failed';
  }
}

/**
 * Same question, same batch, same response contract as the cloud tier (aiSearchService) — one
 * label message per image, then a final instruction turn asking for a JSON array in order.
 *
 * `numCtx`, if given, is what's actually sent as the request's context window — pass whatever
 * resolveEffectiveContext() returned when the caller (smartFlowsService.ts) sized the batch, so the
 * context requested here and the context the batch size was computed from are always the exact same
 * number and can never drift apart. Left unset, it's resolved fresh (one extra /api/show call) —
 * kept as a fallback so this function still works correctly called on its own, e.g. in tests.
 */
export async function classifyImagesBatchLocal(
  items: Array<{ base64: string; mimeType: string }>,
  description: string,
  numCtx?: number
): Promise<ClassifyDescribeResult[]> {
  if (items.length === 0) return [];
  const config = getOllamaConfig();
  const { visionModel } = config;
  const messages = items.flatMap((item, i) => [{ role: 'user', content: `Image ${i + 1}:`, images: [item.base64] }]);
  messages.push({ role: 'user', content: buildBatchClassifyPrompt(items.length, description) } as any);

  const effectiveContext = numCtx ?? (await resolveEffectiveContext(config));

  // Timeout scales with the batch: a bigger batch genuinely takes longer to encode+generate than a
  // small one did, and a batch that legitimately needs the extra time must not be cut off
  // mid-generation only to look like a model/parsing failure.
  const timeoutMs = Math.max(120000, items.length * 12000);
  const answer = await ollamaCall('/api/chat', { model: visionModel, messages, stream: false, options: { temperature: 0, num_ctx: effectiveContext } }, timeoutMs);
  if (!answer.ok) throw new Error(`Ollama error (${answer.status}): ${answer.error || 'no details'}`);

  const raw = answer.data?.message?.content;
  if (!raw) throw new Error('Ollama returned an empty response.');
  // Small local models sometimes wrap the array in prose or a markdown fence despite instructions —
  // pull out the first [...] block rather than failing the whole batch over stray text.
  const match = raw.match(/\[[\s\S]*\]/);
  return parseBatchClassifyResponse(match ? match[0] : raw, items.length);
}

/** A text embedding for local semantic matching (photoContentCache's RAG index), or null if Ollama/the model isn't available. Never throws. */
export async function embedText(text: string): Promise<number[] | null> {
  const { embedModel } = getOllamaConfig();
  const answer = await ollamaCall('/api/embed', { model: embedModel, input: text }, 15000);
  if (!answer.ok) return null;
  const vec = answer.data?.embeddings?.[0];
  return Array.isArray(vec) && vec.length > 0 ? vec : null;
}
