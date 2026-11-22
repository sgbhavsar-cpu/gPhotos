import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import { buildFfmpegArgs, buildClipPrepArgs, exportVideo, runFfmpeg, probeMedia } from '../../src/main/services/videoExportService';

const base = { width: 160, height: 90, quality: 'draft' as const, outputPath: 'out.mp4', secondsPerItem: 2, transition: 'fade' as const, transitionDurationSec: 0.5 };
const filterOf = (args: string[]) => args[args.indexOf('-filter_complex') + 1];

describe('clips in the filter graph', () => {
  it('a clip input is not looped, and its sound is delayed to where its slide starts', () => {
    const { args, totalDurationSec } = buildFfmpegArgs(
      [{ file: 'a.jpg' }, { file: 'c.mp4', seconds: 4, clip: { hasAudio: true, volume: 1 } }, { file: 'b.jpg' }],
      base
    );
    expect(totalDurationSec).toBeCloseTo(2 + 4 + 2 - 1, 5);
    expect(args.slice(args.indexOf('c.mp4') - 1, args.indexOf('c.mp4') + 1)).toEqual(['-i', 'c.mp4']);
    // slide 1 starts at 2s minus one 0.5s overlap = 1.5s
    expect(filterOf(args)).toContain('[1:a]aresample=44100,aformat=channel_layouts=stereo,volume=1.00,adelay=1500|1500[ca1]');
    expect(args).toContain('[outa]');
  });

  it('with music, the music is ducked under clip sound', () => {
    const { args } = buildFfmpegArgs([{ file: 'c.mp4', seconds: 3, clip: { hasAudio: true, volume: 1 } }, { file: 'a.jpg' }], { ...base, audio: { file: 'm.wav', loop: true, fadeOutSec: 0 } });
    expect(filterOf(args)).toContain('sidechaincompress');
  });

  it('a muted/silent clip adds no audio filters', () => {
    const { args } = buildFfmpegArgs([{ file: 'c.mp4', seconds: 3, clip: { hasAudio: false, volume: 1 } }, { file: 'a.jpg' }], base);
    expect(filterOf(args)).not.toContain('adelay');
    expect(args).not.toContain('-c:a');
  });
});

describe('exportVideo with a real clip', () => {
  it('cuts, fits and joins a clip (with its sound) between two photos', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp_clip_'));
    try {
      const jpg = path.join(dir, 'p.jpg');
      await sharp({ create: { width: 200, height: 120, channels: 3, background: '#335577' } }).jpeg().toFile(jpg);
      const src = path.join(dir, 'src.mp4');
      // 6 s portrait test clip with a tone, so cropping/fit and audio are both exercised
      const gen = await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'testsrc=size=90x160:rate=25:duration=6', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', src], 0);
      expect(gen.success).toBe(true);

      const out = path.join(dir, 'out.mp4');
      const res = await exportVideo({
        slides: [{ kind: 'photo', photoPaths: [jpg] }, { kind: 'clip', clipPath: src, trimStartSec: 1, trimEndSec: 4, muted: false }, { kind: 'photo', photoPaths: [jpg] }],
        aspectRatio: '16:9', resolution: '720p', quality: 'draft', transition: 'fade', transitionDurationSec: 0.5,
        secondsPerItem: 1, outputPath: out, tempDir: path.join(dir, 'tmp'),
      });
      expect(res.error).toBeUndefined();
      expect(res.success).toBe(true);
      expect(res.skippedSlides).toBe(0);
      expect(res.durationSec).toBeCloseTo(1 + 3 + 1 - 1, 1);
      const info = await probeMedia(out);
      expect(info.hasVideo).toBe(true);
      expect(info.hasAudio).toBe(true);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch {}
    }
  }, 60000);

  it('clip sound plus music (ducked) renders through real ffmpeg', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp_clipm_'));
    try {
      const src = path.join(dir, 'src.mp4');
      const music = path.join(dir, 'm.mp3');
      expect((await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=25:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', src], 0)).success).toBe(true);
      expect((await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=2', music], 0)).success).toBe(true);
      const out = path.join(dir, 'out.mp4');
      const res = await exportVideo({
        slides: [{ kind: 'clip', clipPath: src, trimStartSec: 0, trimEndSec: 3 }, { kind: 'clip', clipPath: src, trimStartSec: 0, trimEndSec: 2, muted: true }],
        aspectRatio: '16:9', resolution: '720p', quality: 'draft', transition: 'none', transitionDurationSec: 0, secondsPerItem: 1,
        outputPath: out, tempDir: path.join(dir, 'tmp'), audio: { filePath: music, startSec: 0, endSec: null, loop: true, fadeOutSec: 1 },
      });
      expect(res.error).toBeUndefined();
      expect(res.success).toBe(true);
      expect((await probeMedia(out)).hasAudio).toBe(true);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch {}
    }
  }, 60000);

  it('buildClipPrepArgs drops audio when asked', () => {
    const a = buildClipPrepArgs('in.mp4', 'out.mp4', { width: 160, height: 90, fps: 30, startSec: 0, lengthSec: 2, withAudio: false });
    expect(a).toContain('-an');
    expect(a).not.toContain('0:a:0');
  });
});
