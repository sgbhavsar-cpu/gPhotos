import React, { useState } from 'react';
import { RotateCw, Sparkles, FolderPlus, Wand2, Calendar, Trash2, EyeOff, FolderInput } from 'lucide-react';
import { Photo, Album } from '../../../types';
import { libraryStore } from '../services/libraryStore';
import { createClusterFromSelectedPhotos } from '../services/deduplication';
import { autoRotateUpright } from '../services/autoRotateUpright';
import { movePhotosToFolder } from '../services/photoRelocationFlow';
import { deleteFilesWithProgress } from '../services/deleteProgress';
import { notify, notifyError } from '../services/notifications';
import { AlbumChapterPickerModal, addIdsToAlbumChapter } from './AlbumChapterPickerModal';
import { BulkEditModal } from './BulkEditModal';

interface Props {
  /** The currently selected photos (the bulk actions apply to exactly these). */
  selected: Photo[];
  /** Whole library — only needed by the album picker's cover thumbnails. */
  allPhotos: Photo[];
  /** Called after an action consumed the selection (so the caller can clear it). */
  onDone: () => void;
  onOpenDuplicateCleaner?: (cluster?: any) => void;
  onRunSmartFlow?: (photos: Photo[]) => void;
}

const btn: React.CSSProperties = { fontSize: '0.85rem', gap: '8px', padding: '6px 14px' };

/**
 * The bulk-action buttons of the main Photos selection bar (Auto-Rotate, Find Best Shot, Add to Album,
 * Run Smart Flow, Edit Info, Move to Folder, Delete, Exclude), reusable by any other photo grid.
 */
export const PhotoSelectionActions: React.FC<Props> = ({ selected, allPhotos, onDone, onOpenDuplicateCleaner, onRunSmartFlow }) => {
  const n = selected.length;
  const [rotateLabel, setRotateLabel] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [showAlbum, setShowAlbum] = useState(false);

  const autoRotate = async () => {
    setRotateLabel('Checking…');
    try {
      await autoRotateUpright(selected, {
        onProgress: (stage, done, total) => setRotateLabel(stage === 'detecting' ? `Checking ${done}/${total}…` : `Rotating ${done}/${total}…`),
      });
    } finally {
      setRotateLabel(null);
    }
  };

  const bestShot = () => {
    try {
      const cluster = createClusterFromSelectedPhotos(selected);
      if (!cluster) return notify('info', 'Select at least 2 different, visible photos to compare for the best shot.');
      onOpenDuplicateCleaner?.(cluster);
    } catch (err) {
      notifyError('Find best shot', err);
    }
  };

  const moveToFolder = async () => {
    setMoving(true);
    try {
      const res = await movePhotosToFolder(selected, { label: 'the selection' });
      if (res && res.moved > 0) onDone();
    } finally {
      setMoving(false);
    }
  };

  const exclude = () => {
    libraryStore.excludePhotos(selected.map((p) => p.id), true);
    onDone();
  };

  const closeAlbum = () => setShowAlbum(false);

  const addToAlbum = (album: Album, chapterId: string | null, newChapterTitle?: string) => {
    const ids = selected.map((p) => p.id);
    addIdsToAlbumChapter(album, chapterId, newChapterTitle, ids);
    notify('success', `Added ${ids.length} photo(s) to "${album.title}".`);
    closeAlbum();
    onDone();
  };

  const deleteSelected = async () => {
    if (!window.confirm(`Permanently delete ${n} photo(s) from disk? This cannot be undone and files cannot be restored from the Recycle Bin.`)) return;
    setDeleting(true);
    try {
      const paths = selected.map((p) => p.originalRemotePath || p.filePath);
      const { deletedPaths } = await deleteFilesWithProgress(paths);
      const gone = new Set(deletedPaths);
      const deletedIds = selected.filter((p) => gone.has(p.originalRemotePath || p.filePath)).map((p) => p.id);
      if (deletedIds.length) libraryStore.removePhotos(deletedIds);
      if (deletedIds.length < n) notify('error', `${n - deletedIds.length} of ${n} photo(s) could not be deleted.`);
      else notify('success', `Permanently deleted ${n} photo(s).`);
      onDone();
    } catch (err) {
      notifyError('Delete photos', err);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <button className="btn btn-secondary" onClick={autoRotate} disabled={!!rotateLabel || n === 0} style={btn}
        title="Turn the selected photos upright automatically (faces decide the orientation)">
        <RotateCw size={16} className={rotateLabel ? 'animate-spin' : ''} />
        <span>{rotateLabel ?? `Auto-Rotate Upright (${n})`}</span>
      </button>

      {n >= 2 && onOpenDuplicateCleaner && (
        <button className="btn btn-primary" onClick={bestShot}
          style={{ ...btn, background: 'linear-gradient(135deg, #6366f1 0%, #a855f7 100%)', borderColor: '#a855f7', color: 'white', fontWeight: 600 }}
          title="Compare the selected photos and keep the best">
          <Sparkles size={16} /><span>Find Best Shot ({n})</span>
        </button>
      )}

      <button className="btn btn-secondary" onClick={() => setShowAlbum(true)} disabled={n === 0} style={btn} title="Add selected photos to an album">
        <FolderPlus size={16} color="var(--accent-primary)" /><span>Add to Album</span>
      </button>

      {onRunSmartFlow && (
        <button className="btn btn-secondary" onClick={() => onRunSmartFlow(selected)} disabled={n === 0} style={btn}
          title="Run one of your Smart Flows against just the selected photos">
          <Wand2 size={16} color="#c084fc" /><span>Run Smart Flow ({n})</span>
        </button>
      )}

      <button className="btn btn-secondary" onClick={() => setShowEdit(true)} disabled={n === 0} style={btn}
        title="Set date/time, location, or AI caption/tags on all selected photos at once">
        <Calendar size={16} color="var(--accent-cyan)" /><span>Edit Info ({n})</span>
      </button>

      <button className="btn btn-secondary" onClick={moveToFolder} disabled={moving || n === 0} style={btn}
        title="Move the original files of the selected photos to another folder">
        <FolderInput size={16} color="var(--accent-primary)" /><span>{moving ? 'Moving…' : `Move to Folder (${n})`}</span>
      </button>

      <button className="btn btn-secondary" onClick={deleteSelected} disabled={deleting || n === 0}
        style={{ ...btn, color: '#ef4444', borderColor: 'rgba(239, 68, 68, 0.4)', backgroundColor: 'rgba(239, 68, 68, 0.1)' }}
        title="Permanently delete selected photos from disk">
        <Trash2 size={16} color="#ef4444" /><span>{deleting ? 'Deleting…' : `Delete Selected (${n})`}</span>
      </button>

      <button className="btn btn-secondary" onClick={exclude} disabled={n === 0} style={{ ...btn, color: 'var(--accent-rose)' }}
        title="Exclude selected photos from views without deleting source files">
        <EyeOff size={16} /><span>Exclude from App ({n})</span>
      </button>

      {showEdit && <BulkEditModal photos={selected} onClose={() => setShowEdit(false)} />}

      {showAlbum && (
        <AlbumChapterPickerModal title={`Add to Album (${n})`} allPhotos={allPhotos} onClose={closeAlbum}
          onConfirm={(album, chapterId, newTitle) => addToAlbum(album, chapterId, newTitle)} />
      )}
    </>
  );
};
