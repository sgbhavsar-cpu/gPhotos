import { describe, it, expect, beforeEach } from 'vitest';
import { aiSearchService } from '../../src/renderer/src/services/aiSearchService';
import type { Photo, Person } from '../../src/types';

const photo = (n: number, over: Partial<Photo> = {}): Photo => ({
  id: `p${n}`, filePath: `C:\\IMG_${n}.jpg`, fileName: `IMG_${n}.jpg`, fileSize: 1,
  dateTaken: '2026-01-01', year: 2026, month: 1, day: 1, ...over,
}) as any;

const person = (id: string, name: string): Person => ({ id, name, faceCount: 1, photoCount: 1, createdAt: 'x' });

describe('AI search: "only" exclusivity and "but not" exclusion', () => {
  const monika = person('monika', 'Monika');
  const raji = person('raji', 'Raji');
  const stavan = person('stavan', 'Stavan');
  const stuti = person('stuti', 'Stuti');
  const people = [monika, raji, stavan, stuti];

  // monikaAlone: just monika. monikaAndRaji: both. monikaAndandaman: monika, at andaman.
  const monikaAlone = photo(1, { faces: [{ personId: 'monika' }] as any });
  const monikaAndRaji = photo(2, { faces: [{ personId: 'monika' }, { personId: 'raji' }] as any });
  const stavanStutiOnly = photo(3, { faces: [{ personId: 'stavan' }, { personId: 'stuti' }] as any });
  const stavanStutiAndMonika = photo(4, { faces: [{ personId: 'stavan' }, { personId: 'stuti' }, { personId: 'monika' }] as any });
  const monikaAtAndaman = photo(5, {
    faces: [{ personId: 'monika' }] as any,
    location: { latitude: 11.6, longitude: 92.7, city: 'Andaman', country: 'India', label: 'Andaman' },
  });
  const photos = [monikaAlone, monikaAndRaji, stavanStutiOnly, stavanStutiAndMonika, monikaAtAndaman];

  beforeEach(() => {
    aiSearchService.saveConfig({ provider: 'local', geminiApiKey: '', openaiApiKey: '' });
  });

  it('"Only photo of monika at #andaman" combines exclusivity with a location, instead of dropping the location', () => {
    const filter = aiSearchService.smartLocalNlp('Only photo of monika at Andaman, India', people, photos);
    expect(filter.peopleMustInclude).toEqual(['Monika']);
    expect(filter.peopleExactOnly).toBe(true);
    expect(filter.locationQuery).toBe('Andaman');

    const result = aiSearchService.applyFilter(filter, photos, people);
    expect(result.map((p) => p.id)).toEqual(['p5']); // monika alone, AND at andaman
  });

  it('"Photo of stavan and stuti only" excludes a photo where a third person (monika) is also present', () => {
    const filter = aiSearchService.smartLocalNlp('Photo of stavan and stuti only', people, photos);
    expect(filter.peopleMustInclude?.slice().sort()).toEqual(['Stavan', 'Stuti']);
    expect(filter.peopleExactOnly).toBe(true);

    const result = aiSearchService.applyFilter(filter, photos, people);
    expect(result.map((p) => p.id)).toEqual(['p3']); // not p4, which also has monika
  });

  it('"photo of monika but not raji" excludes any photo where raji also appears', () => {
    const filter = aiSearchService.smartLocalNlp('photo of monika but not raji', people, photos);
    expect(filter.peopleMustInclude).toEqual(['Monika']);
    expect(filter.peopleMustExclude).toEqual(['Raji']);

    const result = aiSearchService.applyFilter(filter, photos, people);
    const ids = result.map((p) => p.id);
    expect(ids).toContain('p1'); // monika alone
    expect(ids).toContain('p5'); // monika at andaman
    expect(ids).not.toContain('p2'); // monika AND raji together
  });

  it('a plain "alone" query still returns its own friendly explanation', () => {
    const filter = aiSearchService.smartLocalNlp('Photo of monika alone', people, photos);
    expect(filter.alonePersonName).toBe('Monika');
    expect(filter.explanation).toContain('solo photos of Monika alone');
  });
});
