import { useEffect, useState } from 'react';
import type { AvatarSpriteCoord } from '../../types';

// Batched lookup of person-avatar sprite tiles (see main/services/
// avatarSpriteService.ts). Same shape as the photo-sprite lookup in
// asyncImageLoader.ts: mounted cards ask for their (person, cover) key, a
// debounced worker resolves them in chunks of 50 (one sheet each), and the
// answers land in a shared cache — so opening People costs a couple of sheet
// transfers instead of one gphoto:// request per avatar.
//
// Two priorities: 'visible' (a card is on screen waiting) and 'prefetch'
// (look-ahead so the next screens are free). Visible always goes first, and
// each new prefetch REPLACES the previous unsent one — otherwise, while
// scrolling, thousands of stale look-ahead keys pile up ahead of the cards
// that are actually on screen and they stay blank.

// key -> tile, or null when that person has no avatar file yet (caller then crops live)
const cache = new Map<string, AvatarSpriteCoord | null>();
const listeners = new Set<(keys: Set<string>) => void>();

interface Item {
  personId: string;
  cacheKey: string;
  key: string;
}
let visibleQueue: Item[] = [];
let prefetchQueue: Item[] = [];
// keys that are queued or in flight -> which queue they were added to
const pending = new Map<string, 'visible' | 'prefetch'>();
let timer: ReturnType<typeof setTimeout> | null = null;
let working = false;

// One sheet holds 50 tiles, so visible cards resolve in chunks of 50 (a screenful in ~1 sheet).
// Look-ahead goes in smaller chunks: the worker awaits each call, so a card that mounts
// mid-run waits for the chunk already in flight — keep that wait short.
const CHUNK = 50;
const PREFETCH_CHUNK = 20;

export const avatarSpriteKey = (personId: string, cacheKey: string) => `${personId}::${cacheKey}`;

/** True in the Electron app; the browser/mobile shim has no sprite API, so callers fall back to per-image loading. */
export function avatarSpritesSupported(): boolean {
  const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
  return !!(api && !(api as any).isBrowserShim && api.getPersonAvatarSprites);
}

function nextChunk(): Item[] {
  return visibleQueue.length ? visibleQueue.splice(0, CHUNK) : prefetchQueue.splice(0, PREFETCH_CHUNK);
}

async function work(): Promise<void> {
  if (working) return;
  working = true;
  try {
    // Re-read the queues every iteration so a card that mounts mid-run jumps
    // ahead of whatever prefetch is still waiting.
    for (let chunk = nextChunk(); chunk.length > 0; chunk = nextChunk()) {
      chunk = chunk.filter((it) => !cache.has(it.key));
      if (chunk.length === 0) continue;
      let result: Record<string, AvatarSpriteCoord | null> = {};
      try {
        result = (await window.electronAPI!.getPersonAvatarSprites!(chunk.map(({ personId, cacheKey }) => ({ personId, cacheKey })))) || {};
      } catch (err) {
        console.warn('[AvatarSprite] lookup failed, falling back to per-image loading:', err);
      }
      const updated = new Set<string>();
      for (const it of chunk) {
        cache.set(it.key, result[it.key] ?? null);
        pending.delete(it.key);
        updated.add(it.key);
      }
      listeners.forEach((l) => l(updated));
    }
  } finally {
    working = false;
  }
}

function schedule(): void {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void work();
  }, 25);
}

function enqueue(personId: string, cacheKey: string, kind: 'visible' | 'prefetch'): void {
  const key = avatarSpriteKey(personId, cacheKey);
  if (cache.has(key)) return;
  const cur = pending.get(key);
  if (cur === 'visible' || (cur === 'prefetch' && kind === 'prefetch')) return;
  if (cur === 'prefetch') {
    // promote: a card now needs a key that was only queued as look-ahead
    const i = prefetchQueue.findIndex((x) => x.key === key);
    if (i >= 0) prefetchQueue.splice(i, 1);
  }
  pending.set(key, kind);
  (kind === 'visible' ? visibleQueue : prefetchQueue).push({ personId, cacheKey, key });
  schedule();
}

/** A card needs this tile now. */
export function requestAvatarSprite(personId: string, cacheKey: string): void {
  enqueue(personId, cacheKey, 'visible');
}

/** A card unmounted before its request was sent — don't spend a sheet build on it. */
export function cancelAvatarSpriteRequest(personId: string, cacheKey: string): void {
  const key = avatarSpriteKey(personId, cacheKey);
  if (pending.get(key) !== 'visible') return;
  const i = visibleQueue.findIndex((x) => x.key === key);
  if (i >= 0) {
    visibleQueue.splice(i, 1);
    pending.delete(key);
  }
}

/**
 * Ask for tiles just beyond what's on screen so the next screens of scrolling
 * are free. Replaces any earlier prefetch that hasn't been sent yet, so it
 * always reflects the current scroll position.
 */
export function prefetchAvatarSprites(items: Array<{ personId: string; cacheKey: string }>): void {
  if (!avatarSpritesSupported()) return;
  for (const stale of prefetchQueue) pending.delete(stale.key);
  prefetchQueue = [];
  for (const it of items) {
    if (it.personId && it.cacheKey) enqueue(it.personId, it.cacheKey, 'prefetch');
  }
}

/** Forget a person's cached tile(s) (e.g. after a new cover crop was saved) so mounted cards re-resolve it. */
export function invalidateAvatarSprite(personId: string): void {
  const dropped = new Set<string>();
  for (const key of [...cache.keys()]) {
    if (key.startsWith(`${personId}::`)) {
      cache.delete(key);
      dropped.add(key);
    }
  }
  if (dropped.size) listeners.forEach((l) => l(dropped));
}

/** Test-only. */
export function resetAvatarSpriteLoaderForTests(): void {
  cache.clear();
  visibleQueue = [];
  prefetchQueue = [];
  pending.clear();
  listeners.clear();
  if (timer) clearTimeout(timer);
  timer = null;
  working = false;
}

export type AvatarSpriteStatus = 'off' | 'pending' | 'ready' | 'none';

/**
 * off: sprites not requested/supported. pending: waiting on the batch.
 * ready: `coord` is the tile. none: this person has no avatar file yet (crop live).
 */
export function useAvatarSprite(
  personId: string | undefined,
  cacheKey: string | undefined,
  enabled: boolean
): { status: AvatarSpriteStatus; coord: AvatarSpriteCoord | null } {
  const key = enabled && personId && cacheKey && avatarSpritesSupported() ? avatarSpriteKey(personId, cacheKey) : null;

  const read = (): { status: AvatarSpriteStatus; coord: AvatarSpriteCoord | null } => {
    if (!key) return { status: 'off', coord: null };
    if (!cache.has(key)) return { status: 'pending', coord: null };
    const coord = cache.get(key)!;
    return coord ? { status: 'ready', coord } : { status: 'none', coord: null };
  };

  const [state, setState] = useState(read);

  useEffect(() => {
    setState(read());
    if (!key) return;
    if (!cache.has(key)) requestAvatarSprite(personId!, cacheKey!);
    const listener = (keys: Set<string>) => {
      if (!keys.has(key)) return;
      setState(read());
      if (!cache.has(key)) requestAvatarSprite(personId!, cacheKey!); // invalidated while mounted: fetch the new tile
    };
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      cancelAvatarSpriteRequest(personId!, cacheKey!);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return state;
}
