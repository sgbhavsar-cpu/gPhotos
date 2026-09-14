import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react';
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
} from 'lucide-react';
import { Photo, PlaceAlbum } from '../../types';
import { PhotoCard } from '../components/PhotoCard';
import { libraryStore, getLocalPhotoUrl } from '../services/libraryStore';

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
  },
  satellite: {
    name: 'Satellite',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: '&copy; Esri, Maxar, Earthstar Geographics',
  },
  dark: {
    name: 'Dark',
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    attribution: '&copy; OpenStreetMap &copy; CARTO',
  },
};

export const PlacesMapView: React.FC<PlacesMapViewProps> = ({
  photos,
  places = [],
  onSelectPhoto,
  onToggleFavorite,
  resetTrigger,
}) => {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<L.Map | null>(null);
  const currentTileLayerRef = useRef<L.TileLayer | null>(null);
  const markersLayerRef = useRef<L.LayerGroup | null>(null);

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

      if (showAssignModal) {
        e.stopPropagation();
        setShowAssignModal(false);
        setAssignModalOverridePhotos(null);
      } else if (isEditingClusterLocation) {
        e.stopPropagation();
        setIsEditingClusterLocation(false);
      } else if (selectedCluster) {
        e.stopPropagation();
        setSelectedCluster(null);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
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

  // Initialize all target photos as selected when opening assign modal
  useEffect(() => {
    if (showAssignModal) {
      setSelectedUnlocatedIds(new Set(photosForAssignModal.map((p) => p.id)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showAssignModal, assignModalOverridePhotos, unlocatedPhotos]);

  // All valid geotagged photos
  const geoPhotos = useMemo(() => {
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

  // Dynamic screen-space clustering function
  const computeClusters = useCallback(
    (map: L.Map, clusterPixelThreshold = 55): PhotoCluster[] => {
      if (geoPhotos.length === 0) return [];

      const clusters: {
        photos: Photo[];
        screenPt: L.Point;
        sumLat: number;
        sumLng: number;
      }[] = [];

      for (const photo of geoPhotos) {
        const lat = photo.location!.latitude;
        const lng = photo.location!.longitude;
        const pt = map.latLngToLayerPoint([lat, lng]);

        let matched = false;
        for (const cluster of clusters) {
          const dist = pt.distanceTo(cluster.screenPt);
          if (dist <= clusterPixelThreshold) {
            cluster.photos.push(photo);
            cluster.sumLat += lat;
            cluster.sumLng += lng;
            // Update center point smoothly
            cluster.screenPt = L.point(
              (cluster.screenPt.x + pt.x) / 2,
              (cluster.screenPt.y + pt.y) / 2
            );
            matched = true;
            break;
          }
        }

        if (!matched) {
          clusters.push({
            photos: [photo],
            screenPt: pt,
            sumLat: lat,
            sumLng: lng,
          });
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
      subdomains: 'abcd',
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
      subdomains: 'abcd',
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

      const html = `
        <div class="pin-bubble" title="${cluster.title} (${cluster.subtitle})">
          <img src="${thumbUrl}" class="pin-thumbnail" alt="${cluster.title}" />
          ${isMulti ? `<div class="pin-badge">${cluster.photos.length}</div>` : ''}
          <div class="pin-pointer"></div>
          <div class="pin-title-pill">
            <span class="pin-title-text">${cluster.title}</span>
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
          onSelectPhoto(cluster.photos[0]);
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
  }, [geoPhotos, computeClusters, onSelectPhoto]);

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
    libraryStore.updatePhotos(updatedPhotos);
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
      const data = await res.json();
      if (Array.isArray(data)) {
        const results = data.map((item: any) => ({
          name: item.display_name.split(',').slice(0, 3).join(','),
          lat: parseFloat(item.lat),
          lon: parseFloat(item.lon),
        }));
        setAssignSearchResults(results);
        if (results.length > 0) {
          setChosenLocation(results[0]);
        }
      }
    } catch (err) {
      console.warn('Place search error:', err);
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
    libraryStore.updatePhotos(updated);
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

  const handleFitAllPhotos = () => {
    const map = mapInstanceRef.current;
    if (!map || geoPhotos.length === 0) return;
    const bounds = L.latLngBounds(geoPhotos.map((p) => [p.location!.latitude, p.location!.longitude]));
    if (bounds.isValid()) {
      map.flyToBounds(bounds, { padding: [60, 60], maxZoom: 14, duration: 1.2 });
      setSelectedCluster(null);
    }
  };

  const isInitialized = libraryStore.getState().isInitialized;
  if (!isInitialized && photos.length === 0) {
    return (
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
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
    );
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', position: 'relative', overflow: 'hidden' }}>
      {/* Sleek Top Navigation Header */}
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
              {geoPhotos.length} geotagged {geoPhotos.length === 1 ? 'photo' : 'photos'} across {places?.length || 0} locations
            </p>
          </div>
        </div>

        {/* Map Controls */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {/* Tile Layer Selector */}
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

          {/* Fit All Photos Button */}
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

          {/* Assign Location to unlocated photos Button */}
          {unlocatedPhotos.length > 0 && (
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
          )}
        </div>
      </div>

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
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
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
                  }}
                >
                  <MapPin size={16} />
                </div>
                {isEditingClusterLocation ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
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
                      style={{ fontSize: '0.85rem', padding: '4px 8px', height: '30px', width: '220px' }}
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
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span style={{ fontWeight: 700, fontSize: '0.95rem', color: '#ffffff' }}>
                        {selectedCluster.title}
                      </span>
                      <button
                        className="btn btn-ghost btn-icon"
                        style={{ width: '24px', height: '24px', padding: 0 }}
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
                        style={{ width: '24px', height: '24px', padding: 0 }}
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
              style={{
                padding: '14px 18px',
                display: 'flex',
                gap: '12px',
                overflowX: 'auto',
                overflowY: 'hidden',
              }}
            >
              {selectedCluster.photos.map((photo) => (
                <div
                  key={photo.id}
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
              ))}
            </div>
          </div>
        )}

        {/* Assign Location Modal for Unlocated Photos */}
        {showAssignModal && (
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
                    {isLocationOverrideMode
                      ? `Correct Location (${photosForAssignModal.length} photos)`
                      : `Assign Location (${photosForAssignModal.length} unlocated)`}
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
                {isLocationOverrideMode && (
                  <div
                    style={{
                      padding: '10px 14px',
                      borderRadius: '8px',
                      backgroundColor: 'rgba(244, 63, 94, 0.12)',
                      border: '1px solid rgba(244, 63, 94, 0.35)',
                      fontSize: '0.8rem',
                      color: 'var(--text-secondary)',
                    }}
                  >
                    These photos already have a location. Applying a new one below will
                    <strong> overwrite their existing GPS coordinates and place name.</strong> This cannot be undone automatically.
                  </div>
                )}
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
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fill, minmax(100px, 1fr))',
                      gap: '8px',
                      maxHeight: '180px',
                      overflowY: 'auto',
                      padding: '4px',
                    }}
                  >
                    {photosForAssignModal.map((p) => {
                      const isSel = selectedUnlocatedIds.has(p.id);
                      return (
                        <div
                          key={p.id}
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
                            height: '80px',
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
                    })}
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
                  <span>{isLocationOverrideMode ? 'Overwrite' : 'Assign to'} {selectedUnlocatedIds.size} Photos</span>
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
