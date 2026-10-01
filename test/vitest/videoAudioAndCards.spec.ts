import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import sharp from 'sharp';
import { buildFfmpegArgs, exportVideo, getFfmpegPath, probeMedia } from '../../src/main/services/videoExportService';

const base = { width: 100, height: 100, quality: 'good' as const, outputPath: 'out.mp4' };
const slides = (n: number, seconds?: Array<number | undefined>) => Array.from({ length: n }, (_, i) => ({ file: `s${i}.jpg`, seconds: seconds?.[i] }));
const filterOf = (args: string[]) => args[args.indexOf('-filter_complex') + 1];

describe('buildFfmpegArgs: per-slide durations', () => {
  it('a slide with its own seconds (a title/credits card) overrides the default, and the total follows', () => {
    const { args, totalDurationSec } = buildFfmpegArgs(slides(3, [4, undefined, 5]), {
      ...base, secondsPerItem: 2, transition: 'none', transitionDurationSec: 0,
    });
    expect(totalDurationSec).toBeCloseTo(11, 5);
    const inputs = args.reduce<string[]>((acc, a, i) => (a === '-t' ? [...acc, args[i + 1]] : acc), []);
    expect(inputs).toEqual(['4.000', '2.000', '5.000']);
  });

  it('crossfade offsets use each slide\'s real length', () => {
    const { args, totalDurationSec } = buildFfmpegArgs(slides(3, [4, 2, 5]), {
      ...base, secondsPerItem: 2, transition: 'fade', transitionDurationSec: 1,
    });
    expect(totalDurationSec).toBeCloseTo(4 + 2 + 5 - 2, 5);
    expect(filterOf(args)).toContain('offset=3.000[vx1]'); // 4 - 1
    expect(filterOf(args)).toContain('offset=4.000[outv]'); // (4+2) - 2
  });
});

describe('buildFfmpegArgs: music', () => {
  const opts = { ...base, secondsPerItem: 3, transition: 'none' as const, transitionDurationSec: 0 };

  it('a looped clip becomes an infinite-loop input, mapped after the images and cut at the video length with a fade-out', () => {
    const { args, totalDurationSec } = buildFfmpegArgs(slides(2), { ...opts, audio: { file: 'clip.wav', loop: true, fadeOutSec: 2 } });
    const iAudio = args.lastIndexOf('-i');
    expect(args.slice(iAudio - 2, iAudio + 2)).toEqual(['-stream_loop', '-1', '-i', 'clip.wav']);
    expect(args).toContain('-map');
    expect(args[args.indexOf('2:a') - 1]).toBe('-map'); // slides are inputs 0 and 1, so the music is input 2
    expect(args[args.indexOf('-t', iAudio) + 1]).toBe(totalDurationSec.toFixed(3));
    expect(args).toContain('afade=t=out:st=4.000:d=2.000'); // 6s video: fade the last 2s
  });

  it('without loop there is no -stream_loop, and no fade / volume filter unless asked for', () => {
    const { args } = buildFfmpegArgs(slides(2), { ...opts, audio: { file: 'clip.wav', loop: false, fadeOutSec: 0 } });
    expect(args).not.toContain('-stream_loop');
    expect(args).not.toContain('-af');
  });

  it('volume becomes a volume filter; a fade longer than the video is clamped to it', () => {
    const { args } = buildFfmpegArgs(slides(1), { ...opts, audio: { file: 'c.wav', loop: true, fadeOutSec: 30, volume: 0.5 } });
    const af = args[args.indexOf('-af') + 1];
    expect(af).toContain('volume=0.50');
    expect(af).toContain('afade=t=out:st=0.000:d=3.000');
  });

  it('no audio → no audio mapping at all (unchanged behaviour)', () => {
    const { args } = buildFfmpegArgs(slides(2), opts);
    expect(args).not.toContain('-c:a');
    expect(args.filter((a) => a === '-map')).toHaveLength(1);
  });
});

describe('exportVideo: cards and music, through the real bundled ffmpeg', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gphotos_vid_audio_')); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  const photo = async (name: string, c: { r: number; g: number; b: number }) => {
    const p = path.join(dir, name);
    await sharp({ create: { width: 60, height: 60, channels: 3, background: c } }).jpeg().toFile(p);
    return p;
  };
  /** A real 3-second 440 Hz tone, made by ffmpeg itself. */
  const tone = (seconds = 3) => new Promise<string>((resolve, reject) => {
    const out = path.join(dir, 'tone.wav');
    const proc = spawn(getFfmpegPath(), ['-y', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, '-c:a', 'pcm_s16le', out], { windowsHide: true });
    proc.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error('tone failed'))));
  });
  const job = (extra: any) => ({
    aspectRatio: '1:1' as const, resolution: '720p' as const, quality: 'draft' as const,
    transition: 'none' as const, transitionDurationSec: 0, secondsPerItem: 1,
    outputPath: path.join(dir, 'out.mp4'), tempDir: path.join(dir, 'work'), ...extra,
  });

  it('a designer card (data: URL) becomes a slide with its own length, and the video has that duration', async () => {
    const red = await photo('r.jpg', { r: 255, g: 0, b: 0 });
    const png = await sharp({ create: { width: 200, height: 100, channels: 3, background: { r: 10, g: 20, b: 200 } } }).png().toBuffer();
    const result = await exportVideo(job({
      slides: [
        { kind: 'card', imageDataUrl: 'data:image/png;base64,' + png.toString('base64'), seconds: 2 }, // wrong size on purpose — must be fitted
        { kind: 'photo', photoPaths: [red] },
      ],
    }));
    expect(result).toMatchObject({ success: true, skippedSlides: 0 });
    expect(result.durationSec).toBeCloseTo(3, 1); // 2s card + 1s photo
    const info = await probeMedia(result.outputPath!);
    expect(info.hasVideo).toBe(true);
    expect(info.durationSec!).toBeCloseTo(3, 0);
  }, 30000);

  it('a card that is not a picture is skipped and reported, not fatal', async () => {
    const red = await photo('r.jpg', { r: 255, g: 0, b: 0 });
    const result = await exportVideo(job({
      slides: [{ kind: 'card', imageDataUrl: 'data:text/plain;base64,aGk=' }, { kind: 'photo', photoPaths: [red] }],
    }));
    expect(result).toMatchObject({ success: true, skippedSlides: 1 });
  }, 30000);

  it('music is trimmed, looped to fill the video, and mixed in: the output has an audio stream as long as the video', async () => {
    const [a, b, c] = await Promise.all([photo('a.jpg', { r: 255, g: 0, b: 0 }), photo('b.jpg', { r: 0, g: 255, b: 0 }), photo('c.jpg', { r: 0, g: 0, b: 255 })]);
    const music = await tone(3);
    const result = await exportVideo(job({
      slides: [a, b, c].map((p) => ({ kind: 'photo', photoPaths: [p] })), // 3 x 1s = 3s
      audio: { filePath: music, startSec: 0.5, endSec: 1.5, loop: true, fadeOutSec: 0.5 }, // a 1s clip, repeated
    }));
    expect(result).toMatchObject({ success: true });
    const info = await probeMedia(result.outputPath!);
    expect(info.hasAudio).toBe(true);
    expect(info.durationSec!).toBeCloseTo(3, 0);
  }, 30000);

  it('a clip shorter than the video without looping still gives a full-length video (music just ends early)', async () => {
    const [a, b, c] = await Promise.all([photo('a.jpg', { r: 255, g: 0, b: 0 }), photo('b.jpg', { r: 0, g: 255, b: 0 }), photo('c.jpg', { r: 0, g: 0, b: 255 })]);
    const music = await tone(3);
    const result = await exportVideo(job({
      slides: [a, b, c].map((p) => ({ kind: 'photo', photoPaths: [p] })),
      audio: { filePath: music, startSec: 0, endSec: 1, loop: false, fadeOutSec: 0 },
    }));
    expect(result.success).toBe(true);
    const info = await probeMedia(result.outputPath!);
    expect(info.hasAudio).toBe(true);
    expect(info.durationSec!).toBeGreaterThan(2.5); // NOT cut down to the 1s of music
  }, 30000);

  it('music longer than the video is cut at the video length', async () => {
    const a = await photo('a.jpg', { r: 255, g: 0, b: 0 });
    const music = await tone(3);
    const result = await exportVideo(job({
      slides: [{ kind: 'photo', photoPaths: [a] }], // 1s video, 3s of music
      audio: { filePath: music, startSec: 0, endSec: null, loop: false, fadeOutSec: 0 },
    }));
    expect(result.success).toBe(true);
    expect((await probeMedia(result.outputPath!)).durationSec!).toBeLessThan(1.6);
  }, 30000);

  it('a file with no usable audio fails clearly instead of silently exporting without the music', async () => {
    const a = await photo('a.jpg', { r: 255, g: 0, b: 0 });
    const notAudio = path.join(dir, 'notes.txt');
    fs.writeFileSync(notAudio, 'not music');
    const result = await exportVideo(job({
      slides: [{ kind: 'photo', photoPaths: [a] }],
      audio: { filePath: notAudio, startSec: 0, endSec: null, loop: true, fadeOutSec: 0 },
    }));
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Could not use the chosen music/);
    expect(fs.existsSync(path.join(dir, 'out.mp4'))).toBe(false);
  }, 30000);
});
