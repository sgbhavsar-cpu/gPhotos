// "Smart Flows": user-defined rules that describe a kind of photo in plain text
// ("a screenshot of a Facebook post", "a scanned bill") and either collect matches
// into an album or move them to a folder. A photo not already answered by the shared
// local cache/RAG index is checked with a local Ollama vision model first (private, free);
// only when Ollama is unavailable or unsure does it escalate to the configured cloud
// provider. Every flow requires an explicit one-time consent before it can run (running it
// can still send photos off-machine, to the cloud tier), and runs are manual and capped so a
// mistake doesn't burn through the whole library in one go.
import type { Photo } from '../../../types';
import { libraryStore, getLocalPhotoUrl } from './libraryStore';
import { aiSearchService } from './aiSearchService';
import { ClassifyDescribeResult } from './visionClassify';
import { ensureLoaded, tryLocalMatch, recordFinding } from './photoContentCache';
import { isVisionAvailable, classifyImagesBatchLocal, embedText, getOllamaConfig, resolveEffectiveContext, computeLocalBatchSize } from './ollamaVisionService';
import { movePhotosToFolder } from './photoRelocationFlow';
import { notify } from './notifications';

// How many photos to send in one vision call — amortizes the fixed prompt cost across the batch
// instead of paying it per photo. Kept modest so one bad/oversized response only wastes a handful
// of calls, not the whole run. Local and cloud are sized separately: they have very different
// context budgets, so what's safe for one says nothing about the other.
//
// The LOCAL batch size is not a fixed constant — it's computed per run from Ollama's actual context
// window (checked once, right below, before the local pass starts — see resolveEffectiveContext /
// computeLocalBatchSize in ollamaVisionService.ts for the sizing math), so a bigger context window
// (Settings → Local AI Model → Context Window) genuinely sends more photos per call, and a small
// one doesn't get overrun.
//
// Cloud providers' own context windows are orders of magnitude larger than any local model's, so
// their batch size is unrelated and stays a fixed constant — nothing reported an issue with it, and
// a bigger cloud batch only risks a bigger provider bill if one call has to be retried.
const CLOUD_BATCH_SIZE = 8;
// A local Ollama answer below this confidence is treated as "unsure" and escalated to the cloud
// tier instead of being trusted outright — moving/albuming a photo on a shaky local guess is worse
// than spending one more cloud call to be sure.
const LOCAL_CONFIDENCE_THRESHOLD = 0.75;

export type SmartFlowAction = { type: 'album'; albumName: string } | { type: 'move' };

export interface SmartFlow {
  id: string;
  name: string;
  /** The classification prompt sent to the vision model for every photo. */
  description: string;
  action: SmartFlowAction;
  /** User confirmed that running this flow sends photos to the configured cloud provider. */
  consented: boolean;
  /** photoId -> true, for photos classified as a match so far. */
  matches: Record<string, true>;
  /** photoId -> true, for every photo already sent for classification (match or not), so a re-run only spends new calls on photos it hasn't seen. */
  classifiedIds: Record<string, true>;
  createdAt: string;
  lastRunAt?: string;
}

export interface RunFlowResult {
  classified: number;
  matched: number;
  failed: number;
  /** Of `classified`, how many were decided from the shared local cache/RAG index, no vision call at all. */
  fromCache: number;
  /** Of `classified`, how many were decided by the local Ollama model, no cloud call. */
  fromLocalModel: number;
  actionSummary?: string;
}

/** One line of a run's detail log — which photo, what just happened to it, and how serious. */
export interface FlowRunLogLine {
  /** 1-based position of this photo among the photos this run is checking. */
  index: number;
  total: number;
  photoId: string;
  fileName: string;
  level: 'info' | 'warn' | 'error';
  message: string;
}

// Flows reference photo ids, which are only meaningful within one library — scope the
// storage key to the current library folder so switching libraries doesn't mix them up.
function storageKey(): string {
  const s = libraryStore.getState();
  return `gphotos_smart_flows_v1:${s.selectedFolder || s.currentDirectory || 'default'}`;
}

function load(): SmartFlow[] {
  try {
    const raw = localStorage.getItem(storageKey());
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    console.warn('Failed to read smart flows from localStorage:', e);
    return [];
  }
}

function save(flows: SmartFlow[]): void {
  try {
    localStorage.setItem(storageKey(), JSON.stringify(flows));
  } catch (e) {
    console.warn('Failed to save smart flows to localStorage:', e);
  }
}

export function listFlows(): SmartFlow[] {
  return load();
}

export function createFlow(name: string, description: string, action: SmartFlowAction): SmartFlow {
  const flow: SmartFlow = {
    id: `flow_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    name: name.trim() || 'Untitled flow',
    description: description.trim(),
    action,
    consented: false,
    matches: {},
    classifiedIds: {},
    createdAt: new Date().toISOString(),
  };
  const flows = load();
  flows.unshift(flow);
  save(flows);
  return flow;
}

export function deleteFlow(id: string): void {
  save(load().filter((f) => f.id !== id));
}

export function setFlowConsent(id: string, consented: boolean): void {
  const flows = load();
  const flow = flows.find((f) => f.id === id);
  if (flow) {
    flow.consented = consented;
    save(flows);
  }
}

async function toBase64(photo: Photo): Promise<{ base64: string; mimeType: string } | null> {
  // A 512px cached thumbnail is plenty for a yes/no visual classification and far cheaper
  // to send than the original.
  const url = getLocalPhotoUrl(photo.filePath, photo.originalRemotePath, false, 512);
  const res = await fetch(url);
  if (!res.ok) return null;
  const blob = await res.blob();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return { base64: btoa(binary), mimeType: blob.type || 'image/jpeg' };
}

/** Reads each photo's thumbnail as base64; an unreadable photo is reported via `onUnreadable` (caller counts it failed) and left out of the result. */
async function readImages(
  photos: Photo[],
  onUnreadable: (photo: Photo, err: unknown) => void
): Promise<Array<{ photo: Photo; img: { base64: string; mimeType: string } }>> {
  const out: Array<{ photo: Photo; img: { base64: string; mimeType: string } }> = [];
  for (const photo of photos) {
    try {
      const img = await toBase64(photo);
      if (!img) throw new Error('could not read the photo');
      out.push({ photo, img });
    } catch (err) {
      onUnreadable(photo, err);
    }
  }
  return out;
}

/** A fresh vision result always feeds the shared cache — including a local text embedding of the
 *  caption/tags when Ollama's embedding model is reachable, so a later flow can match this photo
 *  semantically even if its own description never gets classified against by a vision call again. */
async function recordWithEmbedding(photoId: string, description: string, result: ClassifyDescribeResult): Promise<void> {
  const embedding = result.caption ? await embedText(`${result.caption} ${result.tags.join(' ')}`) : null;
  recordFinding(photoId, description, { ...result, embedding });
}

/**
 * Classify up to `cap` not-yet-seen photos against the flow's description, then apply its
 * action (album / move) to every photo matched so far (including earlier runs). Returns null
 * without spending any API calls when the flow hasn't been consented to yet.
 */
export async function runFlow(
  flow: SmartFlow,
  allPhotos: Photo[],
  cap: number,
  onProgress?: (done: number, total: number) => void,
  onLog?: (line: FlowRunLogLine) => void
): Promise<RunFlowResult | null> {
  if (!flow.consented) {
    notify('error', `"${flow.name}" needs to be confirmed first — running it sends photos to your configured cloud AI provider.`);
    return null;
  }

  await ensureLoaded(); // warm the shared local cache/RAG mirror for this library before Pass 1

  const candidates = allPhotos.filter((p) => !flow.classifiedIds[p.id]).slice(0, Math.max(1, cap));
  if (candidates.length > 0) {
    notify('info', `"${flow.name}": checking ${candidates.length} photo${candidates.length === 1 ? '' : 's'}...`);
  } else {
    onLog?.({ index: 0, total: 0, photoId: '', fileName: '', level: 'info', message: allPhotos.length === 0 ? 'Nothing in scope to check.' : 'Every photo in scope has already been checked by this flow.' });
  }

  let failed = 0;
  let newlyMatched = 0;
  let fromCache = 0;
  let fromLocalModel = 0;
  let done = 0;
  const total = candidates.length;
  const markDone = () => onProgress?.(++done, total);
  const indexOf = new Map(candidates.map((p, i) => [p.id, i + 1]));
  const log = (photo: Photo, level: FlowRunLogLine['level'], message: string) =>
    onLog?.({ index: indexOf.get(photo.id) || 0, total, photoId: photo.id, fileName: photo.fileName, level, message });

  // Pass 1: decide whatever the shared local cache/RAG index already knows for free — no vision
  // call at all. A photo any earlier flow already classified (or captioned) often already answers
  // this flow's question, either by an identical past description or by embedding similarity.
  const afterCache: Photo[] = [];
  const descriptionEmbedding = await embedText(flow.description);
  for (const photo of candidates) {
    const local = tryLocalMatch(photo.id, flow.description, descriptionEmbedding);
    if (local === null) {
      afterCache.push(photo);
      continue;
    }
    flow.classifiedIds[photo.id] = true;
    if (local.match) {
      flow.matches[photo.id] = true;
      newlyMatched++;
    }
    fromCache++;
    log(photo, 'info', `Already described — ${local.match ? 'matches' : 'does not match'} (from the shared cache, no AI call needed)`);
    markDone();
  }

  // Pass 2: a local Ollama vision model's first pass — private and free — for whatever the cache
  // didn't resolve. Skipped entirely (falls straight through to Pass 3) when Ollama or its vision
  // model isn't available on this machine. Only a confident answer is trusted; anything below
  // LOCAL_CONFIDENCE_THRESHOLD still needs the cloud tier to be sure before it's filed anywhere.
  const needsCloud: Photo[] = [];
  const ollamaReady = afterCache.length > 0 && (await isVisionAvailable());
  if (ollamaReady) {
    // Checked once per run, not per batch: which context window Ollama will actually honor for
    // this model (the configured value, capped at the model's own real maximum), and how many
    // photos that fits. Reused for every batch below, and for the num_ctx actually requested, so
    // the two can never drift apart.
    const effectiveContext = await resolveEffectiveContext(getOllamaConfig());
    const localBatchSize = computeLocalBatchSize(effectiveContext);
    onLog?.({ index: 0, total, photoId: '', fileName: '', level: 'info', message: `Local model context: ${effectiveContext} tokens — sending up to ${localBatchSize} photos per call.` });

    for (let i = 0; i < afterCache.length; i += localBatchSize) {
      const chunk = afterCache.slice(i, i + localBatchSize);
      chunk.forEach((photo) => log(photo, 'info', 'Trying the local Ollama model...'));
      const withImages = await readImages(chunk, (photo, err) => {
        failed++;
        console.warn(`Smart flow "${flow.name}": failed to read ${photo.fileName}`, err);
        log(photo, 'error', `Could not read this photo — ${(err as Error)?.message || err}`);
        markDone();
      });
      if (withImages.length === 0) continue;

      try {
        const results = await classifyImagesBatchLocal(withImages.map((w) => w.img), flow.description, effectiveContext);
        for (let j = 0; j < withImages.length; j++) {
          const { photo } = withImages[j];
          const result = results[j];
          if (result.confidence < LOCAL_CONFIDENCE_THRESHOLD) {
            log(photo, 'info', `Local model unsure (${Math.round(result.confidence * 100)}%) — escalating to the cloud`);
            needsCloud.push(photo); // not confident enough locally — let Pass 3 decide
            continue;
          }
          flow.classifiedIds[photo.id] = true;
          await recordWithEmbedding(photo.id, flow.description, result);
          if (result.match) {
            flow.matches[photo.id] = true;
            newlyMatched++;
          }
          fromLocalModel++;
          log(photo, 'info', `Local model says ${result.match ? 'matches' : 'does not match'} (${Math.round(result.confidence * 100)}%)`);
          markDone();
        }
      } catch (err) {
        console.warn(`Smart flow "${flow.name}": local Ollama pass failed, falling back to the cloud for this batch`, err);
        withImages.forEach((w) => log(w.photo, 'warn', `Local model error — falling back to the cloud (${(err as Error)?.message || err})`));
        needsCloud.push(...withImages.map((w) => w.photo));
      }
    }
  } else if (afterCache.length > 0) {
    afterCache.forEach((photo) => log(photo, 'warn', 'No local Ollama vision model available — trying the cloud instead'));
    needsCloud.push(...afterCache);
  }

  // Pass 3: escalate whatever's left to the cloud provider, batched to amortize the fixed prompt cost.
  for (let i = 0; i < needsCloud.length; i += CLOUD_BATCH_SIZE) {
    const chunk = needsCloud.slice(i, i + CLOUD_BATCH_SIZE);
    chunk.forEach((photo) => log(photo, 'info', 'Sending to the configured cloud AI provider...'));
    const withImages = await readImages(chunk, (photo, err) => {
      failed++;
      console.warn(`Smart flow "${flow.name}": failed to read ${photo.fileName}`, err);
      log(photo, 'error', `Could not read this photo — ${(err as Error)?.message || err}`);
      markDone();
    });
    if (withImages.length === 0) continue;

    try {
      const results = await aiSearchService.classifyImagesBatch(withImages.map((w) => w.img), flow.description, aiSearchService.getSmartFlowsConfig());
      for (let j = 0; j < withImages.length; j++) {
        const { photo } = withImages[j];
        const result = results[j];
        flow.classifiedIds[photo.id] = true;
        await recordWithEmbedding(photo.id, flow.description, result); // feeds every future flow's local cache, not just this one
        if (result.match) {
          flow.matches[photo.id] = true;
          newlyMatched++;
        }
        log(photo, 'info', `Cloud model says ${result.match ? 'matches' : 'does not match'}`);
        markDone();
      }
    } catch (err) {
      failed += withImages.length;
      console.warn(`Smart flow "${flow.name}": batch classification failed`, err);
      // classifyImagesBatch already throws a plain-language reason (e.g. "no API key set") — surface
      // it verbatim instead of a generic "failed", since this is exactly the case the user needs to
      // act on (configure a provider) rather than a transient error to retry.
      withImages.forEach((w) => log(w.photo, 'error', (err as Error)?.message || String(err)));
      withImages.forEach(() => markDone());
    }
  }

  flow.lastRunAt = new Date().toISOString();
  const flows = load();
  const idx = flows.findIndex((f) => f.id === flow.id);
  if (idx >= 0) flows[idx] = flow;
  else flows.unshift(flow);
  save(flows);

  // ponytail: a moved photo gets a new id (see photoRelocationFlow), so its `matches` entry
  // goes stale and, if it's ever re-scanned into `allPhotos` under its new id, it'll be
  // re-classified once more. Rare and harmless (one extra API call) — not worth tracking
  // old->new id renames here just for this.
  const matchedPhotos = allPhotos.filter((p) => flow.matches[p.id]);
  let actionSummary: string | undefined;
  if (matchedPhotos.length > 0) {
    const action = flow.action;
    if (action.type === 'album') {
      const existing = libraryStore.getState().albums.find((a) => a.title === action.albumName);
      if (existing) libraryStore.addPhotosToAlbum(existing.id, matchedPhotos.map((p) => p.id));
      else libraryStore.createAlbum(action.albumName, undefined, matchedPhotos.map((p) => p.id));
      await libraryStore.flushSaveImmediately();
      actionSummary = `Album "${action.albumName}" now has ${matchedPhotos.length} matching photo${matchedPhotos.length === 1 ? '' : 's'}.`;
    } else {
      const moveResult = await movePhotosToFolder(matchedPhotos, { label: `flow "${flow.name}"` });
      if (moveResult) actionSummary = `Moved ${moveResult.moved} photo${moveResult.moved === 1 ? '' : 's'} to "${moveResult.targetDir}".`;
    }
  }

  if (candidates.length > 0) {
    const notes = [
      fromCache > 0 ? `${fromCache} free from cache` : null,
      fromLocalModel > 0 ? `${fromLocalModel} from the local model` : null,
    ].filter(Boolean);
    const notesText = notes.length ? ` (${notes.join(', ')})` : '';
    const summary = `Checked ${candidates.length}${notesText}, ${newlyMatched} matched${failed ? `, ${failed} failed` : ''}.${actionSummary ? ' ' + actionSummary : ''}`;
    notify(failed > 0 ? 'warning' : 'success', `"${flow.name}": ${summary}`);
    onLog?.({ index: total, total, photoId: '', fileName: '', level: failed > 0 ? 'warn' : 'info', message: summary });
  } else if (!actionSummary) {
    notify('info', `"${flow.name}": nothing left to classify.`);
  }

  return { classified: candidates.length, matched: newlyMatched, failed, fromCache, fromLocalModel, actionSummary };
}
