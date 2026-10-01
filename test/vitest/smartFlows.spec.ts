// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/renderer/src/services/photoRelocationFlow', () => ({
  movePhotosToFolder: vi.fn(async (photos: any[]) => ({ targetDir: 'Z:\\Photos\\Sorted', moved: photos.length, skipped: 0, failed: 0 })),
}));

const photo = (n: number) => ({
  id: `p${n}`, filePath: `C:\\Mirrors\\IMG_${n}.jpg`, fileName: `IMG_${n}.jpg`, fileSize: 1,
  dateTaken: '2026-01-01', year: 2026, month: 1, day: 1,
}) as any;

// The fetch mock encodes which photo a "thumbnail" came from as a single byte, so the batch mock
// (which only sees base64 blobs, exactly like the real classifyImagesBatch) can tell items apart —
// the same way production code would only ever see pixels, not photo ids.
const photoNumFromBase64 = (b64: string): number => atob(b64).charCodeAt(0);

describe('smartFlowsService', () => {
  let flowsMod: any;
  let libMod: any;
  let relocation: any;
  let classifyImagesBatch: any;
  let batchImpl: (items: Array<{ base64: string; mimeType: string }>, description: string) => Promise<any[]>;
  let unreadablePhotoNum: number | null;
  let isVisionAvailable: any;
  let classifyImagesBatchLocal: any;
  let embedText: any;
  let localImpl: (items: Array<{ base64: string; mimeType: string }>, description: string) => Promise<any[]>;

  const load = async () => {
    unreadablePhotoNum = null;
    batchImpl = async (items) => items.map(() => ({ match: false, confidence: 0.1, caption: '', tags: [] }));
    classifyImagesBatch = vi.fn((items: any, description: any) => batchImpl(items, description));
    // Ollama unavailable by default — every existing test exercises only the cache + cloud tiers,
    // exactly as before this tier existed. Tests for the local-model tier override these below.
    localImpl = async () => { throw new Error('should not be called when Ollama is unavailable'); };
    isVisionAvailable = vi.fn(async () => false);
    classifyImagesBatchLocal = vi.fn((items: any, description: any) => localImpl(items, description));
    embedText = vi.fn(async () => null);
    (window as any).electronAPI = { loadLibraryData: async () => null, saveLibraryData: async () => true };
    (globalThis as any).fetch = vi.fn(async (url: string) => {
      const m = /IMG_(\d+)\.jpg/.exec(url);
      const n = m ? parseInt(m[1], 10) : 0;
      if (n === unreadablePhotoNum) throw new Error('network error');
      return { ok: true, blob: async () => ({ type: 'image/jpeg', arrayBuffer: async () => new Uint8Array([n]).buffer }) };
    });
    localStorage.clear();
    vi.resetModules();
    vi.doMock('../../src/renderer/src/services/aiSearchService', () => ({
      aiSearchService: {
        classifyImagesBatch,
        getConfig: () => ({ provider: 'gemini', geminiApiKey: 'k' }),
        getSmartFlowsConfig: () => ({ provider: 'gemini', geminiApiKey: 'k' }),
      },
    }));
    vi.doMock('../../src/renderer/src/services/ollamaVisionService', () => ({
      isVisionAvailable: (...args: any[]) => isVisionAvailable(...args),
      classifyImagesBatchLocal: (...args: any[]) => classifyImagesBatchLocal(...args),
      embedText: (...args: any[]) => embedText(...args),
      // Fixed at 32768/16 here — the actual sizing math has its own coverage in ollamaVisionService.spec.ts.
      getOllamaConfig: () => ({ baseUrl: 'http://localhost:11434', visionModel: 'qwen2.5vl:7b', embedModel: 'nomic-embed-text', contextWindow: 32768 }),
      resolveEffectiveContext: async () => 32768,
      computeLocalBatchSize: () => 16,
    }));
    libMod = await import('../../src/renderer/src/services/libraryStore');
    relocation = await import('../../src/renderer/src/services/photoRelocationFlow');
    flowsMod = await import('../../src/renderer/src/services/smartFlowsService');
    return libMod.libraryStore;
  };

  beforeEach(() => vi.resetAllMocks());

  it('does not spend an API call until the flow is consented to', async () => {
    const store = await load();
    store.getState().photos = [photo(1)];
    const flow = flowsMod.createFlow('Screenshots', 'a phone screenshot', { type: 'album', albumName: 'Screens' });

    const result = await flowsMod.runFlow(flow, store.getState().photos, 10);

    expect(result).toBeNull();
    expect(classifyImagesBatch).not.toHaveBeenCalled();
  });

  it('classifies unclassified photos up to the cap in one batched call, then files matches into a (new or existing) album', async () => {
    const store = await load();
    batchImpl = async (items) =>
      items.map((it) => {
        const n = photoNumFromBase64(it.base64);
        const isScreenshot = n === 1 || n === 2;
        return { match: isScreenshot, confidence: 0.9, caption: isScreenshot ? 'a phone screenshot of an app' : 'a landscape photo', tags: isScreenshot ? ['screenshot'] : ['landscape'] };
      });
    const photos = [photo(1), photo(2), photo(3)];
    store.getState().photos = photos;
    store.getState().albums = [];
    let flow = flowsMod.createFlow('Screenshots', 'a phone screenshot', { type: 'album', albumName: 'Screens' });
    flowsMod.setFlowConsent(flow.id, true);
    flow = flowsMod.listFlows()[0];

    const result = await flowsMod.runFlow(flow, photos, 2); // cap below the photo count

    expect(classifyImagesBatch).toHaveBeenCalledTimes(1); // both sent together, not one call per photo
    expect(result).toEqual({ classified: 2, matched: 2, failed: 0, fromCache: 0, fromLocalModel: 0, actionSummary: expect.stringContaining('Screens') });
    const saved = flowsMod.listFlows()[0];
    expect(Object.keys(saved.classifiedIds).sort()).toEqual(['p1', 'p2']); // p3 left for next run
    const album = store.getState().albums.find((a: any) => a.title === 'Screens');
    expect(album.photoIds).toEqual(['p1', 'p2']);

    // Second run: only p3 is left to classify; it doesn't match.
    const result2 = await flowsMod.runFlow(flowsMod.listFlows()[0], photos, 10);
    expect(result2).toEqual({ classified: 1, matched: 0, failed: 0, fromCache: 0, fromLocalModel: 0, actionSummary: expect.stringContaining('Screens') });
    expect(Object.keys(flowsMod.listFlows()[0].classifiedIds).sort()).toEqual(['p1', 'p2', 'p3']);
  });

  it('an unreadable photo is counted as failed without blocking the rest of its batch', async () => {
    const store = await load();
    unreadablePhotoNum = 1;
    batchImpl = async (items) => items.map(() => ({ match: true, confidence: 0.9, caption: 'a scanned bill', tags: ['receipt', 'bill'] }));
    const photos = [photo(1), photo(2)];
    store.getState().photos = photos;
    store.getState().albums = [];
    const flow = flowsMod.createFlow('Bills', 'a scanned bill', { type: 'album', albumName: 'Bills' });
    flowsMod.setFlowConsent(flow.id, true);

    const result = await flowsMod.runFlow(flowsMod.listFlows()[0], photos, 10);

    expect(result.classified).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.matched).toBe(1); // photo 2 still classified and matched
    expect(classifyImagesBatch).toHaveBeenCalledTimes(1);
    expect(classifyImagesBatch.mock.calls[0][0]).toHaveLength(1); // only the readable photo was sent
  });

  it('a whole-batch API failure fails every photo in that batch, and is counted', async () => {
    const store = await load();
    batchImpl = async () => { throw new Error('rate limited'); };
    const photos = [photo(1), photo(2)];
    store.getState().photos = photos;
    const flow = flowsMod.createFlow('Bills', 'a scanned bill', { type: 'album', albumName: 'Bills' });
    flowsMod.setFlowConsent(flow.id, true);

    const result = await flowsMod.runFlow(flowsMod.listFlows()[0], photos, 10);

    expect(result).toEqual({ classified: 2, matched: 0, failed: 2, fromCache: 0, fromLocalModel: 0, actionSummary: undefined });
  });

  it('a move-action flow hands its matches to movePhotosToFolder', async () => {
    const store = await load();
    batchImpl = async (items) => items.map(() => ({ match: true, confidence: 0.9, caption: 'a scanned bill', tags: ['bill'] }));
    const photos = [photo(1)];
    store.getState().photos = photos;
    store.getState().albums = [];
    const flow = flowsMod.createFlow('Bills', 'a scanned bill', { type: 'move' });
    flowsMod.setFlowConsent(flow.id, true);

    const result = await flowsMod.runFlow(flowsMod.listFlows()[0], photos, 10);

    expect(relocation.movePhotosToFolder).toHaveBeenCalledWith([photos[0]], expect.objectContaining({ label: expect.stringContaining('Bills') }));
    expect(result.actionSummary).toContain('Moved 1');
  });

  it('a second, different flow reuses the first flow\'s cached verdict for an identical description — no new API call', async () => {
    const store = await load();
    batchImpl = async (items) => items.map(() => ({ match: true, confidence: 0.9, caption: 'a screenshot of a chat app on a phone', tags: ['screenshot', 'chat-app', 'phone'] }));
    const photos = [photo(1)];
    store.getState().photos = photos;
    store.getState().albums = [];

    const flowA = flowsMod.createFlow('Chats A', 'a phone screenshot of a chat app', { type: 'album', albumName: 'ChatsA' });
    flowsMod.setFlowConsent(flowA.id, true);
    await flowsMod.runFlow(flowsMod.listFlows().find((f: any) => f.id === flowA.id), photos, 10);
    expect(classifyImagesBatch).toHaveBeenCalledTimes(1);

    const flowB = flowsMod.createFlow('Chats B', 'a phone screenshot of a chat app', { type: 'album', albumName: 'ChatsB' });
    flowsMod.setFlowConsent(flowB.id, true);
    const result = await flowsMod.runFlow(flowsMod.listFlows().find((f: any) => f.id === flowB.id), photos, 10);

    expect(classifyImagesBatch).toHaveBeenCalledTimes(1); // still 1 — flow B answered itself from the shared cache
    expect(result).toMatchObject({ classified: 1, matched: 1, failed: 0, fromCache: 1 });
    const albumB = store.getState().albums.find((a: any) => a.title === 'ChatsB');
    expect(albumB.photoIds).toEqual(['p1']);
  });

  it('a different flow can also match via cached tags/caption alone, with no identical wording', async () => {
    const store = await load();
    batchImpl = async (items) => items.map(() => ({ match: true, confidence: 0.9, caption: 'a screenshot of a chat app on a phone', tags: ['screenshot', 'chat-app', 'phone'] }));
    const photos = [photo(1)];
    store.getState().photos = photos;
    store.getState().albums = [];

    const flowA = flowsMod.createFlow('Chats A', 'a phone screenshot of a chat app', { type: 'album', albumName: 'ChatsA' });
    flowsMod.setFlowConsent(flowA.id, true);
    await flowsMod.runFlow(flowsMod.listFlows().find((f: any) => f.id === flowA.id), photos, 10);

    const flowB = flowsMod.createFlow('Chats B', 'screenshot chat app conversation', { type: 'album', albumName: 'ChatsB' }); // different wording, overlapping keywords
    flowsMod.setFlowConsent(flowB.id, true);
    const result = await flowsMod.runFlow(flowsMod.listFlows().find((f: any) => f.id === flowB.id), photos, 10);

    expect(classifyImagesBatch).toHaveBeenCalledTimes(1); // flow B never called it
    expect(result.fromCache).toBe(1);
    expect(result.matched).toBe(1);
  });

  it('the local model is batched at 16 photos per call (32768-context sizing), not the cloud tier\'s 8', async () => {
    const store = await load();
    isVisionAvailable.mockResolvedValue(true);
    localImpl = async (items) => items.map(() => ({ match: false, confidence: 0.9, caption: 'x', tags: [] }));
    const photos = Array.from({ length: 17 }, (_, i) => photo(i + 1));
    store.getState().photos = photos;
    const flow = flowsMod.createFlow('Bills', 'a scanned bill', { type: 'album', albumName: 'Bills' });
    flowsMod.setFlowConsent(flow.id, true);

    await flowsMod.runFlow(flowsMod.listFlows()[0], photos, 20);

    expect(classifyImagesBatchLocal).toHaveBeenCalledTimes(2); // 16 + 1, not 3 batches of 8-ish
    expect(classifyImagesBatchLocal.mock.calls[0][0]).toHaveLength(16);
    expect(classifyImagesBatchLocal.mock.calls[1][0]).toHaveLength(1);
  });

  it('the cloud tier is still batched at 8 (unaffected by the local batch size)', async () => {
    const store = await load(); // isVisionAvailable defaults to false -> straight to cloud
    batchImpl = async (items) => items.map(() => ({ match: false, confidence: 0.9, caption: 'x', tags: [] }));
    const photos = Array.from({ length: 9 }, (_, i) => photo(i + 1));
    store.getState().photos = photos;
    const flow = flowsMod.createFlow('Bills', 'a scanned bill', { type: 'album', albumName: 'Bills' });
    flowsMod.setFlowConsent(flow.id, true);

    await flowsMod.runFlow(flowsMod.listFlows()[0], photos, 20);

    expect(classifyImagesBatch).toHaveBeenCalledTimes(2); // 8 + 1
    expect(classifyImagesBatch.mock.calls[0][0]).toHaveLength(8);
    expect(classifyImagesBatch.mock.calls[1][0]).toHaveLength(1);
  });

  it('a confident local Ollama answer is used directly, without ever calling the cloud', async () => {
    const store = await load();
    isVisionAvailable.mockResolvedValue(true);
    localImpl = async (items) => items.map(() => ({ match: true, confidence: 0.95, caption: 'a scanned bill with line items', tags: ['bill', 'receipt'] }));
    const photos = [photo(1)];
    store.getState().photos = photos;
    store.getState().albums = [];
    const flow = flowsMod.createFlow('Bills', 'a scanned bill', { type: 'album', albumName: 'Bills' });
    flowsMod.setFlowConsent(flow.id, true);

    const result = await flowsMod.runFlow(flowsMod.listFlows()[0], photos, 10);

    expect(classifyImagesBatchLocal).toHaveBeenCalledTimes(1);
    expect(classifyImagesBatch).not.toHaveBeenCalled(); // cloud never needed
    expect(result).toMatchObject({ classified: 1, matched: 1, failed: 0, fromLocalModel: 1 });
    const album = store.getState().albums.find((a: any) => a.title === 'Bills');
    expect(album.photoIds).toEqual(['p1']);
  });

  it('a low-confidence local answer escalates that photo to the cloud instead of being trusted', async () => {
    const store = await load();
    isVisionAvailable.mockResolvedValue(true);
    localImpl = async (items) => items.map(() => ({ match: true, confidence: 0.4, caption: 'maybe a document', tags: ['document'] }));
    batchImpl = async (items) => items.map(() => ({ match: true, confidence: 0.9, caption: 'a scanned bill', tags: ['bill'] }));
    const photos = [photo(1)];
    store.getState().photos = photos;
    store.getState().albums = [];
    const flow = flowsMod.createFlow('Bills', 'a scanned bill', { type: 'album', albumName: 'Bills' });
    flowsMod.setFlowConsent(flow.id, true);

    const result = await flowsMod.runFlow(flowsMod.listFlows()[0], photos, 10);

    expect(classifyImagesBatchLocal).toHaveBeenCalledTimes(1); // tried locally first...
    expect(classifyImagesBatch).toHaveBeenCalledTimes(1); // ...but wasn't confident enough, so the cloud confirmed it
    expect(result).toMatchObject({ classified: 1, matched: 1, failed: 0, fromLocalModel: 0 });
  });

  it('Ollama being unavailable falls straight through to the cloud, with no error', async () => {
    const store = await load(); // isVisionAvailable defaults to false
    batchImpl = async (items) => items.map(() => ({ match: true, confidence: 0.9, caption: 'a scanned bill', tags: ['bill'] }));
    const photos = [photo(1)];
    store.getState().photos = photos;
    store.getState().albums = [];
    const flow = flowsMod.createFlow('Bills', 'a scanned bill', { type: 'album', albumName: 'Bills' });
    flowsMod.setFlowConsent(flow.id, true);

    const result = await flowsMod.runFlow(flowsMod.listFlows()[0], photos, 10);

    expect(classifyImagesBatchLocal).not.toHaveBeenCalled();
    expect(classifyImagesBatch).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ classified: 1, matched: 1, fromLocalModel: 0 });
  });

  it('deleteFlow removes it, setFlowConsent only affects the named flow', async () => {
    const store = await load();
    store.getState().photos = [];
    const a = flowsMod.createFlow('A', 'x', { type: 'album', albumName: 'A' });
    const b = flowsMod.createFlow('B', 'y', { type: 'album', albumName: 'B' });
    flowsMod.setFlowConsent(a.id, true);
    expect(flowsMod.listFlows().find((f: any) => f.id === a.id).consented).toBe(true);
    expect(flowsMod.listFlows().find((f: any) => f.id === b.id).consented).toBe(false);

    flowsMod.deleteFlow(a.id);
    expect(flowsMod.listFlows().map((f: any) => f.id)).toEqual([b.id]);
  });

  describe('onLog: a detail line per photo, for the run-progress modal', () => {
    const collectLogs = async (flow: any, photos: any[], cap = 10) => {
      const lines: any[] = [];
      const result = await flowsMod.runFlow(flow, photos, cap, undefined, (l: any) => lines.push(l));
      return { result, lines };
    };

    it('a cache hit logs "already described" with the right photo number/name, no API call', async () => {
      const store = await load();
      batchImpl = async (items) => items.map(() => ({ match: true, confidence: 0.9, caption: 'a scanned bill', tags: ['bill'] }));
      const photos = [photo(1)];
      store.getState().photos = photos;
      store.getState().albums = [];
      const flowA = flowsMod.createFlow('Bills A', 'a scanned bill', { type: 'album', albumName: 'A' });
      flowsMod.setFlowConsent(flowA.id, true);
      await flowsMod.runFlow(flowsMod.listFlows()[0], photos, 10); // warms the shared cache

      const flowB = flowsMod.createFlow('Bills B', 'a scanned bill', { type: 'album', albumName: 'B' });
      flowsMod.setFlowConsent(flowB.id, true);
      const { lines } = await collectLogs(flowsMod.listFlows().find((f: any) => f.id === flowB.id), photos);

      expect(lines).toEqual([
        { index: 1, total: 1, photoId: 'p1', fileName: 'IMG_1.jpg', level: 'info', message: expect.stringContaining('Already described') },
        expect.objectContaining({ index: 1, total: 1, level: 'info', message: expect.stringContaining('Checked 1') }),
      ]);
      expect(lines[0].message).toContain('matches');
    });

    it('a low-confidence local answer logs the escalation, then the cloud attempt and its result', async () => {
      const store = await load();
      isVisionAvailable.mockResolvedValue(true);
      localImpl = async (items) => items.map(() => ({ match: true, confidence: 0.4, caption: 'maybe a document', tags: [] }));
      batchImpl = async (items) => items.map(() => ({ match: true, confidence: 0.9, caption: 'a scanned bill', tags: ['bill'] }));
      const photos = [photo(1)];
      store.getState().photos = photos;
      store.getState().albums = [];
      const flow = flowsMod.createFlow('Bills', 'a scanned bill', { type: 'album', albumName: 'Bills' });
      flowsMod.setFlowConsent(flow.id, true);

      const { lines } = await collectLogs(flowsMod.listFlows()[0], photos);
      const messages = lines.map((l) => l.message);
      expect(messages[0]).toMatch(/local model context/i);
      expect(messages[1]).toMatch(/trying the local ollama model/i);
      expect(messages[2]).toMatch(/unsure.*escalating to the cloud/i);
      expect(messages[3]).toMatch(/sending to the configured cloud/i);
      expect(messages[4]).toMatch(/cloud model says matches/i);
    });

    it('no local model available logs a plain warning before falling through to the cloud', async () => {
      const store = await load(); // isVisionAvailable defaults to false
      batchImpl = async (items) => items.map(() => ({ match: false, confidence: 0.9, caption: 'a landscape', tags: [] }));
      const photos = [photo(1)];
      store.getState().photos = photos;
      const flow = flowsMod.createFlow('Bills', 'a scanned bill', { type: 'album', albumName: 'Bills' });
      flowsMod.setFlowConsent(flow.id, true);

      const { lines } = await collectLogs(flowsMod.listFlows()[0], photos);
      expect(lines[0]).toMatchObject({ level: 'warn', message: expect.stringMatching(/no local ollama.*available/i) });
      expect(lines[1]).toMatchObject({ level: 'info', message: expect.stringMatching(/sending to the configured cloud/i) });
    });

    // The reported bug: clicking "Run" with neither engine configured must still run (using the free
    // cache) and, for whatever genuinely needs an engine, show the real reason as a per-photo log line
    // — never a silently-disabled button and never a swallowed exception.
    it('with no cloud provider configured, the run still completes and each affected photo gets the real "set an API key" reason', async () => {
      const store = await load();
      batchImpl = async () => { throw new Error('Set a Gemini or OpenAI API key in "Search with AI" settings first — classifying photos needs a cloud vision provider.'); };
      const photos = [photo(1), photo(2)];
      store.getState().photos = photos;
      const created = flowsMod.createFlow('Food dishes', 'a photo of a plated food dish', { type: 'album', albumName: 'Food dishes' });
      flowsMod.setFlowConsent(created.id, true);
      const flow = flowsMod.listFlows()[0];

      const { result, lines } = await collectLogs(flow, photos);

      expect(result).toMatchObject({ classified: 2, matched: 0, failed: 2 }); // did not throw — the run completed
      const errorLines = lines.filter((l) => l.level === 'error');
      expect(errorLines).toHaveLength(2);
      expect(errorLines[0].message).toContain('Set a Gemini or OpenAI API key');
      expect(errorLines[0].fileName).toBe('IMG_1.jpg');
      expect(errorLines[1].fileName).toBe('IMG_2.jpg');
    });

    it('an unreadable photo logs the read error at the point it was found, not just a silent count', async () => {
      const store = await load();
      unreadablePhotoNum = 2;
      batchImpl = async (items) => items.map(() => ({ match: true, confidence: 0.9, caption: 'a scanned bill', tags: [] }));
      const photos = [photo(1), photo(2)];
      store.getState().photos = photos;
      const created = flowsMod.createFlow('Bills', 'a scanned bill', { type: 'album', albumName: 'Bills' });
      flowsMod.setFlowConsent(created.id, true);
      const flow = flowsMod.listFlows()[0];

      const { lines } = await collectLogs(flow, photos);
      const bad = lines.find((l) => l.fileName === 'IMG_2.jpg' && l.level === 'error');
      expect(bad).toMatchObject({ level: 'error', message: expect.stringContaining('Could not read this photo') });
    });

    it('nothing left to classify logs one explanatory line instead of nothing at all', async () => {
      const store = await load();
      const photos = [photo(1)];
      store.getState().photos = photos;
      const created = flowsMod.createFlow('Bills', 'a scanned bill', { type: 'album', albumName: 'Bills' });
      flowsMod.setFlowConsent(created.id, true);
      const flow = flowsMod.listFlows()[0];
      flow.classifiedIds = { p1: true };

      const { lines } = await collectLogs(flow, photos);
      expect(lines).toEqual([{ index: 0, total: 0, photoId: '', fileName: '', level: 'info', message: expect.stringContaining('already been checked') }]);
    });
  });
});
