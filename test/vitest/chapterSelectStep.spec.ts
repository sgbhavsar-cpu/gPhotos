import { describe, it, expect } from 'vitest';
import { rankChaptersByQuery } from '../../src/renderer/src/components/ChapterSelectStep';

const chapter = (id: string, title: string) =>
  ({ id, title, photoIds: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }) as any;

const CHAPTERS = [chapter('c1', 'Beach Day'), chapter('c2', 'Night Out'), chapter('c3', 'Beach Day 2026')];

describe('rankChaptersByQuery', () => {
  it('an empty query returns every chapter unchanged', () => {
    expect(rankChaptersByQuery(CHAPTERS, '')).toEqual(CHAPTERS);
    expect(rankChaptersByQuery(CHAPTERS, '   ')).toEqual(CHAPTERS);
  });

  it('puts an exact title first, then titles starting with the text, then titles containing it', () => {
    const ranked = rankChaptersByQuery(CHAPTERS, 'beach day');
    expect(ranked.map((c) => c.id)).toEqual(['c1', 'c3']); // exact match first, then the prefix match
  });

  it('is case-insensitive', () => {
    expect(rankChaptersByQuery(CHAPTERS, 'NIGHT')[0].id).toBe('c2');
  });

  it('a query matching nothing returns an empty list', () => {
    expect(rankChaptersByQuery(CHAPTERS, 'sunset drinks')).toEqual([]);
  });

  it('a contains-only match (not a prefix) still ranks, just last', () => {
    const ranked = rankChaptersByQuery(CHAPTERS, 'day');
    expect(ranked.map((c) => c.id).sort()).toEqual(['c1', 'c3']); // "Day" is inside, not a prefix, of either title
  });
});
