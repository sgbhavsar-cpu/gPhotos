import React, { useEffect, useRef, useState } from 'react';
import { FolderInput, Wand2, X } from 'lucide-react';
import type { AlbumChapter } from '../../../types';
import { ChapterPicker } from './ChapterPicker';

export interface Rect { left: number; top: number; right: number; bottom: number }

export const rectsIntersect = (a: Rect, b: Rect) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

const MOVE_THRESHOLD_PX = 4;
const EDGE_SCROLL_ZONE_PX = 40;
const EDGE_SCROLL_STEP_PX = 16;
/** A press that starts one of these is theirs (opening a photo, a button, a text box...) — not the start of a rubber band. */
const NOT_A_BACKGROUND = '[data-album-photo-id], button, input, textarea, select, a, [role="dialog"]';

interface MarqueeOptions {
  containerRef: React.RefObject<HTMLElement | null>;
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  enabled?: boolean;
}

/**
 * Press-and-drag ("rubber band") selection over the album's photo tiles (each marked data-album-photo-id).
 * It starts on empty space, or on a tile's checkbox (data-marquee-start), never on the photo itself — pressing
 * a photo still opens it / drags it to a chapter. Ctrl / Cmd / Shift, or starting on a checkbox, ADDS to the
 * current selection; a plain background press replaces it, and a background click without dragging clears it.
 * The album grid is windowed (off-screen rows are not in the DOM), so what each tile last did is remembered:
 * a photo scrolled out of the band keeps its state until it is drawn again. Near the top/bottom edge the
 * container scrolls by itself while the button is held.
 */
export function useMarqueeSelect({ containerRef, selected, onChange, enabled = true }: MarqueeOptions) {
  const [marquee, setMarquee] = useState<Rect | null>(null);
  const [armed, setArmed] = useState(false);
  const live = useRef({ containerRef, selected, onChange, enabled });
  live.current = { containerRef, selected, onChange, enabled };
  /** True for the click that browsers fire right after a drag that ended on the element it started on. */
  const suppressClick = useRef(false);
  const cleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanupRef.current?.(), []);

  const onMouseDown = (e: React.MouseEvent) => {
    const { containerRef: ref, enabled: on } = live.current;
    const container = ref.current;
    if (!container || on === false || e.button !== 0) return;
    const target = e.target as HTMLElement;
    const onCheckbox = !!target.closest('[data-marquee-start]');
    if (!onCheckbox && target.closest(NOT_A_BACKGROUND)) return;

    const startX = e.clientX;
    const startY = e.clientY;
    const startScroll = container.scrollTop;
    const additive = onCheckbox || e.ctrlKey || e.metaKey || e.shiftKey;
    const base = additive ? new Set(live.current.selected) : new Set<string>();
    const memory = new Map<string, boolean>();
    let active = false;
    let last = { x: startX, y: startY };
    let edgeTimer: ReturnType<typeof setInterval> | null = null;

    setArmed(true);

    const update = () => {
      const c = live.current.containerRef.current;
      if (!c) return;
      // The band is anchored to the CONTENT: if the container scrolled since the press, the start moved with it.
      const sy = startY - (c.scrollTop - startScroll);
      const band: Rect = { left: Math.min(startX, last.x), right: Math.max(startX, last.x), top: Math.min(sy, last.y), bottom: Math.max(sy, last.y) };
      c.querySelectorAll('[data-album-photo-id]').forEach((el) => {
        memory.set(el.getAttribute('data-album-photo-id')!, rectsIntersect(band, el.getBoundingClientRect()));
      });
      const next = new Set(base);
      memory.forEach((hit, id) => { if (hit) next.add(id); });
      live.current.onChange(next);
      const cr = c.getBoundingClientRect();
      setMarquee({ left: Math.max(band.left, cr.left), right: Math.min(band.right, cr.right), top: Math.max(band.top, cr.top), bottom: Math.min(band.bottom, cr.bottom) });
    };

    const stopEdgeScroll = () => { if (edgeTimer) { clearInterval(edgeTimer); edgeTimer = null; } };

    const onMove = (ev: MouseEvent) => {
      last = { x: ev.clientX, y: ev.clientY };
      if (!active) {
        if (Math.hypot(last.x - startX, last.y - startY) < MOVE_THRESHOLD_PX) return;
        active = true;
        document.body.style.userSelect = 'none'; // dragging across captions must not select their text
        window.getSelection()?.removeAllRanges();
      }
      const c = live.current.containerRef.current;
      if (c) {
        const cr = c.getBoundingClientRect();
        const dir = last.y < cr.top + EDGE_SCROLL_ZONE_PX ? -1 : last.y > cr.bottom - EDGE_SCROLL_ZONE_PX ? 1 : 0;
        if (dir === 0) stopEdgeScroll();
        else if (!edgeTimer) {
          edgeTimer = setInterval(() => {
            const cc = live.current.containerRef.current;
            if (!cc) return;
            const d = last.y < cc.getBoundingClientRect().top + EDGE_SCROLL_ZONE_PX ? -1 : 1;
            cc.scrollTop += d * EDGE_SCROLL_STEP_PX;
            update();
          }, 30);
        }
      }
      update();
    };

    const onUp = () => {
      cleanup();
      if (active) {
        suppressClick.current = true;
        setTimeout(() => { suppressClick.current = false; }, 0);
      } else if (!additive) {
        live.current.onChange(new Set()); // a plain click on empty space clears the selection
      }
    };

    const cleanup = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      stopEdgeScroll();
      document.body.style.userSelect = '';
      setMarquee(null);
      setArmed(false);
      cleanupRef.current = null;
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    cleanupRef.current = cleanup;
    // Empty space: don't let the browser start selecting text. (A checkbox is a plain div, same.)
    e.preventDefault();
  };

  return { onMouseDown, marquee, armed, suppressClick };
}

/** The rubber band itself. */
export const MarqueeBox: React.FC<{ rect: Rect | null }> = ({ rect }) => {
  if (!rect) return null;
  return (
    <div
      data-testid="marquee-box"
      style={{
        position: 'fixed', left: rect.left, top: rect.top, width: rect.right - rect.left, height: rect.bottom - rect.top,
        border: '1px solid #10b981', backgroundColor: 'rgba(16, 185, 129, 0.15)', pointerEvents: 'none', zIndex: 900,
      }}
    />
  );
};

interface Anchor { top: number; left: number; width: number; bottom: number }

/**
 * Shown while photos are being dragged: every chapter (plus "Other Photos") as a target pinned to the top of
 * the photo area, so a long album never needs scrolling to reach the chapter you want. It is `fixed`, so showing
 * it does not move the page under the cursor mid-drag.
 */
export const ChapterDropBar: React.FC<{
  chapters: AlbumChapter[];
  count: number;
  anchor: Anchor;
  onDropTo: (chapterId: string | null, e: React.DragEvent) => void;
}> = ({ chapters, count, anchor, onDropTo }) => {
  const [over, setOver] = useState<string | null>(null); // chapter id, or 'none'
  const target = (id: string | null, label: string, sub?: string) => {
    const key = id ?? 'none';
    const isOver = over === key;
    return (
      <div
        key={key}
        data-testid={`drop-chapter-${key}`}
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setOver(key); }}
        onDragLeave={() => setOver((o) => (o === key ? null : o))}
        onDrop={(e) => { setOver(null); onDropTo(id, e); }}
        style={{
          padding: '8px 14px', borderRadius: 'var(--radius-md)', fontSize: '0.84rem', fontWeight: 600, maxWidth: '220px',
          border: isOver ? '2px solid #10b981' : '2px dashed rgba(255,255,255,0.35)',
          backgroundColor: isOver ? 'rgba(16, 185, 129, 0.35)' : 'rgba(15, 23, 42, 0.9)', color: 'white',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}
      >
        {label}{sub ? <span style={{ fontWeight: 400, opacity: 0.7 }}> · {sub}</span> : null}
      </div>
    );
  };
  return (
    <div
      data-testid="chapter-drop-bar"
      style={{
        position: 'fixed', top: anchor.top, left: anchor.left, width: anchor.width, zIndex: 1000, boxSizing: 'border-box',
        padding: '10px 16px', display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap',
        background: 'linear-gradient(180deg, rgba(5,8,15,0.96) 0%, rgba(5,8,15,0.88) 100%)', borderBottom: '1px solid rgba(255,255,255,0.15)', backdropFilter: 'blur(6px)',
      }}
    >
      <span style={{ fontSize: '0.82rem', color: '#e2e8f0', fontWeight: 600 }}>
        Drop {count} photo{count === 1 ? '' : 's'} on a chapter:
      </span>
      {chapters.map((c) => target(c.id, c.title, String(c.photoIds.length)))}
      {target(null, 'Other Photos (no chapter)')}
    </div>
  );
};

/** Bar for the current selection (pinned to the bottom of the photo area): move them to a chapter, or clear. */
export const AlbumSelectionBar: React.FC<{
  count: number;
  chapters: AlbumChapter[];
  anchor: Anchor;
  onMoveTo: (chapterId: string | null) => void;
  onCreateChapter: (title: string) => void;
  onClear: () => void;
  /** Opens Smart Flows pre-scoped to the selected photos. Omitted where the caller has no Smart Flows to offer. */
  onRunSmartFlow?: () => void;
}> = ({ count, chapters, anchor, onMoveTo, onCreateChapter, onClear, onRunSmartFlow }) => {
  const [picking, setPicking] = useState(false);
  return (
    <div
      data-testid="album-selection-bar"
      style={{
        position: 'fixed', left: anchor.left, width: anchor.width, top: anchor.bottom - 64, zIndex: 950, display: 'flex', justifyContent: 'center', pointerEvents: 'none',
      }}
    >
      <div
        style={{
          pointerEvents: 'auto', display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 12px', borderRadius: 'var(--radius-full)',
          backgroundColor: 'var(--bg-surface-elevated)', border: '1px solid var(--border-subtle)', boxShadow: '0 12px 32px rgba(0,0,0,0.55)',
        }}
      >
        <span style={{ fontSize: '0.84rem', fontWeight: 600 }}>{count} selected</span>
        <span style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>drag them onto a chapter, or</span>
        <div style={{ position: 'relative' }}>
          <button className="btn btn-primary" onClick={() => setPicking((p) => !p)} style={{ gap: '6px', padding: '6px 12px', fontSize: '0.8rem' }}>
            <FolderInput size={14} /> Move to chapter…
          </button>
          {picking && (
            <ChapterPicker
              chapters={chapters}
              currentChapterId={undefined}
              onPick={(id) => { setPicking(false); onMoveTo(id); }}
              onCreateNew={(title) => { setPicking(false); onCreateChapter(title); }}
              onClose={() => setPicking(false)}
              anchorStyle={{ bottom: '42px', left: 0 }}
            />
          )}
        </div>
        {onRunSmartFlow && (
          <button className="btn btn-secondary" onClick={onRunSmartFlow} title="Run one of your Smart Flows against just the selected photos" style={{ gap: '6px', padding: '6px 12px', fontSize: '0.8rem' }}>
            <Wand2 size={14} color="#c084fc" /> Run Smart Flow
          </button>
        )}
        <button className="btn btn-ghost btn-icon" title="Clear selection" aria-label="Clear selection" onClick={onClear} style={{ width: '30px', height: '30px' }}><X size={15} /></button>
      </div>
    </div>
  );
};
