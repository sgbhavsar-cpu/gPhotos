import fs from 'fs';
import path from 'path';
// piexifjs has no ESM/TS-friendly default export shape; require() matches
// how the rest of this codebase pulls in similarly-shaped CJS libraries.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const piexif = require('piexifjs');

function toExifDateTimeString(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}:${pad(date.getMonth() + 1)}:${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export interface PhotoMetadataUpdate {
  dateIso?: string;
  latitude?: number;
  longitude?: number;
}

export interface WriteMetadataResult {
  success: boolean;
  wroteExif: boolean;
  error?: string;
}

/**
 * Rewrites a JPEG's EXIF date (DateTimeOriginal/DateTimeDigitized/DateTime)
 * and/or GPS coordinates, and the file's own mtime/atime when a date is
 * given. Only fields actually present on `update` are touched.
 *
 * ponytail: only JPEG gets the EXIF rewrite — piexifjs (the only EXIF-WRITE
 * library in this app; exifr, used elsewhere, is read-only) only understands
 * JPEG's EXIF segment layout. HEIC/PNG/etc. still get their file mtime
 * updated for a date change (that part is format-agnostic), just not the
 * embedded tags. Add a broader tool (e.g. exiftool-vendored) if HEIC EXIF
 * writing turns out to matter in practice — it bundles a per-platform
 * binary, so it's a bigger dependency than this app currently carries for
 * what's a common but not universal case.
 */
export function writePhotoMetadata(filePath: string, update: PhotoMetadataUpdate): WriteMetadataResult {
  try {
    const ext = path.extname(filePath).toLowerCase();
    const isJpeg = ext === '.jpg' || ext === '.jpeg';
    let wroteExif = false;
    const newDate = update.dateIso ? new Date(update.dateIso) : null;

    if (isJpeg && (newDate || (update.latitude != null && update.longitude != null))) {
      const jpegData = fs.readFileSync(filePath).toString('binary');

      let exifObj: any;
      try {
        exifObj = piexif.load(jpegData);
      } catch {
        exifObj = { '0th': {}, Exif: {}, GPS: {}, '1st': {}, thumbnail: null };
      }
      exifObj['0th'] = exifObj['0th'] || {};
      exifObj['Exif'] = exifObj['Exif'] || {};
      exifObj['GPS'] = exifObj['GPS'] || {};

      if (newDate) {
        const exifDateTime = toExifDateTimeString(newDate);
        exifObj['0th'][piexif.ImageIFD.DateTime] = exifDateTime;
        exifObj['Exif'][piexif.ExifIFD.DateTimeOriginal] = exifDateTime;
        exifObj['Exif'][piexif.ExifIFD.DateTimeDigitized] = exifDateTime;
      }

      if (update.latitude != null && update.longitude != null) {
        exifObj['GPS'][piexif.GPSIFD.GPSLatitudeRef] = update.latitude >= 0 ? 'N' : 'S';
        exifObj['GPS'][piexif.GPSIFD.GPSLatitude] = piexif.GPSHelper.degToDmsRational(update.latitude);
        exifObj['GPS'][piexif.GPSIFD.GPSLongitudeRef] = update.longitude >= 0 ? 'E' : 'W';
        exifObj['GPS'][piexif.GPSIFD.GPSLongitude] = piexif.GPSHelper.degToDmsRational(update.longitude);
      }

      const exifBytes = piexif.dump(exifObj);
      const newJpegData = piexif.insert(exifBytes, jpegData);
      const outBuf = Buffer.from(newJpegData, 'binary');

      // Sharp/other writers can't reliably overwrite a file in place on
      // Windows — write to a temp path and rename over it instead (same
      // workaround used elsewhere in this codebase for the same reason).
      const tmpPath = `${filePath}.tmp${Date.now()}`;
      fs.writeFileSync(tmpPath, outBuf);
      fs.renameSync(tmpPath, filePath);
      wroteExif = true;
    }

    if (newDate) {
      fs.utimesSync(filePath, newDate, newDate);
    }
    return { success: true, wroteExif };
  } catch (err: any) {
    return { success: false, wroteExif: false, error: String(err?.message || err) };
  }
}
