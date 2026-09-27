import type { DetectedFace, Photo } from '../../../types';

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Clockwise rotation in degrees, folded to 0 / 90 / 180 / 270 (anything else is treated as 0). */
export function normalizeDegrees(degrees: number): 0 | 90 | 180 | 270 {
  const d = ((Math.round(degrees / 90) * 90) % 360 + 360) % 360;
  return d as 0 | 90 | 180 | 270;
}

/**
 * Where a box inside a `frameW` x `frameH` image ends up after the image is rotated `degrees` clockwise,
 * plus the rotated image's size (the new reference frame).
 *
 *   90:  (x, y) -> (H - y, x)        270: (x, y) -> (y, W - x)        180: (x, y) -> (W - x, H - y)
 */
export function rotateBox(box: Box, frameW: number, frameH: number, degrees: number): { box: Box; frameW: number; frameH: number } {
  const { x, y, width: w, height: h } = box;
  switch (normalizeDegrees(degrees)) {
    case 90:
      return { box: { x: frameH - (y + h), y: x, width: h, height: w }, frameW: frameH, frameH: frameW };
    case 180:
      return { box: { x: frameW - (x + w), y: frameH - (y + h), width: w, height: h }, frameW, frameH };
    case 270:
      return { box: { x: y, y: frameW - (x + w), width: h, height: w }, frameW: frameH, frameH: frameW };
    default:
      return { box: { ...box }, frameW, frameH };
  }
}

/**
 * The image frame a face's box is measured in. New detections record it (`imageWidth/imageHeight`); older
 * ones did not, so fall back the same way the lightbox does: a box that fits a 500px thumbnail of a bigger
 * photo was measured on that thumbnail, otherwise on the photo's own size. Null when nothing is known.
 */
export function resolveFaceFrame(face: Pick<DetectedFace, 'box' | 'imageWidth' | 'imageHeight'>, photo: Pick<Photo, 'width' | 'height'>): { w: number; h: number } | null {
  if (face.imageWidth && face.imageHeight && face.imageWidth > 0 && face.imageHeight > 0) {
    return { w: face.imageWidth, h: face.imageHeight };
  }
  const photoW = photo.width || 0;
  const photoH = photo.height || 0;
  if (!(photoW > 0 && photoH > 0)) return null;
  const maxDim = Math.max(photoW, photoH);
  if (maxDim > 505 && face.box.x + face.box.width <= 505 && face.box.y + face.box.height <= 505) {
    const scale = 500 / maxDim;
    return { w: Math.max(1, Math.round(photoW * scale)), h: Math.max(1, Math.round(photoH * scale)) };
  }
  return { w: photoW, h: photoH };
}
