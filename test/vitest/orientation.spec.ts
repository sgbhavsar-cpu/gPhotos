import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import type { OrientationProbe } from '../../src/main/services/faceDetectionEngine';

vi.mock('../../src/main/services/workerSafeLogger', () => ({ logger: { debug() {}, info() {}, warn() {}, error() {} } }));
const probeMock = vi.fn();
vi.mock('../../src/main/services/faceDetectionWorkerClient', () => ({
  probeFaceOrientation: (b: Buffer) => probeMock(b),
  getFaceDetectionPoolSize: () => 2,
}));
const heicMock = vi.fn();
vi.mock('../../src/main/services/heicService', () => ({ getOrGenerateHeicThumbnail500: (p: string) => heicMock(p) }));

import { rotateRgbClockwise } from '../../src/main/services/faceDetectionEngine';
import { decideRotation, detectUprightRotations } from '../../src/main/services/orientationService';

const probe = (s0: number, s90: number, s180: number, s270: number, n = 1): OrientationProbe => ({
  width: 640,
  height: 480,
  scores: { 0: { count: s0 ? n : 0, score: s0 }, 90: { count: s90 ? n : 0, score: s90 }, 180: { count: s180 ? n : 0, score: s180 }, 270: { count: s270 ? n : 0, score: s270 } },
});

describe('rotateRgbClockwise', () => {
  it('matches sharp.rotate for 90/180/270 on a non-square image', async () => {
    const w = 7;
    const h = 5;
    const data = Buffer.alloc(w * h * 3);
    for (let i = 0; i < data.length; i++) data[i] = (i * 37 + 11) & 255;
    for (const r of [0, 90, 180, 270] as const) {
      const mine = rotateRgbClockwise({ data, width: w, height: h }, r);
      const ref = await sharp(data, { raw: { width: w, height: h, channels: 3 } }).rotate(r).raw().toBuffer({ resolveWithObject: true });
      expect([mine.width, mine.height]).toEqual([ref.info.width, ref.info.height]);
      expect(Buffer.compare(mine.data, ref.data)).toBe(0);
    }
  });
});

describe('decideRotation', () => {
  it('no faces anywhere -> unknown', () => {
    expect(decideRotation(probe(0, 0, 0, 0))).toMatchObject({ status: 'unknown', rotation: 0, reason: 'no faces found' });
  });
  it('sub-threshold noise -> unknown', () => {
    expect(decideRotation(probe(0.05, 0.1, 0.02, 0.1)).status).toBe('unknown');
  });
  it('0 degrees clearly best -> upright', () => {
    expect(decideRotation(probe(3, 0.3, 0.2, 0.1, 4))).toMatchObject({ status: 'upright', rotation: 0, faces: 4 });
  });
  it('0 degrees ties for the lead with faces -> upright (no rotation)', () => {
    expect(decideRotation(probe(1, 1, 0, 0)).status).toBe('upright');
  });
  it.each([90, 180, 270] as const)('clear dominance at %i -> rotate', (r) => {
    const s: [number, number, number, number] = [0.1, 0.1, 0.1, 0.1];
    s[[0, 90, 180, 270].indexOf(r)] = 2.5;
    expect(decideRotation(probe(...s, 3))).toMatchObject({ status: 'rotate', rotation: r, faces: 3 });
  });
  it('best non-zero orientation beats 0 by less than 2x -> unknown/ambiguous', () => {
    expect(decideRotation(probe(0.9, 1.4, 0, 0))).toMatchObject({ status: 'unknown', rotation: 0, reason: 'ambiguous face orientation' });
  });
  it('two non-zero orientations close together -> unknown', () => {
    expect(decideRotation(probe(0, 1.5, 1.4, 0)).status).toBe('unknown');
  });
  it('best non-zero orientation with a weak signal -> unknown', () => {
    expect(decideRotation(probe(0.2, 0.3, 0, 0))).toMatchObject({ status: 'unknown', reason: 'weak face signal' });
  });
  it('a single strong face at 180 with a faint 0 hit -> rotate 180', () => {
    expect(decideRotation(probe(0.05, 0, 0.55, 0.02)).status).toBe('rotate');
  });
});

describe('detectUprightRotations', () => {
  let dir: string;
  beforeEach(() => {
    probeMock.mockReset();
    heicMock.mockReset();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orient_'));
  });
  const file = (name: string, content = 'x') => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, content);
    return p;
  };

  it('probes local files and virtual thumbnails, keeps input order, reports progress, never reads the remote original', async () => {
    const local = file('a.jpg', 'local');
    const thumb = file('b.jpg', 'thumb');
    const remote = file('remote.jpg', 'REMOTE-ORIGINAL');
    probeMock.mockImplementation(async (b: Buffer) => (b.toString() === 'local' ? probe(0.1, 2.5, 0.1, 0.1, 2) : probe(3, 0, 0, 0)));
    const progress: Array<[number, number]> = [];
    const res = await detectUprightRotations(
      [
        { id: 'a', filePath: local },
        { id: 'b', filePath: thumb, isVirtual: true, originalRemotePath: remote },
      ],
      (d, t) => progress.push([d, t])
    );
    expect(res.map((r) => [r.id, r.status, r.rotation])).toEqual([['a', 'rotate', 90], ['b', 'upright', 0]]);
    expect(probeMock.mock.calls.map((c) => c[0].toString())).not.toContain('REMOTE-ORIGINAL');
    expect(progress.map((p) => p[0]).sort()).toEqual([1, 2]);
    expect(progress.every((p) => p[1] === 2)).toBe(true);
  });

  it('virtual photo without a local thumbnail -> failed (offline), remote path untouched', async () => {
    const remote = file('remote.jpg');
    const [r] = await detectUprightRotations([{ id: 'v', filePath: path.join(dir, 'missing.jpg'), isVirtual: true, originalRemotePath: remote }]);
    expect(r).toMatchObject({ id: 'v', status: 'failed', reason: 'no local thumbnail (offline)' });
    expect(probeMock).not.toHaveBeenCalled();
  });

  it('a throwing probe fails only that photo', async () => {
    const a = file('a.jpg', 'boom');
    const b = file('b.jpg', 'fine');
    probeMock.mockImplementation(async (buf: Buffer) => {
      if (buf.toString() === 'boom') throw new Error('worker crashed');
      return probe(3, 0, 0, 0);
    });
    const res = await detectUprightRotations([{ id: 'a', filePath: a }, { id: 'b', filePath: b }]);
    expect(res[0]).toMatchObject({ status: 'failed', reason: 'worker crashed' });
    expect(res[1].status).toBe('upright');
  });

  it('HEIC goes through the heic thumbnail helper; null -> failed', async () => {
    const h = file('p.HEIC');
    heicMock.mockResolvedValueOnce(Buffer.from('jpeg')).mockResolvedValueOnce(null);
    probeMock.mockResolvedValue(probe(3, 0, 0, 0));
    const [ok] = await detectUprightRotations([{ id: 'h', filePath: h }]);
    expect(ok.status).toBe('upright');
    const [bad] = await detectUprightRotations([{ id: 'h2', filePath: h }]);
    expect(bad).toMatchObject({ status: 'failed', reason: 'could not decode HEIC' });
  });

  it('limits concurrency to the pool size and tolerates a throwing progress callback', async () => {
    let active = 0;
    let peak = 0;
    probeMock.mockImplementation(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 15));
      active--;
      return probe(3, 0, 0, 0);
    });
    const photos = Array.from({ length: 8 }, (_, i) => ({ id: String(i), filePath: file(`p${i}.jpg`) }));
    const res = await detectUprightRotations(photos, () => {
      throw new Error('ui gone');
    });
    expect(res).toHaveLength(8);
    expect(res.every((r) => r.status === 'upright')).toBe(true);
    expect(peak).toBe(2);
  });

  it('empty input resolves to []', async () => {
    expect(await detectUprightRotations([])).toEqual([]);
  });
});
