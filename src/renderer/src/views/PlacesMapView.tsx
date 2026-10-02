import React, { useEffect, useRef, useState, useMemo, useCallback, useDeferredValue } from 'react';
import L from 'leaflet';
import {
  MapPin,
  ArrowLeft,
  Compass,
  Layers,
  X,
  Calendar,
  Eye,
  Maximize2,
  Edit2,
  Check,
  Search,
  Plus,
  CheckSquare,
  Square,
  MoreVertical,
} from 'lucide-react';
import { Photo, PlaceAlbum } from '../../../types';
import { PhotoCard } from '../components/PhotoCard';
import { LocationPickerModal } from '../components/LocationPickerModal';
import { libraryStore, getLocalPhotoUrl } from '../services/libraryStore';
import { matchesPlaceQuery } from '../services/placesService';
import { useIsMobile } from '../hooks/useIsMobile';
import { notify, notifyError } from '../services/notifications';
import { VirtualCardGrid } from '../components/VirtualCardGrid';
import { VirtualHorizontalList } from '../components/VirtualHorizontalList';

// Place names come from EXIF / geocoding / the user and end up inside Leaflet divIcon HTML.
const escapeHtml = (v: unknown): string =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

interface PlacesMapViewProps {
  photos: Photo[];
  places: PlaceAlbum[];
  onSelectPhoto: (photo: Photo) => void;
  onToggleFavorite: (photoId: string) => void;
  resetTrigger?: number;
}

interface PhotoCluster {
  id: string;
  latitude: number;
  longitude: number;
  photos: Photo[];
  coverPhoto: Photo;
  title: string;
  subtitle: string;
}

const TILE_LAYERS = {
  osm: {
    name: 'OpenStreetMap (Free)',
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; OpenStreetMap contributors',
    subdomains: 'abc',
  },
  satellite: {
    name: 'Satellite',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: '&copy; Esri, Maxar, Earthstar Geographics',
    subdomains: 'abc',
  },
  dark: {
    name: 'Dark',
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    attribution: '&copy; OpenStreetMap &copy; CARTO',
    subdomains: 'abcd',
  },
};

export const PlacesMapView: React.FC<PlacesMapViewProps> = ({
  photos,
  places = [],
  onSelectPhoto,
  onToggleFavorite,
  resetTrigger,
}) => {
  // App passes a fresh inline callback every render; read it through a ref so markers/clusters
  // aren't recomputed (O(photos)) on every parent re-render.
  const onSelectPhotoRef = useRef(onSelectPhoto);
  onSelectPhotoRef.current = onSelectPhoto;
  const mapContainerRef = useRef<HTMLDivElement>(null);
  // Scroll containers of the two windowed photo lists (cluster tray, Assign modal grid).
  const clusterTrayRef = useRef<HTMLDivElement>(null);
  const assignGridScrollRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<L.Map | null>(null);
  const currentTileLayerRef = useRef<L.TileLayer | null>(null);
  const markersLayerRef = useRef<L.LayerGroup | null>(null);

  const isMobile = useIsMobile();

  // Filter the map by place name (city/country/custom label) — mirrors PeopleView's name search.
  // Deferred for the same reason: typing shouldn't jank marker re-clustering/re-render.
  const [placesSearchQuery, setPlacesSearchQuery] = useState('');
  const deferredPlacesSearchQuery = useDeferredValue(placesSearchQuery);
  const [showMobileTools, setShowMobileTools] = useState(false);

  const [activeTileType, setActiveTileType] = useState<'osm' | 'satellite' | 'dark'>('osm');
  const [selectedCluster, setSelectedCluster] = useState<PhotoCluster | null>(null);

  // Cluster renaming states
  const [isEditingClusterLocation, setIsEditingClusterLocation] = useState(false);
  const [clusterLocationInput, setClusterLocationInput] = useState('');
  const [clusterToast, setClusterToast] = useState<string | null>(null);

  // Assign location to unlocated photos modal states
  const [showAssignModal, setShowAssignModal] = useState(false);
  const [assignSearchQuery, setAssignSearchQuery] = useState('');
  const [assignSearchResults, setAssignSearchResults] = useState<Array<{ name: string; lat: number; lon: number }>>([]);
  const [isSearchingPlaces, setIsSearchingPlaces] = useState(false);
  const [chosenLocation, setChosenLocation] = useState<{ name: string; lat: number; lon: number } | null>(null);
  const [selectedUnlocatedIds, setSelectedUnlocatedIds] = useState<Set<string>>(new Set());
  // When set, the Assign Location modal targets these specific (already-geotagged) photos
  // instead of the unlocated ones — used by the cluster panel's "Fix Location" override.
  const [assignModalOverridePhotos, setAssignModalOverridePhotos] = useState<Photo[] | null>(null);

  // Reset selected cluster on resetTrigger
  useEffect(() => {
    if (resetTrigger) {
      setSelectedCluster(null);
      setIsEditingClusterLocation(false);
      setShowAssignModal(false);
      setAssignModalOverridePhotos(null);
    }
  }, [resetTrigger]);

  // Handle Escape key navigation inside PlacesMapView
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;

      // stopImmediatePropagation, not stopPropagation — see PeopleView's
      // matching Escape handler for why (App.tsx's global handler is also
      // bound to `window` and stopPropagation alone won't stop it firing).
      if (showAssignModal) {
        e.stopImmediatePropagation();
        setShowAssignModal(false);
        setAssignModalOverridePhotos(null);
      } else if (isEditingClusterLocation) {
        e.stopImmediatePropagation();
        setIsEditingClusterLocation(false);
      } else if (selectedCluster) {
        e.stopImmediatePropagation();
        setSelectedCluster(null);
      }
    };

    // capture: true — see PeopleView's matching Escape handler for why.
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, [showAssignModal, isEditingClusterLocation, selectedCluster]);

  // Unlocated photos
  const unlocatedPhotos = useMemo(() => {
    return photos.filter(
      (p) =>
        !p.location ||
        p.location.latitude == null ||
        p.location.longitude == null ||
        isNaN(p.location.latitude) ||
        isNaN(p.location.longitude) ||
        (p.location.latitude === 0 && p.location.longitude === 0 && !p.location.label)
    );
  }, [photos]);

  // Photos targeted by the Assign Location modal: either the unlocated set (default),
  // or a specific cluster's photos when opened via the "Fix Location" override.
  const photosForAssignModal = assignModalOverridePhotos ?? unlocatedPhotos;
  const isLocationOverrideMode = assignModalOverridePhotos !== null;

  // Initialize all target photos as selected when opening the assign modal. Deliberately NOT
  // re-run when `unlocatedPhotos` changes identity (any store update), or the user's
  // deselections would be wiped while the dialog is open.
  const photosForAssignModalRef = useRef(photosForAssignModal);
  photosForAssignModalRef.current = photosForAssignModal;
  useEffect(() => {
    if (showAssignModal) {
      setSelectedUnlocatedIds(new Set(photosForAssignModalRef.current.map((p) => p.id)));
    }
  }, [showAssignModal, assignModalOverridePhotos]);

  // All valid geotagged photos
  const allGeoPhotos = useMemo(() => {
    return photos.filter(
      (p) =>
        p.location &&
        p.location.latitude != null &&
        p.location.longitude != null &&
        !isNaN(p.location.latitude) &&
        !isNaN(p.location.longitude) &&
        (p.location.latitude !== 0 || p.location.longitude !== 0)
    );
  }, [photos]);

  // Narrowed by the place search box, if any — every downstream consumer (clustering, marker
  // rendering, bounds-fitting, the header count) reads this name, so a search box automatically
  // narrows the whole map to matching pins with no other changes needed.
  const geoPhotos = useMemo(() => {
    if (!deferredPlacesSearchQuery.trim()) return allGeoPhotos;
    return allGeoPhotos.filter((p) => matchesPlaceQuery(p.location, deferredPlacesSearchQuery));
  }, [allGeoPhotos, deferredPlacesSearchQuery]);

  // Dynamic screen-space clustering function
  const computeClusters = useCallback(
    (map: L.Map, clusterPixelThreshold = 55): PhotoCluster[] => {
      if (geoPhotos.length === 0) return [];

      type Bucket = {
        photos: Photo[];
        screenPt: L.Point;
        sumLat: number;
        sumLng: number;
        cell: string;
      };
      const clusters: Bucket[] = [];
      // Grid hash (cell = threshold px): a point can only be within threshold of clusters in its
      // own or the 8 neighbouring cells, so this is ~O(photos) instead of O(photos x clusters).
      const grid = new Map<string, Bucket[]>();
      const cellSize = clusterPixelThreshold;
      const cellOf = (pt: L.Point) => `${Math.floor(pt.x / cellSize)},${Math.floor(pt.y / cellSize)}`;

      for (const photo of geoPhotos) {
        const lat = photo.location!.latitude;
        const lng = photo.location!.longitude;
        const pt = map.latLngToLayerPoint([lat, lng]);
        const cx = Math.floor(pt.x / cellSize);
        const cy = Math.floor(pt.y / cellSize);

        let target: Bucket | null = null;
        for (let dx = -1; dx <= 1 && !target; dx++) {
          for (let dy = -1; dy <= 1 && !target; dy++) {
            const list = grid.get(`${cx + dx},${cy + dy}`);
            if (!list) continue;
            for (const cluster of list) {
              if (pt.distanceTo(cluster.screenPt) <= clusterPixelThreshold) {
                target = cluster;
                break;
              }
            }
          }
        }

        if (target) {
          target.photos.push(photo);
          target.sumLat += lat;
          target.sumLng += lng;
          // Update center point smoothly
          target.screenPt = L.point((target.screenPt.x + pt.x) / 2, (target.screenPt.y + pt.y) / 2);
          const newCell = cellOf(target.screenPt);
          if (newCell !== target.cell) {
            const oldList = grid.get(target.cell);
            if (oldList) oldList.splice(oldList.indexOf(target), 1);
            const nl = grid.get(newCell) || [];
            nl.push(target);
            grid.set(newCell, nl);
            target.cell = newCell;
          }
        } else {
          const cell = cellOf(pt);
          const b: Bucket = { photos: [photo], screenPt: pt, sumLat: lat, sumLng: lng, cell };
          clusters.push(b);
          const list = grid.get(cell) || [];
          list.push(b);
          grid.set(cell, list);
        }
      }

      return clusters.map((c, index) => {
        const count = c.photos.length;
        const avgLat = c.sumLat / count;
        const avgLng = c.sumLng / count;

        // Choose the best cover photo (favorite first, else newest)
        const sorted = [...c.photos].sort((a, b) => {
          if (a.isFavorite && !b.isFavorite) return -1;
          if (!a.isFavorite && b.isFavorite) return 1;
          return new Date(b.dateTaken).getTime() - new Date(a.dateTaken).getTime();
        });
        const coverPhoto = sorted[0];

        // Format meaningful title from location or city
        let title = '';
        const sampleLoc = c.photos.find((p) => p.location?.city)?.location;
        if (sampleLoc && sampleLoc.city) {
          title = sampleLoc.country ? `${sampleLoc.city}, ${sampleLoc.country}` : sampleLoc.city;
        } else if (c.photos[0].location?.label) {
          title = c.photos[0].location.label;
        } else {
          title = `${avgLat.toFixed(2)}°, ${avgLng.toFixed(2)}°`;
        }

        const subtitle = count === 1 ? '1 photo' : `${count} photos`;

        return {
          id: `cluster_${index}_${Math.round(avgLat * 1000)}_${Math.round(avgLng * 1000)}`,
          latitude: avgLat,
          longitude: avgLng,
          photos: sorted,
          coverPhoto,
          title,
          subtitle,
        };
      });
    },
    [geoPhotos]
  );

  // Initialize Leaflet Map
  useEffect(() => {
    if (!mapContainerRef.current) return;
    if (mapInstanceRef.current) return;

    let initialLat = 22.2587;
    let initialLng = 71.1924;
    let initialZoom = 6;

    if (geoPhotos.length > 0) {
      initialLat = geoPhotos[0].location!.latitude;
      initialLng = geoPhotos[0].location!.longitude;
      initialZoom = 8;
    }

    const map = L.map(mapContainerRef.current, {
      center: [initialLat, initialLng],
      zoom: initialZoom,
      zoomControl: false,
      attributionControl: false,
    });

    L.control.zoom({ position: 'bottomright' }).addTo(map);

    // Initial tile layer
    const tileConfig = TILE_LAYERS[activeTileType];
    const tileLayer = L.tileLayer(tileConfig.url, {
      maxZoom: 19,
      subdomains: tileConfig.subdomains,
    }).addTo(map);
    currentTileLayerRef.current = tileLayer;

    const markersLayer = L.layerGroup().addTo(map);
    markersLayerRef.current = markersLayer;
    mapInstanceRef.current = map;

    // Dismiss bottom tray when clicking blank map area
    map.on('click', () => {
      setSelectedCluster(null);
    });

    return () => {
      map.remove();
      mapInstanceRef.current = null;
    };
  }, []);

  // Switch Tile Layer on activeTileType change
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map) return;

    if (currentTileLayerRef.current) {
      map.removeLayer(currentTileLayerRef.current);
    }

    const tileConfig = TILE_LAYERS[activeTileType];
    const newTileLayer = L.tileLayer(tileConfig.url, {
      maxZoom: 19,
      subdomains: tileConfig.subdomains,
    }).addTo(map);
    currentTileLayerRef.current = newTileLayer;
  }, [activeTileType]);

  // Update Markers dynamically on zoom/pan or photos change
  const refreshMarkers = useCallback(() => {
    const map = mapInstanceRef.current;
    const markersLayer = markersLayerRef.current;
    if (!map || !markersLayer) return;

    markersLayer.clearLayers();

    if (geoPhotos.length === 0) return;

    const clusters = computeClusters(map, 54);

    clusters.forEach((cluster) => {
      const isMulti = cluster.photos.length > 1;
      const thumbUrl = getLocalPhotoUrl(
        cluster.coverPhoto.filePath,
        cluster.coverPhoto.originalRemotePath,
        false
      );

      const safeTitle = escapeHtml(cluster.title);
      const html = `
        <div class="pin-bubble" title="${safeTitle} (${escapeHtml(cluster.subtitle)})">
          <img src="${escapeHtml(thumbUrl)}" class="pin-thumbnail" alt="${safeTitle}" />
          ${isMulti ? `<div class="pin-badge">${cluster.photos.length}</div>` : ''}
          <div class="pin-pointer"></div>
          <div class="pin-title-pill">
            <span class="pin-title-text">${safeTitle}</span>
            <span class="pin-count-badge">${cluster.photos.length}</span>
          </div>
        </div>
      `;

      const customIcon = L.divIcon({
        className: `photo-map-pin ${isMulti ? 'is-stacked' : ''}`,
        html,
        iconSize: [52, 52],
        iconAnchor: [26, 52],
      });

      const marker = L.marker([cluster.latitude, cluster.longitude], {
        icon: customIcon,
        riseOnHover: true,
      });

      marker.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        if (cluster.photos.length === 1) {
          // iPhone style: Single photo tap directly launches Lightbox!
          onSelectPhotoRef.current(cluster.photos[0]);
        } else {
          // Multi-photo cluster: smoothly zoom in and show photos in bottom tray
          setSelectedCluster(cluster);
          if (map.getZoom() < 16) {
            map.flyTo([cluster.latitude, cluster.longitude], Math.min(map.getZoom() + 3, 16), {
              duration: 0.8,
            });
          }
        }
      });

      marker.addTo(markersLayer);
    });
  }, [geoPhotos, computeClusters]);

  const handleSaveClusterLocationName = () => {
    const clean = clusterLocationInput.trim();
    if (!clean || !selectedCluster) return;
    const updatedPhotos = selectedCluster.photos.map((p) => ({
      ...p,
      location: {
        latitude: selectedCluster.latitude,
        longitude: selectedCluster.longitude,
        ...p.location,
        label: clean,
        city: clean,
      },
    }));
    try {
      libraryStore.updatePhotos(updatedPhotos);
    } catch (err) {
      notifyError('Rename location', err);
      return;
    }
    setSelectedCluster({
      ...selectedCluster,
      title: clean,
      photos: updatedPhotos,
    });
    setIsEditingClusterLocation(false);
    setClusterToast(`✓ Location updated to "${clean}"!`);
    setTimeout(() => setClusterToast(null), 3500);
    refreshMarkers();
  };

  const handleSearchPlaces = async () => {
    const query = assignSearchQuery.trim();
    if (!query) return;
    setIsSearchingPlaces(true);
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=5`);
      if (!res.ok) throw new Error(`Place search returned HTTP ${res.status}`);
      const data = await res.json();
      if (Array.isArray(data)) {
        const results = data
          .map((item: any) => ({
            name: String(item.display_name || '').split(',').slice(0, 3).join(','),
            lat: parseFloat(item.lat),
            lon: parseFloat(item.lon),
          }))
          .filter((r) => r.name && Number.isFinite(r.lat) && Number.isFinite(r.lon));
        setAssignSearchResults(results);
        setChosenLocation(results.length > 0 ? results[0] : null);
        if (results.length === 0) notify('info', `No places found for "${query}".`);
      }
    } catch (err) {
      notifyError('Place search failed (offline?)', err);
    } finally {
      setIsSearchingPlaces(false);
    }
  };

  const handleApplyAssignedLocation = () => {
    if (!chosenLocation || selectedUnlocatedIds.size === 0) return;
    const targetPhotos = photos.filter((p) => selectedUnlocatedIds.has(p.id));
    const updated = targetPhotos.map((p) => ({
      ...p,
      location: {
        latitude: chosenLocation.lat,
        longitude: chosenLocation.lon,
        label: chosenLocation.name,
        city: chosenLocation.name.split(',')[0].trim(),
      },
    }));
    try {
      libraryStore.updatePhotos(updated);
    } catch (err) {
      notifyError('Assign location', err);
      return;
    }
    setShowAssignModal(false);
    setAssignModalOverridePhotos(null);
    setChosenLocation(null);
    setAssignSearchResults([]);
    setAssignSearchQuery('');

    // Fly map to newly geotagged location
    const map = mapInstanceRef.current;
    if (map) {
      map.flyTo([chosenLocation.lat, chosenLocation.lon], 12, { duration: 1 });
    }
    refreshMarkers();
  };

  /** "Correct Location" (the override path) — same apply logic as handleApplyAssignedLocation,
   *  but fed by LocationPickerModal's pin-on-a-map picker (the same dialog the Lightbox/bulk-edit
   *  use) instead of the plain OpenStreetMap text search, and applied to every photo in the
   *  cluster at once (unlike LocationPickerModal's own single-photo call site in PhotoLightbox). */
  const handleCorrectLocationConfirm = (lat: number, lng: number, label: string) => {
    if (!assignModalOverridePhotos || assignModalOverridePhotos.length === 0) return;
    const cleanLabel = label.trim();
    const updated = assignModalOverridePhotos.map((p) => ({
      ...p,
      location: { latitude: lat, longitude: lng, label: cleanLabel || p.location?.label, city: cleanLabel || p.location?.city },
    }));
    try {
      libraryStore.updatePhotos(updated);
    } catch (err) {
      notifyError('Correct location', err);
      return;
    }
    setShowAssignModal(false);
    setAssignModalOverridePhotos(null);

    const map = mapInstanceRef.current;
    if (map) map.flyTo([lat, lng], 12, { duration: 1 });
    refreshMarkers();
  };

  // Attach dynamic zoom & move listeners to recompute clusters
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map) return;

    refreshMarkers();

    const onMapMove = () => {
      refreshMarkers();
    };

    map.on('moveend', onMapMove);
    map.on('zoomend', onMapMove);

    return () => {
      map.off('moveend', onMapMove);
      map.off('zoomend', onMapMove);
    };
  }, [refreshMarkers]);

  // Fit all photos in view on initial load
  const hasFittedBoundsRef = useRef(false);
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map || geoPhotos.length === 0 || hasFittedBoundsRef.current) return;

    const bounds = L.latLngBounds(geoPhotos.map((p) => [p.location!.latitude, p.location!.longitude]));
    if (bounds.isValid()) {
      map.fitBounds(bounds, { padding: [60, 60], maxZoom: 13 });
      hasFittedBoundsRef.current = true;
    }
  }, [geoPhotos]);

  // Flies to whatever the place search currently matches, so typing a name is a real "find this
  // place" action, not just a pin filter the user has to go hunting for.
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map || !deferredPlacesSearchQuery.trim() || geoPhotos.length === 0) return;
    const bounds = L.latLngBounds(geoPhotos.map((p) => [p.location!.latitude, p.location!.longitude]));
    if (bounds.isValid()) map.flyToBounds(bounds, { padding: [60, 60], maxZoom: 14, duration: 0.8 });
  }, [deferredPlacesSearchQuery, geoPhotos]);

  const handleFitAllPhotos = () => {
    const map = mapInstanceRef.current;
    if (!map || geoPhotos.length === 0) return;
    const bounds = L.latLngBounds(geoPhotos.map((p) => [p.location!.latitude, p.location!.longitude]));
    if (bounds.isValid()) {
      map.flyToBounds(bounds, { padding: [60, 60], maxZoom: 14, duration: 1.2 });
      setSelectedCluster(null);
    }
  };

  // The map container must stay mounted (Leaflet binds to that DOM node once), so the
  // loading state is an overlay rather than an early return.
  const isInitialized = libraryStore.getState().isInitialized;
  const showLoading = !isInitialized && photos.length === 0;
  const loadingOverlay = showLoading ? (
      <div
        style={{
          position: 'absolute',
          inset: 0,
          zIndex: 60,
          backgroundColor: 'var(--bg-app)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '14px',
          color: 'var(--text-muted)',
        }}
      >
        <div
          className="spinner"
          style={{
            width: '36px',
            height: '36px',
            border: '3px solid rgba(56, 189, 248, 0.2)',
            borderTopColor: '#38bdf8',
            borderRadius: '50%',
            animation: 'spin 1s linear infinite',
          }}
        />
        <span style={{ fontSize: '0.95rem' }}>Loading map and geotagged places...</span>
      </div>
  ) : null;

  // Shared JSX built once and arranged differently for desktop vs mobile
  // below — mobile collapses the tile selector / Fit All / Assign Location
  // buttons behind a single "more options" toggle instead of letting them
  // overflow (or wrap into extra rows) next to the title on a phone-width
  // header, mirroring the pattern established in GalleryView.
  const tileSelector = (
    <div
      style={{
        display: 'flex',
        backgroundColor: 'rgba(30, 41, 59, 0.8)',
        padding: '2px',
        borderRadius: '8px',
        border: '1px solid var(--border-subtle)',
      }}
    >
      {(['osm', 'satellite', 'dark'] as const).map((type) => (
        <button
          key={type}
          onClick={() => setActiveTileType(type)}
          style={{
            padding: '4px 10px',
            fontSize: '0.75rem',
            fontWeight: 600,
            border: 'none',
            borderRadius: '6px',
            cursor: 'pointer',
            backgroundColor: activeTileType === type ? 'var(--accent-primary)' : 'transparent',
            color: activeTileType === type ? '#ffffff' : 'var(--text-muted)',
            transition: 'all 0.15s ease',
          }}
        >
          {TILE_LAYERS[type].name}
        </button>
      ))}
    </div>
  );

  const fitAllButton = (
    <button
      onClick={handleFitAllPhotos}
      className="btn btn-secondary"
      title="Center and fit all photos on map"
      style={{
        fontSize: '0.78rem',
        padding: '6px 12px',
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
      }}
    >
      <Compass size={15} />
      <span>Fit All</span>
    </button>
  );

  // Search by place name (city, country, or a custom label) — same pattern as PeopleView's name
  // search. Shown whenever there's at least one geotagged photo to search through.
  const placesSearchInput = allGeoPhotos.length > 0 ? (
    <div style={{ position: 'relative', flex: 1, maxWidth: isMobile ? undefined : '320px' }}>
      <Search
        size={14}
        color="var(--text-muted)"
        style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }}
      />
      <input
        type="text"
        value={placesSearchQuery}
        onChange={(e) => setPlacesSearchQuery(e.target.value)}
        onKeyDown={(e) => e.stopPropagation()}
        placeholder="Search places..."
        className="input"
        style={{ width: '100%', fontSize: '0.82rem', padding: '6px 10px 6px 30px' }}
      />
    </div>
  ) : null;

  const assignLocationButton = unlocatedPhotos.length > 0 ? (
    <button
      onClick={() => {
        setAssignModalOverridePhotos(null);
        setShowAssignModal(true);
      }}
      className="btn btn-secondary"
      title="Assign geographical location to photos without geotags"
      style={{
        fontSize: '0.78rem',
        padding: '6px 12px',
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        color: '#f43f5e',
        borderColor: 'rgba(244, 63, 94, 0.4)',
      }}
    >
      <MapPin size={15} color="#f43f5e" />
      <span>Assign Location ({unlocatedPhotos.length})</span>
    </button>
  ) : null;

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', position: 'relative', overflow: 'hidden' }}>
      {/* Sleek Top Navigation Header */}
      {isMobile ? (
        <div
          style={{
            borderBottom: '1px solid var(--border-subtle)',
            backgroundColor: 'rgba(15, 23, 42, 0.95)',
            backdropFilter: 'blur(12px)',
            zIndex: 30,
          }}
        >
          {/* Row 1: title + a single toggle for everything else, so the
              persistent bar never grows past one compact row. */}
          <div
            style={{
              height: '56px',
              padding: '0 12px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '8px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0, overflow: 'hidden' }}>
              <div
                style={{
                  width: '30px',
                  height: '30px',
                  borderRadius: '9px',
                  backgroundColor: 'rgba(56, 189, 248, 0.15)',
                  border: '1px solid rgba(56, 189, 248, 0.3)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#38bdf8',
                  flexShrink: 0,
                }}
              >
                <MapPin size={16} />
              </div>
              <div style={{ minWidth: 0, overflow: 'hidden' }}>
                <h2 style={{ fontSize: '0.92rem', fontWeight: 700, letterSpacing: '-0.01em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  Photos Map
                </h2>
                <p style={{ fontSize: '0.7rem', color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {placesSearchQuery.trim() && geoPhotos.length === 0
                    ? `No places match "${placesSearchQuery.trim()}"`
                    : `${geoPhotos.length} geotagged ${geoPhotos.length === 1 ? 'photo' : 'photos'}`}
                </p>
              </div>
            </div>
            <button
              className={`btn ${showMobileTools ? 'btn-primary' : 'btn-ghost'} btn-icon`}
              onClick={() => setShowMobileTools((v) => !v)}
              style={{ width: '34px', height: '34px', flexShrink: 0 }}
              title="More options"
              aria-expanded={showMobileTools}
            >
              <MoreVertical size={18} />
            </button>
          </div>

          {/* Search row — always visible (unlike the collapsed tools below), same as PeopleView's
              mobile layout: a primary filter action shouldn't be behind an extra tap. */}
          {placesSearchInput && (
            <div style={{ padding: '0 12px 10px 12px' }}>
              {placesSearchInput}
            </div>
          )}

          {/* Collapsed by default: tile selector / Fit All / Assign Location,
              only taking up space when the user actually asks for them. */}
          {showMobileTools && (
            <div
              style={{
                padding: '10px 12px',
                display: 'flex',
                flexDirection: 'column',
                gap: '10px',
                borderTop: '1px solid var(--border-subtle)',
                backgroundColor: 'rgba(30, 41, 59, 0.6)',
              }}
            >
              {tileSelector}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                {fitAllButton}
                {assignLocationButton}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div
          style={{
            height: '56px',
            padding: '0 20px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderBottom: '1px solid var(--border-subtle)',
            backgroundColor: 'rgba(15, 23, 42, 0.95)',
            backdropFilter: 'blur(12px)',
            zIndex: 30,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div
              style={{
                width: '34px',
                height: '34px',
                borderRadius: '10px',
                backgroundColor: 'rgba(56, 189, 248, 0.15)',
                border: '1px solid rgba(56, 189, 248, 0.3)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#38bdf8',
              }}
            >
              <MapPin size={18} />
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <h2 style={{ fontSize: '1.05rem', fontWeight: 700, letterSpacing: '-0.01em' }}>
                  Photos Map
                </h2>
                <span
                  style={{
                    fontSize: '0.72rem',
                    fontWeight: 700,
                    backgroundColor: 'rgba(56, 189, 248, 0.2)',
                    color: '#38bdf8',
                    padding: '2px 8px',
                    borderRadius: '12px',
                    border: '1px solid rgba(56, 189, 248, 0.3)',
                  }}
                >
                  iPhone Style
                </span>
              </div>
              <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                {placesSearchQuery.trim() && geoPhotos.length === 0
                  ? `No places match "${placesSearchQuery.trim()}"`
                  : `${geoPhotos.length} geotagged ${geoPhotos.length === 1 ? 'photo' : 'photos'} across ${places?.length || 0} locations`}
              </p>
            </div>
          </div>

          {placesSearchInput}

          {/* Map Controls */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {tileSelector}
            {fitAllButton}
            {assignLocationButton}
          </div>
        </div>
      )}

      {/* Main Map Container */}
      <div style={{ flex: 1, position: 'relative', width: '100%', height: '100%' }}>
        <div
          ref={mapContainerRef}
          style={{
            width: '100%',
            height: '100%',
            zIndex: 10,
          }}
        />
        {loadingOverlay}

        {/* Floating Bottom Drawer for Selected Cluster (Apple Photos iOS Style) */}
        {selectedCluster && (
          <div
            style={{
              position: 'absolute',
              bottom: '16px',
              left: '50%',
              transform: 'translateX(-50%)',
              width: 'calc(100% - 32px)',
              maxWidth: '960px',
              maxHeight: '290px',
              backgroundColor: 'rgba(15, 23, 42, 0.94)',
              backdropFilter: 'blur(16px)',
              border: '1px solid rgba(255, 255, 255, 0.15)',
              borderRadius: '18px',
              boxShadow: '0 20px 50px rgba(0, 0, 0, 0.75)',
              zIndex: 40,
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
              animation: 'slideUp 0.25s cubic-bezier(0.16, 1, 0.3, 1)',
            }}
          >
            {/* Drawer Header with Batch Renaming */}
            <div
              style={{
                padding: '12px 18px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
                gap: isMobile ? '10px' : undefined,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: isMobile ? 0 : undefined, flex: isMobile ? 1 : undefined }}>
                <div
                  style={{
                    width: '32px',
                    height: '32px',
                    borderRadius: '8px',
                    backgroundColor: 'rgba(59, 130, 246, 0.2)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: '#60a5fa',
                    flexShrink: 0,
                  }}
                >
                  <MapPin size={16} />
                </div>
                {isEditingClusterLocation ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: isMobile ? 0 : undefined, flex: isMobile ? 1 : undefined }}>
                    <input
                      type="text"
                      value={clusterLocationInput}
                      onChange={(e) => setClusterLocationInput(e.target.value)}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === 'Enter') handleSaveClusterLocationName();
                        if (e.key === 'Escape') setIsEditingClusterLocation(false);
                      }}
                      className="input"
                      placeholder="Enter location name..."
                      style={
                        isMobile
                          ? { fontSize: '0.85rem', padding: '4px 8px', height: '30px', flex: 1, minWidth: 0 }
                          : { fontSize: '0.85rem', padding: '4px 8px', height: '30px', width: '220px' }
                      }
                      autoFocus
                    />
                    <button
                      className="btn btn-primary btn-icon"
                      style={{ width: '28px', height: '28px', padding: 0 }}
                      onClick={handleSaveClusterLocationName}
                      title="Save location name"
                    >
                      <Check size={14} />
                    </button>
                    <button
                      className="btn btn-secondary btn-icon"
                      style={{ width: '28px', height: '28px', padding: 0 }}
                      onClick={() => setIsEditingClusterLocation(false)}
                      title="Cancel"
                    >
                      <X size={14} />
                    </button>
                  </div>
                ) : (
                  <div style={{ minWidth: isMobile ? 0 : undefined }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: isMobile ? 0 : undefined }}>
                      <span
                        style={{
                          fontWeight: 700,
                          fontSize: '0.95rem',
                          color: '#ffffff',
                          ...(isMobile
                            ? { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }
                            : {}),
                        }}
                      >
                        {selectedCluster.title}
                      </span>
                      <button
                        className="btn btn-ghost btn-icon"
                        style={{ width: '24px', height: '24px', padding: 0, flexShrink: 0 }}
                        onClick={() => {
                          setIsEditingClusterLocation(true);
                          setClusterLocationInput(selectedCluster.title);
                        }}
                        title="Rename location for all photos in this cluster"
                      >
                        <Edit2 size={13} color="var(--accent-primary)" />
                      </button>
                      <button
                        className="btn btn-ghost btn-icon"
                        style={{ width: '24px', height: '24px', padding: 0, flexShrink: 0 }}
                        onClick={() => {
                          setAssignModalOverridePhotos(selectedCluster.photos);
                          setShowAssignModal(true);
                        }}
                        title="Correct the coordinates for these photos (search a different place)"
                      >
                        <MapPin size={13} color="#f43f5e" />
                      </button>
                    </div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                      {selectedCluster.photos.length} photos at this location
                      {clusterToast && <span style={{ color: 'var(--accent-emerald)', marginLeft: '10px', fontWeight: 600 }}>{clusterToast}</span>}
                    </div>
                  </div>
                )}
              </div>

              <button
                onClick={() => setSelectedCluster(null)}
                style={{
                  background: 'rgba(255, 255, 255, 0.1)',
                  border: 'none',
                  color: '#ffffff',
                  width: '28px',
                  height: '28px',
                  borderRadius: '50%',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                  transition: 'background 0.15s ease',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255, 255, 255, 0.25)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)')}
              >
                <X size={15} />
              </button>
            </div>

            {/* Horizontal Scroll of Cluster Photos */}
            <div
              ref={clusterTrayRef}
              style={{
                padding: '14px 18px',
                overflowX: 'auto',
                overflowY: 'hidden',
              }}
            >
              <VirtualHorizontalList
                key={selectedCluster.id}
                items={selectedCluster.photos}
                getKey={(photo) => photo.id}
                scrollRef={clusterTrayRef}
                itemWidth={150}
                gap={12}
                renderItem={(photo) => (
                <div
                  onClick={() => onSelectPhoto(photo)}
                  style={{
                    minWidth: '150px',
                    maxWidth: '150px',
                    backgroundColor: 'var(--bg-surface-elevated)',
                    borderRadius: '12px',
                    overflow: 'hidden',
                    cursor: 'pointer',
                    border: '1px solid rgba(255, 255, 255, 0.1)',
                    boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)',
                    transition: 'transform 0.15s ease, box-shadow 0.15s ease',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.transform = 'scale(1.04) translateY(-2px)';
                    e.currentTarget.style.boxShadow = '0 8px 20px rgba(0, 0, 0, 0.5)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.transform = 'scale(1) translateY(0)';
                    e.currentTarget.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.3)';
                  }}
                >
                  <div style={{ height: '110px', position: 'relative' }}>
                    <img
                      src={getLocalPhotoUrl(photo.filePath, photo.originalRemotePath, false)}
                      alt={photo.fileName}
                      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                    />
                    {photo.faces && photo.faces.length > 0 && (
                      <div
                        style={{
                          position: 'absolute',
                          bottom: '6px',
                          left: '6px',
                          background: 'rgba(0, 0, 0, 0.65)',
                          backdropFilter: 'blur(4px)',
                          borderRadius: '10px',
                          padding: '2px 6px',
                          fontSize: '0.65rem',
                          color: '#ffffff',
                          fontWeight: 600,
                        }}
                      >
                        👤 {photo.faces.length}
                      </div>
                    )}
                  </div>
                  <div style={{ padding: '8px 10px' }}>
                    <div
                      style={{
                        fontSize: '0.78rem',
                        fontWeight: 600,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {photo.fileName}
                    </div>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                      {new Date(photo.dateTaken).toLocaleDateString(undefined, {
                        month: 'short',
                        day: 'numeric',
                        year: 'numeric',
                      })}
                    </div>
                  </div>
                </div>
                )}
              />
            </div>
          </div>
        )}

        {/* Correct Location (override mode) now reuses the SAME map-picker dialog the Lightbox and
            bulk-edit use, instead of this view's own separate text-search-only dialog below —
            applied to every photo in the cluster at once via handleCorrectLocationConfirm. */}
        {showAssignModal && isLocationOverrideMode && (
          <LocationPickerModal
            initialLat={assignModalOverridePhotos?.[0]?.location?.latitude}
            initialLng={assignModalOverridePhotos?.[0]?.location?.longitude}
            initialLabel={assignModalOverridePhotos?.[0]?.location?.label || assignModalOverridePhotos?.[0]?.location?.city}
            onConfirm={handleCorrectLocationConfirm}
            onClose={() => {
              setShowAssignModal(false);
              setAssignModalOverridePhotos(null);
            }}
          />
        )}

        {/* Assign Location Modal for Unlocated Photos (plain, non-override case only — see above) */}
        {showAssignModal && !isLocationOverrideMode && (
          <div
            style={{
              position: 'fixed',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              backgroundColor: 'rgba(5, 8, 15, 0.85)',
              backdropFilter: 'blur(8px)',
              zIndex: 3000,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '20px',
            }}
            onClick={() => {
              setShowAssignModal(false);
              setAssignModalOverridePhotos(null);
            }}
          >
            <div
              style={{
                width: '100%',
                maxWidth: '600px',
                maxHeight: '90vh',
                backgroundColor: 'var(--bg-surface)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--radius-lg)',
                boxShadow: '0 24px 64px rgba(0, 0, 0, 0.7)',
                overflow: 'hidden',
                display: 'flex',
                flexDirection: 'column',
              }}
              onClick={(e) => e.stopPropagation()}
            >
              {/* Modal Header */}
              <div
                style={{
                  padding: '16px 20px',
                  borderBottom: '1px solid var(--border-subtle)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  backgroundColor: 'var(--bg-surface-elevated)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <MapPin size={20} color="#f43f5e" />
                  <h3 style={{ fontSize: '1.05rem', fontWeight: 700, margin: 0, color: 'var(--text-primary)' }}>
                    Assign Location ({photosForAssignModal.length} unlocated)
                  </h3>
                </div>
                <button
                  className="btn btn-ghost btn-icon"
                  onClick={() => {
                    setShowAssignModal(false);
                    setAssignModalOverridePhotos(null);
                  }}
                >
                  <X size={18} />
                </button>
              </div>

              {/* Modal Body */}
              <div style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '16px', overflowY: 'auto' }}>
                {/* Search / Pick Location */}
                <div>
                  <label style={{ display: 'block', fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '6px' }}>
                    1. Search Location or Landmark:
                  </label>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <input
                      type="text"
                      placeholder="e.g. Andaman Islands, Paris, Taj Mahal, Goa..."
                      value={assignSearchQuery}
                      onChange={(e) => setAssignSearchQuery(e.target.value)}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          handleSearchPlaces();
                        }
                      }}
                      className="input"
                      style={{ flex: 1, fontSize: '0.85rem' }}
                    />
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={handleSearchPlaces}
                      disabled={isSearchingPlaces || !assignSearchQuery.trim()}
                      style={{ fontSize: '0.85rem', gap: '6px' }}
                    >
                      <Search size={14} />
                      <span>{isSearchingPlaces ? 'Searching...' : 'Search'}</span>
                    </button>
                  </div>

                  {/* Search Results */}
                  {assignSearchResults.length > 0 && (
                    <div
                      style={{
                        marginTop: '8px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '4px',
                        maxHeight: '130px',
                        overflowY: 'auto',
                        border: '1px solid var(--border-subtle)',
                        borderRadius: '8px',
                        padding: '6px',
                        backgroundColor: 'var(--bg-surface-elevated)',
                      }}
                    >
                      {assignSearchResults.map((res, i) => (
                        <div
                          key={i}
                          onClick={() => setChosenLocation(res)}
                          style={{
                            padding: '6px 10px',
                            borderRadius: '6px',
                            fontSize: '0.8rem',
                            cursor: 'pointer',
                            backgroundColor: chosenLocation?.name === res.name ? 'rgba(59, 130, 246, 0.2)' : 'transparent',
                            color: chosenLocation?.name === res.name ? 'var(--accent-primary)' : 'var(--text-primary)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                          }}
                        >
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{res.name}</span>
                          <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                            {res.lat.toFixed(3)}°, {res.lon.toFixed(3)}°
                          </span>
                        </div>
                      ))}
                    </div>
                  )}

                  {chosenLocation && (
                    <div
                      style={{
                        marginTop: '8px',
                        padding: '8px 12px',
                        borderRadius: '8px',
                        backgroundColor: 'rgba(16, 185, 129, 0.15)',
                        border: '1px solid rgba(16, 185, 129, 0.3)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        fontSize: '0.82rem',
                      }}
                    >
                      <span style={{ color: '#10b981', fontWeight: 600 }}>Selected: {chosenLocation.name}</span>
                      <span style={{ color: 'var(--text-muted)', fontSize: '0.72rem' }}>
                        ({chosenLocation.lat.toFixed(4)}°, {chosenLocation.lon.toFixed(4)}°)
                      </span>
                    </div>
                  )}
                </div>

                {/* Photo selection list */}
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                    <label style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-secondary)' }}>
                      2. Select Photos to Tag ({selectedUnlocatedIds.size} of {photosForAssignModal.length} selected):
                    </label>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      style={{ fontSize: '0.75rem', padding: '2px 8px' }}
                      onClick={() => {
                        if (selectedUnlocatedIds.size === photosForAssignModal.length) {
                          setSelectedUnlocatedIds(new Set());
                        } else {
                          setSelectedUnlocatedIds(new Set(photosForAssignModal.map((p) => p.id)));
                        }
                      }}
                    >
                      {selectedUnlocatedIds.size === photosForAssignModal.length ? 'Deselect All' : 'Select All'}
                    </button>
                  </div>

                  <div
                    ref={assignGridScrollRef}
                    style={{
                      maxHeight: '180px',
                      overflowY: 'auto',
                      padding: '4px',
                    }}
                  >
                    <VirtualCardGrid
                      items={photosForAssignModal}
                      getKey={(p) => p.id}
                      scrollRef={assignGridScrollRef}
                      rowHeight={80}
                      minColWidth={100}
                      gap={8}
                      renderItem={(p) => {
                      const isSel = selectedUnlocatedIds.has(p.id);
                      return (
                        <div
                          onClick={() => {
                            setSelectedUnlocatedIds((prev) => {
                              const next = new Set(prev);
                              if (next.has(p.id)) next.delete(p.id);
                              else next.add(p.id);
                              return next;
                            });
                          }}
                          style={{
                            position: 'relative',
                            height: '100%',
                            boxSizing: 'border-box',
                            borderRadius: '8px',
                            overflow: 'hidden',
                            border: isSel ? '2px solid var(--accent-primary)' : '1px solid var(--border-subtle)',
                            cursor: 'pointer',
                          }}
                        >
                          <img
                            src={getLocalPhotoUrl(p.thumbnailPath || p.filePath, p.originalRemotePath, false)}
                            alt={p.fileName}
                            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                          />
                          <div
                            style={{
                              position: 'absolute',
                              top: '4px',
                              right: '4px',
                              backgroundColor: isSel ? 'var(--accent-primary)' : 'rgba(0,0,0,0.6)',
                              borderRadius: '4px',
                              padding: '2px',
                            }}
                          >
                            {isSel ? <Check size={12} color="#fff" strokeWidth={3} /> : <div style={{ width: '12px', height: '12px' }} />}
                          </div>
                        </div>
                      );
                      }}
                    />
                  </div>
                </div>
              </div>

              {/* Modal Footer */}
              <div
                style={{
                  padding: '14px 20px',
                  borderTop: '1px solid var(--border-subtle)',
                  display: 'flex',
                  justifyContent: 'flex-end',
                  gap: '10px',
                  backgroundColor: 'var(--bg-surface-elevated)',
                }}
              >
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => {
                    setShowAssignModal(false);
                    setAssignModalOverridePhotos(null);
                  }}
                  style={{ fontSize: '0.85rem' }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={handleApplyAssignedLocation}
                  disabled={!chosenLocation || selectedUnlocatedIds.size === 0}
                  style={{ fontSize: '0.85rem', gap: '6px', padding: '6px 18px' }}
                >
                  <Check size={15} />
                  <span>Assign to {selectedUnlocatedIds.size} Photos</span>
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
