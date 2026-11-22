/** A capture date embedded in a file name (20240608_165442000_iOS, IMG-20240727-WA0042, 2024-06-08 16.54.42) — local time. Pure: shared by main and renderer. */
export function parseDateFromFileName(name: string): { date: Date; hasTime: boolean } | null {
  const base = name.split(/[\/]/).pop() || name;
  const m = base.match(/(?<!\d)((?:19|20)\d{2})[-_. ]?(0[1-9]|1[0-2])[-_. ]?(0[1-9]|[12]\d|3[01])(?:[-_ T.]?([01]\d|2[0-3])[-_.:]?([0-5]\d)[-_.:]?([0-5]\d)(?:\d{3})?)?(?!\d)/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const date = new Date(+y, +mo - 1, +d, h ? +h : 12, mi ? +mi : 0, s ? +s : 0);
  return isNaN(date.getTime()) || date.getTime() > Date.now() + 86_400_000 ? null : { date, hasTime: !!h };
}

export const dateFromFileName = (name: string): Date | null => parseDateFromFileName(name)?.date ?? null;
