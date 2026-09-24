import React, { useEffect, useRef, useState, useCallback } from 'react';
import { X, Check, Star } from 'lucide-react';
import { DetectedFace, Photo } from '../../types';
import { libraryStore, getLocalPhotoUrl } from '../services/libraryStore';
import { invalidateAvatarSprite } from '../services/avatarSpriteLoader';

interface SetCoverPhotoModalProps {
  photo: Photo;
  face: DetectedFace;
  personId: string;
  personName: string;
  onClose: () => void;
  onSaved?: () => void;
}

interface CropBox {
  x: number;
  y: number;
  size: number;
}

const MIN_CROP_SIZE = 40;

/**
 * Lets the user fine-tune the face crop used as a person's cover photo,
 * starting from the detected face box (with the same padding FaceAvatar
 * applies elsewhere) instead of accepting it as-is. Crop stays square since
 * every cover avatar in the app renders circular.
 */
export const SetCoverPhotoModal: React.FC<SetCoverPhotoModalProps> = ({
  photo,
  face,
  personId,
  personName,
  onClose,
  onSaved,
}) => {
  const imgRef = useRef<HTMLImageElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const [displayScale, setDisplayScale] = useState(1);
  const [cropBox, setCropBox] = useState<CropBox | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const dragState = useRef<{
    mode: 'move' | 'resize';
    corner?: 'nw' | 'ne' | 'sw' | 'se';
    startClientX: number;
    startClientY: number;
    startBox: CropBox;
  } | null>(null);

  const imageUrl = getLocalPhotoUrl(photo.filePath, photo.originalRemotePath, true);

  const initializeCropBox = useCallback((natW: number, natH: number) => {
    const baseW = face.imageWidth || natW;
    const baseH = face.imageHeight || natH;
    const scaleX = natW / baseW;
    const scaleY = natH / baseH;
    const fb = face.box;
    const scaledBox = {
      x: fb.x * scaleX,
      y: fb.y * scaleY,
      width: fb.width * scaleX,
      height: fb.height * scaleY,
    };

    const padding = 0.35;
    const padW = scaledBox.width * padding;
    const padH = scaledBox.height * padding;
    const rawX = Math.max(0, scaledBox.x - padW);
    const rawY = Math.max(0, scaledBox.y - padH);
    const rawW = Math.min(natW - rawX, scaledBox.width + padW * 2);
    const rawH = Math.min(natH - rawY, scaledBox.height + padH * 2);

    const side = Math.max(MIN_CROP_SIZE, Math.min(natW, natH, Math.max(rawW, rawH)));
    const x = Math.max(0, Math.min(natW - side, rawX - (side - rawW) / 2));
    const y = Math.max(0, Math.min(natH - side, rawY - (side - rawH) / 2));
    setCropBox({ x, y, size: side });
  }, [face]);

  const handleImageLoad = () => {
    const img = imgRef.current;
    if (!img) return;
    const natW = img.naturalWidth;
    const natH = img.naturalHeight;
    setNaturalSize({ w: natW, h: natH });

    // Fit the image within a fixed preview box, uniform scale (no letterbox
    // math needed since the container itself gets sized to the scaled image).
    const maxW = 640;
    const maxH = 520;
    const scale = Math.min(maxW / natW, maxH / natH, 1);
    setDisplayScale(scale);

    initializeCropBox(natW, natH);
  };

  const clampBox = (box: CropBox, natW: number, natH: number): CropBox => {
    const size = Math.max(MIN_CROP_SIZE, Math.min(box.size, natW, natH));
    const x = Math.max(0, Math.min(natW - size, box.x));
    const y = Math.max(0, Math.min(natH - size, box.y));
    return { x, y, size };
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      const drag = dragState.current;
      if (!drag || !naturalSize) return;
      const dxNat = (e.clientX - drag.startClientX) / displayScale;
      const dyNat = (e.clientY - drag.startClientY) / displayScale;

      if (drag.mode === 'move') {
        setCropBox(
          clampBox({ x: drag.startBox.x + dxNat, y: drag.startBox.y + dyNat, size: drag.startBox.size }, naturalSize.w, naturalSize.h)
        );
      } else if (drag.mode === 'resize' && drag.corner) {
        const { x, y, size } = drag.startBox;
        // Anchor is the opposite corner; size follows the larger of the two
        // deltas from it so the box always stays square.
        let anchorX = x;
        let anchorY = y;
        if (drag.corner === 'ne' || drag.corner === 'se') anchorX = x;
        if (drag.corner === 'nw' || drag.corner === 'sw') anchorX = x + size;
        if (drag.corner === 'se' || drag.corner === 'sw') anchorY = y;
        if (drag.corner === 'ne' || drag.corner === 'nw') anchorY = y + size;

        const mouseNatX = x + (drag.corner === 'nw' || drag.corner === 'sw' ? 0 : size) + dxNat;
        const mouseNatY = y + (drag.corner === 'nw' || drag.corner === 'ne' ? 0 : size) + dyNat;
        const newSize = Math.max(MIN_CROP_SIZE, Math.max(Math.abs(mouseNatX - anchorX), Math.abs(mouseNatY - anchorY)));

        const newX = drag.corner === 'nw' || drag.corner === 'sw' ? anchorX - newSize : anchorX;
        const newY = drag.corner === 'nw' || drag.corner === 'ne' ? anchorY - newSize : anchorY;

        setCropBox(clampBox({ x: newX, y: newY, size: newSize }, naturalSize.w, naturalSize.h));
      }
    };

    const handleMouseUp = () => {
      dragState.current = null;
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayScale, naturalSize]);

  const startMove = (e: React.MouseEvent) => {
    if (!cropBox) return;
    e.preventDefault();
    dragState.current = { mode: 'move', startClientX: e.clientX, startClientY: e.clientY, startBox: cropBox };
  };

  const startResize = (corner: 'nw' | 'ne' | 'sw' | 'se') => (e: React.MouseEvent) => {
    if (!cropBox) return;
    e.preventDefault();
    e.stopPropagation();
    dragState.current = { mode: 'resize', corner, startClientX: e.clientX, startClientY: e.clientY, startBox: cropBox };
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        onClose();
      }
    };
    // capture: true — see PeopleView's matching Escape handler for why.
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, [onClose]);

  const handleConfirm = async () => {
    if (!cropBox || !naturalSize) return;
    setIsSaving(true);
    setErrorMessage(null);
    try {
      const canvas = document.createElement('canvas');
      const targetSize = 440; // 2x a typical 220px displayed avatar
      canvas.width = targetSize;
      canvas.height = targetSize;
      const ctx = canvas.getContext('2d');
      if (!ctx || !imgRef.current) throw new Error('Could not prepare crop canvas');

      ctx.drawImage(imgRef.current, cropBox.x, cropBox.y, cropBox.size, cropBox.size, 0, 0, targetSize, targetSize);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.9);

      libraryStore.setPersonCover(personId, photo.id, face.id);
      if (window.electronAPI?.savePersonAvatar) {
        await window.electronAPI.savePersonAvatar(personId, face.id, dataUrl);
        invalidateAvatarSprite(personId); // grid cards must pick up the new crop, not the cached sprite tile
      }

      if (onSaved) onSaved();
      onClose();
    } catch (err: any) {
      console.error('[SetCoverPhotoModal] Failed to save cover crop:', err);
      setErrorMessage(err?.message || 'Failed to save cover photo.');
    } finally {
      setIsSaving(false);
    }
  };

  const displayW = naturalSize ? naturalSize.w * displayScale : 0;
  const displayH = naturalSize ? naturalSize.h * displayScale : 0;
  const handleSize = 16;

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
        zIndex: 3600,
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
          backgroundColor: 'var(--bg-surface)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: '0 24px 64px rgba(0, 0, 0, 0.7)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          maxWidth: '95vw',
          maxHeight: '90vh',
        }}
      >
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <Star size={18} color="var(--accent-amber)" />
            <h3 style={{ fontSize: '1.05rem', fontWeight: 700, margin: 0, color: 'var(--text-primary)' }}>
              Set as Cover Photo for {personName}
            </h3>
          </div>
          <button className="btn btn-ghost btn-icon" onClick={onClose} style={{ width: '32px', height: '32px' }}>
            <X size={18} />
          </button>
        </div>

        <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: '10px', alignItems: 'center' }}>
          <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
            Drag the box to reposition, drag a corner to resize — it stays square.
          </div>

          <div
            ref={containerRef}
            style={{
              position: 'relative',
              width: displayW || undefined,
              height: displayH || undefined,
              lineHeight: 0,
            }}
          >
            <img
              ref={imgRef}
              src={imageUrl}
              crossOrigin="anonymous"
              onLoad={handleImageLoad}
              alt="Adjust cover crop"
              draggable={false}
              style={{ width: displayW || 'auto', height: displayH || 'auto', display: 'block', userSelect: 'none' }}
            />

            {cropBox && naturalSize && (
              <div
                onMouseDown={startMove}
                style={{
                  position: 'absolute',
                  left: cropBox.x * displayScale,
                  top: cropBox.y * displayScale,
                  width: cropBox.size * displayScale,
                  height: cropBox.size * displayScale,
                  border: '2px solid var(--accent-amber)',
                  boxShadow: '0 0 0 2000px rgba(0, 0, 0, 0.5)',
                  cursor: 'move',
                }}
              >
                {(['nw', 'ne', 'sw', 'se'] as const).map((corner) => (
                  <div
                    key={corner}
                    onMouseDown={startResize(corner)}
                    style={{
                      position: 'absolute',
                      width: handleSize,
                      height: handleSize,
                      backgroundColor: 'var(--accent-amber)',
                      border: '2px solid white',
                      borderRadius: '50%',
                      cursor: `${corner}-resize`,
                      top: corner.includes('n') ? -handleSize / 2 : undefined,
                      bottom: corner.includes('s') ? -handleSize / 2 : undefined,
                      left: corner.includes('w') ? -handleSize / 2 : undefined,
                      right: corner.includes('e') ? -handleSize / 2 : undefined,
                    }}
                  />
                ))}
              </div>
            )}
          </div>

          {errorMessage && (
            <div style={{ fontSize: '0.8rem', color: 'var(--accent-rose)' }}>{errorMessage}</div>
          )}
        </div>

        <div style={{ padding: '14px 20px', borderTop: '1px solid var(--border-subtle)', display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
          <button className="btn btn-secondary" onClick={onClose} disabled={isSaving}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={handleConfirm} disabled={!cropBox || isSaving} style={{ gap: '6px' }}>
            <Check size={16} />
            <span>{isSaving ? 'Saving...' : 'Confirm Cover Photo'}</span>
          </button>
        </div>
      </div>
    </div>
  );
};
