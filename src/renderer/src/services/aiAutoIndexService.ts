// Background AI auto-tagging — see docs/FEATURE_AI_AUTO_TAGGING.md. Keeps every photo described
// and tagged via the LOCAL Ollama model only (no cloud fallback — see the doc's §2.3 for why),
// so Search with AI's '&tag' matching (and any future caption-text search) works library-wide
// without the user ever running a manual Smart Flow. "Already done" is just "has a photoContentCache
// entry with a caption" — no separate checkpoint file, so a restart resumes for free and a later
// manual Smart Flow run on the same photo is also a free cache hit.
import type { Photo } from '../../../types';
import { ensureLoaded, getEntry, recordFinding } from './photoContentCache';
import { isVisionAvailable, classifyImagesBatchLocal, embedText, getOllamaConfig, resolveEffectiveContext, computeLocalBatchSize } from './ollamaVisionService';
import { isManualFlowRunning } from './visionJobLock';
import { getLocalPhotoUrl } from './libraryStore';

// No real description to match against — this feature only wants the caption/tags every batch
// classify call already returns regardless of match (see visionClassify.buildBatchClassifyPrompt).
const GENERIC_DESCRIPTION = 'the general content of this photo';
// Yields back to the event loop between batches so a long run never starves the UI thread.
const INTER_BATCH_DELAY_MS = 300;

const STORAGE_KEY = 'gphotos_ai_auto_index_v1';

export interface AiAutoIndexStatus {
  enabled: boolean;
  running: boolean;
  done: number;
  total: number;
  /** Set when the loop is idle because Ollama/the vision model isn't reachable right now. */
  waitingForOllama: boolean;
}

let enabled = false;
try {
  enabled = localStorage.getItem(STORAGE_KEY) === '1';
} catch {
  enabled = false;
}

let running = false;
let done = 0;
let total = 0;
let waitingForOllama = false;
const listeners = new Set<(status: AiAutoIndexStatus) => void>();

function getStatus(): AiAutoIndexStatus {
  return { enabled, running, done, total, waitingForOllama };
}

function notifyListeners(): void {
  const status = getStatus();
  for (const l of listeners) {
    try { l(status); } catch {}
  }
}

export function subscribe(listener: (status: AiAutoIndexStatus) => void): () => void {
  listeners.add(listener);
  listener(getStatus());
  return () => listeners.delete(listener);
}

export function isAutoIndexEnabled(): boolean {
  return enabled;
}

export function setAutoIndexEnabled(next: boolean): void {
  enabled = next;
  try {
    localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
  } catch {}
  notifyListeners();
}

async function toBase64(photo: Photo): Promise<{ base64: string; mimeType: string } | null> {
  const url = getLocalPhotoUrl(photo.filePath, photo.originalRemotePath, false, 512);
  const res = await fetch(url);
  if (!res.ok) return null;
  const blob = await res.blob();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return { base64: btoa(binary), mimeType: blob.type || 'image/jpeg' };
}

/** Photos this feature still wants to describe: not a video, and no cached caption yet. */
function candidatesFrom(photos: Photo[]): Photo[] {
  return photos.filter((p) => !p.isVideo && !getEntry(p.id)?.caption);
}

/**
 * Runs one full pass over `photos`, batching and yielding between batches, stopping early if
 * disabled mid-run (checked once per batch) or if a manual Smart Flow starts (checked once per
 * batch — see visionJobLock). Safe to call again while already running: a second call is a no-op.
 */
export async function runAutoIndexPass(photos: Photo[]): Promise<void> {
  if (running) return;
  if (!enabled) return;

  await ensureLoaded();
  const candidates = candidatesFrom(photos);
  if (candidates.length === 0) {
    done = 0;
    total = 0;
    notifyListeners();
    return;
  }

  if (!(await isVisionAvailable())) {
    waitingForOllama = true;
    notifyListeners();
    return;
  }
  waitingForOllama = false;

  running = true;
  done = 0;
  total = candidates.length;
  notifyListeners();

  try {
    const effectiveContext = await resolveEffectiveContext(getOllamaConfig());
    const batchSize = computeLocalBatchSize(effectiveContext);

    for (let i = 0; i < candidates.length; i += batchSize) {
      if (!enabled) break;
      if (isManualFlowRunning()) {
        // Back off while a manual run is in flight rather than fighting it for the same local
        // model; the NEXT scheduled pass (library update / app restart) picks up where this left off.
        break;
      }

      const chunk = candidates.slice(i, i + batchSize);
      const withImages: Array<{ photo: Photo; img: { base64: string; mimeType: string } }> = [];
      for (const photo of chunk) {
        try {
          const img = await toBase64(photo);
          if (img) withImages.push({ photo, img });
        } catch {
          // Unreadable photo — just skip it this pass; nothing to record, nothing to retry here.
        }
        done++;
      }
      notifyListeners();
      if (withImages.length === 0) continue;

      try {
        const results = await classifyImagesBatchLocal(withImages.map((w) => w.img), GENERIC_DESCRIPTION, effectiveContext);
        for (let j = 0; j < withImages.length; j++) {
          const { photo } = withImages[j];
          const result = results[j];
          const embedding = result.caption ? await embedText(`${result.caption} ${result.tags.join(' ')}`) : null;
          recordFinding(photo.id, GENERIC_DESCRIPTION, { ...result, embedding });
        }
      } catch (err) {
        // This batch's photos simply stay uncached and are retried on the next pass — not fatal
        // to the run as a whole.
        console.warn('aiAutoIndexService: a batch failed, continuing with the next one', err);
      }

      if (i + batchSize < candidates.length) {
        await new Promise((r) => setTimeout(r, INTER_BATCH_DELAY_MS));
      }
    }
  } finally {
    running = false;
    notifyListeners();
  }
}
