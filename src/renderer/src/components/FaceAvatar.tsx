import React, { useState, useEffect, useRef } from 'react';
import { Users } from 'lucide-react';
import { Photo, DetectedFace } from '../../types';
import { getLocalPhotoUrl } from '../services/libraryStore';
import { useAvatarSprite } from '../services/avatarSpriteLoader';
import { getSpriteUrl } from '../services/asyncImageLoader';

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
  /**
   * When set, this is a person's profile photo (not a one-off face crop):
   * the cropped image is cached to a local file under the app's userData
   * folder, keyed by personId + a cache key derived from the source
   * face/photo. On future renders the local file is used directly, so the
   * profile photo keeps showing even if the source photo's network storage
   * is offline or a different storage is currently selected. The cache key
   * should change whenever the underlying cover face/photo changes (e.g.
   * pass face?.id ?? photo?.id) so a cover-face change invalidates the old
   * cached crop instead of leaving it stale.
   */
  personId?: string;
  /**
   * Crops from the full-resolution original (network/OneDrive-backed photos
   * fall back to the cached thumbnail if the original isn't reachable) —
   * for a small always-visible avatar this isn't worth the extra fetch, but
   * for a one-off "which face should represent this person" cover picker,
   * cropping a small region out of an already-downscaled thumbnail just
   * upscales compression artifacts into a visibly blurry avatar.
   */
  preferOriginal?: boolean;
  /**
   * Render this person's cover from a pre-baked avatar sprite sheet (one
   * transfer for ~50 avatars) instead of loading a file per avatar. For the
   * People grid. `coverKey` is the person's coverFaceId — it lets the tile be
   * looked up before the cover photo/face objects have loaded.
   */
  preferSprite?: boolean;
  coverKey?: string;
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
  personId,
  preferOriginal = false,
  preferSprite = false,
  coverKey,
}) => {
  const [croppedDataUrl, setCroppedDataUrl] = useState<string | null>(null);
  const [hasError, setHasError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => { setRetry(0); }, [croppedDataUrl]);

  // Use explicit box if passed, or fall back to face.box
  const box = explicitBox || face?.box;
  // With a coverKey (the person's coverFaceId) the saved avatar and the sprite
  // lookup share one key. Without it, the crop was saved under whichever face
  // this card happened to render, which could differ from coverFaceId and
  // leave that person permanently without a sprite tile.
  const avatarCacheKey = coverKey || face?.id || photo?.id || '';
  const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
  const usesPersonCache = Boolean(personId && avatarCacheKey && api?.getPersonAvatarPath);
  const sprite = useAvatarSprite(personId, avatarCacheKey, preferSprite);

  useEffect(() => {
    // Sprite mode: the tile is (or is about to be) the image, so skip the
    // per-avatar file load. Only when the person has no avatar file yet
    // ('none') do we crop live from the source photo — which also saves the
    // avatar so the next sprite lookup finds it.
    if (sprite.status === 'pending' || sprite.status === 'ready') return;

    if (!photo) {
      setCroppedDataUrl(null);
      return;
    }

    // If no bounding box is provided, fallback to standard full image
    if (!box || !box.width || !box.height) {
      setCroppedDataUrl(getLocalPhotoUrl(photo.filePath, photo.originalRemotePath, preferOriginal));
      return;
    }

    let isCancelled = false;
    let finalShown = false;
    let provisionalShown = false;

    // isFinal=false is a quick provisional crop from the local thumbnail; the
    // final crop (from the original when preferOriginal) replaces it and is
    // the one persisted as the person's avatar.
    const cropLiveFromSource = (
      sourceUrl: string = getLocalPhotoUrl(photo.filePath, photo.originalRemotePath, preferOriginal),
      isFinal = true
    ) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.src = sourceUrl;

      img.onload = () => {
        if (isCancelled || (!isFinal && finalShown)) return;
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
        const dataUrl = canvas.toDataURL('image/jpeg', 0.88);
        setCroppedDataUrl(dataUrl);
        if (isFinal) finalShown = true;
        else provisionalShown = true;

        // Persist this crop locally so it's available next time without
        // needing the (possibly network) source photo at all.
        if (isFinal && usesPersonCache) {
          api!.savePersonAvatar!(personId!, avatarCacheKey, dataUrl).catch(() => {});
        }
      } catch (err) {
        console.warn('Failed to crop face avatar canvas:', err);
        setCroppedDataUrl(getLocalPhotoUrl(photo.filePath));
      }
      };

      img.onerror = () => {
        // A failed provisional load is harmless; a failed final one only
        // becomes an error state if nothing was shown in the meantime.
        if (!isCancelled && isFinal && !provisionalShown) setHasError(true);
      };
    };

    // Cloud-backed originals (OneDrive) can take many seconds to fetch, which
    // left cards blank. Show a crop from the local 500px thumbnail right away,
    // then upgrade to the original when it arrives.
    const startCrop = () => {
      if (preferOriginal && photo.originalRemotePath) {
        cropLiveFromSource(getLocalPhotoUrl(photo.filePath, undefined, false, 500), false);
      }
      cropLiveFromSource();
    };

    if (usesPersonCache) {
      api!.getPersonAvatarPath!(personId!, avatarCacheKey).then((localPath) => {
        if (isCancelled) return;
        if (localPath) {
          setCroppedDataUrl(getLocalPhotoUrl(localPath));
        } else {
          startCrop();
        }
      }).catch(() => {
        if (!isCancelled) startCrop();
      });
    } else {
      startCrop();
    }

    return () => {
      isCancelled = true;
    };
  }, [
    photo?.filePath,
    box?.x,
    box?.y,
    box?.width,
    box?.height,
    face?.id,
    face?.imageWidth,
    face?.imageHeight,
    imageWidth,
    imageHeight,
    size,
    personId,
    avatarCacheKey,
    usesPersonCache,
    preferOriginal,
    sprite.status,
  ]);

  const retrySrc =
    retry > 0 && croppedDataUrl && !croppedDataUrl.startsWith('data:')
      ? `${croppedDataUrl}${croppedDataUrl.includes('?') ? '&' : '?'}_r=${retry}`
      : croppedDataUrl;

  if (sprite.status === 'ready' && sprite.coord) {
    const c = sprite.coord;
    return (
      <div
        role="img"
        aria-label={alt}
        style={{
          width: `${size}px`,
          height: `${size}px`,
          borderRadius,
          backgroundColor: 'var(--bg-surface-elevated)',
          backgroundImage: `url(${getSpriteUrl({ spriteId: c.spriteId } as any)})`,
          backgroundRepeat: 'no-repeat',
          // sheets are 10 tiles wide; each tile is shown at `size` px
          backgroundSize: `${10 * size}px ${c.rows * size}px`,
          backgroundPosition: `-${c.col * size}px -${c.row * size}px`,
        }}
      />
    );
  }

  if (sprite.status === 'pending') {
    // Card is already on screen; the picture follows once the batch answers.
    return <div style={{ width: `${size}px`, height: `${size}px`, borderRadius, backgroundColor: '#1e293b' }} />;
  }

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
          src={retrySrc ?? undefined}
          alt={alt}
          // A transient failure (main process busy while the People screen
          // opens) is cached by Chromium per URL, so the image would stay
          // broken forever. Retry with a changed URL, then fall back to the
          // placeholder icon instead of a broken-image box.
          onError={() => {
            if (retry >= 3) { setHasError(true); return; }
            setTimeout(() => setRetry((r) => r + 1), 1500 * 2 ** retry);
          }}
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
