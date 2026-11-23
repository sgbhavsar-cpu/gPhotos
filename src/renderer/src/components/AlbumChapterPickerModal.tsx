import React, { useEffect, useState } from 'react';
import { useEscapeLayer } from '../services/escapeStack';
import { BookImage, X } from 'lucide-react';
import { Photo, Album } from '../../../types';
import { libraryStore } from '../services/libraryStore';
import { AlbumPicker } from './AlbumPicker';
import { ChapterSelectStep } from './ChapterSelectStep';

/**
 * Common "pick an album, then a chapter" dialog (used by Add to Album and Move to Album).
 * Calls onConfirm with the album and either an existing chapterId, a new chapter title, or neither (→ "Others").
 */
export const AlbumChapterPickerModal: React.FC<{
  title: string;
  allPhotos: Photo[];
  /** Albums not offered (e.g. the album the photos are being moved out of). */
  excludeAlbumId?: string;
  onConfirm: (album: Album, chapterId: string | null, newChapterTitle?: string) => void;
  onClose: () => void;
  /** Skip the album step: pick a chapter inside this album only (Back closes the dialog). */
  fixedAlbum?: Album;
}> = ({ title, allPhotos, excludeAlbumId, onConfirm, onClose, fixedAlbum }) => {
  const [pending, setPending] = useState<Album | null>(fixedAlbum ?? null);
  useEscapeLayer(true, onClose);
  return (
    <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(5, 8, 15, 0.88)', backdropFilter: 'blur(10px)', zIndex: 3500, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' }}
      onClick={onClose}>
      <div style={{ width: '100%', maxWidth: '480px', maxHeight: '80vh', backgroundColor: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-lg)', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}
        onClick={(e) => e.stopPropagation()}>
        <div style={{ padding: '18px 24px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <BookImage size={22} color="var(--accent-primary)" />
            <h3 style={{ fontSize: '1.2rem', fontWeight: 700, margin: 0 }}>{title}</h3>
          </div>
          <button className="btn btn-ghost btn-icon" onClick={onClose}><X size={20} /></button>
        </div>
        <div style={{ padding: '18px 24px', minHeight: 0, flex: 1, display: 'flex' }}>
          {pending ? (
            <ChapterSelectStep
              album={pending}
              onBack={() => (fixedAlbum ? onClose() : setPending(null))}
              onPickChapter={(chapterId) => onConfirm(pending, chapterId)}
              onCreateChapter={(t) => onConfirm(pending, null, t)}
            />
          ) : (
            <AlbumPicker
              albums={(libraryStore.getState().albums || []).filter((a) => a.id !== excludeAlbumId)}
              photos={allPhotos}
              onPick={setPending}
              onCreateNew={(t) => setPending(libraryStore.createAlbum(t))}
              listMaxHeight={360}
            />
          )}
        </div>
      </div>
    </div>
  );
};

/** Adds photoIds to the chosen album/chapter (same rules the Photos-grid "Add to Album" uses). */
export function addIdsToAlbumChapter(album: Album, chapterId: string | null, newChapterTitle: string | undefined, ids: string[]) {
  if (newChapterTitle) libraryStore.createChapter(album.id, newChapterTitle, ids);
  else {
    const target = chapterId || (album.chapters || []).find((c) => c.title.trim().toLowerCase() === 'others')?.id;
    if (target) libraryStore.addPhotosToChapter(album.id, target, ids);
    else libraryStore.createChapter(album.id, 'Others', ids);
  }
}
