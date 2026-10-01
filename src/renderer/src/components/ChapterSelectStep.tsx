import React, { useMemo, useState } from 'react';
import { Check, Plus, Search, Layers, ArrowLeft } from 'lucide-react';
import type { Album, AlbumChapter } from '../../../types';

/** The catch-all bucket a bulk "Add to Album" lands in when the user doesn't pick a specific
 *  chapter — found by name (case-insensitively) if the album already has one, created otherwise. */
export const OTHERS_CHAPTER_TITLE = 'Others';

/** Same exact/prefix/contains ranking as AlbumPicker's rankAlbumsByQuery, for an album's chapters. */
export function rankChaptersByQuery(chapters: AlbumChapter[], query: string): AlbumChapter[] {
  const q = query.trim().toLowerCase();
  if (!q) return chapters;
  const exact: AlbumChapter[] = [];
  const prefix: AlbumChapter[] = [];
  const inner: AlbumChapter[] = [];
  for (const c of chapters) {
    const title = c.title.toLowerCase();
    if (title === q) exact.push(c);
    else if (title.startsWith(q)) prefix.push(c);
    else if (title.includes(q)) inner.push(c);
  }
  return exact.concat(prefix, inner);
}

export interface ChapterSelectStepProps {
  album: Album;
  /** A specific chapter id, or null for the "Others" fallback (resolved by the caller: find an
   *  existing chapter named "Others" in this album, or create one). */
  onPickChapter: (chapterId: string | null) => void;
  /** A typed name matching no existing chapter. */
  onCreateChapter: (title: string) => void;
  onBack: () => void;
  autoFocus?: boolean;
}

/**
 * Step 2 of bulk "Add to Album": once an album is chosen, pick which of its chapters the selected
 * photos go into — same type-to-filter, Enter-picks-first-match-or-creates-new mechanic as
 * AlbumPicker, with one addition: pressing Enter with nothing typed (or clicking the pinned "Others"
 * card) always works, even for an album with no chapters yet, landing the photos in a catch-all
 * "Others" chapter instead of requiring the user to name something.
 */
export const ChapterSelectStep: React.FC<ChapterSelectStepProps> = ({
  album, onPickChapter, onCreateChapter, onBack, autoFocus = true,
}) => {
  const [query, setQuery] = useState('');
  const chapters = album.chapters || [];
  const ranked = useMemo(() => rankChaptersByQuery(chapters, query), [chapters, query]);
  // The pinned "Others" card above the list already covers a real "Others" chapter too (clicking it
  // resolves to that chapter by name) — listing it a second time among the ranked results would show
  // the same destination twice.
  const rankedForDisplay = useMemo(() => ranked.filter((c) => c.title.trim().toLowerCase() !== OTHERS_CHAPTER_TITLE.toLowerCase()), [ranked]);

  const trimmed = query.trim();
  const first = trimmed ? ranked[0] : undefined;
  const hasExactTitle = trimmed !== '' && chapters.some((c) => c.title.toLowerCase() === trimmed.toLowerCase());
  const offerCreate = trimmed !== '' && !hasExactTitle;

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation(); // keep the gallery's own keyboard shortcuts from seeing typing
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    e.preventDefault();
    if (!trimmed) {
      onPickChapter(null); // nothing typed — the "Others" fallback
      return;
    }
    if (first) onPickChapter(first.id);
    else onCreateChapter(trimmed);
  };

  const hint = !trimmed
    ? `Press Enter to add to "${OTHERS_CHAPTER_TITLE}"`
    : first
      ? `Press Enter to choose "${first.title}"`
      : `No match — press Enter to create a new chapter named "${trimmed}"`;

  const rowStyle = (emphasised: boolean): React.CSSProperties => ({
    display: 'flex', alignItems: 'center', gap: '10px', width: '100%', textAlign: 'left',
    padding: '10px 12px', borderRadius: 'var(--radius-md)', cursor: 'pointer',
    backgroundColor: emphasised ? 'rgba(59, 130, 246, 0.15)' : 'var(--bg-surface-elevated)',
    border: emphasised ? '2px solid var(--accent-primary)' : '1px solid var(--border-subtle)',
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', minHeight: 0, flex: 1 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <button type="button" className="btn btn-ghost btn-icon" onClick={onBack} style={{ width: '30px', height: '30px', flexShrink: 0 }} title="Back to album selection">
          <ArrowLeft size={16} />
        </button>
        <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          Adding to <strong style={{ color: 'var(--text-primary)' }}>{album.title}</strong> — pick a chapter
        </div>
      </div>

      <div style={{ position: 'relative' }}>
        <Search size={15} color="var(--text-muted)" style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)' }} />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={`Type a chapter name, or press Enter for "${OTHERS_CHAPTER_TITLE}"…`}
          className="input"
          style={{ width: '100%', fontSize: '0.9rem', paddingLeft: '36px' }}
          autoFocus={autoFocus}
          data-testid="chapter-select-input"
        />
      </div>

      <div data-testid="chapter-select-hint" style={{ fontSize: '0.8rem', color: 'var(--accent-emerald)', padding: '0 2px', fontWeight: 600 }}>
        {hint}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', flex: 1, minHeight: 0, overflowY: 'auto', padding: '4px' }}>
        {offerCreate && (
          <button
            type="button"
            data-testid="chapter-select-create"
            onClick={() => onCreateChapter(trimmed)}
            style={{
              ...rowStyle(false),
              border: '1px dashed var(--accent-primary)', backgroundColor: 'rgba(59, 130, 246, 0.06)', color: 'var(--accent-primary)', fontWeight: 700,
            }}
          >
            <Plus size={16} />
            <span>Create new chapter "{trimmed}"</span>
          </button>
        )}

        <button type="button" data-testid="chapter-select-others" onClick={() => onPickChapter(null)} style={rowStyle(!trimmed)}>
          <Layers size={16} color="var(--text-muted)" />
          <span style={{ flex: 1, fontWeight: 600 }}>{OTHERS_CHAPTER_TITLE}</span>
          {!trimmed && <Check size={14} color="var(--accent-primary)" />}
        </button>

        {rankedForDisplay.map((c) => {
          const isFirstMatch = first?.id === c.id;
          return (
            <button key={c.id} type="button" data-testid="chapter-select-card" data-first-match={isFirstMatch ? 'true' : undefined} onClick={() => onPickChapter(c.id)} style={rowStyle(isFirstMatch)}>
              <span style={{ flex: 1, fontWeight: isFirstMatch ? 700 : 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.title}</span>
              <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{c.photoIds.length}</span>
              {isFirstMatch && <Check size={14} color="var(--accent-primary)" />}
            </button>
          );
        })}

        {chapters.length === 0 && (
          <div style={{ padding: '6px 2px', color: 'var(--text-muted)', fontSize: '0.78rem' }}>
            This album has no chapters yet — photos land in "{OTHERS_CHAPTER_TITLE}" unless you name a new one above.
          </div>
        )}
      </div>
    </div>
  );
};
