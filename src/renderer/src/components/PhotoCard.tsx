import React, { useState } from 'react';
import { Heart, MapPin, Users, Check, EyeOff, Image as ImageIcon, ImageOff } from 'lucide-react';
import { Photo } from '../../types';
import { getLocalPhotoUrl } from '../services/libraryStore';
import { useBatchThumbnail, useSpriteCoordinate, getSpriteUrl } from '../services/asyncImageLoader';

interface PhotoCardProps {
  photo: Photo;
  onClick: () => void;
  onToggleFavorite: (e: React.MouseEvent) => void;
  size?: 'very_small' | 'small' | 'medium' | 'large';
  isSelected?: boolean;
  onToggleSelect?: (e: React.MouseEvent) => void;
  isSelectMode?: boolean;
}

export const PhotoCard: React.FC<PhotoCardProps> = ({
  photo,
  onClick,
  onToggleFavorite,
  size = 'medium',
  isSelected = false,
  onToggleSelect,
  isSelectMode = false,
}) => {
  const [isHovered, setIsHovered] = useState(false);
  const [imgElementLoaded, setImgElementLoaded] = useState(false);

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
  const targetPixelSize = pixelSizeMap[size] || 250;

  // 0. High-Speed Static Sprite Sheet Coordinate (1 static WebP for 50 thumbnails, 0ms render)
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

  const isElectron = typeof window !== 'undefined' && !!(window.electronAPI && !(window.electronAPI as any).isBrowserShim);
  const displaySrc = batchSrc || (isElectron ? directUrl : null);
  const hasThumbnail = !!(spriteCoord || displaySrc);
  const isLoading = !hasThumbnail && isBatchLoading;
  const hasError = !hasThumbnail && isBatchError;

  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
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
      {spriteCoord && !hasError && (
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
          }}
        />
      )}

      {/* 2. Fallback Batch / Direct Photo Display */}
      {!spriteCoord && displaySrc && !hasError && (
        <img
          src={displaySrc}
          alt={photo.fileName}
          decoding="async"
          onLoad={() => setImgElementLoaded(true)}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            opacity: imgElementLoaded ? 1 : 0,
            transition: 'opacity 0.2s ease-out',
            imageOrientation: 'from-image' as any,
            position: 'relative',
            zIndex: 2,
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
        {/* Top bar: Favorite heart & badges */}
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

          <button
            onClick={onToggleFavorite}
            style={{
              background: 'rgba(15, 23, 42, 0.75)',
              backdropFilter: 'blur(6px)',
              border: 'none',
              borderRadius: 'var(--radius-full)',
              width: '34px',
              height: '34px',
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
            <Heart size={18} fill={photo.isFavorite ? 'currentColor' : 'none'} />
          </button>
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
