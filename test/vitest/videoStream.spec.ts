import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import type { AddressInfo } from 'net';
import { buildHlsPlaylist, buildHlsSegmentArgs, streamHlsSegment, getVideoDurationSec } from '../../src/main/services/videoStreamService';
import { runFfmpeg, probeMedia } from '../../src/main/services/videoExportService';

describe('buildHlsPlaylist', () => {
  it('covers the whole duration in 6 s segments, the last one shorter', () => {
    const txt = buildHlsPlaylist(14, (i) => `seg?i=${i}`);
    expect(txt.match(/#EXTINF/g)).toHaveLength(3);
    expect(txt).toContain('#EXTINF:6.000,\nseg?i=0');
    expect(txt).toContain('#EXTINF:2.000,\nseg?i=2');
    expect(txt.trim().endsWith('#EXT-X-ENDLIST')).toBe(true);
    expect(txt).toContain('#EXT-X-TARGETDURATION:6');
  });
  it('an exact multiple has no empty trailing segment', () => {
    expect(buildHlsPlaylist(12, (i) => `s${i}`).match(/#EXTINF/g)).toHaveLength(2);
  });
});

describe('buildHlsSegmentArgs', () => {
  it('seeks on the input (no whole-file read) and offsets timestamps by the segment start', () => {
    const a = buildHlsSegmentArgs('v.mp4', 2, 100);
    expect(a.indexOf('-ss')).toBeLessThan(a.indexOf('-i'));
    expect(a[a.indexOf('-ss') + 1]).toBe('12.000');
    expect(a[a.indexOf('-output_ts_offset') + 1]).toBe('12.000');
    expect(a).toContain('libx264');
    expect(a).toContain('aac');
  });
});

describe('streamHlsSegment: real ffmpeg', () => {
  it('re-encodes a segment of a HEVC-free test clip to MPEG-TS that plays (H.264 + AAC), without touching the rest', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp_hls_'));
    try {
      const src = path.join(dir, 'v.mp4');
      expect((await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'testsrc=size=1920x1080:rate=30:duration=14', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=14', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', src], 0)).success).toBe(true);
      const dur = await getVideoDurationSec(src);
      expect(dur).toBeGreaterThan(13);

      const server = http.createServer((req, res) => { streamHlsSegment(res, src, 1, dur!); });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
      const port = (server.address() as AddressInfo).port;
      const buf: Buffer = await new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}/`, (res) => {
          expect(res.headers['content-type']).toBe('video/mp2t');
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks)));
        }).on('error', reject);
      });
      server.close();
      expect(buf.length).toBeGreaterThan(1000);
      expect(buf[0]).toBe(0x47); // MPEG-TS sync byte
      const seg = path.join(dir, 'seg.ts');
      fs.writeFileSync(seg, buf);
      const info = await probeMedia(seg);
      expect(info.hasVideo).toBe(true);
      expect(info.hasAudio).toBe(true);
      expect(info.durationSec).toBeGreaterThan(5);
      expect(info.durationSec).toBeLessThan(7.5);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch {}
    }
  }, 90000);
});

describe('buildHlsSegmentArgs: gpu mode', () => {
  it('decodes, scales and encodes on the GPU, keeping the same seek/offset behaviour', () => {
    const a = buildHlsSegmentArgs('v.mp4', 1, 100, 6, 'gpu');
    expect(a).toContain('h264_nvenc');
    expect(a.join(' ')).toContain('-hwaccel cuda -hwaccel_output_format cuda');
    expect(a.join(' ')).toContain('scale_cuda=');
    expect(a.indexOf('-ss')).toBeLessThan(a.indexOf('-i'));
    expect(a[a.indexOf('-output_ts_offset') + 1]).toBe('6.000');
  });
});
