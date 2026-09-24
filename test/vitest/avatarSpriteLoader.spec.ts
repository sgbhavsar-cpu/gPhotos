import { describe, it, expect, beforeEach, vi } from 'vitest';

// The loader must never let stale look-ahead starve the cards on screen
// (the bug: while scrolling, every window queued ~140 look-ahead keys and the
// visible cards waited behind all of them, staying blank).
type Call = string[]; // personIds per IPC call, in call order

describe('avatarSpriteLoader queue priorities', () => {
  let calls: Call[];
  let loader: typeof import('../../src/renderer/src/services/avatarSpriteLoader');

  const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => ({ personId: `${prefix}${i}`, cacheKey: 'f' }));

  beforeEach(async () => {
    calls = [];
    vi.useFakeTimers();
    (globalThis as any).window = {
      electronAPI: {
        getPersonAvatarSprites: async (items: Array<{ personId: string; cacheKey: string }>) => {
          calls.push(items.map((i) => i.personId));
          const out: Record<string, any> = {};
          for (const i of items) out[`${i.personId}::${i.cacheKey}`] = { spriteId: 's', col: 0, row: 0, rows: 1, tile: 160 };
          return out;
        },
      },
    };
    vi.resetModules();
    loader = await import('../../src/renderer/src/services/avatarSpriteLoader');
    loader.resetAvatarSpriteLoaderForTests();
  });

  const drain = async () => {
    await vi.advanceTimersByTimeAsync(30); // debounce
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 20; i++) await Promise.resolve(); // let the worker's awaited calls settle
  };

  it('sends visible requests in chunks of at most 50 (one sheet each) and look-ahead in smaller chunks', async () => {
    for (const it of ids('v', 120)) loader.requestAvatarSprite(it.personId, it.cacheKey);
    await drain();
    expect(calls.map((c) => c.length)).toEqual([50, 50, 20]);

    calls.length = 0;
    loader.prefetchAvatarSprites(ids('p', 50));
    await drain();
    expect(calls.map((c) => c.length)).toEqual([20, 20, 10]); // short in-flight wait for a card that mounts mid-run
  });

  it('a card that mounts while look-ahead is queued is served before the remaining look-ahead', async () => {
    loader.prefetchAvatarSprites(ids('ahead', 200)); // 4 chunks of look-ahead
    loader.requestAvatarSprite('onscreen', 'f');
    await drain();
    expect(calls[0]).toContain('onscreen'); // first call, not last
    expect(calls[0]).not.toContain('ahead0'); // visible chunk goes before any look-ahead
  });

  it('a newer prefetch replaces older unsent look-ahead instead of queueing behind it', async () => {
    loader.prefetchAvatarSprites(ids('old', 200));
    loader.prefetchAvatarSprites(ids('new', 60)); // user scrolled: window moved
    await drain();
    const sent = calls.flat();
    expect(sent.some((p) => p.startsWith('old'))).toBe(false);
    expect(sent.filter((p) => p.startsWith('new'))).toHaveLength(60);
  });

  it('drops a visible request whose card unmounted before it was sent', async () => {
    loader.requestAvatarSprite('gone', 'f');
    loader.requestAvatarSprite('stays', 'f');
    loader.cancelAvatarSpriteRequest('gone', 'f');
    await drain();
    expect(calls.flat()).toEqual(['stays']);
  });

  it('promotes a key that was only look-ahead when a card needs it, without asking twice', async () => {
    loader.prefetchAvatarSprites([{ personId: 'x', cacheKey: 'f' }, ...ids('other', 10)]);
    loader.requestAvatarSprite('x', 'f');
    await drain();
    expect(calls.flat().filter((p) => p === 'x')).toHaveLength(1);
    expect(calls[0][0]).toBe('x'); // visible queue first
  });

  it('does not re-request tiles it already resolved', async () => {
    loader.requestAvatarSprite('a', 'f');
    await drain();
    loader.requestAvatarSprite('a', 'f');
    loader.prefetchAvatarSprites([{ personId: 'a', cacheKey: 'f' }]);
    await drain();
    expect(calls.flat()).toEqual(['a']);
  });
});
