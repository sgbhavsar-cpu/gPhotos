// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('ollamaVisionService', () => {
  let mod: any;
  let fetchMock: any;

  const load = async () => {
    localStorage.clear();
    vi.resetModules();
    mod = await import('../../src/renderer/src/services/ollamaVisionService');
  };

  beforeEach(() => {
    fetchMock = vi.fn();
    (globalThis as any).fetch = fetchMock;
  });

  it('getOllamaConfig defaults to localhost:11434 / qwen2.5vl:7b / nomic-embed-text / a 4096 context window', async () => {
    await load();
    expect(mod.getOllamaConfig()).toEqual({ baseUrl: 'http://127.0.0.1:11434', visionModel: 'qwen2.5vl:7b', embedModel: 'nomic-embed-text', contextWindow: 4096 });
  });

  it('saveOllamaConfig persists a partial override, merged with the rest of the defaults, surviving a reload', async () => {
    await load();
    mod.saveOllamaConfig({ visionModel: 'llava:13b' });
    expect(mod.getOllamaConfig()).toEqual({ baseUrl: 'http://127.0.0.1:11434', visionModel: 'llava:13b', embedModel: 'nomic-embed-text', contextWindow: 4096 });

    // A fresh module instance (simulating a restart) reads the same override back from localStorage.
    vi.resetModules();
    const mod2 = await import('../../src/renderer/src/services/ollamaVisionService');
    expect(mod2.getOllamaConfig().visionModel).toBe('llava:13b');
  });

  it('isVisionAvailable checks the configured host for the configured vision model name', async () => {
    await load();
    mod.saveOllamaConfig({ baseUrl: 'http://gpu-box:9999/', visionModel: 'my-vision-model' });
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ models: [{ name: 'my-vision-model' }] }) });

    const ready = await mod.isVisionAvailable();

    expect(ready).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith('http://gpu-box:9999/api/tags', expect.anything()); // trailing slash trimmed, no doubled "//api"
  });

  it('isVisionAvailable is false when the model list does not include the configured model, or the request fails', async () => {
    await load();
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ models: [{ name: 'some-other-model' }] }) });
    expect(await mod.isVisionAvailable()).toBe(false);

    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await mod.isVisionAvailable()).toBe(false);
  });

  it('classifyImagesBatchLocal sends the configured model name and base URL (an explicit numCtx skips the context-lookup round-trip)', async () => {
    await load();
    mod.saveOllamaConfig({ baseUrl: 'http://localhost:9000', visionModel: 'custom-vision' });
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ message: { content: '[{"match": true, "confidence": 0.9, "caption": "x", "tags": []}]' } }) });

    const result = await mod.classifyImagesBatchLocal([{ base64: 'abc', mimeType: 'image/jpeg' }], 'a scanned bill', 4096);

    expect(result).toEqual([{ match: true, confidence: 0.9, caption: 'x', tags: [] }]);
    expect(fetchMock).toHaveBeenCalledTimes(1); // no /api/show lookup when numCtx is given directly
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:9000/api/chat');
    expect(JSON.parse(opts.body).model).toBe('custom-vision');
  });

  it('classifyImagesBatchLocal extracts a JSON array even when the model wraps it in prose/markdown', async () => {
    await load();
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ message: { content: 'Sure! Here you go:\n```json\n[{"match": false, "confidence": 0.2, "caption": "y", "tags": ["z"]}]\n```' } }) });

    const result = await mod.classifyImagesBatchLocal([{ base64: 'abc', mimeType: 'image/jpeg' }], 'x', 4096);

    expect(result).toEqual([{ match: false, confidence: 0.2, caption: 'y', tags: ['z'] }]);
  });

  it('with no numCtx given, classifyImagesBatchLocal resolves it itself and sends that value', async () => {
    await load();
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ model_info: { 'qwen25vl.context_length': 128000 } }) }) // /api/show
      .mockResolvedValueOnce({ ok: true, json: async () => ({ message: { content: '[{"match": true, "confidence": 0.9, "caption": "x", "tags": []}]' } }) }); // /api/chat

    await mod.classifyImagesBatchLocal([{ base64: 'abc', mimeType: 'image/jpeg' }], 'a scanned bill');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toContain('/api/show');
    expect(fetchMock.mock.calls[1][0]).toContain('/api/chat');
    const body = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body.options).toMatchObject({ num_ctx: 4096 }); // the configured default — well under the model's 128000 max
  });


  it('embedText sends the configured embedding model and returns its vector, or null on any failure', async () => {
    await load();
    mod.saveOllamaConfig({ embedModel: 'custom-embed' });
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ embeddings: [[0.1, 0.2, 0.3]] }) });

    const vec = await mod.embedText('hello');

    expect(vec).toEqual([0.1, 0.2, 0.3]);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe('custom-embed');

    fetchMock.mockRejectedValue(new Error('offline'));
    expect(await mod.embedText('hello')).toBeNull();
  });

  it('listModels returns name/size/capabilities for every installed model, or [] on any failure', async () => {
    await load();
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        models: [
          { name: 'qwen2.5vl:7b', size: 6000000000, capabilities: ['completion', 'vision'] },
          { name: 'nomic-embed-text:latest', size: 274000000, capabilities: ['embedding'] },
          { model: 'legacy-model' }, // an older server: no `name`/`size`/`capabilities` fields
        ],
      }),
    });

    const models = await mod.listModels();

    expect(models).toEqual([
      { name: 'qwen2.5vl:7b', sizeBytes: 6000000000, capabilities: ['completion', 'vision'] },
      { name: 'nomic-embed-text:latest', sizeBytes: 274000000, capabilities: ['embedding'] },
      { name: 'legacy-model', sizeBytes: 0, capabilities: [] },
    ]);

    fetchMock.mockRejectedValue(new Error('offline'));
    expect(await mod.listModels()).toEqual([]);
  });

  // A fake streamed response body: each call to read() yields one more NDJSON line as a chunk,
  // exactly like Ollama's /api/pull — including a line split across two chunks, to make sure the
  // partial-line buffering is exercised, not just whole-line-per-chunk.
  const fakeStreamBody = (lines: string[]) => {
    const raw = lines.map((l) => l + '\n').join('');
    const chunks: string[] = [];
    for (let i = 0; i < raw.length; i += 7) chunks.push(raw.slice(i, i + 7)); // arbitrary small chunk size
    let i = 0;
    return {
      getReader: () => ({
        read: async () => {
          if (i >= chunks.length) return { done: true, value: undefined };
          const value = new TextEncoder().encode(chunks[i]);
          i++;
          return { done: false, value };
        },
      }),
    };
  };

  it('pullModel streams progress and resolves "success"', async () => {
    await load();
    fetchMock.mockResolvedValue({
      ok: true,
      body: fakeStreamBody([
        JSON.stringify({ status: 'pulling manifest' }),
        JSON.stringify({ status: 'downloading', completed: 50, total: 100 }),
        JSON.stringify({ status: 'success' }),
      ]),
    });
    const events: any[] = [];

    const result = await mod.pullModel('qwen2.5vl:7b', (p: any) => events.push(p));

    expect(result).toBe('success');
    expect(events).toEqual([
      { status: 'pulling manifest' },
      { status: 'downloading', completed: 50, total: 100 },
      { status: 'success' },
    ]);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:11434/api/pull');
    expect(JSON.parse(opts.body)).toEqual({ model: 'qwen2.5vl:7b', stream: true });
  });

  it('pullModel resolves "failed" when the stream reports an error, or the request itself fails', async () => {
    await load();
    fetchMock.mockResolvedValue({ ok: true, body: fakeStreamBody([JSON.stringify({ error: 'model not found' })]) });
    expect(await mod.pullModel('does-not-exist')).toBe('failed');

    fetchMock.mockResolvedValue({ ok: false, body: null });
    expect(await mod.pullModel('x')).toBe('failed');

    fetchMock.mockRejectedValue(new Error('network down'));
    expect(await mod.pullModel('x')).toBe('failed');
  });

  it('pullModel resolves "cancelled" when aborted', async () => {
    await load();
    fetchMock.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    expect(await mod.pullModel('x', undefined, new AbortController().signal)).toBe('cancelled');
  });

  // In the desktop app every Ollama call goes through the main process (a file:// window's "Origin: null"
  // gets a 403 from Ollama). These tests give the service that bridge and assert it is used INSTEAD of fetch.
  describe('desktop app: calls go through the main process, never straight from the window', () => {
    let api: any;
    beforeEach(() => {
      api = {
        ollamaRequest: vi.fn(),
        ollamaPull: vi.fn(),
        ollamaCancelPull: vi.fn(async () => true),
        onOllamaPullProgress: vi.fn(),
      };
      (window as any).electronAPI = api;
    });
    afterEach(() => { delete (window as any).electronAPI; });

    it('listModels / isVisionAvailable / embedText use ollamaRequest and never touch fetch', async () => {
      await load();
      api.ollamaRequest.mockImplementation(async (req: any) =>
        req.path === '/api/tags'
          ? { ok: true, status: 200, data: { models: [{ name: 'qwen2.5vl:7b', size: 5, capabilities: ['vision'] }] } }
          : { ok: true, status: 200, data: { embeddings: [[1, 2, 3]] } }
      );

      expect(await mod.listModels()).toEqual([{ name: 'qwen2.5vl:7b', sizeBytes: 5, capabilities: ['vision'] }]);
      expect(await mod.isVisionAvailable()).toBe(true);
      expect(await mod.embedText('hello')).toEqual([1, 2, 3]);

      expect(fetchMock).not.toHaveBeenCalled();
      const embedReq = api.ollamaRequest.mock.calls.find((c: any[]) => c[0].path === '/api/embed')[0];
      expect(embedReq).toMatchObject({ baseUrl: 'http://127.0.0.1:11434', method: 'POST', body: { model: 'nomic-embed-text', input: 'hello' } });
    });

    it('a failed listing exposes the reason so the Settings card can show it', async () => {
      await load();
      api.ollamaRequest.mockResolvedValue({ ok: false, status: 0, error: 'Could not connect to Ollama — is it running? (connection refused)' });

      expect(await mod.listModels()).toEqual([]);
      expect(mod.getLastOllamaError()).toMatch(/is it running/);

      api.ollamaRequest.mockResolvedValue({ ok: true, status: 200, data: { models: [] } });
      await mod.listModels();
      expect(mod.getLastOllamaError()).toBeNull(); // a good answer clears it
    });

    it('classifyImagesBatchLocal goes through the bridge and turns an HTTP error into a thrown message', async () => {
      await load();
      api.ollamaRequest.mockResolvedValueOnce({ ok: true, status: 200, data: { message: { content: '[{"match": true, "confidence": 0.9, "caption": "x", "tags": []}]' } } });
      expect(await mod.classifyImagesBatchLocal([{ base64: 'a', mimeType: 'image/jpeg' }], 'a bill', 4096)).toHaveLength(1);
      expect(api.ollamaRequest.mock.calls[0][0]).toMatchObject({ path: '/api/chat', timeoutMs: 120000 });
      expect(api.ollamaRequest.mock.calls[0][0].body.options).toMatchObject({ num_ctx: 4096 });

      api.ollamaRequest.mockResolvedValueOnce({ ok: false, status: 404, error: 'model "x" not found' });
      await expect(mod.classifyImagesBatchLocal([{ base64: 'a', mimeType: 'image/jpeg' }], 'a bill', 4096)).rejects.toThrow(/404.*not found/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('with no numCtx given, resolves it via the bridge too (an /api/show call before /api/chat)', async () => {
      await load();
      api.ollamaRequest
        .mockResolvedValueOnce({ ok: true, status: 200, data: { model_info: { 'qwen25vl.context_length': 2048 } } }) // /api/show — caps the configured 4096 down to 2048
        .mockResolvedValueOnce({ ok: true, status: 200, data: { message: { content: '[{"match": true, "confidence": 0.9, "caption": "x", "tags": []}]' } } });

      await mod.classifyImagesBatchLocal([{ base64: 'a', mimeType: 'image/jpeg' }], 'a bill');

      expect(api.ollamaRequest.mock.calls[0][0].path).toBe('/api/show');
      expect(api.ollamaRequest.mock.calls[1][0].body.options).toMatchObject({ num_ctx: 2048 }); // capped, not the configured 4096
    });

    it('the timeout scales up for a bigger batch instead of staying fixed at 120s for any size', async () => {
      await load();
      const resultFor = (n: number) => JSON.stringify(Array.from({ length: n }, () => ({ match: true, confidence: 0.9, caption: 'x', tags: [] })));
      const photos = (n: number) => Array.from({ length: n }, (_, i) => ({ base64: `img${i}`, mimeType: 'image/jpeg' }));

      api.ollamaRequest.mockResolvedValueOnce({ ok: true, status: 200, data: { message: { content: resultFor(1) } } });
      await mod.classifyImagesBatchLocal(photos(1), 'a bill', 4096);
      expect(api.ollamaRequest.mock.calls[0][0].timeoutMs).toBe(120000); // a small batch keeps the old floor

      api.ollamaRequest.mockResolvedValueOnce({ ok: true, status: 200, data: { message: { content: resultFor(16) } } });
      await mod.classifyImagesBatchLocal(photos(16), 'a bill', 4096);
      expect(api.ollamaRequest.mock.calls[1][0].timeoutMs).toBe(16 * 12000); // scales with the full local batch size
    });

    it('pullModel downloads via ollamaPull, relays only this model progress, and unsubscribes afterwards', async () => {
      await load();
      let push: (p: any) => void = () => {};
      const unsubscribe = vi.fn();
      api.onOllamaPullProgress.mockImplementation((cb: any) => { push = cb; return unsubscribe; });
      api.ollamaPull.mockImplementation(async () => {
        push({ model: 'other-model', status: 'downloading', completed: 1, total: 2 });
        push({ model: 'qwen2.5vl:7b', status: 'downloading', completed: 50, total: 100 });
        return { result: 'success' };
      });
      const events: any[] = [];

      const result = await mod.pullModel('qwen2.5vl:7b', (e: any) => events.push(e));

      expect(result).toBe('success');
      expect(api.ollamaPull).toHaveBeenCalledWith('http://127.0.0.1:11434', 'qwen2.5vl:7b');
      expect(events).toEqual([{ model: 'qwen2.5vl:7b', status: 'downloading', completed: 50, total: 100 }]);
      expect(unsubscribe).toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('a failed download reports why; aborting asks the main process to cancel that model', async () => {
      await load();
      api.onOllamaPullProgress.mockReturnValue(() => {});
      api.ollamaPull.mockResolvedValueOnce({ result: 'failed', error: 'pull model manifest: file does not exist' });
      expect(await mod.pullModel('nope')).toBe('failed');
      expect(mod.getLastOllamaError()).toBe('pull model manifest: file does not exist');

      let finish: (v: any) => void = () => {};
      api.ollamaPull.mockImplementationOnce(() => new Promise((r) => { finish = r; }));
      const controller = new AbortController();
      const pending = mod.pullModel('big', undefined, controller.signal);
      controller.abort();
      expect(api.ollamaCancelPull).toHaveBeenCalledWith('big');
      finish({ result: 'cancelled' });
      expect(await pending).toBe('cancelled');
    });

    it('the browser/mobile shim (no real main process) keeps using the direct fetch fallback', async () => {
      await load();
      (window as any).electronAPI = { isBrowserShim: true, ollamaRequest: vi.fn() };
      fetchMock.mockResolvedValue({ ok: true, json: async () => ({ models: [] }) });
      await mod.listModels();
      expect(fetchMock).toHaveBeenCalled();
      expect((window as any).electronAPI.ollamaRequest).not.toHaveBeenCalled();
    });
  });
});
