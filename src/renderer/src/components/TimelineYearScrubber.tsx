import React, { useMemo, useRef, useState, useCallback } from 'react';

export interface ScrubberMonth {
  key: string;
  label: string;
  year: number;
  top: number;
}

interface TimelineYearScrubberProps {
  /** Every month group, sorted newest-first — same order as virtualMonthData. */
  months: ScrubberMonth[];
  scrollTop: number;
  onJump: (top: number) => void;
}

/**
 * A Google-Photos-style vertical year strip: years are spaced evenly by
 * INDEX into `months` (not by real scroll-pixel distance), so a year with
 * few photos doesn't collapse to a sliver next to a prolific one. Dragging
 * maps the same way — visual position -> index into `months` -> that
 * month's precomputed scroll offset — so the tick positions and the actual
 * jump target always agree with each other.
 */
export const TimelineYearScrubber: React.FC<TimelineYearScrubberProps> = ({ months, scrollTop, onJump }) => {
  const trackRef = useRef<HTMLDivElement>(null);
  const [hoverFraction, setHoverFraction] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const yearTicks = useMemo(() => {
    if (months.length === 0) return [];
    const seen = new Set<number>();
    const ticks: { year: number; fraction: number }[] = [];
    months.forEach((m, i) => {
      if (!seen.has(m.year)) {
        seen.add(m.year);
        ticks.push({ year: m.year, fraction: months.length > 1 ? i / (months.length - 1) : 0 });
      }
    });
    return ticks;
  }, [months]);

  const activeMonthIndex = useMemo(() => {
    // The last month whose top has already scrolled past — i.e. the one
    // currently pinned as the sticky header.
    let idx = 0;
    for (let i = 0; i < months.length; i++) {
      if (months[i].top <= scrollTop + 40) idx = i;
      else break;
    }
    return idx;
  }, [months, scrollTop]);

  const activeYear = months[activeMonthIndex]?.year;

  const fractionToIndex = useCallback(
    (fraction: number) => Math.max(0, Math.min(months.length - 1, Math.round(fraction * (months.length - 1)))),
    [months.length]
  );

  const handlePointer = useCallback(
    (clientY: number, jump: boolean) => {
      const track = trackRef.current;
      if (!track || months.length === 0) return;
      const rect = track.getBoundingClientRect();
      const fraction = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
      setHoverFraction(fraction);
      if (jump) {
        const idx = fractionToIndex(fraction);
        onJump(months[idx].top);
      }
    },
    [months, fractionToIndex, onJump]
  );

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    handlePointer(e.clientY, true);

    const handleMove = (ev: MouseEvent) => handlePointer(ev.clientY, true);
    const handleUp = () => {
      setIsDragging(false);
      setHoverFraction(null);
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
  };

  if (months.length === 0) return null;

  const hoverIndex = hoverFraction != null ? fractionToIndex(hoverFraction) : null;
  const hoverLabel = hoverIndex != null ? months[hoverIndex].label : null;

  return (
    <div
      style={{
        width: '36px',
        flexShrink: 0,
        position: 'relative',
        display: 'flex',
        alignItems: 'stretch',
        cursor: 'pointer',
      }}
      onMouseEnter={(e) => handlePointer(e.clientY, false)}
      onMouseLeave={() => !isDragging && setHoverFraction(null)}
      onMouseMove={(e) => !isDragging && handlePointer(e.clientY, false)}
    >
      <div ref={trackRef} onMouseDown={handleMouseDown} style={{ position: 'relative', width: '100%', height: '100%' }}>
        {yearTicks.map((tick) => (
          <div
            key={tick.year}
            style={{
              position: 'absolute',
              top: `${tick.fraction * 100}%`,
              right: '6px',
              transform: 'translateY(-50%)',
              fontSize: '0.68rem',
              fontWeight: tick.year === activeYear ? 700 : 500,
              color: tick.year === activeYear ? 'var(--accent-primary)' : 'var(--text-muted)',
              whiteSpace: 'nowrap',
              pointerEvents: 'none',
              transition: 'color 0.15s ease',
            }}
          >
            {tick.year}
          </div>
        ))}
      </div>

      {hoverFraction != null && hoverLabel && (
        <div
          style={{
            position: 'fixed',
            right: '48px',
            top: `${(trackRef.current?.getBoundingClientRect().top ?? 0) + hoverFraction * (trackRef.current?.getBoundingClientRect().height ?? 0)}px`,
            transform: 'translateY(-50%)',
            padding: '6px 14px',
            borderRadius: 'var(--radius-md)',
            backgroundColor: 'var(--accent-primary)',
            color: 'white',
            fontSize: '0.82rem',
            fontWeight: 700,
            whiteSpace: 'nowrap',
            boxShadow: '0 4px 16px rgba(0, 0, 0, 0.4)',
            zIndex: 20,
            pointerEvents: 'none',
          }}
        >
          {hoverLabel}
        </div>
      )}
    </div>
  );
};
