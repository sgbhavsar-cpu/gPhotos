import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  configureHeicWorker,
  decodeHeicToJpeg,
  getHeicWorkerStats,
} from '../../src/main/services/heicWorkerClient';

// No real HEVC HEIC exists in the repo (and sharp can't encode one), so the
// pool / limiter / timeout / crash-recovery logic is exercised against a fake
// worker script. The real heicWorker.ts is smoke-tested with an invalid file.

let dir: string;
let fakeWorker: string;

const job = (o: { op?: 'echo' | 'crash' | 'hang' | 'throw' | 'busy'; ms?: number; tag?: string }) => Buffer.from(JSON.stringify(o));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heicworker_spec_'));
  fakeWorker = path.join(dir, 'fakeWorker.js');
  fs.writeFileSync(
    fakeWorker,
    `const { parentPort } = require('worker_threads');
parentPort.postMessage({ ready: true });
parentPort.on('message', (msg) => {
  const req = JSON.parse(Buffer.from(msg.buffer).toString());
  const done = () => {
    if (req.op === 'crash') process.exit(3);
    if (req.op === 'hang') { for (;;) {} }
    if (req.op === 'busy') { const end = Date.now() + req.ms; while (Date.now() < end) {} }
    if (req.op === 'throw') return parentPort.postMessage({ id: msg.id, error: 'boom' });
    const out = new Uint8Array(Buffer.from(String(req.tag) + ':' + msg.quality));
    parentPort.postMessage({ id: msg.id, result: out }, [out.buffer]);
  };
  if (req.op === 'busy') done(); else setTimeout(done, req.ms || 0);
});
`
  );
});

afterEach(() => configureHeicWorker({ workerPath: fakeWorker, timeoutMs: 120000, idleMs: 60000, poolSize: 1 }));
afterAll(() => {
  configureHeicWorker({});
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('heicWorkerClient (fake worker)', () => {
  it('round-trips a buffer through the worker and passes quality', async () => {
    configureHeicWorker({ workerPath: fakeWorker });
    const out = await decodeHeicToJpeg(job({ tag: 'hello' }), 0.9, 'low');
    expect(Buffer.isBuffer(out)).toBe(true);
    expect(out.toString()).toBe('hello:0.9');
  });

  it('runs one decode at a time; high priority overtakes queued low, FIFO within a class', async () => {
    configureHeicWorker({ workerPath: fakeWorker });
    const order: string[] = [];
    const run = (tag: string, p: 'high' | 'low', ms = 0) =>
      decodeHeicToJpeg(job({ tag, ms }), 0.9, p).then(() => order.push(tag));
    const all = [run('blocker', 'low', 150)];
    await sleep(30); // blocker is now in flight
    all.push(run('L1', 'low'), run('L2', 'low'), run('H1', 'high'), run('H2', 'high'));
    expect(getHeicWorkerStats().busy).toBe(1);
    await Promise.all(all);
    expect(order).toEqual(['blocker', 'H1', 'H2', 'L1', 'L2']);
  });

  it('a flood of high-priority jobs cannot starve a low job forever', async () => {
    configureHeicWorker({ workerPath: fakeWorker });
    const order: string[] = [];
    const run = (tag: string, p: 'high' | 'low', ms = 0) =>
      decodeHeicToJpeg(job({ tag, ms }), 0.9, p).then(() => order.push(tag));
    const all = [run('blocker', 'low', 100)];
    await sleep(30);
    all.push(run('LOW', 'low'));
    for (let i = 0; i < 12; i++) all.push(run(`H${i}`, 'high'));
    await Promise.all(all);
    const idx = order.indexOf('LOW');
    expect(idx).toBeGreaterThan(1); // still behind the first highs...
    expect(idx).toBeLessThanOrEqual(9); // ...but served after at most 8 of them (blocker + 8 highs)
  });

  it('a decode error rejects only that request', async () => {
    configureHeicWorker({ workerPath: fakeWorker });
    const bad = decodeHeicToJpeg(job({ op: 'throw' }), 0.9);
    const good = decodeHeicToJpeg(job({ tag: 'ok' }), 0.9);
    await expect(bad).rejects.toThrow('boom');
    expect((await good).toString()).toBe('ok:0.9');
  });

  it('worker crash fails only the running request; queued work runs on a lazily respawned worker', async () => {
    configureHeicWorker({ workerPath: fakeWorker });
    const crashing = decodeHeicToJpeg(job({ op: 'crash' }), 0.9);
    const queued = decodeHeicToJpeg(job({ tag: 'after-crash' }), 0.9);
    await expect(crashing).rejects.toThrow(/exited with code 3/);
    expect((await queued).toString()).toBe('after-crash:0.9');
    expect(getHeicWorkerStats().broken).toBe(false);
  });

  it('a wedged worker is terminated on timeout and the pool recovers', async () => {
    // The same timeout also bounds the replacement worker's boot + decode below, which can take well over
    // a second when the whole suite runs in parallel, so it must not be too tight.
    configureHeicWorker({ workerPath: fakeWorker, timeoutMs: 3000 });
    const t0 = Date.now();
    await expect(decodeHeicToJpeg(job({ op: 'hang' }), 0.9)).rejects.toThrow(/timed out/);
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect((await decodeHeicToJpeg(job({ tag: 'alive' }), 0.9)).toString()).toBe('alive:0.9');
  });

  it('idle workers are terminated and respawn on demand', async () => {
    configureHeicWorker({ workerPath: fakeWorker, idleMs: 150 });
    await decodeHeicToJpeg(job({ tag: 'a' }), 0.9);
    expect(getHeicWorkerStats().workers).toBe(1);
    await sleep(500);
    expect(getHeicWorkerStats().workers).toBe(0);
    expect((await decodeHeicToJpeg(job({ tag: 'b' }), 0.9)).toString()).toBe('b:0.9');
  });

  it('pool size 2 runs two decodes concurrently, never more', async () => {
    configureHeicWorker({ workerPath: fakeWorker, poolSize: 5 }); // clamped to 2
    const ps = [1, 2, 3].map((i) => decodeHeicToJpeg(job({ tag: `t${i}`, ms: 200 }), 0.9));
    await sleep(80);
    expect(getHeicWorkerStats().busy).toBe(2);
    expect(getHeicWorkerStats().queuedLow).toBe(1);
    await Promise.all(ps);
  });

  it('falls back to the in-process path when the worker cannot start', async () => {
    configureHeicWorker({ workerPath: path.join(dir, 'does-not-exist.js') });
    // invalid HEIC data: the rejection must come from heic-convert itself (in-process), not from the pool
    await expect(decodeHeicToJpeg(Buffer.from('not a heic file'), 0.9)).rejects.toThrow();
    expect(getHeicWorkerStats().broken).toBe(true);
    await expect(decodeHeicToJpeg(Buffer.from('still not a heic'), 0.9)).rejects.toThrow(); // broken => straight to in-process
  });
});

describe('main-thread responsiveness', () => {
  // Stand-in for a multi-second synchronous libheif decode: a 1s CPU-bound loop.
  const measureLag = async (work: () => Promise<unknown>) => {
    let last = Date.now();
    let maxLag = 0;
    const t = setInterval(() => {
      const now = Date.now();
      maxLag = Math.max(maxLag, now - last - 10);
      last = now;
    }, 10);
    await work();
    await sleep(30); // let a blocked timer tick land
    clearInterval(t);
    return maxLag;
  };

  it('a busy decode on the worker leaves the main event loop responsive (vs. blocked in-process)', async () => {
    configureHeicWorker({ workerPath: fakeWorker });
    const inProcess = await measureLag(async () => {
      await sleep(30);
      const end = Date.now() + 1000;
      while (Date.now() < end) {} // what heic-convert did on the main thread
    });
    const viaWorker = await measureLag(() => decodeHeicToJpeg(job({ op: 'busy', ms: 1000 }), 0.9));
    console.log(`[heic responsiveness] max event-loop lag: in-process ${inProcess}ms, worker ${viaWorker}ms`);
    expect(inProcess).toBeGreaterThan(800);
    expect(viaWorker).toBeLessThan(250);
  });
});

describe('heicWorker.ts (real worker)', () => {
  it('loads under tsx, rejects an invalid HEIC without crashing, and stays usable', async () => {
    configureHeicWorker({}); // default: heicWorker.ts through tsx
    await expect(decodeHeicToJpeg(Buffer.from('definitely not a heic'), 0.9, 'high')).rejects.toThrow();
    const st = getHeicWorkerStats();
    expect(st.broken).toBe(false);
    expect(st.workers).toBe(1);
    await expect(decodeHeicToJpeg(Buffer.from('another bogus file'), 0.9, 'low')).rejects.toThrow();
  }, 60000);
});
