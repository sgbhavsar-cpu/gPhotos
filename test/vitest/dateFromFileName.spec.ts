import { describe, it, expect, vi } from 'vitest';
vi.mock('../../src/main/services/videoExportService', () => ({ probeCreationTime: vi.fn(async () => null) }));
import { dateFromFileName } from '../../src/main/services/exifParser';

describe('dateFromFileName', () => {
  it('reads date and time from common phone/app names', () => {
    const a = dateFromFileName('20240608_165442000_iOS.mp4')!;
    expect([a.getFullYear(), a.getMonth() + 1, a.getDate(), a.getHours(), a.getMinutes(), a.getSeconds()]).toEqual([2024, 6, 8, 16, 54, 42]);
    const b = dateFromFileName('VID-20240727-WA0042.mp4')!;
    expect([b.getFullYear(), b.getMonth() + 1, b.getDate()]).toEqual([2024, 7, 27]);
  });
  it('ignores long digit runs and names without a date', () => {
    expect(dateFromFileName('GX010071_1721620591851.MP4')).toBeNull();
    expect(dateFromFileName('IMG_6156 Leh Palace 10.MOV')).toBeNull();
  });
});
