import React, { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import { X, Search, Check, MapPin } from 'lucide-react';

interface LocationPickerModalProps {
  initialLat?: number;
  initialLng?: number;
  initialLabel?: string;
  onConfirm: (lat: number, lng: number, label: string) => void;
  onClose: () => void;
}

const PIN_ICON = L.divIcon({
  className: 'location-picker-pin',
  html: '<div style="width:22px;height:22px;border-radius:50% 50% 50% 0;background:#ef4444;border:2px solid white;transform:rotate(-45deg);box-shadow:0 2px 6px rgba(0,0,0,0.4);"></div>',
  iconSize: [22, 22],
  iconAnchor: [11, 22],
});

/**
 * Manual fallback for when a typed place name can't be geocoded (or the
 * user just wants precision): a plain Leaflet map where clicking anywhere
 * drops/moves a draggable pin. Search box is optional — it only re-centers
 * the map, the pin's actual position is whatever the user clicks/drags.
 */
export const LocationPickerModal: React.FC<LocationPickerModalProps> = ({
  initialLat,
  initialLng,
  initialLabel,
  onConfirm,
  onClose,
}) => {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);
  const hasInitialPin = initialLat != null && initialLng != null && (initialLat !== 0 || initialLng !== 0);
  const [pin, setPin] = useState<{ lat: number; lng: number } | null>(
    hasInitialPin ? { lat: initialLat as number, lng: initialLng as number } : null
  );
  const [label, setLabel] = useState(initialLabel || '');
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);

  const placePin = (lat: number, lng: number) => {
    setPin({ lat, lng });
    const map = mapInstanceRef.current;
    if (!map) return;
    if (markerRef.current) {
      markerRef.current.setLatLng([lat, lng]);
    } else {
      markerRef.current = L.marker([lat, lng], { icon: PIN_ICON, draggable: true }).addTo(map);
      markerRef.current.on('dragend', () => {
        const pos = markerRef.current!.getLatLng();
        setPin({ lat: pos.lat, lng: pos.lng });
      });
    }
  };

  useEffect(() => {
    if (!mapContainerRef.current || mapInstanceRef.current) return;

    const map = L.map(mapContainerRef.current, {
      center: [pin?.lat ?? 20, pin?.lng ?? 0],
      zoom: pin ? 12 : 2,
      zoomControl: false,
      attributionControl: false,
    });
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      subdomains: 'abc',
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map);

    map.on('click', (e: L.LeafletMouseEvent) => placePin(e.latlng.lat, e.latlng.lng));
    mapInstanceRef.current = map;
    if (pin) placePin(pin.lat, pin.lng);

    return () => {
      map.remove();
      mapInstanceRef.current = null;
      markerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSearch = async () => {
    const query = searchQuery.trim();
    if (!query) return;
    setIsSearching(true);
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=1`);
      const data = await res.json();
      if (Array.isArray(data) && data[0]) {
        const lat = parseFloat(data[0].lat);
        const lng = parseFloat(data[0].lon);
        placePin(lat, lng);
        if (!label.trim()) setLabel(query);
        mapInstanceRef.current?.flyTo([lat, lng], 13, { duration: 0.8 });
      }
    } catch (err) {
      console.warn('[LocationPickerModal] Search failed:', err);
    } finally {
      setIsSearching(false);
    }
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // capture + stopImmediatePropagation so App.tsx's global Escape
        // handler (also bound to window) doesn't ALSO fire and, e.g., pop
        // tab navigation on top of just closing this modal.
        e.stopImmediatePropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, [onClose]);

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(5, 8, 15, 0.88)',
        backdropFilter: 'blur(10px)',
        zIndex: 4000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: '720px',
          height: '600px',
          maxHeight: '85vh',
          backgroundColor: 'var(--bg-surface)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: '0 24px 64px rgba(0, 0, 0, 0.7)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <MapPin size={20} color="var(--accent-cyan)" />
            <h3 style={{ fontSize: '1.1rem', fontWeight: 700, margin: 0, color: 'var(--text-primary)' }}>Set Location on Map</h3>
          </div>
          <button className="btn btn-ghost btn-icon" onClick={onClose} style={{ width: '32px', height: '32px' }}>
            <X size={18} />
          </button>
        </div>

        <div style={{ padding: '12px 20px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', gap: '8px' }}>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') {
                e.preventDefault();
                handleSearch();
              }
            }}
            placeholder="Search a place to jump the map there..."
            className="input"
            style={{ flex: 1, fontSize: '0.85rem' }}
          />
          <button
            className="btn btn-secondary"
            onClick={handleSearch}
            disabled={isSearching || !searchQuery.trim()}
            style={{ fontSize: '0.8rem' }}
          >
            <Search size={14} />
            <span>{isSearching ? 'Searching...' : 'Search'}</span>
          </button>
        </div>

        <div ref={mapContainerRef} style={{ flex: 1, minHeight: 0 }} />

        <div style={{ padding: '14px 20px', borderTop: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
          <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
            {pin ? `${pin.lat.toFixed(5)}°, ${pin.lng.toFixed(5)}° — drag the pin to fine-tune` : 'Click anywhere on the map to drop a pin'}
          </div>
          <button
            className="btn btn-primary"
            disabled={!pin}
            onClick={() => pin && onConfirm(pin.lat, pin.lng, label.trim())}
            style={{ fontSize: '0.85rem' }}
          >
            <Check size={16} />
            <span>Use This Location</span>
          </button>
        </div>
      </div>
    </div>
  );
};
