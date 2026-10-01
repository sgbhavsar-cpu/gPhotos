// Draws a SlideDesign (title screen / end credits) onto a canvas. The designer's preview canvas has the
// video's real pixel size (it is only scaled down by CSS), so the preview, the drag hit-testing and the final
// card sent to the exporter all run this same code through the shared layoutText — what you see is what renders.
import { layoutText, cssFont, type SlideDesign, type FontSpec, type MeasureFn } from '../../../types/slideDesign';

export function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous'; // needed so the canvas can be exported (same as the cover-photo cropper)
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

const measureWith = (ctx: CanvasRenderingContext2D): MeasureFn => (font: FontSpec, text: string) => {
  ctx.font = cssFont(font);
  return ctx.measureText(text).width;
};

export function drawDesign(ctx: CanvasRenderingContext2D, design: SlideDesign, W: number, H: number, photo: HTMLImageElement | null): void {
  const bg = design.background;
  if (bg.kind === 'gradient') {
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, bg.from);
    g.addColorStop(1, bg.to);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  } else if (bg.kind === 'solid') {
    ctx.fillStyle = bg.color;
    ctx.fillRect(0, 0, W, H);
  } else {
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, W, H);
    if (photo && photo.width > 0 && photo.height > 0) {
      const scale = Math.max(W / photo.width, H / photo.height); // cover
      const w = photo.width * scale;
      const h = photo.height * scale;
      ctx.drawImage(photo, (W - w) / 2, (H - h) / 2, w, h);
    }
    if (bg.dim > 0) {
      ctx.fillStyle = `rgba(0,0,0,${Math.min(0.85, Math.max(0, bg.dim))})`;
      ctx.fillRect(0, 0, W, H);
    }
  }

  const measure = measureWith(ctx);
  ctx.textBaseline = 'top';
  for (const t of design.texts) {
    if (!t.text.trim()) continue;
    const l = layoutText(t, W, H, measure);
    ctx.save();
    ctx.font = cssFont(l.font);
    ctx.textAlign = l.textAlign;
    ctx.fillStyle = t.color;
    if (t.shadow) {
      ctx.shadowColor = 'rgba(0,0,0,0.65)';
      ctx.shadowBlur = l.font.px * 0.12;
      ctx.shadowOffsetY = l.font.px * 0.04;
    }
    l.lines.forEach((line, i) => ctx.fillText(line, l.lineX[i], l.box.y + i * l.lineHeightPx + (l.lineHeightPx - l.font.px) * 0.4));
    ctx.restore();
  }
}

/** Draws into an existing canvas, sizing it to the video frame. */
export function drawDesignOnCanvas(canvas: HTMLCanvasElement, design: SlideDesign, W: number, H: number, photo: HTMLImageElement | null): void {
  if (canvas.width !== W) canvas.width = W;
  if (canvas.height !== H) canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (ctx) drawDesign(ctx, design, W, H, photo);
}

/** The id of the topmost text under a point given in frame pixels (for click / drag in the designer), if any. */
export function hitTestDesign(design: SlideDesign, W: number, H: number, x: number, y: number): string | null {
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return null;
  const measure = measureWith(ctx);
  const pad = Math.round(Math.min(W, H) * 0.015);
  for (let i = design.texts.length - 1; i >= 0; i--) {
    const t = design.texts[i];
    if (!t.text.trim()) continue;
    const { box } = layoutText(t, W, H, measure);
    if (x >= box.x - pad && x <= box.x + box.w + pad && y >= box.y - pad && y <= box.y + box.h + pad) return t.id;
  }
  return null;
}

/** The finished card as a JPEG data URL at exactly W x H, ready to send to the exporter. Throws if the canvas is unavailable. */
export async function renderDesignToDataUrl(design: SlideDesign, W: number, H: number, photoUrl?: string): Promise<string> {
  const photo = design.background.kind === 'photo' && photoUrl ? await loadImage(photoUrl) : null;
  if (design.background.kind === 'photo' && photoUrl && !photo) throw new Error('The background photo could not be loaded (its storage may be offline).');
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This computer could not create the title-screen image.');
  drawDesign(ctx, design, W, H, photo);
  return canvas.toDataURL('image/jpeg', 0.92);
}
