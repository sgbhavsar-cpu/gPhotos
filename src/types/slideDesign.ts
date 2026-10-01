// The model behind the wizard's Title-screen / End-credits designer, plus the pure layout that keeps
// every line of text INSIDE the video frame. No I/O and no canvas here: text is measured through a
// function the caller supplies (the renderer passes canvas.measureText; tests pass a fake), so the
// preview and the final full-size render use the very same layout code and cannot disagree.

export const FONT_FAMILIES = [
  'Arial',
  'Helvetica',
  'Verdana',
  'Trebuchet MS',
  'Segoe UI',
  'Georgia',
  'Times New Roman',
  'Palatino Linotype',
  'Courier New',
  'Impact',
  'Comic Sans MS',
  'Brush Script MT',
] as const;

export interface DesignText {
  id: string;
  /** May contain line breaks. */
  text: string;
  fontFamily: string;
  /** Font size as a percentage of the frame's SHORTER side: the same on a 720p preview and a 1080p render, and a portrait (9:16) video gets the same text size as a square one instead of a huge one. */
  sizePct: number;
  color: string;
  bold: boolean;
  italic: boolean;
  align: 'left' | 'center' | 'right';
  /** Centre of the text block, as a percentage of the frame width / height. */
  xPct: number;
  yPct: number;
  /** Widest a line may be, as a percentage of the frame width (default 86). */
  widthPct?: number;
  shadow: boolean;
}

export type DesignBackground =
  | { kind: 'gradient'; from: string; to: string }
  | { kind: 'solid'; color: string }
  | { kind: 'photo'; photoId: string; /** 0 (untouched) .. 0.85 (nearly black) — keeps text readable over a busy photo. */ dim: number };

export interface SlideDesign {
  background: DesignBackground;
  texts: DesignText[];
  /** How long the card stays on screen. */
  seconds: number;
}

export interface FontSpec {
  family: string;
  px: number;
  bold: boolean;
  italic: boolean;
}

/** CSS `font` shorthand for a spec, e.g. `italic bold 64px "Georgia", sans-serif`. */
export function cssFont(f: FontSpec): string {
  return `${f.italic ? 'italic ' : ''}${f.bold ? 'bold ' : ''}${Math.max(1, Math.round(f.px))}px "${f.family}", sans-serif`;
}

export type MeasureFn = (font: FontSpec, text: string) => number;

const LINE_HEIGHT = 1.22;
const MIN_FONT_PX = 6;

/** Greedy word wrap to `maxWidth`; a single word wider than the line is broken by characters. */
export function wrapText(text: string, maxWidth: number, measure: (s: string) => number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    if (paragraph.trim() === '') { lines.push(''); continue; }
    let current = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = current ? current + ' ' + word : word;
      if (measure(candidate) <= maxWidth) { current = candidate; continue; }
      if (current) { lines.push(current); current = ''; }
      if (measure(word) <= maxWidth) { current = word; continue; }
      // one very long word: split it across lines rather than let it run off the frame
      let chunk = '';
      for (const ch of word) {
        if (chunk && measure(chunk + ch) > maxWidth) { lines.push(chunk); chunk = ch; } else chunk += ch;
      }
      current = chunk;
    }
    lines.push(current);
  }
  return lines;
}

export interface TextLayout {
  lines: string[];
  font: FontSpec;
  lineHeightPx: number;
  /** The text block's box in frame pixels (also what the designer hit-tests a click against). */
  box: { x: number; y: number; w: number; h: number };
  /** Per-line x anchor for the chosen alignment, with the matching canvas `textAlign`. */
  lineX: number[];
  textAlign: 'left' | 'center' | 'right';
}

/**
 * Lays one text out in a `frameW` x `frameH` frame. The font is shrunk (up to a floor) until the wrapped
 * block fits — its lines within the allowed width and the whole block within the frame — and the block is
 * then nudged so it never crosses the frame edge, wherever it was placed.
 */
export function layoutText(t: DesignText, frameW: number, frameH: number, measure: MeasureFn): TextLayout {
  const margin = Math.round(Math.min(frameW, frameH) * 0.04);
  const maxW = Math.min(frameW - margin * 2, (frameW * (t.widthPct ?? 86)) / 100);
  const maxH = frameH - margin * 2;

  let px = Math.max(MIN_FONT_PX, (t.sizePct / 100) * Math.min(frameW, frameH));
  let font: FontSpec = { family: t.fontFamily, px, bold: t.bold, italic: t.italic };
  let lines: string[] = [];
  let widest = 0;
  for (let attempt = 0; attempt < 40; attempt++) {
    font = { family: t.fontFamily, px, bold: t.bold, italic: t.italic };
    const m = (s: string) => measure(font, s);
    lines = wrapText(t.text, maxW, m);
    widest = Math.max(0, ...lines.map(m));
    const blockH = lines.length * px * LINE_HEIGHT;
    if ((widest <= maxW + 0.5 && blockH <= maxH) || px <= MIN_FONT_PX) break;
    px = Math.max(MIN_FONT_PX, px * 0.92);
  }

  const lineHeightPx = px * LINE_HEIGHT;
  const w = Math.min(maxW, Math.max(widest, 1));
  const h = Math.min(maxH, lines.length * lineHeightPx);
  const x = Math.min(Math.max((t.xPct / 100) * frameW - w / 2, margin), Math.max(margin, frameW - margin - w));
  const y = Math.min(Math.max((t.yPct / 100) * frameH - h / 2, margin), Math.max(margin, frameH - margin - h));

  const lineX = lines.map(() => (t.align === 'left' ? x : t.align === 'right' ? x + w : x + w / 2));
  return { lines, font, lineHeightPx, box: { x, y, w, h }, lineX, textAlign: t.align };
}

let counter = 0;
export const newTextId = () => `t_${Date.now().toString(36)}_${(counter++).toString(36)}`;

export function makeText(over: Partial<DesignText> = {}): DesignText {
  return {
    id: newTextId(), text: 'Your text', fontFamily: 'Arial', sizePct: 6, color: '#ffffff', bold: true, italic: false,
    align: 'center', xPct: 50, yPct: 50, shadow: true, ...over,
  };
}

const DARK_GRADIENT: DesignBackground = { kind: 'gradient', from: '#1e293b', to: '#0f172a' };

export function defaultTitleDesign(title: string, subtitle?: string): SlideDesign {
  const texts = [makeText({ text: title || 'Untitled', sizePct: 8, yPct: subtitle ? 44 : 50 })];
  if (subtitle) texts.push(makeText({ text: subtitle, sizePct: 3.8, bold: false, color: '#94a3b8', yPct: 57, shadow: false }));
  return { background: DARK_GRADIENT, texts, seconds: 4 };
}

export function defaultCreditsDesign(albumTitle: string): SlideDesign {
  return {
    background: DARK_GRADIENT,
    texts: [
      makeText({ text: 'Thank you for watching', sizePct: 6.5, yPct: 38 }),
      makeText({ text: albumTitle, sizePct: 4, bold: false, color: '#cbd5e1', yPct: 51, shadow: false }),
      makeText({ text: 'Made with gPhotos', sizePct: 2.8, bold: false, italic: true, color: '#64748b', yPct: 90, shadow: false }),
    ],
    seconds: 5,
  };
}
