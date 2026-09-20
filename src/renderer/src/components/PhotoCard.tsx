import React, { useState, useRef, useEffect } from 'react';
import { Heart, MapPin, Users, Check, EyeOff, Image as ImageIcon, ImageOff, RotateCw } from 'lucide-react';
import { Photo } from '../../types';
import { getLocalPhotoUrl, libraryStore } from '../services/libraryStore';
import { useBatchThumbnail, useSpriteCoordinate, getSpriteUrl, batchThumbnailStore, evictAndRefreshThumbnail } from '../services/asyncImageLoader';
import { authFetch } from '../services/webAuthClient';

interface PhotoCardProps {
  photo: Photo;
  onClick: (e: React.MouseEvent) => void;
  onToggleFavorite: (e: React.MouseEvent) => void;
  size?: 'very_small' | 'small' | 'medium' | 'large';
  isSelected?: boolean;
  onToggleSelect?: (e: React.MouseEvent) => void;
  isSelectMode?: boolean;
  onCardMouseDown?: (photoId: string, e: React.MouseEvent) => void;
  onCardMouseEnter?: (photoId: string, e: React.MouseEvent) => void;
}

const PhotoCardComponent: React.FC<PhotoCardProps> = ({
  photo,
  onClick,
  onToggleFavorite,
  size = 'medium',
  isSelected = false,
  onToggleSelect,
  isSelectMode = false,
  onCardMouseDown,
  onCardMouseEnter,
}) => {
  const [isHovered, setIsHovered] = useState(false);
  const [imgElementLoaded, setImgElementLoaded] = useState(false);

  // Instant local visual rotation on thumbnail (0ms latency feedback during clicks)
  const [visualRotation, setVisualRotation] = useState<number>(0);
  const [cacheBuster, setCacheBuster] = useState<number>(0);
  const debounceTimerRef = useRef<any>(null);
  const pendingRotationDeltaRef = useRef<number>(0);

  // Clean up timer on unmount
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  const heightMap: Record<string, string> = {
    very_small: '80px',
    small: '130px',
    medium: '210px',
    large: '290px',
  };

  const formattedDate = new Date(photo.dateTaken).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });

  const pixelSizeMap: Record<string, number> = {
    very_small: 150,
    small: 200,
    medium: 300,
    large: 500,
  };

  const photoPath = photo.thumbnailPath || photo.filePath;
  const isHeic = /\.(heic|heif)$/i.test(photo.fileName || photo.filePath || photo.originalRemotePath || '');
  const targetPixelSize = pixelSizeMap[size] || 250;

  // 0. High-Speed Static WebP Sprite Sheet Coordinate (1 static WebP for 50 thumbnails, 0ms render)
  const spriteCoord = useSpriteCoordinate(photoPath);

  // 1. Batch thumbnail loader (0ms from memory when pre-fetched, 1 HTTP call for 100 photos!)
  const { src: batchSrc, isLoading: isBatchLoading, hasError: isBatchError } = useBatchThumbnail(
    photoPath,
    photo.originalRemotePath,
    targetPixelSize
  );

  // 2. Fallback direct URL if running in native Electron
  const directUrl = getLocalPhotoUrl(
    photoPath,
    photo.originalRemotePath,
    false,
    targetPixelSize
  );

  const isRotated = !!photo.isHeicRotated || (photo.heicRotation || photo.rotation || 0) !== 0;
  const isElectron = typeof window !== 'undefined' && !!(window.electronAPI && !(window.electronAPI as any).isBrowserShim);
  const displaySrc = (isRotated ? directUrl : batchSrc) || (isElectron ? directUrl : null);
  const canUseSprite = !!(spriteCoord && !hasError && !isRotated);
  const hasThumbnail = !!(canUseSprite || displaySrc);
  const isLoading = !hasThumbnail && isBatchLoading;
  const hasError = !hasThumbnail && isBatchError;

  /**
   * Hover quick-rotate: Rotates thumbnail instantly in the UI.
   * Debounces for 2 seconds; if no further rotate clicks occur, pushes rotation to actual image file on disk!
   */
  const handleQuickRotate = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();

    const nextRot = (visualRotation + 90) % 360;
    setVisualRotation(nextRot);
    pendingRotationDeltaRef.current = (pendingRotationDeltaRef.current + 90) % 360;

    // Reset 2-second debounce timer
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    debounceTimerRef.current = setTimeout(async () => {
      const degreesToRotate = pendingRotationDeltaRef.current;
      if (degreesToRotate === 0) return;
      pendingRotationDeltaRef.current = 0;

      const localPath = photo.filePath;
      const remotePath = photo.originalRemotePath;
      try {
        let res: any = null;
        if (window.electronAPI?.rotatePhoto) {
          res = await window.electronAPI.rotatePhoto(localPath, degreesToRotate, remotePath);
        } else {
          const fetchRes = await authFetch('/api/rotate-photo', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              filePath: localPath,
              originalRemotePath: remotePath,
              rotationDegrees: degreesToRotate,
            }),
          });
          if (fetchRes.ok) res = await fetchRes.json();
        }

        // For HEIC photos: update photo in libraryStore so isHeicRotated and rotation flag persist in library.json
        const isHeic = /\.(heic|heif)$/i.test(localPath) || /\.(heic|heif)$/i.test(remotePath || '');
        if (res?.isHeic || isHeic || res?.isHeicRotated) {
          const newRot = res?.heicRotation ?? (((photo.heicRotation || photo.rotation || 0) + degreesToRotate) % 360);
          libraryStore.updatePhoto({
            ...photo,
            isHeicRotated: newRot !== 0,
            heicRotation: newRot,
            rotation: newRot,
          });
        }

        // Evict and immediately re-request fresh batch thumbnail from backend
        evictAndRefreshThumbnail(photoPath, remotePath, targetPixelSize);
        // Reset CSS rotation because thumbnail image pixels on disk are now physically rotated
        setVisualRotation(0);
        setCacheBuster(Date.now());
      } catch (err) {
        console.error('[PhotoCard] Failed to persist rotated photo to disk:', err);
      }
    }, 2000);
  };

  return (
    <div
      onClick={onClick}
      onMouseDown={(e) => onCardMouseDown && onCardMouseDown(photo.id, e)}
      onMouseEnter={(e) => {
        setIsHovered(true);
        if (onCardMouseEnter) onCardMouseEnter(photo.id, e);
      }}
      onMouseLeave={() => setIsHovered(false)}
      onDragStart={(e) => e.preventDefault()}
      style={{
        position: 'relative',
        height: heightMap[size] || '210px',
        borderRadius: 'var(--radius-md)',
        overflow: 'hidden',
        backgroundColor: 'var(--bg-surface-elevated)',
        cursor: 'pointer',
        boxShadow: isHovered ? 'var(--shadow-md)' : 'var(--shadow-sm)',
        transform: isHovered ? 'scale(1.02)' : 'scale(1)',
        border: isSelected ? '2px solid var(--accent-primary)' : '2px solid transparent',
        transition: 'transform var(--transition-normal), box-shadow var(--transition-normal), border var(--transition-fast)',
        opacity: photo.isExcluded ? 0.55 : 1,
        userSelect: 'none',
      }}
    >
      {/* Asynchronous Skeleton Shimmer Loading Placeholder */}
      {isLoading && (
        <div
          className="skeleton-shimmer"
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: 'var(--bg-surface-elevated)',
            zIndex: 1,
          }}
        >
          <ImageIcon size={26} color="rgba(255, 255, 255, 0.18)" />
        </div>
      )}

      {/* Graceful Fallback if Image is Unavailable or Timed Out */}
      {hasError && (
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '6px',
            backgroundColor: 'var(--bg-surface-elevated)',
            color: 'var(--text-muted)',
            padding: '8px',
            textAlign: 'center',
            zIndex: 1,
          }}
        >
          <ImageOff size={22} color="rgba(255, 255, 255, 0.25)" />
          <span style={{ fontSize: '10px', color: 'var(--text-muted)', maxWidth: '90%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {photo.fileName}
          </span>
        </div>
      )}

      {/* 1. Ultra-High Performance Static WebP Sprite Tile (0 CPU overhead, 1 transfer for 50 cards) */}
      {canUseSprite && spriteCoord && (
        <div
          title={photo.fileName}
          style={{
            width: '100%',
            height: '100%',
            backgroundImage: `url(${getSpriteUrl(spriteCoord)})`,
            backgroundPosition: `${(spriteCoord.col / 9) * 100}% ${(spriteCoord.row / 4) * 100}%`,
            backgroundSize: '1000% 500%',
            backgroundRepeat: 'no-repeat',
            position: 'relative',
            zIndex: 2,
            transform: visualRotation ? `rotate(${visualRotation}deg)` : undefined,
            transition: 'transform 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
          }}
        />
      )}

      {/* 2. Fallback Batch / Direct Photo Display */}
      {!canUseSprite && displaySrc && !hasError && (
        <img
          src={
            (cacheBuster || isRotated) && !displaySrc.startsWith('data:')
              ? `${displaySrc}${displaySrc.includes('?') ? '&' : '?'}cb=${cacheBuster || photo.heicRotation || photo.rotation || 1}`
              : displaySrc
          }
          alt={photo.fileName}
          decoding="async"
          onLoad={() => setImgElementLoaded(true)}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            opacity: imgElementLoaded ? 1 : 0,
            transition: 'opacity 0.2s ease-out, transform 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
            imageOrientation: 'from-image' as any,
            position: 'relative',
            zIndex: 2,
            transform: visualRotation ? `rotate(${visualRotation}deg)` : undefined,
          }}
        />
      )}

      {/* Multi-Selection Checkbox */}
      {(isSelectMode || isHovered || isSelected) && onToggleSelect && (
        <div
          onClick={(e) => {
            e.stopPropagation();
            onToggleSelect(e);
          }}
          style={{
            position: 'absolute',
            top: '8px',
            left: '8px',
            zIndex: 15,
            width: '28px',
            height: '28px',
            borderRadius: '6px',
            backgroundColor: isSelected ? 'var(--accent-primary)' : 'rgba(15, 23, 42, 0.85)',
            border: isSelected ? 'none' : '2px solid rgba(255, 255, 255, 0.9)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0 2px 8px rgba(0,0,0,0.6)',
            cursor: 'pointer',
            transition: 'all var(--transition-fast)',
          }}
          title={isSelected ? 'Deselect photo' : 'Select photo'}
        >
          {isSelected && <Check size={18} color="white" strokeWidth={3} />}
        </div>
      )}

      {/* Quick Rotate Button on Hover (like checkbox for selection appears) - Enabled for all photos including HEIC */}
      {(isHovered || visualRotation !== 0) && (
        <div
          onClick={handleQuickRotate}
          style={{
            position: 'absolute',
            top: '8px',
            right: '8px',
            zIndex: 15,
            width: '28px',
            height: '28px',
            borderRadius: '6px',
            backgroundColor: visualRotation !== 0 ? 'var(--accent-primary)' : 'rgba(15, 23, 42, 0.85)',
            border: visualRotation !== 0 ? '1px solid var(--accent-primary)' : '2px solid rgba(255, 255, 255, 0.9)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0 2px 8px rgba(0,0,0,0.6)',
            cursor: 'pointer',
            transition: 'all var(--transition-fast)',
            color: 'white',
          }}
          title={visualRotation !== 0 ? `Rotating (saving in 2s)...` : "Quick Rotate (90° clockwise)"}
        >
          <RotateCw
            size={16}
            style={{
              transform: visualRotation !== 0 ? 'rotate(90deg)' : 'none',
              transition: 'transform 0.2s ease',
            }}
          />
        </div>
      )}

      {/* Hover Overlay */}
      <div style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: 'linear-gradient(180deg, rgba(0,0,0,0.4) 0%, transparent 40%, rgba(0,0,0,0.65) 100%)',
        opacity: isHovered ? 1 : 0,
        transition: 'opacity var(--transition-fast)',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        padding: '10px',
        pointerEvents: isHovered ? 'auto' : 'none',
      }}>
        {/* Top bar: Quick rotate, Badges, Favorite heart */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingLeft: onToggleSelect ? '28px' : '0' }}>
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
            {photo.location && (
              <span style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '3px',
                fontSize: '11px',
                padding: '2px 7px',
                borderRadius: 'var(--radius-full)',
                backgroundColor: 'rgba(15, 23, 42, 0.75)',
                backdropFilter: 'blur(6px)',
                color: 'var(--accent-cyan)',
                fontWeight: 600,
              }}>
                <MapPin size={11} />
                {photo.location.city || 'GPS'}
              </span>
            )}
            {photo.faces && photo.faces.length > 0 ? (
              <span style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '3px',
                fontSize: '11px',
                padding: '2px 7px',
                borderRadius: 'var(--radius-full)',
                backgroundColor: 'rgba(15, 23, 42, 0.75)',
                backdropFilter: 'blur(6px)',
                color: '#ec4899',
                fontWeight: 600,
              }}>
                <Users size={11} />
                {photo.faces.length}
              </span>
            ) : photo.faceScanCompleted ? (
              <span style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '3px',
                fontSize: '11px',
                padding: '2px 7px',
                borderRadius: 'var(--radius-full)',
                backgroundColor: 'rgba(71, 85, 105, 0.85)',
                backdropFilter: 'blur(6px)',
                color: '#cbd5e1',
                fontWeight: 500,
              }} title="No faces detected (scenery / objects / documents)">
                <EyeOff size={11} />
                No Faces
              </span>
            ) : null}

            {photo.isHeicRotated && (
              <span style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '3px',
                fontSize: '11px',
                padding: '2px 7px',
                borderRadius: 'var(--radius-full)',
                backgroundColor: 'rgba(15, 23, 42, 0.75)',
                backdropFilter: 'blur(6px)',
                color: 'var(--accent-primary)',
                fontWeight: 600,
              }} title={`HEIC thumbnail rotated ${photo.heicRotation || photo.rotation || 90}°`}>
                <RotateCw size={10} />
                HEIC {photo.heicRotation || photo.rotation || 90}°
              </span>
            )}

            {photo.isExcluded && (
              <span style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '3px',
                fontSize: '11px',
                padding: '2px 7px',
                borderRadius: 'var(--radius-full)',
                backgroundColor: 'rgba(239, 68, 68, 0.85)',
                color: 'white',
                fontWeight: 600,
              }}>
                Hidden
              </span>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginRight: '34px' }}>
            {/* Favorite button */}
            <button
              onClick={onToggleFavorite}
              style={{
                background: 'rgba(15, 23, 42, 0.75)',
                backdropFilter: 'blur(6px)',
                border: 'none',
                borderRadius: 'var(--radius-full)',
                width: '32px',
                height: '32px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                color: photo.isFavorite ? 'var(--accent-rose)' : 'white',
                transition: 'transform var(--transition-fast)',
                boxShadow: '0 2px 6px rgba(0,0,0,0.5)',
              }}
              title={photo.isFavorite ? 'Remove from favorites' : 'Add to favorites'}
            >
              <Heart size={16} fill={photo.isFavorite ? 'currentColor' : 'none'} />
            </button>
          </div>
        </div>

        {/* Bottom bar: Date and filename */}
        <div>
          <div style={{ fontSize: '12px', fontWeight: 600, color: 'white', textShadow: '0 1px 3px rgba(0,0,0,0.8)' }}>
            {formattedDate}
          </div>
          <div style={{
            fontSize: '11px',
            color: 'var(--text-secondary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {photo.fileName}
          </div>
        </div>
      </div>
    </div>
  );
};

export const PhotoCard = React.memo(PhotoCardComponent, (prev, next) => {
  return (
    prev.photo.id === next.photo.id &&
    prev.photo.rotation === next.photo.rotation &&
    prev.photo.isHeicRotated === next.photo.isHeicRotated &&
    prev.photo.heicRotation === next.photo.heicRotation &&
    prev.photo.isFavorite === next.photo.isFavorite &&
    prev.photo.isExcluded === next.photo.isExcluded &&
    prev.photo.filePath === next.photo.filePath &&
    prev.photo.thumbnailPath === next.photo.thumbnailPath &&
    prev.isSelected === next.isSelected &&
    prev.isSelectMode === next.isSelectMode &&
    prev.size === next.size
  );
});
