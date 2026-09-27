import fs from 'fs';
import { probeFaceOrientation, getFaceDetectionPoolSize } from './faceDetectionWorkerClient';
import { getOrGenerateHeicThumbnail500 } from './heicService';
import type { OrientationProbe } from './faceDetectionEngine';

// Decides, per photo, how many degrees clockwise it must be turned to be
// upright, from face detections at the four orientations (see
// faceDetectionEngine.probeOrientation). This module NEVER rotates anything —
// callers act on the result. It cannot judge photos without faces (landscapes,
// documents, pets...): those come back 'unknown'.

export interface OrientationInput {
  id: string;
  filePath: string;
  fileName?: string;
  originalRemotePath?: string;
  isVirtual?: boolean;
}

export interface OrientationResult {
  id: string;
  status: 'upright' | 'rotate' | 'unknown' | 'failed';
  rotation: 0 | 90 | 180 | 270;
  confidence: number;
  faces: number;
  reason?: string;
}

export type OrientationDecision = Omit<OrientationResult, 'id' | 'status'> & { status: 'upright' | 'rotate' | 'unknown' };

// Tunable (calibrate against real photos): the caller physically rotates files, so err towards 'unknown'.
/** Minimum summed evidence (see engine orientationEvidence) for an orientation to count as "faces seen": ~one face at confidence 0.75+. */
export const MIN_FACE_SCORE = 0.4;
/** A rotation is only proposed when it beats EVERY other orientation (incl. 0 degrees) by this factor. */
export const ROTATE_DOMINANCE = 2;

const ROTATIONS = [0, 90, 180, 270] as const;
type Rot = (typeof ROTATIONS)[number];

/** PURE. `probe.scores[r]` is the face signal of the image rotated clockwise by r; the answer is the r with the strongest, conservatively. */
export function decideRotation(probe: OrientationProbe): OrientationDecision {
  const total = ROTATIONS.map((r) => probe.scores[r].score).reduce((a, b) => a + b, 0);
  const s0 = probe.scores[0].score;
  const unknown = (reason: string, faces = 0): OrientationDecision => ({ status: 'unknown', rotation: 0, confidence: 0, faces, reason });

  if (total < MIN_FACE_SCORE) return unknown('no faces found');

  let best: Rot = 0;
  for (const r of ROTATIONS) if (probe.scores[r].score > probe.scores[best].score) best = r;
  const others = (excl: Rot) => Math.max(...ROTATIONS.filter((r) => r !== excl).map((r) => probe.scores[r].score));
  const share = (r: Rot) => probe.scores[r].score / total;

  // 0 degrees wins outright or ties for the lead with faces present: leave it alone.
  if (s0 >= MIN_FACE_SCORE && s0 >= others(0)) {
    return { status: 'upright', rotation: 0, confidence: share(0), faces: probe.scores[0].count };
  }

  const sb = probe.scores[best].score;
  if (best !== 0 && sb >= MIN_FACE_SCORE) {
    if (sb >= ROTATE_DOMINANCE * others(best)) {
      return { status: 'rotate', rotation: best, confidence: share(best), faces: probe.scores[best].count };
    }
    return unknown('ambiguous face orientation', probe.scores[best].count);
  }
  return unknown('weak face signal', probe.scores[best].count);
}

const isHeic = (p: string) => /\.(heic|heif)$/i.test(p);

/**
 * Cheapest readable image showing the photo as the user sees it. Virtual photos are read ONLY
 * through their local mirror thumbnail (photo.filePath) — the network/OneDrive original
 * (originalRemotePath) is never touched. HEIC goes through heicService's 500px thumbnail helper
 * (EXIF + saved user rotation applied). Returns a reason string when nothing is readable.
 */
async function readSource(photo: OrientationInput): Promise<{ buffer: Buffer } | { reason: string }> {
  if (!photo.filePath) return { reason: photo.isVirtual ? 'no local thumbnail (offline)' : 'no file path' };
  if (!fs.existsSync(photo.filePath)) {
    return { reason: photo.isVirtual ? 'no local thumbnail (offline)' : 'file not found' };
  }
  if (isHeic(photo.filePath)) {
    const buffer = await getOrGenerateHeicThumbnail500(photo.filePath);
    return buffer ? { buffer } : { reason: 'could not decode HEIC' };
  }
  return { buffer: await fs.promises.readFile(photo.filePath) };
}

async function detectOne(photo: OrientationInput): Promise<OrientationResult> {
  try {
    const source = await readSource(photo);
    if ('reason' in source) return { id: photo.id, status: 'failed', rotation: 0, confidence: 0, faces: 0, reason: source.reason };
    return { id: photo.id, ...decideRotation(await probeFaceOrientation(source.buffer)) };
  } catch (err) {
    return { id: photo.id, status: 'failed', rotation: 0, confidence: 0, faces: 0, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** Probes each photo (concurrency = face worker pool size); never throws per photo; results are in input order. */
export async function detectUprightRotations(
  photos: OrientationInput[],
  onProgress?: (done: number, total: number) => void
): Promise<OrientationResult[]> {
  const results: OrientationResult[] = new Array(photos.length);
  let next = 0;
  let done = 0;
  const lane = async () => {
    while (next < photos.length) {
      const i = next++;
      results[i] = await detectOne(photos[i]);
      done++;
      try { onProgress?.(done, photos.length); } catch { /* a bad progress callback must not fail the batch */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(photos.length, Math.max(1, getFaceDetectionPoolSize())) }, lane));
  return results;
}
