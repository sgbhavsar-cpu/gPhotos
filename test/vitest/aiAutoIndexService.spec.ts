// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Photo } from '../../src/types';

const photo = (id: string, over: Partial<Photo> = {}): Photo => ({
  id, filePath: `C:\\Photos\\${id}.jpg`, fileName: `${id}.jpg`, fileSize: 1,
  dateTaken: '2026-01-01', year: 2026, month: 1, day: 1, isFavorite: false,
  ...over,
}) as Photo;

describe('aiAutoIndexService (docs/FEATURE_AI_AUTO_TAGGING.md)', () => {
  let svc: typeof import('../../src/renderer/src/services/aiAutoIndexService');
  let contentCache: typeof import('../../src/renderer/src/services/photoContentCache');
  let lock: typeof import('../../src/renderer/src/services/visionJobLock');
  let fetchMock: ReturnType<typeof vi.fn>;

  /** Builds a response sized to match however many images this particular /api/chat call actually sent. */
  const chatResponseFor = (opts: any) => {
    const body = JSON.parse(opts.body);
    const imageCount = body.messages.filter((m: any) => Array.isArray(m.images)).length;
    const arr = Array.from({ length: imageCount }, (_, i) => ({
      image: i + 1, match: false, confidence: 0.3, caption: 'a cat on a sofa', tags: ['cat', 'indoor'],
    }));
    return { ok: true, json: async () => ({ message: { content: JSON.stringify(arr) } }) };
  };

  const load = async () => {
    localStorage.clear();
    vi.resetModules();
    svc = await import('../../src/renderer/src/services/aiAutoIndexService');
    contentCache = await import('../../src/renderer/src/services/photoContentCache');
    lock = await import('../../src/renderer/src/services/visionJobLock');
    contentCache.resetForTests();
    lock.setManualFlowRunning(false);
  };

  beforeEach(() => {
    fetchMock = vi.fn(async (url: string, opts?: any) => {
      if (url.includes('/api/tags')) return { ok: true, json: async () => ({ models: [{ name: 'qwen2.5vl:7b' }] }) };
      if (url.includes('/api/show')) return { ok: true, json: async () => ({ model_info: {} }) };
      if (url.includes('/api/chat')) return chatResponseFor(opts);
      if (url.includes('/api/embed')) return { ok: true, json: async () => ({ embeddings: [[0.1, 0.2]] }) };
      if (url.includes('/api/photo')) return { ok: true, blob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }) };
      return { ok: false, status: 404 };
    });
    (globalThis as any).fetch = fetchMock;
  });

  it('T1: every photo with no cache entry gets described when Ollama is available', async () => {
    await load();
    svc.setAutoIndexEnabled(true);
    await svc.runAutoIndexPass([photo('a'), photo('b')]);

    expect(contentCache.getEntry('a')?.caption).toBe('a cat on a sofa');
    expect(contentCache.getEntry('a')?.tags).toEqual(['cat', 'indoor']);
    expect(contentCache.getEntry('b')?.caption).toBe('a cat on a sofa');
  });

  it('T2: a photo that already has a cached caption is not re-sent', async () => {
    await load();
    contentCache.recordFinding('already-done', 'x', { match: false, confidence: 0.5, caption: 'existing caption', tags: ['x'] });
    svc.setAutoIndexEnabled(true);

    await svc.runAutoIndexPass([photo('already-done'), photo('new-one')]);

    const chatCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/api/chat'));
    expect(chatCalls).toHaveLength(1); // only "new-one" classified
    expect(contentCache.getEntry('already-done')?.caption).toBe('existing caption'); // untouched
  });

  it('T3: Ollama unavailable makes zero vision calls and reports waitingForOllama', async () => {
    await load();
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/api/tags')) return { ok: true, json: async () => ({ models: [] }) }; // no vision model installed
      return { ok: false, status: 404 };
    });
    svc.setAutoIndexEnabled(true);
    let lastStatus: any = null;
    const unsubscribe = svc.subscribe((s) => { lastStatus = s; });

    await svc.runAutoIndexPass([photo('a')]);

    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/api/chat'))).toBe(false);
    expect(lastStatus.waitingForOllama).toBe(true);
    unsubscribe();
  });

  it('T4: disabled makes zero vision calls at all', async () => {
    await load();
    svc.setAutoIndexEnabled(false);
    await svc.runAutoIndexPass([photo('a')]);
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/api/chat'))).toBe(false);
  });

  it('T5: defers while a manual Smart Flow is running', async () => {
    await load();
    svc.setAutoIndexEnabled(true);
    lock.setManualFlowRunning(true);

    await svc.runAutoIndexPass([photo('a')]);

    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/api/chat'))).toBe(false);
  });

  it('T6: a video photo is never included as a candidate', async () => {
    await load();
    svc.setAutoIndexEnabled(true);
    await svc.runAutoIndexPass([photo('vid', { isVideo: true })]);

    expect(contentCache.getEntry('vid')).toBeUndefined();
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/api/chat'))).toBe(false);
  });

  it('T7: a batch that throws does not stop the pass — other photos are unaffected and nothing crashes', async () => {
    await load();
    let chatCallCount = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/api/tags')) return { ok: true, json: async () => ({ models: [{ name: 'qwen2.5vl:7b' }] }) };
      if (url.includes('/api/show')) return { ok: true, json: async () => ({ model_info: {} }) };
      if (url.includes('/api/chat')) {
        chatCallCount++;
        return { ok: false, status: 500 }; // every classify call fails this pass
      }
      if (url.includes('/api/photo')) return { ok: true, blob: async () => new Blob([new Uint8Array([1])], { type: 'image/jpeg' }) };
      return { ok: false, status: 404 };
    });
    svc.setAutoIndexEnabled(true);

    await expect(svc.runAutoIndexPass([photo('a'), photo('b')])).resolves.toBeUndefined();
    expect(chatCallCount).toBeGreaterThan(0);
    expect(contentCache.getEntry('a')).toBeUndefined(); // failed batch — nothing recorded, will retry next pass
  });

  it('T9: uses computeLocalBatchSize/resolveEffectiveContext the same way Smart Flows does (sized from the context window)', async () => {
    await load();
    svc.setAutoIndexEnabled(true);
    await svc.runAutoIndexPass([photo('a')]);

    const chatCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/chat'));
    expect(chatCall).toBeTruthy();
    const body = JSON.parse(chatCall![1].body);
    expect(body.options.num_ctx).toBe(4096); // default context window, same math as ollamaVisionService
  });
});
