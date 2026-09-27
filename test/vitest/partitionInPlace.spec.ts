import { describe, it, expect } from 'vitest';
import { partitionInPlace } from '../../src/main/services/virtualMirrorService';

describe('partitionInPlace (large-library sync ordering)', () => {
  it('keeps the array intact and stable for a library far above the call-stack argument limit', () => {
    const N = 900_000; // the reported library had ~818k photos; push(...arr) overflows the stack from ~120k
    const files = Array.from({ length: N }, (_, i) => `f${i}`);
    const expectedFirst = files.filter((_, i) => i % 3 === 0);
    const expectedRest = files.filter((_, i) => i % 3 !== 0);

    const res = partitionInPlace(files, (f) => Number(f.slice(1)) % 3 === 0);

    expect(files).toHaveLength(N);
    expect(res).toEqual({ first: expectedFirst.length, rest: expectedRest.length });
    expect(files.slice(0, expectedFirst.length)).toEqual(expectedFirst); // stable order inside each group
    expect(files.slice(expectedFirst.length)).toEqual(expectedRest);
    expect(files.every((f) => typeof f === 'string')).toBe(true); // no holes / undefined entries
  });

  it('leaves the array untouched when the predicate throws (a failure must never empty the file list)', () => {
    const files = ['a', 'b', 'c', 'd'];
    expect(() =>
      partitionInPlace(files, (f) => {
        if (f === 'c') throw new Error('boom');
        return f === 'a';
      })
    ).toThrow('boom');
    expect(files).toEqual(['a', 'b', 'c', 'd']);
  });

  it('handles empty and all-one-side inputs', () => {
    expect(partitionInPlace([], () => true)).toEqual({ first: 0, rest: 0 });
    const a = ['x', 'y'];
    expect(partitionInPlace(a, () => false)).toEqual({ first: 0, rest: 2 });
    expect(a).toEqual(['x', 'y']);
    expect(partitionInPlace(a, () => true)).toEqual({ first: 2, rest: 0 });
  });
});
