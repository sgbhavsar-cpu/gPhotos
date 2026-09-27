import React, { useEffect, useRef, useState } from 'react';
import { computeRowRange } from './VirtualCardGrid';

// Horizontal counterpart of VirtualCardGrid for a single scrolling strip of fixed-width cards
// (e.g. the map's cluster tray): only the cards in/near view are mounted; leading and trailing
// spacers keep the scroll width, and every card's position, exactly what it would be unwindowed.

interface Props<T> {
  items: T[];
  getKey: (item: T) => string;
  renderItem: (item: T) => React.ReactNode;
  /** The horizontally scrolling ancestor (or the strip's own parent) whose scrollLeft drives the window. */
  scrollRef: React.RefObject<HTMLElement | null>;
  itemWidth: number;
  gap?: number;
  overscan?: number;
  /** Extra styles for the flex row (e.g. alignItems). */
  style?: React.CSSProperties;
}

/** Item index range [start, end) to mount — same maths as the vertical grid, along x. */
export function computeItemRange(scrollLeft: number, viewportWidth: number, stripLeft: number, itemWidth: number, gap: number, total: number, overscan: number) {
  const r = computeRowRange(scrollLeft, viewportWidth, stripLeft, itemWidth + gap, total, overscan);
  return { start: r.startRow, end: r.endRow };
}

export function VirtualHorizontalList<T>({ items, getKey, renderItem, scrollRef, itemWidth, gap = 12, overscan = 3, style }: Props<T>) {
  const stripRef = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState({ start: 0, end: 0 });
  const pitch = itemWidth + gap;

  useEffect(() => {
    const scroller = scrollRef.current;
    const strip = stripRef.current;
    if (!scroller || !strip) return;
    const measure = () => {
      const stripLeft = strip.getBoundingClientRect().left - scroller.getBoundingClientRect().left + scroller.scrollLeft;
      const next = computeItemRange(scroller.scrollLeft, scroller.clientWidth, stripLeft, itemWidth, gap, items.length, overscan);
      setRange((prev) => (prev.start === next.start && prev.end === next.end ? prev : next));
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
    return () => {
      scroller.removeEventListener('scroll', schedule);
      observer?.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [scrollRef, items.length, itemWidth, gap, overscan]);

  const total = items.length;
  const start = Math.min(range.start, total);
  const end = Math.min(range.end, total);
  const lead = start > 0 ? start * pitch - gap : 0;
  const trail = end < total ? (total - end) * pitch - gap : 0;

  return (
    <div ref={stripRef} style={{ display: 'flex', gap, ...style }}>
      {lead > 0 && <div style={{ flex: '0 0 auto', width: lead }} />}
      {items.slice(start, end).map((item) => (
        <React.Fragment key={getKey(item)}>{renderItem(item)}</React.Fragment>
      ))}
      {trail > 0 && <div style={{ flex: '0 0 auto', width: trail }} />}
    </div>
  );
}
