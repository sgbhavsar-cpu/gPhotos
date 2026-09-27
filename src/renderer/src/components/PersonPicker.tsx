import React, { useMemo, useState } from 'react';
import { Check, Plus, Search, UserCheck } from 'lucide-react';
import { Person, Photo } from '../../../types';
import { FaceAvatar } from './FaceAvatar';

/**
 * Orders people for a typed query: exact name first, then names that START with the text, then names that
 * contain it. Within each group the incoming order is kept, so the result is stable. An empty query returns
 * everyone unchanged. The first entry is what pressing Enter picks.
 */
export function rankPeopleByQuery(people: Person[], query: string): Person[] {
  const q = query.trim().toLowerCase();
  if (!q) return people;
  const exact: Person[] = [];
  const prefix: Person[] = [];
  const inner: Person[] = [];
  for (const p of people) {
    const name = p.name.toLowerCase();
    if (name === q) exact.push(p);
    else if (name.startsWith(q)) prefix.push(p);
    else if (name.includes(q)) inner.push(p);
  }
  return exact.concat(prefix, inner);
}

export interface PersonPickerProps {
  people: Person[];
  /** Used only to find each person's cover face; may be the whole library. */
  photos: Photo[];
  /** Clicking a card, or pressing Enter with a match, calls this straight away (no confirm step). */
  onPick: (person: Person) => void;
  /** Person already chosen elsewhere (shown ticked). */
  selectedId?: string | null;
  /**
   * When set, typing a name that matches nobody offers "Create new person" (click or Enter).
   * A partial match still picks the first match on Enter; the create row is then a click target.
   */
  onCreateNew?: (name: string) => void;
  /** Enter on a first match that is already `selectedId` calls this instead (e.g. "confirm the merge"). */
  onEnterOnSelected?: () => void;
  placeholder?: string;
  autoFocus?: boolean;
  /** Cards rendered at most (avatars are costly); searching narrows the list. */
  maxCards?: number;
  /** Cap the list's height (e.g. inside a small dialog). Default: fill the parent. */
  listMaxHeight?: number | string;
  columnMinWidth?: number;
  /** Text shown when the library has nobody to pick. */
  emptyText?: string;
}

export const PersonPicker: React.FC<PersonPickerProps> = ({
  people,
  photos,
  onPick,
  selectedId = null,
  onCreateNew,
  onEnterOnSelected,
  placeholder = 'Type a name to search…',
  autoFocus = true,
  maxCards = 150,
  listMaxHeight,
  columnMinWidth = 220,
  emptyText = 'No people to choose from.',
}) => {
  const [query, setQuery] = useState('');

  // One pass over the library instead of a scan per card per keystroke.
  const coverLookup = useMemo(() => {
    const byId = new Map<string, Photo>();
    const firstWithPerson = new Map<string, Photo>();
    for (const ph of photos) {
      byId.set(ph.id, ph);
      if (ph.faces) {
        for (const f of ph.faces) {
          if (f.personId && !firstWithPerson.has(f.personId)) firstWithPerson.set(f.personId, ph);
        }
      }
    }
    return { byId, firstWithPerson };
  }, [photos]);

  const ranked = useMemo(() => rankPeopleByQuery(people, query), [people, query]);
  const trimmed = query.trim();
  const first = trimmed ? ranked[0] : undefined;
  const hasExactName = trimmed !== '' && people.some((p) => p.name.toLowerCase() === trimmed.toLowerCase());
  const offerCreate = !!onCreateNew && trimmed !== '' && !hasExactName;

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation(); // keep the lightbox / gallery shortcuts from seeing typing
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    e.preventDefault();
    if (!trimmed) return;
    if (first) {
      if (first.id === selectedId && onEnterOnSelected) onEnterOnSelected();
      else onPick(first);
    } else if (onCreateNew) {
      onCreateNew(trimmed);
    }
  };

  const hint = !trimmed
    ? null
    : first
      ? `Press Enter to choose "${first.name}"`
      : onCreateNew
        ? `No match — press Enter to create a new person named "${trimmed}"`
        : 'No match';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', minHeight: 0, flex: listMaxHeight ? undefined : 1 }}>
      <div style={{ position: 'relative' }}>
        <Search
          size={15}
          color="var(--text-muted)"
          style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)' }}
        />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          className="input"
          style={{ width: '100%', fontSize: '0.9rem', paddingLeft: '36px' }}
          autoFocus={autoFocus}
          data-testid="person-picker-input"
        />
      </div>

      {hint && (
        <div
          data-testid="person-picker-hint"
          style={{ fontSize: '0.8rem', color: first ? 'var(--accent-emerald)' : 'var(--text-muted)', padding: '0 2px', fontWeight: first ? 600 : 400 }}
        >
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
            data-testid="person-picker-create"
            onClick={() => onCreateNew!(trimmed)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.stopPropagation();
                onCreateNew!(trimmed);
              }
            }}
            title={`Create a new person named ${trimmed}`}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '12px',
              padding: '10px 12px',
              borderRadius: 'var(--radius-md)',
              border: '1px dashed var(--accent-primary)',
              backgroundColor: 'rgba(59, 130, 246, 0.06)',
              cursor: 'pointer',
              color: 'var(--accent-primary)',
              fontWeight: 700,
              fontSize: '0.88rem',
              gridColumn: '1 / -1',
            }}
          >
            <Plus size={18} />
            <span>Create new person "{trimmed}"</span>
          </div>
        )}

        {ranked.length === 0 ? (
          !offerCreate && (
            <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.85rem', gridColumn: '1 / -1' }}>
              {people.length === 0 ? emptyText : 'No matching people.'}
            </div>
          )
        ) : (
          ranked.slice(0, maxCards).map((p) => {
            const isSelected = selectedId === p.id;
            const isFirstMatch = first?.id === p.id;
            const personPhoto =
              (p.coverPhotoId ? coverLookup.byId.get(p.coverPhotoId) : undefined) || coverLookup.firstWithPerson.get(p.id);
            const personFace = personPhoto?.faces?.find((f) => f.personId === p.id);
            const emphasised = isSelected || isFirstMatch;

            return (
              <div
                key={p.id}
                role="button"
                tabIndex={0}
                title={`Choose ${p.name}`}
                data-testid="person-picker-card"
                data-first-match={isFirstMatch ? 'true' : undefined}
                onClick={() => onPick(p)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    e.stopPropagation();
                    onPick(p);
                  }
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '12px',
                  padding: '10px 12px',
                  borderRadius: 'var(--radius-md)',
                  backgroundColor: emphasised ? 'rgba(59, 130, 246, 0.15)' : 'var(--bg-surface-elevated)',
                  border: emphasised ? '2px solid var(--accent-primary)' : '1px solid var(--border-subtle)',
                  cursor: 'pointer',
                  boxShadow: emphasised ? '0 0 14px rgba(59, 130, 246, 0.4)' : 'none',
                  transition: 'all 0.15s ease',
                }}
              >
                <div style={{ position: 'relative', width: '52px', height: '52px', flexShrink: 0, borderRadius: '50%', overflow: 'hidden' }}>
                  {personPhoto ? (
                    <FaceAvatar photo={personPhoto} face={personFace} box={personFace?.box} size={52} alt={p.name} personId={p.id} />
                  ) : (
                    <div
                      style={{
                        width: '52px',
                        height: '52px',
                        borderRadius: '50%',
                        backgroundColor: 'rgba(255, 255, 255, 0.08)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <UserCheck size={24} color="var(--text-muted)" />
                    </div>
                  )}
                  {isSelected && (
                    <div
                      style={{
                        position: 'absolute',
                        bottom: 0,
                        right: 0,
                        width: '18px',
                        height: '18px',
                        borderRadius: '50%',
                        backgroundColor: 'var(--accent-primary)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        boxShadow: '0 2px 6px rgba(0,0,0,0.6)',
                      }}
                    >
                      <Check size={11} color="#fff" strokeWidth={3} />
                    </div>
                  )}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: '0.88rem',
                      fontWeight: 700,
                      color: emphasised ? 'var(--accent-primary)' : 'var(--text-primary)',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {p.name}
                  </div>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '2px' }}>
                    {p.photoCount} {p.photoCount === 1 ? 'photo' : 'photos'}
                  </div>
                </div>
              </div>
            );
          })
        )}

        {ranked.length > maxCards && (
          <div style={{ gridColumn: '1 / -1', padding: '8px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.78rem' }}>
            Showing {maxCards} of {ranked.length} people — type a name to narrow the list.
          </div>
        )}
      </div>
    </div>
  );
};
