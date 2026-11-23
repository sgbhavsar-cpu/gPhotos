// Builds a slideshow-style video (photos + optional collages + an optional title slide, with
// crossfade transitions) from an album/chapter's photos, using a bundled real FFmpeg binary
// (ffmpeg-static) — no system install required. Every image is pre-normalized to the exact output
// resolution with `sharp` first (crop-to-fill, like Instagram/YouTube expect), which keeps the
// FFmpeg side to a single, simple filter graph instead of per-clip scale/pad filters.
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { computeCollageTiles, MAX_VIDEO_COLLAGE_PHOTOS, type CollageStyle, type CollageTile } from '../../types/collageLayout';
import { computeDimensions, CAPTION_COLORS, DEFAULT_CAPTION_STYLE, type VideoCaptionStyle, type VideoTransitionName, type VideoFilterName, type VideoMotionName } from '../../types/videoFormat';
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
export type VideoResolutionTier = '360p' | '720p' | '1080p';
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
  const photos = sourcePaths.slice(0, MAX_VIDEO_COLLAGE_PHOTOS);
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

const even = (n: number) => 2 * Math.round(n / 2);

/**
 * A transparent, frame-sized picture with one lower-third caption: white text with a soft shadow on a translucent dark
 * band at the bottom-left. Laid over a slide with ffmpeg's overlay, so it stays still while the photo moves.
 * Text is wrapped to two lines at an average glyph width (no canvas in the main process, as in renderTitleSlide).
 */
export async function renderCaptionPng(text: string, width: number, height: number, outPath: string, style: VideoCaptionStyle = DEFAULT_CAPTION_STYLE): Promise<void> {
  const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const px = Math.round(Math.min(width, height) * ({ small: 0.038, medium: 0.05, large: 0.068 }[style.size] ?? 0.05));
  const maxChars = Math.max(8, Math.floor((width * 0.84) / (px * 0.56)));
  const words = text.trim().split(/\s+/);
  const lines: string[] = [];
  for (const w of words) {
    const last = lines[lines.length - 1];
    if (last !== undefined && (last + ' ' + w).length <= maxChars) lines[lines.length - 1] = last + ' ' + w;
    else lines.push(w);
  }
  const shown = lines.slice(0, 2);
  if (lines.length > 2) shown[1] = shown[1].slice(0, Math.max(1, maxChars - 1)) + '…';
  const boxW = Math.min(width * 0.92, Math.max(...shown.map((l) => l.length)) * px * 0.56 + px * 1.6);
  const boxH = shown.length * px * 1.25 + px * 0.9;
  const x = Math.round(width * 0.04);
  const y = Math.round(style.position === 'top' ? height * 0.06 : style.position === 'middle' ? (height - boxH) / 2 : height - boxH - height * 0.06);
  const fill = (CAPTION_COLORS.find((c) => c[0] === style.color) ?? CAPTION_COLORS[0])[2];
  const tspans = shown.map((l, i) => `<tspan x="${x + px * 0.8}" y="${y + px * 0.45 + px * 1.25 * (i + 0.8)}">${esc(l)}</tspan>`).join('');
  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <rect x="${x}" y="${y}" width="${Math.round(boxW)}" height="${Math.round(boxH)}" rx="${Math.round(px * 0.35)}" fill="rgba(8,12,20,0.55)"/>
    <text font-family="Arial, Helvetica, sans-serif" font-size="${px}" font-weight="600" fill="${fill}" style="paint-order:stroke" stroke="rgba(0,0,0,0.35)" stroke-width="${Math.max(1, Math.round(px * 0.06))}">${tspans}</text>
  </svg>`;
  await requireSharp()(Buffer.from(svg)).png().toFile(outPath);
}

export interface SlidePlan {
  /** Absolute path to an already-generated image (or, with `clip`, a prepared video), pre-normalized to exactly `width`x`height`. */
  file: string;
  /** How long this slide stays up; defaults to `secondsPerItem` (cards like a title/credits page can differ). */
  seconds?: number;
  /** Set when `file` is a prepared video clip (see prepareClip) rather than a still image. */
  clip?: { hasAudio: boolean; volume: number };
  /** Still images only: slow zoom / pan. The image must then have been prepared MOTION_SCALE times larger than the frame. */
  motion?: VideoMotionName;
  focus?: { x: number; y: number };
  filter?: VideoFilterName;
  /** A transparent frame-sized PNG laid over this slide (see renderCaptionPng). */
  captionFile?: string;
}

/** A moving still is cropped from an image this much larger than the frame, so the zoom stays sharp. */
export const MOTION_SCALE = 1.25;

const FILTER_CHAINS: Record<Exclude<VideoFilterName, 'none'>, string> = {
  warm: 'colorbalance=rs=.08:gs=.02:bs=-.08:rm=.06:bm=-.06,eq=saturation=1.1',
  cool: 'colorbalance=rs=-.06:bs=.08:rm=-.05:bm=.07',
  vintage: 'curves=preset=vintage',
  bw: 'hue=s=0,eq=contrast=1.1',
  vivid: 'eq=saturation=1.4:contrast=1.08',
  cinematic: 'eq=contrast=1.12:saturation=0.92,colorbalance=rs=-.05:bs=.07:rh=.07:bh=-.05',
};

/** zoompan expression for a still; `frames` = how many output frames the slide lasts. */
function motionFilter(motion: VideoMotionName, focus: { x: number; y: number } | undefined, frames: number, w: number, h: number, fps: number): string | null {
  if (motion === 'none') return null;
  const clamp = (v: number | undefined) => Math.min(0.9, Math.max(0.1, v ?? 0.5));
  const fx = clamp(focus?.x), fy = clamp(focus?.y);
  const n = Math.max(1, frames);
  const t = `on/${n}`;
  const tail = `:d=1:s=${w}x${h}:fps=${fps}`;
  const pos = (fxExpr: string) => `:x='(iw-iw/zoom)*${fxExpr}':y='(ih-ih/zoom)*${fy}'`;
  switch (motion) {
    case 'zoomout': return `zoompan=z='1.2-0.2*${t}'${pos(String(fx))}${tail}`;
    case 'panleft': return `zoompan=z='1.18'${pos(`(1-${t})`)}${tail}`;
    case 'panright': return `zoompan=z='1.18'${pos(t)}${tail}`;
    case 'face': return `zoompan=z='1+0.3*${t}'${pos(String(fx))}${tail}`;
    default: return `zoompan=z='1+0.2*${t}'${pos(String(fx))}${tail}`; // zoomin
  }
}

/**
 * Cuts [startSec, startSec+lengthSec) out of a video and normalizes it to the exact output frame
 * (fit with a blurred copy of itself behind, so portrait phone clips don't get black bars or a hard crop),
 * constant fps, yuv420p, and stereo 44.1k AAC — so it can join the same xfade chain as the photo slides.
 */
export function buildClipPrepArgs(src: string, out: string, o: { width: number; height: number; fps: number; startSec: number; lengthSec: number; withAudio: boolean; speed?: number; reverse?: boolean; holdSec?: number }): string[] {
  const { width: W, height: H } = o;
  const speed = Math.min(4, Math.max(0.25, o.speed ?? 1));
  const hold = Math.min(10, Math.max(0, o.holdSec ?? 0)); // freeze: the last frame stays up this long after the clip
  const outLen = o.lengthSec / speed + hold;
  // atempo only accepts 0.5..2 per stage, so 4x / 0.25x chain two stages.
  const tempo = speed === 1 ? '' : speed > 2 ? `atempo=2,atempo=${(speed / 2).toFixed(4)}` : speed < 0.5 ? `atempo=0.5,atempo=${(speed / 0.5).toFixed(4)}` : `atempo=${speed.toFixed(4)}`;
  const audioFilters = [o.reverse ? 'areverse' : '', tempo, hold > 0 ? `apad=pad_dur=${hold.toFixed(3)}` : ''].filter(Boolean).join(',');
  const graph = `[0:v]${o.reverse ? 'reverse,' : ''}split=2[a][b];[a]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=20:5[bg];` +
    `[b]scale=${W}:${H}:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1${speed === 1 ? '' : `,setpts=PTS/${speed.toFixed(4)}`},fps=${o.fps}${hold > 0 ? `,tpad=stop_mode=clone:stop_duration=${hold.toFixed(3)}` : ''},format=yuv420p[v]`;
  return [
    '-y', '-ss', Math.max(0, o.startSec).toFixed(3), '-t', o.lengthSec.toFixed(3), '-i', src,
    '-filter_complex', graph, '-map', '[v]',
    ...(o.withAudio ? ['-map', '0:a:0', ...(audioFilters ? ['-af', audioFilters] : []), '-ac', '2', '-ar', '44100', '-c:a', 'aac', '-b:a', '160k'] : ['-an']),
    '-c:v', 'libx264', '-crf', '20', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-t', outLen.toFixed(3), out,
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

/** A spoken / extra sound track laid over the video (voice-over, ambient sound...). */
export interface VoiceTrackPlan {
  file: string;
  /** Where in the VIDEO this track starts (seconds). */
  startSec: number;
  /** Which part of the file to use (seconds into the file); length null = to the end. */
  trimStartSec?: number;
  lengthSec?: number | null;
  /** 0..2, default 1. */
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
  /** Extra tracks mixed in; the music is ducked under them (and under clip sound). */
  voice?: VoiceTrackPlan[];
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
    // A moving still needs frames at the output rate (zoompan advances once per input frame).
    else inputArgs.push('-loop', '1', ...(sl.motion && sl.motion !== 'none' ? ['-framerate', String(fps)] : []), '-t', durations[i].toFixed(3), '-i', sl.file);
  });
  // Caption pictures come after the slides (and before any music), one input per captioned slide.
  const captionInput = new Map<number, number>();
  slides.forEach((sl, i) => {
    if (!sl.captionFile) return;
    captionInput.set(i, slides.length + captionInput.size);
    inputArgs.push('-loop', '1', '-t', durations[i].toFixed(3), '-i', sl.captionFile);
  });
  const voice = opts.voice ?? [];
  const voiceIdx = voice.map((_, k) => slides.length + captionInput.size + k);
  voice.forEach((v) => {
    inputArgs.push(...(v.trimStartSec ? ['-ss', v.trimStartSec.toFixed(3)] : []), ...(v.lengthSec ? ['-t', v.lengthSec.toFixed(3)] : []), '-i', v.file);
  });
  const audioIdx = slides.length + captionInput.size + voice.length;

  const formatLabels = slides.map((sl, i) => {
    const look = sl.filter && sl.filter !== 'none' ? FILTER_CHAINS[sl.filter] : null;
    const move = sl.motion && !sl.clip ? motionFilter(sl.motion, sl.focus, Math.round(durations[i] * fps), opts.width, opts.height, fps) : null;
    const pre = `${sl.clip ? 'setpts=PTS-STARTPTS,' : ''}${move ? move + ',' : ''}`;
    const cap = captionInput.get(i);
    // Order: motion, colour look, caption on top (so the caption stays put while the picture moves), then the common format.
    return cap === undefined
      ? `[${i}:v]${pre}${look ? look + ',' : ''}format=yuv420p,fps=${fps}[v${i}]`
      : `[${i}:v]${pre}${look ? look + ',' : ''}format=yuv420p[b${i}];[b${i}][${cap}:v]overlay=0:0:format=auto,format=yuv420p,fps=${fps}[v${i}]`;
  });
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

  // Everything that has sound of its own is mixed into "loud" buses; the music is ducked (sidechain compressed) whenever a
  // bus is making noise. Clip sound: each clip's audio is delayed to where its slide starts. Voice tracks: each is delayed to its start.
  const clipAudio = slides.map((sl, i) => ({ sl, i })).filter(({ sl }) => sl.clip?.hasAudio && sl.clip.volume > 0);
  if (clipAudio.length > 0 || voice.length > 0) {
    let startAt = 0;
    const starts = durations.map((d) => { const s = startAt; startAt += d - td; return s; });
    const parts: string[] = [];
    const loud: string[] = []; // labels of the buses
    const mixOf = (labels: string[], out: string) => parts.push(labels.length === 1 ? `[${labels[0]}]anull[${out}]` : `${labels.map((l) => `[${l}]`).join('')}amix=inputs=${labels.length}:normalize=0:duration=longest[${out}]`);
    if (clipAudio.length > 0) {
      clipAudio.forEach(({ sl, i }) => {
        const ms = Math.round(starts[i] * 1000);
        parts.push(`[${i}:a]aresample=44100,aformat=channel_layouts=stereo,volume=${sl.clip!.volume.toFixed(2)},adelay=${ms}|${ms}[ca${i}]`);
      });
      mixOf(clipAudio.map(({ i }) => `ca${i}`), 'bus');
      loud.push('bus');
    }
    if (voice.length > 0) {
      voice.forEach((v, k) => {
        const ms = Math.max(0, Math.round(v.startSec * 1000));
        parts.push(`[${voiceIdx[k]}:a]aresample=44100,aformat=channel_layouts=stereo,volume=${(v.volume ?? 1).toFixed(2)},adelay=${ms}|${ms}[vo${k}]`);
      });
      mixOf(voice.map((_, k) => `vo${k}`), 'vbus');
      loud.push('vbus');
    }
    if (opts.audio) {
      inputArgs.push(...(opts.audio.loop ? ['-stream_loop', '-1'] : []), '-i', opts.audio.file);
      const mf: string[] = [];
      if (opts.audio.volume !== undefined && Math.abs(opts.audio.volume - 1) > 0.01) mf.push(`volume=${opts.audio.volume.toFixed(2)}`);
      const fade = Math.min(opts.audio.fadeOutSec, total);
      if (fade > 0) mf.push(`afade=t=out:st=${(total - fade).toFixed(3)}:d=${fade.toFixed(3)}`);
      parts.push(`[${audioIdx}:a]${mf.length ? mf.join(',') : 'anull'}[mus]`);
      // each bus is used twice: once to trigger the ducking, once in the final mix
      loud.forEach((l) => parts.push(`[${l}]asplit=2[${l}_sc][${l}_mx]`));
      mixOf(loud.map((l) => `${l}_sc`), 'trig');
      parts.push('[mus][trig]sidechaincompress=threshold=0.03:ratio=10:attack=30:release=600[duck]');
      parts.push(`[duck]${loud.map((l) => `[${l}_mx]`).join('')}amix=inputs=${loud.length + 1}:normalize=0:duration=longest[outa]`);
    } else {
      mixOf(loud, 'outa');
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
    audioArgs.push('-map', `${audioIdx}:a`, '-c:a', 'aac', '-b:a', '192k', ...(filters.length ? ['-af', filters.join(',')] : []), '-t', total.toFixed(3));
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
  /** Playback speed of the clip, 0.25..4 (default 1). */
  speed?: number;
  /** Play the clip backwards. */
  reverse?: boolean;
  /** Hold the last frame (freeze) for this many seconds after the clip, 0..10. */
  holdSec?: number;
  volume?: number;
  collageStyle?: CollageStyle;
  title?: string;
  subtitle?: string;
  /** For 'card': the finished title/credits picture as a data: URL, drawn by the wizard's designer. */
  imageDataUrl?: string;
  /** Overrides the job's seconds-per-slide for this slide (title / credits cards). */
  seconds?: number;
  /** See VideoSlideInput (src/types/index.ts): slow camera movement, a colour look, and a lower-third caption. */
  motion?: VideoMotionName;
  focus?: { x: number; y: number };
  filter?: VideoFilterName;
  caption?: string;
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

export interface VideoVoiceSpec {
  filePath: string;
  /** Where in the video it starts (seconds). */
  startSec: number;
  /** Which part of the file to use. */
  trimStartSec?: number;
  lengthSec?: number | null;
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
  /** Voice-over / extra sound tracks over the video. */
  voice?: VideoVoiceSpec[];
  captionStyle?: VideoCaptionStyle;
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
        const spd = Math.min(4, Math.max(0.25, slide.speed ?? 1));
        const hold = Math.min(10, Math.max(0, slide.holdSec ?? 0));
        const clipOut = path.join(job.tempDir, `clip_${String(i).padStart(4, '0')}.mp4`);
        const withAudio = info.hasAudio && !slide.muted;
        const prep = await runFfmpeg(buildClipPrepArgs(src, clipOut, { width, height, fps: 30, startSec: start, lengthSec: len, withAudio, speed: slide.speed, reverse: slide.reverse, holdSec: hold }), len / spd + hold, undefined, signal);
        if (!prep.success) throw new Error(prep.error || 'clip preparation failed');
        const clipPlan: SlidePlan = { file: clipOut, seconds: len / spd + hold, clip: { hasAudio: withAudio, volume: slide.volume ?? 1 } };
        if (slide.filter && slide.filter !== 'none') clipPlan.filter = slide.filter;
        if (slide.caption?.trim()) {
          clipPlan.captionFile = path.join(job.tempDir, `caption_${String(i).padStart(4, '0')}.png`);
          await renderCaptionPng(slide.caption, width, height, clipPlan.captionFile, job.captionStyle);
        }
        slideFiles.push(clipPlan);
        onProgress?.({ stage: 'preparing', done: i + 1, total: job.slides.length });
        continue;
      }
      // A photo / collage that moves is cut from a larger picture so the zoom does not go soft.
      const motion = (slide.kind === 'photo' || slide.kind === 'collage') && slide.motion && slide.motion !== 'none' ? slide.motion : undefined;
      const pw = motion ? even(width * MOTION_SCALE) : width;
      const ph = motion ? even(height * MOTION_SCALE) : height;
      if (slide.kind === 'card') {
        await prepareCardImage(slide.imageDataUrl || '', outPath, width, height);
      } else if (slide.kind === 'title') {
        await renderTitleSlide(slide.title || '', slide.subtitle, width, height, outPath);
      } else if (slide.kind === 'collage') {
        await renderCollageImage(slide.photoPaths || [], outPath, pw, ph, slide.collageStyle || 'grid');
      } else {
        await prepareSlideImage((slide.photoPaths || [])[0], outPath, pw, ph);
      }
      const plan: SlidePlan = { file: outPath, seconds: slide.seconds };
      if (motion) { plan.motion = motion; plan.focus = slide.focus; }
      if (slide.kind !== 'card' && slide.kind !== 'title') {
        if (slide.filter && slide.filter !== 'none') plan.filter = slide.filter;
        if (slide.caption?.trim()) {
          plan.captionFile = path.join(job.tempDir, `caption_${String(i).padStart(4, '0')}.png`);
          await renderCaptionPng(slide.caption, width, height, plan.captionFile, job.captionStyle);
        }
      }
      slideFiles.push(plan);
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
      voice: job.voice?.filter((v) => v.filePath && fs.existsSync(v.filePath)).map((v) => ({ file: v.filePath, startSec: v.startSec, trimStartSec: v.trimStartSec, lengthSec: v.lengthSec, volume: v.volume })),
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
