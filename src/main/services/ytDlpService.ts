// Fetching a YouTube video's audio for the video wizard's music step, using the open-source yt-dlp
// (https://github.com/yt-dlp/yt-dlp). It is NOT bundled: YouTube changes often and yt-dlp is updated
// weekly, so a stale copy inside the installer would break quickly. Instead the official release binary is
// downloaded on demand into the app's own folder — verified against the release's published SHA-256 list —
// and can be re-installed to update. A yt-dlp already on the machine's PATH is used if there is one.
// ffmpeg (needed to turn the download into an mp3) is the copy that already ships with the app.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';

export const YT_DLP_RELEASE_BASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download';

/** The release asset to fetch for this machine (standalone builds, so no Python is needed). */
export function ytDlpAssetName(platform: string = process.platform, arch: string = process.arch): string {
  if (platform === 'win32') return 'yt-dlp.exe';
  if (platform === 'darwin') return 'yt-dlp_macos';
  return arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux';
}

/** Only real YouTube addresses (youtube.com and its subdomains, youtu.be) are accepted. */
export function isYouTubeUrl(input: string): boolean {
  let u: URL;
  try {
    u = new URL((input || '').trim());
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  const host = u.hostname.toLowerCase();
  return host === 'youtu.be' || host === 'youtube.com' || host.endsWith('.youtube.com');
}

/** Reads a `SHA2-256SUMS` file ("<hex>  <file name>" per line) into a name → hash map. */
export function parseSha256Sums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line);
    if (m) out.set(m[2], m[1].toLowerCase());
  }
  return out;
}

export const ytDlpDir = (userDataDir: string) => path.join(userDataDir, 'tools');
export const managedYtDlpPath = (userDataDir: string, platform: string = process.platform) =>
  path.join(ytDlpDir(userDataDir), platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

export interface YtDlpLauncher {
  command: string;
  /** Arguments placed before the real ones (tests launch a stand-in script through node this way). */
  prefixArgs?: string[];
}

function runCapture(command: string, args: string[], timeoutMs = 15000): Promise<{ code: number | null; stdout: string; error?: string }> {
  return new Promise((resolve) => {
    let stdout = '';
    let done = false;
    const finish = (r: { code: number | null; stdout: string; error?: string }) => { if (!done) { done = true; resolve(r); } };
    try {
      const proc = spawn(command, args, { windowsHide: true });
      const timer = setTimeout(() => { try { proc.kill(); } catch {} finish({ code: null, stdout, error: 'timed out' }); }, timeoutMs);
      proc.stdout.on('data', (d) => { stdout += d.toString(); });
      proc.on('error', (e) => { clearTimeout(timer); finish({ code: null, stdout, error: e.message }); });
      proc.on('close', (code) => { clearTimeout(timer); finish({ code, stdout }); });
    } catch (e: any) {
      finish({ code: null, stdout, error: e?.message || String(e) });
    }
  });
}

export async function ytDlpVersion(launcher: YtDlpLauncher): Promise<string | null> {
  const r = await runCapture(launcher.command, [...(launcher.prefixArgs || []), '--version']);
  return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

export interface YtDlpStatus {
  installed: boolean;
  source?: 'managed' | 'system';
  version?: string;
}

/** The yt-dlp to use: our own downloaded copy first, else one already on PATH, else nothing. */
export async function resolveYtDlp(userDataDir: string): Promise<{ launcher: YtDlpLauncher; status: YtDlpStatus }> {
  const managed = managedYtDlpPath(userDataDir);
  if (fs.existsSync(managed)) {
    const version = await ytDlpVersion({ command: managed });
    if (version) return { launcher: { command: managed }, status: { installed: true, source: 'managed', version } };
  }
  const systemVersion = await ytDlpVersion({ command: 'yt-dlp' });
  if (systemVersion) return { launcher: { command: 'yt-dlp' }, status: { installed: true, source: 'system', version: systemVersion } };
  return { launcher: { command: managed }, status: { installed: false } };
}

export interface InstallOptions {
  userDataDir: string;
  releaseBase?: string;
  platform?: string;
  arch?: string;
  onProgress?: (pct: number) => void;
  signal?: AbortSignal;
  /** Run `--version` on the result to prove it works (default true; only tests turn it off). */
  verify?: boolean;
}

export interface InstallResult {
  ok: boolean;
  error?: string;
  version?: string;
}

/** Downloads the official yt-dlp build for this machine, checks its SHA-256 against the release's list, and installs it. */
export async function installYtDlp(opts: InstallOptions): Promise<InstallResult> {
  const base = (opts.releaseBase || YT_DLP_RELEASE_BASE).replace(/\/+$/, '');
  const platform = opts.platform || process.platform;
  const asset = ytDlpAssetName(platform, opts.arch);
  const dest = managedYtDlpPath(opts.userDataDir, platform);
  const tmp = dest + '.download';

  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });

    const sumsRes = await fetch(`${base}/SHA2-256SUMS`, { signal: opts.signal });
    if (!sumsRes.ok) return { ok: false, error: `Could not fetch the checksum list (HTTP ${sumsRes.status}).` };
    const expected = parseSha256Sums(await sumsRes.text()).get(asset);
    if (!expected) return { ok: false, error: `The release has no checksum for "${asset}", so it was not installed.` };

    const res = await fetch(`${base}/${asset}`, { signal: opts.signal });
    if (!res.ok || !res.body) return { ok: false, error: `Download failed (HTTP ${res.status}).` };
    const total = Number(res.headers.get('content-length')) || 0;

    const hash = crypto.createHash('sha256');
    const out = fs.createWriteStream(tmp);
    let received = 0;
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        hash.update(value);
        received += value.length;
        if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()));
        if (total) opts.onProgress?.(Math.min(99, Math.round((received / total) * 100)));
      }
    } finally {
      await new Promise<void>((r) => out.end(() => r()));
    }

    if (hash.digest('hex') !== expected) {
      fs.rmSync(tmp, { force: true });
      return { ok: false, error: 'The downloaded file did not match its published checksum, so it was discarded.' };
    }

    fs.rmSync(dest, { force: true });
    fs.renameSync(tmp, dest);
    if (platform !== 'win32') fs.chmodSync(dest, 0o755);

    let version: string | undefined;
    if (opts.verify !== false) {
      version = (await ytDlpVersion({ command: dest })) || undefined;
      if (!version) return { ok: false, error: 'yt-dlp was downloaded but would not start on this machine.' };
    }
    opts.onProgress?.(100);
    return { ok: true, version };
  } catch (err: any) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    if (opts.signal?.aborted) return { ok: false, error: 'Cancelled.' };
    return { ok: false, error: err?.cause?.message || err?.message || String(err) };
  }
}

export interface DownloadAudioOptions {
  url: string;
  outDir: string;
  launcher: YtDlpLauncher;
  ffmpegPath: string;
  onProgress?: (pct: number) => void;
  signal?: AbortSignal;
}

export interface DownloadAudioResult {
  ok: boolean;
  filePath?: string;
  error?: string;
}

/** Turns yt-dlp's stderr into something a person can act on. */
export function friendlyYtDlpError(stderr: string): string {
  const s = stderr || '';
  if (/Sign in to confirm|confirm you.re not a bot/i.test(s)) return 'YouTube asked for a sign-in / bot check for this video, so it could not be downloaded.';
  if (/Private video/i.test(s)) return 'That video is private.';
  if (/Video unavailable|This video is not available|has been removed/i.test(s)) return 'That video is unavailable.';
  if (/copyright|blocked it/i.test(s)) return 'YouTube blocks this video from being downloaded (copyright / region).';
  if (/HTTP Error 429|Too Many Requests/i.test(s)) return 'YouTube is rate-limiting this computer right now — try again in a while.';
  if (/Unsupported URL|is not a valid URL/i.test(s)) return 'That is not a link to a YouTube video.';
  if (/getaddrinfo|Temporary failure in name resolution|Unable to download webpage|Connection|timed out/i.test(s)) return 'Could not reach YouTube — check the internet connection.';
  const last = s.trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' ');
  return last ? `yt-dlp reported: ${last.slice(0, 300)}` : 'The download failed.';
}

/** Downloads the audio of one YouTube video as an mp3 into `outDir`. Never throws. */
export async function downloadYouTubeAudio(opts: DownloadAudioOptions): Promise<DownloadAudioResult> {
  if (!isYouTubeUrl(opts.url)) return { ok: false, error: 'That does not look like a YouTube link.' };
  try {
    fs.mkdirSync(opts.outDir, { recursive: true });
  } catch (err: any) {
    return { ok: false, error: `Could not create the download folder: ${err?.message || err}` };
  }

  const args = [
    ...(opts.launcher.prefixArgs || []),
    '--no-playlist', '--no-warnings', '--newline',
    '-f', 'bestaudio/best',
    '-x', '--audio-format', 'mp3', '--audio-quality', '0',
    '--ffmpeg-location', opts.ffmpegPath,
    '-o', path.join(opts.outDir, '%(title).80B [%(id)s].%(ext)s'),
    '--print', 'after_move:filepath', '--no-simulate',
    '--', // whatever follows is the address, never an option
    opts.url.trim(),
  ];

  return new Promise<DownloadAudioResult>((resolve) => {
    let stderr = '';
    let filePath: string | undefined;
    let buffer = '';
    let settled = false;
    const finish = (r: DownloadAudioResult) => { if (!settled) { settled = true; opts.signal?.removeEventListener('abort', onAbort); resolve(r); } };

    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(opts.launcher.command, args, { windowsHide: true });
    } catch (err: any) {
      finish({ ok: false, error: err?.message || String(err) });
      return;
    }
    const onAbort = () => { try { proc.kill(); } catch {} };
    opts.signal?.addEventListener('abort', onAbort);

    const handleLine = (line: string) => {
      const m = /\[download\]\s+([\d.]+)%/.exec(line);
      if (m) { opts.onProgress?.(Math.min(99, Math.round(parseFloat(m[1])))); return; }
      const t = line.trim();
      if (t && !t.startsWith('[') && fs.existsSync(t)) filePath = t; // `--print after_move:filepath`
    };
    proc.stdout?.on('data', (d) => {
      buffer += d.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      lines.forEach(handleLine);
    });
    proc.stderr?.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (err: any) => finish({ ok: false, error: err?.code === 'ENOENT' ? 'yt-dlp is not installed yet.' : err?.message || String(err) }));
    proc.on('close', (code) => {
      if (buffer) handleLine(buffer);
      if (opts.signal?.aborted) return finish({ ok: false, error: 'Cancelled.' });
      if (code === 0 && filePath) {
        opts.onProgress?.(100);
        return finish({ ok: true, filePath });
      }
      finish({ ok: false, error: code === 0 ? 'The download finished but no audio file was produced.' : friendlyYtDlpError(stderr) });
    });
  });
}
