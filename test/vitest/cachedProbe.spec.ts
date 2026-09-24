import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createCachedProbe } from '../../src/main/services/cachedProbe';

// Regression: getBackgroundServiceStatus ran execSync('reg query') on every call —
// 1-3s of frozen main process each time. get() must never wait on the probe.
describe('createCachedProbe', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('get() returns immediately without waiting for a slow probe, then serves the probed value', async () => {
    let resolveProbe!: (v: boolean) => void;
    const probe = vi.fn(() => new Promise<boolean>((res) => { resolveProbe = res; }));
    const c = createCachedProbe(probe, 30_000, false);

    expect(c.get()).toBe(false);          // initial value, instantly
    expect(probe).toHaveBeenCalledTimes(1); // background refresh started
    expect(c.get()).toBe(false);          // still in flight: no second probe, still instant
    expect(probe).toHaveBeenCalledTimes(1);

    resolveProbe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(c.get()).toBe(true);
    expect(probe).toHaveBeenCalledTimes(1); // fresh: not re-probed
  });

  it('refreshes in the background once stale, serving the old value meanwhile', async () => {
    let next = true;
    const probe = vi.fn(async () => next);
    const c = createCachedProbe(probe, 1000, false);
    c.get(); await vi.advanceTimersByTimeAsync(0);
    expect(c.get()).toBe(true);
    next = false;
    await vi.advanceTimersByTimeAsync(1500);
    expect(c.get()).toBe(true);            // stale read returns the last known value immediately...
    await vi.advanceTimersByTimeAsync(0);
    expect(c.get()).toBe(false);           // ...and the refreshed one on the next read
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('set() records a value we just caused, so no probe is needed', () => {
    const probe = vi.fn(async () => false);
    const c = createCachedProbe(probe, 30_000, false);
    c.set(true);
    expect(c.get()).toBe(true);
    expect(probe).not.toHaveBeenCalled();
  });

  it('keeps the last value when the probe fails, and retries on the next stale read', async () => {
    let fail = false;
    const probe = vi.fn(async () => { if (fail) throw new Error('boom'); return true; });
    const c = createCachedProbe(probe, 1000, false);
    c.get(); await vi.advanceTimersByTimeAsync(0);
    fail = true;
    await vi.advanceTimersByTimeAsync(1500);
    expect(c.get()).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(c.get()).toBe(true);             // failure didn't clobber it
    fail = false;
    await vi.advanceTimersByTimeAsync(1500);
    c.get(); await vi.advanceTimersByTimeAsync(0);
    expect(probe.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
});
