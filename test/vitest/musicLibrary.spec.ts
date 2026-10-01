import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import {
  MUSIC_CATALOG, MUSIC_ARTIST, musicTrackUrl, findMusicTrack, musicCreditText, MUSIC_CATEGORY_LABEL,
} from '../../src/types/musicCatalog';
import { fetchMusicTrack, listCachedTrackIds, cachedTrackPath } from '../../src/main/services/musicLibraryService';

describe('music catalogue', () => {
  it('has 20 distinct tracks, each with a title, artist, category, duration and download file', () => {
    expect(MUSIC_CATALOG).toHaveLength(20);
    expect(new Set(MUSIC_CATALOG.map((t) => t.id)).size).toBe(20);
    expect(new Set(MUSIC_CATALOG.map((t) => t.title)).size).toBe(20);
    for (const t of MUSIC_CATALOG) {
      expect(t.title.length).toBeGreaterThan(0);
      expect(MUSIC_CATEGORY_LABEL[t.category]).toBeTruthy();
      expect(t.file).toMatch(/\.mp3$/);
      expect(t.durationSec).toBeGreaterThan(30);
      expect(t.sizeBytes).toBeGreaterThan(1_000_000);
    }
  });

  it('covers several moods, so there is something for every kind of album', () => {
    expect(new Set(MUSIC_CATALOG.map((t) => t.category)).size).toBeGreaterThanOrEqual(5);
  });

  it('builds a URL-encoded download address and finds a track by id', () => {
    const t = findMusicTrack('local-forecast-elevator')!;
    expect(t.title).toBe('Local Forecast - Elevator');
    expect(musicTrackUrl(t)).toBe('https://incompetech.com/music/royalty-free/mp3-royaltyfree/Local%20Forecast%20-%20Elevator.mp3');
    expect(musicTrackUrl(t, 'http://x/y/')).toBe('http://x/y/Local%20Forecast%20-%20Elevator.mp3');
    expect(findMusicTrack('nope')).toBeUndefined();
  });

  it('the credit line carries the title, the artist and the licence, as the licence requires', () => {
    const c = musicCreditText(findMusicTrack('carefree')!);
    expect(c).toContain('"Carefree"');
    expect(c).toContain(MUSIC_ARTIST);
    expect(c).toContain('incompetech.com');
    expect(c).toContain('By Attribution 4.0');
    expect(c).toContain('creativecommons.org/licenses/by/4.0');
  });
});

describe('fetchMusicTrack (against a local stand-in for incompetech.com)', () => {
  let dir: string;
  let server: http.Server;
  let base: string;
  let requests: string[];
  let body: Buffer | null;
  let status: number;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gphotos_music_'));
    requests = [];
    body = Buffer.alloc(200_000, 3);
    status = 200;
    server = http.createServer((req, res) => {
      requests.push(decodeURIComponent(req.url || ''));
      res.statusCode = status;
      res.end(status === 200 ? body : 'nope');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as any).port}`;
  });
  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  const track = findMusicTrack('carefree')!;

  it('downloads a track once, reports progress to 100, and serves it from the cache afterwards', async () => {
    const seen: number[] = [];
    const first = await fetchMusicTrack({ userDataDir: dir, track, baseUrl: base, onProgress: (p) => seen.push(p) });
    expect(first.ok).toBe(true);
    expect(first.filePath).toBe(cachedTrackPath(dir, track));
    expect(fs.statSync(first.filePath!).size).toBe(200_000);
    expect(seen[seen.length - 1]).toBe(100);
    expect(requests).toEqual(['/Carefree.mp3']);
    expect(listCachedTrackIds(dir)).toEqual(['carefree']);

    const second = await fetchMusicTrack({ userDataDir: dir, track, baseUrl: base });
    expect(second.ok).toBe(true);
    expect(requests).toHaveLength(1); // no second download
  });

  it('a server error is reported and nothing is cached', async () => {
    status = 404;
    const r = await fetchMusicTrack({ userDataDir: dir, track, baseUrl: base });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/404/);
    expect(listCachedTrackIds(dir)).toEqual([]);
  });

  it('a tiny / cut-off response is rejected and leaves no partial file behind', async () => {
    body = Buffer.from('<html>error page</html>');
    const r = await fetchMusicTrack({ userDataDir: dir, track, baseUrl: base });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/incomplete/);
    expect(fs.readdirSync(path.dirname(cachedTrackPath(dir, track)))).toEqual([]);
  });

  it('an unreachable server gives a plain message', async () => {
    const r = await fetchMusicTrack({ userDataDir: dir, track, baseUrl: 'http://127.0.0.1:9' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/internet connection|ECONNREFUSED|refused/i);
  });

  it('cancelling reports Cancelled and leaves nothing behind', async () => {
    const slow = http.createServer((_req, res) => { res.write(Buffer.alloc(1000)); /* never ends */ });
    await new Promise<void>((r) => slow.listen(0, '127.0.0.1', () => r()));
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const r = await fetchMusicTrack({ userDataDir: dir, track, baseUrl: `http://127.0.0.1:${(slow.address() as any).port}`, signal: ac.signal });
    slow.closeAllConnections?.();
    await new Promise<void>((res) => slow.close(() => res()));
    expect(r).toEqual({ ok: false, error: 'Cancelled.' });
    expect(listCachedTrackIds(dir)).toEqual([]);
    expect(fs.readdirSync(path.dirname(cachedTrackPath(dir, track)))).toEqual([]);
  });
});
