// Per-photo visual content cache / RAG index, SHARED across every Smart Flow (unlike each flow's
// own classifiedIds/matches). The first time a photo is sent to a vision model (local Ollama or
// cloud) for any flow, its caption + tags + a text embedding are kept here — durably, in a table in
// the current library's own SQLite database (one per library, via the main process) — so a LATER,
// DIFFERENT flow checks this cache first and, when it's confident enough, decides the match for
// free instead of spending another vision call on the same photo.
//
// Persistence goes through the main process (node:sqlite) when running as the real desktop app;
// a plain localStorage fallback keeps this working under the browser shim / in tests, where
// there's no per-library database file to write into.
import type { PhotoContentEntry } from '../../../types';
import { libraryStore } from './libraryStore';
import { cosineDistance } from './clustering';

export type { PhotoContentEntry };

const STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'on', 'in', 'at', 'to', 'is', 'are', 'this', 'that', 'with', 'and', 'or',
  'photo', 'photos', 'picture', 'pictures', 'image', 'images',
]);

// A photo's cached embedding is confidently similar/dissimilar enough to skip an API call outside
// this band; inside it, the plain keyword-overlap heuristic below gets a say instead of guessing.
const EMBED_MATCH_THRESHOLD = 0.72;
const EMBED_MISS_THRESHOLD = 0.35;

let mirror: Record<string, PhotoContentEntry> = {};
let mirrorLibraryKey: string | null = null;
let loadPromise: Promise<void> | null = null;

function currentLibraryKey(): string {
  const s = libraryStore.getState();
  return s.selectedFolder || s.currentDirectory || 'default';
}

function hasRealApi(): boolean {
  const api = (window as any).electronAPI;
  return !!(api?.getAllPhotoContentEntries && api?.upsertPhotoContentEntry && !api.isBrowserShim);
}

function fallbackKey(libraryKey: string): string {
  return `gphotos_photo_content_cache_v1:${libraryKey}`;
}

function loadFallback(libraryKey: string): Record<string, PhotoContentEntry> {
  try {
    const raw = localStorage.getItem(fallbackKey(libraryKey));
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    console.warn('Failed to read photo content cache from localStorage:', e);
    return {};
  }
}

function saveFallback(libraryKey: string, all: Record<string, PhotoContentEntry>): void {
  try {
    localStorage.setItem(fallbackKey(libraryKey), JSON.stringify(all));
  } catch (e) {
    console.warn('Failed to save photo content cache to localStorage:', e);
  }
}

/**
 * Warms the in-memory mirror for the current library. Cheap to call repeatedly — only actually
 * (re)loads when the active library has changed since the last call. `getEntry`/`tryLocalMatch`
 * read this mirror synchronously, so callers that need it warm first (Smart Flows runs) should
 * `await` this once up front; a reader that doesn't (e.g. the photo detail panel, which just wants
 * whatever's already known) simply sees nothing until the next load completes.
 */
export function ensureLoaded(): Promise<void> {
  const key = currentLibraryKey();
  if (mirrorLibraryKey === key && loadPromise) return loadPromise;
  mirrorLibraryKey = key;
  loadPromise = (async () => {
    try {
      mirror = hasRealApi() ? (await (window as any).electronAPI.getAllPhotoContentEntries()) || {} : loadFallback(key);
    } catch (e) {
      console.warn('Failed to load photo content cache:', e);
      mirror = {};
    }
  })();
  return loadPromise;
}

export function normalizeDescription(d: string): string {
  return d.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function getEntry(photoId: string): PhotoContentEntry | undefined {
  return mirror[photoId];
}

/** Every distinct tag any Smart Flow has ever recorded for a photo in this library — offered as
 *  '&tag' autocomplete suggestions in Search with AI. Reads the already-loaded in-memory mirror
 *  synchronously; callers should `ensureLoaded()` first the same way `getEntry` callers do. */
export function getAllKnownTags(): string[] {
  const tags = new Set<string>();
  for (const entry of Object.values(mirror)) {
    for (const t of entry.tags || []) tags.add(t);
  }
  return Array.from(tags);
}

/** Merge a fresh verdict + caption/tags/embedding into the cache for one photo. Tags accumulate
 *  (deduplicated), and a newer embedding/caption replaces the old one — across every flow that has
 *  ever looked at this photo. Fire-and-forget persistence: the in-memory mirror updates immediately. */
export function recordFinding(
  photoId: string,
  description: string,
  result: { match: boolean; confidence: number; caption?: string; tags?: string[]; embedding?: number[] | null }
): void {
  const prev = mirror[photoId];
  const tags = new Set(prev?.tags || []);
  for (const t of result.tags || []) {
    const clean = t.toLowerCase().trim();
    if (clean) tags.add(clean);
  }
  const entry: PhotoContentEntry = {
    caption: result.caption?.trim() || prev?.caption || '',
    tags: Array.from(tags),
    embedding: result.embedding || prev?.embedding || null,
    verdicts: { ...(prev?.verdicts || {}), [normalizeDescription(description)]: { match: result.match, confidence: result.confidence } },
    updatedAt: new Date().toISOString(),
  };
  mirror[photoId] = entry;

  if (hasRealApi()) {
    (window as any).electronAPI.upsertPhotoContentEntry(photoId, entry).catch((e: unknown) => console.warn('Failed to save photo content entry:', e));
  } else {
    saveFallback(currentLibraryKey(), mirror);
  }
}

/**
 * Directly replaces a photo's caption/tags — unlike recordFinding (which MERGES a fresh vision
 * result into whatever's already there, tags accumulating and never shrinking), this is a plain
 * overwrite for a user manually editing or clearing what the AI recorded (see PhotoAiInfoPanel.tsx
 * and BulkEditModal.tsx). An empty caption or an empty tags array is a deliberate "delete this" —
 * not treated as "nothing to change" the way recordFinding's falsy-caption fallback does. Embedding
 * and verdicts are left untouched: an edited caption shouldn't silently invalidate the semantic
 * cache other Smart Flows rely on, and a manual edit isn't itself a verdict on any flow's description.
 */
export function setCaptionAndTags(photoId: string, caption: string, tags: string[]): void {
  const prev = mirror[photoId];
  const cleanTags = Array.from(new Set(tags.map((t) => t.toLowerCase().trim()).filter(Boolean)));
  const entry: PhotoContentEntry = {
    caption: caption.trim(),
    tags: cleanTags,
    embedding: prev?.embedding || null,
    verdicts: prev?.verdicts || {},
    updatedAt: new Date().toISOString(),
  };
  mirror[photoId] = entry;

  if (hasRealApi()) {
    (window as any).electronAPI.upsertPhotoContentEntry(photoId, entry).catch((e: unknown) => console.warn('Failed to save photo content entry:', e));
  } else {
    saveFallback(currentLibraryKey(), mirror);
  }
}

/**
 * Best-effort match using only what's already cached for this photo — no API call. `descriptionEmbedding`
 * is the CURRENT flow's description, embedded once per run (see ollamaVisionService.embedText) and
 * passed in here rather than computed per photo. Returns null ("unsure") when there isn't enough
 * locally to decide, which the caller should then escalate (to the local Ollama pass, then the cloud).
 */
export function tryLocalMatch(
  photoId: string,
  description: string,
  descriptionEmbedding: number[] | null = null
): { match: boolean; confidence: number } | null {
  const entry = getEntry(photoId);
  if (!entry) return null;

  const norm = normalizeDescription(description);
  const exact = entry.verdicts[norm];
  if (exact) return exact; // this exact question was already answered for this photo

  if (entry.embedding && descriptionEmbedding) {
    const similarity = 1 - cosineDistance(descriptionEmbedding, entry.embedding);
    if (similarity >= EMBED_MATCH_THRESHOLD) return { match: true, confidence: Math.min(0.9, similarity) };
    if (similarity <= EMBED_MISS_THRESHOLD) return { match: false, confidence: Math.min(0.9, 1 - similarity) };
    // ambiguous by embedding similarity — fall through to the plain keyword heuristic below
  }

  const words = norm.split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOPWORDS.has(w));
  if (words.length === 0) return null;
  const corpus = `${entry.caption} ${entry.tags.join(' ')}`.toLowerCase();
  const overlap = words.filter((w) => corpus.includes(w)).length;
  const ratio = overlap / words.length;
  // ponytail: plain keyword overlap, not embeddings — only used when there's no cached embedding
  // yet (or the embedding was ambiguous); good enough to skip an API call on a clear hit/miss,
  // genuinely ambiguous cases fall through to null (escalate) rather than guess wrong.
  if (ratio >= 0.6) return { match: true, confidence: 0.55 };
  if (ratio === 0 && entry.tags.length >= 3) return { match: false, confidence: 0.5 };
  return null;
}

/** Test-only: the in-memory mirror is a module-level singleton, so a test that calls recordFinding()
 *  must reset it in a beforeEach, or a later test in the same file would still see its entries. */
export function resetForTests(): void {
  mirror = {};
  mirrorLibraryKey = null;
  loadPromise = null;
}
