import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import exifr from 'exifr';
import { parsePhotoMetadata } from '../../src/main/services/exifParser';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const piexif = require('piexifjs');

/**
 * parsePhotoMetadata used to readFile() the whole original just to read its EXIF header.
 * It now lets exifr read the file in chunks; these check the parsed output is unchanged
 * versus the old whole-buffer parse, across JPEGs with/without EXIF/GPS/orientation.
 */
describe('parsePhotoMetadata: chunked read is equivalent to whole-file read', () => {
  let dir: string;
  const files: Record<string, string> = {};

  async function makeJpeg(name: string, opts: { exif?: any; big?: boolean }): Promise<string> {
    const p = path.join(dir, name);
    // Noisy pixels so the file is much larger than any first chunk.
    const w = opts.big ? 1600 : 64;
    const raw = Buffer.alloc(w * w * 3);
    for (let i = 0; i < raw.length; i++) raw[i] = (i * 2654435761) >>> 24;
    let jpeg = await sharp(raw, { raw: { width: w, height: w, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
    if (opts.exif) {
      const bin = jpeg.toString('binary');
      jpeg = Buffer.from(piexif.insert(piexif.dump(opts.exif), bin), 'binary');
    }
    fs.writeFileSync(p, jpeg);
    return p;
  }

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gphotos_exif_equiv_'));
    files.plain = await makeJpeg('plain.jpg', {});
    files.exifOnly = await makeJpeg('exif.jpg', {
      exif: {
        '0th': { [piexif.ImageIFD.Make]: 'ACME', [piexif.ImageIFD.Model]: 'Cam 9', [piexif.ImageIFD.Orientation]: 6 },
        Exif: {
          [piexif.ExifIFD.DateTimeOriginal]: '2021:03:04 05:06:07',
          [piexif.ExifIFD.PixelXDimension]: 4000,
          [piexif.ExifIFD.PixelYDimension]: 3000,
          [piexif.ExifIFD.ISOSpeedRatings]: 200,
        },
      },
    });
    files.gps = await makeJpeg('gps.jpg', {
      big: true,
      exif: {
        '0th': { [piexif.ImageIFD.Make]: 'ACME' },
        Exif: { [piexif.ExifIFD.DateTimeOriginal]: '2019:12:31 23:59:58' },
        GPS: {
          [piexif.GPSIFD.GPSLatitudeRef]: 'N',
          [piexif.GPSIFD.GPSLatitude]: piexif.GPSHelper.degToDmsRational(21.1702),
          [piexif.GPSIFD.GPSLongitudeRef]: 'E',
          [piexif.GPSIFD.GPSLongitude]: piexif.GPSHelper.degToDmsRational(72.8311),
        },
      },
    });
    // Big EXIF block (embedded thumbnail) so the header itself is larger than one chunk.
    const thumb = await sharp({ create: { width: 160, height: 120, channels: 3, background: '#468' } }).jpeg().toBuffer();
    files.thumb = await makeJpeg('thumb.jpg', {
      exif: {
        '0th': { [piexif.ImageIFD.Make]: 'ThumbCo' },
        Exif: { [piexif.ExifIFD.DateTimeOriginal]: '2020:01:02 03:04:05' },
        '1st': { [piexif.ImageIFD.Compression]: 6 },
        thumbnail: thumb.toString('binary'),
      },
    });
    files.tiff = path.join(dir, 'a.tif');
    await sharp({ create: { width: 200, height: 100, channels: 3, background: '#a33' } })
      .withExif({ IFD0: { Make: 'TiffCo', Model: 'T1' } })
      .tiff()
      .toFile(files.tiff);
    files.png = path.join(dir, 'a.png');
    await sharp({ create: { width: 50, height: 50, channels: 3, background: '#0a0' } }).png().toFile(files.png);
    files.garbage = path.join(dir, 'bad.jpg');
    fs.writeFileSync(files.garbage, Buffer.from('not really a jpeg'));
  });

  afterAll(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  it('exifr parse of the path equals exifr parse of the whole buffer for every fixture', async () => {
    const opts = { tiff: true, exif: true, gps: true, jfif: true };
    const all = [...Object.values(files), path.resolve(__dirname, '../fixtures/sample_photo.jpg')];
    for (const f of all) {
      const whole = await exifr.parse(fs.readFileSync(f), opts).catch(() => undefined);
      const chunked = await exifr.parse(f, opts).catch(() => undefined);
      expect(chunked, path.basename(f)).toEqual(whole);
    }
  });

  it('parsePhotoMetadata extracts camera, date, GPS and orientation-swapped size', async () => {
    const a = await parsePhotoMetadata(files.exifOnly);
    expect(a.exif?.cameraMake).toBe('ACME');
    expect(a.exif?.iso).toBe(200);
    expect(a.dateTaken).toBe(new Date(2021, 2, 4, 5, 6, 7).toISOString());
    // Orientation 6 => 4000x3000 capture size is swapped for display.
    expect(a.width).toBe(3000);
    expect(a.height).toBe(4000);

    const g = await parsePhotoMetadata(files.gps);
    expect(g.location?.latitude).toBeCloseTo(21.1702, 3);
    expect(g.location?.longitude).toBeCloseTo(72.8311, 3);
    expect(g.location?.city).toBe('Surat');
    expect(g.dateTaken).toBe(new Date(2019, 11, 31, 23, 59, 58).toISOString());

    const t = await parsePhotoMetadata(files.thumb);
    expect(t.exif?.cameraMake).toBe('ThumbCo');
  });

  it('files with no EXIF fall back to mtime, and unreadable/garbage files never throw', async () => {
    const mtime = new Date('2018-06-07T08:09:10Z');
    fs.utimesSync(files.plain, mtime, mtime);
    const p = await parsePhotoMetadata(files.plain);
    expect(p.dateTaken).toBe(mtime.toISOString());
    expect(p.location).toBeUndefined();

    const bad = await parsePhotoMetadata(files.garbage);
    expect(typeof bad.dateTaken).toBe('string');
    const missing = await parsePhotoMetadata(path.join(dir, 'nope.jpg'));
    expect(typeof missing.dateTaken).toBe('string');
  });
});
