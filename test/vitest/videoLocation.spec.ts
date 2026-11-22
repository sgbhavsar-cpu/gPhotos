import { describe, it, expect } from 'vitest';
import { parseIso6709 } from '../../src/main/services/videoExportService';

describe('parseIso6709 (video container GPS)', () => {
  it('reads a phone location tag', () => {
    expect(parseIso6709('+23.0225+072.5714+000.000/')).toEqual({ latitude: 23.0225, longitude: 72.5714 });
    expect(parseIso6709('-33.8688+151.2093/')).toEqual({ latitude: -33.8688, longitude: 151.2093 });
  });
  it('rejects junk and 0,0', () => {
    expect(parseIso6709('hello')).toBeNull();
    expect(parseIso6709('+00.0000+000.0000/')).toBeNull();
    expect(parseIso6709('+95.0+10.0/')).toBeNull();
  });
});
