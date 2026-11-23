import React, { useRef, useState } from 'react';
import { ZoomIn, ZoomOut } from 'lucide-react';

export interface TimelineItem {
  id: string;
  kind: 'photo' | 'collage' | 'clip';
  label: string;
  /** Seconds this slide is on screen. */
  seconds: number;
  included: boolean;
  thumbUrl?: string;
}

interface SlideTimelineProps {
  items: TimelineItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Dragged block `from` dropped onto block `to` (indices into `items`). */
  onReorder: (from: number, to: number) => void;
  /** The right edge of a photo / collage block was dragged: its new on-screen time. */
  onResize: (id: string, seconds: number) => void;
}

const KIND_COLOUR: Record<TimelineItem['kind'], string> = { photo: '#3b82f6', collage: '#ec4899', clip: '#f5b942' };
export const MIN_BLOCK_SEC = 0.5;
export const MAX_BLOCK_SEC = 30;

/** Start time and width (in px) of every block, for a given zoom; only included slides take time. */
export function timelineLayout(items: TimelineItem[], pxPerSec: number): Array<{ start: number; width: number }> {
  let t = 0;
  return items.map((it) => {
    const start = t;
    if (it.included) t += it.seconds;
    return { start, width: Math.max(24, it.seconds * pxPerSec) };
  });
}

/** The slides as proportional blocks on a time ruler: drag to reorder, drag a block's right edge to change how long it stays. */
export const SlideTimeline: React.FC<SlideTimelineProps> = ({ items, selectedId, onSelect, onReorder, onResize }) => {
  const [pps, setPps] = useState(36);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dropOn, setDropOn] = useState<number | null>(null);
  const resizeRef = useRef<{ id: string; x0: number; s0: number } | null>(null);
  const total = items.filter((i) => i.included).reduce((a, i) => a + i.seconds, 0);
  const layout = timelineLayout(items, pps);
  const tickEvery = pps >= 50 ? 1 : pps >= 24 ? 5 : 10;
  const ticks = Array.from({ length: Math.floor(total / tickEvery) + 1 }, (_, i) => i * tickEvery);

  return (
    <div data-testid="slide-timeline" style={{ display: 'flex', flexDirection: 'column', gap: '6px', padding: '8px 10px', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', backgroundColor: 'var(--bg-surface-elevated)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
        <span>Timeline · about {total.toFixed(1)} s (drag a block to move it, drag its right edge to change how long it stays)</span>
        <span style={{ display: 'flex', gap: '4px' }}>
          <button className="btn btn-ghost btn-icon" aria-label="Zoom timeline out" onClick={() => setPps((v) => Math.max(10, v - 8))} style={{ width: '26px', height: '26px' }}><ZoomOut size={14} /></button>
          <button className="btn btn-ghost btn-icon" aria-label="Zoom timeline in" onClick={() => setPps((v) => Math.min(90, v + 8))} style={{ width: '26px', height: '26px' }}><ZoomIn size={14} /></button>
        </span>
      </div>
      <div style={{ overflowX: 'auto', paddingBottom: '4px' }}>
        <div style={{ position: 'relative', height: '16px', minWidth: `${Math.max(1, total) * pps}px`, color: 'var(--text-muted)', fontSize: '0.65rem' }}>
          {ticks.map((t) => <span key={t} style={{ position: 'absolute', left: `${t * pps}px`, top: 0, borderLeft: '1px solid var(--border-subtle)', paddingLeft: '3px' }}>{t}s</span>)}
        </div>
        <div style={{ display: 'flex', gap: '2px', alignItems: 'stretch' }}>
          {items.map((it, i) => (
            <div
              key={it.id}
              data-testid="timeline-block"
              data-slide-id={it.id}
              draggable
              onDragStart={() => setDragFrom(i)}
              onDragOver={(e) => { e.preventDefault(); setDropOn(i); }}
              onDragLeave={() => setDropOn((d) => (d === i ? null : d))}
              onDrop={() => { if (dragFrom !== null && dragFrom !== i) onReorder(dragFrom, i); setDragFrom(null); setDropOn(null); }}
              onDragEnd={() => { setDragFrom(null); setDropOn(null); }}
              onClick={() => onSelect(it.id)}
              title={`${it.label} · ${it.seconds.toFixed(1)} s${it.included ? '' : ' (left out)'}`}
              style={{
                position: 'relative', flex: 'none', width: `${layout[i].width}px`, height: '54px', borderRadius: '6px', overflow: 'hidden', cursor: 'grab',
                borderTop: `4px solid ${KIND_COLOUR[it.kind]}`, backgroundColor: '#1e293b',
                backgroundImage: it.thumbUrl ? `url("${it.thumbUrl}")` : undefined, backgroundSize: 'cover', backgroundPosition: 'center',
                opacity: it.included ? 1 : 0.35,
                outline: it.id === selectedId ? '2px solid #fff' : dropOn === i && dragFrom !== null ? '2px dashed #ec4899' : 'none', outlineOffset: '1px',
              }}
            >
              <span style={{ position: 'absolute', left: '4px', bottom: '2px', fontSize: '0.62rem', fontWeight: 700, color: '#fff', textShadow: '0 1px 2px rgba(0,0,0,0.9)' }}>
                {it.kind === 'clip' ? 'CLIP ' : it.kind === 'collage' ? 'COLLAGE ' : ''}{it.seconds.toFixed(1)}s
              </span>
              {it.kind !== 'clip' && (
                <div
                  data-testid="timeline-resize"
                  aria-label="Drag to change how long this slide stays"
                  onClick={(e) => e.stopPropagation()}
                  draggable={false}
                  onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId); resizeRef.current = { id: it.id, x0: e.clientX, s0: it.seconds }; }}
                  onPointerMove={(e) => {
                    const r = resizeRef.current;
                    if (!r || r.id !== it.id) return;
                    const next = Math.min(MAX_BLOCK_SEC, Math.max(MIN_BLOCK_SEC, Math.round((r.s0 + (e.clientX - r.x0) / pps) * 2) / 2));
                    if (next !== it.seconds) onResize(it.id, next);
                  }}
                  onPointerUp={() => { resizeRef.current = null; }}
                  onPointerCancel={() => { resizeRef.current = null; }}
                  style={{ position: 'absolute', top: 0, right: 0, bottom: 0, width: '8px', cursor: 'ew-resize', backgroundColor: 'rgba(255,255,255,0.35)', touchAction: 'none' }}
                />
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
