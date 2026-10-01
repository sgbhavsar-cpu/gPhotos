// Pulls exact coordinates straight out of a pasted Google Maps link, instead of asking OpenStreetMap's
// Nominatim to guess a place from a typed name — precise, and needs no network call for a long/full URL.
export interface ParsedMapsLocation {
  lat: number;
  lng: number;
}

const isFiniteLatLng = (lat: number, lng: number) =>
  Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

/** True for a Google-owned host: google.<tld> (any ccTLD), maps.google.com, goo.gl, g.co, maps.app.goo.gl. */
export function isGoogleMapsUrl(url: string): boolean {
  try {
    const host = new URL(url.trim()).hostname.toLowerCase();
    return /(^|\.)google\.[a-z.]+$/.test(host) || /(^|\.)goo\.gl$/.test(host) || host === 'g.co';
  } catch {
    return false;
  }
}

/** A shortened link (maps.app.goo.gl, goo.gl/maps/…, g.co/…) that has no coordinates of its own — it
 *  has to be resolved (followed) to its real, long destination URL before it can be parsed. */
export function isShortGoogleMapsUrl(url: string): boolean {
  try {
    const host = new URL(url.trim()).hostname.toLowerCase();
    return host === 'maps.app.goo.gl' || host === 'goo.gl' || host === 'g.co';
  } catch {
    return false;
  }
}

/**
 * Extracts lat/lng from an already-resolved (long) Google Maps URL. Tries, in order of precision:
 *  1. `!3d<lat>!4d<lng>` inside `data=…` — the actual marker/place position, which can differ from
 *     the map's own center (e.g. a place card open over a panned map);
 *  2. `@<lat>,<lng>,<zoom>z` — the map view's center;
 *  3. a `q=`, `query=` or `ll=` parameter of the form `<lat>,<lng>`.
 * Returns null when the URL isn't a Google Maps link, or none of these are present (e.g. it only
 * names a place with no coordinates at all, or is still a short link — see isShortGoogleMapsUrl).
 */
export function parseGoogleMapsUrl(url: string): ParsedMapsLocation | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  if (!isGoogleMapsUrl(url)) return null;

  const whole = u.pathname + u.search + u.hash;
  const marker = /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/.exec(whole);
  if (marker) {
    const lat = parseFloat(marker[1]);
    const lng = parseFloat(marker[2]);
    if (isFiniteLatLng(lat, lng)) return { lat, lng };
  }

  const center = /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(whole);
  if (center) {
    const lat = parseFloat(center[1]);
    const lng = parseFloat(center[2]);
    if (isFiniteLatLng(lat, lng)) return { lat, lng };
  }

  for (const key of ['q', 'query', 'll']) {
    const v = u.searchParams.get(key);
    const m = v && /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/.exec(v.trim());
    if (m) {
      const lat = parseFloat(m[1]);
      const lng = parseFloat(m[2]);
      if (isFiniteLatLng(lat, lng)) return { lat, lng };
    }
  }

  return null;
}
