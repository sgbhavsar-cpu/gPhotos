// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('photoContentCache', () => {
  let cache: any;
  let libMod: any;
  let api: any;

  const load = async (electronApi: any) => {
    api = electronApi;
    (window as any).electronAPI = api;
    localStorage.clear();
    vi.resetModules();
    libMod = await import('../../src/renderer/src/services/libraryStore');
    cache = await import('../../src/renderer/src/services/photoContentCache');
    libMod.libraryStore.getState().selectedFolder = 'C:\\Library';
    return cache;
  };

  beforeEach(() => vi.resetAllMocks());

  it('warms its mirror from the main-process sqlite store when a real electronAPI is present', async () => {
    const getAll = vi.fn(async () => ({ p1: { caption: 'a scanned bill', tags: ['bill'], embedding: null, verdicts: {}, updatedAt: 'x' } }));
    await load({ getAllPhotoContentEntries: getAll, upsertPhotoContentEntry: vi.fn(async () => true) });

    expect(cache.getEntry('p1')).toBeUndefined(); // not warmed yet
    await cache.ensureLoaded();
    expect(getAll).toHaveBeenCalledTimes(1);
    expect(cache.getEntry('p1')).toMatchObject({ caption: 'a scanned bill', tags: ['bill'] });

    await cache.ensureLoaded(); // same library — doesn't reload
    expect(getAll).toHaveBeenCalledTimes(1);
  });

  it('falls back to localStorage (scoped per library) when there is no real electronAPI', async () => {
    await load({ isBrowserShim: true });
    await cache.ensureLoaded();
    expect(cache.getEntry('p1')).toBeUndefined();

    cache.recordFinding('p1', 'a scanned bill', { match: true, confidence: 0.9, caption: 'a bill', tags: ['bill'] });
    expect(cache.getEntry('p1')).toMatchObject({ caption: 'a bill', tags: ['bill'] });

    // A fresh module instance (simulating a restart) reloads the same data back from localStorage.
    vi.resetModules();
    const libMod2 = await import('../../src/renderer/src/services/libraryStore');
    libMod2.libraryStore.getState().selectedFolder = 'C:\\Library';
    const cache2 = await import('../../src/renderer/src/services/photoContentCache');
    await cache2.ensureLoaded();
    expect(cache2.getEntry('p1')).toMatchObject({ caption: 'a bill' });
  });

  it('recordFinding persists through the real electronAPI and merges tags across calls', async () => {
    const upsert = vi.fn(async () => true);
    await load({ getAllPhotoContentEntries: vi.fn(async () => ({})), upsertPhotoContentEntry: upsert });
    await cache.ensureLoaded();

    cache.recordFinding('p1', 'a scanned bill', { match: true, confidence: 0.9, caption: 'a bill', tags: ['bill', 'receipt'] });
    cache.recordFinding('p1', 'a phone screenshot', { match: false, confidence: 0.8, caption: 'a bill, updated', tags: ['receipt', 'document'] });

    expect(upsert).toHaveBeenCalledTimes(2);
    const entry = cache.getEntry('p1');
    expect(entry.caption).toBe('a bill, updated');
    expect(entry.tags.sort()).toEqual(['bill', 'document', 'receipt']); // accumulated, deduplicated
    expect(entry.verdicts[cache.normalizeDescription('a scanned bill')]).toEqual({ match: true, confidence: 0.9 });
    expect(entry.verdicts[cache.normalizeDescription('a phone screenshot')]).toEqual({ match: false, confidence: 0.8 });
  });

  describe('setCaptionAndTags — a plain overwrite, unlike recordFinding\'s merge', () => {
    const setup = async () => {
      await load({ isBrowserShim: true });
      await cache.ensureLoaded();
    };

    it('replaces caption and tags outright, not merging with what recordFinding already wrote', async () => {
      await setup();
      cache.recordFinding('p1', 'x', { match: true, confidence: 0.9, caption: 'old caption', tags: ['old', 'tags'] });
      cache.setCaptionAndTags('p1', 'new caption', ['new']);
      expect(cache.getEntry('p1')).toMatchObject({ caption: 'new caption', tags: ['new'] });
    });

    it('an empty caption/tags is a deliberate delete, not a no-op', async () => {
      await setup();
      cache.recordFinding('p1', 'x', { match: true, confidence: 0.9, caption: 'old caption', tags: ['old'] });
      cache.setCaptionAndTags('p1', '', []);
      expect(cache.getEntry('p1')).toMatchObject({ caption: '', tags: [] });
    });

    it('dedupes and lowercases tags, and leaves embedding/verdicts untouched', async () => {
      await setup();
      cache.recordFinding('p1', 'a scanned bill', { match: true, confidence: 0.9, caption: 'x', tags: [], embedding: [1, 0, 0] });
      cache.setCaptionAndTags('p1', 'edited', ['Cat', 'cat', ' Dog ']);
      const entry = cache.getEntry('p1');
      expect(entry.tags.sort()).toEqual(['cat', 'dog']);
      expect(entry.embedding).toEqual([1, 0, 0]);
      expect(entry.verdicts[cache.normalizeDescription('a scanned bill')]).toEqual({ match: true, confidence: 0.9 });
    });
  });

  describe('tryLocalMatch', () => {
    const setup = async () => {
      await load({ isBrowserShim: true });
      await cache.ensureLoaded();
    };

    it('returns null for a photo with no cached entry', async () => {
      await setup();
      expect(cache.tryLocalMatch('unknown', 'anything', null)).toBeNull();
    });

    it('reuses the exact verdict for an identical (normalized) description, ignoring the embedding entirely', async () => {
      await setup();
      cache.recordFinding('p1', '  A Scanned BILL  ', { match: true, confidence: 0.77, caption: 'x', tags: [] });
      expect(cache.tryLocalMatch('p1', 'a scanned bill', [9, 9, 9])).toEqual({ match: true, confidence: 0.77 });
    });

    it('a near-identical cached embedding decides a confident match', async () => {
      await setup();
      cache.recordFinding('p1', 'irrelevant first question', { match: false, confidence: 0.5, caption: 'a phone screenshot of a chat app', tags: ['screenshot'] });
      const entry = cache.getEntry('p1');
      entry.embedding = [1, 0, 0];
      const result = cache.tryLocalMatch('p1', 'a different, never-asked description', [1, 0, 0]); // identical direction -> similarity 1
      expect(result).toEqual({ match: true, confidence: 0.9 });
    });

    it('an orthogonal cached embedding decides a confident non-match', async () => {
      await setup();
      cache.recordFinding('p1', 'irrelevant first question', { match: false, confidence: 0.5, caption: 'a landscape photo', tags: ['landscape'] });
      const entry = cache.getEntry('p1');
      entry.embedding = [1, 0, 0];
      const result = cache.tryLocalMatch('p1', 'a never-asked description', [0, 1, 0]); // orthogonal -> similarity 0
      expect(result).toEqual({ match: false, confidence: 0.9 });
    });

    it('an ambiguous embedding similarity falls through to the keyword heuristic', async () => {
      await setup();
      cache.recordFinding('p1', 'irrelevant', { match: false, confidence: 0.5, caption: 'a phone screenshot of an app', tags: ['screenshot', 'app', 'phone'] });
      const entry = cache.getEntry('p1');
      entry.embedding = [1, 1, 0]; // similarity to [1,0,0] is ~0.707 — inside the ambiguous band
      // wording overlaps heavily with the cached caption/tags -> keyword heuristic says match
      const result = cache.tryLocalMatch('p1', 'phone screenshot app', [1, 0, 0]);
      expect(result).toEqual({ match: true, confidence: 0.55 });
    });

    it('returns null (unsure) when neither an embedding nor enough keyword overlap can decide it', async () => {
      await setup();
      cache.recordFinding('p1', 'irrelevant', { match: false, confidence: 0.5, caption: 'a photo', tags: ['x', 'y'] }); // fewer than 3 tags -> no confident "miss" either
      expect(cache.tryLocalMatch('p1', 'a scanned bill with line items', null)).toBeNull();
    });
  });
});
