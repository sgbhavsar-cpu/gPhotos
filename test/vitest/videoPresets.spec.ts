import { describe, it, expect } from 'vitest';
import { autoPickIds, estimateSizeMB, formatSizeMB, VIDEO_TEMPLATES, EXPORT_PRESETS } from '../../src/renderer/src/services/videoPresets';
import { VIDEO_FILTERS, VIDEO_MOTIONS, VIDEO_TRANSITIONS } from '../../src/types/videoFormat';

const ph = (id: string, t: string, extra: any = {}) => ({ id, filePath: id + '.jpg', fileName: id, dateTaken: t, ...extra }) as any;

describe('templates and presets only use choices the exporter really has', () => {
  it('every template names a known look, movement and transition', () => {
    const looks = new Set(VIDEO_FILTERS.map(([v]) => v)), moves = new Set(VIDEO_MOTIONS.map(([v]) => v)), trans = new Set(VIDEO_TRANSITIONS.map(([v]) => v));
    for (const t of VIDEO_TEMPLATES) {
      expect(looks.has(t.filter)).toBe(true);
      expect(moves.has(t.motion)).toBe(true);
      for (const x of Array.isArray(t.transition) ? t.transition : [t.transition]) expect(trans.has(x)).toBe(true);
    }
    expect(EXPORT_PRESETS.length).toBeGreaterThan(2);
  });
});

describe('estimateSizeMB', () => {
  it('grows with length and quality, and is smaller at 720p', () => {
    expect(estimateSizeMB(60, '1080p', 'good')).toBeCloseTo(37.5, 1);
    expect(estimateSizeMB(120, '1080p', 'good')).toBeGreaterThan(estimateSizeMB(60, '1080p', 'good'));
    expect(estimateSizeMB(60, '720p', 'good')).toBeLessThan(estimateSizeMB(60, '1080p', 'good'));
    expect(estimateSizeMB(60, '1080p', 'good', true)).toBeGreaterThan(estimateSizeMB(60, '1080p', 'good'));
  });
  it('formats MB and GB', () => { expect(formatSizeMB(4.26)).toBe('4.3 MB'); expect(formatSizeMB(37.5)).toBe('38 MB'); expect(formatSizeMB(2048)).toBe('2.0 GB'); });
});

describe('autoPickIds', () => {
  it('returns everything (in order) when the album is already small enough', () => {
    expect(autoPickIds([ph('a', '2026-01-01T10:00:00Z'), ph('b', '2026-01-01T11:00:00Z')], 5)).toEqual(['a', 'b']);
  });
  it('skips excluded photos and collapses a burst to its sharpest shot', () => {
    const list = [
      ph('x', '2026-01-01T10:00:00Z', { isExcluded: true }),
      ph('b1', '2026-01-01T10:00:00Z', { sharpnessScore: 10 }), ph('b2', '2026-01-01T10:00:02Z', { sharpnessScore: 90 }), ph('b3', '2026-01-01T10:00:03Z', { sharpnessScore: 40 }),
      ph('c', '2026-01-01T12:00:00Z', { sharpnessScore: 50 }), ph('d', '2026-01-01T14:00:00Z', { sharpnessScore: 60 }),
    ];
    const picked = autoPickIds(list, 3);
    expect(picked).not.toContain('x');
    expect(picked.filter((id) => id.startsWith('b'))).toEqual(['b2']);
    expect(picked).toEqual(['b2', 'c', 'd']);
  });
  it('prefers favourites and people, keeps album order, and keeps a video in the mix', () => {
    const list = [
      ph('p1', '2026-01-01T09:00:00Z', { sharpnessScore: 5 }),
      ph('fav', '2026-01-01T10:00:00Z', { isFavorite: true, sharpnessScore: 5 }),
      ph('faces', '2026-01-01T11:00:00Z', { faces: [{}, {}], sharpnessScore: 5 }),
      ph('clip', '2026-01-01T12:00:00Z', { isVideo: true, sharpnessScore: 5 }),
      ph('p2', '2026-01-01T13:00:00Z', { sharpnessScore: 5 }),
    ];
    expect(autoPickIds(list, 3)).toEqual(['fav', 'faces', 'clip']);
  });
});
