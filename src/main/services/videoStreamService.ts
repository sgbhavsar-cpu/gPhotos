// On-the-fly video playback for phone browsers. The original (often a OneDrive / NAS file) is never copied or
// downloaded as a whole: each ~6 second piece of the video is cut out of it with ffmpeg (which seeks and reads
// only the byte ranges it needs), re-encoded to H.264 + AAC (what every phone browser plays) and sent as an
// HLS (MPEG-TS) segment. The playlist is built from the video's duration alone, so nothing is prepared up front
// and seeking just asks for a different segment.
import http from 'http';
import os from 'os';
import { spawn } from 'child_process';
import { getFfmpegPath, probeMedia } from './videoExportService';

export const HLS_SEGMENT_SEC = 6;
const MAX_HEIGHT = 720;
// 2, not more: with a third simultaneous GPU encode every one of them slowed ~15x on the test machine (RTX laptop GPU).
const MAX_CONCURRENT_ENCODES = 2;

/** A VOD playlist of fixed-length segments; `segmentUrl(i)` supplies each segment's address. */
export function buildHlsPlaylist(durationSec: number, segmentUrl: (index: number) => string, segSec = HLS_SEGMENT_SEC): string {
  const count = Math.max(1, Math.ceil(durationSec / segSec - 1e-6));
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${Math.ceil(segSec)}`, '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD'];
  for (let i = 0; i < count; i++) {
    const len = Math.min(segSec, durationSec - i * segSec);
    lines.push(`#EXTINF:${len.toFixed(3)},`, segmentUrl(i));
  }
  lines.push('#EXT-X-ENDLIST');
  return lines.join('\n') + '\n';
}

/**
 * ffmpeg arguments that write segment `index` of `src` to stdout as MPEG-TS, timestamps continuing across segments.
 * 'gpu' decodes, scales and encodes entirely on an NVIDIA card (a 4K HDR phone clip converts ~3x faster than it plays);
 * 'cpu' is the software path that works everywhere but can be slower than real time on 4K.
 */
export function buildHlsSegmentArgs(src: string, index: number, durationSec: number, segSec = HLS_SEGMENT_SEC, mode: 'cpu' | 'gpu' = 'cpu'): string[] {
  const start = index * segSec;
  const len = Math.max(0.1, Math.min(segSec, durationSec - start));
  const gpu = mode === 'gpu';
  const w = `if(gt(ih,${MAX_HEIGHT}),-2,iw)`;
  const h = `if(gt(ih,${MAX_HEIGHT}),${MAX_HEIGHT},ih)`;
  return [
    '-hide_banner', '-loglevel', 'error',
    ...(gpu ? ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda'] : []),
    // Input-side -ss: seeks via the container index and reads only what it needs (no download of the whole file).
    '-ss', start.toFixed(3), '-t', len.toFixed(3), '-i', src,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-vf', gpu ? `scale_cuda=w='${w}':h='${h}':format=nv12` : `scale='${w}':'${h}',pad=ceil(iw/2)*2:ceil(ih/2)*2`,
    ...(gpu
      ? ['-c:v', 'h264_nvenc', '-preset', 'p2', '-profile:v', 'main', '-b:v', '4M', '-maxrate', '6M', '-bufsize', '8M']
      : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '27', '-profile:v', 'main', '-pix_fmt', 'yuv420p']),
    '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-ar', '44100',
    '-output_ts_offset', start.toFixed(3),
    '-f', 'mpegts', '-muxdelay', '0', '-muxpreload', '0', 'pipe:1',
  ];
}

// Duration per file, so every segment request doesn't re-probe the (possibly slow, remote) file.
const durationCache = new Map<string, number>();
export async function getVideoDurationSec(src: string): Promise<number | null> {
  const hit = durationCache.get(src);
  if (hit) return hit;
  const info = await probeMedia(src);
  if (!info.hasVideo || !info.durationSec || info.durationSec <= 0) return null;
  if (durationCache.size > 500) durationCache.clear();
  durationCache.set(src, info.durationSec);
  return info.durationSec;
}

// Phone players prefetch several segments at once; encoding is CPU-heavy, so only a few run at a time.
let active = 0;
const waiting: Array<() => void> = [];
const acquire = () => new Promise<void>((resolve) => { if (active < MAX_CONCURRENT_ENCODES) { active++; resolve(); } else waiting.push(() => { active++; resolve(); }); });
const release = () => { active--; waiting.shift()?.(); };

// null = not tried yet; false once the GPU path has failed on this machine (no NVIDIA card / driver), so later segments skip it.
let gpuUsable: boolean | null = null;

/** Starts one encode; `first` resolves 'data' once the first bytes are ready, or 'failed' if it ended without producing any. */
function startEncode(src: string, index: number, durationSec: number, mode: 'cpu' | 'gpu') {
  const proc = spawn(getFfmpegPath(), buildHlsSegmentArgs(src, index, durationSec, HLS_SEGMENT_SEC, mode), { windowsHide: true });
  proc.stderr.on('data', () => {}); // -loglevel error: nothing worth keeping, but never let the pipe fill
  // Someone is watching this: when the PC is busy with background work (AI models, scans, antivirus), run ahead of it.
  try { if (proc.pid) os.setPriority(proc.pid, os.constants.priority.PRIORITY_ABOVE_NORMAL); } catch {}
  const first = new Promise<'data' | 'failed'>((resolve) => {
    proc.stdout.once('readable', () => resolve('data'));
    proc.once('error', () => resolve('failed'));
    proc.once('close', () => resolve('failed')); // no-op if data already arrived
  });
  return { proc, first };
}

/** Encodes one segment and pipes it to the response; the encode is killed if the client goes away. */
export async function streamHlsSegment(res: http.ServerResponse, src: string, index: number, durationSec: number): Promise<void> {
  await acquire();
  let current: ReturnType<typeof startEncode> | null = null;
  const onClose = () => { try { current?.proc.kill(); } catch {} };
  res.on('close', onClose);
  try {
    if (res.destroyed) return;
    let usedGpu = gpuUsable !== false;
    current = startEncode(src, index, durationSec, usedGpu ? 'gpu' : 'cpu');
    if ((await current.first) === 'failed') {
      if (!usedGpu) { res.statusCode = 500; res.end(); return; }
      gpuUsable = false; // fall back to software for this and every later segment
      usedGpu = false;
      current = startEncode(src, index, durationSec, 'cpu');
      if ((await current.first) === 'failed') { res.statusCode = 500; res.end(); return; }
    }
    if (usedGpu) gpuUsable = true;
    if (res.destroyed) return;
    const enc = current;
    res.setHeader('Content-Type', 'video/mp2t');
    res.setHeader('Cache-Control', 'private, max-age=600');
    enc.proc.stdout.pipe(res);
    await new Promise<void>((resolve) => { enc.proc.once('close', () => resolve()); res.once('close', () => resolve()); });
  } finally {
    res.off('close', onClose);
    onClose();
    release();
  }
}
