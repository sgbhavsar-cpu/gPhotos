import { describe, it, expect } from 'vitest';
import { buildAutoCaption, faceFocus, NO_CAPTIONS } from '../../src/renderer/src/services/videoCaption';

const photo: any = {
  id: 'p', filePath: 'x.jpg', fileName: 'x.jpg', dateTaken: '2025-03-14T10:00:00Z',
  location: { latitude: 15.5, longitude: 73.7, city: 'Baga', state: 'Goa', country: 'India' },
  faces: [
    { id: 'f1', personId: 'a', box: { x: 100, y: 100, width: 100, height: 100 }, imageWidth: 1000, imageHeight: 500 },
    { id: 'f2', personId: 'b', box: { x: 700, y: 200, width: 100, height: 100 }, imageWidth: 1000, imageHeight: 500 },
    { id: 'f3', personId: 'c', box: { x: 400, y: 100, width: 50, height: 50 }, imageWidth: 1000, imageHeight: 500 },
  ],
};
const people: any[] = [{ id: 'a', name: 'Riya' }, { id: 'b', name: 'Aman' }, { id: 'c', name: 'Person 12' }];

describe('buildAutoCaption', () => {
  it('is empty with everything off, and joins only the parts that are on and known', () => {
    expect(buildAutoCaption(photo, people, 'Day 2', NO_CAPTIONS)).toBe('');
    expect(buildAutoCaption(photo, people, 'Day 2', { place: true, date: true, people: true, chapter: true })).toBe('Day 2 · Baga, Goa · 14 Mar 2025 · Riya, Aman');
    expect(buildAutoCaption(photo, people, null, { ...NO_CAPTIONS, date: true })).toBe('14 Mar 2025');
  });
  it('skips placeholder names ("Person 12") and photos without a place', () => {
    expect(buildAutoCaption(photo, people, null, { ...NO_CAPTIONS, people: true })).toBe('Riya, Aman');
    expect(buildAutoCaption({ ...photo, location: undefined }, people, null, { ...NO_CAPTIONS, place: true })).toBe('');
  });
});

describe('faceFocus', () => {
  it('is the centre of the box that covers every face, as fractions of the picture', () => {
    // faces span x 100..800 (of 1000) and y 100..300 (of 500) -> centre (450, 200) -> (0.45, 0.4)
    expect(faceFocus(photo)).toEqual({ x: 0.45, y: 0.4 });
  });
  it('is undefined with no usable face', () => {
    expect(faceFocus({ ...photo, faces: [] })).toBeUndefined();
    expect(faceFocus({ ...photo, faces: [{ id: 'f', box: { x: 1, y: 1, width: 5, height: 5 } }] })).toBeUndefined();
  });
});
