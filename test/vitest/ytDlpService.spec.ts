import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import crypto from 'crypto';
import {
  ytDlpAssetName, isYouTubeUrl, parseSha256Sums, installYtDlp, managedYtDlpPath, downloadYouTubeAudio, friendlyYtDlpError,
} from '../../src/main/services/ytDlpService';

describe('ytDlpAssetName', () => {
  it('picks the standalone build for each platform', () => {
    expect(ytDlpAssetName('win32', 'x64')).toBe('yt-dlp.exe');
    expect(ytDlpAssetName('darwin', 'arm64')).toBe('yt-dlp_macos');
    expect(ytDlpAssetName('linux', 'x64')).toBe('yt-dlp_linux');
    expect(ytDlpAssetName('linux', 'arm64')).toBe('yt-dlp_linux_aarch64');
  });
});

describe('isYouTubeUrl', () => {
  it.each([
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ?t=10',
    'https://music.youtube.com/watch?v=abc',
    'http://m.youtube.com/watch?v=abc',
    '  https://youtube.com/watch?v=abc  ',
  ])('accepts %s', (u) => expect(isYouTubeUrl(u)).toBe(true));

  it.each([
    'https://youtube.com.evil.com/watch?v=abc',
    'https://notyoutube.com/watch?v=abc',
    'https://evil.com/?u=https://youtube.com/watch',
    'file:///C:/secret.mp3',
    'javascript:alert(1)',
    '--exec=calc',
    'youtube.com/watch?v=abc', // no scheme
    '',
  ])('rejects %s', (u) => expect(isYouTubeUrl(u)).toBe(false));
});

describe('parseSha256Sums', () => {
  it('reads "<hash>  <name>" lines, tolerating CRLF and a leading * on binary names', () => {
    const h1 = 'a'.repeat(64);
    const h2 = 'B'.repeat(64);
    const m = parseSha256Sums(`${h1}  yt-dlp.exe\r\n${h2} *yt-dlp_linux\r\nnot a hash line\r\n`);
    expect(m.get('yt-dlp.exe')).toBe(h1);
    expect(m.get('yt-dlp_linux')).toBe('b'.repeat(64));
    expect(m.size).toBe(2);
  });
});

describe('installYtDlp (against a local stand-in for the GitHub release)', () => {
  let dir: string;
  let server: http.Server;
  let base: string;
  let files: Record<string, Buffer | string>;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gphotos_ytdlp_'));
    files = {};
    server = http.createServer((req, res) => {
      const body = files[(req.url || '').slice(1)];
      if (body === undefined) { res.statusCode = 404; res.end(); return; }
      res.end(body);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as any).port}`;
  });
  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
  const opts = (extra: any = {}) => ({ userDataDir: dir, releaseBase: base, platform: 'win32', verify: false, ...extra });

  it('installs the binary when its checksum matches, reporting progress up to 100', async () => {
    const bin = Buffer.alloc(200000, 7);
    files['SHA2-256SUMS'] = `${sha(bin)}  yt-dlp.exe\n`;
    files['yt-dlp.exe'] = bin;
    const seen: number[] = [];
    const r = await installYtDlp(opts({ onProgress: (p: number) => seen.push(p) }));
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(managedYtDlpPath(dir, 'win32')).equals(bin)).toBe(true);
    expect(seen[seen.length - 1]).toBe(100);
    expect(fs.existsSync(managedYtDlpPath(dir, 'win32') + '.download')).toBe(false);
  });

  it('refuses (and leaves nothing behind) when the download does not match the published checksum', async () => {
    files['SHA2-256SUMS'] = `${'0'.repeat(64)}  yt-dlp.exe\n`;
    files['yt-dlp.exe'] = Buffer.from('tampered');
    const r = await installYtDlp(opts());
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/checksum/i);
    expect(fs.existsSync(managedYtDlpPath(dir, 'win32'))).toBe(false);
    expect(fs.existsSync(managedYtDlpPath(dir, 'win32') + '.download')).toBe(false);
  });

  it('refuses when the release has no checksum for this platform\'s file', async () => {
    files['SHA2-256SUMS'] = `${'1'.repeat(64)}  something_else\n`;
    files['yt-dlp.exe'] = Buffer.from('x');
    const r = await installYtDlp(opts());
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no checksum/i);
  });

  it('reports a missing release as an error rather than throwing', async () => {
    const r = await installYtDlp(opts());
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/404/);
  });

  it('an unreachable server is reported, not thrown', async () => {
    const r = await installYtDlp(opts({ releaseBase: 'http://127.0.0.1:9' }));
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });
});

describe('downloadYouTubeAudio (with a stand-in yt-dlp script)', () => {
  let dir: string;
  let script: string;
  let argsFile: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gphotos_ytdl_'));
    argsFile = path.join(dir, 'args.json');
    script = path.join(dir, 'fake-yt-dlp.js');
    // Behaves like yt-dlp: progress lines, an mp3 at the -o template, its path printed last; MODE picks a failure.
    fs.writeFileSync(script, `
      const fs = require('fs');
      const args = process.argv.slice(2);
      fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(args));
      const mode = process.env.FAKE_MODE || 'ok';
      if (mode === 'fail') { console.error('ERROR: [youtube] abc: Private video. Sign in if you have been granted access'); process.exit(1); }
      if (mode === 'hang') { setInterval(() => {}, 1000); return; }
      const tpl = args[args.indexOf('-o') + 1];
      const out = tpl.replace('%(title).80B', 'Some Song').replace('%(id)s', 'abc').replace('%(ext)s', 'mp3');
      console.log('[youtube] abc: Downloading webpage');
      console.log('[download]  25.0% of 3.00MiB at 1.0MiB/s ETA 00:02');
      console.log('[download]  80.5% of 3.00MiB at 1.0MiB/s ETA 00:00');
      fs.writeFileSync(out, 'mp3data');
      console.log('[ExtractAudio] Destination: ' + out);
      console.log(out);
    `);
  });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  const run = (extra: any = {}, env: Record<string, string> = {}) => {
    Object.assign(process.env, { FAKE_MODE: 'ok' }, env);
    return downloadYouTubeAudio({
      url: 'https://www.youtube.com/watch?v=abc', outDir: path.join(dir, 'out'), ffmpegPath: 'C:\\ff\\ffmpeg.exe',
      launcher: { command: process.execPath, prefixArgs: [script] }, ...extra,
    });
  };

  it('downloads, reports progress, and returns the mp3 path yt-dlp printed', async () => {
    const seen: number[] = [];
    const r = await run({ onProgress: (p: number) => seen.push(p) });
    expect(r.ok).toBe(true);
    expect(path.basename(r.filePath!)).toBe('Some Song [abc].mp3');
    expect(fs.existsSync(r.filePath!)).toBe(true);
    expect(seen).toEqual(expect.arrayContaining([25, 81, 100]));
  });

  it('passes safe arguments: single video only, our ffmpeg, mp3, and the address after `--`', async () => {
    await run();
    const args: string[] = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
    expect(args).toContain('--no-playlist');
    expect(args[args.indexOf('--ffmpeg-location') + 1]).toBe('C:\\ff\\ffmpeg.exe');
    expect(args[args.indexOf('--audio-format') + 1]).toBe('mp3');
    expect(args[args.length - 2]).toBe('--');
    expect(args[args.length - 1]).toBe('https://www.youtube.com/watch?v=abc');
  });

  it('never launches anything for a non-YouTube address', async () => {
    const r = await run({ url: 'https://evil.example/x.mp3' });
    expect(r.ok).toBe(false);
    expect(fs.existsSync(argsFile)).toBe(false);
  });

  it('turns a yt-dlp failure into a plain-language message', async () => {
    const r = await run({}, { FAKE_MODE: 'fail' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/private/i);
  });

  it('a launcher that does not exist says yt-dlp is not installed', async () => {
    const r = await run({ launcher: { command: path.join(dir, 'nope.exe') } });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not installed/i);
  });

  it('cancelling stops the process and reports Cancelled', async () => {
    const ac = new AbortController();
    const p = run({ signal: ac.signal }, { FAKE_MODE: 'hang' });
    setTimeout(() => ac.abort(), 400);
    const r = await p;
    expect(r).toEqual({ ok: false, error: 'Cancelled.' });
  });
});

describe('friendlyYtDlpError', () => {
  it('maps the common failures', () => {
    expect(friendlyYtDlpError('ERROR: Video unavailable')).toMatch(/unavailable/);
    expect(friendlyYtDlpError('HTTP Error 429: Too Many Requests')).toMatch(/rate-limiting/);
    expect(friendlyYtDlpError('ERROR: Sign in to confirm you\'re not a bot')).toMatch(/sign-in/);
    expect(friendlyYtDlpError('something odd')).toMatch(/something odd/);
    expect(friendlyYtDlpError('')).toMatch(/failed/);
  });
});
