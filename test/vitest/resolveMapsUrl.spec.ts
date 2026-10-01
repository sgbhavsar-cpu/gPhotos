import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'http';

// Exercises exactly what the 'location:resolve-maps-url' IPC handler in main.ts does
// (`fetch(url, { redirect: 'follow' })`, returning `response.url`) — against a real local server
// standing in for maps.app.goo.gl's redirect, to prove following a short link actually works and
// isn't just a mocked assumption.
describe('resolving a shortened Google Maps link (what main.ts\'s IPC handler does)', () => {
  let server: http.Server;
  let base: string;

  beforeEach(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/short') {
        res.writeHead(302, { Location: `${base}/maps/@24.5713934,73.6905743,15z` });
        res.end();
      } else if (req.url === '/chain1') {
        res.writeHead(302, { Location: `${base}/chain2` }); // more than one hop
        res.end();
      } else if (req.url === '/chain2') {
        res.writeHead(302, { Location: `${base}/maps/@1.5,2.5,10z` });
        res.end();
      } else if (req.url?.startsWith('/maps/')) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html>ok</html>');
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as any).port}`;
  });
  afterEach(async () => { await new Promise<void>((r) => server.close(() => r())); });

  const resolve = async (url: string) => {
    try {
      const res = await fetch(url, { redirect: 'follow' });
      return { ok: true, resolvedUrl: res.url };
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) };
    }
  };

  it('follows a single redirect to the real, coordinate-bearing URL', async () => {
    const r = await resolve(`${base}/short`);
    expect(r.ok).toBe(true);
    expect(r.resolvedUrl).toBe(`${base}/maps/@24.5713934,73.6905743,15z`);
  });

  it('follows a chain of redirects to the final destination', async () => {
    const r = await resolve(`${base}/chain1`);
    expect(r.ok).toBe(true);
    expect(r.resolvedUrl).toBe(`${base}/maps/@1.5,2.5,10z`);
  });

  it('an unreachable server is reported as an error, not thrown', async () => {
    const r = await resolve('http://127.0.0.1:9/short');
    expect(r.ok).toBe(false);
    expect((r as any).error).toBeTruthy();
  });

  it('a 404 (dead/expired share link) resolves with its own URL rather than throwing', async () => {
    const r = await resolve(`${base}/nope`);
    expect(r.ok).toBe(true);
    expect(r.resolvedUrl).toBe(`${base}/nope`); // no redirect happened — nothing to parse coordinates from, but no crash
  });
});
