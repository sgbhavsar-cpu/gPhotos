import fs from 'fs';
import exifr from 'exifr';
import { ExifMetadata, LocationMetadata } from '../../types';

// Simple offline city coordinates lookup for common cities worldwide and India
const KNOWN_PLACES = [
  { city: 'New York', country: 'United States', lat: 40.7128, lng: -74.0060, radius: 0.5 },
  { city: 'San Francisco', country: 'United States', lat: 37.7749, lng: -122.4194, radius: 0.4 },
  { city: 'Los Angeles', country: 'United States', lat: 34.0522, lng: -118.2437, radius: 0.6 },
  { city: 'London', country: 'United Kingdom', lat: 51.5074, lng: -0.1278, radius: 0.4 },
  { city: 'Paris', country: 'France', lat: 48.8566, lng: 2.3522, radius: 0.4 },
  { city: 'Tokyo', country: 'Japan', lat: 35.6762, lng: 139.6503, radius: 0.5 },
  { city: 'Rome', country: 'Italy', lat: 41.9028, lng: 12.4964, radius: 0.4 },
  { city: 'Berlin', country: 'Germany', lat: 52.5200, lng: 13.4050, radius: 0.4 },
  { city: 'Sydney', country: 'Australia', lat: -33.8688, lng: 151.2093, radius: 0.5 },
  { city: 'Singapore', country: 'Singapore', lat: 1.3521, lng: 103.8198, radius: 0.3 },
  { city: 'Dubai', country: 'United Arab Emirates', lat: 25.2048, lng: 55.2708, radius: 0.4 },
  { city: 'Toronto', country: 'Canada', lat: 43.6532, lng: -79.3832, radius: 0.4 },
  { city: 'Vancouver', country: 'Canada', lat: 49.2827, lng: -123.1207, radius: 0.4 },
  { city: 'Barcelona', country: 'Spain', lat: 41.3879, lng: 2.1699, radius: 0.4 },
  { city: 'Amsterdam', country: 'Netherlands', lat: 52.3676, lng: 4.9041, radius: 0.3 },
  // India Metros & Cities
  { city: 'Mumbai', country: 'India', lat: 19.0760, lng: 72.8777, radius: 0.5 },
  { city: 'Delhi', country: 'India', lat: 28.6139, lng: 77.2090, radius: 0.5 },
  { city: 'Bengaluru', country: 'India', lat: 12.9716, lng: 77.5946, radius: 0.5 },
  { city: 'Chennai', country: 'India', lat: 13.0827, lng: 80.2707, radius: 0.4 },
  { city: 'Hyderabad', country: 'India', lat: 17.3850, lng: 78.4867, radius: 0.4 },
  { city: 'Pune', country: 'India', lat: 18.5204, lng: 73.8567, radius: 0.4 },
  { city: 'Kolkata', country: 'India', lat: 22.5726, lng: 88.3639, radius: 0.4 },
  { city: 'Jaipur', country: 'India', lat: 26.9124, lng: 75.7873, radius: 0.4 },
  // Gujarat Regional Cities & Tourist Destinations
  { city: 'Surat', country: 'India', lat: 21.1702, lng: 72.8311, radius: 0.25 },
  { city: 'Dumas Beach', country: 'India', lat: 21.1460, lng: 72.7460, radius: 0.08 },
  { city: 'Ahmedabad', country: 'India', lat: 23.0225, lng: 72.5714, radius: 0.35 },
  { city: 'Gandhinagar', country: 'India', lat: 23.2156, lng: 72.6369, radius: 0.2 },
  { city: 'Dholka', country: 'India', lat: 22.7200, lng: 72.4600, radius: 0.3 },
  { city: 'Vadodara', country: 'India', lat: 22.3072, lng: 73.1812, radius: 0.3 },
  { city: 'Halol', country: 'India', lat: 22.4984, lng: 73.4727, radius: 0.2 },
  { city: 'Pavagadh', country: 'India', lat: 22.4600, lng: 73.5200, radius: 0.15 },
  { city: 'Bhavnagar', country: 'India', lat: 21.7645, lng: 72.1519, radius: 0.35 },
  { city: 'Palitana', country: 'India', lat: 21.5222, lng: 71.8322, radius: 0.2 },
  { city: 'Sihor', country: 'India', lat: 21.7000, lng: 71.9700, radius: 0.2 },
  { city: 'Rajkot', country: 'India', lat: 22.3039, lng: 70.8022, radius: 0.3 },
  { city: 'Jamnagar', country: 'India', lat: 22.4707, lng: 70.0577, radius: 0.3 },
  { city: 'Goa', country: 'India', lat: 15.2993, lng: 74.1240, radius: 0.4 },
];

export function findApproximateLocation(lat: number, lng: number): { city?: string; country?: string } {
  let closestPlace: (typeof KNOWN_PLACES)[0] | null = null;
  let minDistance = Infinity;

  for (const place of KNOWN_PLACES) {
    const dLat = Math.abs(place.lat - lat);
    const dLng = Math.abs(place.lng - lng);
    if (dLat <= place.radius && dLng <= place.radius) {
      const dist = Math.hypot(dLat, dLng);
      if (dist < minDistance) {
        minDistance = dist;
        closestPlace = place;
      }
    }
  }

  if (closestPlace) {
    return { city: closestPlace.city, country: closestPlace.country };
  }

  // Specific country and hemisphere fallbacks
  if (lat >= 6 && lat <= 36 && lng >= 68 && lng <= 98) {
    return { country: 'India' };
  } else if (lat > 20 && lat < 50 && lng > -130 && lng < -65) {
    return { country: 'United States' };
  } else if (lat > 35 && lat < 70 && lng > -10 && lng < 40) {
    return { country: 'Europe' };
  } else if (lat > 5 && lat < 40 && lng > 65 && lng < 100) {
    return { country: 'South Asia' };
  } else if (lat > 15 && lat < 55 && lng > 100 && lng < 150) {
    return { country: 'East Asia' };
  }

  return { country: 'Earth' };
}

export async function parsePhotoMetadata(filePath: string): Promise<{
  exif?: ExifMetadata;
  location?: LocationMetadata;
  dateTaken: string;
  width?: number;
  height?: number;
}> {
  let dateTaken: Date | null = null;
  let exifData: ExifMetadata = {};
  let locationData: LocationMetadata | undefined = undefined;
  let width: number | undefined;
  let height: number | undefined;

  try {
    const fileBuffer = await fs.promises.readFile(filePath);
    const raw = await exifr.parse(fileBuffer, {
      tiff: true,
      exif: true,
      gps: true,
      jfif: true,
    });

    if (raw) {
      if (raw.DateTimeOriginal instanceof Date && !isNaN(raw.DateTimeOriginal.getTime())) {
        dateTaken = raw.DateTimeOriginal;
      } else if (raw.CreateDate instanceof Date && !isNaN(raw.CreateDate.getTime())) {
        dateTaken = raw.CreateDate;
      } else if (raw.ModifyDate instanceof Date && !isNaN(raw.ModifyDate.getTime())) {
        dateTaken = raw.ModifyDate;
      }

      width = raw.ExifImageWidth || raw.ImageWidth;
      height = raw.ExifImageHeight || raw.ImageHeight;

      // ExifImageWidth/Height are the raw sensor/capture dimensions, not
      // auto-rotated — for an orientation tag requiring a 90/270 rotation
      // (extremely common: most cameras/phones never physically rotate the
      // pixel data, they just tag the intended orientation), the image that
      // actually gets displayed and that face detection decodes (both
      // auto-orient via sharp's .rotate()) has these swapped. Left
      // unswapped, this photo's stored width/height silently disagrees with
      // its real display-oriented frame — exactly the kind of mismatch that
      // throws off face-box coordinate scaling (see PhotoLightbox.tsx's
      // getFaceNormalizedCoords, which uses photo.width/height as its
      // primary reference). exifr returns Orientation as either the raw
      // EXIF number (5-8 = a 90/270 rotation) or, with this parse config, a
      // translated string like "Rotate 90 CW" — handle both.
      const orientationRaw: unknown = raw.Orientation;
      const orientationNeedsSwap =
        (typeof orientationRaw === 'number' && [5, 6, 7, 8].includes(orientationRaw)) ||
        (typeof orientationRaw === 'string' && /90|270/.test(orientationRaw));
      if (orientationNeedsSwap && width != null && height != null) {
        const swapped = width;
        width = height;
        height = swapped;
      }

      exifData = {
        cameraMake: raw.Make,
        cameraModel: raw.Model,
        lensModel: raw.LensModel,
        iso: raw.ISO,
        fNumber: raw.FNumber,
        exposureTime: raw.ExposureTime,
        focalLength: raw.FocalLength,
        dateTimeOriginal: dateTaken ? dateTaken.toISOString() : undefined,
        orientation: raw.Orientation,
      };

      if (raw.latitude != null && raw.longitude != null && !isNaN(raw.latitude) && !isNaN(raw.longitude)) {
        const approx = findApproximateLocation(raw.latitude, raw.longitude);
        locationData = {
          latitude: Number(raw.latitude.toFixed(6)),
          longitude: Number(raw.longitude.toFixed(6)),
          altitude: raw.altitude ? Number(raw.altitude.toFixed(1)) : undefined,
          city: approx.city,
          country: approx.country,
          label: approx.city ? `${approx.city}, ${approx.country}` : approx.country,
        };
      }
    }
  } catch (err) {
    // Non-fatal, fallback to filesystem metadata
  }

  // Fallback to the file's modified time if no EXIF date — NOT its creation
  // time. Creation time reflects whenever the file was last copied/moved
  // onto this filesystem (e.g. imported from a camera, synced from
  // OneDrive, restored from backup), which is unrelated to when the photo
  // was actually taken and routinely lands weeks/months after the fact.
  // Modified time survives most copy/sync tools unchanged from the
  // original capture, so it's the closer of the two to the truth whenever
  // there's no embedded metadata to go by.
  if (!dateTaken) {
    try {
      const stats = fs.statSync(filePath);
      dateTaken = stats.mtime && !isNaN(stats.mtime.getTime()) && stats.mtime.getFullYear() > 1980
        ? stats.mtime
        : stats.birthtime;
    } catch {
      dateTaken = new Date();
    }
  }

  return {
    exif: Object.keys(exifData).length > 0 ? exifData : undefined,
    location: locationData,
    dateTaken: dateTaken.toISOString(),
    width,
    height,
  };
}
