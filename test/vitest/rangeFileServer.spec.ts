import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { serveFileWithRangeSupport } from '../../src/main/services/rangeFileServer';

describe('serveFileWithRangeSupport (video playback Range support — FEATURE_VIDEO_LIBRARY_SUPPORT.md §2.6)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gphotos-range-test-'));
  const filePath = path.join(dir, 'clip.mp4');
  const content = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));

  beforeAll(() => {
    fs.writeFileSync(filePath, content);
  });
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a Range request returns 206 with exactly the requested byte span', async () => {
    const res = await serveFileWithRangeSupport(filePath, 'video/mp4', 'bytes=100-199');
    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe('bytes 100-199/1000');
    expect(res.headers.get('Accept-Ranges')).toBe('bytes');
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.length).toBe(100);
    expect(buf).toEqual(content.subarray(100, 200));
  });

  it('an open-ended Range ("bytes=500-") returns everything from that offset to the end', async () => {
    const res = await serveFileWithRangeSupport(filePath, 'video/mp4', 'bytes=500-');
    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe('bytes 500-999/1000');
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.length).toBe(500);
  });

  it('no Range header returns the whole file as a plain 200 with Accept-Ranges advertised', async () => {
    const res = await serveFileWithRangeSupport(filePath, 'video/mp4', null);
    expect(res.status).toBe(200);
    expect(res.headers.get('Accept-Ranges')).toBe('bytes');
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.length).toBe(1000);
    expect(buf).toEqual(content);
  });

  it('a Range entirely beyond the file size falls back to the full-file response rather than throwing', async () => {
    const res = await serveFileWithRangeSupport(filePath, 'video/mp4', 'bytes=5000-6000');
    expect(res.status).toBe(200);
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.length).toBe(1000);
  });

  it('an end beyond the file size is clamped to the last byte, not an error', async () => {
    const res = await serveFileWithRangeSupport(filePath, 'video/mp4', 'bytes=900-999999');
    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe('bytes 900-999/1000');
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.length).toBe(100);
  });
});
