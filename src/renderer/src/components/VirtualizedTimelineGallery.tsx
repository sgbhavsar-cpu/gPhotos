import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Photo } from '../../types';
import { PhotoCard } from './PhotoCard';
import { getLocalPhotoUrl, libraryStore } from '../services/libraryStore';
import { requestBatchThumbnails } from '../services/asyncImageLoader';
import {
  Calendar,
  ChevronRight,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Grid,
  Sparkles,
  Layers
} from 'lucide-react';

export type GalleryZoomLevel = 'years' | 'months' | 'very_small' | 'small' | 'medium' | 'large';

export const ZOOM_LEVELS: GalleryZoomLevel[] = [
  'years',
  'months',
  'very_small',
  'small',
  'medium',
  'large',
];

// How far above/below the visible viewport rows are still fully rendered
// (instead of a lightweight spacer div), and thumbnails are fetched ahead of
// time — in both scroll directions — so items are already on-screen and
// their images already loading by the time the user scrolls to them.
const RENDER_BUFFER_PX = 1600;
const THUMBNAIL_PREFETCH_BUFFER_PX = 1600;

interface VirtualizedTimelineGalleryProps {
  photos: Photo[];
  zoomLevel: GalleryZoomLevel;
  onZoomChange: (level: GalleryZoomLevel) => void;
  onSelectPhoto: (photo: Photo) => void;
  onToggleFavorite: (photoId: string) => void;
  isSelectMode?: boolean;
  selectedIds?: Set<string>;
  onToggleSelect?: (photoId: string) => void;
  onDragSelect?: (photoId: string) => void;
  onSelectionChange?: (selectedIds: Set<string>) => void;
  emptyMessage?: string;
  /**
   * Called when the user has scrolled near the bottom of the currently-loaded
   * photos, so the caller can append the next catalog page. Safe to call
   * repeatedly — the caller is expected to no-op while already loading or
   * once every page has been fetched.
   */
  onLoadMore?: () => void;
}

export const VirtualizedTimelineGallery: React.FC<VirtualizedTimelineGalleryProps> = ({
  photos,
  zoomLevel,
  onZoomChange,
  onSelectPhoto,
  onToggleFavorite,
  isSelectMode = false,
  selectedIds = new Set(),
  onToggleSelect,
  onDragSelect,
  onSelectionChange,
  emptyMessage = 'No photos found in this view.',
  onLoadMore,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(800);
  const [containerWidth, setContainerWidth] = useState(1200);
  const lastWheelZoomTime = useRef<number>(0);
  const scrollRafRef = useRef<number | null>(null);

  // 2D Matrix Mouse drag-selection tracking
  const isMouseDownRef = useRef<boolean>(false);
  const isDragSelectingRef = useRef<boolean>(false);
  const dragAnchorRef = useRef<{
    groupKey: string;
    photoId: string;
    index: number;
    row: number;
    col: number;
  } | null>(null);
  const initialSelectedIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const handleGlobalMouseUp = () => {
      isMouseDownRef.current = false;
      dragAnchorRef.current = null;
      setTimeout(() => {
        isDragSelectingRef.current = false;
      }, 60);
    };

    window.addEventListener('mouseup', handleGlobalMouseUp);
    return () => {
      window.removeEventListener('mouseup', handleGlobalMouseUp);
    };
  }, []);

  // ResizeObserver to track container dimensions
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const updateDimensions = () => {
      setContainerHeight(el.clientHeight || 800);
      setContainerWidth(el.clientWidth || 1200);
    };

    updateDimensions();

    if (typeof ResizeObserver !== 'undefined') {
      const resizeObserver = new ResizeObserver(() => {
        updateDimensions();
      });
      resizeObserver.observe(el);
      return () => resizeObserver.disconnect();
    }
  }, []);

  // Distance from the bottom of loaded content, in pixels, at which the next
  // batch of catalog pages is requested (onLoadMore loads several pages at
  // once) — large enough that a multi-page buffer is ready well before the
  // user actually scrolls into blank space.
  const LOAD_MORE_THRESHOLD_PX = 4800;

  // Handle scroll to track viewport. Batched to at most once per animation
  // frame — native scroll events can fire far more often than the display
  // can paint, and updating React state on every single one causes the
  // visible-item recalculation below to run redundantly, which is what was
  // making fast scrolling feel like it stutters/pauses.
  const handleScroll = useCallback(() => {
    if (scrollRafRef.current !== null) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      const el = containerRef.current;
      if (!el) return;
      setScrollTop(el.scrollTop);

      if (onLoadMore) {
        const distanceFromBottom = el.scrollHeight - (el.scrollTop + el.clientHeight);
        if (distanceFromBottom < LOAD_MORE_THRESHOLD_PX) {
          onLoadMore();
        }
      }
    });
  }, [onLoadMore]);

  useEffect(() => {
    return () => {
      if (scrollRafRef.current !== null) {
        cancelAnimationFrame(scrollRafRef.current);
      }
    };
  }, []);

  // Bootstraps loading: if the currently-loaded photos don't even fill the
  // viewport (e.g. right after a library switch loads just the first page),
  // no scroll event will ever fire to trigger onLoadMore — so also check
  // directly whenever the content or container size changes.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !onLoadMore) return;
    if (el.scrollHeight - el.clientHeight < LOAD_MORE_THRESHOLD_PX) {
      onLoadMore();
    }
  }, [photos.length, containerHeight, onLoadMore]);

  // Handle Ctrl + Wheel Zoom (and trackpad pinch zoom which triggers ctrlKey + wheel)
  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      if (e.ctrlKey) {
        e.preventDefault();
        const now = Date.now();
        if (now - lastWheelZoomTime.current < 140) return;
        lastWheelZoomTime.current = now;

        if (e.deltaY < 0) {
          // Scroll Up = Zoom In
          const idx = ZOOM_LEVELS.indexOf(zoomLevel);
          if (idx < ZOOM_LEVELS.length - 1) {
            onZoomChange(ZOOM_LEVELS[idx + 1]);
          }
        } else if (e.deltaY > 0) {
          // Scroll Down = Zoom Out
          const idx = ZOOM_LEVELS.indexOf(zoomLevel);
          if (idx > 0) {
            onZoomChange(ZOOM_LEVELS[idx - 1]);
          }
        }
      }
    },
    [zoomLevel, onZoomChange]
  );

  // Group photos by Year for 'years' view
  const yearGroups = useMemo(() => {
    if (zoomLevel !== 'years') return [];
    const map = new Map<number, { year: number; photos: Photo[] }>();
    for (let i = 0; i < photos.length; i++) {
      const p = photos[i];
      const yr = new Date(p.dateTaken).getFullYear() || 1970;
      let g = map.get(yr);
      if (!g) {
        g = { year: yr, photos: [] };
        map.set(yr, g);
      }
      g.photos.push(p);
    }
    return Array.from(map.values()).sort((a, b) => b.year - a.year);
  }, [photos, zoomLevel]);

  // Group photos by Month for 'months', 'very_small', 'small', 'medium', 'large' views
  const monthGroups = useMemo(() => {
    const map = new Map<string, { key: string; label: string; year: number; photos: Photo[] }>();
    for (let i = 0; i < photos.length; i++) {
      const p = photos[i];
      const date = new Date(p.dateTaken);
      const yr = date.getFullYear() || 1970;
      const mo = String(date.getMonth() + 1).padStart(2, '0');
      const key = `${yr}-${mo}`;

      let g = map.get(key);
      if (!g) {
        const label = date.toLocaleDateString(undefined, { year: 'numeric', month: 'long' });
        g = { key, label, year: yr, photos: [] };
        map.set(key, g);
      }
      g.photos.push(p);
    }
    return Array.from(map.values()).sort((a, b) => b.key.localeCompare(a.key));
  }, [photos]);

  // Grid column count & heights based on zoom level
  const gridConfig = useMemo(() => {
    const padding = 48; // 24px left + 24px right
    const availableWidth = Math.max(300, containerWidth - padding);

    switch (zoomLevel) {
      case 'very_small': {
        const minWidth = 76;
        const gap = 4;
        const cols = Math.max(2, Math.floor((availableWidth + gap) / (minWidth + gap)));
        return { cols, itemHeight: 76, gap, size: 'very_small' as const };
      }
      case 'small': {
        const minWidth = 120;
        const gap = 8;
        const cols = Math.max(2, Math.floor((availableWidth + gap) / (minWidth + gap)));
        return { cols, itemHeight: 120, gap, size: 'small' as const };
      }
      case 'medium': {
        const minWidth = 180;
        const gap = 12;
        const cols = Math.max(2, Math.floor((availableWidth + gap) / (minWidth + gap)));
        return { cols, itemHeight: 180, gap, size: 'medium' as const };
      }
      case 'large': {
        const minWidth = 260;
        const gap = 16;
        const cols = Math.max(1, Math.floor((availableWidth + gap) / (minWidth + gap)));
        return { cols, itemHeight: 250, gap, size: 'large' as const };
      }
      default:
        return { cols: 4, itemHeight: 180, gap: 12, size: 'medium' as const };
    }
  }, [zoomLevel, containerWidth]);

  // Virtualized Month Layout calculations:
  // Pre-calculate positions of every month group for O(1) viewport visibility check
  const virtualMonthData = useMemo(() => {
    if (zoomLevel === 'years' || zoomLevel === 'months') return [];

    const { cols, itemHeight, gap } = gridConfig;
    const headerHeight = 52; // Month header height with margins
    const marginBottom = 32;

    let currentTop = 20; // Top padding
    return monthGroups.map((g) => {
      const rows = Math.ceil(g.photos.length / cols);
      const gridHeight = rows > 0 ? rows * itemHeight + (rows - 1) * gap : 0;
      const totalGroupHeight = headerHeight + gridHeight + marginBottom;

      const item = {
        key: g.key,
        group: g,
        top: currentTop,
        bottom: currentTop + totalGroupHeight,
        totalHeight: totalGroupHeight,
        headerHeight,
        gridHeight,
        rows,
      };

      currentTop += totalGroupHeight;
      return item;
    });
  }, [monthGroups, zoomLevel, gridConfig]);

  // Automatically pre-fetch up to 100 thumbnails in 1 single async request for all
  // visible rows. This hook must be called on every render regardless of zoomLevel
  // or an empty photo list (React's Rules of Hooks) — it no-ops internally for the
  // 'years'/'months' zoom levels via the early-return inside the effect body below,
  // rather than skipping the hook call itself.
  useEffect(() => {
    if (zoomLevel === 'years' || zoomLevel === 'months') return;
    if (virtualMonthData.length === 0) return;

    const bufferPx = THUMBNAIL_PREFETCH_BUFFER_PX;
    const viewportTop = Math.max(0, scrollTop - bufferPx);
    const viewportBottom = scrollTop + containerHeight + bufferPx;
    const { cols, itemHeight, gap, size } = gridConfig;

    const pixelSizeMap: Record<string, number> = {
      very_small: 150,
      small: 200,
      medium: 300,
      large: 500,
    };
    const targetSize = pixelSizeMap[size] || 250;
    const itemsToFetch: Array<{ path: string; originalPath?: string }> = [];

    for (const item of virtualMonthData) {
      const isVisible = item.bottom >= viewportTop && item.top <= viewportBottom;
      if (isVisible) {
        const groupPhotos = item.group.photos;
        const totalRows = item.rows;
        const relativeScrollTop = Math.max(0, viewportTop - item.top - item.headerHeight);
        const relativeScrollBottom = Math.max(0, viewportBottom - item.top - item.headerHeight);
        const startRow = Math.max(0, Math.floor(relativeScrollTop / (itemHeight + gap)));
        const endRow = Math.min(totalRows, Math.ceil(relativeScrollBottom / (itemHeight + gap)));

        const visibleSlice = groupPhotos.slice(startRow * cols, endRow * cols);
        for (const p of visibleSlice) {
          itemsToFetch.push({
            path: p.thumbnailPath || p.filePath,
            originalPath: p.originalRemotePath,
          });
        }
      }
    }

    if (itemsToFetch.length > 0) {
      requestBatchThumbnails(itemsToFetch, targetSize);
    }
  }, [virtualMonthData, scrollTop, containerHeight, gridConfig, zoomLevel]);

  if (photos.length === 0) {
    const isInitialized = libraryStore.getState().isInitialized;
    if (!isInitialized) {
      return (
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '60px 20px',
            color: 'var(--text-muted)',
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
          <span style={{ fontSize: '0.95rem' }}>Loading photo timeline...</span>
        </div>
      );
    }
    return (
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '40px',
          color: 'var(--text-muted)',
          fontSize: '0.95rem',
        }}
      >
        {emptyMessage}
      </div>
    );
  }

  // 1. YEARS VIEW: Grouped by year cards with representative multi-photo collage
  if (zoomLevel === 'years') {
    return (
      <div
        ref={containerRef}
        onScroll={handleScroll}
        onWheel={handleWheel}
        style={{ flex: 1, overflowY: 'auto', padding: '24px', outline: 'none' }}
        tabIndex={0}
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
            gap: '20px',
          }}
        >
          {yearGroups.map(({ year, photos: yPhotos }) => {
            const previewPhotos = yPhotos.slice(0, 4);
            return (
              <div
                key={year}
                onClick={() => onZoomChange('months')}
                style={{
                  backgroundColor: 'var(--bg-surface)',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 'var(--radius-lg)',
                  overflow: 'hidden',
                  cursor: 'pointer',
                  transition: 'transform 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease',
                  boxShadow: 'var(--shadow-md)',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = 'var(--accent-primary)';
                  e.currentTarget.style.transform = 'translateY(-2px)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = 'var(--border-subtle)';
                  e.currentTarget.style.transform = 'none';
                }}
              >
                {/* 2x2 Photo Preview Grid */}
                <div
                  style={{
                    height: '220px',
                    display: 'grid',
                    gridTemplateColumns: previewPhotos.length > 1 ? '1fr 1fr' : '1fr',
                    gridTemplateRows: previewPhotos.length > 2 ? '1fr 1fr' : '1fr',
                    gap: '2px',
                    backgroundColor: '#05080f',
                  }}
                >
                  {previewPhotos.map((p, idx) => (
                    <img
                      key={p.id}
                      src={getLocalPhotoUrl(p.thumbnailPath || p.filePath, p.originalRemotePath, false, 150)}
                      alt={p.fileName}
                      loading="lazy"
                      decoding="async"
                      style={{
                        width: '100%',
                        height: '100%',
                        objectFit: 'cover',
                        imageOrientation: 'from-image',
                      }}
                    />
                  ))}
                  {previewPhotos.length === 0 && (
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)' }}>
                      No preview
                    </div>
                  )}
                </div>

                {/* Card Footer */}
                <div
                  style={{
                    padding: '16px 20px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    backgroundColor: 'var(--bg-surface-elevated)',
                  }}
                >
                  <div>
                    <h3 style={{ margin: 0, fontSize: '1.4rem', fontWeight: 800, color: 'var(--text-primary)' }}>
                      {year}
                    </h3>
                    <span style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>
                      {yPhotos.length.toLocaleString()} {yPhotos.length === 1 ? 'photo' : 'photos'}
                    </span>
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '4px',
                      color: 'var(--accent-primary)',
                      fontSize: '0.85rem',
                      fontWeight: 600,
                    }}
                  >
                    <span>View Months</span>
                    <ChevronRight size={16} />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // 2. MONTHS VIEW: Grouped by Year & Month cards
  if (zoomLevel === 'months') {
    return (
      <div
        ref={containerRef}
        onScroll={handleScroll}
        onWheel={handleWheel}
        style={{ flex: 1, overflowY: 'auto', padding: '24px', outline: 'none' }}
        tabIndex={0}
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
            gap: '16px',
          }}
        >
          {monthGroups.map((group) => {
            const previewPhotos = group.photos.slice(0, 4);
            return (
              <div
                key={group.key}
                onClick={() => onZoomChange('small')}
                style={{
                  backgroundColor: 'var(--bg-surface)',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 'var(--radius-lg)',
                  overflow: 'hidden',
                  cursor: 'pointer',
                  transition: 'transform 0.2s ease, border-color 0.2s ease',
                  boxShadow: 'var(--shadow-sm)',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = 'var(--accent-primary)';
                  e.currentTarget.style.transform = 'translateY(-2px)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = 'var(--border-subtle)';
                  e.currentTarget.style.transform = 'none';
                }}
              >
                {/* 2x2 Photo Preview Grid */}
                <div
                  style={{
                    height: '170px',
                    display: 'grid',
                    gridTemplateColumns: previewPhotos.length > 1 ? '1fr 1fr' : '1fr',
                    gridTemplateRows: previewPhotos.length > 2 ? '1fr 1fr' : '1fr',
                    gap: '2px',
                    backgroundColor: '#05080f',
                  }}
                >
                  {previewPhotos.map((p) => (
                    <img
                      key={p.id}
                      src={getLocalPhotoUrl(p.thumbnailPath || p.filePath, p.originalRemotePath, false, 200)}
                      alt={p.fileName}
                      loading="lazy"
                      decoding="async"
                      style={{
                        width: '100%',
                        height: '100%',
                        objectFit: 'cover',
                        imageOrientation: 'from-image',
                      }}
                    />
                  ))}
                </div>

                <div
                  style={{
                    padding: '12px 16px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    backgroundColor: 'var(--bg-surface-elevated)',
                  }}
                >
                  <div>
                    <h4 style={{ margin: 0, fontSize: '1rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                      {group.label}
                    </h4>
                    <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                      {group.photos.length.toLocaleString()} {group.photos.length === 1 ? 'item' : 'items'}
                    </span>
                  </div>
                  <ChevronRight size={16} color="var(--accent-primary)" />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // 3. FULL PHOTO GRID (very_small, small, medium, large) WITH HIGH-EFFICIENCY VIRTUALIZATION
  // Viewport buffer: render items within RENDER_BUFFER_PX before and after current scroll view
  const bufferPx = RENDER_BUFFER_PX;
  const viewportTop = Math.max(0, scrollTop - bufferPx);
  const viewportBottom = scrollTop + containerHeight + bufferPx;

  const { cols, itemHeight, gap, size } = gridConfig;

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      onWheel={handleWheel}
      style={{
        flex: 1,
        overflowY: 'auto',
        padding: '20px 24px',
        outline: 'none',
        position: 'relative',
      }}
      tabIndex={0}
    >
      {virtualMonthData.map((item) => {
        const isVisible = item.bottom >= viewportTop && item.top <= viewportBottom;

        // If offscreen, render lightweight empty placeholder div to reserve exact layout scroll height!
        if (!isVisible) {
          return (
            <div
              key={item.key}
              style={{
                height: `${item.totalHeight}px`,
                width: '100%',
                pointerEvents: 'none',
              }}
            />
          );
        }

        // When group is on-screen: calculate visible row slice if group is large
        const groupPhotos = item.group.photos;
        const totalRows = item.rows;

        // Calculate visible row range inside this month
        const relativeScrollTop = Math.max(0, viewportTop - item.top - item.headerHeight);
        const relativeScrollBottom = Math.max(0, viewportBottom - item.top - item.headerHeight);

        const startRow = Math.max(0, Math.floor(relativeScrollTop / (itemHeight + gap)));
        const endRow = Math.min(totalRows, Math.ceil(relativeScrollBottom / (itemHeight + gap)));

        const visiblePhotos = groupPhotos.slice(startRow * cols, endRow * cols);
        const topSpacerHeight = startRow * (itemHeight + gap);
        const bottomSpacerHeight = Math.max(0, (totalRows - endRow) * (itemHeight + gap));

        return (
          <section key={item.key} style={{ marginBottom: '32px' }}>
            {/* Sticky Month Header */}
            <div
              style={{
                position: 'sticky',
                top: '-20px',
                zIndex: 5,
                padding: '8px 0',
                backgroundColor: 'var(--bg-app)',
                display: 'flex',
                alignItems: 'baseline',
                gap: '12px',
                borderBottom: '1px solid rgba(255, 255, 255, 0.05)',
                marginBottom: '16px',
              }}
            >
              <h3 style={{ fontSize: '1.15rem', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>
                {item.group.label}
              </h3>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', fontWeight: 500 }}>
                {groupPhotos.length} {groupPhotos.length === 1 ? 'item' : 'items'}
              </span>
            </div>

            {/* Row-virtualized grid */}
            <div>
              {topSpacerHeight > 0 && <div style={{ height: `${topSpacerHeight}px` }} />}

              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: `repeat(${cols}, 1fr)`,
                  gap: `${gap}px`,
                }}
              >
                {visiblePhotos.map((photo) => (
                  <PhotoCard
                    key={photo.id}
                    photo={photo}
                    size={size}
                    isSelected={selectedIds.has(photo.id)}
                    isSelectMode={isSelectMode || selectedIds.size > 0}
                    onToggleSelect={() => onToggleSelect && onToggleSelect(photo.id)}
                    onCardMouseDown={(_id, e) => {
                      if (e.button === 0) {
                        isMouseDownRef.current = true;
                        const photoIdx = groupPhotos.findIndex((p) => p.id === photo.id);
                        dragAnchorRef.current = {
                          groupKey: item.key,
                          photoId: photo.id,
                          index: photoIdx,
                          row: Math.floor(photoIdx / cols),
                          col: photoIdx % cols,
                        };
                        initialSelectedIdsRef.current = new Set(selectedIds);
                      }
                    }}
                    onCardMouseEnter={(id) => {
                      if (isMouseDownRef.current && dragAnchorRef.current) {
                        if (id === dragAnchorRef.current.photoId && !isDragSelectingRef.current) {
                          return;
                        }
                        isDragSelectingRef.current = true;
                        const anchor = dragAnchorRef.current;
                        const currentIdx = groupPhotos.findIndex((p) => p.id === photo.id);
                        const targetRow = Math.floor(currentIdx / cols);
                        const targetCol = currentIdx % cols;

                        const matrixIds = new Set<string>();

                        if (anchor.groupKey === item.key) {
                          // 2D Matrix Selection within the same group (e.g., 3x3 selects all 9 photos)
                          const minRow = Math.min(anchor.row, targetRow);
                          const maxRow = Math.max(anchor.row, targetRow);
                          const minCol = Math.min(anchor.col, targetCol);
                          const maxCol = Math.max(anchor.col, targetCol);

                          groupPhotos.forEach((p, idx) => {
                            const r = Math.floor(idx / cols);
                            const c = idx % cols;
                            if (r >= minRow && r <= maxRow && c >= minCol && c <= maxCol) {
                              matrixIds.add(p.id);
                            }
                          });
                        } else {
                          // Cross-group 2D Matrix Selection
                          const gStartIdx = monthGroups.findIndex((mg) => mg.key === anchor.groupKey);
                          const gEndIdx = monthGroups.findIndex((mg) => mg.key === item.key);
                          const minG = Math.min(gStartIdx, gEndIdx);
                          const maxG = Math.max(gStartIdx, gEndIdx);
                          const minCol = Math.min(anchor.col, targetCol);
                          const maxCol = Math.max(anchor.col, targetCol);

                          for (let gi = minG; gi <= maxG; gi++) {
                            const mg = monthGroups[gi];
                            if (!mg) continue;
                            if (gi === minG) {
                              const fromRow = minG === gStartIdx ? anchor.row : targetRow;
                              mg.photos.forEach((p, idx) => {
                                const r = Math.floor(idx / cols);
                                const c = idx % cols;
                                if (r >= fromRow && c >= minCol && c <= maxCol) {
                                  matrixIds.add(p.id);
                                }
                              });
                            } else if (gi === maxG) {
                              const toRow = maxG === gStartIdx ? anchor.row : targetRow;
                              mg.photos.forEach((p, idx) => {
                                const r = Math.floor(idx / cols);
                                const c = idx % cols;
                                if (r <= toRow && c >= minCol && c <= maxCol) {
                                  matrixIds.add(p.id);
                                }
                              });
                            } else {
                              mg.photos.forEach((p, idx) => {
                                const c = idx % cols;
                                if (c >= minCol && c <= maxCol) {
                                  matrixIds.add(p.id);
                                }
                              });
                            }
                          }
                        }

                        const combined = new Set(initialSelectedIdsRef.current);
                        matrixIds.forEach((mId) => combined.add(mId));

                        if (onSelectionChange) {
                          onSelectionChange(combined);
                        } else if (onDragSelect) {
                          matrixIds.forEach((mId) => onDragSelect(mId));
                        }
                      }
                    }}
                    onClick={(e) => {
                      if (isDragSelectingRef.current) return;
                      if (e.ctrlKey || e.metaKey) {
                        onToggleSelect && onToggleSelect(photo.id);
                        return;
                      }
                      if (isSelectMode || selectedIds.size > 0) {
                        onToggleSelect && onToggleSelect(photo.id);
                      } else {
                        onSelectPhoto(photo);
                      }
                    }}
                    onToggleFavorite={(e) => {
                      e.stopPropagation();
                      onToggleFavorite(photo.id);
                    }}
                  />
                ))}
              </div>

              {bottomSpacerHeight > 0 && <div style={{ height: `${bottomSpacerHeight}px` }} />}
            </div>
          </section>
        );
      })}
    </div>
  );
};
