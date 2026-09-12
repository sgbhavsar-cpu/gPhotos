import { Photo, PlaceAlbum } from '../../types';

export function groupPhotosByPlace(photos: Photo[]): PlaceAlbum[] {
  const geoPhotos = photos.filter((p) => p.location && p.location.latitude && p.location.longitude);
  const albumsMap = new Map<string, PlaceAlbum>();

  for (const photo of geoPhotos) {
    const loc = photo.location!;
    // Place name key: City, Country or rounded coordinate key
    let placeKey = '';
    let albumName = '';
    let albumType: PlaceAlbum['type'] = 'city';

    if (loc.city && loc.country) {
      placeKey = `${loc.city}_${loc.country}`.toLowerCase();
      albumName = `${loc.city}, ${loc.country}`;
      albumType = 'city';
    } else if (loc.city) {
      placeKey = loc.city.toLowerCase();
      albumName = loc.city;
      albumType = 'city';
    } else {
      // Round to ~12-15km grid so photos from distant regions never collapse into one
      const gridLat = loc.latitude.toFixed(1);
      const gridLng = loc.longitude.toFixed(1);
      placeKey = `geo_${gridLat}_${gridLng}`;
      albumName = loc.country
        ? `${loc.country} (${loc.latitude.toFixed(2)}°, ${loc.longitude.toFixed(2)}°)`
        : `Location (${loc.latitude.toFixed(2)}°, ${loc.longitude.toFixed(2)}°)`;
      albumType = 'cluster';
    }

    if (!albumsMap.has(placeKey)) {
      albumsMap.set(placeKey, {
        id: `place_${placeKey}`,
        name: albumName,
        city: loc.city,
        country: loc.country,
        latitude: loc.latitude,
        longitude: loc.longitude,
        photoCount: 1,
        coverPhotoId: photo.id,
        coverFilePath: photo.filePath,
      });
    } else {
      const album = albumsMap.get(placeKey)!;
      album.photoCount += 1;
    }
  }

  return Array.from(albumsMap.values()).sort((a, b) => b.photoCount - a.photoCount);
}

export function computeMapCenter(photos: Photo[]): [number, number] {
  const geoPhotos = photos.filter((p) => p.location && p.location.latitude && p.location.longitude);
  if (geoPhotos.length === 0) {
    return [20.0, 0.0]; // Default global view
  }

  let sumLat = 0;
  let sumLng = 0;
  for (const p of geoPhotos) {
    sumLat += p.location!.latitude;
    sumLng += p.location!.longitude;
  }

  return [sumLat / geoPhotos.length, sumLng / geoPhotos.length];
}
