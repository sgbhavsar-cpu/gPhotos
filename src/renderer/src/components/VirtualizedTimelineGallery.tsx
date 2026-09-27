import React, { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback } from 'react';
import { Photo } from '../../../types';
import { PhotoCard } from './PhotoCard';
import { getLocalPhotoUrl, libraryStore } from '../services/libraryStore';
import { requestBatchThumbnails } from '../services/asyncImageLoader';
import { TimelineYearScrubber } from './TimelineYearScrubber';
import { createMonthGrouper, monthRowWindow, photoMonthInfo } from './timelineGrouping';
import { anchorAtY, scrollTopFor, type AnchorLayoutGroup, type AnchorMetrics, type ZoomAnchor } from './zoomAnchor';
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
// time (same window as the render buffer) — in both scroll directions — so items are already on-screen and
// their images already loading by the time the user scrolls to them.
const RENDER_BUFFER_PX = 1600;

/** One month group of the virtual layout (the fields of virtualMonthData that the zoom anchoring needs). */
interface ZoomLayoutData {
  key: string;
  top: number;
  bottom: number;
  headerHeight: number;
  group: { photos: Photo[] };
}
const toAnchorGroups = (data: ZoomLayoutData[]): AnchorLayoutGroup[] =>
  data.map((d) => ({ key: d.key, top: d.top, bottom: d.bottom, headerHeight: d.headerHeight, photos: d.group.photos }));

/**
 * Where the pointer is for a Ctrl+wheel zoom: the thumbnail under it (and how far down inside it), and the pointer's
 * Y inside the scroll viewport. Over a gap, a header or empty space the position is worked out from the layout.
 */
function captureWheelAnchor(
  e: React.WheelEvent,
  el: HTMLElement | null,
  data: ZoomLayoutData[],
  cfg: AnchorMetrics
): { anchor: ZoomAnchor; viewportY: number; at: number } | null {
  if (!el || data.length === 0) return null;
  const rect = el.getBoundingClientRect();
  const viewportY = e.clientY - rect.top;
  const groups = toAnchorGroups(data);

  const card = (e.target as HTMLElement | null)?.closest?.('[data-photo-id]') as HTMLElement | null;
  const photoId = card?.getAttribute('data-photo-id');
  if (card && photoId) {
    const r = card.getBoundingClientRect();
    const fracY = r.height > 0 ? Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) : 0;
    const group = groups.find((g) => g.photos.some((p) => p.id === photoId));
    if (group) return { anchor: { kind: 'photo', photoId, groupKey: group.key, fracY }, viewportY, at: Date.now() };
  }

  const availableWidth = Math.max(300, el.clientWidth - 48); // same padding as gridConfig
  const cellWidth = (availableWidth - cfg.gap * (cfg.cols - 1)) / cfg.cols;
  const col = Math.floor((e.clientX - rect.left - 24 + cfg.gap / 2) / (cellWidth + cfg.gap));
  const anchor = anchorAtY(groups, cfg, el.scrollTop + viewportY, { col });
  return anchor ? { anchor, viewportY, at: Date.now() } : null;
}

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
  const scrollQuantumRef = useRef(80);

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

  // Keeping the same photo in view when the thumbnail size changes (see zoomAnchor.ts).
  // lastScrollTopRef: the raw scroll offset (the state is snapped to a row pitch). layoutRef: the layout of the
  // most recent render. zoomTransitionRef: set during the render in which the zoom level changed, holding the OLD
  // layout and offset, and consumed by the layout effect once the new layout is committed.
  const lastScrollTopRef = useRef(0);
  const layoutRef = useRef<{ zoomLevel: GalleryZoomLevel; data: ZoomLayoutData[]; cfg: AnchorMetrics }>({ zoomLevel, data: [], cfg: { cols: 1, itemHeight: 1, gap: 0 } });
  const zoomTransitionRef = useRef<{ from: { data: ZoomLayoutData[]; cfg: AnchorMetrics }; scrollTop: number; wheel: { anchor: ZoomAnchor; viewportY: number } | null } | null>(null);
  const wheelAnchorRef = useRef<{ anchor: ZoomAnchor; viewportY: number; at: number } | null>(null);

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
    // The scroll container is a different DOM node (or absent) for empty / years+months / grid
    // renders, so re-attach whenever that changes instead of observing a stale/null element once.
  }, [photos.length === 0, zoomLevel === 'years' || zoomLevel === 'months']);

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
    if (containerRef.current) lastScrollTopRef.current = containerRef.current.scrollTop;
    if (scrollRafRef.current !== null) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      const el = containerRef.current;
      if (!el) return;
      // Snap to a row pitch: the mounted/prefetched window only changes once per row of
      // scrolling, so re-render then instead of on every frame (the buffer absorbs the snap).
      const q = scrollQuantumRef.current;
      const snapped = Math.floor(el.scrollTop / q) * q;
      setScrollTop((prev) => (prev === snapped ? prev : snapped));

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

        const idx = ZOOM_LEVELS.indexOf(zoomLevel);
        const next = e.deltaY < 0 ? ZOOM_LEVELS[idx + 1] : e.deltaY > 0 ? ZOOM_LEVELS[idx - 1] : undefined;
        if (next && idx >= 0) {
          // Remember which photo is under the pointer and where on screen it is, so the new layout can put
          // that same photo back under the pointer.
          wheelAnchorRef.current = captureWheelAnchor(e, containerRef.current, layoutRef.current.data, layoutRef.current.cfg);
          onZoomChange(next); // Scroll Up = Zoom In, Scroll Down = Zoom Out
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
      const yr = photoMonthInfo(p).year;
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
  // Incremental: catalog pages that only append to `photos` don't regroup the whole list.
  const groupMonths = useMemo(() => createMonthGrouper(), []);
  const monthGroups = useMemo(() => groupMonths(photos), [groupMonths, photos]);

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
  scrollQuantumRef.current = gridConfig.itemHeight + gridConfig.gap;

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

  // PhotoCard is memoized with a comparator that ignores its callback props, so the
  // per-card handlers below can hold stale closures. They read everything that
  // changes over time (selection, columns, groups, callbacks) through this ref.
  // The zoom level changed in THIS render (toolbar, wheel or anything else): remember the old layout and the old
  // offset. Idempotent, so a repeated render (StrictMode) does not lose it.
  const previousLayout = layoutRef.current;
  layoutRef.current = { zoomLevel, data: virtualMonthData, cfg: gridConfig };
  if (previousLayout.zoomLevel !== zoomLevel) {
    const wheel = wheelAnchorRef.current && Date.now() - wheelAnchorRef.current.at < 400 ? wheelAnchorRef.current : null;
    wheelAnchorRef.current = null;
    zoomTransitionRef.current = {
      from: { data: previousLayout.data, cfg: previousLayout.cfg },
      scrollTop: lastScrollTopRef.current,
      wheel: wheel ? { anchor: wheel.anchor, viewportY: wheel.viewportY } : null,
    };
  }

  // After the new layout is in the DOM: scroll so the photo the user was looking at is where they were looking.
  useLayoutEffect(() => {
    const t = zoomTransitionRef.current;
    if (!t) return;
    zoomTransitionRef.current = null;
    const el = containerRef.current;
    const cur = layoutRef.current;
    // The years / months views have no thumbnail grid to anchor in.
    if (!el || t.from.data.length === 0 || cur.data.length === 0) return;
    const oldGroups = toAnchorGroups(t.from.data);
    let anchor: ZoomAnchor | null;
    let viewportY = 0;
    if (t.wheel) {
      anchor = t.wheel.anchor;
      viewportY = t.wheel.viewportY;
    } else {
      // Toolbar: the thumbnail at the top-left of the viewport stays at the top-left.
      anchor = anchorAtY(oldGroups, t.from.cfg, t.scrollTop, { topLeft: true });
    }
    if (!anchor) return;
    const next = scrollTopFor(toAnchorGroups(cur.data), cur.cfg, anchor, viewportY);
    if (next === null) return;
    el.scrollTop = next;
    lastScrollTopRef.current = next;
    const q = scrollQuantumRef.current;
    setScrollTop(Math.floor(next / q) * q);
  }, [zoomLevel]);

  const live = useRef({ selectedIds, cols: gridConfig.cols, monthGroups, onToggleSelect, onSelectPhoto, onSelectionChange, onDragSelect, isSelectMode });
  live.current = { selectedIds, cols: gridConfig.cols, monthGroups, onToggleSelect, onSelectPhoto, onSelectionChange, onDragSelect, isSelectMode };

  // Must live up here with the other hooks: the 'years'/'months' zoom levels and the
  // empty-list case return early below, and a hook AFTER those returns is skipped on
  // those renders — switching to Years crashed the whole app (React error #300,
  // "Rendered fewer hooks than expected").
  const scrubberMonths = useMemo(
    () => virtualMonthData.map((item) => ({ key: item.key, label: item.group.label, year: item.group.year, top: item.top })),
    [virtualMonthData]
  );

  // Row window of every on-screen month group. Render and thumbnail prefetch use the same
  // window (same 1600px buffer), computed once per scroll snap / data change.
  const viewportTop = Math.max(0, scrollTop - RENDER_BUFFER_PX);
  const viewportBottom = scrollTop + containerHeight + RENDER_BUFFER_PX;
  const monthWindows = useMemo(() => {
    if (zoomLevel === 'years' || zoomLevel === 'months') return [];
    const { itemHeight, gap } = gridConfig;
    return virtualMonthData.map((item) => monthRowWindow(item, viewportTop, viewportBottom, itemHeight, gap));
  }, [virtualMonthData, viewportTop, viewportBottom, gridConfig, zoomLevel]);
  // Only when this signature (the visible start/end rows) or the data changes do we refetch.
  const windowSig = monthWindows.reduce((s, w, i) => (w ? `${s}${i}:${w.startRow}-${w.endRow};` : s), '');
  const monthWindowsRef = useRef(monthWindows);
  monthWindowsRef.current = monthWindows;

  // Automatically pre-fetch up to 100 thumbnails in 1 single async request for all
  // visible rows. This hook must be called on every render regardless of zoomLevel
  // or an empty photo list (React's Rules of Hooks) — it no-ops internally for the
  // 'years'/'months' zoom levels via the early-return inside the effect body below,
  // rather than skipping the hook call itself.
  useEffect(() => {
    if (zoomLevel === 'years' || zoomLevel === 'months') return;
    if (virtualMonthData.length === 0) return;

    const { cols, size } = gridConfig;
    const pixelSizeMap: Record<string, number> = {
      very_small: 150,
      small: 200,
      medium: 300,
      large: 500,
    };
    const targetSize = pixelSizeMap[size] || 250;
    const itemsToFetch: Array<{ path: string; originalPath?: string }> = [];

    virtualMonthData.forEach((item, i) => {
      const w = monthWindowsRef.current[i];
      if (!w) return;
      for (const p of item.group.photos.slice(w.startRow * cols, w.endRow * cols)) {
        itemsToFetch.push({
          path: p.thumbnailPath || p.filePath,
          originalPath: p.originalRemotePath,
        });
      }
    });

    if (itemsToFetch.length > 0) {
      requestBatchThumbnails(itemsToFetch, targetSize);
    }
  }, [virtualMonthData, windowSig, gridConfig, zoomLevel]);

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
  // (monthWindows above holds the resulting per-group row windows).
  const { cols, itemHeight, gap, size } = gridConfig;

  const handleScrubberJump = (top: number) => {
    if (containerRef.current) {
      containerRef.current.scrollTop = top;
    }
  };

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden' }}>
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
      {virtualMonthData.map((item, itemIdx) => {
        const win = monthWindows[itemIdx];

        // If offscreen, render lightweight empty placeholder div to reserve exact layout scroll height!
        if (!win) {
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

        // Visible row range inside this month
        const { startRow, endRow } = win;

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
                    onToggleSelect={() => live.current.onToggleSelect && live.current.onToggleSelect(photo.id)}
                    onCardMouseDown={(_id, e) => {
                      if (e.button === 0) {
                        // Read live values: this closure can be stale (memoized card).
                        const { cols, selectedIds } = live.current;
                        const groupPhotos = live.current.monthGroups.find((g) => g.key === item.key)?.photos ?? item.group.photos;
                        isMouseDownRef.current = true;
                        const photoIdx = groupPhotos.findIndex((p) => p.id === photo.id);
                        dragAnchorRef.current = {
                          groupKey: item.key,
                          photoId: photo.id,
                          index: photoIdx,
                          row: Math.floor(photoIdx / cols),
                          col: photoIdx % cols,
                        };
                        // Explorer-style drag selection:
                        //  - plain press + drag starts a NEW selection (what was selected before is replaced once the
                        //    drag actually starts; a plain click without dragging is handled by onClick as before);
                        //  - Ctrl/Cmd + press + drag ADDS the dragged block to the current selection. The photos that
                        //    were already selected stay exactly as they are: never toggled off, even if the new block
                        //    overlaps them.
                        const additive = e.ctrlKey || e.metaKey;
                        initialSelectedIdsRef.current = additive ? new Set(selectedIds) : new Set();
                      }
                    }}
                    onCardMouseEnter={(id) => {
                      if (isMouseDownRef.current && dragAnchorRef.current) {
                        if (id === dragAnchorRef.current.photoId && !isDragSelectingRef.current) {
                          return;
                        }
                        isDragSelectingRef.current = true;
                        const { cols, monthGroups, onSelectionChange, onDragSelect } = live.current;
                        const groupPhotos = monthGroups.find((g) => g.key === item.key)?.photos ?? item.group.photos;
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
                      const { onToggleSelect, onSelectPhoto, selectedIds, isSelectMode } = live.current;
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

      <TimelineYearScrubber months={scrubberMonths} scrollTop={scrollTop} onJump={handleScrubberJump} />
    </div>
  );
};
