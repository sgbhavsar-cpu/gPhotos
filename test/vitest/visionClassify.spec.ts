import { describe, it, expect } from 'vitest';
import { buildBatchClassifyPrompt, parseBatchClassifyResponse } from '../../src/renderer/src/services/visionClassify';

// Reported bug: "information returned from local model is associated with wrong image" — a vision
// model's JSON array came back the right length and well-formed, but not actually in the order the
// images were sent, silently mismatching every caption/tag/match after the scrambled entry to the
// wrong photo. The fix asks every entry to name which image it describes (buildBatchClassifyPrompt)
// and maps by that index when the model actually does so (parseBatchClassifyResponse), rather than
// trusting raw array position.
describe('buildBatchClassifyPrompt', () => {
  it('tells the model to name which image each answer is about', () => {
    const prompt = buildBatchClassifyPrompt(3, 'a scanned bill');
    expect(prompt).toMatch(/"image"/);
    expect(prompt).toContain('a scanned bill');
  });
});

describe('parseBatchClassifyResponse: mapping answers back to the right photo', () => {
  it('maps by the explicit "image" index, not array position, when the model answers out of order', () => {
    // Entries deliberately listed as 3, 1, 2 — exactly the "scrambled order" failure mode.
    const raw = JSON.stringify([
      { image: 3, match: true, confidence: 0.9, caption: 'third photo', tags: ['c'] },
      { image: 1, match: false, confidence: 0.2, caption: 'first photo', tags: ['a'] },
      { image: 2, match: true, confidence: 0.8, caption: 'second photo', tags: ['b'] },
    ]);
    const result = parseBatchClassifyResponse(raw, 3);
    expect(result.map((r) => r.caption)).toEqual(['first photo', 'second photo', 'third photo']);
    expect(result[0]).toMatchObject({ match: false, caption: 'first photo' });
    expect(result[2]).toMatchObject({ match: true, caption: 'third photo' });
  });

  it('a well-behaved in-order response with indices still maps correctly (the common case)', () => {
    const raw = JSON.stringify([
      { image: 1, match: true, confidence: 0.9, caption: 'one', tags: [] },
      { image: 2, match: false, confidence: 0.1, caption: 'two', tags: [] },
    ]);
    expect(parseBatchClassifyResponse(raw, 2).map((r) => r.caption)).toEqual(['one', 'two']);
  });

  it('falls back to plain array position when no entry has an "image" field at all (an older/other model)', () => {
    const raw = JSON.stringify([
      { match: true, confidence: 0.9, caption: 'one', tags: [] },
      { match: false, confidence: 0.1, caption: 'two', tags: [] },
    ]);
    expect(parseBatchClassifyResponse(raw, 2).map((r) => r.caption)).toEqual(['one', 'two']);
  });

  it('falls back to plain array position when the indices are duplicated (a confused model) rather than silently overwriting one', () => {
    const raw = JSON.stringify([
      { image: 1, match: true, confidence: 0.9, caption: 'one', tags: [] },
      { image: 1, match: false, confidence: 0.1, caption: 'two', tags: [] },
    ]);
    expect(parseBatchClassifyResponse(raw, 2).map((r) => r.caption)).toEqual(['one', 'two']);
  });

  it('falls back to plain array position when an index is out of range rather than trusting a partial match', () => {
    const raw = JSON.stringify([
      { image: 1, match: true, confidence: 0.9, caption: 'one', tags: [] },
      { image: 5, match: false, confidence: 0.1, caption: 'two', tags: [] },
    ]);
    expect(parseBatchClassifyResponse(raw, 2).map((r) => r.caption)).toEqual(['one', 'two']);
  });

  it('falls back to plain array position when only some entries name an index (partial trust is riskier than none)', () => {
    const raw = JSON.stringify([
      { image: 1, match: true, confidence: 0.9, caption: 'one', tags: [] },
      { match: false, confidence: 0.1, caption: 'two', tags: [] },
    ]);
    expect(parseBatchClassifyResponse(raw, 2).map((r) => r.caption)).toEqual(['one', 'two']);
  });

  it('still rejects a wrong-length array exactly as before', () => {
    const raw = JSON.stringify([{ image: 1, match: true, confidence: 0.9, caption: 'one', tags: [] }]);
    expect(() => parseBatchClassifyResponse(raw, 2)).toThrow(/Expected 2/);
  });
});
