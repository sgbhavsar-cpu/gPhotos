import React, { useEffect, useRef, useState } from 'react';
import { Plus, Trash2, AlignLeft, AlignCenter, AlignRight, Bold, Italic, RotateCcw } from 'lucide-react';
import type { Photo } from '../../../types';
import { FONT_FAMILIES, makeText, type DesignText, type SlideDesign } from '../../../types/slideDesign';
import { getLocalPhotoUrl } from '../services/libraryStore';
import { drawDesignOnCanvas, hitTestDesign, loadImage } from '../services/slideDesignRender';

/** The picture used for a "photo" background, at the largest size the photo cache serves. */
export const designPhotoUrl = (p: Photo) => getLocalPhotoUrl(p.filePath, p.originalRemotePath, false, 2048);

interface SlideDesignerProps {
  design: SlideDesign;
  onChange: (next: SlideDesign) => void;
  /** The video's real frame size, so the preview is drawn — and text fitted — exactly as it will render. */
  width: number;
  height: number;
  /** Photos offered as a background. */
  photos: Photo[];
  onReset: () => void;
}

const lbl: React.CSSProperties = { fontSize: '0.78rem', fontWeight: 600, color: 'var(--text-secondary)' };
const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' };

export const SlideDesigner: React.FC<SlideDesignerProps> = ({ design, onChange, width, height, photos, onReset }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [selectedId, setSelectedId] = useState<string | null>(design.texts[0]?.id ?? null);
  const [bgImage, setBgImage] = useState<HTMLImageElement | null>(null);
  const dragRef = useRef<{ id: string; dx: number; dy: number } | null>(null);
  const designRef = useRef(design);
  designRef.current = design;

  const bg = design.background;
  const bgPhotoId = bg.kind === 'photo' ? bg.photoId : null;
  const bgPhoto = bgPhotoId ? photos.find((p) => p.id === bgPhotoId) : undefined;

  useEffect(() => {
    let live = true;
    setBgImage(null);
    if (bgPhoto) loadImage(designPhotoUrl(bgPhoto)).then((img) => { if (live) setBgImage(img); });
    return () => { live = false; };
  }, [bgPhoto?.id]);

  useEffect(() => {
    if (canvasRef.current) drawDesignOnCanvas(canvasRef.current, design, width, height, bgImage);
  }, [design, width, height, bgImage]);

  useEffect(() => {
    if (selectedId && !design.texts.some((t) => t.id === selectedId)) setSelectedId(design.texts[0]?.id ?? null);
  }, [design.texts, selectedId]);

  const selected = design.texts.find((t) => t.id === selectedId) || null;
  const patch = (over: Partial<DesignText>) => selected && onChange({ ...design, texts: design.texts.map((t) => (t.id === selected.id ? { ...t, ...over } : t)) });

  const toFramePoint = (e: React.PointerEvent) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / Math.max(1, r.width)) * width, y: ((e.clientY - r.top) / Math.max(1, r.height)) * height };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const { x, y } = toFramePoint(e);
    const id = hitTestDesign(design, width, height, x, y);
    if (!id) return;
    const t = design.texts.find((tt) => tt.id === id)!;
    setSelectedId(id);
    dragRef.current = { id, dx: (t.xPct / 100) * width - x, dy: (t.yPct / 100) * height - y };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const { x, y } = toFramePoint(e);
    const xPct = Math.min(100, Math.max(0, ((x + d.dx) / width) * 100));
    const yPct = Math.min(100, Math.max(0, ((y + d.dy) / height) * 100));
    const cur = designRef.current;
    onChange({ ...cur, texts: cur.texts.map((t) => (t.id === d.id ? { ...t, xPct, yPct } : t)) });
  };
  const endDrag = () => { dragRef.current = null; };

  const addText = () => {
    const t = makeText({ text: 'New text', sizePct: 5, yPct: Math.min(90, 30 + design.texts.length * 12) });
    onChange({ ...design, texts: [...design.texts, t] });
    setSelectedId(t.id);
  };
  const removeText = () => {
    if (!selected) return;
    onChange({ ...design, texts: design.texts.filter((t) => t.id !== selected.id) });
  };

  const setBackgroundKind = (kind: 'gradient' | 'solid' | 'photo') => {
    if (kind === bg.kind) return;
    if (kind === 'gradient') onChange({ ...design, background: { kind: 'gradient', from: '#1e293b', to: '#0f172a' } });
    else if (kind === 'solid') onChange({ ...design, background: { kind: 'solid', color: '#0f172a' } });
    else onChange({ ...design, background: { kind: 'photo', photoId: photos[0]?.id ?? '', dim: 0.4 } });
  };

  return (
    <div style={{ display: 'flex', gap: '20px', flexWrap: 'wrap', alignItems: 'flex-start' }}>
      <div style={{ flex: '1 1 300px', display: 'flex', flexDirection: 'column', gap: '8px', alignItems: 'center', minWidth: 0 }}>
        <canvas
          ref={canvasRef}
          data-testid="design-canvas"
          width={width}
          height={height}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          style={{ maxWidth: '100%', maxHeight: '340px', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', cursor: 'move', touchAction: 'none', backgroundColor: '#000' }}
        />
        <span style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>
          {width}×{height} — the size of your video. Drag text to move it; it can never leave the frame.
        </span>
      </div>

      <div style={{ flex: '1 1 300px', display: 'flex', flexDirection: 'column', gap: '14px', minWidth: 0 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <span style={lbl}>Background</span>
          <div style={row}>
            {(['gradient', 'solid', 'photo'] as const).map((k) => (
              <button key={k} className={`btn ${bg.kind === k ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setBackgroundKind(k)} style={{ padding: '5px 12px', fontSize: '0.78rem', textTransform: 'capitalize' }}>{k}</button>
            ))}
          </div>
          {bg.kind === 'gradient' && (
            <div style={row}>
              <input type="color" aria-label="Gradient start colour" value={bg.from} onChange={(e) => onChange({ ...design, background: { ...bg, from: e.target.value } })} />
              <input type="color" aria-label="Gradient end colour" value={bg.to} onChange={(e) => onChange({ ...design, background: { ...bg, to: e.target.value } })} />
            </div>
          )}
          {bg.kind === 'solid' && <input type="color" aria-label="Background colour" value={bg.color} onChange={(e) => onChange({ ...design, background: { ...bg, color: e.target.value } })} />}
          {bg.kind === 'photo' && (
            <>
              <div data-testid="bg-photo-grid" style={{ display: 'flex', gap: '6px', overflowX: 'auto', paddingBottom: '4px' }}>
                {photos.slice(0, 60).map((p) => (
                  <img
                    key={p.id}
                    src={getLocalPhotoUrl(p.filePath, p.originalRemotePath, false, 80)}
                    alt={p.fileName}
                    title={p.fileName}
                    onClick={() => onChange({ ...design, background: { ...bg, photoId: p.id } })}
                    style={{ width: '54px', height: '54px', objectFit: 'cover', borderRadius: 'var(--radius-sm)', cursor: 'pointer', flexShrink: 0, border: bg.photoId === p.id ? '2px solid #ec4899' : '1px solid var(--border-subtle)' }}
                  />
                ))}
                {photos.length === 0 && <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>This album has no photos to use.</span>}
              </div>
              <label style={{ ...row, fontSize: '0.78rem' }}>
                Darken (keeps text readable)
                <input type="range" aria-label="Darken background" min={0} max={0.85} step={0.05} value={bg.dim} onChange={(e) => onChange({ ...design, background: { ...bg, dim: parseFloat(e.target.value) } })} />
              </label>
            </>
          )}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div style={row}>
            <span style={lbl}>Text</span>
            <button className="btn btn-secondary" onClick={addText} style={{ padding: '4px 10px', fontSize: '0.76rem', gap: '4px' }}><Plus size={12} /> Add text</button>
            <button className="btn btn-ghost" onClick={onReset} style={{ padding: '4px 10px', fontSize: '0.76rem', gap: '4px' }}><RotateCcw size={12} /> Reset design</button>
          </div>
          <div style={row}>
            {design.texts.map((t, i) => (
              <button
                key={t.id}
                data-testid="text-chip"
                className={`btn ${t.id === selectedId ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => setSelectedId(t.id)}
                style={{ padding: '3px 10px', fontSize: '0.74rem', maxWidth: '150px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              >
                {t.text.trim().split('\n')[0] || `Text ${i + 1}`}
              </button>
            ))}
          </div>

          {selected && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '10px', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)' }}>
              <textarea className="input" aria-label="Text" rows={2} value={selected.text} onChange={(e) => patch({ text: e.target.value })} style={{ width: '100%', resize: 'vertical' }} />
              <div style={row}>
                <select className="input" aria-label="Font" value={selected.fontFamily} onChange={(e) => patch({ fontFamily: e.target.value })} style={{ height: '34px', width: '160px', fontFamily: selected.fontFamily }}>
                  {FONT_FAMILIES.map((f) => <option key={f} value={f} style={{ fontFamily: f }}>{f}</option>)}
                </select>
                <input type="color" aria-label="Text colour" value={selected.color} onChange={(e) => patch({ color: e.target.value })} />
                <button className={`btn ${selected.bold ? 'btn-primary' : 'btn-secondary'}`} aria-label="Bold" onClick={() => patch({ bold: !selected.bold })} style={{ padding: '4px 8px' }}><Bold size={14} /></button>
                <button className={`btn ${selected.italic ? 'btn-primary' : 'btn-secondary'}`} aria-label="Italic" onClick={() => patch({ italic: !selected.italic })} style={{ padding: '4px 8px' }}><Italic size={14} /></button>
                {([['left', AlignLeft], ['center', AlignCenter], ['right', AlignRight]] as const).map(([a, Icon]) => (
                  <button key={a} className={`btn ${selected.align === a ? 'btn-primary' : 'btn-secondary'}`} aria-label={`Align ${a}`} onClick={() => patch({ align: a })} style={{ padding: '4px 8px' }}><Icon size={14} /></button>
                ))}
              </div>
              <label style={{ ...row, fontSize: '0.78rem' }}>
                Size
                <input type="range" aria-label="Font size" min={2} max={20} step={0.5} value={selected.sizePct} onChange={(e) => patch({ sizePct: parseFloat(e.target.value) })} />
                <span style={{ color: 'var(--text-muted)' }}>{selected.sizePct}% of the short side</span>
              </label>
              <label style={{ ...row, fontSize: '0.78rem' }}>
                Across
                <input type="range" aria-label="Horizontal position" min={0} max={100} step={1} value={Math.round(selected.xPct)} onChange={(e) => patch({ xPct: parseFloat(e.target.value) })} />
                Down
                <input type="range" aria-label="Vertical position" min={0} max={100} step={1} value={Math.round(selected.yPct)} onChange={(e) => patch({ yPct: parseFloat(e.target.value) })} />
              </label>
              <div style={{ ...row, justifyContent: 'space-between' }}>
                <label style={{ ...row, fontSize: '0.78rem' }}>
                  <input type="checkbox" checked={selected.shadow} onChange={(e) => patch({ shadow: e.target.checked })} /> Shadow
                </label>
                <button className="btn btn-ghost" onClick={removeText} style={{ padding: '4px 10px', fontSize: '0.76rem', gap: '4px', color: '#f43f5e' }}><Trash2 size={12} /> Remove text</button>
              </div>
            </div>
          )}
        </div>

        <label style={{ ...row, fontSize: '0.82rem' }}>
          Show for
          <input
            type="number"
            aria-label="Seconds on screen"
            className="input"
            min={1}
            max={30}
            step={0.5}
            value={design.seconds}
            onChange={(e) => onChange({ ...design, seconds: Math.min(30, Math.max(1, parseFloat(e.target.value) || 1)) })}
            style={{ height: '34px', width: '76px' }}
          />
          seconds
        </label>
      </div>
    </div>
  );
};
