import { describe, it, expect } from 'vitest';
import { isGoogleMapsUrl, isShortGoogleMapsUrl, parseGoogleMapsUrl } from '../../src/renderer/src/services/googleMapsUrl';

describe('isGoogleMapsUrl', () => {
  it.each([
    'https://www.google.com/maps/@24.57,73.69,15z',
    'https://google.com/maps',
    'https://maps.google.com/?q=1,2',
    'https://www.google.co.in/maps',
    'https://www.google.de/maps',
    'https://goo.gl/maps/abc',
    'https://maps.app.goo.gl/abc',
    'https://g.co/maps/abc',
  ])('accepts %s', (u) => expect(isGoogleMapsUrl(u)).toBe(true));

  it.each([
    'https://www.bing.com/maps?q=1,2',
    'https://notgoogle.com/maps',
    'https://evilgoogle.com.attacker.net/maps',
    'not a url',
    '',
  ])('rejects %s', (u) => expect(isGoogleMapsUrl(u)).toBe(false));
});

describe('isShortGoogleMapsUrl', () => {
  it('flags only the shortened hosts, not the full maps.google.com domain', () => {
    expect(isShortGoogleMapsUrl('https://maps.app.goo.gl/abc')).toBe(true);
    expect(isShortGoogleMapsUrl('https://goo.gl/maps/abc')).toBe(true);
    expect(isShortGoogleMapsUrl('https://g.co/maps/abc')).toBe(true);
    expect(isShortGoogleMapsUrl('https://www.google.com/maps/@1,2,3z')).toBe(false);
  });
});

describe('parseGoogleMapsUrl', () => {
  it('reads the map center from an "@lat,lng,zoom" path', () => {
    expect(parseGoogleMapsUrl('https://www.google.com/maps/@24.5713934,73.6905743,15z')).toEqual({ lat: 24.5713934, lng: 73.6905743 });
  });

  it('prefers the precise "!3d..!4d.." place marker over the "@" map center when both are present', () => {
    const url = 'https://www.google.com/maps/place/Lake+Palace/@24.5757,73.6802,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d24.575699!4d73.680278!16s%2Fg%2F1';
    expect(parseGoogleMapsUrl(url)).toEqual({ lat: 24.575699, lng: 73.680278 });
  });

  it('reads a "q=lat,lng" query parameter', () => {
    expect(parseGoogleMapsUrl('https://maps.google.com/?q=24.571393,73.690574')).toEqual({ lat: 24.571393, lng: 73.690574 });
  });

  it('reads an "ll=lat,lng" query parameter', () => {
    expect(parseGoogleMapsUrl('https://www.google.co.in/maps?ll=24.571393,73.690574&z=15')).toEqual({ lat: 24.571393, lng: 73.690574 });
  });

  it('handles negative coordinates (southern/western hemisphere)', () => {
    expect(parseGoogleMapsUrl('https://www.google.com/maps/@-33.8688,151.2093,12z')).toEqual({ lat: -33.8688, lng: 151.2093 });
  });

  it('returns null for a non-Google URL, even one with a q=lat,lng that looks the same shape', () => {
    expect(parseGoogleMapsUrl('https://www.bing.com/maps?q=24.57,73.69')).toBeNull();
  });

  it('returns null for a Google Maps URL with no coordinates in it (a place search with no pin yet)', () => {
    expect(parseGoogleMapsUrl('https://www.google.com/maps/place/Somewhere+Unresolved')).toBeNull();
  });

  it('returns null for a shortened link — it has no coordinates until resolved', () => {
    expect(parseGoogleMapsUrl('https://maps.app.goo.gl/8sJvQ2xQwertY')).toBeNull();
  });

  it('returns null for garbage input instead of throwing', () => {
    expect(parseGoogleMapsUrl('not a url at all')).toBeNull();
    expect(parseGoogleMapsUrl('')).toBeNull();
  });

  it('rejects an out-of-range "coordinate" that only looks like one (e.g. a version/build number in the path)', () => {
    expect(parseGoogleMapsUrl('https://www.google.com/maps/@999.9,999.9,15z')).toBeNull();
  });
});
