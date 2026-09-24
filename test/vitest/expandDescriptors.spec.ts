import { describe, it, expect } from 'vitest';
import { expandCompactDescriptors } from '../../src/renderer/src/services/libraryStore';

describe('expandCompactDescriptors', () => {
  it('turns Float32Array descriptors back into plain number[] (JSON.stringify of a typed array writes an object, not an array)', () => {
    const faces: any[] = [{ id: 'a', descriptor: Float32Array.from([0.5, 0.25]) }, { id: 'b', descriptor: [1, 2] }, { id: 'c' }, { id: 'd', descriptor: new Float32Array(0) }];
    expandCompactDescriptors(faces);
    expect(faces[0].descriptor).toEqual([0.5, 0.25]);
    expect(Array.isArray(faces[0].descriptor)).toBe(true);
    expect(JSON.stringify(faces[0].descriptor)).toBe('[0.5,0.25]');
    expect(faces[1].descriptor).toEqual([1, 2]);   // already an array: untouched
    expect(faces[2].descriptor).toBeUndefined();   // none: untouched
    expect(faces[3].descriptor).toEqual([]);
  });
  it('tolerates null/undefined input', () => {
    expect(() => expandCompactDescriptors(undefined)).not.toThrow();
    expect(() => expandCompactDescriptors(null)).not.toThrow();
  });
});
