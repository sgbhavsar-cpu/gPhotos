import React, { useState, useMemo, useEffect, useRef, useDeferredValue } from 'react';
import {
  FolderPlus,
  Image as ImageIcon,
  Calendar,
  Trash2,
  FolderInput,
  ArrowLeft,
  Plus,
  X,
  Check,
  Star,
  Search,
  BookImage,
  FolderHeart,
  Camera,
  Layers,
  Sparkles,
  ZoomIn,
  ZoomOut,
  Film
} from 'lucide-react';
import { Album, Photo } from '../../../types';
import { libraryStore, getLocalPhotoUrl } from '../services/libraryStore';
import { useIsMobile } from '../hooks/useIsMobile';
import { VirtualCardGrid } from '../components/VirtualCardGrid';
import { AlbumChapterSection } from '../components/AlbumChapterSection';
import { ChapterPicker } from '../components/ChapterPicker';
import { VideoWizardModal } from '../components/VideoWizardModal';
import { PromptModal } from '../components/PromptModal';
import { useMarqueeSelect, MarqueeBox, ChapterDropBar, AlbumSelectionBar } from '../components/albumSelection';
import { movePhotosToFolder } from '../services/photoRelocationFlow';

interface AlbumsViewProps {
  photos: Photo[];
  albums: Album[];
  // contextPhotos, when provided, is the ordered list the caller should use
  // for lightbox next/prev navigation instead of the whole library — here,
  // the currently open album's own photos, so browsing an album's lightbox
  // stays inside that album.
  onSelectPhoto: (photo: Photo, contextPhotos?: Photo[]) => void;
  /** Opens Smart Flows pre-scoped to the given photos (the current drag-selection). */
  onRunSmartFlow?: (photos: Photo[]) => void;
  resetTrigger?: number;
}

export const AlbumsView: React.FC<AlbumsViewProps> = ({
  photos,
  albums,
  onSelectPhoto,
  onRunSmartFlow,
  resetTrigger,
}) => {
  const [selectedAlbumId, setSelectedAlbumId] = useState<string | null>(null);
  const isMobile = useIsMobile();

  // Image size toolbar for the album detail grid — same XS/S/M/L levels and
  // controls as the main Photos gallery's zoom toolbar, for a consistent
  // feel, but independent of it: an album's grid is a plain (non-virtualized)
  // CSS grid, not the timeline's column-virtualized one, so it just needs a
  // pixel-size knob rather than the full years/months zoom system.
  const ALBUM_GRID_SIZES = ['very_small', 'small', 'medium', 'large'] as const;
  type AlbumGridSize = (typeof ALBUM_GRID_SIZES)[number];
  const ALBUM_GRID_SIZE_PX: Record<AlbumGridSize, number> = {
    very_small: 120,
    small: 160,
    medium: 200,
    large: 280,
  };
  const [albumGridSize, setAlbumGridSize] = useState<AlbumGridSize>('medium');
  // Both photo grids (album detail, add-photos picker) are windowed by VirtualCardGrid against
  // these scroll containers, so every photo is reachable without capping the tile count.
  const albumScrollRef = useRef<HTMLDivElement>(null);
  const pickerScrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (resetTrigger) {
      setSelectedAlbumId(null);
    }
  }, [resetTrigger]);

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showAddPhotosModal, setShowAddPhotosModal] = useState(false);
  const [photoSearchQuery, setPhotoSearchQuery] = useState('');
  const [selectedPhotoIdsToAdd, setSelectedPhotoIdsToAdd] = useState<Set<string>>(new Set());
  const [addToChapterId, setAddToChapterId] = useState<string>('');
  // Picker filters — Person reuses face-detection data already in the app
  // ("Filter by AI"); a from-scratch scene/object filter isn't built yet.
  const [photoFilterPersonId, setPhotoFilterPersonId] = useState('');
  const [photoFilterLocation, setPhotoFilterLocation] = useState('');
  const [photoFilterDateFrom, setPhotoFilterDateFrom] = useState('');
  const [photoFilterDateTo, setPhotoFilterDateTo] = useState('');

  // Handle Escape key navigation inside AlbumsView
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;

      // stopImmediatePropagation, not stopPropagation — see PeopleView's
      // matching Escape handler for why (App.tsx's global handler is also
      // bound to `window` and stopPropagation alone won't stop it firing).
      if (showAddPhotosModal) {
        e.stopImmediatePropagation();
        setShowAddPhotosModal(false);
      } else if (showCreateModal) {
        e.stopImmediatePropagation();
        setShowCreateModal(false);
      } else if (selectedAlbumId) {
        e.stopImmediatePropagation();
        setSelectedAlbumId(null);
      }
    };

    // capture: true — see PeopleView's matching Escape handler for why.
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, [showAddPhotosModal, showCreateModal, selectedAlbumId]);

  // Form states for Create Album
  const [newTitle, setNewTitle] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [newEventDate, setNewEventDate] = useState('');

  // Quick lookup maps
  const photoMap = useMemo(() => {
    const map = new Map<string, Photo>();
    for (const p of photos) {
      map.set(p.id, p);
    }
    return map;
  }, [photos]);

  const activeAlbum = useMemo(() => {
    return albums.find((a) => a.id === selectedAlbumId) || null;
  }, [albums, selectedAlbumId]);

  // Photos belonging to the active album
  const albumPhotos = useMemo(() => {
    if (!activeAlbum) return [];
    return activeAlbum.photoIds
      .map((id) => photoMap.get(id))
      .filter((p): p is Photo => p !== undefined);
  }, [activeAlbum, photoMap]);

  // Keystrokes stay responsive: the (100k-photo) filter below runs on the deferred query.
  const deferredSearchQuery = useDeferredValue(photoSearchQuery);

  // Available photos not in this album (for picker)
  const availablePhotosForAlbum = useMemo(() => {
    if (!activeAlbum) return [];
    const existing = new Set(activeAlbum.photoIds);
    let candidates = photos.filter((p) => !existing.has(p.id) && !p.isExcluded);

    if (deferredSearchQuery.trim()) {
      const q = deferredSearchQuery.trim().toLowerCase();
      candidates = candidates.filter(
        (p) =>
          (p.fileName || '').toLowerCase().includes(q) ||
          p.location?.city?.toLowerCase().includes(q) ||
          p.location?.country?.toLowerCase().includes(q)
      );
    }
    if (photoFilterPersonId) {
      candidates = candidates.filter((p) => p.faces?.some((f) => f.personId === photoFilterPersonId));
    }
    if (photoFilterLocation) {
      candidates = candidates.filter((p) => (p.location?.city || p.location?.label) === photoFilterLocation);
    }
    if (photoFilterDateFrom) {
      const from = new Date(photoFilterDateFrom).getTime();
      candidates = candidates.filter((p) => new Date(p.dateTaken).getTime() >= from);
    }
    if (photoFilterDateTo) {
      // Inclusive of the whole end day, not just midnight.
      const to = new Date(photoFilterDateTo).getTime() + 24 * 60 * 60 * 1000 - 1;
      candidates = candidates.filter((p) => new Date(p.dateTaken).getTime() <= to);
    }
    return candidates;
  }, [photos, activeAlbum, deferredSearchQuery, photoFilterPersonId, photoFilterLocation, photoFilterDateFrom, photoFilterDateTo]);

  // Filter dropdown options, derived from the library so they only ever
  // show choices that actually exist rather than a generic fixed list.
  const filterablePeople = useMemo(() => {
    return libraryStore.getState().people.filter((p) => p.photoCount > 0);
  }, [photos]);

  const filterableLocations = useMemo(() => {
    const names = new Set<string>();
    for (const p of photos) {
      const name = p.location?.city || p.location?.label;
      if (name) names.add(name);
    }
    return Array.from(names).sort();
  }, [photos]);

  const handleCreateAlbum = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim()) return;

    const created = libraryStore.createAlbum(
      newTitle.trim(),
      newDescription.trim() || undefined,
      newEventDate.trim() || undefined
    );

    setNewTitle('');
    setNewDescription('');
    setNewEventDate('');
    setShowCreateModal(false);
    setSelectedAlbumId(created.id);
  };

  // "Move to Folder…": physically moves every photo of the open album (see photoRelocationFlow.ts).
  const [moveProgress, setMoveProgress] = useState<{ done: number; total: number } | null>(null);
  const handleMoveAlbumToFolder = async () => {
    if (!activeAlbum || moveProgress) return;
    setMoveProgress({ done: 0, total: albumPhotos.length });
    try {
      await movePhotosToFolder(albumPhotos, {
        label: `the album "${activeAlbum.title}"`,
        onProgress: (done, total) => setMoveProgress({ done, total }),
      });
    } finally {
      setMoveProgress(null);
    }
  };

  const handleDeleteAlbum = (albumId: string, albumTitle: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    const confirmed = window.confirm(`Delete the album "${albumTitle}"?\n\n(Photos will remain in your library; only the album collection is removed.)`);
    if (!confirmed) return;

    libraryStore.deleteAlbum(albumId);
    if (selectedAlbumId === albumId) {
      setSelectedAlbumId(null);
    }
  };

  const handleAddSelectedPhotos = () => {
    if (!activeAlbum || selectedPhotoIdsToAdd.size === 0) return;
    const ids = Array.from(selectedPhotoIdsToAdd);
    if (addToChapterId) libraryStore.addPhotosToChapter(activeAlbum.id, addToChapterId, ids);
    else libraryStore.addPhotosToAlbum(activeAlbum.id, ids);
    setSelectedPhotoIdsToAdd(new Set());
    setShowAddPhotosModal(false);
  };

  const handleRemovePhotoFromAlbum = (photoId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!activeAlbum) return;
    libraryStore.removePhotosFromAlbum(activeAlbum.id, [photoId]);
  };

  const handleSetCoverPhoto = (photoId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!activeAlbum) return;
    libraryStore.setAlbumCover(activeAlbum.id, photoId);
  };

  const [showVideoWizard, setShowVideoWizard] = useState(false);

  // Chapters
  const [movePhotoPopoverId, setMovePhotoPopoverId] = useState<string | null>(null);
  const [showNewChapterPrompt, setShowNewChapterPrompt] = useState(false);
  // Photos picked (in the chapter view itself, not the Add-Photos picker) to drag as a group
  // between chapters. A drag that starts on a photo NOT in this set just drags that one photo.
  const [dragSelectedIds, setDragSelectedIds] = useState<Set<string>>(new Set());
  const [dragOverTarget, setDragOverTarget] = useState<string | null>(null); // chapterId, or 'unchaptered'
  // How many photos are being dragged right now (0 = no drag): while > 0 the chapter drop bar is shown.
  const [draggingCount, setDraggingCount] = useState(0);
  // Rubber-band selection: press on empty space (or a photo's checkbox) and drag across photos.
  const marquee = useMarqueeSelect({
    containerRef: albumScrollRef,
    selected: dragSelectedIds,
    onChange: setDragSelectedIds,
    enabled: !!selectedAlbumId && !showAddPhotosModal,
  });
  // A new album (or leaving one) starts with nothing selected.
  useEffect(() => { setDragSelectedIds(new Set()); setDraggingCount(0); }, [selectedAlbumId]);
  // The drag ends on the dragged tile — which the windowed grid may have unmounted (or the drop may land elsewhere) —
  // so the drop bar is also put away by document-level events.
  useEffect(() => {
    const stop = () => setDraggingCount(0);
    document.addEventListener('dragend', stop);
    document.addEventListener('drop', stop);
    return () => { document.removeEventListener('dragend', stop); document.removeEventListener('drop', stop); };
  }, []);
  const chapterOfPhoto = (photoId: string): string | null =>
    activeAlbum?.chapters?.find((c) => c.photoIds.includes(photoId))?.id ?? null;

  const handleCreateChapter = () => setShowNewChapterPrompt(true);

  const submitNewChapter = (title: string) => {
    if (activeAlbum) libraryStore.createChapter(activeAlbum.id, title);
    setShowNewChapterPrompt(false);
  };

  const handleMovePhotoToChapter = (photoId: string, chapterId: string | null) => {
    if (!activeAlbum) return;
    const current = chapterOfPhoto(photoId);
    if (current) libraryStore.removePhotosFromChapter(activeAlbum.id, current, [photoId]);
    if (chapterId) libraryStore.addPhotosToChapter(activeAlbum.id, chapterId, [photoId]);
    setMovePhotoPopoverId(null);
  };

  const handleCreateChapterAndMove = (photoId: string, title: string) => {
    if (!activeAlbum) return;
    const chapter = libraryStore.createChapter(activeAlbum.id, title);
    if (chapter) handleMovePhotoToChapter(photoId, chapter.id);
  };

  const toggleDragSelected = (photoId: string) => {
    setDragSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(photoId)) next.delete(photoId);
      else next.add(photoId);
      return next;
    });
  };

  // Drag one or more photos (from any chapter, or "Other Photos") onto a chapter section or the
  // "Other Photos" bucket to reassign them — including dragging several at once via dragSelectedIds.
  const handlePhotoDragStart = (photoId: string, e: React.DragEvent) => {
    const ids = dragSelectedIds.has(photoId) && dragSelectedIds.size > 1 ? Array.from(dragSelectedIds) : [photoId];
    e.dataTransfer.setData('application/x-gphotos-photo-ids', JSON.stringify(ids));
    e.dataTransfer.effectAllowed = 'move';
    if (ids.length > 1 && e.dataTransfer.setDragImage) {
      const ghost = document.createElement('div');
      ghost.textContent = `${ids.length} photos`;
      ghost.style.cssText = 'position:fixed;top:-100px;left:-100px;padding:8px 14px;border-radius:999px;background:#10b981;color:white;font:600 13px sans-serif';
      document.body.appendChild(ghost);
      e.dataTransfer.setDragImage(ghost, 20, 16);
      setTimeout(() => ghost.remove(), 0);
    }
    // Deferred: changing the page inside dragstart can make the browser cancel the drag.
    setTimeout(() => setDraggingCount(ids.length), 0);
  };

  // Moves photos into a chapter (out of whichever chapter they were in), or back to "no chapter" for null.
  const moveIdsToChapter = (chapterId: string | null, ids: string[]) => {
    if (!activeAlbum || ids.length === 0) return;
    if (chapterId) libraryStore.addPhotosToChapter(activeAlbum.id, chapterId, ids);
    else libraryStore.removePhotosFromAllChapters(activeAlbum.id, ids);
    setDragSelectedIds(new Set());
  };

  const handleDropOnChapter = (chapterId: string | null, e: React.DragEvent, insertBeforePhotoId?: string) => {
    e.preventDefault();
    setDragOverTarget(null);
    setDraggingCount(0);
    if (!activeAlbum) return;
    const raw = e.dataTransfer.getData('application/x-gphotos-photo-ids');
    if (!raw) return;
    try {
      const ids: string[] = JSON.parse(raw);
      if (!Array.isArray(ids) || ids.length === 0) return;
      if (insertBeforePhotoId && ids.length === 1 && ids[0] === insertBeforePhotoId) return; // dropped on itself — no-op
      if (chapterId) libraryStore.addPhotosToChapter(activeAlbum.id, chapterId, ids, insertBeforePhotoId);
      else libraryStore.removePhotosFromAllChapters(activeAlbum.id, ids);
      setDragSelectedIds(new Set());
    } catch {}
  };

  const toggleSelectPhotoToAdd = (photoId: string) => {
    setSelectedPhotoIdsToAdd((prev) => {
      const next = new Set(prev);
      if (next.has(photoId)) next.delete(photoId);
      else next.add(photoId);
      return next;
    });
  };

  const sizeControls = (
    <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
      <button
        className="btn btn-ghost btn-icon"
        disabled={albumGridSize === ALBUM_GRID_SIZES[0]}
        onClick={() => {
          const idx = ALBUM_GRID_SIZES.indexOf(albumGridSize);
          if (idx > 0) setAlbumGridSize(ALBUM_GRID_SIZES[idx - 1]);
        }}
        style={{ width: '30px', height: '30px' }}
        title="Smaller thumbnails"
      >
        <ZoomOut size={15} />
      </button>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          backgroundColor: 'var(--bg-surface-elevated)',
          padding: '2px',
          borderRadius: 'var(--radius-md)',
          border: '1px solid var(--border-subtle)',
        }}
      >
        {([
          { id: 'very_small', label: 'XS' },
          { id: 'small', label: 'S' },
          { id: 'medium', label: 'M' },
          { id: 'large', label: 'L' },
        ] as const).map(({ id, label }) => (
          <button
            key={id}
            className={`btn ${albumGridSize === id ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setAlbumGridSize(id)}
            style={{ padding: '3px 8px', fontSize: '0.74rem', height: '26px' }}
          >
            {label}
          </button>
        ))}
      </div>

      <button
        className="btn btn-ghost btn-icon"
        disabled={albumGridSize === ALBUM_GRID_SIZES[ALBUM_GRID_SIZES.length - 1]}
        onClick={() => {
          const idx = ALBUM_GRID_SIZES.indexOf(albumGridSize);
          if (idx < ALBUM_GRID_SIZES.length - 1) setAlbumGridSize(ALBUM_GRID_SIZES[idx + 1]);
        }}
        style={{ width: '30px', height: '30px' }}
        title="Larger thumbnails"
      >
        <ZoomIn size={15} />
      </button>
    </div>
  );

  // -------------------------------------------------------------
  // DETAIL VIEW: An album is currently open
  // -------------------------------------------------------------
  if (activeAlbum) {
    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
        {/* Detail Header */}
        <div
          style={{
            padding: isMobile ? '12px 14px' : '16px 28px',
            backgroundColor: 'var(--bg-surface)',
            borderBottom: '1px solid var(--border-subtle)',
            display: 'flex',
            flexDirection: isMobile ? 'column' : 'row',
            alignItems: isMobile ? 'stretch' : 'center',
            justifyContent: 'space-between',
            flexWrap: isMobile ? 'nowrap' : 'wrap',
            gap: isMobile ? '10px' : '16px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: isMobile ? '10px' : '16px', minWidth: 0 }}>
            <button
              className="btn btn-secondary btn-icon"
              onClick={() => setSelectedAlbumId(null)}
              title="Back to all albums"
              style={{ width: '40px', height: '40px', borderRadius: 'var(--radius-md)', flexShrink: 0 }}
            >
              <ArrowLeft size={20} />
            </button>
            <div style={{ minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
                <h2
                  style={{
                    fontSize: isMobile ? '1.1rem' : '1.4rem',
                    fontWeight: 700,
                    margin: 0,
                    color: 'var(--text-primary)',
                    ...(isMobile
                      ? { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }
                      : {}),
                  }}
                >
                  {activeAlbum.title}
                </h2>
                <span
                  style={{
                    fontSize: '0.78rem',
                    fontWeight: 600,
                    padding: '3px 10px',
                    borderRadius: 'var(--radius-full)',
                    backgroundColor: 'rgba(59, 130, 246, 0.15)',
                    color: 'var(--accent-primary)',
                    flexShrink: 0,
                  }}
                >
                  {activeAlbum.photoIds.length} photo{activeAlbum.photoIds.length === 1 ? '' : 's'}
                </span>
              </div>
              {!isMobile && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '4px', fontSize: '0.82rem', color: 'var(--text-muted)' }}>
                  {activeAlbum.eventDate && (
                    <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                      <Calendar size={13} color="var(--accent-cyan)" />
                      {new Date(activeAlbum.eventDate).toLocaleDateString(undefined, {
                        year: 'numeric',
                        month: 'long',
                        day: 'numeric',
                      })}
                    </span>
                  )}
                  {activeAlbum.description && <span>• {activeAlbum.description}</span>}
                </div>
              )}
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', ...(isMobile ? { justifyContent: 'space-between' } : {}) }}>
            {!isMobile && sizeControls}
            <button
              className="btn btn-primary"
              onClick={() => {
                setSelectedPhotoIdsToAdd(new Set());
                setPhotoSearchQuery('');
                setPhotoFilterPersonId('');
                setPhotoFilterLocation('');
                setPhotoFilterDateFrom('');
                setPhotoFilterDateTo('');
                setAddToChapterId(activeAlbum?.lastUsedChapterId || '');
                setShowAddPhotosModal(true);
              }}
              style={{
                gap: '8px',
                padding: isMobile ? '0 16px' : '10px 18px',
                height: '40px',
                fontSize: '0.88rem',
                flex: isMobile ? 1 : undefined,
                justifyContent: isMobile ? 'center' : undefined,
              }}
            >
              <Plus size={18} />
              <span>Add Photos</span>
            </button>

            <button
              className="btn btn-secondary"
              onClick={handleCreateChapter}
              title="Split this album into named sections (e.g. by day or ceremony)"
              style={{ gap: '8px', height: '40px', padding: isMobile ? '0 14px' : '10px 16px', fontSize: '0.88rem', flexShrink: 0 }}
            >
              <BookImage size={18} />
              <span>New Chapter</span>
            </button>

            <button
              className="btn btn-secondary"
              onClick={() => setShowVideoWizard(true)}
              disabled={albumPhotos.length === 0}
              title="Create a video slideshow from this album's photos"
              style={{ gap: '8px', height: '40px', padding: isMobile ? '0 14px' : '10px 16px', fontSize: '0.88rem', flexShrink: 0 }}
            >
              <Film size={18} />
              <span>Create Video</span>
            </button>

            <button
              className="btn btn-secondary"
              onClick={handleMoveAlbumToFolder}
              disabled={moveProgress !== null || albumPhotos.length === 0}
              title="Physically move all photos of this album into a folder of the same library or storage"
              data-testid="album-move-to-folder"
              style={{
                gap: '8px',
                height: '40px',
                padding: isMobile ? '0 14px' : '10px 16px',
                fontSize: '0.88rem',
                flexShrink: 0,
              }}
            >
              <FolderInput size={18} />
              <span>
                {moveProgress ? `Moving ${moveProgress.done}/${moveProgress.total}…` : 'Move to Folder…'}
              </span>
            </button>

            <button
              className="btn btn-secondary btn-icon"
              onClick={(e) => handleDeleteAlbum(activeAlbum.id, activeAlbum.title, e)}
              title="Delete this album"
              style={{ width: '40px', height: '40px', color: 'var(--accent-rose)', flexShrink: 0 }}
            >
              <Trash2 size={18} />
            </button>
          </div>
        </div>

        {isMobile && (
          <div style={{
            padding: '8px 14px',
            borderBottom: '1px solid var(--border-subtle)',
            backgroundColor: 'var(--bg-surface)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}>
            <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontWeight: 600 }}>Grid size</span>
            {sizeControls}
          </div>
        )}

        {/* Photos in Album Scroll Area */}
        <div ref={albumScrollRef} onMouseDown={marquee.onMouseDown} data-testid="album-scroll-area" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '24px' }}>
          {albumPhotos.length === 0 ? (
            <div
              style={{
                textAlign: 'center',
                padding: '80px 20px',
                color: 'var(--text-muted)',
                backgroundColor: 'var(--bg-surface-elevated)',
                borderRadius: 'var(--radius-lg)',
                border: '1px dashed var(--border-subtle)',
                maxWidth: '600px',
                margin: '40px auto',
              }}
            >
              <ImageIcon size={52} color="var(--accent-primary)" style={{ margin: '0 auto 16px', opacity: 0.8 }} />
              <h3 style={{ fontSize: '1.2rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '8px' }}>
                This Album is Empty
              </h3>
              <p style={{ maxWidth: '400px', margin: '0 auto 20px', fontSize: '0.88rem', lineHeight: 1.5 }}>
                Collect photos from your local folders, drives, and network mirrors into this album.
              </p>
              <button
                className="btn btn-primary"
                onClick={() => {
                  setSelectedPhotoIdsToAdd(new Set());
                  setPhotoSearchQuery('');
                  setPhotoFilterPersonId('');
                  setPhotoFilterLocation('');
                  setPhotoFilterDateFrom('');
                  setPhotoFilterDateTo('');
                  setAddToChapterId(activeAlbum?.lastUsedChapterId || '');
                  setShowAddPhotosModal(true);
                }}
                style={{ gap: '8px', padding: '10px 20px', margin: '0 auto' }}
              >
                <Plus size={18} />
                <span>Add Photos to Album</span>
              </button>
            </div>
          ) : (() => {
            // `chapterIdContext` is which chapter (or null for "Other Photos"/no chapters yet) this
            // tile is currently rendered in — dropping another photo directly ON a tile inserts it
            // right before that tile in `chapterIdContext`'s own order, which is also how
            // reordering *within* one chapter works (dragging one of its own photos onto a sibling).
            const renderPhotoTile = (photo: Photo, chapterIdContext: string | null) => {
              const isCover = activeAlbum.coverPhotoId === photo.id;
              const hasChapters = (activeAlbum.chapters?.length || 0) > 0;
              const isDragSelected = dragSelectedIds.has(photo.id);
              return (
                <div
                  data-album-photo-id={photo.id}
                  onClick={(e) => {
                    // Same as the gallery: Ctrl/Cmd-click, or any click once something is selected, toggles selection.
                    if (e.ctrlKey || e.metaKey || dragSelectedIds.size > 0) toggleDragSelected(photo.id);
                    else onSelectPhoto(photo, albumPhotos);
                  }}
                  draggable={hasChapters && !marquee.armed}
                  onDragStart={hasChapters ? (e) => handlePhotoDragStart(photo.id, e) : undefined}
                  onDragEnd={() => setDraggingCount(0)}
                  onDragOver={hasChapters && chapterIdContext ? (e) => { e.preventDefault(); e.stopPropagation(); } : undefined}
                  onDrop={hasChapters && chapterIdContext ? (e) => { e.stopPropagation(); handleDropOnChapter(chapterIdContext, e, photo.id); } : undefined}
                  style={{
                    position: 'relative',
                    height: '100%',
                    boxSizing: 'border-box',
                    borderRadius: 'var(--radius-md)',
                    overflow: 'hidden',
                    backgroundColor: 'var(--bg-surface-elevated)',
                    cursor: 'pointer',
                    boxShadow: isCover ? '0 0 16px rgba(59, 130, 246, 0.4)' : 'var(--shadow-sm)',
                    border: isDragSelected ? '2px solid #10b981' : isCover ? '2px solid var(--accent-primary)' : '1px solid var(--border-subtle)',
                    transition: 'transform 0.15s ease, box-shadow 0.15s ease',
                  }}
                >
                  <img
                    src={getLocalPhotoUrl(photo.filePath, photo.originalRemotePath)}
                    alt={photo.fileName}
                    loading="lazy"
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  />

                  {/* Selection checkbox. Click toggles; press + drag from here rubber-bands across more photos. */}
                  {(
                    <div
                      data-marquee-start
                      data-testid="tile-checkbox"
                      role="checkbox"
                      aria-checked={isDragSelected}
                      aria-label={`Select ${photo.fileName}`}
                      onClick={(e) => { e.stopPropagation(); if (!marquee.suppressClick.current) toggleDragSelected(photo.id); }}
                      title="Select — then drag the selected photos onto a chapter, or press and drag across photos to select several"
                      style={{
                        position: 'absolute', bottom: '8px', left: '8px', width: '22px', height: '22px', borderRadius: '50%',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        backgroundColor: isDragSelected ? '#10b981' : 'rgba(15, 23, 42, 0.75)', border: '1px solid rgba(255,255,255,0.3)', cursor: 'pointer',
                      }}
                    >
                      {isDragSelected && <Check size={13} color="white" />}
                    </div>
                  )}

                  {/* Cover Photo Badge */}
                  {isCover && (
                    <div
                      style={{
                        position: 'absolute',
                        top: '8px',
                        left: '8px',
                        backgroundColor: 'var(--accent-primary)',
                        color: 'white',
                        fontSize: '0.72rem',
                        fontWeight: 700,
                        padding: '3px 8px',
                        borderRadius: 'var(--radius-full)',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '4px',
                        boxShadow: '0 2px 6px rgba(0,0,0,0.5)',
                      }}
                    >
                      <Star size={12} fill="white" />
                      <span>Album Cover</span>
                    </div>
                  )}

                  {/* Top Action Overlay */}
                  <div
                    style={{
                      position: 'absolute',
                      top: '8px',
                      right: '8px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                    }}
                  >
                    {/* Move to Chapter Button (only once the album actually has chapters) */}
                    {hasChapters && (
                      <div style={{ position: 'relative' }} onClick={(e) => e.stopPropagation()}>
                        <button
                          onClick={() => setMovePhotoPopoverId(movePhotoPopoverId === photo.id ? null : photo.id)}
                          style={{
                            backgroundColor: 'rgba(15, 23, 42, 0.85)', backdropFilter: 'blur(6px)',
                            border: '1px solid rgba(255,255,255,0.2)', borderRadius: 'var(--radius-full)',
                            width: '32px', height: '32px', display: 'flex', alignItems: 'center', justifyContent: 'center',
                            color: 'white', cursor: 'pointer', boxShadow: '0 2px 6px rgba(0,0,0,0.5)',
                          }}
                          title="Move to a different chapter"
                        >
                          <BookImage size={15} />
                        </button>
                        {movePhotoPopoverId === photo.id && (
                          <ChapterPicker
                            chapters={activeAlbum.chapters || []}
                            currentChapterId={chapterOfPhoto(photo.id)}
                            onPick={(chapterId) => handleMovePhotoToChapter(photo.id, chapterId)}
                            onCreateNew={(title) => handleCreateChapterAndMove(photo.id, title)}
                            onClose={() => setMovePhotoPopoverId(null)}
                            anchorStyle={{ top: '38px', right: 0 }}
                          />
                        )}
                      </div>
                    )}

                    {/* Set Cover Button */}
                    {!isCover && (
                      <button
                        onClick={(e) => handleSetCoverPhoto(photo.id, e)}
                        style={{
                          backgroundColor: 'rgba(15, 23, 42, 0.85)',
                          backdropFilter: 'blur(6px)',
                          border: '1px solid rgba(255,255,255,0.2)',
                          borderRadius: 'var(--radius-full)',
                          width: '32px',
                          height: '32px',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          color: 'white',
                          cursor: 'pointer',
                          boxShadow: '0 2px 6px rgba(0,0,0,0.5)',
                        }}
                        title="Set as Album Cover Photo"
                      >
                        <Star size={15} />
                      </button>
                    )}

                    {/* Remove from Album Button */}
                    <button
                      onClick={(e) => handleRemovePhotoFromAlbum(photo.id, e)}
                      style={{
                        backgroundColor: 'rgba(15, 23, 42, 0.85)',
                        backdropFilter: 'blur(6px)',
                        border: '1px solid rgba(239, 68, 68, 0.5)',
                        borderRadius: 'var(--radius-full)',
                        width: '32px',
                        height: '32px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: '#f87171',
                        cursor: 'pointer',
                        boxShadow: '0 2px 6px rgba(0,0,0,0.5)',
                      }}
                      title="Remove photo from this album"
                    >
                      <X size={16} />
                    </button>
                  </div>

                  {/* Bottom File Info */}
                  <div
                    style={{
                      position: 'absolute',
                      bottom: 0,
                      left: 0,
                      right: 0,
                      padding: '8px 10px',
                      background: 'linear-gradient(180deg, transparent 0%, rgba(0,0,0,0.85) 100%)',
                      fontSize: '0.75rem',
                      color: 'white',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {photo.fileName}
                  </div>
                </div>
              );
            };

            const chapters = activeAlbum.chapters || [];
            const unchapteredIds = libraryStore.getUnchapteredPhotoIds(activeAlbum);
            const unchapteredPhotos = unchapteredIds.map((id) => photoMap.get(id)).filter((p): p is Photo => !!p);
            const gridProps = {
              scrollRef: albumScrollRef,
              rowHeight: Math.round(ALBUM_GRID_SIZE_PX[albumGridSize] * 1.05),
              minColWidth: ALBUM_GRID_SIZE_PX[albumGridSize],
              gap: albumGridSize === 'very_small' ? 10 : 16,
            };

            if (chapters.length === 0) {
              return <VirtualCardGrid items={albumPhotos} getKey={(p) => p.id} renderItem={(photo) => renderPhotoTile(photo, null)} {...gridProps} />;
            }

            return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '36px' }}>
                {chapters.map((chapter, idx) => (
                  <AlbumChapterSection
                    key={chapter.id}
                    chapter={chapter}
                    photos={chapter.photoIds.map((id) => photoMap.get(id)).filter((p): p is Photo => !!p)}
                    renderTile={(photo) => renderPhotoTile(photo, chapter.id)}
                    onRename={(title) => libraryStore.renameChapter(activeAlbum.id, chapter.id, title)}
                    onDelete={() => {
                      if (window.confirm(`Delete the chapter "${chapter.title}"? Its photos stay in the album.`)) {
                        libraryStore.deleteChapter(activeAlbum.id, chapter.id);
                      }
                    }}
                    onMoveUp={idx > 0 ? () => libraryStore.reorderChapters(activeAlbum.id, [
                      ...chapters.slice(0, idx - 1).map((c) => c.id), chapter.id, chapters[idx - 1].id, ...chapters.slice(idx + 1).map((c) => c.id),
                    ]) : undefined}
                    onMoveDown={idx < chapters.length - 1 ? () => libraryStore.reorderChapters(activeAlbum.id, [
                      ...chapters.slice(0, idx).map((c) => c.id), chapters[idx + 1].id, chapter.id, ...chapters.slice(idx + 2).map((c) => c.id),
                    ]) : undefined}
                    onDropPhotoIds={(e) => handleDropOnChapter(chapter.id, e)}
                    {...gridProps}
                  />
                ))}
                {/* Once every photo has been sorted into a named chapter, this bucket (and its
                    drop target) disappears entirely — a photo can still be sent back to "no
                    chapter" via its move-to-chapter popover even while this section is hidden. */}
                {unchapteredPhotos.length > 0 && (
                  <div
                    onDragOver={(e) => { e.preventDefault(); setDragOverTarget('unchaptered'); }}
                    onDragLeave={() => setDragOverTarget((t) => (t === 'unchaptered' ? null : t))}
                    onDrop={(e) => handleDropOnChapter(null, e)}
                    style={{
                      borderRadius: 'var(--radius-lg)', padding: dragOverTarget === 'unchaptered' ? '10px' : '0',
                      border: dragOverTarget === 'unchaptered' ? '2px dashed #10b981' : '2px dashed transparent',
                      backgroundColor: dragOverTarget === 'unchaptered' ? 'rgba(16, 185, 129, 0.06)' : 'transparent',
                    }}
                  >
                    <h3 style={{ margin: '0 0 14px', fontSize: '1.05rem', fontWeight: 700, color: 'var(--text-muted)' }}>
                      Other Photos <span style={{ fontWeight: 500, fontSize: '0.82rem' }}>({unchapteredPhotos.length})</span>
                    </h3>
                    <VirtualCardGrid items={unchapteredPhotos} getKey={(p) => p.id} renderItem={(photo) => renderPhotoTile(photo, null)} {...gridProps} />
                  </div>
                )}
              </div>
            );
          })()}
        </div>

        <VideoWizardModal
          isOpen={showVideoWizard}
          onClose={() => setShowVideoWizard(false)}
          album={activeAlbum}
          photos={photos}
        />

        <MarqueeBox rect={marquee.marquee} />

        {(() => {
          const box = albumScrollRef.current?.getBoundingClientRect();
          if (!box) return null;
          const anchor = { top: box.top, left: box.left, width: box.width, bottom: box.bottom };
          const chapters = activeAlbum.chapters || [];
          if (draggingCount > 0 && chapters.length > 0) {
            return <ChapterDropBar chapters={chapters} count={draggingCount} anchor={anchor} onDropTo={(id, e) => handleDropOnChapter(id, e)} />;
          }
          if (dragSelectedIds.size > 0 && draggingCount === 0) {
            return (
              <AlbumSelectionBar
                count={dragSelectedIds.size}
                chapters={chapters}
                anchor={anchor}
                onMoveTo={(id) => moveIdsToChapter(id, Array.from(dragSelectedIds))}
                onCreateChapter={(title) => {
                  libraryStore.createChapter(activeAlbum.id, title, Array.from(dragSelectedIds));
                  setDragSelectedIds(new Set());
                }}
                onClear={() => setDragSelectedIds(new Set())}
                onRunSmartFlow={onRunSmartFlow ? () => onRunSmartFlow(Array.from(dragSelectedIds).map((id) => photoMap.get(id)).filter((p): p is Photo => !!p)) : undefined}
              />
            );
          }
          return null;
        })()}

        {showNewChapterPrompt && (
          <PromptModal
            title="New Chapter"
            message='e.g. "Day 1 — Ceremony"'
            placeholder="Chapter name"
            confirmLabel="Create"
            onSubmit={submitNewChapter}
            onCancel={() => setShowNewChapterPrompt(false)}
          />
        )}

        {/* Modal: Add Photos to Album Picker */}
        {showAddPhotosModal && (
          <div
            style={{
              position: 'fixed',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              backgroundColor: 'rgba(5, 8, 15, 0.88)',
              backdropFilter: 'blur(10px)',
              zIndex: 3500,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: isMobile ? '10px' : '24px',
            }}
            onClick={() => setShowAddPhotosModal(false)}
          >
            <div
              style={{
                width: '100%',
                maxWidth: '900px',
                height: '85vh',
                backgroundColor: 'var(--bg-surface)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--radius-lg)',
                boxShadow: '0 24px 64px rgba(0, 0, 0, 0.7)',
                overflow: 'hidden',
                display: 'flex',
                flexDirection: 'column',
              }}
              onClick={(e) => e.stopPropagation()}
            >
              {/* Picker Header */}
              <div
                style={{
                  padding: isMobile ? '12px 16px' : '16px 24px',
                  borderBottom: '1px solid var(--border-subtle)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '16px',
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <h3
                    style={{
                      fontSize: isMobile ? '1rem' : '1.15rem',
                      fontWeight: 700,
                      margin: 0,
                      color: 'var(--text-primary)',
                      ...(isMobile
                        ? { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
                        : {}),
                    }}
                  >
                    Add Photos to "{activeAlbum.title}"
                  </h3>
                  {!isMobile && (
                    <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '2px' }}>
                      Select photos from your entire library across any drives or network folders.
                    </div>
                  )}
                </div>

                <button
                  className="btn btn-ghost btn-icon"
                  onClick={() => setShowAddPhotosModal(false)}
                  style={{ width: '36px', height: '36px', flexShrink: 0 }}
                >
                  <X size={20} />
                </button>
              </div>

              {/* Picker Search & Select All Toolbar */}
              <div
                style={{
                  padding: isMobile ? '10px 16px' : '12px 24px',
                  backgroundColor: 'var(--bg-surface-elevated)',
                  borderBottom: '1px solid var(--border-subtle)',
                  display: 'flex',
                  flexDirection: isMobile ? 'column' : 'row',
                  alignItems: isMobile ? 'stretch' : 'center',
                  justifyContent: 'space-between',
                  gap: isMobile ? '8px' : '12px',
                }}
              >
                <div style={{ position: 'relative', flex: 1, maxWidth: isMobile ? 'none' : '380px' }}>
                  <Search
                    size={16}
                    color="var(--text-muted)"
                    style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)' }}
                  />
                  <input
                    type="text"
                    className="input"
                    placeholder="Search photos by filename, place..."
                    value={photoSearchQuery}
                    onChange={(e) => setPhotoSearchQuery(e.target.value)}
                    style={{ paddingLeft: '36px', height: '36px', fontSize: '0.85rem', width: isMobile ? '100%' : undefined }}
                  />
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <button
                    className="btn btn-ghost"
                    onClick={() => setSelectedPhotoIdsToAdd(new Set(availablePhotosForAlbum.map((p) => p.id)))}
                    style={{ fontSize: '0.8rem', height: '34px', flex: isMobile ? 1 : undefined }}
                  >
                    Select All ({availablePhotosForAlbum.length})
                  </button>
                  <button
                    className="btn btn-ghost"
                    onClick={() => setSelectedPhotoIdsToAdd(new Set())}
                    style={{ fontSize: '0.8rem', height: '34px', flex: isMobile ? 1 : undefined }}
                  >
                    Clear
                  </button>
                </div>
              </div>

              {/* Picker Filters: person (AI), location, date range */}
              <div
                style={{
                  padding: isMobile ? '10px 16px' : '10px 24px',
                  backgroundColor: 'var(--bg-surface-elevated)',
                  borderBottom: '1px solid var(--border-subtle)',
                  display: 'flex',
                  flexWrap: 'wrap',
                  alignItems: 'center',
                  gap: '8px',
                }}
              >
                <select
                  className="input"
                  value={photoFilterPersonId}
                  onChange={(e) => setPhotoFilterPersonId(e.target.value)}
                  style={{ height: '32px', fontSize: '0.8rem', maxWidth: '180px' }}
                  title="Filter by recognized person"
                >
                  <option value="">Filter by AI: Anyone</option>
                  {filterablePeople.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.photoCount})
                    </option>
                  ))}
                </select>

                <select
                  className="input"
                  value={photoFilterLocation}
                  onChange={(e) => setPhotoFilterLocation(e.target.value)}
                  style={{ height: '32px', fontSize: '0.8rem', maxWidth: '180px' }}
                  title="Filter by location"
                >
                  <option value="">Any Location</option>
                  {filterableLocations.map((loc) => (
                    <option key={loc} value={loc}>
                      {loc}
                    </option>
                  ))}
                </select>

                <input
                  type="date"
                  value={photoFilterDateFrom}
                  onChange={(e) => setPhotoFilterDateFrom(e.target.value)}
                  className="input"
                  style={{ height: '32px', fontSize: '0.8rem' }}
                  title="From date"
                />
                <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>to</span>
                <input
                  type="date"
                  value={photoFilterDateTo}
                  onChange={(e) => setPhotoFilterDateTo(e.target.value)}
                  className="input"
                  style={{ height: '32px', fontSize: '0.8rem' }}
                  title="To date"
                />

                {(photoFilterPersonId || photoFilterLocation || photoFilterDateFrom || photoFilterDateTo) && (
                  <button
                    className="btn btn-ghost"
                    onClick={() => {
                      setPhotoFilterPersonId('');
                      setPhotoFilterLocation('');
                      setPhotoFilterDateFrom('');
                      setPhotoFilterDateTo('');
                    }}
                    style={{ fontSize: '0.78rem', height: '32px' }}
                  >
                    Reset Filters
                  </button>
                )}
              </div>

              {/* Photos Picker Grid */}
              <div ref={pickerScrollRef} style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '20px 24px' }}>
                {availablePhotosForAlbum.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-muted)' }}>
                    No available photos found to add.
                  </div>
                ) : (
                  <VirtualCardGrid
                    items={availablePhotosForAlbum}
                    getKey={(p) => p.id}
                    scrollRef={pickerScrollRef}
                    rowHeight={140}
                    minColWidth={150}
                    gap={12}
                    renderItem={(photo) => {
                      const isPicked = selectedPhotoIdsToAdd.has(photo.id);
                      return (
                        <div
                          onClick={() => toggleSelectPhotoToAdd(photo.id)}
                          style={{
                            position: 'relative',
                            height: '100%',
                            boxSizing: 'border-box',
                            borderRadius: 'var(--radius-md)',
                            overflow: 'hidden',
                            backgroundColor: '#0f172a',
                            cursor: 'pointer',
                            border: isPicked ? '3px solid var(--accent-primary)' : '1px solid var(--border-subtle)',
                            boxShadow: isPicked ? '0 0 16px rgba(59, 130, 246, 0.4)' : 'none',
                            transition: 'all 0.15s ease',
                          }}
                        >
                          <img
                            src={getLocalPhotoUrl(photo.filePath, photo.originalRemotePath)}
                            alt={photo.fileName}
                            loading="lazy"
                            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                          />

                          {/* Checkbox badge */}
                          <div
                            style={{
                              position: 'absolute',
                              top: '8px',
                              left: '8px',
                              width: '26px',
                              height: '26px',
                              borderRadius: '6px',
                              backgroundColor: isPicked ? 'var(--accent-primary)' : 'rgba(15, 23, 42, 0.85)',
                              border: isPicked ? 'none' : '2px solid rgba(255,255,255,0.85)',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              boxShadow: '0 2px 6px rgba(0,0,0,0.5)',
                            }}
                          >
                            {isPicked && <Check size={16} color="white" strokeWidth={3} />}
                          </div>

                          {/* Filename */}
                          <div
                            style={{
                              position: 'absolute',
                              bottom: 0,
                              left: 0,
                              right: 0,
                              padding: '4px 6px',
                              background: 'rgba(0,0,0,0.75)',
                              fontSize: '0.68rem',
                              color: 'white',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {photo.fileName}
                          </div>
                        </div>
                      );
                    }}
                  />
                )}
              </div>

              {/* Picker Footer */}
              <div
                style={{
                  padding: isMobile ? '10px 16px' : '14px 24px',
                  borderTop: '1px solid var(--border-subtle)',
                  display: 'flex',
                  flexDirection: isMobile ? 'column' : 'row',
                  alignItems: isMobile ? 'stretch' : 'center',
                  justifyContent: 'space-between',
                  gap: isMobile ? '8px' : undefined,
                }}
              >
                <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                  {selectedPhotoIdsToAdd.size} photo{selectedPhotoIdsToAdd.size === 1 ? '' : 's'} selected
                </span>

                <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                  {(activeAlbum?.chapters?.length || 0) > 0 && (
                    <select
                      className="input"
                      value={addToChapterId}
                      onChange={(e) => setAddToChapterId(e.target.value)}
                      title="Which chapter to add these photos into"
                      style={{ height: '38px', fontSize: '0.85rem', maxWidth: '180px' }}
                    >
                      <option value="">No chapter</option>
                      {activeAlbum!.chapters!.map((c) => (
                        <option key={c.id} value={c.id}>{c.title}</option>
                      ))}
                    </select>
                  )}
                  <button
                    className="btn btn-ghost"
                    onClick={() => setShowAddPhotosModal(false)}
                    style={{ height: '38px', padding: '0 16px', flex: isMobile ? 1 : undefined }}
                  >
                    Cancel
                  </button>
                  <button
                    className="btn btn-primary"
                    onClick={handleAddSelectedPhotos}
                    disabled={selectedPhotoIdsToAdd.size === 0}
                    style={{ height: '38px', padding: '0 20px', gap: '8px', flex: isMobile ? 2 : undefined }}
                  >
                    <Check size={16} />
                    <span>Add to Album ({selectedPhotoIdsToAdd.size})</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // -------------------------------------------------------------
  // MAIN VIEW: Albums Grid
  // -------------------------------------------------------------
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Header */}
      <div
        style={{
          padding: isMobile ? '12px 14px' : '20px 28px',
          backgroundColor: 'var(--bg-surface)',
          borderBottom: '1px solid var(--border-subtle)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: isMobile ? '10px' : '16px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: isMobile ? '10px' : '14px', minWidth: 0 }}>
          <div
            style={{
              width: isMobile ? '34px' : '42px',
              height: isMobile ? '34px' : '42px',
              borderRadius: 'var(--radius-md)',
              backgroundColor: 'rgba(59, 130, 246, 0.15)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              border: '1px solid rgba(59, 130, 246, 0.3)',
              flexShrink: 0,
            }}
          >
            <BookImage size={isMobile ? 18 : 22} color="var(--accent-primary)" />
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <h2 style={{ fontSize: isMobile ? '1.05rem' : '1.35rem', fontWeight: 700, margin: 0, color: 'var(--text-primary)' }}>
                Albums & Events
              </h2>
              <span
                style={{
                  fontSize: '0.8rem',
                  fontWeight: 600,
                  padding: '2px 10px',
                  borderRadius: 'var(--radius-full)',
                  backgroundColor: 'rgba(59, 130, 246, 0.15)',
                  color: 'var(--accent-primary)',
                }}
              >
                {albums.length}
              </span>
            </div>
            {/* Descriptive subtitle is dropped on mobile — it's informational
                only, and its wrapped 2-3 lines were the main contributor to
                the toolbar eating up screen height on narrow viewports. */}
            {!isMobile && (
              <p style={{ margin: '3px 0 0', fontSize: '0.82rem', color: 'var(--text-muted)' }}>
                Group photos by event, trip, or story irrespective of their folder or drive location
              </p>
            )}
          </div>
        </div>

        <button
          className="btn btn-primary"
          onClick={() => setShowCreateModal(true)}
          style={{
            gap: '8px',
            padding: isMobile ? '0 14px' : '10px 20px',
            height: isMobile ? '36px' : '42px',
            fontSize: isMobile ? '0.82rem' : '0.9rem',
          }}
        >
          <FolderPlus size={isMobile ? 16 : 18} />
          <span>New Album</span>
        </button>
      </div>

      {/* Albums Grid */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '28px' }}>
        {albums.length === 0 ? (
          !libraryStore.getState().isInitialized ? (
            <div
              style={{
                textAlign: 'center',
                padding: '80px 20px',
                maxWidth: '520px',
                margin: '40px auto',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '14px',
              }}
            >
              <div
                className="spinner"
                style={{
                  width: '36px',
                  height: '36px',
                  border: '3px solid rgba(59, 130, 246, 0.2)',
                  borderTopColor: 'var(--accent-primary)',
                  borderRadius: '50%',
                  animation: 'spin 1s linear infinite',
                }}
              />
              <span style={{ color: 'var(--text-muted)', fontSize: '0.95rem' }}>Loading albums...</span>
            </div>
          ) : (
            <div
              style={{
                textAlign: 'center',
                padding: '80px 20px',
                maxWidth: '520px',
                margin: '40px auto',
                backgroundColor: 'var(--bg-surface-elevated)',
                borderRadius: 'var(--radius-lg)',
                border: '1px dashed var(--border-subtle)',
              }}
            >
              <div
                style={{
                  width: '64px',
                  height: '64px',
                  borderRadius: '50%',
                  backgroundColor: 'rgba(59, 130, 246, 0.12)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  margin: '0 auto 16px',
                }}
              >
                <FolderHeart size={32} color="var(--accent-primary)" />
              </div>
              <h3 style={{ fontSize: '1.25rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '8px' }}>
                No Albums Created Yet
              </h3>
              <p style={{ fontSize: '0.88rem', color: 'var(--text-muted)', lineHeight: 1.5, marginBottom: '24px' }}>
                Create an album for a wedding, family trip, or birthday party. You can easily add photos from anywhere in your library.
              </p>
              <button
                className="btn btn-primary"
                onClick={() => setShowCreateModal(true)}
                style={{ gap: '8px', padding: '10px 22px', margin: '0 auto' }}
              >
                <Plus size={18} />
                <span>Create Your First Album</span>
              </button>
            </div>
          )
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
              gap: '24px',
            }}
          >
            {albums.map((album) => {
              const coverPhoto =
                (album.coverPhotoId && photoMap.get(album.coverPhotoId)) ||
                (album.photoIds.length > 0 && photoMap.get(album.photoIds[0])) ||
                null;

              return (
                <div
                  key={album.id}
                  onClick={() => setSelectedAlbumId(album.id)}
                  style={{
                    backgroundColor: 'var(--bg-surface-elevated)',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 'var(--radius-lg)',
                    overflow: 'hidden',
                    cursor: 'pointer',
                    boxShadow: 'var(--shadow-sm)',
                    transition: 'transform 0.15s ease, box-shadow 0.15s ease, border-color 0.15s ease',
                    display: 'flex',
                    flexDirection: 'column',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.transform = 'translateY(-3px)';
                    e.currentTarget.style.boxShadow = 'var(--shadow-md)';
                    e.currentTarget.style.borderColor = 'var(--accent-primary)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.transform = 'translateY(0)';
                    e.currentTarget.style.boxShadow = 'var(--shadow-sm)';
                    e.currentTarget.style.borderColor = 'var(--border-subtle)';
                  }}
                >
                  {/* Cover Card Image */}
                  <div
                    style={{
                      height: '180px',
                      backgroundColor: '#0f172a',
                      position: 'relative',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    {coverPhoto ? (
                      <img
                        src={getLocalPhotoUrl(coverPhoto.filePath, coverPhoto.originalRemotePath)}
                        alt={album.title}
                        loading="lazy"
                        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                      />
                    ) : (
                      <div style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
                        <BookImage size={38} style={{ opacity: 0.4, margin: '0 auto 6px' }} />
                        <span style={{ fontSize: '0.78rem' }}>Empty Album</span>
                      </div>
                    )}

                    {/* Photo Count Pill */}
                    <div
                      style={{
                        position: 'absolute',
                        bottom: '10px',
                        right: '10px',
                        backgroundColor: 'rgba(15, 23, 42, 0.85)',
                        backdropFilter: 'blur(6px)',
                        color: 'white',
                        fontSize: '0.75rem',
                        fontWeight: 600,
                        padding: '3px 9px',
                        borderRadius: 'var(--radius-full)',
                        boxShadow: '0 2px 6px rgba(0,0,0,0.5)',
                      }}
                    >
                      {album.photoIds.length} photo{album.photoIds.length === 1 ? '' : 's'}
                    </div>

                    {/* Delete Icon Overlay Button */}
                    <button
                      onClick={(e) => handleDeleteAlbum(album.id, album.title, e)}
                      style={{
                        position: 'absolute',
                        top: '10px',
                        right: '10px',
                        backgroundColor: 'rgba(15, 23, 42, 0.85)',
                        backdropFilter: 'blur(6px)',
                        color: 'var(--text-muted)',
                        border: 'none',
                        borderRadius: 'var(--radius-full)',
                        width: '32px',
                        height: '32px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        cursor: 'pointer',
                        transition: 'color 0.15s ease',
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--accent-rose)')}
                      onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-muted)')}
                      title="Delete album"
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>

                  {/* Album Info */}
                  <div style={{ padding: '14px 16px' }}>
                    <div
                      style={{
                        fontSize: '1rem',
                        fontWeight: 700,
                        color: 'var(--text-primary)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {album.title}
                    </div>

                    {album.eventDate && (
                      <div
                        style={{
                          fontSize: '0.78rem',
                          color: 'var(--accent-cyan)',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '5px',
                          marginTop: '4px',
                        }}
                      >
                        <Calendar size={13} />
                        <span>
                          {new Date(album.eventDate).toLocaleDateString(undefined, {
                            year: 'numeric',
                            month: 'short',
                            day: 'numeric',
                          })}
                        </span>
                      </div>
                    )}

                    {album.description && (
                      <div
                        style={{
                          fontSize: '0.78rem',
                          color: 'var(--text-muted)',
                          marginTop: '4px',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {album.description}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Modal: Create Album */}
      {showCreateModal && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(5, 8, 15, 0.88)',
            backdropFilter: 'blur(10px)',
            zIndex: 3500,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: isMobile ? '10px' : '24px',
          }}
          onClick={() => setShowCreateModal(false)}
        >
          <div
            style={{
              width: '100%',
              maxWidth: '480px',
              backgroundColor: 'var(--bg-surface)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-lg)',
              boxShadow: '0 24px 64px rgba(0, 0, 0, 0.7)',
              overflow: 'hidden',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              style={{
                padding: '18px 24px',
                borderBottom: '1px solid var(--border-subtle)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <BookImage size={22} color="var(--accent-primary)" />
                <h3 style={{ fontSize: '1.2rem', fontWeight: 700, margin: 0, color: 'var(--text-primary)' }}>
                  Create New Album
                </h3>
              </div>
              <button
                className="btn btn-ghost btn-icon"
                onClick={() => setShowCreateModal(false)}
                style={{ width: '36px', height: '36px' }}
              >
                <X size={20} />
              </button>
            </div>

            <form onSubmit={handleCreateAlbum} style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div>
                <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '6px' }}>
                  Album Title <span style={{ color: 'var(--accent-rose)' }}>*</span>
                </label>
                <input
                  type="text"
                  className="input"
                  placeholder="e.g. Summer Vacation, Sachin's Birthday"
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  autoFocus
                  required
                  style={{ height: '40px' }}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '6px' }}>
                  Event Date (Optional)
                </label>
                <input
                  type="date"
                  className="input"
                  value={newEventDate}
                  onChange={(e) => setNewEventDate(e.target.value)}
                  style={{ height: '40px' }}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '6px' }}>
                  Description (Optional)
                </label>
                <textarea
                  className="input"
                  rows={3}
                  placeholder="Brief note about this event or collection..."
                  value={newDescription}
                  onChange={(e) => setNewDescription(e.target.value)}
                  style={{ resize: 'vertical', paddingTop: '8px' }}
                />
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '12px' }}>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => setShowCreateModal(false)}
                  style={{ height: '40px', padding: '0 18px' }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={!newTitle.trim()}
                  style={{ height: '40px', padding: '0 22px' }}
                >
                  Create Album
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
