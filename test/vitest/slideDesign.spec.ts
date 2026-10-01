import { describe, it, expect } from 'vitest';
import {
  wrapText, layoutText, makeText, cssFont, defaultTitleDesign, defaultCreditsDesign,
  type MeasureFn,
} from '../../src/types/slideDesign';
import { computeDimensions } from '../../src/types/videoFormat';

// A stand-in for canvas.measureText: every character is 0.55 em wide (bold a little wider).
const measure: MeasureFn = (f, s) => s.length * f.px * (f.bold ? 0.6 : 0.55);

describe('wrapText', () => {
  const m = (s: string) => s.length * 10;

  it('wraps on spaces so no line is wider than the limit', () => {
    const lines = wrapText('the quick brown fox jumps over the lazy dog', 120, m);
    expect(lines.every((l) => m(l) <= 120)).toBe(true);
    expect(lines.join(' ')).toBe('the quick brown fox jumps over the lazy dog');
  });

  it('keeps explicit line breaks (and blank lines)', () => {
    expect(wrapText('one\n\ntwo', 500, m)).toEqual(['one', '', 'two']);
  });

  it('breaks a single word that is wider than the whole line instead of letting it run off', () => {
    const lines = wrapText('supercalifragilisticexpialidocious', 100, m);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((l) => m(l) <= 100)).toBe(true);
    expect(lines.join('')).toBe('supercalifragilisticexpialidocious');
  });
});

describe('layoutText — text always stays inside the frame', () => {
  const inside = (b: { x: number; y: number; w: number; h: number }, W: number, H: number) =>
    b.x >= 0 && b.y >= 0 && b.x + b.w <= W + 0.5 && b.y + b.h <= H + 0.5;

  it('a long title on a VERTICAL 1080x1920 video wraps within the width (the reported bug)', () => {
    const t = makeText({ text: 'Sachin & Monika — Wedding Celebrations in Udaipur 2026', sizePct: 8 });
    const layout = layoutText(t, 1080, 1920, measure);
    expect(layout.lines.length).toBeGreaterThan(1);
    expect(inside(layout.box, 1080, 1920)).toBe(true);
    for (const line of layout.lines) expect(measure(layout.font, line)).toBeLessThanOrEqual(1080 * 0.86 + 0.5);
  });

  it('the old failure mode — one unwrapped line at 7.5% of height — would have been far wider than the frame', () => {
    const title = 'Sachin & Monika — Wedding Celebrations in Udaipur 2026';
    const unwrapped = title.length * 0.075 * 1920 * 0.6;
    expect(unwrapped).toBeGreaterThan(1080); // i.e. it really did overflow a vertical frame
  });

  it('shrinks the font when the text cannot fit at the requested size (huge text, small frame)', () => {
    const t = makeText({ text: 'A fairly long line of text that needs many rows', sizePct: 40 });
    const layout = layoutText(t, 720, 720, measure);
    expect(layout.font.px).toBeLessThan(0.4 * 720);
    expect(inside(layout.box, 720, 720)).toBe(true);
  });

  it.each([[1920, 1080], [1080, 1920], [1080, 1080], [1440, 1080]])('%ix%i: a block placed at every edge and corner is pulled back inside', (W, H) => {
    for (const [x, y] of [[0, 0], [100, 0], [0, 100], [100, 100], [50, 50], [-30, 130]]) {
      const layout = layoutText(makeText({ text: 'Corner text here', xPct: x, yPct: y }), W, H, measure);
      expect(inside(layout.box, W, H)).toBe(true);
    }
  });

  it('alignment picks the per-line x anchor within the block', () => {
    const base = { text: 'hello world', xPct: 50, yPct: 50 };
    const left = layoutText(makeText({ ...base, align: 'left' }), 1000, 1000, measure);
    const center = layoutText(makeText({ ...base, align: 'center' }), 1000, 1000, measure);
    const right = layoutText(makeText({ ...base, align: 'right' }), 1000, 1000, measure);
    expect(left.lineX[0]).toBe(left.box.x);
    expect(center.lineX[0]).toBeCloseTo(center.box.x + center.box.w / 2, 5);
    expect(right.lineX[0]).toBeCloseTo(right.box.x + right.box.w, 5);
    expect(left.textAlign).toBe('left');
  });

  it('the size is a percentage of the SHORT side, so it scales between a preview and the real render', () => {
    const t = makeText({ text: 'Hi', sizePct: 10 });
    const small = layoutText(t, 320, 180, measure);
    const big = layoutText(t, 1920, 1080, measure);
    expect(big.font.px / small.font.px).toBeCloseTo(1080 / 180, 5);
  });

  it('a portrait frame gets the same text size as a square one (not a size based on its long side)', () => {
    const t = makeText({ text: 'Hi', sizePct: 8 });
    expect(layoutText(t, 1080, 1920, measure).font.px).toBeCloseTo(layoutText(t, 1080, 1080, measure).font.px, 5);
  });

  it('a respected widthPct narrows the wrap width', () => {
    const wide = layoutText(makeText({ text: 'one two three four five six seven', sizePct: 5 }), 1000, 1000, measure);
    const narrow = layoutText(makeText({ text: 'one two three four five six seven', sizePct: 5, widthPct: 30 }), 1000, 1000, measure);
    expect(narrow.lines.length).toBeGreaterThan(wide.lines.length);
  });
});

describe('defaults and helpers', () => {
  it('cssFont builds a canvas font string', () => {
    expect(cssFont({ family: 'Georgia', px: 63.6, bold: true, italic: true })).toBe('italic bold 64px "Georgia", sans-serif');
  });

  it('default title/credits designs fit every output size', () => {
    for (const ar of ['16:9', '9:16', '1:1', '4:3'] as const) {
      const { width, height } = computeDimensions(ar, '1080p');
      for (const design of [defaultTitleDesign('A really quite long album title that goes on and on', 'A subtitle'), defaultCreditsDesign('Trip')]) {
        for (const t of design.texts) {
          const l = layoutText(t, width, height, measure);
          expect(l.box.x).toBeGreaterThanOrEqual(0);
          expect(l.box.x + l.box.w).toBeLessThanOrEqual(width + 0.5);
          expect(l.box.y + l.box.h).toBeLessThanOrEqual(height + 0.5);
        }
      }
    }
  });

  it('a title design has a subtitle line only when given one', () => {
    expect(defaultTitleDesign('T').texts).toHaveLength(1);
    expect(defaultTitleDesign('T', 'S').texts).toHaveLength(2);
    expect(defaultTitleDesign('T').seconds).toBeGreaterThan(0);
  });
});
