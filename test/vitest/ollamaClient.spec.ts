import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { ollamaRequest, ollamaPull, ollamaEndpoint } from '../../src/main/services/ollamaClient';

// A tiny stand-in for Ollama on a real local socket. Like the real one it answers 403 to any request that
// carries an Origin header it does not know — which is exactly what a file:// renderer sends ("null").
describe('ollamaClient (main-process Ollama access)', () => {
  let server: http.Server;
  let base: string;
  const seen: Array<{ method?: string; url?: string; origin?: string; body: string }> = [];
  let pullLines: string[] = [];
  let pullDelayMs = 0;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', async () => {
        seen.push({ method: req.method, url: req.url, origin: req.headers.origin as string | undefined, body });
        if (req.headers.origin) { res.writeHead(403); res.end(); return; }
        if (req.url === '/api/tags') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ models: [{ name: 'qwen2.5vl:7b', size: 6e9, capabilities: ['vision'] }] }));
        } else if (req.url === '/api/embed') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ embeddings: [[0.1, 0.2]], echoed: JSON.parse(body) }));
        } else if (req.url === '/api/missing') {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'model "nope" not found' }));
        } else if (req.url === '/api/pull') {
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
          for (const l of pullLines) {
            res.write(l.slice(0, 9)); // split every line across two writes to exercise the partial-line buffer
            await new Promise((r) => setTimeout(r, pullDelayMs));
            res.write(l.slice(9) + '\n');
            await new Promise((r) => setTimeout(r, pullDelayMs));
          }
          res.end();
        } else {
          res.writeHead(404); res.end();
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  // A port nothing listens on: bind one, remember its number, close it again.
  const closedPort = async () => {
    const s = http.createServer();
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    const port = (s.address() as AddressInfo).port;
    await new Promise<void>((r) => s.close(() => r()));
    return port;
  };

  it('a request from the main process carries no Origin header, so Ollama\'s origin check never trips', async () => {
    const res = await ollamaRequest({ baseUrl: base, path: '/api/tags' });
    expect(res.ok).toBe(true);
    expect(res.data.models[0].name).toBe('qwen2.5vl:7b');
    expect(seen[seen.length - 1].origin).toBeUndefined();
  });

  it('POSTs a JSON body and returns the parsed answer', async () => {
    const res = await ollamaRequest({ baseUrl: base, path: '/api/embed', body: { model: 'nomic-embed-text', input: 'hi' } });
    expect(res.ok).toBe(true);
    expect(res.data.embeddings).toEqual([[0.1, 0.2]]);
    expect(res.data.echoed).toEqual({ model: 'nomic-embed-text', input: 'hi' });
  });

  it('a non-2xx answer becomes ok:false with Ollama\'s own error message', async () => {
    const res = await ollamaRequest({ baseUrl: base, path: '/api/missing' });
    expect(res).toMatchObject({ ok: false, status: 404, error: 'model "nope" not found' });
  });

  it('an unreachable server is reported in plain words, not thrown', async () => {
    const res = await ollamaRequest({ baseUrl: `http://127.0.0.1:${await closedPort()}`, path: '/api/tags', timeoutMs: 2000 });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/could not connect|refused|did not answer|fetch failed/i);
  });

  it('only http(s) addresses and /api/ paths are accepted', async () => {
    expect((await ollamaRequest({ baseUrl: 'file:///etc', path: '/api/tags' })).error).toMatch(/http/);
    expect((await ollamaRequest({ baseUrl: 'not a url', path: '/api/tags' })).error).toMatch(/not a valid/);
    expect((await ollamaRequest({ baseUrl: base, path: '/etc/passwd' })).error).toMatch(/\/api\//);
    expect((await ollamaRequest({ baseUrl: base, path: '/api/../secret' })).error).toMatch(/\/api\//);
    expect(ollamaEndpoint('http://127.0.0.1:11434/', '/api/tags')).toBe('http://127.0.0.1:11434/api/tags'); // no doubled slash
  });

  describe('ollamaPull', () => {
    it('streams progress (lines split across chunks included) and finishes with success', async () => {
      pullLines = [
        JSON.stringify({ status: 'pulling manifest' }),
        JSON.stringify({ status: 'downloading', completed: 50, total: 100 }),
        JSON.stringify({ status: 'success' }),
      ];
      pullDelayMs = 2;
      const events: any[] = [];

      const out = await ollamaPull(base, 'qwen2.5vl:7b', (e) => events.push(e));

      expect(out).toEqual({ result: 'success' });
      expect(events).toEqual([
        { status: 'pulling manifest' },
        { status: 'downloading', completed: 50, total: 100 },
        { status: 'success' },
      ]);
      expect(JSON.parse(seen[seen.length - 1].body)).toEqual({ model: 'qwen2.5vl:7b', stream: true });
      expect(seen[seen.length - 1].origin).toBeUndefined();
    });

    it('an error line in the stream fails the download with that message', async () => {
      pullLines = [JSON.stringify({ status: 'pulling manifest' }), JSON.stringify({ error: 'pull model manifest: file does not exist' })];
      const out = await ollamaPull(base, 'nope', () => {});
      expect(out).toEqual({ result: 'failed', error: 'pull model manifest: file does not exist' });
    });

    it('cancelling mid-download reports "cancelled"', async () => {
      pullLines = Array.from({ length: 50 }, (_, i) => JSON.stringify({ status: 'downloading', completed: i, total: 50 }));
      pullDelayMs = 10;
      const controller = new AbortController();
      const events: any[] = [];
      const promise = ollamaPull(base, 'big', (e) => { events.push(e); if (events.length === 3) controller.abort(); }, controller.signal);
      expect(await promise).toEqual({ result: 'cancelled' });
      expect(events.length).toBeLessThan(50);
    });

    it('a server that is not there fails cleanly', async () => {
      const out = await ollamaPull(`http://127.0.0.1:${await closedPort()}`, 'x', () => {});
      expect(out.result).toBe('failed');
      expect(out.error).toBeTruthy();
    });
  });
});
