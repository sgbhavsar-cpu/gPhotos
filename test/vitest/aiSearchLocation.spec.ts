import { describe, it, expect, beforeEach } from 'vitest';
import { aiSearchService } from '../../src/renderer/src/services/aiSearchService';
import type { Photo, Person } from '../../src/types';

const photo = (n: number, over: Partial<Photo> = {}): Photo => ({
  id: `p${n}`, filePath: `C:\\IMG_${n}.jpg`, fileName: `IMG_${n}.jpg`, fileSize: 1,
  dateTaken: '2026-01-01', year: 2026, month: 1, day: 1, ...over,
}) as any;

const person = (id: string, name: string): Person => ({ id, name, faceCount: 1, photoCount: 1, createdAt: 'x' });

describe('AI search: location matching (the "#place" autocomplete bug)', () => {
  const udaipur1 = photo(1, { location: { latitude: 24.58, longitude: 73.68, city: 'Udaipur', country: 'India' } });
  const udaipur2 = photo(2, { location: { latitude: 24.6, longitude: 73.7, city: 'Udaipur', country: 'India' } });
  const mumbai = photo(3, { location: { latitude: 19.07, longitude: 72.87, city: 'Mumbai', country: 'India' } });
  const goa = photo(4, { location: { latitude: 15.29, longitude: 74.12, city: 'Goa', country: 'India' } }); // same country, different city
  const noLocation = photo(5);
  const photos = [udaipur1, udaipur2, mumbai, goa, noLocation];
  const people: Person[] = [person('u1', 'Sachin Bhavsar')];

  beforeEach(() => {
    // Force the local (no cloud provider) path, exactly like a fresh install with nothing configured.
    aiSearchService.saveConfig({ provider: 'local', geminiApiKey: '', openaiApiKey: '' });
  });

  describe('smartLocalNlp: detecting the place', () => {
    it('a bare "#place" mention with no preposition — exactly what the autocomplete inserts — is still recognised', () => {
      const filter = aiSearchService.smartLocalNlp('Photo of Udaipur, India', people, photos);
      expect(filter.locationQuery).toBe('Udaipur'); // the library's own clean value, not the raw "Udaipur, India" text
    });

    it('the older "in <place>" phrasing still works, and now also picks up the library\'s own casing', () => {
      const filter = aiSearchService.smartLocalNlp('Photo of sachin in andaman', people, [
        photo(9, { location: { latitude: 11, longitude: 92, city: undefined, country: undefined, label: 'Andaman' } }),
      ]);
      expect(filter.locationQuery).toBe('Andaman');
    });

    it('falls back to the raw preposition phrase for a place not yet in the library at all', () => {
      const filter = aiSearchService.smartLocalNlp('Photo of sachin in narnia', people, photos);
      expect(filter.locationQuery).toBe('narnia');
    });

    it('a location combined with a person mention resolves both', () => {
      const filter = aiSearchService.smartLocalNlp('Sachin Bhavsar Udaipur, India', people, photos);
      expect(filter.locationQuery).toBe('Udaipur');
      expect(filter.peopleMustInclude).toEqual(['Sachin Bhavsar']);
    });

    it('a place name is not mistaken for a person even when phrased plainly', () => {
      const filter = aiSearchService.smartLocalNlp('Goa photos', people, photos);
      expect(filter.locationQuery).toBe('Goa');
    });

    // Reported bug: searching "#andaman" (the autocomplete inserts the library's own "Andaman,
    // India" text) resolved to the country "India" instead of the specific "Andaman" — returning
    // ~15,000 photos (every India photo) with "India" as the shown place. Reproduced here by putting
    // OTHER India photos first, so "India" lands in the known-values set before "Andaman" ever does
    // — exactly the data-order dependency that made this intermittent in a real library.
    it('a renamed place is never shadowed by its own country, regardless of which photo the app happened to see first', () => {
      const mumbaiFirst = photo(10, { location: { latitude: 19.07, longitude: 72.87, city: 'Mumbai', country: 'India' } });
      const goaSecond = photo(11, { location: { latitude: 15.29, longitude: 74.12, city: 'Goa', country: 'India' } });
      const andaman = photo(12, { location: { latitude: 11.6, longitude: 92.7, city: 'Andaman', country: 'India', label: 'Andaman' } });
      const libraryPhotos = [mumbaiFirst, goaSecond, andaman]; // "India" seen twice before "Andaman"

      const filter = aiSearchService.smartLocalNlp('Photo of sachin at Andaman, India', people, libraryPhotos);
      expect(filter.locationQuery).toBe('Andaman');

      const result = aiSearchService.applyFilter(filter, libraryPhotos, people);
      expect(result.map((p) => p.id)).toEqual(['p12']); // not all 3 India photos
    });
  });

  describe('applyFilter: a combined "City, Country" query against per-field photo data', () => {
    it('matches only photos in that exact city, not just anywhere in the country', () => {
      const result = aiSearchService.applyFilter({ queryText: '', explanation: '', locationQuery: 'Udaipur, India' }, photos, people);
      expect(result.map((p) => p.id).sort()).toEqual(['p1', 'p2']);
    });

    it('a single bare place name still matches as before', () => {
      const result = aiSearchService.applyFilter({ queryText: '', explanation: '', locationQuery: 'Mumbai' }, photos, people);
      expect(result.map((p) => p.id)).toEqual(['p3']);
    });

    it('requires every comma-separated part, so a right-country-wrong-city combo excludes it', () => {
      const result = aiSearchService.applyFilter({ queryText: '', explanation: '', locationQuery: 'Chennai, India' }, photos, people);
      expect(result).toEqual([]);
    });

    it('a photo with no location data at all is excluded', () => {
      const result = aiSearchService.applyFilter({ queryText: '', explanation: '', locationQuery: 'Udaipur' }, photos, people);
      expect(result.find((p) => p.id === 'p5')).toBeUndefined();
    });
  });

  describe('end-to-end through search() on the local (no cloud provider) path', () => {
    it('reproduces the reported scenario: picking "Udaipur, India" from the # list finds only Udaipur photos', async () => {
      const res = await aiSearchService.search('Photo of Udaipur, India', photos, people);
      expect(res.matchedPhotos.map((p) => p.id).sort()).toEqual(['p1', 'p2']);
      expect(res.filter.locationQuery).toBe('Udaipur');
    });
  });
});
