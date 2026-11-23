import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import { buildFfmpegArgs, exportVideo, grabVideoFrame, probeMedia, renderCaptionPng } from '../../src/main/services/videoExportService';
import { VIDEO_FILTERS, VIDEO_MOTIONS } from '../../src/types/videoFormat';

const base = { width: 160, height: 90, quality: 'draft' as const, outputPath: 'out.mp4', secondsPerItem: 2, transition: 'none' as const, transitionDurationSec: 0 };
const filterOf = (args: string[]) => args[args.indexOf('-filter_complex') + 1];

describe('buildFfmpegArgs: motion, look and captions', () => {
  it('a plain slide is built exactly as before (no extra inputs or filters)', () => {
    const { args } = buildFfmpegArgs([{ file: 'a.jpg' }, { file: 'b.jpg' }], base);
    expect(filterOf(args)).toContain('[0:v]format=yuv420p,fps=30[v0]');
    expect(args).not.toContain('-framerate');
  });
  it('a moving still gets zoompan at the output rate and an input frame rate to match', () => {
    const { args } = buildFfmpegArgs([{ file: 'a.jpg', motion: 'zoomin' }, { file: 'b.jpg' }], base);
    expect(filterOf(args)).toContain("[0:v]zoompan=z='1+0.2*on/60'");
    expect(args.slice(args.indexOf('-framerate'), args.indexOf('-framerate') + 2)).toEqual(['-framerate', '30']);
  });
  it('"follow the faces" aims at the focus point; pans move across the picture', () => {
    const f = filterOf(buildFfmpegArgs([{ file: 'a.jpg', motion: 'face', focus: { x: 0.8, y: 0.3 } }, { file: 'b.jpg' }], base).args);
    expect(f).toContain("x='(iw-iw/zoom)*0.8':y='(ih-ih/zoom)*0.3'");
    expect(filterOf(buildFfmpegArgs([{ file: 'a.jpg', motion: 'panleft' }, { file: 'b.jpg' }], base).args)).toContain('(1-on/60)');
  });
  it('a look goes before the common format step; a caption is an extra overlay input and music still maps correctly', () => {
    const { args } = buildFfmpegArgs([{ file: 'a.jpg', filter: 'bw', captionFile: 'c.png' }, { file: 'b.jpg' }], { ...base, audio: { file: 'm.wav', loop: false, fadeOutSec: 0 } });
    expect(filterOf(args)).toContain('[0:v]hue=s=0,eq=contrast=1.1,format=yuv420p[b0];[b0][2:v]overlay=0:0');
    expect(args.indexOf('c.png')).toBeGreaterThan(args.indexOf('b.jpg')); // caption input after the slides
    expect(args).toContain('3:a'); // music is input 3: two slides + one caption
  });
});

describe('real ffmpeg: every look and every motion renders; captions and motion show up in the pictures', () => {
  it('renders all looks and motions, with a caption, to a playable video', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp_look_'));
    try {
      const jpg = path.join(dir, 'p.jpg');
      // left half red, right half blue, so a zoom / pan toward one side visibly changes the frame
      const left = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#d03030' } }).jpeg().toBuffer();
      await sharp({ create: { width: 800, height: 300, channels: 3, background: '#3040d0' } }).composite([{ input: left, left: 0, top: 0 }]).jpeg().toFile(jpg);
      const looks = VIDEO_FILTERS.map(([v]) => v);
      const motions = VIDEO_MOTIONS.map(([v]) => v);
      const slides = [
        ...looks.map((filter) => ({ kind: 'photo' as const, photoPaths: [jpg], filter })),
        ...motions.map((motion) => ({ kind: 'photo' as const, photoPaths: [jpg], motion, focus: { x: 0.8, y: 0.5 }, caption: 'Baga Beach, Goa · 14 Mar 2025 · Riya and Aman' })),
      ];
      const out = path.join(dir, 'out.mp4');
      const res = await exportVideo({ slides, aspectRatio: '16:9', resolution: '720p', quality: 'draft', transition: 'none', transitionDurationSec: 0, secondsPerItem: 1, outputPath: out, tempDir: path.join(dir, 'tmp') });
      expect(res.error).toBeUndefined();
      expect(res.success).toBe(true);
      expect(res.skippedSlides).toBe(0);
      expect(res.durationSec).toBeCloseTo(slides.length, 0);
      expect((await probeMedia(out)).hasVideo).toBe(true);
    } finally { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch {} }
  }, 120000);

  it('a zoom-in toward the right side changes the picture over time; the caption PNG has visible pixels', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp_kb_'));
    try {
      const jpg = path.join(dir, 'p.jpg');
      const left = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#d03030' } }).jpeg().toBuffer();
      await sharp({ create: { width: 800, height: 300, channels: 3, background: '#3040d0' } }).composite([{ input: left, left: 0, top: 0 }]).jpeg().toFile(jpg);
      const out = path.join(dir, 'kb.mp4');
      const res = await exportVideo({ slides: [{ kind: 'photo', photoPaths: [jpg], motion: 'zoomin', focus: { x: 0.9, y: 0.5 } }], aspectRatio: '16:9', resolution: '720p', quality: 'draft', transition: 'none', transitionDurationSec: 0, secondsPerItem: 3, outputPath: out, tempDir: path.join(dir, 'tmp') });
      expect(res.success).toBe(true);
      const redShare = async (t: number) => {
        const frame = await grabVideoFrame(out, t);
        const { data, info } = await sharp(frame!).raw().toBuffer({ resolveWithObject: true });
        let red = 0; for (let i = 0; i < data.length; i += info.channels) if (data[i] > 150 && data[i + 2] < 100) red++;
        return red / (data.length / info.channels);
      };
      const early = await redShare(0.1), late = await redShare(2.8);
      expect(early).toBeGreaterThan(0.2);          // the left (red) half is clearly in view at the start
      expect(late).toBeLessThan(early - 0.015);    // zooming toward the right pushes some of the red (left half) out of the frame

      const png = path.join(dir, 'cap.png');
      await renderCaptionPng('Baga Beach, Goa · 14 Mar 2025', 1280, 720, png);
      const { data } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      let opaque = 0; for (let i = 3; i < data.length; i += 4) if (data[i] > 100) opaque++;
      expect(opaque).toBeGreaterThan(2000);        // a band of text, not an empty picture
      expect(opaque).toBeLessThan(1280 * 720 * 0.25);
    } finally { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch {} }
  }, 120000);
});

describe('caption style', () => {
  it('position and colour move and recolour the caption', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp_cs_'));
    try {
      const probe = async (style: any) => {
        const png = path.join(dir, 'c.png');
        await renderCaptionPng('Sunset at the beach', 640, 360, png, style);
        const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        let sumY = 0, n = 0, brightest = [0, 0, 0];
        for (let i = 0; i < data.length; i += 4) if (data[i + 3] > 200) { sumY += Math.floor(i / 4 / info.width); n++; if (data[i] + data[i + 1] + data[i + 2] > brightest[0] + brightest[1] + brightest[2]) brightest = [data[i], data[i + 1], data[i + 2]]; }
        return { y: sumY / n / info.height, brightest };
      };
      const top = await probe({ position: 'top', size: 'medium', color: 'white' });
      const mid = await probe({ position: 'middle', size: 'medium', color: 'white' });
      const bottom = await probe({ position: 'bottom', size: 'medium', color: 'white' });
      expect(top.y).toBeLessThan(0.25);
      expect(mid.y).toBeGreaterThan(0.4); expect(mid.y).toBeLessThan(0.6);
      expect(bottom.y).toBeGreaterThan(0.75);
      const pink = await probe({ position: 'bottom', size: 'medium', color: 'pink' });
      expect(pink.brightest[0]).toBeGreaterThan(pink.brightest[2]); // #ff7eb6: red > blue
      expect(pink.brightest[1]).toBeLessThan(pink.brightest[0]);
    } finally { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch {} }
  });
});

describe('a 9-photo collage renders through sharp', () => {
  it('produces one frame-sized picture with all nine colours present', async () => {
    const { renderCollageImage } = await import('../../src/main/services/videoExportService');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp_c9_'));
    try {
      const colours = ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff', '#00ffff', '#ffffff', '#ff8800', '#8800ff'];
      const files: string[] = [];
      for (const [i, c] of colours.entries()) { const f = path.join(dir, `c${i}.jpg`); await sharp({ create: { width: 300, height: 200, channels: 3, background: c } }).jpeg().toFile(f); files.push(f); }
      const out = path.join(dir, 'collage.jpg');
      await renderCollageImage(files, out, 960, 540, 'grid');
      const meta = await sharp(out).metadata();
      expect([meta.width, meta.height]).toEqual([960, 540]);
      const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
      const seen = new Set<string>();
      for (let i = 0; i < data.length; i += info.channels * 97) seen.add([data[i], data[i + 1], data[i + 2]].map((v) => (v > 127 ? 'H' : 'L')).join('') + (data[i] > 200 && data[i + 1] > 100 && data[i + 1] < 170 ? 'o' : ''));
      expect(seen.size).toBeGreaterThanOrEqual(7); // the nine bright colours collapse to at least 7 distinct hi/lo patterns
    } finally { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch {} }
  });
});
