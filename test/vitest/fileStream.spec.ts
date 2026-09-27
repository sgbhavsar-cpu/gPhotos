import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import type { AddressInfo } from 'net';
import { parseByteRange, sendFileStream } from '../../src/main/services/fileStream';

describe('parseByteRange', () => {
  it('parses a-b, a- and -n', () => {
    expect(parseByteRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
    expect(parseByteRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
    expect(parseByteRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseByteRange('bytes=-500', 100)).toEqual({ start: 0, end: 99 });
    expect(parseByteRange('bytes=50-500', 100)).toEqual({ start: 50, end: 99 });
  });
  it('flags unsatisfiable ranges', () => {
    expect(parseByteRange('bytes=100-', 100)).toBe('unsatisfiable');
    expect(parseByteRange('bytes=9-5', 100)).toBe('unsatisfiable');
    expect(parseByteRange('bytes=-0', 100)).toBe('unsatisfiable');
    expect(parseByteRange('bytes=0-1', 0)).toBe('unsatisfiable');
  });
  it('ignores absent, other-unit, multi-range and malformed headers', () => {
    expect(parseByteRange(undefined, 100)).toBeNull();
    expect(parseByteRange('items=0-5', 100)).toBeNull();
    expect(parseByteRange('bytes=0-5,10-20', 100)).toBeNull();
    expect(parseByteRange('bytes=abc', 100)).toBeNull();
    expect(parseByteRange('bytes=-', 100)).toBeNull();
  });
});

describe('sendFileStream over HTTP', () => {
  let dir: string;
  let server: http.Server;
  let port: number;
  const body = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz');

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gphotos_filestream_'));
    fs.writeFileSync(path.join(dir, 'f.bin'), body);
    server = http.createServer((req, res) => {
      res.setHeader('ETag', '"abc"');
      res.setHeader('Content-Type', 'application/octet-stream');
      const file = req.url === '/missing' ? path.join(dir, 'nope.bin') : path.join(dir, 'f.bin');
      sendFileStream(res, file, 404, 'gone', req);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function get(urlPath: string, range?: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; data: Buffer }> {
    return new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: urlPath, headers: range ? { Range: range } : {} }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, data: Buffer.concat(chunks) }));
      }).on('error', reject);
    });
  }

  it('serves the whole file with Accept-Ranges and ETag when no Range is sent', async () => {
    const r = await get('/');
    expect(r.status).toBe(200);
    expect(r.headers['accept-ranges']).toBe('bytes');
    expect(r.headers['etag']).toBe('"abc"');
    expect(r.data.equals(body)).toBe(true);
  });

  it('serves 206 with Content-Range for a single range', async () => {
    const r = await get('/', 'bytes=5-9');
    expect(r.status).toBe(206);
    expect(r.headers['content-range']).toBe(`bytes 5-9/${body.length}`);
    expect(r.headers['content-length']).toBe('5');
    expect(r.headers['etag']).toBe('"abc"');
    expect(r.data.toString()).toBe('56789');
  });

  it('serves a suffix range', async () => {
    const r = await get('/', 'bytes=-4');
    expect(r.status).toBe(206);
    expect(r.data.toString()).toBe('wxyz');
  });

  it('answers 416 with Content-Range */size for an unsatisfiable range', async () => {
    const r = await get('/', `bytes=${body.length}-`);
    expect(r.status).toBe(416);
    expect(r.headers['content-range']).toBe(`bytes */${body.length}`);
  });

  it('still returns the error status for a missing file, with or without Range', async () => {
    expect((await get('/missing')).status).toBe(404);
    const r = await get('/missing', 'bytes=0-1');
    expect(r.status).toBe(404);
    expect(r.headers['etag']).toBeUndefined();
  });
});
