import { describe, it, expect } from 'vitest';
import { matchesPlaceQuery } from '../../src/renderer/src/services/placesService';

// The Places map's search box (PlacesMapView.tsx) narrows pins down to this predicate.
describe('matchesPlaceQuery', () => {
  it('an empty query matches everything, including a photo with no location at all', () => {
    expect(matchesPlaceQuery(undefined, '')).toBe(true);
    expect(matchesPlaceQuery({ latitude: 1, longitude: 1, city: 'Udaipur' }, '  ')).toBe(true);
  });

  it('matches by city, country, or a custom label, case-insensitively', () => {
    expect(matchesPlaceQuery({ latitude: 1, longitude: 1, city: 'Udaipur', country: 'India' }, 'udai')).toBe(true);
    expect(matchesPlaceQuery({ latitude: 1, longitude: 1, city: 'Udaipur', country: 'India' }, 'INDIA')).toBe(true);
    expect(matchesPlaceQuery({ latitude: 1, longitude: 1, label: 'Andaman' }, 'andaman')).toBe(true);
  });

  it('a non-matching query excludes the photo', () => {
    expect(matchesPlaceQuery({ latitude: 1, longitude: 1, city: 'Udaipur', country: 'India' }, 'paris')).toBe(false);
  });

  it('a photo with no location never matches a non-empty query', () => {
    expect(matchesPlaceQuery(undefined, 'udaipur')).toBe(false);
  });
});
