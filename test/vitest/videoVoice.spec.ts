import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import { buildFfmpegArgs, exportVideo, runFfmpeg, probeMedia } from '../../src/main/services/videoExportService';

const base = { width: 160, height: 90, quality: 'draft' as const, outputPath: 'out.mp4', secondsPerItem: 2, transition: 'none' as const, transitionDurationSec: 0 };
const filterOf = (args: string[]) => args[args.indexOf('-filter_complex') + 1];

describe('voice / extra tracks in the filter graph', () => {
  it('a voice track is delayed to its start, its trim goes on the input, and it gets its own input index before the music', () => {
    const { args } = buildFfmpegArgs([{ file: 'a.jpg' }, { file: 'b.jpg' }], { ...base, voice: [{ file: 'v.wav', startSec: 1.5, trimStartSec: 2, lengthSec: 3, volume: 0.8 }], audio: { file: 'm.wav', loop: true, fadeOutSec: 0 } });
    const f = filterOf(args);
    expect(f).toContain('[2:a]aresample=44100,aformat=channel_layouts=stereo,volume=0.80,adelay=1500|1500[vo0]');
    expect(args.slice(args.indexOf('v.wav') - 5, args.indexOf('v.wav') + 1)).toEqual(['-ss', '2.000', '-t', '3.000', '-i', 'v.wav']);
    expect(f).toContain('[3:a]anull[mus]'); // the music is input 3: two slides + one voice track
    expect(f).toContain('sidechaincompress'); // music ducks under the voice
  });
  it('two voice tracks are mixed on one bus; without music the bus is the sound', () => {
    const { args } = buildFfmpegArgs([{ file: 'a.jpg' }, { file: 'b.jpg' }], { ...base, voice: [{ file: 'v1.wav', startSec: 0 }, { file: 'v2.wav', startSec: 2 }] });
    expect(filterOf(args)).toContain('[vo0][vo1]amix=inputs=2:normalize=0:duration=longest[vbus]');
    expect(filterOf(args)).toContain('[vbus]anull[outa]');
    expect(args).toContain('[outa]');
  });
  it('no voice and no clip sound keeps the plain music-only path', () => {
    const { args } = buildFfmpegArgs([{ file: 'a.jpg' }, { file: 'b.jpg' }], { ...base, audio: { file: 'm.wav', loop: true, fadeOutSec: 1 } });
    expect(filterOf(args)).not.toContain('sidechaincompress');
    expect(args).toContain('-af');
  });
});

describe('real ffmpeg: voice-over with music and clip sound', () => {
  it('mixes music, a voice track and a clip with its own sound into one audio stream of the video\'s length', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp_vo_'));
    try {
      const jpg = path.join(dir, 'p.jpg');
      await sharp({ create: { width: 200, height: 120, channels: 3, background: '#335577' } }).jpeg().toFile(jpg);
      const clip = path.join(dir, 'c.mp4'), music = path.join(dir, 'm.mp3'), voice = path.join(dir, 'v.wav');
      expect((await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=25:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', clip], 0)).success).toBe(true);
      expect((await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=3', music], 0)).success).toBe(true);
      expect((await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=2', voice], 0)).success).toBe(true);
      const out = path.join(dir, 'out.mp4');
      const res = await exportVideo({
        slides: [{ kind: 'photo', photoPaths: [jpg] }, { kind: 'clip', clipPath: clip, trimStartSec: 0, trimEndSec: 3 }, { kind: 'photo', photoPaths: [jpg] }],
        aspectRatio: '16:9', resolution: '720p', quality: 'draft', transition: 'none', transitionDurationSec: 0, secondsPerItem: 2,
        outputPath: out, tempDir: path.join(dir, 'tmp'),
        audio: { filePath: music, startSec: 0, endSec: null, loop: true, fadeOutSec: 1 },
        voice: [{ filePath: voice, startSec: 1, volume: 1 }],
      });
      expect(res.error).toBeUndefined();
      expect(res.success).toBe(true);
      const info = await probeMedia(out);
      expect(info.hasAudio).toBe(true);
      expect(info.durationSec!).toBeGreaterThan(6.5);
      expect(info.durationSec!).toBeLessThan(7.5);
    } finally { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch {} }
  }, 90000);

  it('a voice track on its own over photos (no music, no clips) gives the video sound', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp_vo2_'));
    try {
      const jpg = path.join(dir, 'p.jpg');
      await sharp({ create: { width: 200, height: 120, channels: 3, background: '#553355' } }).jpeg().toFile(jpg);
      const voice = path.join(dir, 'v.wav');
      expect((await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'sine=frequency=500:duration=2', voice], 0)).success).toBe(true);
      const out = path.join(dir, 'out.mp4');
      const res = await exportVideo({ slides: [{ kind: 'photo', photoPaths: [jpg] }, { kind: 'photo', photoPaths: [jpg] }], aspectRatio: '16:9', resolution: '720p', quality: 'draft', transition: 'none', transitionDurationSec: 0, secondsPerItem: 2, outputPath: out, tempDir: path.join(dir, 'tmp'), voice: [{ filePath: voice, startSec: 0.5 }] });
      expect(res.success).toBe(true);
      expect((await probeMedia(out)).hasAudio).toBe(true);
    } finally { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch {} }
  }, 90000);
});
