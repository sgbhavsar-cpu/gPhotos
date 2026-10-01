import React, { useMemo, useState } from 'react';
import { Check, Plus, Search, BookImage } from 'lucide-react';
import { Album, Photo } from '../../../types';
import { getLocalPhotoUrl } from '../services/libraryStore';

/**
 * Orders albums for a typed query: exact title first, then titles that START with the text, then
 * titles that contain it. Within each group the incoming order is kept, so the result is stable. An
 * empty query returns every album unchanged. The first entry is what pressing Enter picks.
 */
export function rankAlbumsByQuery(albums: Album[], query: string): Album[] {
  const q = query.trim().toLowerCase();
  if (!q) return albums;
  const exact: Album[] = [];
  const prefix: Album[] = [];
  const inner: Album[] = [];
  for (const a of albums) {
    const title = a.title.toLowerCase();
    if (title === q) exact.push(a);
    else if (title.startsWith(q)) prefix.push(a);
    else if (title.includes(q)) inner.push(a);
  }
  return exact.concat(prefix, inner);
}

export interface AlbumPickerProps {
  albums: Album[];
  /** Used only to resolve each album's cover photo; may be the whole library. */
  photos: Photo[];
  /** Clicking a card, or pressing Enter with a match, calls this straight away (no confirm step). */
  onPick: (album: Album) => void;
  /** Typing a title that matches no album offers "Create new album" (click or Enter). */
  onCreateNew: (title: string) => void;
  /** Album already chosen elsewhere (shown ticked). */
  selectedId?: string | null;
  placeholder?: string;
  autoFocus?: boolean;
  /** Cards rendered at most (cover images are costly); searching narrows the list. */
  maxCards?: number;
  /** Cap the list's height (e.g. inside a small dialog). Default: fill the parent. */
  listMaxHeight?: number | string;
  columnMinWidth?: number;
  /** Text shown when the library has no albums to pick from. */
  emptyText?: string;
}

/**
 * The album counterpart of PersonPicker: an autofocused search box that filters as you type, a
 * grid of cover-photo + title cards, and "Create new album «title»" when nothing matches — so
 * adding photos to an album works the same way as picking a person, right down to Enter choosing
 * the first match (or creating a new album when there is none).
 */
export const AlbumPicker: React.FC<AlbumPickerProps> = ({
  albums,
  photos,
  onPick,
  onCreateNew,
  selectedId = null,
  placeholder = 'Type an album name to search…',
  autoFocus = true,
  maxCards = 150,
  listMaxHeight,
  columnMinWidth = 220,
  emptyText = 'No albums yet.',
}) => {
  const [query, setQuery] = useState('');

  const photoMap = useMemo(() => new Map(photos.map((p) => [p.id, p])), [photos]);
  const coverOf = (album: Album): Photo | null =>
    (album.coverPhotoId && photoMap.get(album.coverPhotoId)) ||
    (album.photoIds.length > 0 && photoMap.get(album.photoIds[0])) ||
    null;

  const ranked = useMemo(() => rankAlbumsByQuery(albums, query), [albums, query]);
  const trimmed = query.trim();
  const first = trimmed ? ranked[0] : undefined;
  const hasExactTitle = trimmed !== '' && albums.some((a) => a.title.toLowerCase() === trimmed.toLowerCase());
  const offerCreate = trimmed !== '' && !hasExactTitle;

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation(); // keep the gallery's own keyboard shortcuts from seeing typing
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    e.preventDefault();
    if (!trimmed) return;
    if (first) onPick(first);
    else onCreateNew(trimmed);
  };

  const hint = !trimmed
    ? null
    : first
      ? `Press Enter to choose "${first.title}"`
      : `No match — press Enter to create a new album named "${trimmed}"`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', minHeight: 0, flex: listMaxHeight ? undefined : 1 }}>
      <div style={{ position: 'relative' }}>
        <Search size={15} color="var(--text-muted)" style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)' }} />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          className="input"
          style={{ width: '100%', fontSize: '0.9rem', paddingLeft: '36px' }}
          autoFocus={autoFocus}
          data-testid="album-picker-input"
        />
      </div>

      {hint && (
        <div data-testid="album-picker-hint" style={{ fontSize: '0.8rem', color: first ? 'var(--accent-emerald)' : 'var(--text-muted)', padding: '0 2px', fontWeight: first ? 600 : 400 }}>
          {hint}
        </div>
      )}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(auto-fill, minmax(${columnMinWidth}px, 1fr))`,
          gap: '10px',
          flex: listMaxHeight ? undefined : 1,
          minHeight: 0,
          maxHeight: listMaxHeight,
          overflowY: 'auto',
          padding: '4px',
          alignContent: 'start',
        }}
      >
        {offerCreate && (
          <div
            role="button"
            tabIndex={0}
            data-testid="album-picker-create"
            onClick={() => onCreateNew(trimmed)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.stopPropagation(); onCreateNew(trimmed); }
            }}
            title={`Create a new album named ${trimmed}`}
            style={{
              display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 12px', borderRadius: 'var(--radius-md)',
              border: '1px dashed var(--accent-primary)', backgroundColor: 'rgba(59, 130, 246, 0.06)', cursor: 'pointer',
              color: 'var(--accent-primary)', fontWeight: 700, fontSize: '0.88rem', gridColumn: '1 / -1',
            }}
          >
            <Plus size={18} />
            <span>Create new album "{trimmed}"</span>
          </div>
        )}

        {ranked.length === 0 ? (
          !offerCreate && (
            <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.85rem', gridColumn: '1 / -1' }}>
              {albums.length === 0 ? emptyText : 'No matching albums.'}
            </div>
          )
        ) : (
          ranked.slice(0, maxCards).map((a) => {
            const isSelected = selectedId === a.id;
            const isFirstMatch = first?.id === a.id;
            const cover = coverOf(a);
            const emphasised = isSelected || isFirstMatch;

            return (
              <div
                key={a.id}
                role="button"
                tabIndex={0}
                title={`Choose ${a.title}`}
                data-testid="album-picker-card"
                data-first-match={isFirstMatch ? 'true' : undefined}
                onClick={() => onPick(a)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onPick(a); }
                }}
                style={{
                  display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 12px', borderRadius: 'var(--radius-md)',
                  backgroundColor: emphasised ? 'rgba(59, 130, 246, 0.15)' : 'var(--bg-surface-elevated)',
                  border: emphasised ? '2px solid var(--accent-primary)' : '1px solid var(--border-subtle)',
                  cursor: 'pointer', boxShadow: emphasised ? '0 0 14px rgba(59, 130, 246, 0.4)' : 'none', transition: 'all 0.15s ease',
                }}
              >
                <div style={{ position: 'relative', width: '52px', height: '52px', flexShrink: 0, borderRadius: 'var(--radius-sm)', overflow: 'hidden', backgroundColor: 'rgba(255, 255, 255, 0.08)' }}>
                  {cover ? (
                    <img src={getLocalPhotoUrl(cover.filePath, cover.originalRemotePath, false, 80)} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  ) : (
                    <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <BookImage size={22} color="var(--text-muted)" />
                    </div>
                  )}
                  {isSelected && (
                    <div style={{ position: 'absolute', bottom: 0, right: 0, width: '18px', height: '18px', borderRadius: '50%', backgroundColor: 'var(--accent-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 2px 6px rgba(0,0,0,0.6)' }}>
                      <Check size={11} color="#fff" strokeWidth={3} />
                    </div>
                  )}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '0.88rem', fontWeight: 700, color: emphasised ? 'var(--accent-primary)' : 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {a.title}
                  </div>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '2px' }}>
                    {a.photoIds.length} {a.photoIds.length === 1 ? 'photo' : 'photos'}
                  </div>
                </div>
              </div>
            );
          })
        )}

        {ranked.length > maxCards && (
          <div style={{ gridColumn: '1 / -1', padding: '8px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.78rem' }}>
            Showing {maxCards} of {ranked.length} albums — type a name to narrow the list.
          </div>
        )}
      </div>
    </div>
  );
};
