// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { aiSearchService } from '../../src/renderer/src/services/aiSearchService';
import { recordFinding, resetForTests as resetPhotoContentCache } from '../../src/renderer/src/services/photoContentCache';
import type { Photo, Person } from '../../src/types';

const photo = (id: string, over: Partial<Photo> = {}): Photo => ({
  id, filePath: `C:\\${id}.jpg`, fileName: `${id}.jpg`, fileSize: 1,
  dateTaken: '2026-01-01', year: 2026, month: 1, day: 1, ...over,
}) as any;

const people: Person[] = [];

// photoContentCache's mirror is a module-level singleton shared across every it() in this run, so
// each test gets its own unique id prefix — a tag/photo recorded in one test can never leak into
// (or be shadowed by) another's assertions.
let seq = 0;
beforeEach(() => {
  seq++;
  resetPhotoContentCache();
  aiSearchService.saveConfig({ provider: 'local', geminiApiKey: '', openaiApiKey: '' });
});
const uid = (n: number) => `tagtest_${seq}_p${n}`;

describe('AI search: "&tag" Smart Flow content-tag matching', () => {
  describe('smartLocalNlp: recognising a known tag in the query', () => {
    it('a tag already seen by some photo (what the "&tag" autocomplete offers) is detected', () => {
      recordFinding(uid(1), 'a scanned bill', { match: true, confidence: 0.9, tags: ['receipt', 'bill'] });
      const filter = aiSearchService.smartLocalNlp('Photo tagged receipt', people, [photo(uid(1))]);
      expect(filter.tagsMustInclude).toEqual(['receipt']);
    });

    it('a random word that was never recorded as a tag is not mistaken for one', () => {
      const filter = aiSearchService.smartLocalNlp(`Photo tagged ${uid(1)}_nonexistent_word`, people, []);
      expect(filter.tagsMustInclude).toBeUndefined();
    });

    it('several known tags mentioned together are all picked up', () => {
      const t1 = `${uid(1)}_screenshot`;
      const t2 = `${uid(1)}_chatapp`;
      recordFinding(uid(1), 'x', { match: true, confidence: 0.9, tags: [t1, t2] });
      const filter = aiSearchService.smartLocalNlp(`Photo tagged ${t1} and ${t2}`, people, [photo(uid(1))]);
      expect(filter.tagsMustInclude?.sort()).toEqual([t1, t2].sort());
    });
  });

  describe('applyFilter: matching against each photo\'s own cached tags', () => {
    it('matches only photos whose cached tags include every required one', () => {
      const tag = `${uid(1)}_bill`;
      recordFinding(uid(1), 'x', { match: true, confidence: 0.9, tags: [tag, 'other'] });
      recordFinding(uid(2), 'x', { match: true, confidence: 0.9, tags: ['other'] }); // missing the required tag
      const photos = [photo(uid(1)), photo(uid(2)), photo(uid(3))]; // p3 was never analysed at all
      const result = aiSearchService.applyFilter({ queryText: '', explanation: '', tagsMustInclude: [tag] }, photos, people);
      expect(result.map((p) => p.id)).toEqual([uid(1)]);
    });

    it('requires every tag when more than one is specified (AND, not OR)', () => {
      const a = `${uid(1)}_a`, b = `${uid(1)}_b`;
      recordFinding(uid(1), 'x', { match: true, confidence: 0.9, tags: [a, b] });
      recordFinding(uid(2), 'x', { match: true, confidence: 0.9, tags: [a] }); // only one of the two
      const result = aiSearchService.applyFilter(
        { queryText: '', explanation: '', tagsMustInclude: [a, b] },
        [photo(uid(1)), photo(uid(2))],
        people
      );
      expect(result.map((p) => p.id)).toEqual([uid(1)]);
    });

    it('is case-insensitive, matching how tags are normalised when recorded', () => {
      const tag = `${uid(1)}_Receipt`;
      recordFinding(uid(1), 'x', { match: true, confidence: 0.9, tags: [tag] }); // recordFinding lowercases on write
      const result = aiSearchService.applyFilter(
        { queryText: '', explanation: '', tagsMustInclude: [tag.toUpperCase()] },
        [photo(uid(1))],
        people
      );
      expect(result.map((p) => p.id)).toEqual([uid(1)]);
    });

    it('a photo Smart Flow has never analysed is excluded, not treated as an unknown match', () => {
      const result = aiSearchService.applyFilter(
        { queryText: '', explanation: '', tagsMustInclude: [`${uid(1)}_whatever`] },
        [photo(uid(1))],
        people
      );
      expect(result).toEqual([]);
    });
  });

  describe('end-to-end through search() on the local (no cloud provider) path', () => {
    it('picking a tag from the "&" list finds only photos carrying it', async () => {
      const tag = `${uid(1)}_screenshot`;
      recordFinding(uid(1), 'x', { match: true, confidence: 0.9, tags: [tag] });
      recordFinding(uid(2), 'x', { match: true, confidence: 0.9, tags: ['unrelated'] });
      const photos = [photo(uid(1)), photo(uid(2))];
      const res = await aiSearchService.search(`Photo ${tag}`, photos, people);
      expect(res.matchedPhotos.map((p) => p.id)).toEqual([uid(1)]);
      expect(res.filter.tagsMustInclude).toEqual([tag]);
    });
  });
});
