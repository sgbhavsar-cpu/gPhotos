import { describe, it, expect } from 'vitest';
import { isPermanentDecodeError } from '../../src/main/services/pipelineOrchestrator';

// The real error from the one photo that kept the library at 23,879/23,880:
// an Apple ProRAW .dng using a TIFF compression the decoder can't read.
describe('isPermanentDecodeError', () => {
  it('recognises undecodable-file errors, so the photo is marked scanned instead of retried forever', () => {
    expect(isPermanentDecodeError(new Error('Error: tiff2vips: Compression scheme 52546 scanline decoding is not implemented\ntiff2vips: read error'))).toBe(true);
    expect(isPermanentDecodeError(new Error('Input buffer contains unsupported image format'))).toBe(true);
    expect(isPermanentDecodeError('VipsJpeg: Premature end of JPEG file')).toBe(true);
    expect(isPermanentDecodeError(new Error('heif2vips: unsupported feature: Unsupported codec'))).toBe(true);
  });

  it('does NOT swallow environmental failures a retry could fix', () => {
    expect(isPermanentDecodeError(new Error('Face detection worker exited unexpectedly'))).toBe(false);
    expect(isPermanentDecodeError(new Error('Worker request timed out after 60000ms'))).toBe(false);
    expect(isPermanentDecodeError(new Error('ENOENT: no such file or directory'))).toBe(false);
    expect(isPermanentDecodeError(new Error('Cannot allocate memory'))).toBe(false);
    expect(isPermanentDecodeError(undefined)).toBe(false);
  });
});
