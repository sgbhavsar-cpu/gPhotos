import React from 'react';
import { X } from 'lucide-react';
import type { Photo, VideoAspectRatio, VideoCollageStyle } from '../../../types';
import { computeCollageTiles } from '../../../types/collageLayout';
import { getLocalPhotoUrl } from '../services/libraryStore';

interface CollageStylePickerProps {
  /** The 2-4 photos about to be combined, in the order they'll be placed. */
  photos: Photo[];
  aspectRatio: VideoAspectRatio;
  onPick: (style: VideoCollageStyle) => void;
  onCancel: () => void;
}

const STYLES: Array<{ value: VideoCollageStyle; label: string; hint: string }> = [
  { value: 'grid', label: 'Grid', hint: 'Balanced tiles' },
  { value: 'sideBySide', label: 'Side by Side', hint: 'Equal columns' },
  { value: 'stacked', label: 'Stacked', hint: 'Equal rows' },
  { value: 'featured', label: 'Featured', hint: 'One big, rest small' },
];

const PREVIEW_W = 200;
const previewHeight = (aspect: VideoAspectRatio) => {
  const [w, h] = aspect.split(':').map(Number);
  return Math.round((PREVIEW_W * h) / w);
};

/**
 * The popup shown after choosing the photos for a collage: one live preview per layout style,
 * drawn with the very same layout math the video renderer uses (types/collageLayout.ts), so the
 * thumbnail you click is exactly the frame you'll get.
 */
export const CollageStylePicker: React.FC<CollageStylePickerProps> = ({ photos, aspectRatio, onPick, onCancel }) => {
  const height = previewHeight(aspectRatio);

  return (
    <div
      style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.78)', backdropFilter: 'blur(8px)', zIndex: 1300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' }}
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div className="animate-in" style={{ backgroundColor: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-lg)', width: '100%', maxWidth: '560px', padding: '20px', display: 'flex', flexDirection: 'column', gap: '16px', boxShadow: '0 25px 50px -12px rgba(0,0,0,0.7)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0, fontSize: '1rem' }}>Choose a Collage Style</h3>
          <button className="btn btn-ghost btn-icon" onClick={onCancel} title="Cancel"><X size={18} /></button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '14px' }}>
          {STYLES.map((s) => {
            const tiles = computeCollageTiles(photos.length, s.value, PREVIEW_W, height, 3);
            return (
              <button
                key={s.value}
                data-testid={`collage-style-${s.value}`}
                onClick={() => onPick(s.value)}
                style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '10px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-subtle)', background: 'transparent', cursor: 'pointer', textAlign: 'left', color: 'inherit' }}
              >
                <div style={{ position: 'relative', width: '100%', aspectRatio: `${PREVIEW_W} / ${height}`, backgroundColor: '#000', borderRadius: 'var(--radius-sm)', overflow: 'hidden' }}>
                  {tiles.map((t, i) => photos[i] && (
                    <img
                      key={photos[i].id}
                      src={getLocalPhotoUrl(photos[i].filePath, photos[i].originalRemotePath, false, 160)}
                      alt=""
                      style={{
                        position: 'absolute', objectFit: 'cover',
                        left: `${(t.x / PREVIEW_W) * 100}%`, top: `${(t.y / height) * 100}%`,
                        width: `${(t.w / PREVIEW_W) * 100}%`, height: `${(t.h / height) * 100}%`,
                      }}
                    />
                  ))}
                </div>
                <div>
                  <div style={{ fontWeight: 600, fontSize: '0.88rem' }}>{s.label}</div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{s.hint}</div>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
};
