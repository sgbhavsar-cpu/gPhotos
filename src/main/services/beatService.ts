// Tempo and first-beat detection for "cut on the beat": decode the music to mono PCM with the bundled ffmpeg, build an
// onset-strength envelope (how fast the energy rises), and find the repeat interval with an autocorrelation. Pure DSP in
// estimateTempo so it can be tested on a synthetic click track.
import { spawn } from 'child_process';
import { getFfmpegPath } from './videoExportService';

export interface BeatInfo {
  /** Beats per minute, 70..180. */
  bpm: number;
  /** Where the first strong beat falls, in seconds from the start of the analysed audio. */
  firstBeatSec: number;
}

const SAMPLE_RATE = 11025;
const FRAME = 256; // ~23 ms per envelope step
const HOP_SEC = FRAME / SAMPLE_RATE;
const MIN_BPM = 70;
const MAX_BPM = 180;

/** Onset-strength envelope of mono samples: positive rises of the log energy, one value per FRAME samples. */
export function onsetEnvelope(samples: Int16Array | Float32Array): Float32Array {
  const frames = Math.floor(samples.length / FRAME);
  const env = new Float32Array(frames);
  let prev = 0;
  for (let f = 0; f < frames; f++) {
    let e = 0;
    for (let i = f * FRAME; i < (f + 1) * FRAME; i++) { const v = samples[i] / (samples instanceof Int16Array ? 32768 : 1); e += v * v; }
    const logE = Math.log(1 + 1000 * (e / FRAME));
    env[f] = f === 0 ? 0 : Math.max(0, logE - prev);
    prev = logE;
  }
  return env;
}

/** Tempo and first beat from an onset envelope (one value per HOP_SEC). null when there is no usable rhythm. */
export function estimateTempo(env: Float32Array): BeatInfo | null {
  const n = env.length;
  const lagMin = Math.floor(60 / MAX_BPM / HOP_SEC);
  const lagMax = Math.ceil(60 / MIN_BPM / HOP_SEC);
  if (n < lagMax * 3) return null;
  let total = 0;
  for (let i = 0; i < n; i++) total += env[i];
  if (total < 1e-6) return null;

  // A beat rarely falls on a whole number of envelope frames, so the repeat interval is searched on a quarter-frame grid,
  // reading the (lightly smoothed) envelope with linear interpolation.
  const sm = new Float32Array(n);
  for (let i = 0; i < n; i++) sm[i] = 0.25 * (env[i - 1] ?? 0) + 0.5 * env[i] + 0.25 * (env[i + 1] ?? 0);
  const at = (x: number) => { const i = Math.floor(x); const f = x - i; return (sm[i] ?? 0) * (1 - f) + (sm[i + 1] ?? 0) * f; };
  const score = (lag: number) => {
    let s = 0;
    for (let i = 0; i + lag < n - 1; i++) s += sm[i] * at(i + lag);
    return s / (n - lag);
  };
  let best = -1, lag = 0;
  for (let l = lagMin; l <= lagMax; l += 0.25) {
    const bpm = 60 / (l * HOP_SEC);
    // A mild preference for the tempi people actually tap (around 120), so half / double time is not picked by accident.
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.8, 2));
    const sc = score(l) * (0.6 + 0.4 * prior);
    if (sc > best) { best = sc; lag = l; }
  }
  if (best <= 0) return null;

  // The coarse interval can be a couple of percent off, which would drift by a whole beat within a minute. Refine it
  // (and find the phase) by laying a beat grid over the whole envelope and keeping the interval / offset that collects
  // the most onset strength.
  let bestSum = -1, bestPhase = 0, bestLag = lag;
  for (let l = lag * 0.97; l <= lag * 1.03; l += lag * 0.0005) {
    for (let phase = 0; phase < l; phase += 0.5) {
      let sum = 0;
      for (let t = phase; t < n - 1; t += l) sum += at(t);
      if (sum > bestSum) { bestSum = sum; bestPhase = phase; bestLag = l; }
    }
  }
  return { bpm: Math.round((60 / (bestLag * HOP_SEC)) * 10) / 10, firstBeatSec: Math.round(bestPhase * HOP_SEC * 1000) / 1000 };
}

/** Analyses up to `maxSeconds` of `filePath` starting at `startSec`. null if the file has no readable audio or no rhythm. */
export function analyzeBeats(filePath: string, startSec = 0, maxSeconds = 60): Promise<BeatInfo | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const proc = spawn(getFfmpegPath(), ['-v', 'error', '-ss', Math.max(0, startSec).toFixed(3), '-t', String(maxSeconds), '-i', filePath, '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', 'pipe:1'], { windowsHide: true });
    proc.stdout.on('data', (d) => chunks.push(d));
    proc.on('error', () => resolve(null));
    proc.on('close', () => {
      const buf = Buffer.concat(chunks);
      if (buf.length < SAMPLE_RATE * 2 * 4) return resolve(null);
      const samples = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2));
      resolve(estimateTempo(onsetEnvelope(samples)));
    });
  });
}
