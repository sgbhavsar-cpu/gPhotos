import React, { useState } from 'react';
import { ChevronUp, ChevronDown, Pencil, Trash2, Check, X } from 'lucide-react';
import type { AlbumChapter, Photo } from '../../../types';
import { getLocalPhotoUrl } from '../services/libraryStore';
import { VirtualCardGrid } from './VirtualCardGrid';

interface AlbumChapterSectionProps {
  chapter: AlbumChapter;
  photos: Photo[];
  scrollRef: React.RefObject<HTMLDivElement | null>;
  rowHeight: number;
  minColWidth: number;
  gap: number;
  renderTile: (photo: Photo) => React.ReactNode;
  onRename: (title: string) => void;
  onDelete: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  /** Dropping one or more dragged photos onto this section moves them into this chapter. */
  onDropPhotoIds?: (e: React.DragEvent) => void;
}

/**
 * One chapter's section: a heading bar — the chapter's "auto-generated cover", a small collage of
 * up to 4 of its own thumbnails plus its title, rendered live from CSS/`<img>`s rather than saved
 * as an actual photo file — followed by that chapter's own windowed photo grid.
 */
export const AlbumChapterSection: React.FC<AlbumChapterSectionProps> = ({
  chapter, photos, scrollRef, rowHeight, minColWidth, gap, renderTile, onRename, onDelete, onMoveUp, onMoveDown, onDropPhotoIds,
}) => {
  const [isRenaming, setIsRenaming] = useState(false);
  const [draftTitle, setDraftTitle] = useState(chapter.title);
  const [isDragOver, setIsDragOver] = useState(false);

  const collagePhotos = photos.slice(0, 4);

  const submitRename = () => {
    if (draftTitle.trim() && draftTitle.trim() !== chapter.title) onRename(draftTitle.trim());
    setIsRenaming(false);
  };

  return (
    <div
      onDragOver={onDropPhotoIds ? (e) => { e.preventDefault(); setIsDragOver(true); } : undefined}
      onDragLeave={onDropPhotoIds ? () => setIsDragOver(false) : undefined}
      onDrop={onDropPhotoIds ? (e) => { setIsDragOver(false); onDropPhotoIds(e); } : undefined}
      style={{
        borderRadius: 'var(--radius-lg)', padding: isDragOver ? '10px' : '0',
        border: isDragOver ? '2px dashed #10b981' : '2px dashed transparent',
        backgroundColor: isDragOver ? 'rgba(16, 185, 129, 0.06)' : 'transparent',
        transition: 'padding 0.1s ease',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '14px', marginBottom: '14px' }}>
        {/* Auto-generated chapter cover: a live collage of its own photos, never saved as a file. */}
        <div
          style={{
            width: '56px', height: '56px', borderRadius: 'var(--radius-md)', overflow: 'hidden', flexShrink: 0,
            display: 'grid', gridTemplateColumns: '1fr 1fr', gridTemplateRows: '1fr 1fr', gap: '1px',
            backgroundColor: 'var(--bg-surface-elevated)', border: '1px solid var(--border-subtle)',
          }}
        >
          {collagePhotos.length === 0
            ? <div style={{ gridColumn: '1 / 3', gridRow: '1 / 3', backgroundColor: 'var(--bg-surface-elevated)' }} />
            : collagePhotos.map((p) => (
              <img key={p.id} src={getLocalPhotoUrl(p.filePath, p.originalRemotePath, false, 80)} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            ))}
        </div>

        {isRenaming ? (
          <form
            onSubmit={(e) => { e.preventDefault(); submitRename(); }}
            style={{ display: 'flex', alignItems: 'center', gap: '6px', flex: 1, minWidth: 0 }}
          >
            <input autoFocus className="input" value={draftTitle} onChange={(e) => setDraftTitle(e.target.value)} style={{ fontSize: '1rem', fontWeight: 700, padding: '6px 10px', flex: 1, minWidth: 0 }} />
            <button type="submit" className="btn btn-ghost btn-icon" title="Save"><Check size={16} color="#10b981" /></button>
            <button type="button" className="btn btn-ghost btn-icon" title="Cancel" onClick={() => { setDraftTitle(chapter.title); setIsRenaming(false); }}><X size={16} /></button>
          </form>
        ) : (
          <>
            <div style={{ flex: 1, minWidth: 0 }}>
              <h3 style={{ margin: 0, fontSize: '1.05rem', fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {chapter.title}
              </h3>
              <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>{photos.length} photo{photos.length === 1 ? '' : 's'}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '2px', flexShrink: 0 }}>
              {onMoveUp && <button className="btn btn-ghost btn-icon" title="Move chapter up" onClick={onMoveUp} style={{ width: '30px', height: '30px' }}><ChevronUp size={15} /></button>}
              {onMoveDown && <button className="btn btn-ghost btn-icon" title="Move chapter down" onClick={onMoveDown} style={{ width: '30px', height: '30px' }}><ChevronDown size={15} /></button>}
              <button className="btn btn-ghost btn-icon" title="Rename chapter" onClick={() => setIsRenaming(true)} style={{ width: '30px', height: '30px' }}><Pencil size={14} /></button>
              <button className="btn btn-ghost btn-icon" title="Delete chapter (keeps its photos in the album)" onClick={onDelete} style={{ width: '30px', height: '30px' }}><Trash2 size={14} color="#f43f5e" /></button>
            </div>
          </>
        )}
      </div>

      {photos.length === 0 ? (
        <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.82rem', border: '1px dashed var(--border-subtle)', borderRadius: 'var(--radius-md)' }}>
          No photos in this chapter yet — use a photo's "Move to chapter" button below, or add new photos directly into it.
        </div>
      ) : (
        <VirtualCardGrid items={photos} getKey={(p) => p.id} scrollRef={scrollRef} rowHeight={rowHeight} minColWidth={minColWidth} gap={gap} renderItem={renderTile} />
      )}
    </div>
  );
};
