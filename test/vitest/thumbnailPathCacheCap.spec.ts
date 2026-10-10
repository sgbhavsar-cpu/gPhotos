import { describe, it, expect, beforeEach } from 'vitest';
import { thumbnailWorker } from '../../src/main/services/thumbnailWorkerService';

// Regression test for the OOM fix in CODE_REVIEW §57: confirmedCachedPaths is deliberately never
// cleared on library switch (see its own comment in thumbnailWorkerService.ts), so without a cap it
// grew by one entry per distinct photo path ever seen, for the life of the process.
describe('thumbnail worker confirmedCachedPaths cap (OOM fix)', () => {
  beforeEach(() => {
    thumbnailWorker.useIsolatedStateForTests('');
  });

  it('trims the oldest entries once the cap is exceeded', () => {
    const CAP = 200_000; // MAX_CONFIRMED_CACHED_PATHS
    for (let i = 0; i < CAP + 50; i++) {
      thumbnailWorker.seedConfirmedCachedPathForTests(`c:\\lib\\photo${i}.jpg`);
    }
    expect(thumbnailWorker.getConfirmedCachedPathsSizeForTests()).toBe(CAP + 50);
    thumbnailWorker.trimUnboundedPathCachesForTests();
    expect(thumbnailWorker.getConfirmedCachedPathsSizeForTests()).toBe(CAP);
  });

  it('does nothing when under the cap', () => {
    thumbnailWorker.seedConfirmedCachedPathForTests('c:\\lib\\photo1.jpg');
    thumbnailWorker.trimUnboundedPathCachesForTests();
    expect(thumbnailWorker.getConfirmedCachedPathsSizeForTests()).toBe(1);
  });
});
