import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// A long-but-finite tracked operation (no AbortController) must not have its "waiting" indicator
// silently end at the 5s safety timeout while the real promise is still running — see the fix in
// responseTracker.ts's startOperation.
describe('responseTracker: safety timeout only applies to abortable operations', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a non-abortable call past 5s is still tracked as active, and reports done when it actually resolves', async () => {
    vi.resetModules();
    const { trackBackendCall, responseTracker } = await import('../../src/renderer/src/services/responseTracker');

    let resolvePromise: () => void;
    const longCall = new Promise<void>((resolve) => { resolvePromise = resolve; });
    const tracked = trackBackendCall(longCall, 'A long rescan...');

    await vi.advanceTimersByTimeAsync(10000); // well past the old 5s safety timeout
    expect(responseTracker.getState().activeCount).toBe(1); // still tracked — not silently ended

    resolvePromise!();
    await tracked;
    expect(responseTracker.getState().activeCount).toBe(0);
    expect(responseTracker.getState().isWaitingBackend).toBe(false);
  });

  it('an abortable call past 5s is actually aborted, not just hidden', async () => {
    vi.resetModules();
    const { trackBackendCall, responseTracker } = await import('../../src/renderer/src/services/responseTracker');

    const controller = new AbortController();
    const neverResolves = new Promise<void>(() => {});
    trackBackendCall(neverResolves, 'A cancellable call...', controller);

    await vi.advanceTimersByTimeAsync(5500);
    expect(responseTracker.getState().activeCount).toBe(0); // safety timeout fired
    expect(controller.signal.aborted).toBe(true); // ...and it's a REAL cancel, not just a hidden indicator
  });
});
