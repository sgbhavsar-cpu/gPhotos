import React, { useState, useMemo, useEffect, useCallback } from 'react';
import {
  Image as ImageIcon,
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
  AlertTriangle,
  MoreVertical,
  RotateCw,
  Wand2
} from 'lucide-react';
import { Photo, VirtualStorageConfig, Album } from '../../../types';
import { PhotoCard } from '../components/PhotoCard';
import { AlbumPicker } from '../components/AlbumPicker';
import { ChapterSelectStep } from '../components/ChapterSelectStep';
import { libraryStore } from '../services/libraryStore';
import { VirtualizedTimelineGallery, GalleryZoomLevel, ZOOM_LEVELS } from '../components/VirtualizedTimelineGallery';
import { AiPhotoFilter } from '../services/aiSearchService';
import { batchThumbnailStore, requestBatchThumbnails } from '../services/asyncImageLoader';
import { createClusterFromSelectedPhotos } from '../services/deduplication';
import { authFetch } from '../services/webAuthClient';
import { useIsMobile } from '../hooks/useIsMobile';
import { BulkEditModal } from '../components/BulkEditModal';
import { autoRotateUpright } from '../services/autoRotateUpright';
import { notify, notifyError } from '../services/notifications';

interface GalleryViewProps {
  photos: Photo[];
  onSelectPhoto: (photo: Photo) => void;
  onToggleFavorite: (photoId: string) => void;
  onOpenFolder: () => void;
  onRefreshNetwork?: () => void;
  /** Local-library counterpart of onRefreshNetwork (see docs/FEATURE_VIDEO_LIBRARY_SUPPORT.md). */
  onRescanLocalLibrary?: () => void;
  filterFavorite?: boolean;
  virtualStorages?: VirtualStorageConfig[];
  onSelectStorage?: (storage: VirtualStorageConfig) => void;
  onOpenDuplicateCleaner?: (cluster?: any) => void;
  /** Opens Smart Flows pre-scoped to the currently selected photos. */
  onRunSmartFlow?: (photos: Photo[]) => void;
  /** The active library's folder path — its last path segment is shown as the page title. */
  libraryFolder?: string | null;
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
  onRescanLocalLibrary,
  filterFavorite = false,
  virtualStorages = [],
  onSelectStorage,
  onOpenDuplicateCleaner,
  onRunSmartFlow,
  libraryFolder,
  onOpenHelp,
  onOpenAiSearch,
  activeAiFilter,
  onClearAiFilter,
  resetTrigger,
  totalCount,
}) => {
  const [zoomLevel, setZoomLevel] = useState<GalleryZoomLevel>('medium');
  const [filterType, setFilterType] = useState<'all' | 'faces' | 'nofaces' | 'noalbum' | 'excluded'>('all');
  const [isSelectMode, setIsSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const isMobile = useIsMobile();
  const [showMobileTools, setShowMobileTools] = useState(false);

  // Album Dialog states
  const [showAlbumDialog, setShowAlbumDialog] = useState(false);
  const [albumSuccessToast, setAlbumSuccessToast] = useState<string | null>(null);
  // Step 2 of the dialog: once an album is picked (or created), which chapter to add into — null
  // means still on step 1 (picking the album itself).
  const [albumPendingChapterSelection, setAlbumPendingChapterSelection] = useState<Album | null>(null);

  // Bulk date/location edit modal
  const [showBulkEditModal, setShowBulkEditModal] = useState(false);

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

      // stopImmediatePropagation, not stopPropagation — see PeopleView's
      // matching Escape handler for why (App.tsx's global handler is also
      // bound to `window` and stopPropagation alone won't stop it firing).
      if (showBulkEditModal) {
        e.stopImmediatePropagation();
        setShowBulkEditModal(false);
      } else if (showAlbumDialog) {
        e.stopImmediatePropagation();
        if (albumPendingChapterSelection) setAlbumPendingChapterSelection(null); // back to picking the album
        else setShowAlbumDialog(false);
      } else if (showDeleteConfirmModal) {
        e.stopImmediatePropagation();
        setShowDeleteConfirmModal(false);
      } else if (isSelectMode || selectedIds.size > 0) {
        e.stopImmediatePropagation();
        setIsSelectMode(false);
        setSelectedIds(new Set());
      }
    };

    // capture: true — see PeopleView's matching Escape handler for why.
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, [showBulkEditModal, showAlbumDialog, albumPendingChapterSelection, showDeleteConfirmModal, isSelectMode, selectedIds]);

  // Stable reference so the gallery's near-bottom/bootstrap load-more effects
  // don't re-fire on every unrelated re-render. Loads several pages ahead
  // (not just one) so there's a multi-screenful buffer of photos ready
  // before the user actually scrolls into them.
  const handleLoadMore = useCallback(() => {
    libraryStore.loadNextCatalogPages(3);
  }, []);

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

  // Automatic upright rotation of the selection (see services/autoRotateUpright.ts).
  const [autoRotateBusy, setAutoRotateBusy] = useState(false);
  const [autoRotateLabel, setAutoRotateLabel] = useState('Working…');
  const handleAutoRotateSelected = async () => {
    if (autoRotateBusy || selectedIds.size === 0) return;
    const selected = photos.filter((p) => selectedIds.has(p.id));
    setAutoRotateBusy(true);
    setAutoRotateLabel('Checking…');
    try {
      await autoRotateUpright(selected, {
        onProgress: (stage, done, total) =>
          setAutoRotateLabel(stage === 'detecting' ? `Checking ${done}/${total}…` : `Rotating ${done}/${total}…`),
      });
    } finally {
      setAutoRotateBusy(false);
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

    const toDelete = photos.filter((p) => selectedIds.has(p.id));
    const filePaths = toDelete.map((p) => p.originalRemotePath || p.filePath);

    try {
      // Only remove photos from the library that were ACTUALLY deleted on disk —
      // previously every selected photo was removed from the UI regardless of
      // whether the delete succeeded, so a photo on an offline network storage
      // would silently vanish from the library while its file was untouched.
      let deletedIds = toDelete.map((p) => p.id);
      let failureMessage: string | null = null;

      if (window.electronAPI?.deleteFilesPermanently) {
        const result = await window.electronAPI.deleteFilesPermanently(filePaths);
        const deletedPathSet = new Set(result.deletedPaths);
        deletedIds = toDelete
          .filter((p) => deletedPathSet.has(p.originalRemotePath || p.filePath))
          .map((p) => p.id);

        if (result.errors.length > 0) {
          const offlineCount = result.errors.filter((e) => e.includes('network storage is not available')).length;
          failureMessage = offlineCount > 0
            ? `${offlineCount} of ${toDelete.length} photo(s) skipped — network storage is not available.`
            : `${result.errors.length} of ${toDelete.length} photo(s) could not be deleted.`;
        }
      } else {
        const res = await authFetch('/api/delete-files', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filePaths, permanent: true }),
        });
        if (!res.ok) throw new Error(`The server refused the delete (HTTP ${res.status}). Nothing was deleted.`);
        try {
          // If the server reports exactly what it deleted, only remove those from the library.
          const body = await res.json();
          if (body && Array.isArray(body.deletedPaths)) {
            const deleted = new Set<string>(body.deletedPaths);
            deletedIds = toDelete.filter((p) => deleted.has(p.originalRemotePath || p.filePath)).map((p) => p.id);
            if (deletedIds.length < toDelete.length) {
              failureMessage = `${toDelete.length - deletedIds.length} of ${toDelete.length} photo(s) could not be deleted.`;
            }
          }
        } catch {
          // Body isn't JSON: an ok status is all we can go on.
        }
      }

      if (deletedIds.length > 0) {
        libraryStore.removePhotos(deletedIds);
      }

      // Clear selection
      setSelectedIds(new Set());
      setIsSelectMode(false);
      setShowDeleteConfirmModal(false);

      if (failureMessage) {
        notify('error', failureMessage);
        setAlbumSuccessToast(
          deletedIds.length > 0
            ? `⚠ Deleted ${deletedIds.length} photo(s). ${failureMessage}`
            : `⚠ ${failureMessage}`
        );
        setTimeout(() => setAlbumSuccessToast(null), 6000);
      } else {
        setAlbumSuccessToast(`✓ Permanently deleted ${deletedIds.length} photo(s) from storage.`);
        setTimeout(() => setAlbumSuccessToast(null), 3500);
      }
    } catch (err: any) {
      notifyError('Delete photos', err);
    } finally {
      setIsDeleting(false);
    }
  };

  // Which photos are in at least one album. Albums are edited in place (same array, same objects), so the
  // memo is keyed on a cheap fingerprint — id + updatedAt + size of each album — rather than on the array.
  const albumsNow = libraryStore.getState().albums || [];
  const albumFingerprint = albumsNow.map((a) => a.id + ':' + a.updatedAt + ':' + a.photoIds.length).join('|');
  const photoIdsInAnAlbum = useMemo(() => {
    const ids = new Set<string>();
    for (const a of albumsNow) for (const id of a.photoIds) ids.add(id);
    return ids;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [albumFingerprint]);

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
    } else if (filterType === 'noalbum') {
      result = result.filter((p) => !p.isExcluded && !photoIdsInAnAlbum.has(p.id));
    } else if (filterType === 'excluded') {
      result = result.filter((p) => p.isExcluded);
    }

    return result;
  }, [photos, filterFavorite, filterType, photoIdsInAnAlbum]);

  // Derived values that used to be recomputed by scanning every photo on each render (each selection toggle).
  const excludedCount = useMemo(() => photos.filter((p) => p.isExcluded).length, [photos]);
  const firstVirtualStorageName = useMemo(() => {
    const v = filteredPhotos.find((p) => p.isVirtual);
    return v ? (v.storageName || 'Network Mirror') : null;
  }, [filteredPhotos]);
  const hasVirtual = firstVirtualStorageName !== null;
  const selectedPhotosForEdit = useMemo(
    () => (showBulkEditModal ? photos.filter((p) => selectedIds.has(p.id)) : []),
    [showBulkEditModal, photos, selectedIds]
  );

  // createClusterFromSelectedPhotos returns null unless 2+ distinct, non-hidden photos are selected;
  // passing null on would open the cleaner in whole-library scan mode.
  const openBestShotForSelection = () => {
    if (!onOpenDuplicateCleaner) return;
    try {
      const selectedPhotos = photos.filter((p) => selectedIds.has(p.id));
      const cluster = createClusterFromSelectedPhotos(selectedPhotos);
      if (!cluster) {
        notify('info', 'Select at least 2 different, visible photos to compare for the best shot.');
        return;
      }
      onOpenDuplicateCleaner(cluster);
    } catch (err) {
      notifyError('Find best shot', err);
    }
  };

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
        const res = await authFetch('/api/thumbnails/refresh-from-source', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items: itemsToRefresh }),
        });
        if (!res.ok) throw new Error(`The server could not refresh the thumbnails (HTTP ${res.status})`);
        result = await res.json();
      }
      if (result && result.errors && result.errors.length > 0) {
        notify('warning', `${result.errors.length} thumbnail(s) could not be refreshed from source.`, result.errors.join('\n'));
      }

      // 3. Immediately re-request fresh batch thumbnails for display
      const batchItems = selectedPhotos.map((p) => ({
        path: p.thumbnailPath || p.filePath,
        originalPath: p.originalRemotePath,
      }));
      requestBatchThumbnails(batchItems, 250);

      const failedCount = result?.errors?.length || 0;
      setRefreshToast(
        failedCount > 0
          ? `⚠ Refreshed ${Math.max(0, selectedPhotos.length - failedCount)} of ${selectedPhotos.length} thumbnail(s); ${failedCount} failed.`
          : `✓ Refreshed thumbnail cache for ${selectedPhotos.length} photo(s) from source!`
      );
      setTimeout(() => setRefreshToast(null), 4000);
    } catch (err: any) {
      notifyError('Refresh thumbnails from source', err);
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

  const closeAlbumDialog = () => {
    setShowAlbumDialog(false);
    setAlbumPendingChapterSelection(null);
  };

  // Step 1: pick (or create) the album — moves to step 2 (chapter selection) rather than adding
  // right away, so every bulk add goes through a chapter, even an album that doesn't have any yet.
  const handlePickAlbum = (album: Album) => setAlbumPendingChapterSelection(album);
  const handleCreateAlbumAndAdd = (title: string) => {
    const created = libraryStore.createAlbum(title);
    setAlbumPendingChapterSelection(created);
  };

  // Step 2: add the selection into a specific chapter of the already-picked album, or — chapterId
  // null and no newChapterTitle — the "Others" catch-all: reuse it by name if the album already has
  // one, create it otherwise. Pressing Enter with nothing typed takes this same path.
  const finishAddToAlbumChapter = (album: Album, chapterId: string | null, newChapterTitle?: string) => {
    const ids = Array.from(selectedIds);
    let chapterTitle: string;

    if (newChapterTitle) {
      const chapter = libraryStore.createChapter(album.id, newChapterTitle, ids);
      chapterTitle = chapter?.title || newChapterTitle;
    } else {
      const targetId = chapterId || (album.chapters || []).find((c) => c.title.trim().toLowerCase() === 'others')?.id;
      if (targetId) {
        libraryStore.addPhotosToChapter(album.id, targetId, ids);
        chapterTitle = album.chapters?.find((c) => c.id === targetId)?.title || '';
      } else {
        const chapter = libraryStore.createChapter(album.id, 'Others', ids);
        chapterTitle = chapter?.title || 'Others';
      }
    }

    setAlbumSuccessToast(`✓ Added ${ids.length} photo(s) to "${album.title}" → "${chapterTitle}"!`);
    setTimeout(() => setAlbumSuccessToast(null), 3500);

    setSelectedIds(new Set());
    setIsSelectMode(false);
    setShowAlbumDialog(false);
    setAlbumPendingChapterSelection(null);
  };

  const existingAlbums = libraryStore.getState().albums || [];

  // Shared JSX built once and arranged differently for desktop vs mobile
  // below — mobile collapses everything but the title and filter chips
  // behind a single "more options" toggle, instead of letting flex-wrap
  // stack Select/Clean Duplicates/Rescan/Ask AI/zoom controls into four or
  // five separate rows that ate roughly half the screen on a phone.
  // The page header: the library's own name (its folder's last path segment) as a plain title —
  // not a colored pill/badge like the virtual-storage indicator next to it — with a photo icon.
  // Favorites keeps its own "Favorite Photos" label instead, since that page context is what tells
  // it apart from the main Photos tab (both render through this same component).
  const libraryDisplayName = libraryFolder ? (libraryFolder.split(/[\\/]/).filter(Boolean).pop() || 'Library') : 'Library';

  const titleBlock = (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0, overflow: 'hidden' }}>
      <ImageIcon size={isMobile ? 16 : 18} color="var(--text-primary)" style={{ flexShrink: 0 }} />
      <span style={{
        fontSize: isMobile ? '0.9rem' : '1.05rem',
        fontWeight: 700,
        color: 'var(--text-primary)',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}>
        {filterFavorite ? 'Favorite Photos' : libraryDisplayName}
      </span>
    </div>
  );

  const filterChips = (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      backgroundColor: 'var(--bg-surface-elevated)',
      padding: '2px',
      borderRadius: 'var(--radius-md)',
      border: '1px solid var(--border-subtle)',
      flexShrink: 0,
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
      <button
        className={'btn ' + (filterType === 'noalbum' ? 'btn-primary' : 'btn-ghost')}
        onClick={() => setFilterType('noalbum')}
        style={{ padding: '3px 10px', fontSize: '0.75rem', height: '26px' }}
        title="Photos that are not in any album yet"
        data-testid="filter-no-album"
      >
        No Album
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
  );

  // Icon-only, like the zoom controls below — a tooltip (title) carries the label instead of
  // text, so four buttons' worth of toolbar width shrinks to four 34px squares and the whole
  // toolbar stays on one line even on a narrower window.
  const selectButton = (
    <button
      className={`btn btn-icon ${isSelectMode ? 'btn-primary' : 'btn-secondary'}`}
      onClick={() => {
        setIsSelectMode(!isSelectMode);
        if (isSelectMode) setSelectedIds(new Set());
      }}
      style={{ width: '34px', height: '34px' }}
      title={isSelectMode ? 'Cancel selection' : 'Select photos'}
    >
      <CheckSquare size={16} />
    </button>
  );

  const cleanDuplicatesButton = onOpenDuplicateCleaner ? (
    <button
      className="btn btn-icon btn-secondary"
      onClick={() => onOpenDuplicateCleaner()} // NOT onClick={onOpenDuplicateCleaner}: that passes the click event in as the `cluster` argument
      style={{ width: '34px', height: '34px', borderColor: 'rgba(99, 102, 241, 0.4)' }}
      title="Clean Duplicates — identify duplicate bursts, score best shots, and safely delete inferior copies"
    >
      <Layers size={16} color="#818cf8" />
    </button>
  ) : null;

  const rescanButton = (hasVirtual && onRefreshNetwork) ? (
    <button
      className="btn btn-icon btn-secondary"
      onClick={onRefreshNetwork}
      style={{ width: '34px', height: '34px' }}
      title="Rescan — check the network location for newly added photos"
    >
      <RefreshCw size={15} />
    </button>
  ) : (!hasVirtual && onRescanLocalLibrary) ? (
    <button
      className="btn btn-icon btn-secondary"
      onClick={onRescanLocalLibrary}
      style={{ width: '34px', height: '34px' }}
      title="Rescan — check this folder for new or changed files (e.g. videos added since this library was last indexed)"
    >
      <RefreshCw size={15} />
    </button>
  ) : null;

  const askAiButton = onOpenAiSearch ? (
    <button
      className="btn btn-icon btn-secondary"
      onClick={onOpenAiSearch}
      style={{
        width: '34px',
        height: '34px',
        background: 'linear-gradient(135deg, rgba(99, 102, 241, 0.15) 0%, rgba(168, 85, 247, 0.15) 100%)',
        borderColor: 'rgba(168, 85, 247, 0.4)',
      }}
      title="Ask AI — natural language photo search"
    >
      <Sparkles size={16} color="#c084fc" />
    </button>
  ) : null;

  const zoomControls = (
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
  );

  // Compact mobile selection bar: replaces the whole normal mobile header
  // (title/filters/tools toggle) while selecting, and packs the previous
  // desktop-style sticky action bar's half-dozen buttons into two lines —
  // a count/select-all/clear row, and a horizontally-scrollable row of
  // short action buttons — instead of the multi-row wrap that used to run
  // off the right edge of the screen.
  const mobileSelectionBar = (
    <div style={{
      borderBottom: '1px solid var(--accent-primary)',
      backgroundColor: 'rgba(15, 23, 42, 0.95)',
      backdropFilter: 'blur(8px)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 10px' }}>
        <button
          className="btn btn-ghost btn-icon"
          onClick={() => {
            setIsSelectMode(false);
            setSelectedIds(new Set());
          }}
          style={{ width: '30px', height: '30px', flexShrink: 0 }}
          title="Cancel selection"
        >
          <X size={16} />
        </button>
        <span style={{
          fontSize: '0.8rem',
          fontWeight: 600,
          color: 'var(--accent-cyan)',
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {selectedIds.size} of {filteredPhotos.length} selected
        </span>
        <button
          className="btn btn-ghost"
          onClick={handleSelectAll}
          style={{ fontSize: '0.74rem', padding: '4px 8px', flexShrink: 0 }}
        >
          All
        </button>
        <button
          className="btn btn-ghost"
          onClick={handleClearSelection}
          style={{ fontSize: '0.74rem', padding: '4px 8px', flexShrink: 0 }}
        >
          Clear
        </button>
      </div>

      <div style={{
        display: 'flex',
        gap: '8px',
        padding: '0 10px 10px',
        overflowX: 'auto',
        WebkitOverflowScrolling: 'touch',
      }}>
        <button
          className="btn btn-secondary"
          onClick={handleRefreshThumbnailsFromSource}
          disabled={isRefreshingThumbnails || selectedIds.size === 0}
          style={{
            fontSize: '0.78rem',
            gap: '6px',
            padding: '6px 10px',
            flexShrink: 0,
            borderColor: 'rgba(56, 189, 248, 0.4)',
            backgroundColor: 'rgba(56, 189, 248, 0.1)',
            color: 'var(--accent-cyan)',
          }}
          title="Purge cached thumbnails and regenerate fresh thumbnails directly from source files"
        >
          <RefreshCw size={14} className={isRefreshingThumbnails ? 'animate-spin' : ''} color="var(--accent-cyan)" />
          <span>Refresh</span>
        </button>

        <button
          className="btn btn-secondary"
          onClick={handleAutoRotateSelected}
          disabled={autoRotateBusy || selectedIds.size === 0}
          style={{ fontSize: '0.78rem', gap: '6px', padding: '6px 10px', flexShrink: 0 }}
          title="Turn the selected photos upright automatically (looks for people's faces)"
        >
          <RotateCw size={14} className={autoRotateBusy ? 'animate-spin' : ''} />
          <span>{autoRotateBusy ? autoRotateLabel : 'Upright'}</span>
        </button>

        {selectedIds.size >= 2 && onOpenDuplicateCleaner && (
          <button
            className="btn btn-primary"
            onClick={openBestShotForSelection}
            style={{
              fontSize: '0.78rem',
              gap: '6px',
              padding: '6px 10px',
              flexShrink: 0,
              background: 'linear-gradient(135deg, #6366f1 0%, #a855f7 100%)',
              borderColor: '#a855f7',
              color: 'white',
              fontWeight: 600,
            }}
            title="Treat selected photos as one cluster and launch Best Shot finder to compare quality and keep the best"
          >
            <Sparkles size={14} />
            <span>Best Shot</span>
          </button>
        )}

        <button
          className="btn btn-secondary"
          onClick={() => setShowAlbumDialog(true)}
          disabled={selectedIds.size === 0}
          style={{ fontSize: '0.78rem', gap: '6px', padding: '6px 10px', flexShrink: 0 }}
          title="Add selected photos to an album"
        >
          <FolderPlus size={14} color="var(--accent-primary)" />
          <span>Album</span>
        </button>

        {onRunSmartFlow && (
          <button
            className="btn btn-secondary"
            onClick={() => onRunSmartFlow(photos.filter((p) => selectedIds.has(p.id)))}
            disabled={selectedIds.size === 0}
            style={{ fontSize: '0.78rem', gap: '6px', padding: '6px 10px', flexShrink: 0 }}
            title="Run one of your Smart Flows against just the selected photos"
          >
            <Wand2 size={14} color="#c084fc" />
            <span>Smart Flow</span>
          </button>
        )}

        <button
          className="btn btn-secondary"
          onClick={() => setShowBulkEditModal(true)}
          disabled={selectedIds.size === 0}
          style={{ fontSize: '0.78rem', gap: '6px', padding: '6px 10px', flexShrink: 0 }}
          title="Set date/time or location on all selected photos at once"
        >
          <Calendar size={14} color="var(--accent-cyan)" />
          <span>Edit Date/Location</span>
        </button>

        <button
          className="btn btn-secondary"
          onClick={() => setShowDeleteConfirmModal(true)}
          disabled={selectedIds.size === 0}
          style={{
            fontSize: '0.78rem',
            gap: '6px',
            padding: '6px 10px',
            flexShrink: 0,
            color: '#ef4444',
            borderColor: 'rgba(239, 68, 68, 0.4)',
            backgroundColor: 'rgba(239, 68, 68, 0.1)',
          }}
          title="Permanently delete selected photos from disk"
        >
          <Trash2 size={14} color="#ef4444" />
          <span>Delete</span>
        </button>

        {filterType === 'excluded' ? (
          <button
            className="btn btn-primary"
            onClick={() => handleExcludeSelected(false)}
            disabled={selectedIds.size === 0}
            style={{ fontSize: '0.78rem', gap: '6px', padding: '6px 10px', flexShrink: 0 }}
          >
            <Eye size={14} />
            <span>Restore</span>
          </button>
        ) : (
          <button
            className="btn btn-secondary"
            onClick={() => handleExcludeSelected(true)}
            disabled={selectedIds.size === 0}
            style={{ fontSize: '0.78rem', gap: '6px', padding: '6px 10px', flexShrink: 0, color: 'var(--accent-rose)' }}
            title="Exclude selected photos from views without deleting source files"
          >
            <EyeOff size={14} />
            <span>Exclude</span>
          </button>
        )}
      </div>
    </div>
  );

  const helpButton = onOpenHelp ? (
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
  ) : null;

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Gallery Subheader Controls */}
      {isMobile ? (
        (isSelectMode || selectedIds.size > 0) ? (
          // Selecting on mobile: swap the whole header (title/filters/tools
          // toggle) for the compact 2-line selection bar instead — nothing
          // from the normal toolbar is relevant mid-selection, and every
          // pixel of width is needed for the selection actions themselves.
          mobileSelectionBar
        ) : (
        <div style={{ borderBottom: '1px solid var(--border-subtle)', backgroundColor: 'var(--bg-app)' }}>
          {/* Row 1: title + a single toggle for everything else, so the
              persistent bar never grows past one compact row. */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', padding: '8px 12px' }}>
            {titleBlock}
            <button
              className={`btn ${showMobileTools ? 'btn-primary' : 'btn-ghost'} btn-icon`}
              onClick={() => setShowMobileTools((v) => !v)}
              style={{ width: '34px', height: '34px', flexShrink: 0 }}
              title="More options"
              aria-expanded={showMobileTools}
            >
              <MoreVertical size={18} />
            </button>
          </div>

          {/* Row 2: filter chips, horizontally scrollable instead of
              wrapping onto their own extra row(s). */}
          <div className="filter-pills-row" style={{ padding: '0 12px 8px', display: 'flex' }}>
            {filterChips}
          </div>

          {/* Collapsed by default: Select/Clean Duplicates/Rescan/Ask AI +
              zoom/grouping controls + help, only taking up space when the
              user actually asks for them. */}
          {showMobileTools && (
            <div style={{
              padding: '10px 12px',
              display: 'flex',
              flexDirection: 'column',
              gap: '10px',
              borderTop: '1px solid var(--border-subtle)',
              backgroundColor: 'var(--bg-surface-elevated)',
            }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                {selectButton}
                {cleanDuplicatesButton}
                {rescanButton}
                {askAiButton}
                {helpButton}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontWeight: 600 }}>Grid size</span>
                {zoomControls}
              </div>
            </div>
          )}
        </div>
        )
      ) : (
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
            {titleBlock}
            {filterChips}
          </div>

          {/* Right Section: Tools, Select Mode, Cleaner, Grid Size */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            {selectButton}
            {cleanDuplicatesButton}
            {rescanButton}
            {askAiButton}
            {zoomControls}
            {helpButton}
          </div>
        </div>
      )}

      {/* Multi-Selection Floating / Sticky Action Bar (desktop only — mobile
          uses the compact mobileSelectionBar swapped in above instead) */}
      {(isSelectMode || selectedIds.size > 0) && !isMobile && (
        <div style={{
          backgroundColor: 'rgba(15, 23, 42, 0.95)',
          borderBottom: '1px solid var(--accent-primary)',
          padding: '10px 24px',
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '12px',
          backdropFilter: 'blur(8px)',
          zIndex: 20,
        }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '12px' }}>
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

          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px' }}>
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

            {/* Automatic upright rotation of the selected photos (faces decide the orientation) */}
            <button
              className="btn btn-secondary"
              onClick={handleAutoRotateSelected}
              disabled={autoRotateBusy || selectedIds.size === 0}
              data-testid="auto-rotate-upright"
              style={{ fontSize: '0.85rem', gap: '8px', padding: '6px 14px' }}
              title="Turn the selected photos upright automatically. The app looks for people's faces; photos without a clear answer are left unchanged."
            >
              <RotateCw size={16} className={autoRotateBusy ? 'animate-spin' : ''} />
              <span>{autoRotateBusy ? autoRotateLabel : `Auto-Rotate Upright (${selectedIds.size})`}</span>
            </button>

            {/* Deduplicate & Find Best Shot from Selected Photos */}
            {selectedIds.size >= 2 && onOpenDuplicateCleaner && (
              <button
                className="btn btn-primary"
                onClick={openBestShotForSelection}
                style={{
                  fontSize: '0.85rem',
                  gap: '8px',
                  padding: '6px 14px',
                  background: 'linear-gradient(135deg, #6366f1 0%, #a855f7 100%)',
                  borderColor: '#a855f7',
                  color: 'white',
                  fontWeight: 600,
                }}
                title="Treat selected photos as one cluster and launch Best Shot finder to compare quality and keep the best"
              >
                <Sparkles size={16} />
                <span>Find Best Shot ({selectedIds.size})</span>
              </button>
            )}

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

            {/* Run a Smart Flow against just the selected photos */}
            {onRunSmartFlow && (
              <button
                className="btn btn-secondary"
                onClick={() => onRunSmartFlow(photos.filter((p) => selectedIds.has(p.id)))}
                disabled={selectedIds.size === 0}
                style={{ fontSize: '0.85rem', gap: '8px', padding: '6px 14px' }}
                title="Run one of your Smart Flows against just the selected photos"
              >
                <Wand2 size={16} color="#c084fc" />
                <span>Run Smart Flow ({selectedIds.size})</span>
              </button>
            )}

            {/* Bulk Edit Date/Location Button */}
            <button
              className="btn btn-secondary"
              onClick={() => setShowBulkEditModal(true)}
              disabled={selectedIds.size === 0}
              style={{ fontSize: '0.85rem', gap: '8px', padding: '6px 14px' }}
              title="Set date/time or location on all selected photos at once"
            >
              <Calendar size={16} color="var(--accent-cyan)" />
              <span>Edit Date/Location ({selectedIds.size})</span>
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
            backgroundColor: /^(⚠|Failed)/.test(refreshToast) ? 'rgba(244, 63, 94, 0.15)' : 'rgba(14, 165, 233, 0.15)',
            borderBottom: /^(⚠|Failed)/.test(refreshToast) ? '1px solid rgba(244, 63, 94, 0.4)' : '1px solid rgba(14, 165, 233, 0.4)',
            color: /^(⚠|Failed)/.test(refreshToast) ? 'var(--accent-rose)' : 'var(--accent-cyan)',
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
        onLoadMore={handleLoadMore}
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
            backgroundColor: albumSuccessToast.startsWith('⚠') ? 'rgba(220, 38, 38, 0.95)' : 'rgba(16, 185, 129, 0.95)',
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
      {showBulkEditModal && (
        <BulkEditModal
          photos={selectedPhotosForEdit}
          onClose={() => setShowBulkEditModal(false)}
        />
      )}

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
          onClick={closeAlbumDialog}
        >
          <div
            style={{
              width: '100%',
              maxWidth: '480px',
              maxHeight: '80vh',
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
            <div
              style={{
                padding: '18px 24px',
                borderBottom: '1px solid var(--border-subtle)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                flexShrink: 0,
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
                onClick={closeAlbumDialog}
                style={{ width: '36px', height: '36px' }}
              >
                <X size={20} />
              </button>
            </div>

            <div style={{ padding: '18px 24px', minHeight: 0, flex: 1, display: 'flex' }}>
              {albumPendingChapterSelection ? (
                <ChapterSelectStep
                  album={albumPendingChapterSelection}
                  onBack={() => setAlbumPendingChapterSelection(null)}
                  onPickChapter={(chapterId) => finishAddToAlbumChapter(albumPendingChapterSelection, chapterId)}
                  onCreateChapter={(title) => finishAddToAlbumChapter(albumPendingChapterSelection, null, title)}
                />
              ) : (
                <AlbumPicker
                  albums={existingAlbums}
                  photos={photos}
                  onPick={handlePickAlbum}
                  onCreateNew={handleCreateAlbumAndAdd}
                  listMaxHeight={360}
                />
              )}
            </div>
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

