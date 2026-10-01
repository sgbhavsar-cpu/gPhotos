// Downloads the built-in royalty-free tracks (see src/types/musicCatalog.ts) on first use and keeps them in
// <userData>/music_library. Only catalogue tracks can be fetched — the renderer sends an id, never a URL.
import fs from 'fs';
import path from 'path';
import { MUSIC_CATALOG, musicTrackUrl, type MusicTrack } from '../../types/musicCatalog';

export const musicLibraryDir = (userDataDir: string) => path.join(userDataDir, 'music_library');
export const cachedTrackPath = (userDataDir: string, track: MusicTrack) => path.join(musicLibraryDir(userDataDir), track.file);

// A real track is megabytes; anything tiny is an error page or a cut-off download.
const MIN_TRACK_BYTES = 50_000;

const isCached = (userDataDir: string, track: MusicTrack) => {
  try { return fs.statSync(cachedTrackPath(userDataDir, track)).size >= MIN_TRACK_BYTES; } catch { return false; }
};

/** Ids of the tracks already downloaded (so the list can say which ones work offline). */
export function listCachedTrackIds(userDataDir: string): string[] {
  return MUSIC_CATALOG.filter((t) => isCached(userDataDir, t)).map((t) => t.id);
}

export interface FetchTrackOptions {
  userDataDir: string;
  track: MusicTrack;
  /** Overrides incompetech.com (tests point this at a local server). */
  baseUrl?: string;
  onProgress?: (pct: number) => void;
  signal?: AbortSignal;
}

export interface FetchTrackResult {
  ok: boolean;
  filePath?: string;
  error?: string;
}

/** Returns the local file for a track, downloading it first if needed. Never throws. */
export async function fetchMusicTrack(opts: FetchTrackOptions): Promise<FetchTrackResult> {
  const dest = cachedTrackPath(opts.userDataDir, opts.track);
  if (isCached(opts.userDataDir, opts.track)) return { ok: true, filePath: dest };

  const tmp = dest + '.part';
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const res = await fetch(musicTrackUrl(opts.track, opts.baseUrl), { signal: opts.signal });
    if (!res.ok || !res.body) return { ok: false, error: `Could not download "${opts.track.title}" (HTTP ${res.status}).` };
    const total = Number(res.headers.get('content-length')) || opts.track.sizeBytes;

    const out = fs.createWriteStream(tmp);
    let received = 0;
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.length;
        if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()));
        if (total) opts.onProgress?.(Math.min(99, Math.round((received / total) * 100)));
      }
    } finally {
      await new Promise<void>((r) => out.end(() => r()));
    }

    if (received < MIN_TRACK_BYTES) {
      fs.rmSync(tmp, { force: true });
      return { ok: false, error: `The download of "${opts.track.title}" was incomplete.` };
    }
    fs.renameSync(tmp, dest);
    opts.onProgress?.(100);
    return { ok: true, filePath: dest };
  } catch (err: any) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    if (opts.signal?.aborted) return { ok: false, error: 'Cancelled.' };
    const reason = err?.cause?.code === 'ENOTFOUND' || err?.cause?.code === 'ECONNREFUSED' || /fetch failed/i.test(err?.message || '')
      ? 'Could not reach incompetech.com — check the internet connection.'
      : err?.message || String(err);
    return { ok: false, error: reason };
  }
}
