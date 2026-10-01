import React, { useEffect, useState } from 'react';
import { Music, FolderOpen, Globe, Download, XCircle, Play, Trash2 } from 'lucide-react';
import type { AudioFileInfo, YtDlpStatusInfo } from '../../../types';
import { MusicLibraryList } from './MusicLibraryList';

export interface MusicSelection {
  file: AudioFileInfo;
  startSec: number;
  /** null = to the end of the file. */
  endSec: number | null;
  /** Repeat the clip until the video ends. */
  loop: boolean;
  fadeOutSec: number;
  volume: number;
  /** Set when the track is from the built-in library. */
  trackId?: string;
  /** The credit the track's licence requires (library tracks only). */
  credit?: string;
}

/** "1:05", "65", "1:02:03" or "1:05.5" → seconds; blank → null; anything else → NaN. */
export function parseTime(text: string): number | null {
  const s = text.trim();
  if (!s) return null;
  const parts = s.split(':');
  if (parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return NaN;
  return parts.reduce((acc, p) => acc * 60 + parseFloat(p), 0);
}

export function formatTime(sec: number): string {
  const total = Math.max(0, sec);
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  const whole = Math.floor(s);
  const frac = Math.round((s - whole) * 10);
  return `${m}:${String(whole).padStart(2, '0')}${frac ? '.' + frac : ''}`;
}

const TimeField: React.FC<{ label: string; value: number | null; placeholder?: string; onCommit: (v: number | null) => void }> = ({ label, value, placeholder, onCommit }) => {
  const [text, setText] = useState(value == null ? '' : formatTime(value));
  useEffect(() => { setText(value == null ? '' : formatTime(value)); }, [value]);
  const commit = () => {
    const v = parseTime(text);
    if (Number.isNaN(v)) { setText(value == null ? '' : formatTime(value)); return; }
    onCommit(v);
  };
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.82rem' }}>
      {label}
      <input
        className="input"
        aria-label={label}
        value={text}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') commit(); }}
        style={{ height: '34px', width: '84px' }}
      />
    </label>
  );
};

interface MusicStepProps {
  music: MusicSelection | null;
  onChange: (next: MusicSelection | null) => void;
  /** Length of the video without music, to show how often the clip repeats. */
  videoLengthSec: number;
}

const newSelection = (file: AudioFileInfo): MusicSelection => ({ file, startSec: 0, endSec: null, loop: true, fadeOutSec: 2, volume: 1 });

export const MusicStep: React.FC<MusicStepProps> = ({ music, onChange, videoLengthSec }) => {
  const api = window.electronAPI;
  const [tab, setTab] = useState<'library' | 'file' | 'youtube'>('library');
  const [yt, setYt] = useState<YtDlpStatusInfo | null>(null);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState<null | 'install' | 'download'>(null);
  const [pct, setPct] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);

  useEffect(() => {
    if (tab !== 'youtube' || yt) return;
    api?.getYtDlpStatus?.().then(setYt).catch(() => setYt({ installed: false }));
  }, [tab, yt, api]);

  useEffect(() => {
    const off = api?.onAudioFetchProgress?.((p) => setPct(p.pct));
    return () => off?.();
  }, [api]);

  useEffect(() => { setPreviewSrc(null); }, [music?.file.filePath, music?.startSec, music?.endSec]);

  const chooseFile = async () => {
    setError(null);
    const file = await api?.chooseAudioFile?.();
    if (!file) return;
    if (file.durationSec == null) { setError('That file has no audio ffmpeg can read — try another one.'); return; }
    onChange(newSelection(file));
  };

  const install = async () => {
    setError(null); setBusy('install'); setPct(0);
    try {
      const r = await api?.installYtDlp?.();
      if (r?.ok) setYt(await api!.getYtDlpStatus!());
      else setError(r?.error || 'Could not install yt-dlp.');
    } finally { setBusy(null); }
  };

  const download = async () => {
    setError(null); setBusy('download'); setPct(0);
    try {
      const r = await api?.downloadYouTubeAudio?.(url.trim());
      if (r?.ok && r.file) onChange(newSelection(r.file));
      else if (r?.error !== 'Cancelled.') setError(r?.error || 'The download failed.');
    } finally { setBusy(null); }
  };

  const preview = async () => {
    if (!music) return;
    setPreviewing(true);
    try {
      const src = await api?.getAudioPreview?.(music.file.filePath, music.startSec, music.endSec);
      if (src) setPreviewSrc(src); else setError('Could not make a preview of that section.');
    } finally { setPreviewing(false); }
  };

  const duration = music?.file.durationSec ?? null;
  const clipEnd = music ? (music.endSec ?? duration ?? 0) : 0;
  const clipLen = music ? Math.max(0, clipEnd - music.startSec) : 0;
  const repeats = music && music.loop && clipLen > 0 && videoLengthSec > clipLen ? Math.ceil(videoLengthSec / clipLen) : 1;

  const setStart = (v: number | null) => {
    if (!music) return;
    const start = Math.min(Math.max(0, v ?? 0), Math.max(0, (duration ?? Infinity) - 0.5));
    const end = music.endSec != null && music.endSec <= start + 0.5 ? null : music.endSec;
    onChange({ ...music, startSec: start, endSec: end });
  };
  const setEnd = (v: number | null) => {
    if (!music) return;
    if (v == null || (duration != null && v >= duration)) { onChange({ ...music, endSec: null }); return; }
    onChange({ ...music, endSec: Math.max(v, music.startSec + 0.5) });
  };

  const tabBtn = (k: 'library' | 'file' | 'youtube', label: string, icon: React.ReactNode) => (
    <button className={`btn ${tab === k ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setTab(k)} style={{ gap: '6px', fontSize: '0.82rem' }}>{icon} {label}</button>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--text-muted)' }}>
        Add a song or any audio under the video. This step is optional — leave it empty for a silent video.
      </p>

      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
        {tabBtn('library', 'Free music library', <Music size={14} />)}
        {tabBtn('file', 'From this computer', <FolderOpen size={14} />)}
        {tabBtn('youtube', 'From YouTube', <Globe size={14} />)}
      </div>

      {tab === 'library' && <MusicLibraryList music={music} onUse={onChange} onError={setError} pct={pct} />}

      {tab === 'file' && (
        <button className="btn btn-secondary" onClick={chooseFile} style={{ alignSelf: 'flex-start', gap: '8px' }}>
          <Music size={16} /> {music ? 'Choose a different file…' : 'Choose an audio file…'}
        </button>
      )}

      {tab === 'youtube' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', maxWidth: '560px' }}>
          {yt === null && <span style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>Checking for yt-dlp…</span>}
          {yt && !yt.installed && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '12px', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)' }}>
              <span style={{ fontSize: '0.82rem' }}>
                Downloading from YouTube uses <strong>yt-dlp</strong>, a free open-source tool (github.com/yt-dlp/yt-dlp). It isn't bundled with gPhotos —
                install it once here (about 18 MB, fetched from its official GitHub release and checked against the published checksum).
              </span>
              <button className="btn btn-primary" disabled={busy === 'install'} onClick={install} style={{ alignSelf: 'flex-start', gap: '8px' }}>
                <Download size={14} /> {busy === 'install' ? `Installing… ${pct}%` : 'Install yt-dlp'}
              </button>
            </div>
          )}
          {yt?.installed && (
            <>
              <div style={{ display: 'flex', gap: '8px' }}>
                <input
                  className="input"
                  aria-label="YouTube link"
                  placeholder="Paste a YouTube link, e.g. https://www.youtube.com/watch?v=…"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  style={{ height: '38px', flex: 1 }}
                />
                {busy === 'download' ? (
                  <button className="btn btn-ghost" onClick={() => api?.cancelYouTubeDownload?.()} style={{ gap: '6px' }}><XCircle size={14} /> Cancel</button>
                ) : (
                  <button className="btn btn-primary" disabled={!url.trim()} onClick={download} style={{ gap: '6px' }}><Download size={14} /> Download audio</button>
                )}
              </div>
              {busy === 'download' && (
                <div style={{ height: '6px', borderRadius: '3px', backgroundColor: 'var(--bg-surface-elevated)', overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${pct}%`, backgroundColor: '#ec4899', transition: 'width 0.2s' }} />
                </div>
              )}
              <span style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>
                Only use music you have the right to use — YouTube content is usually copyrighted. yt-dlp {yt.version}{yt.source === 'system' ? ' (found on this computer)' : ''}.
              </span>
            </>
          )}
        </div>
      )}

      {error && <div role="alert" style={{ fontSize: '0.82rem', color: '#f43f5e' }}>{error}</div>}

      {music && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', padding: '14px', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <Music size={16} color="#ec4899" />
            <strong data-testid="music-name" style={{ flex: 1, fontSize: '0.88rem', wordBreak: 'break-all' }}>{music.file.name}</strong>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{duration != null ? formatTime(duration) : ''}</span>
            <button className="btn btn-ghost" onClick={() => onChange(null)} style={{ gap: '6px', fontSize: '0.78rem', color: '#f43f5e' }}><Trash2 size={13} /> Remove</button>
          </div>

          <div style={{ display: 'flex', gap: '18px', flexWrap: 'wrap', alignItems: 'center' }}>
            <TimeField label="Start at" value={music.startSec} onCommit={setStart} />
            <TimeField label="End at" value={music.endSec} placeholder="end" onCommit={setEnd} />
            <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>m:ss — leave “End at” empty to use the rest of the song</span>
          </div>

          <div style={{ display: 'flex', gap: '18px', flexWrap: 'wrap', alignItems: 'center' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.85rem' }}>
              <input type="checkbox" checked={music.loop} onChange={(e) => onChange({ ...music, loop: e.target.checked })} /> Repeat to fill the whole video
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.82rem' }}>
              Fade out (s)
              <input type="number" className="input" aria-label="Fade out seconds" min={0} max={10} step={0.5} value={music.fadeOutSec} onChange={(e) => onChange({ ...music, fadeOutSec: Math.min(10, Math.max(0, parseFloat(e.target.value) || 0)) })} style={{ height: '34px', width: '70px' }} />
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.82rem' }}>
              Volume
              <input type="range" aria-label="Volume" min={0.1} max={1.5} step={0.05} value={music.volume} onChange={(e) => onChange({ ...music, volume: parseFloat(e.target.value) })} />
              {Math.round(music.volume * 100)}%
            </label>
          </div>

          <div data-testid="music-summary" style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
            Using {formatTime(clipLen)} of the song ({formatTime(music.startSec)} – {formatTime(clipEnd)}).{' '}
            {clipLen > 0 && (music.loop
              ? (repeats > 1 ? `It plays ${repeats} times to cover the ~${formatTime(videoLengthSec)} video.` : `It is long enough for the ~${formatTime(videoLengthSec)} video; any extra is cut off.`)
              : (clipLen < videoLengthSec ? `The music ends before the ~${formatTime(videoLengthSec)} video does — tick Repeat to fill it.` : 'Any extra is cut off when the video ends.'))}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <button className="btn btn-secondary" disabled={previewing} onClick={preview} style={{ gap: '6px', fontSize: '0.8rem' }}><Play size={13} /> {previewing ? 'Preparing…' : 'Preview this section'}</button>
            {previewSrc && <audio data-testid="music-preview" controls autoPlay src={previewSrc} style={{ height: '34px' }} />}
          </div>
        </div>
      )}
    </div>
  );
};
