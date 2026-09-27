import http from 'http';
import fs from 'fs';
import { pipeline } from 'stream';

export type ByteRange = { start: number; end: number };

/**
 * Parses a single `Range: bytes=a-b | a- | -n` header against a file of `size` bytes.
 * Returns the inclusive range, 'unsatisfiable' (-> 416), or null when the header
 * should be ignored and the whole file served (absent, other unit, multi-range,
 * or malformed syntax — all legal per RFC 9110).
 */
export function parseByteRange(header: string | undefined, size: number): ByteRange | 'unsatisfiable' | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  if (size <= 0) return 'unsatisfiable';
  if (m[1] === '') {
    const n = Number(m[2]); // suffix: last n bytes
    if (!Number.isSafeInteger(n) || n === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (!Number.isSafeInteger(start) || start >= size || end < start) return 'unsatisfiable';
  return { start, end };
}

/**
 * Streams a file to the response with stream.pipeline, so a client that
 * aborts (mobile scrolling cancels image loads) destroys the read stream
 * instead of leaking its file handle (which on Windows also keeps the file
 * locked). A failure to open the file still gets a clean error response.
 * When `req` carries a single-range `Range` header the reply is 206 with
 * Content-Range (416 if unsatisfiable); otherwise the whole file, as before.
 */
export function sendFileStream(
  res: http.ServerResponse,
  filePath: string,
  errorStatus: number = 500,
  errorMessage: string = 'Failed reading file',
  req?: http.IncomingMessage
): void {
  const fail = () => {
    if (res.writableEnded || res.destroyed) return;
    if (res.headersSent) {
      res.destroy();
      return;
    }
    // Don't let a cached-forever header stick to an error body.
    res.removeHeader('ETag');
    res.removeHeader('Cache-Control');
    res.removeHeader('Accept-Ranges');
    res.removeHeader('Content-Range');
    res.removeHeader('Content-Length');
    res.statusCode = errorStatus;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end(errorMessage);
  };

  const stream = (range?: ByteRange) => {
    const rs = fs.createReadStream(filePath, range);
    rs.once('error', fail);
    rs.once('open', () => {
      rs.off('error', fail);
      pipeline(rs, res, (err) => {
        if (err && (err as NodeJS.ErrnoException).code !== 'ERR_STREAM_PREMATURE_CLOSE') {
          console.warn('[EmbeddedWebServer] Stream error:', err.message);
        }
      });
    });
  };

  res.setHeader('Accept-Ranges', 'bytes');
  const rangeHeader = req?.headers.range;
  if (!rangeHeader) {
    stream();
    return;
  }
  fs.stat(filePath, (err, st) => {
    if (err) return fail();
    const range = parseByteRange(rangeHeader, st.size);
    if (range === null) return stream();
    if (range === 'unsatisfiable') {
      res.removeHeader('ETag');
      res.removeHeader('Cache-Control');
      res.statusCode = 416;
      res.setHeader('Content-Range', `bytes */${st.size}`);
      res.end();
      return;
    }
    res.statusCode = 206;
    res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${st.size}`);
    res.setHeader('Content-Length', String(range.end - range.start + 1));
    stream(range);
  });
}
