import React, { useState, useEffect, useRef } from 'react';
import { Users } from 'lucide-react';
import { Photo, DetectedFace } from '../../types';
import { getLocalPhotoUrl } from '../services/libraryStore';

interface FaceAvatarProps {
  photo?: Photo;
  face?: DetectedFace;
  box?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  imageWidth?: number;
  imageHeight?: number;
  size?: number;
  alt?: string;
  borderRadius?: string;
}

export const FaceAvatar: React.FC<FaceAvatarProps> = ({
  photo,
  face,
  box: explicitBox,
  imageWidth,
  imageHeight,
  size = 110,
  alt = 'Face Avatar',
  borderRadius = 'var(--radius-full)',
}) => {
  const [croppedDataUrl, setCroppedDataUrl] = useState<string | null>(null);
  const [hasError, setHasError] = useState(false);

  // Use explicit box if passed, or fall back to face.box
  const box = explicitBox || face?.box;

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

        // Determine the base resolution on which the face bounding box was detected
        let baseW = face?.imageWidth || imageWidth;
        let baseH = face?.imageHeight || imageHeight;

        if (!baseW || !baseH) {
          // Check if matching face exists in photo.faces
          const matchedFace =
            photo.faces?.find(
              (f) => f.box && Math.abs(f.box.x - box.x) < 3 && Math.abs(f.box.y - box.y) < 3
            ) || photo.faces?.[0];

          if (matchedFace?.imageWidth && matchedFace?.imageHeight) {
            baseW = matchedFace.imageWidth;
            baseH = matchedFace.imageHeight;
          } else if (photo.width && photo.height && photo.width > 0 && photo.height > 0) {
            baseW = photo.width;
            baseH = photo.height;
          }
        }

        // Calculate normalized 0..1 bounding box
        let normX: number;
        let normY: number;
        let normW: number;
        let normH: number;

        if (baseW && baseH && baseW > 0 && baseH > 0) {
          normX = box.x / baseW;
          normY = box.y / baseH;
          normW = box.width / baseW;
          normH = box.height / baseH;
        } else if (box.x + box.width <= 505 && box.y + box.height <= 505 && img.naturalWidth > 505) {
          const scale = 500 / Math.max(img.naturalWidth, img.naturalHeight);
          const thumbW = Math.max(1, Math.round(img.naturalWidth * scale));
          const thumbH = Math.max(1, Math.round(img.naturalHeight * scale));
          normX = box.x / thumbW;
          normY = box.y / thumbH;
          normW = box.width / thumbW;
          normH = box.height / thumbH;
        } else if (box.x + box.width <= img.naturalWidth && box.y + box.height <= img.naturalHeight) {
          normX = box.x / img.naturalWidth;
          normY = box.y / img.naturalHeight;
          normW = box.width / img.naturalWidth;
          normH = box.height / img.naturalHeight;
        } else {
          const estW = Math.max(img.naturalWidth, box.x + box.width);
          const estH = Math.max(img.naturalHeight, box.y + box.height);
          normX = box.x / estW;
          normY = box.y / estH;
          normW = box.width / estW;
          normH = box.height / estH;
        }

        normX = Math.max(0, Math.min(1, normX));
        normY = Math.max(0, Math.min(1, normY));
        normW = Math.max(0, Math.min(1 - normX, normW));
        normH = Math.max(0, Math.min(1 - normY, normH));

        const scaledBox = {
          x: Math.round(normX * img.naturalWidth),
          y: Math.round(normY * img.naturalHeight),
          width: Math.round(normW * img.naturalWidth),
          height: Math.round(normH * img.naturalHeight),
        };

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
  }, [photo?.filePath, box?.x, box?.y, box?.width, box?.height, face?.id, face?.imageWidth, face?.imageHeight, imageWidth, imageHeight, size]);

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
