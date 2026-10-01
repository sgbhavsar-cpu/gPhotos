import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import {
  buildFfmpegArgs,
  parseFfmpegTimeSeconds,
  parseFfmpegDurationSeconds,
  probeDurationSec,
  exportVideo,
  computeDimensions,
  computeCollageTiles,
  getFfmpegPath,
} from '../../src/main/services/videoExportService';

describe('videoExportService: pure helpers', () => {
  it('computeDimensions matches real platform sizes, not a math-derived guess', () => {
    expect(computeDimensions('16:9', '1080p')).toEqual({ width: 1920, height: 1080 });
    expect(computeDimensions('9:16', '1080p')).toEqual({ width: 1080, height: 1920 }); // NOT 1920x1080 scaled
    expect(computeDimensions('1:1', '720p')).toEqual({ width: 720, height: 720 });
  });

  it('parseFfmpegTimeSeconds / parseFfmpegDurationSeconds read ffmpeg\'s own text formats', () => {
    expect(parseFfmpegTimeSeconds('frame=10 fps=25 time=00:00:03.20 bitrate=...')).toBeCloseTo(3.2, 5);
    expect(parseFfmpegTimeSeconds('no time here')).toBeNull();
    expect(parseFfmpegDurationSeconds('Duration: 00:01:02.50, start: 0.000000, bitrate: 1000 kb/s')).toBeCloseTo(62.5, 5);
    expect(parseFfmpegDurationSeconds('nothing')).toBeNull();
  });

  describe('buildFfmpegArgs', () => {
    const slides = (n: number) => Array.from({ length: n }, (_, i) => ({ file: `slide${i}.jpg` }));

    it('"none" transition (or a single slide) concatenates with hard cuts — total duration is just the sum', () => {
      const { args, totalDurationSec } = buildFfmpegArgs(slides(3), {
        width: 100, height: 100, secondsPerItem: 2, transition: 'none', transitionDurationSec: 0.5, quality: 'good', outputPath: 'out.mp4',
      });
      expect(totalDurationSec).toBeCloseTo(6, 5); // 3 * 2s, no overlap
      const filterArg = args[args.indexOf('-filter_complex') + 1];
      expect(filterArg).toContain('concat=n=3:v=1:a=0[outv]');
      expect(filterArg).not.toContain('xfade');
      expect(args).toContain('out.mp4');
    });

    it('a real transition crossfades and shortens the total by (n-1)*transitionDuration', () => {
      const { args, totalDurationSec } = buildFfmpegArgs(slides(3), {
        width: 100, height: 100, secondsPerItem: 2, transition: 'fade', transitionDurationSec: 0.5, quality: 'good', outputPath: 'out.mp4',
      });
      expect(totalDurationSec).toBeCloseTo(2 + 2 + 2 - 0.5 * 2, 5); // 5s
      const filterArg = args[args.indexOf('-filter_complex') + 1];
      // xfade #1: offset = sum(durations[0..0]) - td*1 = 2 - 0.5 = 1.5
      expect(filterArg).toContain('xfade=transition=fade:duration=0.500:offset=1.500[vx1]');
      // xfade #2: offset = sum(durations[0..1]) - td*2 = 4 - 1.0 = 3.0, final label is [outv]
      expect(filterArg).toContain('xfade=transition=fade:duration=0.500:offset=3.000[outv]');
    });

    it('a single slide never tries to build a transition graph', () => {
      const { args, totalDurationSec } = buildFfmpegArgs(slides(1), {
        width: 100, height: 100, secondsPerItem: 4, transition: 'fade', transitionDurationSec: 0.5, quality: 'good', outputPath: 'out.mp4',
      });
      expect(totalDurationSec).toBeCloseTo(4, 5);
      expect(args[args.indexOf('-filter_complex') + 1]).not.toContain('xfade');
    });

    it('a per-cut transition list gives each xfade its own effect (random / multiple-effects modes)', () => {
      const { args, totalDurationSec } = buildFfmpegArgs(slides(4), {
        width: 100, height: 100, secondsPerItem: 2, transition: ['wipeleft', 'circleopen', 'slideup'], transitionDurationSec: 0.5, quality: 'good', outputPath: 'out.mp4',
      });
      const filterArg = args[args.indexOf('-filter_complex') + 1];
      expect(filterArg).toContain('xfade=transition=wipeleft:');
      expect(filterArg).toContain('xfade=transition=circleopen:');
      expect(filterArg).toContain('xfade=transition=slideup:');
      expect(totalDurationSec).toBeCloseTo(4 * 2 - 0.5 * 3, 5); // same duration maths as a single transition
    });

    it('a stray "none" inside a per-cut list becomes a fade rather than breaking the xfade chain', () => {
      const { args } = buildFfmpegArgs(slides(3), {
        width: 100, height: 100, secondsPerItem: 2, transition: ['none', 'wipeleft'], transitionDurationSec: 0.5, quality: 'good', outputPath: 'out.mp4',
      });
      const filterArg = args[args.indexOf('-filter_complex') + 1];
      expect(filterArg).toContain('xfade=transition=fade:');
      expect(filterArg).toContain('xfade=transition=wipeleft:');
    });

    it('quality maps to a sane CRF/preset, and throws with no slides', () => {
      const draft = buildFfmpegArgs(slides(1), { width: 10, height: 10, secondsPerItem: 1, transition: 'none', transitionDurationSec: 0, quality: 'draft', outputPath: 'o.mp4' });
      const best = buildFfmpegArgs(slides(1), { width: 10, height: 10, secondsPerItem: 1, transition: 'none', transitionDurationSec: 0, quality: 'best', outputPath: 'o.mp4' });
      expect(draft.args).toContain('30'); // draft CRF
      expect(best.args).toContain('18'); // best CRF
      expect(() => buildFfmpegArgs([], { width: 10, height: 10, secondsPerItem: 1, transition: 'none', transitionDurationSec: 0, quality: 'good', outputPath: 'o.mp4' })).toThrow();
    });
  });
});

describe('videoExportService: collage layouts', () => {
  const inside = (tiles: Array<{ x: number; y: number; w: number; h: number }>, w: number, h: number) =>
    tiles.every((t) => t.x >= 0 && t.y >= 0 && t.x + t.w <= w && t.y + t.h <= h && t.w > 0 && t.h > 0);
  const overlaps = (a: any, b: any) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

  it.each(['grid', 'sideBySide', 'stacked', 'featured'] as const)('%s: 2-4 photos always fit inside the frame without overlapping', (style) => {
    for (const [w, h] of [[1920, 1080], [1080, 1920], [1080, 1080]]) {
      for (const n of [2, 3, 4]) {
        const tiles = computeCollageTiles(n, style, w, h);
        expect(tiles).toHaveLength(n);
        expect(inside(tiles, w, h)).toBe(true);
        for (let i = 0; i < tiles.length; i++) for (let j = i + 1; j < tiles.length; j++) expect(overlaps(tiles[i], tiles[j])).toBe(false);
      }
    }
  });

  it('a single photo is always the whole frame, whatever the style', () => {
    expect(computeCollageTiles(1, 'featured', 640, 360)).toEqual([{ x: 0, y: 0, w: 640, h: 360 }]);
  });

  it('sideBySide makes N full-height columns; stacked makes N full-width rows', () => {
    const cols = computeCollageTiles(3, 'sideBySide', 1000, 500);
    expect(cols.every((t) => t.h === 500 && t.y === 0)).toBe(true);
    expect(cols.map((t) => t.x)).toEqual([...cols.map((t) => t.x)].sort((a, b) => a - b));
    const rows = computeCollageTiles(3, 'stacked', 500, 1000);
    expect(rows.every((t) => t.w === 500 && t.x === 0)).toBe(true);
  });

  it('featured puts the first photo big on top and the rest in a strip below it', () => {
    const [big, ...small] = computeCollageTiles(4, 'featured', 1000, 1000);
    expect(big.w).toBe(1000);
    expect(big.h).toBeGreaterThan(small[0].h * 1.5);
    expect(small).toHaveLength(3);
    expect(small.every((t) => t.y === small[0].y && t.y >= big.h)).toBe(true);
  });
});

describe('videoExportService: real ffmpeg integration (uses the bundled binary — no mocks)', () => {
  let dir: string;
  const photo = (name: string, color: { r: number; g: number; b: number }) => {
    const p = path.join(dir, name);
    return sharp({ create: { width: 60, height: 60, channels: 3, background: color } }).jpeg().toFile(p).then(() => p);
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gphotos_video_test_'));
  });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  it('the bundled ffmpeg binary actually runs', async () => {
    expect(fs.existsSync(getFfmpegPath())).toBe(true);
  });

  it('renders photos + a collage + a title slide into a real playable mp4 of roughly the right duration', async () => {
    const red = await photo('red.jpg', { r: 255, g: 0, b: 0 });
    const green = await photo('green.jpg', { r: 0, g: 255, b: 0 });
    const blue = await photo('blue.jpg', { r: 0, g: 0, b: 255 });
    const outputPath = path.join(dir, 'out.mp4');

    const result = await exportVideo({
      slides: [
        { kind: 'title', title: 'Our Trip', subtitle: '2026' },
        { kind: 'photo', photoPaths: [red] },
        { kind: 'collage', photoPaths: [green, blue] },
      ],
      aspectRatio: '1:1',
      resolution: '720p',
      quality: 'draft', // fast preset — this is a test, not a real export
      transition: 'fade',
      transitionDurationSec: 0.2,
      secondsPerItem: 1,
      outputPath,
      tempDir: path.join(dir, 'work'),
    });

    expect(result).toMatchObject({ success: true, skippedSlides: 0, outputPath });
    expect(fs.existsSync(outputPath)).toBe(true);
    expect(fs.statSync(outputPath).size).toBeGreaterThan(1000);

    const probed = await probeDurationSec(outputPath);
    expect(probed).not.toBeNull();
    expect(probed!).toBeCloseTo(result.durationSec!, 0); // within ~1s of the computed plan

    // The temp working directory (generated slide images) is cleaned up afterwards.
    expect(fs.existsSync(path.join(dir, 'work'))).toBe(false);
  }, 30000);

  it('renders a styled collage with a per-cut transition list, creating a missing output folder', async () => {
    const red = await photo('r.jpg', { r: 255, g: 0, b: 0 });
    const green = await photo('g.jpg', { r: 0, g: 255, b: 0 });
    const blue = await photo('b.jpg', { r: 0, g: 0, b: 255 });
    const outputPath = path.join(dir, 'videos', 'nested', 'styled.mp4'); // neither folder exists yet

    const result = await exportVideo({
      slides: [
        { kind: 'collage', photoPaths: [red, green, blue], collageStyle: 'featured' },
        { kind: 'collage', photoPaths: [red, green], collageStyle: 'sideBySide' },
        { kind: 'photo', photoPaths: [blue] },
      ],
      aspectRatio: '9:16', resolution: '720p', quality: 'draft',
      transition: ['wipeleft', 'circleopen'], transitionDurationSec: 0.2, secondsPerItem: 1,
      outputPath, tempDir: path.join(dir, 'work4'),
    });

    expect(result).toMatchObject({ success: true, skippedSlides: 0 });
    expect(fs.existsSync(outputPath)).toBe(true);
    expect(await probeDurationSec(outputPath)).toBeGreaterThan(1.5);
  }, 30000);

  it('a photo that cannot be read is skipped, and the rest of the video still renders', async () => {
    const red = await photo('red.jpg', { r: 255, g: 0, b: 0 });
    const outputPath = path.join(dir, 'out2.mp4');

    const result = await exportVideo({
      slides: [
        { kind: 'photo', photoPaths: [red] },
        { kind: 'photo', photoPaths: [path.join(dir, 'does-not-exist.jpg')] },
        { kind: 'photo', photoPaths: [red] },
      ],
      aspectRatio: '1:1',
      resolution: '720p',
      quality: 'draft',
      transition: 'none',
      transitionDurationSec: 0,
      secondsPerItem: 1,
      outputPath,
      tempDir: path.join(dir, 'work2'),
    });

    expect(result).toMatchObject({ success: true, skippedSlides: 1 });
    expect(fs.existsSync(outputPath)).toBe(true);
  }, 30000);

  it('every photo failing to read is reported, not silently rendered as an empty video', async () => {
    const outputPath = path.join(dir, 'out3.mp4');
    const result = await exportVideo({
      slides: [{ kind: 'photo', photoPaths: [path.join(dir, 'nope.jpg')] }],
      aspectRatio: '1:1', resolution: '720p', quality: 'draft', transition: 'none', transitionDurationSec: 0,
      secondsPerItem: 1, outputPath, tempDir: path.join(dir, 'work3'),
    });
    expect(result.success).toBe(false);
    expect(result.skippedSlides).toBe(1);
    expect(fs.existsSync(outputPath)).toBe(false);
  }, 15000);
});
