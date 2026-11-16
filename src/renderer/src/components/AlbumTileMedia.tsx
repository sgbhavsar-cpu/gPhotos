import React, { useEffect, useRef, useState } from 'react';
import { RotateCw, Maximize2 } from 'lucide-react';
import type { Photo } from '../../../types';
import { getLocalPhotoUrl, libraryStore } from '../services/libraryStore';
import { afterPhotoRotated } from '../services/photoRotation';
import { authFetch } from '../services/webAuthClient';
import { notifyError } from '../services/notifications';

const round: React.CSSProperties = {
  position: 'absolute', bottom: '34px', zIndex: 15, width: '28px', height: '28px', borderRadius: '6px',
  display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: 'white',
  backgroundColor: 'rgba(15, 23, 42, 0.85)', border: '2px solid rgba(255, 255, 255, 0.9)', boxShadow: '0 2px 8px rgba(0,0,0,0.6)',
};

/**
 * An album tile's picture plus its hover controls: quick-rotate (90° steps, saved to the file 2s after the
 * last click — same behaviour as the Photos grid) and view-full-screen.
 */
export const AlbumTileMedia: React.FC<{ photo: Photo; onOpen: () => void }> = ({ photo, onOpen }) => {
  const [rot, setRot] = useState(0);
  const [bust, setBust] = useState(0);
  const pending = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const photoRef = useRef(photo);
  photoRef.current = photo;

  const persist = async () => {
    const deg = pending.current;
    if (!deg) return;
    pending.current = 0;
    const p = photoRef.current;
    try {
      let res: any = null;
      if (window.electronAPI?.rotatePhoto) res = await window.electronAPI.rotatePhoto(p.filePath, deg, p.originalRemotePath);
      else {
        const r = await authFetch('/api/rotate-photo', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filePath: p.filePath, originalRemotePath: p.originalRemotePath, rotationDegrees: deg }),
        });
        if (r.ok) res = await r.json();
      }
      if (!res || res.success === false) throw new Error(res?.error || res?.message || 'The photo could not be rotated on disk');
      if (res?.isHeic || res?.isHeicRotated || /\.(heic|heif)$/i.test(p.filePath) || /\.(heic|heif)$/i.test(p.originalRemotePath || '')) {
        const n = res?.heicRotation ?? (((p.heicRotation || p.rotation || 0) + deg) % 360);
        libraryStore.updatePhoto({ ...p, isHeicRotated: n !== 0, heicRotation: n, rotation: n });
      }
      void afterPhotoRotated(p, deg, 250);
      setRot(0);
      setBust(Date.now());
    } catch (err) {
      setRot(0);
      notifyError('Rotate photo', err);
    }
  };
  // Save a pending rotation if the tile goes away before the 2s are up.
  const persistRef = useRef(persist);
  persistRef.current = persist;
  useEffect(() => () => { if (timer.current) { clearTimeout(timer.current); void persistRef.current(); } }, []);

  const rotate = (e: React.MouseEvent) => {
    e.stopPropagation();
    setRot((r) => (r + 90) % 360);
    pending.current = (pending.current + 90) % 360;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { timer.current = null; void persist(); }, 2000);
  };

  const src = getLocalPhotoUrl(photo.filePath, photo.originalRemotePath);
  return (
    <>
      <img
        src={bust ? `${src}${src.includes('?') ? '&' : '?'}cb=${bust}` : src}
        alt={photo.fileName}
        loading="lazy"
        draggable={false}
        style={{ width: '100%', height: '100%', objectFit: 'cover', transform: rot ? `rotate(${rot}deg)` : undefined, transition: 'transform 0.2s ease' }}
      />
      {!photo.isVideo && (
        <div data-hover-ctl role="button" aria-label="Rotate 90° clockwise" title={rot ? 'Rotating (saving in 2s)…' : 'Quick Rotate (90° clockwise)'} onClick={rotate} style={{ ...round, right: '8px' }}>
          <RotateCw size={14} />
        </div>
      )}
      <div data-hover-ctl role="button" aria-label="View full screen" title="View full screen" onClick={(e) => { e.stopPropagation(); onOpen(); }}
        style={{ ...round, right: photo.isVideo ? '8px' : '44px' }}>
        <Maximize2 size={14} />
      </div>
    </>
  );
};
