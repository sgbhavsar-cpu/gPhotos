import React, { useState, useEffect, useRef } from 'react';
import { Users } from 'lucide-react';
import { Photo } from '../../types';
import { getLocalPhotoUrl } from '../services/libraryStore';

interface FaceAvatarProps {
  photo?: Photo;
  box?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  size?: number;
  alt?: string;
  borderRadius?: string;
}

export const FaceAvatar: React.FC<FaceAvatarProps> = ({
  photo,
  box,
  size = 110,
  alt = 'Face Avatar',
  borderRadius = 'var(--radius-full)',
}) => {
  const [croppedDataUrl, setCroppedDataUrl] = useState<string | null>(null);
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    if (!photo) {
      setCroppedDataUrl(null);
      return;
    }

    // If no bounding box is provided, fallback to standard full image
    if (!box || !box.width || !box.height) {
      setCroppedDataUrl(getLocalPhotoUrl(photo.filePath));
      return;
    }

    let isCancelled = false;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = getLocalPhotoUrl(photo.filePath);

    img.onload = () => {
      if (isCancelled) return;
      try {
        const canvas = document.createElement('canvas');
        const targetSize = size * 2; // 2x for retina / high-DPI sharpness
        canvas.width = targetSize;
        canvas.height = targetSize;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        // Scale box coordinates if detected on different resolution
        let scaledBox = { ...box };
        if (box.x + box.width > img.naturalWidth || box.y + box.height > img.naturalHeight) {
          const photoW = photo.width || 4000;
          const photoH = photo.height || 3000;
          const scaleX = img.naturalWidth / photoW;
          const scaleY = img.naturalHeight / photoH;
          scaledBox = {
            x: Math.round(box.x * scaleX),
            y: Math.round(box.y * scaleY),
            width: Math.round(box.width * scaleX),
            height: Math.round(box.height * scaleY),
          };
        } else if (img.naturalWidth > 1000 && box.x + box.width <= 505 && photo.width && photo.width > 505) {
          const scale = 500 / Math.max(photo.width, photo.height || 1);
          const thumbW = Math.max(1, Math.round(photo.width * scale));
          const thumbH = Math.max(1, Math.round((photo.height || photo.width) * scale));
          const scaleX = img.naturalWidth / thumbW;
          const scaleY = img.naturalHeight / thumbH;
          scaledBox = {
            x: Math.round(box.x * scaleX),
            y: Math.round(box.y * scaleY),
            width: Math.round(box.width * scaleX),
            height: Math.round(box.height * scaleY),
          };
        }

        // Calculate face crop with 35% margin for portrait look
        const padding = 0.35;
        const padW = scaledBox.width * padding;
        const padH = scaledBox.height * padding;

        const rawX = Math.max(0, scaledBox.x - padW);
        const rawY = Math.max(0, scaledBox.y - padH);
        const rawW = Math.min(img.naturalWidth - rawX, scaledBox.width + padW * 2);
        const rawH = Math.min(img.naturalHeight - rawY, scaledBox.height + padH * 2);

        // Make square crop centered on face
        const side = Math.max(rawW, rawH);
        const cropX = Math.max(0, Math.min(img.naturalWidth - side, rawX - (side - rawW) / 2));
        const cropY = Math.max(0, Math.min(img.naturalHeight - side, rawY - (side - rawH) / 2));
        const cropSide = Math.min(side, img.naturalWidth - cropX, img.naturalHeight - cropY);

        ctx.drawImage(img, cropX, cropY, cropSide, cropSide, 0, 0, targetSize, targetSize);
        setCroppedDataUrl(canvas.toDataURL('image/jpeg', 0.88));
      } catch (err) {
        console.warn('Failed to crop face avatar canvas:', err);
        setCroppedDataUrl(getLocalPhotoUrl(photo.filePath));
      }
    };

    img.onerror = () => {
      if (!isCancelled) setHasError(true);
    };

    return () => {
      isCancelled = true;
    };
  }, [photo?.filePath, box?.x, box?.y, box?.width, box?.height, size]);

  if (!photo || hasError) {
    return (
      <div style={{
        width: `${size}px`,
        height: `${size}px`,
        borderRadius,
        backgroundColor: 'var(--bg-surface-elevated)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--text-muted)',
      }}>
        <Users size={Math.round(size * 0.4)} />
      </div>
    );
  }

  return (
    <div style={{
      width: `${size}px`,
      height: `${size}px`,
      borderRadius,
      overflow: 'hidden',
      backgroundColor: 'var(--bg-surface-elevated)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    }}>
      {croppedDataUrl ? (
        <img
          src={croppedDataUrl}
          alt={alt}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            display: 'block',
          }}
        />
      ) : (
        <div style={{ width: '100%', height: '100%', backgroundColor: '#1e293b' }} />
      )}
    </div>
  );
};
