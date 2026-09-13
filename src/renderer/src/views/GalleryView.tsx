import React, { useState, useMemo } from 'react';
import {
  Calendar,
  Sliders,
  FolderOpen,
  Heart,
  RefreshCw,
  HardDrive,
  CheckSquare,
  EyeOff,
  Eye,
  Sparkles,
  Layers,
  Check,
  HelpCircle,
  FolderPlus,
  BookImage,
  Plus,
  X,
  ZoomIn,
  ZoomOut,
  Trash2,
  AlertTriangle
} from 'lucide-react';
import { Photo, VirtualStorageConfig, Album } from '../../types';
import { PhotoCard } from '../components/PhotoCard';
import { libraryStore } from '../services/libraryStore';
import { VirtualizedTimelineGallery, GalleryZoomLevel, ZOOM_LEVELS } from '../components/VirtualizedTimelineGallery';
import { AiPhotoFilter } from '../services/aiSearchService';
import { batchThumbnailStore, requestBatchThumbnails } from '../services/asyncImageLoader';

interface GalleryViewProps {
  photos: Photo[];
  onSelectPhoto: (photo: Photo) => void;
  onToggleFavorite: (photoId: string) => void;
  onOpenFolder: () => void;
  onRefreshNetwork?: () => void;
  filterFavorite?: boolean;
  virtualStorages?: VirtualStorageConfig[];
  onSelectStorage?: (storage: VirtualStorageConfig) => void;
  onOpenDuplicateCleaner?: () => void;
  onOpenHelp?: () => void;
  onOpenAiSearch?: () => void;
  activeAiFilter?: AiPhotoFilter | null;
  onClearAiFilter?: () => void;
  resetTrigger?: number;
  totalCount?: number;
}

export const GalleryView: React.FC<GalleryViewProps> = ({
  photos,
  onSelectPhoto,
  onToggleFavorite,
  onOpenFolder,
  onRefreshNetwork,
  filterFavorite = false,
  virtualStorages = [],
  onSelectStorage,
  onOpenDuplicateCleaner,
  onOpenHelp,
  onOpenAiSearch,
  activeAiFilter,
  onClearAiFilter,
  resetTrigger,
  totalCount,
}) => {
  const [zoomLevel, setZoomLevel] = useState<GalleryZoomLevel>('medium');
  const [filterType, setFilterType] = useState<'all' | 'faces' | 'nofaces' | 'excluded'>('all');
  const [isSelectMode, setIsSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Album Dialog states
  const [showAlbumDialog, setShowAlbumDialog] = useState(false);
  const [targetAlbumId, setTargetAlbumId] = useState<string>('new');
  const [newAlbumTitle, setNewAlbumTitle] = useState('');
  const [albumSuccessToast, setAlbumSuccessToast] = useState<string | null>(null);

  // Permanent Deletion Confirmation Modal states
  const [showDeleteConfirmModal, setShowDeleteConfirmModal] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  // Thumbnail Cache Refreshing states
  const [isRefreshingThumbnails, setIsRefreshingThumbnails] = useState(false);
  const [refreshToast, setRefreshToast] = useState<string | null>(null);

  // Handle Escape key navigation inside GalleryView
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;

      if (showAlbumDialog) {
        e.stopPropagation();
        setShowAlbumDialog(false);
      } else if (showDeleteConfirmModal) {
        e.stopPropagation();
        setShowDeleteConfirmModal(false);
      } else if (isSelectMode || selectedIds.size > 0) {
        e.stopPropagation();
        setIsSelectMode(false);
        setSelectedIds(new Set());
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showAlbumDialog, showDeleteConfirmModal, isSelectMode, selectedIds]);

  // Mobile-style mouse drag-selection handler
  const handleDragSelect = (photoId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.add(photoId);
      return next;
    });
    if (!isSelectMode) {
      setIsSelectMode(true);
    }
  };

  const handleSelectionChange = (newSelected: Set<string>) => {
    setSelectedIds(newSelected);
    if (!isSelectMode && newSelected.size > 0) {
      setIsSelectMode(true);
    }
  };

  const handlePermanentDeleteSelected = async () => {
    if (selectedIds.size === 0) return;
    setIsDeleting(true);

    const count = selectedIds.size;
    const deleteIds = Array.from(selectedIds);
    const toDelete = photos.filter((p) => selectedIds.has(p.id));
    const filePaths = toDelete.map((p) => p.originalRemotePath || p.filePath);

    try {
      if (window.electronAPI?.deleteFilesPermanently) {
        await window.electronAPI.deleteFilesPermanently(filePaths);
      } else {
        await fetch('/api/delete-files', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filePaths, permanent: true }),
        });
      }

      // Remove photos from library store
      libraryStore.removePhotos(deleteIds);

      // Clear selection
      setSelectedIds(new Set());
      setIsSelectMode(false);
      setShowDeleteConfirmModal(false);

      setAlbumSuccessToast(`✓ Permanently deleted ${count} photo(s) from storage.`);
      setTimeout(() => setAlbumSuccessToast(null), 3500);
    } catch (err: any) {
      alert(`Failed to permanently delete photos: ${err.message}`);
    } finally {
      setIsDeleting(false);
    }
  };

  const filteredPhotos = useMemo(() => {
    let result = photos;

    if (filterFavorite) {
      result = result.filter((p) => p.isFavorite);
    }

    if (filterType === 'all') {
      result = result.filter((p) => !p.isExcluded);
    } else if (filterType === 'faces') {
      result = result.filter((p) => !p.isExcluded && p.faces && p.faces.length > 0);
    } else if (filterType === 'nofaces') {
      result = result.filter((p) => !p.isExcluded && (!p.faces || p.faces.length === 0));
    } else if (filterType === 'excluded') {
      result = result.filter((p) => p.isExcluded);
    }

    return result;
  }, [photos, filterFavorite, filterType]);

  const toggleSelectPhoto = (photoId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(photoId)) {
        next.delete(photoId);
      } else {
        next.add(photoId);
      }
      return next;
    });
  };

  const handleSelectAll = () => {
    setSelectedIds(new Set(filteredPhotos.map((p) => p.id)));
  };

  const handleClearSelection = () => {
    setSelectedIds(new Set());
    setIsSelectMode(false);
  };

  const handleExcludeSelected = (exclude: boolean) => {
    if (selectedIds.size === 0) return;
    libraryStore.excludePhotos(Array.from(selectedIds), exclude);
    setSelectedIds(new Set());
    setIsSelectMode(false);
  };

  const handleRefreshThumbnailsFromSource = async () => {
    if (selectedIds.size === 0 || isRefreshingThumbnails) return;
    setIsRefreshingThumbnails(true);

    try {
      const selectedPhotos = photos.filter((p) => selectedIds.has(p.id));
      const itemsToRefresh = selectedPhotos.map((p) => ({
        filePath: p.filePath,
        originalRemotePath: p.originalRemotePath,
      }));

      // 1. Evict from frontend in-memory store so UI immediately requests fresh buffers
      selectedPhotos.forEach((p) => {
        if (p.thumbnailPath) batchThumbnailStore.delete(p.thumbnailPath);
        if (p.filePath) batchThumbnailStore.delete(p.filePath);
        if (p.originalRemotePath) batchThumbnailStore.delete(p.originalRemotePath);
      });

      // 2. Call backend to purge disk caches and regenerate fresh thumbnails
      let result: { refreshedCount: number; errors: string[] } = { refreshedCount: 0, errors: [] };
      if (window.electronAPI?.refreshThumbnailsFromSource) {
        result = await window.electronAPI.refreshThumbnailsFromSource(itemsToRefresh);
      } else {
        const res = await fetch('/api/thumbnails/refresh-from-source', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items: itemsToRefresh }),
        });
        if (res.ok) result = await res.json();
      }

      // 3. Immediately re-request fresh batch thumbnails for display
      const batchItems = selectedPhotos.map((p) => ({
        path: p.thumbnailPath || p.filePath,
        originalPath: p.originalRemotePath,
      }));
      requestBatchThumbnails(batchItems, 250);

      setRefreshToast(`✓ Refreshed thumbnail cache for ${selectedPhotos.length} photo(s) from source!`);
      setTimeout(() => setRefreshToast(null), 4000);
    } catch (err: any) {
      console.error('[GalleryView] Error refreshing thumbnails from source:', err);
      setRefreshToast(`Failed to refresh thumbnails: ${err.message || 'Unknown error'}`);
      setTimeout(() => setRefreshToast(null), 4000);
    } finally {
      setIsRefreshingThumbnails(false);
    }
  };

  // (groupedPhotos & gridColumns are handled internally with virtualized windowing by VirtualizedTimelineGallery)

  if (photos.length === 0) {
    const isScanning = libraryStore.getState().isScanning;
    if (isScanning) {
      return (
        <div style={{
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '32px',
          textAlign: 'center',
        }}>
          <div style={{
            width: '64px',
            height: '64px',
            borderRadius: '50%',
            background: 'rgba(59, 130, 246, 0.12)',
            border: '1px solid rgba(59, 130, 246, 0.3)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: '20px',
            color: 'var(--accent-primary)',
          }}>
            <RefreshCw size={28} className="animate-spin" />
          </div>
          <h2 style={{ fontSize: '1.3rem', fontWeight: 700, marginBottom: '8px' }}>
            Preparing Your Library...
          </h2>
          <p style={{ color: 'var(--text-muted)', maxWidth: '420px', fontSize: '0.9rem', marginBottom: '16px' }}>
            Scanning photos and building local thumbnail cache. Your gallery will appear automatically.
          </p>
          <div style={{
            width: '200px',
            height: '4px',
            background: 'rgba(255,255,255,0.08)',
            borderRadius: '9999px',
            overflow: 'hidden',
            position: 'relative',
          }}>
            <div style={{
              position: 'absolute',
              top: 0, bottom: 0, left: 0,
              width: '40%',
              background: 'linear-gradient(90deg, #3b82f6, #8b5cf6, #ec4899)',
              borderRadius: '9999px',
              animation: 'inline-shimmer 1.5s infinite ease-in-out',
            }} />
          </div>
        </div>
      );
    }

    return (
      <div style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '32px',
        textAlign: 'center',
        overflowY: 'auto',
      }}>
        <div style={{
          width: '72px',
          height: '72px',
          borderRadius: 'var(--radius-lg)',
          backgroundColor: 'var(--bg-surface-elevated)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: '20px',
          color: 'var(--accent-primary)',
        }}>
          <FolderOpen size={36} />
        </div>
        <h2 style={{ fontSize: '1.4rem', fontWeight: 700, marginBottom: '8px' }}>
          No Photos in Library Yet
        </h2>
        <p style={{ color: 'var(--text-muted)', maxWidth: '420px', marginBottom: '24px', fontSize: '0.9rem' }}>
          Select a local photo directory, or browse one of your saved network/cloud mirrors below.
        </p>

        <button className="btn btn-primary" onClick={onOpenFolder} style={{ padding: '10px 24px', marginBottom: '24px' }}>
          <FolderOpen size={18} />
          <span>Select Local Photo Folder</span>
        </button>

        {/* Quick Access to Network Mirrors if configured */}
        {virtualStorages && virtualStorages.length > 0 && (
          <div style={{
            maxWidth: '560px',
            width: '100%',
            backgroundColor: 'var(--bg-surface)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-lg)',
            padding: '20px',
            textAlign: 'left',
          }}>
            <div style={{
              fontSize: '0.8rem',
              fontWeight: 700,
              textTransform: 'uppercase',
              color: 'var(--accent-cyan)',
              marginBottom: '12px',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
            }}>
              <HardDrive size={15} />
              <span>Configured Network & Cloud Mirrors</span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {virtualStorages.map((storage) => (
                <div
                  key={storage.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '10px 14px',
                    borderRadius: 'var(--radius-md)',
                    backgroundColor: 'var(--bg-surface-elevated)',
                    border: '1px solid var(--border-subtle)',
                  }}
                >
                  <div>
                    <div style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                      {storage.name}
                    </div>
                    <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                      {storage.totalItems || 0} photos • {storage.networkSourcePath}
                    </div>
                  </div>

                  <button
                    className="btn btn-secondary"
                    onClick={() => onSelectStorage && onSelectStorage(storage)}
                    style={{ fontSize: '0.78rem', padding: '6px 14px' }}
                  >
                    Open Library
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  const excludedCount = photos.filter((p) => p.isExcluded).length;

  const handleAddSelectedToAlbum = (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedIds.size === 0) return;
    const ids = Array.from(selectedIds);

    let albumName = '';
    const currentAlbums = libraryStore.getState().albums || [];
    if (targetAlbumId === 'new') {
      if (!newAlbumTitle.trim()) return;
      const created = libraryStore.createAlbum(newAlbumTitle.trim());
      libraryStore.addPhotosToAlbum(created.id, ids);
      albumName = created.title;
    } else {
      const existing = currentAlbums.find((a) => a.id === targetAlbumId);
      if (!existing) return;
      libraryStore.addPhotosToAlbum(existing.id, ids);
      albumName = existing.title;
    }

    setAlbumSuccessToast(`✓ Added ${ids.length} photo(s) to album "${albumName}"!`);
    setTimeout(() => setAlbumSuccessToast(null), 3500);

    setSelectedIds(new Set());
    setIsSelectMode(false);
    setShowAlbumDialog(false);
    setNewAlbumTitle('');
  };

  const existingAlbums = libraryStore.getState().albums || [];

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Gallery Subheader Controls */}
      <div style={{
        padding: '10px 24px',
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '12px',
        borderBottom: '1px solid var(--border-subtle)',
        backgroundColor: 'var(--bg-app)',
      }}>
        {/* Left Section: Timeline title & Filters */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-secondary)' }}>
            <Calendar size={18} />
            <span style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--text-primary)' }}>
              {filterFavorite ? 'Favorite Photos' : 'Timeline'}
            </span>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
              ({filterFavorite || filterType !== 'all' ? filteredPhotos.length : (totalCount || filteredPhotos.length)})
            </span>

            {filteredPhotos.some((p) => p.isVirtual) && (
              <span style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px',
                fontSize: '11px',
                padding: '2px 8px',
                borderRadius: 'var(--radius-full)',
                backgroundColor: 'rgba(6, 182, 212, 0.15)',
                color: 'var(--accent-cyan)',
                border: '1px solid rgba(6, 182, 212, 0.3)',
                fontWeight: 600,
                marginLeft: '6px',
              }}>
                <HardDrive size={12} />
                {filteredPhotos.find((p) => p.isVirtual)?.storageName || 'Network Mirror'}
              </span>
            )}
          </div>

          {/* Quick Filters */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            backgroundColor: 'var(--bg-surface-elevated)',
            padding: '2px',
            borderRadius: 'var(--radius-md)',
            border: '1px solid var(--border-subtle)',
          }}>
            <button
              className={`btn ${filterType === 'all' ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => setFilterType('all')}
              style={{ padding: '3px 10px', fontSize: '0.75rem', height: '26px' }}
            >
              All
            </button>
            <button
              className={`btn ${filterType === 'faces' ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => setFilterType('faces')}
              style={{ padding: '3px 10px', fontSize: '0.75rem', height: '26px' }}
            >
              Portraits
            </button>
            <button
              className={`btn ${filterType === 'nofaces' ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => setFilterType('nofaces')}
              style={{ padding: '3px 10px', fontSize: '0.75rem', height: '26px' }}
              title="Photos with no faces detected (scenery, objects, documents)"
            >
              No Faces
            </button>
            {excludedCount > 0 && (
              <button
                className={`btn ${filterType === 'excluded' ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => setFilterType('excluded')}
                style={{
                  padding: '3px 10px',
                  fontSize: '0.75rem',
                  height: '26px',
                  color: filterType === 'excluded' ? 'white' : 'var(--accent-rose)',
                }}
              >
                Hidden ({excludedCount})
              </button>
            )}
          </div>
        </div>

        {/* Right Section: Tools, Select Mode, Cleaner, Grid Size */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          {/* Select Photos Toggle */}
          <button
            className={`btn ${isSelectMode ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => {
              setIsSelectMode(!isSelectMode);
              if (isSelectMode) setSelectedIds(new Set());
            }}
            style={{ padding: '6px 14px', fontSize: '0.82rem', gap: '8px', height: '34px' }}
          >
            <CheckSquare size={16} />
            <span>{isSelectMode ? 'Cancel Select' : 'Select'}</span>
          </button>

          {/* Clean Duplicates Trigger */}
          {onOpenDuplicateCleaner && (
            <button
              className="btn btn-secondary"
              onClick={onOpenDuplicateCleaner}
              style={{ padding: '6px 14px', fontSize: '0.82rem', gap: '8px', height: '34px', borderColor: 'rgba(99, 102, 241, 0.4)' }}
              title="Identify duplicate bursts, score best shots, and safely delete inferior copies"
            >
              <Layers size={16} color="#818cf8" />
              <span>Clean Duplicates</span>
            </button>
          )}

          {filteredPhotos.some((p) => p.isVirtual) && onRefreshNetwork && (
            <button
              className="btn btn-secondary"
              onClick={onRefreshNetwork}
              style={{ padding: '6px 12px', fontSize: '0.82rem', gap: '8px', height: '34px' }}
              title="Rescan network location for newly added photos"
            >
              <RefreshCw size={15} />
              <span>Rescan</span>
            </button>
          )}

          {/* Ask AI Search Button */}
          {onOpenAiSearch && (
            <button
              className="btn btn-secondary"
              onClick={onOpenAiSearch}
              style={{
                padding: '6px 14px',
                fontSize: '0.82rem',
                gap: '8px',
                height: '34px',
                background: 'linear-gradient(135deg, rgba(99, 102, 241, 0.15) 0%, rgba(168, 85, 247, 0.15) 100%)',
                borderColor: 'rgba(168, 85, 247, 0.4)',
                fontWeight: 600,
              }}
              title="Natural language photo search with AI assistant"
            >
              <Sparkles size={16} color="#c084fc" />
              <span>Ask AI</span>
            </button>
          )}

          {/* Zoom Controls: Out, 6 Levels, In */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
            <button
              className="btn btn-ghost btn-icon"
              disabled={zoomLevel === 'years'}
              onClick={() => {
                const idx = ZOOM_LEVELS.indexOf(zoomLevel);
                if (idx > 0) setZoomLevel(ZOOM_LEVELS[idx - 1]);
              }}
              style={{ width: '30px', height: '30px' }}
              title="Zoom Out (Ctrl + Wheel Down)"
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
              title="Ctrl + Mouse Wheel to zoom"
            >
              {([
                { id: 'years', label: 'Years' },
                { id: 'months', label: 'Months' },
                { id: 'very_small', label: 'XS' },
                { id: 'small', label: 'S' },
                { id: 'medium', label: 'M' },
                { id: 'large', label: 'L' },
              ] as const).map(({ id, label }) => (
                <button
                  key={id}
                  className={`btn ${zoomLevel === id ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => setZoomLevel(id)}
                  style={{ padding: '3px 8px', fontSize: '0.74rem', height: '26px' }}
                >
                  {label}
                </button>
              ))}
            </div>

            <button
              className="btn btn-ghost btn-icon"
              disabled={zoomLevel === 'large'}
              onClick={() => {
                const idx = ZOOM_LEVELS.indexOf(zoomLevel);
                if (idx < ZOOM_LEVELS.length - 1) setZoomLevel(ZOOM_LEVELS[idx + 1]);
              }}
              style={{ width: '30px', height: '30px' }}
              title="Zoom In (Ctrl + Wheel Up)"
            >
              <ZoomIn size={15} />
            </button>
          </div>

          {onOpenHelp && (
            <button
              className="btn btn-ghost btn-icon"
              onClick={onOpenHelp}
              style={{
                width: '34px',
                height: '34px',
                borderRadius: 'var(--radius-full)',
                color: 'var(--accent-primary)',
                backgroundColor: 'rgba(59, 130, 246, 0.1)',
              }}
              title="User Guide & Feature Help"
            >
              <HelpCircle size={18} />
            </button>
          )}
        </div>
      </div>

      {/* Multi-Selection Floating / Sticky Action Bar */}
      {(isSelectMode || selectedIds.size > 0) && (
        <div style={{
          backgroundColor: 'rgba(15, 23, 42, 0.95)',
          borderBottom: '1px solid var(--accent-primary)',
          padding: '10px 24px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '12px',
          backdropFilter: 'blur(8px)',
          zIndex: 20,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <span style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--accent-cyan)' }}>
              {selectedIds.size} of {filteredPhotos.length} selected
            </span>
            <button
              className="btn btn-ghost"
              onClick={handleSelectAll}
              style={{ fontSize: '0.8rem', padding: '4px 10px' }}
            >
              Select All
            </button>
            <button
              className="btn btn-ghost"
              onClick={handleClearSelection}
              style={{ fontSize: '0.8rem', padding: '4px 10px' }}
            >
              Clear
            </button>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            {/* Refresh Thumbnail Cache from Source Button */}
            <button
              className="btn btn-secondary"
              onClick={handleRefreshThumbnailsFromSource}
              disabled={isRefreshingThumbnails || selectedIds.size === 0}
              style={{
                fontSize: '0.85rem',
                gap: '8px',
                padding: '6px 14px',
                borderColor: 'rgba(56, 189, 248, 0.4)',
                backgroundColor: 'rgba(56, 189, 248, 0.1)',
                color: 'var(--accent-cyan)',
              }}
              title="Purge cached thumbnails and regenerate fresh thumbnails directly from source files"
            >
              <RefreshCw size={16} className={isRefreshingThumbnails ? 'animate-spin' : ''} color="var(--accent-cyan)" />
              <span>{isRefreshingThumbnails ? 'Refreshing...' : `Refresh Cache (${selectedIds.size})`}</span>
            </button>

            {/* Add to Album Button */}
            <button
              className="btn btn-secondary"
              onClick={() => setShowAlbumDialog(true)}
              disabled={selectedIds.size === 0}
              style={{ fontSize: '0.85rem', gap: '8px', padding: '6px 14px' }}
              title="Add selected photos to an album"
            >
              <FolderPlus size={16} color="var(--accent-primary)" />
              <span>Add to Album</span>
            </button>

            {/* Permanently Delete Selected Button */}
            <button
              className="btn btn-secondary"
              onClick={() => setShowDeleteConfirmModal(true)}
              disabled={selectedIds.size === 0}
              style={{
                fontSize: '0.85rem',
                gap: '8px',
                color: '#ef4444',
                borderColor: 'rgba(239, 68, 68, 0.4)',
                backgroundColor: 'rgba(239, 68, 68, 0.1)',
                padding: '6px 14px',
              }}
              title="Permanently delete selected photos from disk"
            >
              <Trash2 size={16} color="#ef4444" />
              <span>Delete Selected ({selectedIds.size})</span>
            </button>

            {filterType === 'excluded' ? (
              <button
                className="btn btn-primary"
                onClick={() => handleExcludeSelected(false)}
                disabled={selectedIds.size === 0}
                style={{ fontSize: '0.85rem', gap: '8px', padding: '6px 14px' }}
              >
                <Eye size={16} />
                <span>Restore to App ({selectedIds.size})</span>
              </button>
            ) : (
              <button
                className="btn btn-secondary"
                onClick={() => handleExcludeSelected(true)}
                disabled={selectedIds.size === 0}
                style={{ fontSize: '0.85rem', gap: '8px', color: 'var(--accent-rose)', padding: '6px 14px' }}
                title="Exclude selected photos from views without deleting source files"
              >
                <EyeOff size={16} />
                <span>Exclude from App ({selectedIds.size})</span>
              </button>
            )}
          </div>
        </div>
      )}

      {/* Thumbnail Refresh Toast Notification */}
      {refreshToast && (
        <div
          style={{
            padding: '8px 24px',
            backgroundColor: 'rgba(14, 165, 233, 0.15)',
            borderBottom: '1px solid rgba(14, 165, 233, 0.4)',
            color: 'var(--accent-cyan)',
            fontSize: '0.85rem',
            fontWeight: 500,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            zIndex: 19,
          }}
        >
          <span>{refreshToast}</span>
          <button
            onClick={() => setRefreshToast(null)}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--text-muted)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
            }}
          >
            <X size={15} />
          </button>
        </div>
      )}

      {/* AI Search Active Filter Banner */}
      {activeAiFilter && (
        <div
          style={{
            padding: '10px 24px',
            backgroundColor: 'rgba(99, 102, 241, 0.12)',
            borderBottom: '1px solid rgba(168, 85, 247, 0.3)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '12px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <Sparkles size={16} color="#c084fc" />
            <span style={{ fontSize: '0.88rem', fontWeight: 600, color: 'var(--text-primary)' }}>
              AI Search: "{activeAiFilter.queryText}"
            </span>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
              ({filteredPhotos.length} {filteredPhotos.length === 1 ? 'photo' : 'photos'} found)
            </span>
          </div>

          {onClearAiFilter && (
            <button
              className="btn btn-ghost"
              onClick={onClearAiFilter}
              style={{
                fontSize: '0.78rem',
                height: '28px',
                padding: '0 10px',
                gap: '4px',
                color: 'var(--accent-rose)',
              }}
            >
              <X size={14} />
              <span>Clear AI Filter</span>
            </button>
          )}
        </div>
      )}

      {/* Virtualized Timeline Gallery Supporting 6 Zoom Levels (Years, Months, XS, S, M, L) and 50k+ Photos */}
      <VirtualizedTimelineGallery
        photos={filteredPhotos}
        zoomLevel={zoomLevel}
        onZoomChange={setZoomLevel}
        onSelectPhoto={onSelectPhoto}
        onToggleFavorite={onToggleFavorite}
        isSelectMode={isSelectMode || selectedIds.size > 0}
        selectedIds={selectedIds}
        onToggleSelect={toggleSelectPhoto}
        onDragSelect={handleDragSelect}
        onSelectionChange={handleSelectionChange}
        emptyMessage="No photos found matching the selected filter."
      />

      {/* Toast Notification */}
      {albumSuccessToast && (
        <div
          style={{
            position: 'absolute',
            top: '16px',
            right: '24px',
            zIndex: 100,
            padding: '12px 20px',
            backgroundColor: 'rgba(16, 185, 129, 0.95)',
            color: 'white',
            fontWeight: 600,
            fontSize: '0.88rem',
            borderRadius: 'var(--radius-md)',
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.4)',
            backdropFilter: 'blur(8px)',
          }}
        >
          {albumSuccessToast}
        </div>
      )}

      {/* Modal: Add to Album */}
      {showAlbumDialog && (
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
            padding: '24px',
          }}
          onClick={() => setShowAlbumDialog(false)}
        >
          <div
            style={{
              width: '100%',
              maxWidth: '460px',
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
                  Add to Album ({selectedIds.size})
                </h3>
              </div>
              <button
                className="btn btn-ghost btn-icon"
                onClick={() => setShowAlbumDialog(false)}
                style={{ width: '36px', height: '36px' }}
              >
                <X size={20} />
              </button>
            </div>

            <form onSubmit={handleAddSelectedToAlbum} style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
              {existingAlbums.length > 0 && (
                <div>
                  <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '6px' }}>
                    Choose Album
                  </label>
                  <select
                    className="input"
                    value={targetAlbumId}
                    onChange={(e) => setTargetAlbumId(e.target.value)}
                    style={{ height: '40px', width: '100%' }}
                  >
                    <option value="new">+ Create New Album...</option>
                    {existingAlbums.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.title} ({a.photoIds.length} photos)
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {targetAlbumId === 'new' && (
                <div>
                  <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '6px' }}>
                    New Album Title <span style={{ color: 'var(--accent-rose)' }}>*</span>
                  </label>
                  <input
                    type="text"
                    className="input"
                    placeholder="e.g. Summer Roadtrip, Wedding 2024"
                    value={newAlbumTitle}
                    onChange={(e) => setNewAlbumTitle(e.target.value)}
                    autoFocus
                    required={targetAlbumId === 'new'}
                    style={{ height: '40px' }}
                  />
                </div>
              )}

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '12px' }}>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => setShowAlbumDialog(false)}
                  style={{ height: '40px', padding: '0 18px' }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={targetAlbumId === 'new' && !newAlbumTitle.trim()}
                  style={{ height: '40px', padding: '0 22px' }}
                >
                  Add Photos
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal: Permanent Deletion Confirmation */}
      {showDeleteConfirmModal && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(5, 8, 15, 0.88)',
            backdropFilter: 'blur(10px)',
            zIndex: 3600,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '24px',
          }}
          onClick={() => !isDeleting && setShowDeleteConfirmModal(false)}
        >
          <div
            style={{
              width: '100%',
              maxWidth: '460px',
              backgroundColor: 'var(--bg-surface)',
              borderRadius: 'var(--radius-lg)',
              border: '1px solid rgba(239, 68, 68, 0.4)',
              boxShadow: '0 24px 60px rgba(0, 0, 0, 0.8), 0 0 25px rgba(239, 68, 68, 0.2)',
              padding: '24px',
              display: 'flex',
              flexDirection: 'column',
              gap: '16px',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header with Warning Icon */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
              <div
                style={{
                  width: '46px',
                  height: '46px',
                  borderRadius: '50%',
                  backgroundColor: 'rgba(239, 68, 68, 0.15)',
                  border: '1px solid rgba(239, 68, 68, 0.4)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                <AlertTriangle size={24} color="#ef4444" />
              </div>
              <div>
                <h3 style={{ margin: 0, fontSize: '1.15rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                  Permanently Delete Photos?
                </h3>
                <span style={{ fontSize: '0.80rem', color: '#f87171', fontWeight: 600 }}>
                  Irreversible Action
                </span>
              </div>
            </div>

            <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: '0.88rem', lineHeight: 1.5 }}>
              Are you sure you want to delete <strong>{selectedIds.size}</strong> selected photo(s)?
            </p>

            <div
              style={{
                backgroundColor: 'rgba(239, 68, 68, 0.08)',
                border: '1px solid rgba(239, 68, 68, 0.25)',
                borderRadius: 'var(--radius-md)',
                padding: '12px 14px',
                fontSize: '0.82rem',
                color: '#fca5a5',
                lineHeight: 1.4,
              }}
            >
              ⚠️ <strong>Warning:</strong> This will permanently delete this from your storage disk. This cannot be undone and files cannot be restored from the Recycle Bin.
            </div>

            {/* Action Buttons */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '8px' }}>
              <button
                className="btn btn-secondary"
                type="button"
                onClick={() => setShowDeleteConfirmModal(false)}
                disabled={isDeleting}
                style={{ padding: '8px 16px' }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={handlePermanentDeleteSelected}
                disabled={isDeleting}
                style={{
                  backgroundColor: '#dc2626',
                  borderColor: '#b91c1c',
                  color: 'white',
                  gap: '8px',
                  padding: '8px 18px',
                  fontWeight: 600,
                }}
              >
                <Trash2 size={16} />
                <span>{isDeleting ? 'Deleting...' : `Permanently Delete (${selectedIds.size})`}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

