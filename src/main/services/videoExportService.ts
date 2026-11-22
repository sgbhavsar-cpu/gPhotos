// Builds a slideshow-style video (photos + optional collages + an optional title slide, with
// crossfade transitions) from an album/chapter's photos, using a bundled real FFmpeg binary
// (ffmpeg-static) — no system install required. Every image is pre-normalized to the exact output
// resolution with `sharp` first (crop-to-fill, like Instagram/YouTube expect), which keeps the
// FFmpeg side to a single, simple filter graph instead of per-clip scale/pad filters.
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { computeCollageTiles, MAX_COLLAGE_PHOTOS, type CollageStyle, type CollageTile } from '../../types/collageLayout';
import { computeDimensions, type VideoTransitionName } from '../../types/videoFormat';
import { layoutText, makeText } from '../../types/slideDesign';
// @ts-ignore — ffmpeg-static has no types; it's just a string (the binary's path) at runtime.
import ffmpegPathRaw from 'ffmpeg-static';

export { computeCollageTiles };
export type { CollageStyle, CollageTile };

// Loaded lazily/defensively, same as avatarSpriteService.ts — a missing/broken native sharp
// binding on some machine should degrade this feature, not crash the whole app.
let sharp: any = null;
try {
  sharp = require('sharp');
} catch {}

export function getFfmpegPath(): string {
  let p = ffmpegPathRaw as unknown as string;
  // Packaged app: the binary can't be run from inside app.asar — electron-builder's asarUnpack
  // (see electron-builder.yml) puts a real copy next to it in app.asar.unpacked; ffmpeg-static's
  // own path still points at the asar one, so redirect it the same way faceDetectionWorker.js etc. do.
  const asarMarker = `${path.sep}app.asar${path.sep}`;
  if (p && p.includes(asarMarker) && !p.includes('app.asar.unpacked')) {
    p = p.replace(asarMarker, `${path.sep}app.asar.unpacked${path.sep}`);
  }
  return p;
}

export type AspectRatio = '16:9' | '9:16' | '1:1' | '4:3';
export type VideoResolutionTier = '720p' | '1080p';
export type VideoQuality = 'draft' | 'good' | 'best';
// A curated subset of ffmpeg's `xfade` transition names, enough variety without overwhelming the wizard.
export type TransitionName = VideoTransitionName;

const QUALITY_CRF: Record<VideoQuality, number> = { draft: 30, good: 23, best: 18 };

export { computeDimensions };

function requireSharp(): any {
  if (!sharp) throw new Error('Image processing (sharp) is not available.');
  return sharp;
}

/** Resizes/crops a single source photo to exactly fill the target frame (cover, not letterboxed). */
export async function prepareSlideImage(sourcePath: string, outPath: string, width: number, height: number): Promise<void> {
  await requireSharp()(sourcePath)
    .rotate() // apply EXIF orientation before cropping, so "cover" crops the upright image
    .resize(width, height, { fit: 'cover', position: 'attention' })
    .flatten({ background: '#000000' })
    .jpeg({ quality: 92 })
    .toFile(outPath);
}

/**
 * A title (and optional subtitle) on a plain gradient — the wizard's designer normally supplies a finished
 * image instead; this stays as the simple fallback. Text is wrapped and shrunk to fit the frame (librsvg
 * does no wrapping of its own, which is how a long title used to run off a vertical video).
 */
export async function renderTitleSlide(title: string, subtitle: string | undefined, width: number, height: number, outPath: string): Promise<void> {
  const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // No canvas in the main process: an average glyph is ~0.58 em wide (a touch more when bold).
  const approx = (f: { px: number; bold: boolean }, text: string) => text.length * f.px * (f.bold ? 0.62 : 0.58);
  const blocks = [makeText({ text: title, sizePct: 7.5, yPct: subtitle ? 44 : 50 })];
  if (subtitle) blocks.push(makeText({ text: subtitle, sizePct: 3.6, bold: false, color: '#94a3b8', yPct: 57 }));
  const texts = blocks.map((b) => {
    const l = layoutText(b, width, height, approx);
    const tspans = l.lines.map((line, i) => `<tspan x="${l.lineX[i]}" y="${l.box.y + l.lineHeightPx * (i + 0.8)}">${esc(line)}</tspan>`).join('');
    const anchor = l.textAlign === 'left' ? 'start' : l.textAlign === 'right' ? 'end' : 'middle';
    return `<text text-anchor="${anchor}" font-family="Arial, Helvetica, sans-serif" font-size="${l.font.px}" font-weight="${l.font.bold ? 700 : 400}" fill="${b.color}">${tspans}</text>`;
  }).join('');
  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#1e293b"/><stop offset="100%" stop-color="#0f172a"/>
    </linearGradient></defs>
    <rect width="100%" height="100%" fill="url(#bg)"/>${texts}
  </svg>`;
  await requireSharp()(Buffer.from(svg)).jpeg({ quality: 92 }).toFile(outPath);
}

/** Writes a designer card (a data: URL from the renderer's canvas) to disk, exactly fitted to the video frame. */
export async function prepareCardImage(imageDataUrl: string, outPath: string, width: number, height: number): Promise<void> {
  const m = /^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(imageDataUrl || '');
  if (!m) throw new Error('The title/credits card image is not a valid picture.');
  await requireSharp()(Buffer.from(m[2], 'base64'))
    .resize(width, height, { fit: 'cover' }) // a no-op for a card drawn at the right size
    .flatten({ background: '#000000' })
    .jpeg({ quality: 93 })
    .toFile(outPath);
}

/** 1-4 photos combined into one collage frame in the chosen layout style (capped at 4, same as the album chapter cover). */
export async function renderCollageImage(sourcePaths: string[], outPath: string, width: number, height: number, style: CollageStyle = 'grid'): Promise<void> {
  const photos = sourcePaths.slice(0, MAX_COLLAGE_PHOTOS);
  if (photos.length === 0) throw new Error('renderCollageImage needs at least one photo');
  if (photos.length === 1) return prepareSlideImage(photos[0], outPath, width, height);

  const tiles = computeCollageTiles(photos.length, style, width, height);
  const composites = await Promise.all(
    tiles.map(async (t, i) => ({
      input: await requireSharp()(photos[i]).rotate().resize(t.w, t.h, { fit: 'cover' }).jpeg().toBuffer(),
      left: t.x,
      top: t.y,
    }))
  );

  await requireSharp()({ create: { width, height, channels: 3, background: '#000000' } })
    .composite(composites)
    .jpeg({ quality: 92 })
    .toFile(outPath);
}

export interface SlidePlan {
  /** Absolute path to an already-generated image (or, with `clip`, a prepared video), pre-normalized to exactly `width`x`height`. */
  file: string;
  /** How long this slide stays up; defaults to `secondsPerItem` (cards like a title/credits page can differ). */
  seconds?: number;
  /** Set when `file` is a prepared video clip (see prepareClip) rather than a still image. */
  clip?: { hasAudio: boolean; volume: number };
}

/**
 * Cuts [startSec, startSec+lengthSec) out of a video and normalizes it to the exact output frame
 * (fit with a blurred copy of itself behind, so portrait phone clips don't get black bars or a hard crop),
 * constant fps, yuv420p, and stereo 44.1k AAC — so it can join the same xfade chain as the photo slides.
 */
export function buildClipPrepArgs(src: string, out: string, o: { width: number; height: number; fps: number; startSec: number; lengthSec: number; withAudio: boolean }): string[] {
  const { width: W, height: H } = o;
  const graph = `[0:v]split=2[a][b];[a]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=20:5[bg];` +
    `[b]scale=${W}:${H}:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1,fps=${o.fps},format=yuv420p[v]`;
  return [
    '-y', '-ss', Math.max(0, o.startSec).toFixed(3), '-t', o.lengthSec.toFixed(3), '-i', src,
    '-filter_complex', graph, '-map', '[v]',
    ...(o.withAudio ? ['-map', '0:a:0', '-ac', '2', '-ar', '44100', '-c:a', 'aac', '-b:a', '160k'] : ['-an']),
    '-c:v', 'libx264', '-crf', '20', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-t', o.lengthSec.toFixed(3), out,
  ];
}

/** Music under the whole video. */
export interface AudioPlan {
  /** An already-trimmed clip (see exportVideo) — this is what gets looped/faded. */
  file: string;
  /** Repeat the clip until the video ends. */
  loop: boolean;
  /** Fade the music out over the last N seconds (0 = none). */
  fadeOutSec: number;
  /** 0..1.5, default 1. */
  volume?: number;
}

export interface BuildFfmpegArgsOptions {
  width: number;
  height: number;
  fps?: number;
  secondsPerItem: number;
  /** One transition for every cut, or one entry per cut (slides.length - 1) — used by the wizard's random / multiple-effects modes. */
  transition: TransitionName | TransitionName[];
  transitionDurationSec: number; // ignored when transition === 'none'
  quality: VideoQuality;
  outputPath: string;
  audio?: AudioPlan;
}

export interface BuiltFfmpegPlan {
  args: string[];
  totalDurationSec: number;
}

/**
 * Pure — no I/O, no ffmpeg invocation — so it's unit-testable on its own. See the FFmpeg wiki's
 * "Xfade" recipe for the offset formula: for N same-duration clips (each shown `secondsPerItem`
 * seconds) crossfaded with transition duration `td`, the i-th transition's offset (0-indexed,
 * combining the chain-so-far with clip i+1) is `sum(durations[0..i]) - td*(i+1)`, and the whole
 * video's duration is `sum(durations) - td*(N-1)`.
 */
export function buildFfmpegArgs(slides: SlidePlan[], opts: BuildFfmpegArgsOptions): BuiltFfmpegPlan {
  if (slides.length === 0) throw new Error('No slides to render');
  const fps = opts.fps ?? 30;
  const crf = QUALITY_CRF[opts.quality];
  const preset = opts.quality === 'draft' ? 'veryfast' : opts.quality === 'best' ? 'slow' : 'medium';
  const anyRealTransition = Array.isArray(opts.transition) ? opts.transition.some((t) => t !== 'none') : opts.transition !== 'none';
  const useTransition = anyRealTransition && opts.transitionDurationSec > 0 && slides.length > 1;
  // A per-cut list can't mix hard cuts with crossfades in one xfade chain, so a stray 'none' inside a list falls back to 'fade'.
  const transitionFor = (edge: number): TransitionName => {
    const t = Array.isArray(opts.transition) ? (opts.transition[edge] ?? opts.transition[opts.transition.length - 1] ?? 'fade') : opts.transition;
    return t === 'none' ? 'fade' : t;
  };
  const td = useTransition ? opts.transitionDurationSec : 0;
  const durations = slides.map((sl) => (sl.seconds && sl.seconds > 0 ? sl.seconds : opts.secondsPerItem));

  const inputArgs: string[] = [];
  slides.forEach((sl, i) => {
    if (sl.clip) inputArgs.push('-i', sl.file);
    else inputArgs.push('-loop', '1', '-t', durations[i].toFixed(3), '-i', sl.file);
  });

  const formatLabels = slides.map((sl, i) => `[${i}:v]${sl.clip ? 'setpts=PTS-STARTPTS,' : ''}format=yuv420p,fps=${fps}[v${i}]`);
  let filterComplex: string;
  let totalDurationSec: number;

  if (!useTransition) {
    const concatInputs = slides.map((_, i) => `[v${i}]`).join('');
    filterComplex = `${formatLabels.join(';')};${concatInputs}concat=n=${slides.length}:v=1:a=0[outv]`;
    totalDurationSec = durations.reduce((a, b) => a + b, 0);
  } else {
    let cumulative = 0;
    let prevLabel = 'v0';
    const chain: string[] = [];
    for (let i = 0; i < slides.length - 1; i++) {
      cumulative += durations[i];
      const offset = Math.max(0, cumulative - td * (i + 1));
      const outLabel = i === slides.length - 2 ? 'outv' : `vx${i + 1}`;
      chain.push(`[${prevLabel}][v${i + 1}]xfade=transition=${transitionFor(i)}:duration=${td.toFixed(3)}:offset=${offset.toFixed(3)}[${outLabel}]`);
      prevLabel = outLabel;
    }
    filterComplex = `${formatLabels.join(';')};${chain.join(';')}`;
    totalDurationSec = durations.reduce((a, b) => a + b, 0) - td * (slides.length - 1);
  }

  const total = Math.max(0, totalDurationSec);
  const audioArgs: string[] = [];

  // Clip sound: each clip's audio is delayed to where its slide starts, then all are mixed into one bus.
  // With music too, the music is ducked (sidechain compressed) whenever a clip is making noise.
  const clipAudio = slides.map((sl, i) => ({ sl, i })).filter(({ sl }) => sl.clip?.hasAudio && sl.clip.volume > 0);
  if (clipAudio.length > 0) {
    let startAt = 0;
    const starts = durations.map((d) => { const s = startAt; startAt += d - td; return s; });
    const parts = clipAudio.map(({ sl, i }) => {
      const ms = Math.round(starts[i] * 1000);
      return `[${i}:a]aresample=44100,aformat=channel_layouts=stereo,volume=${sl.clip!.volume.toFixed(2)},adelay=${ms}|${ms}[ca${i}]`;
    });
    const labels = clipAudio.map(({ i }) => `[ca${i}]`).join('');
    parts.push(clipAudio.length === 1 ? `${labels}anull[bus]` : `${labels}amix=inputs=${clipAudio.length}:normalize=0:duration=longest[bus]`);
    if (opts.audio) {
      inputArgs.push(...(opts.audio.loop ? ['-stream_loop', '-1'] : []), '-i', opts.audio.file);
      const mf: string[] = [];
      if (opts.audio.volume !== undefined && Math.abs(opts.audio.volume - 1) > 0.01) mf.push(`volume=${opts.audio.volume.toFixed(2)}`);
      const fade = Math.min(opts.audio.fadeOutSec, total);
      if (fade > 0) mf.push(`afade=t=out:st=${(total - fade).toFixed(3)}:d=${fade.toFixed(3)}`);
      parts.push(`[${slides.length}:a]${mf.length ? mf.join(',') : 'anull'}[mus]`);
      parts.push('[bus]asplit=2[sc][cm]');
      parts.push('[mus][sc]sidechaincompress=threshold=0.03:ratio=10:attack=30:release=600[duck]');
      parts.push('[duck][cm]amix=inputs=2:normalize=0:duration=longest[outa]');
    } else {
      parts.push('[bus]anull[outa]');
    }
    filterComplex += ';' + parts.join(';');
    audioArgs.push('-map', '[outa]', '-c:a', 'aac', '-b:a', '192k', '-t', total.toFixed(3));
  } else if (opts.audio) {
    // Input options go before their -i: `-stream_loop -1` repeats the clip forever, and the explicit
    // output `-t` (below) is what ends the video at exactly the slideshow's length either way.
    inputArgs.push(...(opts.audio.loop ? ['-stream_loop', '-1'] : []), '-i', opts.audio.file);
    const filters: string[] = [];
    if (opts.audio.volume !== undefined && Math.abs(opts.audio.volume - 1) > 0.01) filters.push(`volume=${opts.audio.volume.toFixed(2)}`);
    const fade = Math.min(opts.audio.fadeOutSec, total);
    if (fade > 0) filters.push(`afade=t=out:st=${(total - fade).toFixed(3)}:d=${fade.toFixed(3)}`);
    audioArgs.push('-map', `${slides.length}:a`, '-c:a', 'aac', '-b:a', '192k', ...(filters.length ? ['-af', filters.join(',')] : []), '-t', total.toFixed(3));
  }

  const args = [
    ...inputArgs,
    '-filter_complex', filterComplex,
    '-map', '[outv]',
    ...audioArgs,
    '-r', String(fps),
    '-pix_fmt', 'yuv420p',
    '-c:v', 'libx264',
    '-crf', String(crf),
    '-preset', preset,
    '-movflags', '+faststart',
    '-y',
    opts.outputPath,
  ];
  return { args, totalDurationSec: total };
}

/** Parses ffmpeg's own `time=HH:MM:SS.cc` progress line format out of a chunk of its stderr output. */
export function parseFfmpegTimeSeconds(line: string): number | null {
  const m = line.match(/time=(\d+):(\d{2}):(\d{2})\.(\d+)/);
  if (!m) return null;
  const [, h, mi, s, cs] = m;
  return parseInt(h, 10) * 3600 + parseInt(mi, 10) * 60 + parseInt(s, 10) + parseInt(cs, 10) / Math.pow(10, cs.length);
}

/** Parses ffmpeg's `Duration: HH:MM:SS.cc` line (printed for any input it opens) — used to sanity-check a rendered file. */
export function parseFfmpegDurationSeconds(stderrText: string): number | null {
  const m = stderrText.match(/Duration: (\d+):(\d{2}):(\d{2})\.(\d+)/);
  if (!m) return null;
  const [, h, mi, s, cs] = m;
  return parseInt(h, 10) * 3600 + parseInt(mi, 10) * 60 + parseInt(s, 10) + parseInt(cs, 10) / Math.pow(10, cs.length);
}

/** Runs the bundled ffmpeg on an existing file just to read its container `Duration` back out of stderr — no ffprobe binary needed. */
export function probeDurationSec(filePath: string): Promise<number | null> {
  return new Promise((resolve) => {
    let stderr = '';
    const proc = spawn(getFfmpegPath(), ['-i', filePath, '-f', 'null', '-'], { windowsHide: true });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', () => resolve(null));
    proc.on('close', () => resolve(parseFfmpegDurationSeconds(stderr)));
  });
}

export interface MediaInfo {
  durationSec: number | null;
  hasAudio: boolean;
  hasVideo: boolean;
}

/** Duration and which streams a media file has, read from ffmpeg's own banner (no ffprobe needed). */
export function probeMedia(filePath: string): Promise<MediaInfo> {
  return new Promise((resolve) => {
    let stderr = '';
    // No output file: ffmpeg prints the banner and exits, instead of decoding the whole video to a null sink.
    const proc = spawn(getFfmpegPath(), ['-hide_banner', '-i', filePath], { windowsHide: true });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', () => resolve({ durationSec: null, hasAudio: false, hasVideo: false }));
    proc.on('close', () => resolve({
      durationSec: parseFfmpegDurationSeconds(stderr),
      hasAudio: /Stream #\d+:\d+[^\n]*: Audio:/.test(stderr),
      hasVideo: /Stream #\d+:\d+[^\n]*: Video:/.test(stderr),
    }));
  });
}

/** The container's `creation_time` tag (when the video was recorded), or null. Banner-only: reads just the file header. */
export function probeCreationTime(filePath: string): Promise<Date | null> {
  return new Promise((resolve) => {
    let stderr = '';
    const proc = spawn(getFfmpegPath(), ['-hide_banner', '-i', filePath], { windowsHide: true });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', () => resolve(null));
    proc.on('close', () => {
      const m = stderr.match(/creation_time\s*:\s*(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/);
      const d = m ? new Date(`${m[1]}T${m[2]}Z`) : null;
      resolve(d && !isNaN(d.getTime()) && d.getFullYear() > 1990 ? d : null);
    });
  });
}

/** ISO 6709 "+23.0225+072.5714+000.0/" (what phones write as the container `location` tag) → degrees, or null. */
export function parseIso6709(text: string): { latitude: number; longitude: number } | null {
  const m = text.match(/([+-]\d{1,2}(?:\.\d+)?)([+-]\d{1,3}(?:\.\d+)?)/);
  if (!m) return null;
  const latitude = Number(m[1]);
  const longitude = Number(m[2]);
  if (!isFinite(latitude) || !isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  if (latitude === 0 && longitude === 0) return null;
  return { latitude, longitude };
}

/** GPS position a phone embedded in the video container (`location` / Apple location tag), or null. Banner-only. */
export function probeLocation(filePath: string): Promise<{ latitude: number; longitude: number } | null> {
  return new Promise((resolve) => {
    let stderr = '';
    const proc = spawn(getFfmpegPath(), ['-hide_banner', '-i', filePath], { windowsHide: true });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', () => resolve(null));
    proc.on('close', () => {
      const m = stderr.match(/(?:location(?:-eng)?|com\.apple\.quicktime\.location\.ISO6709)\s*:\s*(\S+)/i);
      resolve(m ? parseIso6709(m[1]) : null);
    });
  });
}

/** A short low-bitrate mp3 (as a data: URL) of `[startSec, endSec)` of a file, so the wizard can play the chosen section. */
export function makeAudioPreview(filePath: string, startSec: number, endSec: number | null, maxSeconds = 20): Promise<string | null> {
  return new Promise((resolve) => {
    const start = Math.max(0, startSec || 0);
    const span = Math.min(maxSeconds, endSec != null && endSec > start ? endSec - start : maxSeconds);
    const chunks: Buffer[] = [];
    const proc = spawn(getFfmpegPath(), ['-v', 'error', '-ss', String(start), '-i', filePath, '-vn', '-t', String(span), '-ac', '2', '-ar', '44100', '-b:a', '96k', '-f', 'mp3', 'pipe:1'], { windowsHide: true });
    proc.stdout.on('data', (d) => chunks.push(d));
    proc.on('error', () => resolve(null));
    proc.on('close', (code) => {
      const buf = Buffer.concat(chunks);
      resolve(code === 0 && buf.length > 0 ? 'data:audio/mpeg;base64,' + buf.toString('base64') : null);
    });
  });
}

/**
 * Grabs a single frame from a video file as a JPEG buffer, via ffmpeg's own seek+decode (no
 * ffprobe, no temp file — piped straight to stdout). Used for a video's thumbnail/hover-preview
 * frames (see docs/FEATURE_VIDEO_LIBRARY_SUPPORT.md) — shared so both the main thumbnail cache
 * and the virtual-mirror thumbnail path use the exact same extraction, not two copies.
 */
export function grabVideoFrame(filePath: string, atSec: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const proc = spawn(getFfmpegPath(), [
      '-ss', Math.max(0, atSec).toFixed(3), '-i', filePath,
      '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1',
    ], { windowsHide: true });
    proc.stdout.on('data', (d) => chunks.push(d));
    proc.on('error', () => resolve(null));
    proc.on('close', (code) => {
      const buf = Buffer.concat(chunks);
      resolve(code === 0 && buf.length > 0 ? buf : null);
    });
  });
}

export interface RunFfmpegResult {
  success: boolean;
  error?: string;
}

/** Spawns ffmpeg with the given args, reporting fractional progress (0..1) via `onProgress` as it encodes. */
export function runFfmpeg(args: string[], expectedDurationSec: number, onProgress?: (fraction: number) => void, signal?: AbortSignal): Promise<RunFfmpegResult> {
  return new Promise((resolve) => {
    const proc = spawn(getFfmpegPath(), args, { windowsHide: true });
    let stderrTail = '';
    const onAbort = () => { try { proc.kill(); } catch {} };
    signal?.addEventListener('abort', onAbort);

    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderrTail = (stderrTail + text).slice(-4000); // keep only the tail for a useful error message
      const t = parseFfmpegTimeSeconds(text);
      if (t !== null && expectedDurationSec > 0) onProgress?.(Math.min(1, t / expectedDurationSec));
    });
    proc.on('error', (err) => {
      signal?.removeEventListener('abort', onAbort);
      resolve({ success: false, error: err.message });
    });
    proc.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) resolve({ success: false, error: 'Cancelled' });
      else if (code === 0) resolve({ success: true });
      else resolve({ success: false, error: stderrTail.trim().split('\n').slice(-5).join('\n') || `ffmpeg exited with code ${code}` });
    });
  });
}

export interface VideoSlideSpec {
  kind: 'photo' | 'collage' | 'title' | 'card' | 'clip';
  /** Absolute source file paths (1 for 'photo', up to 4 for 'collage', unused otherwise). */
  photoPaths?: string[];
  /** For 'clip': the source video, the part to use (seconds; end null/0 = to the end), and its own sound. */
  clipPath?: string;
  trimStartSec?: number;
  trimEndSec?: number | null;
  muted?: boolean;
  volume?: number;
  collageStyle?: CollageStyle;
  title?: string;
  subtitle?: string;
  /** For 'card': the finished title/credits picture as a data: URL, drawn by the wizard's designer. */
  imageDataUrl?: string;
  /** Overrides the job's seconds-per-slide for this slide (title / credits cards). */
  seconds?: number;
}

export interface VideoAudioSpec {
  filePath: string;
  /** Where in the source file the clip starts (seconds). */
  startSec: number;
  /** Where it ends; null = the end of the file. */
  endSec: number | null;
  /** Repeat the clip to fill the whole video. */
  loop: boolean;
  fadeOutSec: number;
  volume?: number;
}

export interface VideoExportJob {
  slides: VideoSlideSpec[];
  aspectRatio: AspectRatio;
  resolution: VideoResolutionTier;
  quality: VideoQuality;
  transition: TransitionName | TransitionName[];
  transitionDurationSec: number;
  secondsPerItem: number;
  outputPath: string;
  tempDir: string;
  audio?: VideoAudioSpec;
}

export interface VideoExportProgress {
  stage: 'preparing' | 'encoding';
  done: number;
  total: number;
}

export interface VideoExportResult {
  success: boolean;
  error?: string;
  skippedSlides: number;
  outputPath?: string;
  durationSec?: number;
}

/**
 * Prepares every slide image (resizing photos, building collages/the title slide) and then
 * encodes them into one video. A slide whose source photo(s) can't be read (unsupported format,
 * missing file) is skipped rather than failing the whole export — `skippedSlides` reports how many.
 */
export async function exportVideo(job: VideoExportJob, onProgress?: (p: VideoExportProgress) => void, signal?: AbortSignal): Promise<VideoExportResult> {
  const { width, height } = computeDimensions(job.aspectRatio, job.resolution);
  fs.mkdirSync(job.tempDir, { recursive: true });

  const slideFiles: SlidePlan[] = [];
  let skippedSlides = 0;
  for (let i = 0; i < job.slides.length; i++) {
    if (signal?.aborted) return { success: false, error: 'Cancelled', skippedSlides };
    const slide = job.slides[i];
    const outPath = path.join(job.tempDir, `slide_${String(i).padStart(4, '0')}.jpg`);
    try {
      if (slide.kind === 'clip') {
        const src = slide.clipPath || '';
        const info = await probeMedia(src);
        if (!info.hasVideo) throw new Error('not a readable video');
        const start = Math.max(0, slide.trimStartSec ?? 0);
        const end = slide.trimEndSec && slide.trimEndSec > start ? slide.trimEndSec : (info.durationSec ?? start);
        const len = Math.min(end, info.durationSec ?? end) - start;
        if (!(len > 0.2)) throw new Error('empty trim range');
        const clipOut = path.join(job.tempDir, `clip_${String(i).padStart(4, '0')}.mp4`);
        const withAudio = info.hasAudio && !slide.muted;
        const prep = await runFfmpeg(buildClipPrepArgs(src, clipOut, { width, height, fps: 30, startSec: start, lengthSec: len, withAudio }), len, undefined, signal);
        if (!prep.success) throw new Error(prep.error || 'clip preparation failed');
        slideFiles.push({ file: clipOut, seconds: len, clip: { hasAudio: withAudio, volume: slide.volume ?? 1 } });
        onProgress?.({ stage: 'preparing', done: i + 1, total: job.slides.length });
        continue;
      }
      if (slide.kind === 'card') {
        await prepareCardImage(slide.imageDataUrl || '', outPath, width, height);
      } else if (slide.kind === 'title') {
        await renderTitleSlide(slide.title || '', slide.subtitle, width, height, outPath);
      } else if (slide.kind === 'collage') {
        await renderCollageImage(slide.photoPaths || [], outPath, width, height, slide.collageStyle || 'grid');
      } else {
        await prepareSlideImage((slide.photoPaths || [])[0], outPath, width, height);
      }
      slideFiles.push({ file: outPath, seconds: slide.seconds });
    } catch (err) {
      console.warn(`videoExportService: skipping slide ${i} (${slide.kind}):`, err);
      skippedSlides++;
    }
    onProgress?.({ stage: 'preparing', done: i + 1, total: job.slides.length });
  }

  if (slideFiles.length === 0) {
    return { success: false, error: 'No slides could be prepared (every photo failed to read).', skippedSlides };
  }

  try {
    fs.mkdirSync(path.dirname(job.outputPath), { recursive: true });
  } catch (err: any) {
    return { success: false, error: `Could not create the output folder: ${err?.message || err}`, skippedSlides };
  }

  // Music: cut the chosen part out of the source first (to a plain PCM clip), so looping it later is seamless.
  let audioPlan: AudioPlan | undefined;
  if (job.audio) {
    const clipPath = path.join(job.tempDir, 'audio_clip.wav');
    const cut = ['-y', '-ss', Math.max(0, job.audio.startSec).toFixed(3)];
    if (job.audio.endSec !== null && job.audio.endSec > job.audio.startSec) cut.push('-to', job.audio.endSec.toFixed(3));
    cut.push('-i', job.audio.filePath, '-vn', '-ac', '2', '-ar', '44100', '-c:a', 'pcm_s16le', clipPath);
    const cutResult = await runFfmpeg(cut, 0, undefined, signal);
    if (!cutResult.success || !fs.existsSync(clipPath)) {
      try { fs.rmSync(job.tempDir, { recursive: true, force: true }); } catch {}
      return { success: false, error: `Could not use the chosen music: ${cutResult.error || 'no audio was found in that file.'}`, skippedSlides };
    }
    audioPlan = { file: clipPath, loop: job.audio.loop, fadeOutSec: job.audio.fadeOutSec, volume: job.audio.volume };
  }

  const { args, totalDurationSec } = buildFfmpegArgs(
    slideFiles,
    {
      width, height,
      secondsPerItem: job.secondsPerItem,
      transition: job.transition,
      transitionDurationSec: job.transitionDurationSec,
      quality: job.quality,
      outputPath: job.outputPath,
      audio: audioPlan,
    }
  );

  const result = await runFfmpeg(args, totalDurationSec, (fraction) => {
    onProgress?.({ stage: 'encoding', done: Math.round(fraction * 100), total: 100 });
  }, signal);

  // Best-effort cleanup of the generated slide images — never let a cleanup failure mask the real result.
  try { fs.rmSync(job.tempDir, { recursive: true, force: true }); } catch {}

  if (!result.success) return { success: false, error: result.error, skippedSlides };
  return { success: true, skippedSlides, outputPath: job.outputPath, durationSec: totalDurationSec };
}
