import { describe, it, expect } from 'vitest';
import { groupPhotosByPlace } from '../../src/renderer/src/services/placesService';
import type { Photo } from '../../src/types';

const photo = (n: number, location: Photo['location']): Photo =>
  ({ id: `p${n}`, filePath: `C:\\p${n}.jpg`, fileName: `p${n}.jpg`, fileSize: 1,
     dateTaken: '2026-01-01', year: 2026, month: 1, day: 1, location }) as any;

// Reported bug: renaming a cluster of photos to "Andaman" (handleSaveClusterLocationName sets
// label + city, but deliberately leaves the geographically-correct country alone) still showed up
// everywhere as "Andaman, India" — because this function only ever derived its display name from
// city+country and never looked at the custom label meant to override them.
describe('groupPhotosByPlace: a custom label always wins over the auto-derived "City, Country" name', () => {
  it('uses the plain label, not "City, Country", once one is set', () => {
    const photos = [
      photo(1, { latitude: 11.6, longitude: 92.7, city: 'Andaman', country: 'India', label: 'Andaman' }),
      photo(2, { latitude: 11.7, longitude: 92.8, city: 'Andaman', country: 'India', label: 'Andaman' }),
    ];
    const [place] = groupPhotosByPlace(photos);
    expect(place.name).toBe('Andaman');
    expect(place.photoCount).toBe(2); // still grouped together, just displayed differently
  });

  it('still falls back to "City, Country" exactly as before when no label is set', () => {
    const photos = [photo(1, { latitude: 24.5, longitude: 73.6, city: 'Udaipur', country: 'India' })];
    expect(groupPhotosByPlace(photos)[0].name).toBe('Udaipur, India');
  });

  it('a label on just the city-only case (no country) also wins', () => {
    const photos = [photo(1, { latitude: 1, longitude: 1, city: 'Somewhere', label: "Grandma's House" })];
    expect(groupPhotosByPlace(photos)[0].name).toBe("Grandma's House");
  });

  it('an empty/whitespace-only label is treated as no label at all', () => {
    const photos = [photo(1, { latitude: 24.5, longitude: 73.6, city: 'Udaipur', country: 'India', label: '   ' })];
    expect(groupPhotosByPlace(photos)[0].name).toBe('Udaipur, India');
  });

  it('two photos at the same place with different labels still group together, keeping one name', () => {
    const photos = [
      photo(1, { latitude: 11.6, longitude: 92.7, city: 'Andaman', country: 'India', label: 'Andaman' }),
      photo(2, { latitude: 11.6, longitude: 92.7, city: 'Andaman', country: 'India' }), // never renamed
    ];
    const places = groupPhotosByPlace(photos);
    expect(places).toHaveLength(1); // grouping key is still city+country, unaffected by the label
    expect(places[0].photoCount).toBe(2);
  });
});
