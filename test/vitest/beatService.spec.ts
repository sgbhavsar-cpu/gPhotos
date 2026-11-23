import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { estimateTempo, onsetEnvelope, analyzeBeats } from '../../src/main/services/beatService';
import { runFfmpeg } from '../../src/main/services/videoExportService';

/** A click every `periodSec`, starting at `offsetSec`, as 11025 Hz mono samples. */
function clickTrack(bpm: number, seconds: number, offsetSec: number): Int16Array {
  const sr = 11025, out = new Int16Array(sr * seconds), period = (60 / bpm) * sr;
  for (let t = offsetSec * sr; t < out.length; t += period) for (let i = 0; i < 220; i++) { const k = Math.floor(t) + i; if (k < out.length) out[k] = Math.round(20000 * Math.sin(i * 0.5) * (1 - i / 220)); }
  return out;
}

describe('estimateTempo on synthetic click tracks', () => {
  it.each([90, 100, 120, 128, 140, 160])('finds %i BPM within 0.5%', (bpm) => {
    const r = estimateTempo(onsetEnvelope(clickTrack(bpm, 30, 0.3)));
    expect(r).not.toBeNull();
    expect(Math.abs(r!.bpm - bpm) / bpm).toBeLessThan(0.005);
  });
  it('finds where the first beat falls (clicks every 0.5 s starting at 0.3 s)', () => {
    const r = estimateTempo(onsetEnvelope(clickTrack(120, 30, 0.3)))!;
    expect(Math.abs(r.firstBeatSec - 0.3)).toBeLessThan(0.06);
  });
  it('returns null for silence and for audio that is too short', () => {
    expect(estimateTempo(onsetEnvelope(new Int16Array(11025 * 30)))).toBeNull();
    expect(estimateTempo(onsetEnvelope(new Int16Array(11025)))).toBeNull();
  });
});

describe('analyzeBeats on a real file (decoded by ffmpeg)', () => {
  it('reads the tempo of a 120 BPM click file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp_beat_'));
    try {
      const f = path.join(dir, 'clicks.wav');
      expect((await runFfmpeg(['-y', '-f', 'lavfi', '-i', "aevalsrc='sin(2*PI*1200*t)*lt(mod(t,0.5),0.03)':s=44100:d=20", f], 0)).success).toBe(true);
      const r = await analyzeBeats(f, 0, 20);
      expect(r).not.toBeNull();
      expect(Math.abs(r!.bpm - 120)).toBeLessThan(3);
      expect(await analyzeBeats(path.join(dir, 'missing.wav'))).toBeNull();
    } finally { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch {} }
  }, 60000);
});
