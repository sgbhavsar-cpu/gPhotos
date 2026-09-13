import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Photo } from '../../types';
import { PhotoCard } from './PhotoCard';
import { getLocalPhotoUrl } from '../services/libraryStore';
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
  emptyMessage?: string;
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
  emptyMessage = 'No photos found in this view.',
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(800);
  const [containerWidth, setContainerWidth] = useState(1200);
  const lastWheelZoomTime = useRef<number>(0);

  // Mouse drag-selection tracking (mobile-style swipe/drag select)
  const isMouseDownRef = useRef<boolean>(false);
  const isDragSelectingRef = useRef<boolean>(false);

  useEffect(() => {
    const handleGlobalMouseUp = () => {
      isMouseDownRef.current = false;
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

  // Handle scroll to track viewport
  const handleScroll = useCallback(() => {
    if (containerRef.current) {
      setScrollTop(containerRef.current.scrollTop);
    }
  }, []);

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

  if (photos.length === 0) {
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
  // Viewport buffer: render items within 800px before and after current scroll view
  const bufferPx = 800;
  const viewportTop = Math.max(0, scrollTop - bufferPx);
  const viewportBottom = scrollTop + containerHeight + bufferPx;

  const { cols, itemHeight, gap, size } = gridConfig;

  // Automatically pre-fetch up to 100 thumbnails in 1 single async request for all visible rows
  useEffect(() => {
    if (zoomLevel === 'years' || zoomLevel === 'months') return;
    if (virtualMonthData.length === 0) return;

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
  }, [virtualMonthData, viewportTop, viewportBottom, cols, itemHeight, gap, size, zoomLevel]);

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
                      if (e.button === 0 && (isSelectMode || selectedIds.size > 0)) {
                        isMouseDownRef.current = true;
                      }
                    }}
                    onCardMouseEnter={(id) => {
                      if (isMouseDownRef.current && (isSelectMode || selectedIds.size > 0)) {
                        isDragSelectingRef.current = true;
                        if (onDragSelect) {
                          onDragSelect(id);
                        } else if (onToggleSelect && !selectedIds.has(id)) {
                          onToggleSelect(id);
                        }
                      }
                    }}
                    onClick={() => {
                      if (isDragSelectingRef.current) return;
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
