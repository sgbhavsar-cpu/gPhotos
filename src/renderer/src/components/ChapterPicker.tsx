import React, { useState } from 'react';
import { Check, FolderPlus, Layers } from 'lucide-react';
import type { AlbumChapter } from '../../../types';

interface ChapterPickerProps {
  chapters: AlbumChapter[];
  /** null/undefined = the album's default (no-chapter) bucket. */
  currentChapterId?: string | null;
  onPick: (chapterId: string | null) => void;
  onCreateNew: (title: string) => void;
  onClose: () => void;
  /** Anchors the popover under/near the trigger element instead of screen-centering it. */
  anchorStyle?: React.CSSProperties;
}

/**
 * A small popover for picking which chapter of an album a photo should go into (or "No chapter").
 * Used both for reassigning an already-chaptered photo (AlbumsView) and for choosing a chapter
 * before a quick "Add to Album" (PhotoLightbox). A full-screen invisible backdrop closes it on an
 * outside click, matching this app's existing modal-close convention.
 */
export const ChapterPicker: React.FC<ChapterPickerProps> = ({ chapters, currentChapterId, onPick, onCreateNew, onClose, anchorStyle }) => {
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');

  const rowStyle = (active: boolean): React.CSSProperties => ({
    display: 'flex', alignItems: 'center', gap: '8px', width: '100%', textAlign: 'left',
    padding: '8px 12px', border: 'none', borderRadius: 'var(--radius-md)', cursor: 'pointer',
    background: active ? 'rgba(59, 130, 246, 0.15)' : 'transparent', color: 'var(--text-primary)', fontSize: '0.85rem',
  });

  return (
    <>
      <div style={{ position: 'fixed', inset: 0, zIndex: 1200 }} onClick={onClose} />
      <div
        style={{
          position: 'absolute', zIndex: 1201, minWidth: '220px', maxWidth: '280px',
          backgroundColor: 'var(--bg-surface-elevated)', border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-lg)', boxShadow: '0 12px 32px rgba(0,0,0,0.5)', padding: '6px',
          display: 'flex', flexDirection: 'column', gap: '2px', maxHeight: '260px', overflowY: 'auto',
          ...anchorStyle,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <button type="button" style={rowStyle(!currentChapterId)} onClick={() => onPick(null)}>
          <Layers size={14} color="var(--text-muted)" />
          <span style={{ flex: 1 }}>No chapter</span>
          {!currentChapterId && <Check size={14} color="var(--accent-primary)" />}
        </button>
        {chapters.map((c) => (
          <button key={c.id} type="button" style={rowStyle(currentChapterId === c.id)} onClick={() => onPick(c.id)}>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.title}</span>
            {currentChapterId === c.id && <Check size={14} color="var(--accent-primary)" />}
          </button>
        ))}
        <div style={{ borderTop: '1px solid var(--border-subtle)', margin: '4px 0' }} />
        {creating ? (
          <form
            onSubmit={(e) => { e.preventDefault(); if (newTitle.trim()) onCreateNew(newTitle.trim()); }}
            style={{ display: 'flex', gap: '6px', padding: '4px 6px' }}
          >
            <input
              autoFocus
              className="input"
              placeholder="Chapter name"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              style={{ flex: 1, fontSize: '0.82rem', padding: '6px 8px' }}
            />
            <button type="submit" className="btn btn-primary" style={{ padding: '4px 10px', fontSize: '0.8rem' }} disabled={!newTitle.trim()}>Add</button>
          </form>
        ) : (
          <button type="button" style={rowStyle(false)} onClick={() => setCreating(true)}>
            <FolderPlus size={14} color="var(--accent-primary)" />
            <span>New chapter…</span>
          </button>
        )}
      </div>
    </>
  );
};
