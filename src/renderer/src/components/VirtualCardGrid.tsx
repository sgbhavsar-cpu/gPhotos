import React, { useEffect, useRef, useState } from 'react';

// A windowed card grid: only the rows in (or near) view are mounted, so a
// 5,000-person People screen costs ~40 cards of DOM instead of 5,000. Cards
// have a fixed height (rowHeight), which is what lets the total scroll height
// and each row's position be computed without measuring every card.

/** Same column count CSS `repeat(auto-fill, minmax(minCol, 1fr))` would give. */
export function computeColumns(width: number, minColWidth: number, gap: number): number {
  return Math.max(1, Math.floor((width + gap) / (minColWidth + gap)));
}

/**
 * Which rows to mount. `scrollTop` is the scroller's scroll offset and
 * `gridTop` the grid's top edge within the scroller's content, so their
 * difference is how far into the grid the viewport starts.
 */
export function computeRowRange(
  scrollTop: number,
  viewportHeight: number,
  gridTop: number,
  rowPitch: number,
  totalRows: number,
  overscanRows: number
): { startRow: number; endRow: number } {
  const relTop = scrollTop - gridTop;
  const first = Math.floor(relTop / rowPitch);
  const last = Math.ceil((relTop + viewportHeight) / rowPitch);
  const clamp = (n: number) => Math.max(0, Math.min(totalRows, n));
  return { startRow: clamp(first - overscanRows), endRow: clamp(last + overscanRows) };
}

interface Layout {
  cols: number;
  startRow: number;
  endRow: number;
}

interface VirtualCardGridProps<T> {
  items: T[];
  getKey: (item: T) => string;
  /** Rendered inside a cell of exactly `rowHeight`px — give the card `height: 100%`. */
  renderItem: (item: T) => React.ReactNode;
  /** The scrolling ancestor whose scroll position drives the window. */
  scrollRef: React.RefObject<HTMLElement | null>;
  rowHeight: number;
  minColWidth?: number;
  gap?: number;
  overscanRows?: number;
  /** Called with the mounted item index range [start, end) whenever it changes — e.g. to prefetch data just beyond it. */
  onWindowChange?: (startIndex: number, endIndex: number) => void;
}

export function VirtualCardGrid<T>({
  items,
  getKey,
  renderItem,
  scrollRef,
  rowHeight,
  minColWidth = 180,
  gap = 20,
  overscanRows = 2,
  onWindowChange,
}: VirtualCardGridProps<T>) {
  const gridRef = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<Layout>({ cols: 1, startRow: 0, endRow: 0 });
  const rowPitch = rowHeight + gap;

  useEffect(() => {
    const scroller = scrollRef.current;
    const grid = gridRef.current;
    if (!scroller || !grid) return;

    const measure = () => {
      const cols = computeColumns(grid.clientWidth, minColWidth, gap);
      const totalRows = Math.ceil(items.length / cols);
      const gridTop = grid.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
      const { startRow, endRow } = computeRowRange(scroller.scrollTop, scroller.clientHeight, gridTop, rowPitch, totalRows, overscanRows);
      // Only re-render when the mounted window actually changes, not on every scroll pixel.
      setLayout((prev) => (prev.cols === cols && prev.startRow === startRow && prev.endRow === endRow ? prev : { cols, startRow, endRow }));
    };

    let raf = 0;
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        measure();
      });
    };

    measure();
    scroller.addEventListener('scroll', schedule, { passive: true });
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null;
    observer?.observe(scroller);
    observer?.observe(grid);
    return () => {
      scroller.removeEventListener('scroll', schedule);
      observer?.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [scrollRef, items.length, rowPitch, minColWidth, gap, overscanRows]);

  const onWindowChangeRef = useRef(onWindowChange);
  onWindowChangeRef.current = onWindowChange;
  useEffect(() => {
    onWindowChangeRef.current?.(layout.startRow * layout.cols, layout.endRow * layout.cols);
  }, [layout, items]);

  const { cols, startRow, endRow } = layout;
  const totalRows = Math.ceil(items.length / cols);
  const totalHeight = totalRows === 0 ? 0 : totalRows * rowHeight + (totalRows - 1) * gap;
  const visible = items.slice(startRow * cols, endRow * cols);

  return (
    <div ref={gridRef} style={{ position: 'relative', height: totalHeight }}>
      <div
        style={{
          position: 'absolute',
          top: startRow * rowPitch,
          left: 0,
          right: 0,
          display: 'grid',
          gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
          gridAutoRows: `${rowHeight}px`,
          gap: `${gap}px`,
        }}
      >
        {visible.map((item) => (
          <React.Fragment key={getKey(item)}>{renderItem(item)}</React.Fragment>
        ))}
      </div>
    </div>
  );
}
