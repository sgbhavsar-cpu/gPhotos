// Small pure helpers for the video wizard: the automatic lower-third caption of a slide (place, date, people, chapter)
// and where "follow the faces" should aim. Kept out of the component so they can be tested on their own.
import type { Photo, Person } from '../../../types';

export interface CaptionOptions {
  place: boolean;
  date: boolean;
  people: boolean;
  chapter: boolean;
}

export const NO_CAPTIONS: CaptionOptions = { place: false, date: false, people: false, chapter: false };

const isPlaceholderName = (n: string) => /^Person(\s+\d+)?$/i.test(n.trim());

/** "Baga, Goa · 14 Mar 2025 · Riya, Aman · Day 2" — only the parts switched on and actually known. */
export function buildAutoCaption(photo: Photo | undefined, people: Person[], chapterTitle: string | null | undefined, opts: CaptionOptions): string {
  if (!photo) return '';
  const parts: string[] = [];
  if (opts.chapter && chapterTitle?.trim()) parts.push(chapterTitle.trim());
  if (opts.place) {
    const l = photo.location;
    const place = l?.label?.trim() || [l?.city, l?.state || l?.country].filter((x): x is string => !!x && x.trim() !== '').join(', ');
    if (place) parts.push(place);
  }
  if (opts.date) {
    const d = new Date(photo.dateTaken || photo.fileDate || '');
    if (!isNaN(d.getTime()) && d.getFullYear() > 1971) parts.push(d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }));
  }
  if (opts.people) {
    const byId = new Map(people.map((p) => [p.id, p.name]));
    const names = Array.from(new Set((photo.faces || []).map((f) => (f.personId ? byId.get(f.personId) : undefined)).filter((n): n is string => !!n && !isPlaceholderName(n))));
    if (names.length) parts.push(names.slice(0, 4).join(', ') + (names.length > 4 ? ` +${names.length - 4}` : ''));
  }
  return parts.join(' · ');
}

/** Centre of the people in the photo as fractions of the picture (0..1), or undefined when no face has a usable box. */
export function faceFocus(photo: Photo | undefined): { x: number; y: number } | undefined {
  const boxes = (photo?.faces || []).filter((f) => f.box && f.imageWidth && f.imageHeight && f.box.width > 0 && f.box.height > 0);
  if (!boxes.length) return undefined;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const f of boxes) {
    const w = f.imageWidth!, h = f.imageHeight!;
    x0 = Math.min(x0, f.box.x / w); y0 = Math.min(y0, f.box.y / h);
    x1 = Math.max(x1, (f.box.x + f.box.width) / w); y1 = Math.max(y1, (f.box.y + f.box.height) / h);
  }
  return { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
}
