import React, { useState } from 'react';
import { X, Calendar, MapPin, Check, Sparkles } from 'lucide-react';
import { Photo, LocationMetadata } from '../../types';
import { libraryStore } from '../services/libraryStore';
import { LocationPickerModal } from './LocationPickerModal';

interface BulkEditModalProps {
  photos: Photo[];
  onClose: () => void;
}

/**
 * Applies a single date/time and/or location to every selected photo at
 * once. Each field has its own "apply" checkbox so the user can change just
 * one without touching the other. Date writes also try to update each
 * photo's actual file (EXIF for JPEG, mtime for everything) — same
 * best-effort behavior as the single-photo editor in PhotoLightbox.
 */
export const BulkEditModal: React.FC<BulkEditModalProps> = ({ photos, onClose }) => {
  const [applyDate, setApplyDate] = useState(false);
  const [dateInput, setDateInput] = useState('');
  const [applyLocation, setApplyLocation] = useState(false);
  const [locationInput, setLocationInput] = useState('');
  const [pickedLatLng, setPickedLatLng] = useState<{ lat: number; lng: number } | null>(null);
  const [showLocationPicker, setShowLocationPicker] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [resultMessage, setResultMessage] = useState<string | null>(null);

  const canApply = (applyDate && !!dateInput) || (applyLocation && !!locationInput.trim());

  const handleApply = async () => {
    if (!canApply || isSaving) return;
    setIsSaving(true);
    setResultMessage(null);

    let newDateIso: string | null = null;
    if (applyDate && dateInput) {
      const d = new Date(dateInput);
      if (!isNaN(d.getTime())) newDateIso = d.toISOString();
    }

    let newLocation: LocationMetadata | null = null;
    if (applyLocation) {
      if (pickedLatLng) {
        const label = locationInput.trim() || undefined;
        newLocation = { latitude: pickedLatLng.lat, longitude: pickedLatLng.lng, label, city: label };
      } else if (locationInput.trim()) {
        try {
          const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(locationInput.trim())}&limit=1`);
          const data = await res.json();
          if (Array.isArray(data) && data[0]) {
            newLocation = {
              latitude: parseFloat(data[0].lat),
              longitude: parseFloat(data[0].lon),
              label: locationInput.trim(),
              city: locationInput.trim(),
            };
          }
        } catch (err) {
          console.warn('[BulkEditModal] Geocoding failed:', err);
        }
      }
    }

    if ((newDateIso || newLocation) && window.electronAPI?.writePhotoMetadata) {
      const update = {
        ...(newDateIso ? { dateIso: newDateIso } : {}),
        ...(newLocation ? { latitude: newLocation.latitude, longitude: newLocation.longitude } : {}),
      };
      await Promise.all(
        photos.map((p) => window.electronAPI!.writePhotoMetadata!(p.filePath, update, p.originalRemotePath).catch(() => null))
      );
    }

    const updated = photos.map((p) => ({
      ...p,
      ...(newDateIso ? { dateTaken: newDateIso } : {}),
      ...(newLocation ? { location: newLocation } : {}),
    }));
    libraryStore.updatePhotos(updated, !!newLocation);

    setIsSaving(false);
    setResultMessage(
      applyLocation && locationInput.trim() && !newLocation
        ? `Updated date, but couldn't find map coordinates for "${locationInput.trim()}" — use Pin on Map instead.`
        : `✓ Updated ${photos.length} photo${photos.length === 1 ? '' : 's'}.`
    );
    if (newDateIso || newLocation) {
      setTimeout(onClose, 1300);
    }
  };

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
        zIndex: 3500,
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
          maxWidth: '460px',
          backgroundColor: 'var(--bg-surface)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: '0 24px 64px rgba(0, 0, 0, 0.7)',
          overflow: 'hidden',
        }}
      >
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h3 style={{ fontSize: '1.1rem', fontWeight: 700, margin: 0, color: 'var(--text-primary)' }}>
            Edit {photos.length} Photo{photos.length === 1 ? '' : 's'}
          </h3>
          <button className="btn btn-ghost btn-icon" onClick={onClose} style={{ width: '32px', height: '32px' }}>
            <X size={18} />
          </button>
        </div>

        <div style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '18px' }}>
          {/* Date section */}
          <div>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.85rem', fontWeight: 600, marginBottom: '8px', cursor: 'pointer' }}>
              <input type="checkbox" checked={applyDate} onChange={(e) => setApplyDate(e.target.checked)} />
              <Calendar size={14} />
              <span>Set Date &amp; Time</span>
            </label>
            {applyDate && (
              <input
                type="datetime-local"
                value={dateInput}
                onChange={(e) => setDateInput(e.target.value)}
                className="input"
                style={{ width: '100%', fontSize: '0.85rem' }}
              />
            )}
          </div>

          {/* Location section */}
          <div>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.85rem', fontWeight: 600, marginBottom: '8px', cursor: 'pointer' }}>
              <input type="checkbox" checked={applyLocation} onChange={(e) => setApplyLocation(e.target.checked)} />
              <MapPin size={14} />
              <span>Set Location</span>
            </label>
            {applyLocation && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <div style={{ display: 'flex', gap: '6px' }}>
                  <input
                    type="text"
                    value={locationInput}
                    onChange={(e) => {
                      setLocationInput(e.target.value);
                      setPickedLatLng(null);
                    }}
                    placeholder="e.g. Paris, Eiffel Tower, Home"
                    className="input"
                    style={{ flex: 1, fontSize: '0.85rem' }}
                  />
                  <button
                    className="btn btn-secondary"
                    onClick={() => setShowLocationPicker(true)}
                    style={{ fontSize: '0.78rem', padding: '6px 10px', gap: '4px' }}
                    title="Pin exact location on map"
                  >
                    <MapPin size={13} />
                    <span>Pin on Map</span>
                  </button>
                </div>
                <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                  {pickedLatLng
                    ? `Pinned at ${pickedLatLng.lat.toFixed(5)}°, ${pickedLatLng.lng.toFixed(5)}°`
                    : 'Type a name (auto-located) or pin it precisely on the map'}
                </div>
              </div>
            )}
          </div>

          {resultMessage && (
            <div style={{ fontSize: '0.8rem', color: 'var(--accent-emerald)', fontWeight: 600 }}>{resultMessage}</div>
          )}
        </div>

        <div style={{ padding: '14px 20px', borderTop: '1px solid var(--border-subtle)', display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
          <button className="btn btn-ghost" onClick={onClose} disabled={isSaving}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={handleApply} disabled={!canApply || isSaving} style={{ gap: '6px' }}>
            {isSaving ? <Sparkles size={15} className="animate-spin" /> : <Check size={15} />}
            <span>{isSaving ? 'Applying...' : `Apply to ${photos.length}`}</span>
          </button>
        </div>
      </div>

      {showLocationPicker && (
        <LocationPickerModal
          initialLat={pickedLatLng?.lat}
          initialLng={pickedLatLng?.lng}
          initialLabel={locationInput}
          onConfirm={(lat, lng, label) => {
            setPickedLatLng({ lat, lng });
            if (label) setLocationInput(label);
            setShowLocationPicker(false);
          }}
          onClose={() => setShowLocationPicker(false)}
        />
      )}
    </div>
  );
};
