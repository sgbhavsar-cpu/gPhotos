import React, { useState, useMemo, useEffect } from 'react';
import {
  FolderPlus,
  Image as ImageIcon,
  Calendar,
  Trash2,
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
  ZoomOut
} from 'lucide-react';
import { Album, Photo } from '../../types';
import { libraryStore, getLocalPhotoUrl } from '../services/libraryStore';
import { useIsMobile } from '../hooks/useIsMobile';

interface AlbumsViewProps {
  photos: Photo[];
  albums: Album[];
  // contextPhotos, when provided, is the ordered list the caller should use
  // for lightbox next/prev navigation instead of the whole library — here,
  // the currently open album's own photos, so browsing an album's lightbox
  // stays inside that album.
  onSelectPhoto: (photo: Photo, contextPhotos?: Photo[]) => void;
  resetTrigger?: number;
}

export const AlbumsView: React.FC<AlbumsViewProps> = ({
  photos,
  albums,
  onSelectPhoto,
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

  useEffect(() => {
    if (resetTrigger) {
      setSelectedAlbumId(null);
    }
  }, [resetTrigger]);

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showAddPhotosModal, setShowAddPhotosModal] = useState(false);
  const [photoSearchQuery, setPhotoSearchQuery] = useState('');
  const [selectedPhotoIdsToAdd, setSelectedPhotoIdsToAdd] = useState<Set<string>>(new Set());
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

  // Available photos not in this album (for picker)
  const availablePhotosForAlbum = useMemo(() => {
    if (!activeAlbum) return [];
    const existing = new Set(activeAlbum.photoIds);
    let candidates = photos.filter((p) => !existing.has(p.id) && !p.isExcluded);

    if (photoSearchQuery.trim()) {
      const q = photoSearchQuery.toLowerCase();
      candidates = candidates.filter(
        (p) =>
          p.fileName.toLowerCase().includes(q) ||
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
  }, [photos, activeAlbum, photoSearchQuery, photoFilterPersonId, photoFilterLocation, photoFilterDateFrom, photoFilterDateTo]);

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
    libraryStore.addPhotosToAlbum(activeAlbum.id, Array.from(selectedPhotoIdsToAdd));
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
        <div style={{ flex: 1, overflowY: 'auto', padding: '24px' }}>
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
                  setShowAddPhotosModal(true);
                }}
                style={{ gap: '8px', padding: '10px 20px', margin: '0 auto' }}
              >
                <Plus size={18} />
                <span>Add Photos to Album</span>
              </button>
            </div>
          ) : (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: `repeat(auto-fill, minmax(${ALBUM_GRID_SIZE_PX[albumGridSize]}px, 1fr))`,
                gap: albumGridSize === 'very_small' ? '10px' : '16px',
              }}
            >
              {albumPhotos.map((photo) => {
                const isCover = activeAlbum.coverPhotoId === photo.id;
                return (
                  <div
                    key={photo.id}
                    onClick={() => onSelectPhoto(photo, albumPhotos)}
                    style={{
                      position: 'relative',
                      height: `${Math.round(ALBUM_GRID_SIZE_PX[albumGridSize] * 1.05)}px`,
                      borderRadius: 'var(--radius-md)',
                      overflow: 'hidden',
                      backgroundColor: 'var(--bg-surface-elevated)',
                      cursor: 'pointer',
                      boxShadow: isCover ? '0 0 16px rgba(59, 130, 246, 0.4)' : 'var(--shadow-sm)',
                      border: isCover ? '2px solid var(--accent-primary)' : '1px solid var(--border-subtle)',
                      transition: 'transform 0.15s ease, box-shadow 0.15s ease',
                    }}
                  >
                    <img
                      src={getLocalPhotoUrl(photo.filePath, photo.originalRemotePath)}
                      alt={photo.fileName}
                      loading="lazy"
                      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                    />

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
              })}
            </div>
          )}
        </div>

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
              <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>
                {availablePhotosForAlbum.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-muted)' }}>
                    No available photos found to add.
                  </div>
                ) : (
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
                      gap: '12px',
                    }}
                  >
                    {availablePhotosForAlbum.map((photo) => {
                      const isPicked = selectedPhotoIdsToAdd.has(photo.id);
                      return (
                        <div
                          key={photo.id}
                          onClick={() => toggleSelectPhotoToAdd(photo.id)}
                          style={{
                            position: 'relative',
                            height: '140px',
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
                    })}
                  </div>
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

                <div style={{ display: 'flex', gap: '10px' }}>
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
