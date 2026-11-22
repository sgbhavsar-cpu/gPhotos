import React, { useEffect, useRef, useState } from 'react';
import { RotateCw, Maximize2, Play, Image as ImageIcon, ImageOff } from 'lucide-react';
import type { Photo } from '../../../types';
import { getLocalPhotoUrl, libraryStore } from '../services/libraryStore';
import { useBatchThumbnail, useSpriteCoordinate, getSpriteUrl } from '../services/asyncImageLoader';
import { afterPhotoRotated } from '../services/photoRotation';
import { authFetch } from '../services/webAuthClient';
import { notifyError } from '../services/notifications';

const round: React.CSSProperties = {
  position: 'absolute', bottom: '34px', zIndex: 15, width: '28px', height: '28px', borderRadius: '6px',
  display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: 'white',
  backgroundColor: 'rgba(15, 23, 42, 0.85)', border: '2px solid rgba(255, 255, 255, 0.9)', boxShadow: '0 2px 8px rgba(0,0,0,0.6)',
};
const fill: React.CSSProperties = { position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' };
const ROTATE_DELAY_MS = 5000;

/**
 * An album tile's picture plus its hover controls: quick-rotate (90° steps, saved to the file 5s after the
 * last click — same behaviour as the Photos grid) and view-full-screen.
 *
 * The picture comes through the SAME pipeline as the Photos grid (PhotoCard): a pre-built sprite-sheet tile
 * when there is one (one transfer for 50 photos), otherwise the batched thumbnail loader (one call for up
 * to 100 photos), then the direct URL. Videos get the same play badge, "no preview" card and hover clip.
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
  // Save a pending rotation if the tile goes away before the wait is up.
  const persistRef = useRef(persist);
  persistRef.current = persist;
  useEffect(() => () => { if (timer.current) { clearTimeout(timer.current); void persistRef.current(); } }, []);

  const rotate = (e: React.MouseEvent) => {
    e.stopPropagation();
    setRot((r) => (r + 90) % 360);
    pending.current = (pending.current + 90) % 360;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { timer.current = null; void persist(); }, ROTATE_DELAY_MS);
  };

  const photoPath = photo.thumbnailPath || photo.filePath;
  const spriteCoord = useSpriteCoordinate(photoPath);
  const { src: batchSrc, isLoading: isBatchLoading, hasError: isBatchError } = useBatchThumbnail(photoPath, photo.originalRemotePath, 300);
  const directUrl = getLocalPhotoUrl(photoPath, photo.originalRemotePath, false, 300);
  const isRotated = !!photo.isHeicRotated || (photo.heicRotation || photo.rotation || 0) !== 0;
  const isElectron = typeof window !== 'undefined' && !!(window.electronAPI && !(window.electronAPI as any).isBrowserShim);
  const displaySrc = (isRotated || bust ? directUrl : batchSrc) || (isElectron ? directUrl : null);
  const canUseSprite = !!(spriteCoord && !isRotated && !bust);
  const hasThumbnail = canUseSprite || !!displaySrc;
  const [imgFailed, setImgFailed] = useState(false);
  useEffect(() => setImgFailed(false), [photoPath]);
  const isLoading = !hasThumbnail && isBatchLoading;
  const hasError = (!hasThumbnail && isBatchError) || imgFailed;
  const videoNoPreview = !!photo.isVideo && (hasError || (!hasThumbnail && !isLoading));

  // Videos: resting the mouse on the tile for ~0.7s plays the cached 5-second clip in a loop.
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hovered = useRef(false);
  useEffect(() => () => { if (hoverTimer.current) clearTimeout(hoverTimer.current); }, []);
  const onEnter = () => {
    if (!photo.isVideo) return;
    hovered.current = true;
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(async () => {
      const api = window.electronAPI as any;
      if (!hovered.current || !api?.getVideoPreview) return;
      const res = await api.getVideoPreview(photo.filePath, photo.originalRemotePath).catch(() => null);
      if (res?.path && hovered.current) setPreviewUrl(getLocalPhotoUrl(res.path, undefined, true, 0));
    }, 700);
  };
  const onLeave = () => {
    hovered.current = false;
    if (hoverTimer.current) { clearTimeout(hoverTimer.current); hoverTimer.current = null; }
    setPreviewUrl(null);
  };

  const rotStyle: React.CSSProperties = { transform: rot ? `rotate(${rot}deg)` : undefined, transition: 'transform 0.2s ease' };
  return (
    <>
      <div style={fill} onMouseEnter={onEnter} onMouseLeave={onLeave}>
        {isLoading && (
          <div className="skeleton-shimmer" style={{ ...fill, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1 }}>
            <ImageIcon size={26} color="rgba(255, 255, 255, 0.18)" />
          </div>
        )}
        {videoNoPreview && !previewUrl && (
          <div
            title="No preview image for this video. It plays by streaming from its storage, so the storage must be online."
            style={{ ...fill, zIndex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', gap: '4px', padding: '8px 8px 34px', textAlign: 'center', background: 'linear-gradient(135deg, #1e293b, #0f172a)', color: 'var(--text-muted)' }}
          >
            <span style={{ fontSize: '10px', fontWeight: 800, letterSpacing: '0.08em', color: 'rgba(255,255,255,0.7)' }}>{(photo.fileName?.split('.').pop() || 'video').toUpperCase()} VIDEO</span>
            <span style={{ fontSize: '10px', maxWidth: '90%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{photo.fileName}</span>
            <span style={{ fontSize: '9px', opacity: 0.7 }}>No preview · plays from storage</span>
          </div>
        )}
        {hasError && !photo.isVideo && (
          <div style={{ ...fill, zIndex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '6px', backgroundColor: 'var(--bg-surface-elevated)', color: 'var(--text-muted)', padding: '8px', textAlign: 'center' }}>
            <ImageOff size={22} color="rgba(255, 255, 255, 0.25)" />
            <span style={{ fontSize: '10px', maxWidth: '90%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{photo.fileName}</span>
          </div>
        )}
        {canUseSprite && spriteCoord && (
          <div
            title={photo.fileName}
            style={{ ...fill, backgroundImage: `url(${getSpriteUrl(spriteCoord)})`, backgroundPosition: `${(spriteCoord.col / 9) * 100}% ${(spriteCoord.row / 4) * 100}%`, backgroundSize: '1000% 500%', backgroundRepeat: 'no-repeat', zIndex: 2, ...rotStyle }}
          />
        )}
        {!canUseSprite && displaySrc && !hasError && !videoNoPreview && (
          <img
            src={(bust || isRotated) && !displaySrc.startsWith('data:') ? `${displaySrc}${displaySrc.includes('?') ? '&' : '?'}cb=${bust || photo.heicRotation || photo.rotation || 1}` : displaySrc}
            alt={photo.fileName}
            decoding="async"
            draggable={false}
            onError={() => setImgFailed(true)}
            style={{ ...fill, objectFit: 'cover', zIndex: 2, imageOrientation: 'from-image' as any, ...rotStyle }}
          />
        )}
        {photo.isVideo && previewUrl && (
          <video src={previewUrl} autoPlay muted loop playsInline style={{ ...fill, objectFit: 'cover', zIndex: 3 }} />
        )}
        {photo.isVideo && !previewUrl && (
          <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', zIndex: 11, width: '44px', height: '44px', borderRadius: '50%', backgroundColor: 'rgba(15, 23, 42, 0.55)', border: '2px solid rgba(255, 255, 255, 0.85)', display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
            <Play size={20} color="white" fill="white" style={{ marginLeft: '2px' }} />
          </div>
        )}
      </div>
      {!photo.isVideo && (
        <div data-hover-ctl role="button" aria-label="Rotate 90° clockwise" title={rot ? 'Rotating (saving 5s after the last click)…' : 'Quick Rotate (90° clockwise)'} onClick={rotate} style={{ ...round, right: '8px' }}>
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
