import React, { useEffect, useState } from 'react';
import { Sun, Coffee, Heart, Film, Smile, Leaf, Play, Check, Download, XCircle } from 'lucide-react';
import {
  MUSIC_CATALOG, MUSIC_ARTIST, MUSIC_CATEGORY_LABEL, MUSIC_LICENSE_NAME, musicCreditText,
  type MusicCategory, type MusicTrack,
} from '../../../types/musicCatalog';
import type { AudioFileInfo } from '../../../types';
import { formatTime, type MusicSelection } from './MusicStep';

const CATEGORY_LOOK: Record<MusicCategory, { hue: number; Icon: React.ComponentType<{ size?: number; color?: string }> }> = {
  upbeat: { hue: 38, Icon: Sun },
  relaxed: { hue: 180, Icon: Coffee },
  emotional: { hue: 335, Icon: Heart },
  cinematic: { hue: 235, Icon: Film },
  playful: { hue: 110, Icon: Smile },
  acoustic: { hue: 25, Icon: Leaf },
};

/** Cover art: a gradient and an icon for the track's mood, each track a slightly different shade. */
export const MusicCover: React.FC<{ track: MusicTrack; size?: number }> = ({ track, size = 52 }) => {
  const { hue, Icon } = CATEGORY_LOOK[track.category];
  const shift = (MUSIC_CATALOG.indexOf(track) * 13) % 36;
  return (
    <div
      data-testid="music-cover"
      style={{
        width: size, height: size, flexShrink: 0, borderRadius: 'var(--radius-md)', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: `linear-gradient(135deg, hsl(${hue + shift} 75% 58%), hsl(${hue + shift + 40} 70% 32%))`,
      }}
    >
      <Icon size={Math.round(size * 0.46)} color="rgba(255,255,255,0.92)" />
    </div>
  );
};

interface Props {
  music: MusicSelection | null;
  onUse: (m: MusicSelection) => void;
  onError: (message: string | null) => void;
  /** 0-100 while a download is in flight (driven by the wizard's progress subscription). */
  pct: number;
}

export const MusicLibraryList: React.FC<Props> = ({ music, onUse, onError, pct }) => {
  const api = window.electronAPI;
  const [cached, setCached] = useState<Set<string>>(new Set());
  const [category, setCategory] = useState<MusicCategory | 'all'>('all');
  const [busy, setBusy] = useState<{ id: string; what: 'use' | 'preview' } | null>(null);
  const [preview, setPreview] = useState<{ id: string; src: string } | null>(null);

  useEffect(() => {
    api?.getMusicLibraryCached?.().then((ids) => setCached(new Set(ids))).catch(() => {});
  }, [api]);

  const ensure = async (track: MusicTrack): Promise<AudioFileInfo | null> => {
    const r = await api?.fetchMusicTrack?.(track.id);
    if (!r?.ok || !r.file) {
      if (r?.error !== 'Cancelled.') onError(r?.error || `Could not get "${track.title}".`);
      return null;
    }
    setCached((prev) => new Set(prev).add(track.id));
    return r.file;
  };

  const use = async (track: MusicTrack) => {
    onError(null);
    setBusy({ id: track.id, what: 'use' });
    try {
      const file = await ensure(track);
      if (file) onUse({ file, startSec: 0, endSec: null, loop: true, fadeOutSec: 2, volume: 1, trackId: track.id, credit: musicCreditText(track) });
    } finally { setBusy(null); }
  };

  const play = async (track: MusicTrack) => {
    onError(null);
    setBusy({ id: track.id, what: 'preview' });
    try {
      const file = await ensure(track);
      if (!file) return;
      const src = await api?.getAudioPreview?.(file.filePath, 0, null);
      if (src) setPreview({ id: track.id, src }); else onError('Could not make a preview of that track.');
    } finally { setBusy(null); }
  };

  const shown = MUSIC_CATALOG.filter((t) => category === 'all' || t.category === category);
  const categories = Array.from(new Set(MUSIC_CATALOG.map((t) => t.category)));
  const previewTrack = preview ? MUSIC_CATALOG.find((t) => t.id === preview.id) : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
        {MUSIC_CATALOG.length} royalty-free tracks by {MUSIC_ARTIST} (incompetech.com), {MUSIC_LICENSE_NAME}. Free to use in your videos — the required credit is
        added to your end-credits screen automatically. A track downloads (about 8 MB) the first time you preview or use it.
      </span>

      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
        {(['all', ...categories] as Array<MusicCategory | 'all'>).map((c) => (
          <button key={c} className={`btn ${category === c ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setCategory(c)} style={{ padding: '3px 10px', fontSize: '0.74rem' }}>
            {c === 'all' ? 'All' : MUSIC_CATEGORY_LABEL[c]}
          </button>
        ))}
      </div>

      {previewTrack && preview && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '0.8rem' }}>
          <span>Preview: <strong>{previewTrack.title}</strong></span>
          <audio data-testid="library-preview" controls autoPlay src={preview.src} style={{ height: '32px' }} />
        </div>
      )}

      <div data-testid="music-library" style={{ display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '340px', overflowY: 'auto', paddingRight: '4px' }}>
        {shown.map((t) => {
          const selected = music?.trackId === t.id;
          const isBusy = busy?.id === t.id;
          return (
            <div
              key={t.id}
              data-testid={`music-track-${t.id}`}
              style={{
                display: 'flex', alignItems: 'center', gap: '12px', padding: '8px 10px', borderRadius: 'var(--radius-md)',
                border: selected ? '1px solid #ec4899' : '1px solid var(--border-subtle)', background: selected ? 'rgba(236,72,153,0.08)' : 'transparent',
              }}
            >
              <MusicCover track={t} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '0.88rem', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.title}</div>
                <div style={{ fontSize: '0.76rem', color: 'var(--text-secondary)' }}>{MUSIC_ARTIST}</div>
                <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                  {MUSIC_CATEGORY_LABEL[t.category]} · {formatTime(t.durationSec)}{t.feel.length ? ` · ${t.feel.join(', ')}` : ''}{cached.has(t.id) ? ' · downloaded' : ''}
                </div>
              </div>
              {isBusy ? (
                <>
                  <span style={{ fontSize: '0.76rem', color: 'var(--text-muted)', minWidth: '70px', textAlign: 'right' }}>
                    {busy!.what === 'use' ? 'Getting' : 'Preparing'}… {pct}%
                  </span>
                  <button className="btn btn-ghost" aria-label="Cancel download" onClick={() => api?.cancelYouTubeDownload?.()} style={{ padding: '4px 8px' }}><XCircle size={14} /></button>
                </>
              ) : (
                <>
                  <button className="btn btn-secondary" aria-label={`Preview ${t.title}`} disabled={!!busy} onClick={() => play(t)} style={{ padding: '5px 9px', gap: '5px', fontSize: '0.76rem' }}><Play size={12} /> Preview</button>
                  <button className={`btn ${selected ? 'btn-secondary' : 'btn-primary'}`} aria-label={`Use ${t.title}`} disabled={!!busy} onClick={() => use(t)} style={{ padding: '5px 12px', gap: '5px', fontSize: '0.76rem' }}>
                    {selected ? <><Check size={13} /> Selected</> : cached.has(t.id) ? 'Use' : <><Download size={12} /> Use</>}
                  </button>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
