import { describe, it, expect } from 'vitest';
import { identifyDuplicateClusters, identifyExactDuplicateClusters } from '../../src/renderer/src/services/deduplication';
import type { Photo } from '../../src/types';

const photo = (n: number, over: Partial<Photo> = {}): Photo => ({
  id: `p${n}`, filePath: `C:\\Photos\\p${n}.jpg`, fileName: `p${n}.jpg`, fileSize: 1_000_000,
  dateTaken: '2026-01-01T00:00:00Z', year: 2026, month: 1, day: 1, width: 4000, height: 3000,
  isFavorite: false,
  ...over,
}) as Photo;

describe('identifyExactDuplicateClusters (same file size + dimensions, no time window)', () => {
  it('groups two photos with identical size and dimensions taken months apart', () => {
    const a = photo(1, { dateTaken: '2026-01-01T00:00:00Z' });
    const b = photo(2, { dateTaken: '2026-06-01T00:00:00Z' }); // far outside the fuzzy mode's time window
    const clusters = identifyExactDuplicateClusters([a, b]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].clusterType).toBe('identical');
    expect(clusters[0].photos.map((p) => p.id).sort()).toEqual(['p1', 'p2']);
  });

  it('does not group photos with the same dimensions but a different file size', () => {
    const a = photo(1, { fileSize: 1_000_000 });
    const b = photo(2, { fileSize: 2_000_000 });
    expect(identifyExactDuplicateClusters([a, b])).toEqual([]);
  });

  it('does not group photos with the same file size but different dimensions', () => {
    const a = photo(1, { width: 4000, height: 3000 });
    const b = photo(2, { width: 1920, height: 1080 });
    expect(identifyExactDuplicateClusters([a, b])).toEqual([]);
  });

  it('excludes a photo with no known width/height from exact comparison entirely', () => {
    const a = photo(1);
    const b = photo(2, { width: undefined, height: undefined });
    expect(identifyExactDuplicateClusters([a, b])).toEqual([]);
  });

  it('three exact matches form one cluster, scored for a best-shot pick like the fuzzy mode', () => {
    const group = [photo(1), photo(2), photo(3)];
    const clusters = identifyExactDuplicateClusters(group);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].photos).toHaveLength(3);
    expect(Object.keys(clusters[0].scores)).toHaveLength(3);
    expect(clusters[0].photos.map((p) => p.id)).toContain(clusters[0].bestPhotoId);
  });

  it('an excluded photo is never matched against itself (canonical-path de-dup still applies)', () => {
    const a = photo(1);
    const sameFileTwice = { ...a, id: 'p1dup' }; // same canonical path (filePath), different id
    expect(identifyExactDuplicateClusters([a, sameFileTwice])).toEqual([]);
  });
});

// Regression check: refactoring the scoring/packaging into a shared buildClusterFromGroup() helper
// must not change identifyDuplicateClusters' own existing behavior.
describe('identifyDuplicateClusters (fuzzy mode, unaffected by the shared-helper refactor)', () => {
  it('still groups a burst of same-second shots with no faces', () => {
    const group = [
      photo(1, { dateTaken: '2026-01-01T10:00:00Z', fileName: 'IMG_001.jpg' }),
      photo(2, { dateTaken: '2026-01-01T10:00:02Z', fileName: 'IMG_002.jpg' }),
      photo(3, { dateTaken: '2026-01-01T10:00:04Z', fileName: 'IMG_003.jpg' }),
    ];
    const clusters = identifyDuplicateClusters(group);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].clusterType).toBe('burst');
    expect(clusters[0].photos).toHaveLength(3);
  });

  it('does not group photos outside the time window', () => {
    const a = photo(1, { dateTaken: '2026-01-01T10:00:00Z' });
    const b = photo(2, { dateTaken: '2026-01-01T11:00:00Z' });
    expect(identifyDuplicateClusters([a, b])).toEqual([]);
  });
});
