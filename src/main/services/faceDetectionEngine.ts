import path from 'path';
import fs from 'fs';
import sharp from 'sharp';
import * as ort from 'onnxruntime-node';
import { logger } from './workerSafeLogger';
import { FACE_DATA_VERSION } from './faceEngineVersion';

// Native, main-process face detection + recognition — replaces the renderer's
// @vladmandic/face-api (which needed a DOM/canvas). Runs SCRFD (detection)
// and ArcFace/MobileFaceNet (recognition) via onnxruntime-node, so it works
// with no window open at all (see docs/PIPELINE_REDESIGN_DEV_DOC.md §3.7).
//
// Models: InsightFace's "buffalo_sc" pack (non-commercial research license —
// see docs/CURRENT_STATUS_AND_GAPS.md; personal/internal use only, must be
// swapped for permissively-licensed models before any commercial release):
//   - scrfd_500m.onnx  (detection, SCRFD-500MF w/ 5-point landmarks)
//   - arcface_mbf.onnx (recognition, MobileFaceNet, 512-d embeddings)
//
// Detection algorithm here reimplements InsightFace's own SCRFD postprocess
// (anchor generation, distance-decoded boxes/keypoints, per-stride NMS) —
// see model_zoo/scrfd.py in the insightface project for the reference
// implementation this was ported from.

export const DETECTOR_VERSION = FACE_DATA_VERSION;

const MODELS_DIR = path.join(__dirname, '../../resources/models-onnx');
const DETECTION_INPUT_SIZE = 640;
const DETECTION_MEAN = 127.5;
const DETECTION_STD = 128.0;
const RECOGNITION_INPUT_SIZE = 112;
const RECOGNITION_MEAN = 127.5;
const RECOGNITION_STD = 127.5;
const DET_SCORE_THRESHOLD = 0.5;
const NMS_IOU_THRESHOLD = 0.4;
const FEATURE_STRIDES = [8, 16, 32];
const NUM_ANCHORS = 2;

// Canonical 5-point face template for a 112x112 aligned crop (InsightFace's
// arcface_dst reference points) — the target every detected face's 5
// landmarks (eyes, nose, mouth corners) get aligned to before recognition.
const ARCFACE_TEMPLATE: Array<[number, number]> = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
];

export interface DetectedFace {
  box: { x: number; y: number; width: number; height: number };
  confidence: number;
  landmarks: Array<{ x: number; y: number }>;
  descriptor: number[];
  // Present only on detectFaceInRegion's result (remapped into the original,
  // uncropped image's coordinate space) — detectFaces() itself returns these
  // separately via DetectFacesResult since they're the same for every face
  // in a single call.
  imageWidth?: number;
  imageHeight?: number;
}

let detectionSession: ort.InferenceSession | null = null;
let recognitionSession: ort.InferenceSession | null = null;
let loadPromise: Promise<void> | null = null;

function resolveModelPath(fileName: string): string {
  // Packaged builds put resources/ next to the app; dev runs from the repo
  // root. Try both so this works identically in `npm start` and dist:win.
  const candidates = [
    path.join(MODELS_DIR, fileName),
    path.join(process.cwd(), 'resources', 'models-onnx', fileName),
    path.join(process.resourcesPath || '', 'models-onnx', fileName),
  ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`Face model not found: ${fileName} (looked in: ${candidates.join(', ')})`);
}

/** Lazily loads both ONNX sessions once; safe to call repeatedly/concurrently. */
export async function loadFaceModels(): Promise<void> {
  if (detectionSession && recognitionSession) return;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    logger.debug('FaceDetectionEngine', 'Loading ONNX face models');
    const detPath = resolveModelPath('scrfd_500m.onnx');
    const recPath = resolveModelPath('arcface_mbf.onnx');
    const options: ort.InferenceSession.SessionOptions = {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all',
    };
    [detectionSession, recognitionSession] = await Promise.all([
      ort.InferenceSession.create(detPath, options),
      ort.InferenceSession.create(recPath, options),
    ]);
    logger.info('FaceDetectionEngine', 'ONNX face models loaded', { detPath, recPath });
  })();

  try {
    await loadPromise;
  } catch (err) {
    loadPromise = null; // allow a retry on next call instead of caching a permanent failure
    logger.error('FaceDetectionEngine', 'Failed to load ONNX face models', { err: String(err) });
    throw err;
  }
}

export function areFaceModelsLoaded(): boolean {
  return !!(detectionSession && recognitionSession);
}

export interface DecodedImage {
  data: Buffer; // raw RGB, 3 channels, no alpha
  width: number;
  height: number;
}

export async function decodeToRawRgb(imageBuffer: Buffer): Promise<DecodedImage> {
  const { data, info } = await sharp(imageBuffer)
    .rotate() // apply EXIF orientation so detection matches what the user sees
    .removeAlpha()
    .toColorspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

interface LetterboxResult {
  tensorData: Float32Array;
  scale: number;
  resizedWidth: number;
  resizedHeight: number;
}

async function letterboxForDetection(image: DecodedImage): Promise<LetterboxResult> {
  const { width, height } = image;
  const scale = Math.min(DETECTION_INPUT_SIZE / width, DETECTION_INPUT_SIZE / height);
  const resizedWidth = Math.round(width * scale);
  const resizedHeight = Math.round(height * scale);

  const resized = await sharp(image.data, { raw: { width, height, channels: 3 } })
    .resize(resizedWidth, resizedHeight, { fit: 'fill' })
    .raw()
    .toBuffer();

  // NCHW float32, top-left aligned on a zero-padded DETECTION_INPUT_SIZE square.
  const tensorData = new Float32Array(3 * DETECTION_INPUT_SIZE * DETECTION_INPUT_SIZE);
  const planeSize = DETECTION_INPUT_SIZE * DETECTION_INPUT_SIZE;
  for (let y = 0; y < resizedHeight; y += 1) {
    for (let x = 0; x < resizedWidth; x += 1) {
      const srcIdx = (y * resizedWidth + x) * 3;
      const dstIdx = y * DETECTION_INPUT_SIZE + x;
      tensorData[dstIdx] = (resized[srcIdx] - DETECTION_MEAN) / DETECTION_STD; // R
      tensorData[planeSize + dstIdx] = (resized[srcIdx + 1] - DETECTION_MEAN) / DETECTION_STD; // G
      tensorData[2 * planeSize + dstIdx] = (resized[srcIdx + 2] - DETECTION_MEAN) / DETECTION_STD; // B
    }
  }

  return { tensorData, scale, resizedWidth, resizedHeight };
}

interface RawCandidate {
  score: number;
  box: [number, number, number, number]; // x1,y1,x2,y2 in network-input (640) space
  kps: Array<[number, number]>;
}

function decodeScrfdOutputs(outputs: Record<string, ort.Tensor>, outputNames: readonly string[]): RawCandidate[] {
  const candidates: RawCandidate[] = [];

  for (let strideIdx = 0; strideIdx < FEATURE_STRIDES.length; strideIdx += 1) {
    const stride = FEATURE_STRIDES[strideIdx];
    const scores = outputs[outputNames[strideIdx]].data as Float32Array;
    const bboxPreds = outputs[outputNames[strideIdx + FEATURE_STRIDES.length]].data as Float32Array;
    const kpsPreds = outputs[outputNames[strideIdx + FEATURE_STRIDES.length * 2]].data as Float32Array;

    const featSize = DETECTION_INPUT_SIZE / stride;
    let anchorIdx = 0;
    for (let gy = 0; gy < featSize; gy += 1) {
      for (let gx = 0; gx < featSize; gx += 1) {
        const cx = gx * stride;
        const cy = gy * stride;
        for (let a = 0; a < NUM_ANCHORS; a += 1) {
          const score = scores[anchorIdx];
          if (score >= DET_SCORE_THRESHOLD) {
            const bo = anchorIdx * 4;
            const x1 = cx - bboxPreds[bo] * stride;
            const y1 = cy - bboxPreds[bo + 1] * stride;
            const x2 = cx + bboxPreds[bo + 2] * stride;
            const y2 = cy + bboxPreds[bo + 3] * stride;

            const ko = anchorIdx * 10;
            const kps: Array<[number, number]> = [];
            for (let k = 0; k < 5; k += 1) {
              kps.push([cx + kpsPreds[ko + k * 2] * stride, cy + kpsPreds[ko + k * 2 + 1] * stride]);
            }

            candidates.push({ score, box: [x1, y1, x2, y2], kps });
          }
          anchorIdx += 1;
        }
      }
    }
  }

  return candidates;
}

function iou(a: [number, number, number, number], b: [number, number, number, number]): number {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]);
  const y2 = Math.min(a[3], b[3]);
  const interW = Math.max(0, x2 - x1);
  const interH = Math.max(0, y2 - y1);
  const inter = interW * interH;
  const areaA = Math.max(0, a[2] - a[0]) * Math.max(0, a[3] - a[1]);
  const areaB = Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
  const union = areaA + areaB - inter;
  return union <= 0 ? 0 : inter / union;
}

function nonMaxSuppression(candidates: RawCandidate[]): RawCandidate[] {
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  const kept: RawCandidate[] = [];
  for (const candidate of sorted) {
    if (kept.every((k) => iou(k.box, candidate.box) <= NMS_IOU_THRESHOLD)) {
      kept.push(candidate);
    }
  }
  return kept;
}

/**
 * Least-squares fit of a similarity transform (uniform scale + rotation +
 * translation, no reflection) mapping `src` points onto `dst` points:
 *   dst_x = a*src_x - b*src_y + tx
 *   dst_y = b*src_x + a*src_y + ty
 * Solved directly as a linear system in (a,b,tx,ty) via normal equations —
 * simpler and numerically equivalent to SVD-based Umeyama for this
 * 4-degree-of-freedom case, with no reflection-sign ambiguity to handle.
 */
function fitSimilarityTransform(
  src: Array<[number, number]>,
  dst: Array<[number, number]>
): { a: number; b: number; tx: number; ty: number } {
  // Normal equations for A^T A x = A^T y, x = [a,b,tx,ty].
  const ATA = [
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ];
  const ATy = [0, 0, 0, 0];

  const addRow = (row: number[], y: number) => {
    for (let i = 0; i < 4; i += 1) {
      ATy[i] += row[i] * y;
      for (let j = 0; j < 4; j += 1) {
        ATA[i][j] += row[i] * row[j];
      }
    }
  };

  for (let i = 0; i < src.length; i += 1) {
    const [sx, sy] = src[i];
    const [dx, dy] = dst[i];
    addRow([sx, -sy, 1, 0], dx);
    addRow([sy, sx, 0, 1], dy);
  }

  const x = solve4x4(ATA, ATy);
  return { a: x[0], b: x[1], tx: x[2], ty: x[3] };
}

/** Gaussian elimination with partial pivoting for a small fixed 4x4 system. */
function solve4x4(matrix: number[][], vector: number[]): number[] {
  const n = 4;
  const M = matrix.map((row, i) => [...row, vector[i]]);

  for (let col = 0; col < n; col += 1) {
    let pivotRow = col;
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs(M[row][col]) > Math.abs(M[pivotRow][col])) pivotRow = row;
    }
    [M[col], M[pivotRow]] = [M[pivotRow], M[col]];

    const pivot = M[col][col] || 1e-9;
    for (let row = 0; row < n; row += 1) {
      if (row === col) continue;
      const factor = M[row][col] / pivot;
      for (let k = col; k <= n; k += 1) {
        M[row][k] -= factor * M[col][k];
      }
    }
  }

  return M.map((row, i) => row[n] / (row[i] || 1e-9));
}

function bilinearSample(image: DecodedImage, x: number, y: number, channel: number): number {
  const { data, width, height } = image;
  const clampedX = Math.min(Math.max(x, 0), width - 1);
  const clampedY = Math.min(Math.max(y, 0), height - 1);
  const x0 = Math.floor(clampedX);
  const y0 = Math.floor(clampedY);
  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, height - 1);
  const fx = clampedX - x0;
  const fy = clampedY - y0;

  const p00 = data[(y0 * width + x0) * 3 + channel];
  const p10 = data[(y0 * width + x1) * 3 + channel];
  const p01 = data[(y1 * width + x0) * 3 + channel];
  const p11 = data[(y1 * width + x1) * 3 + channel];

  const top = p00 * (1 - fx) + p10 * fx;
  const bottom = p01 * (1 - fx) + p11 * fx;
  return top * (1 - fy) + bottom * fy;
}

/**
 * Warps the original full-resolution image into a 112x112 aligned face crop
 * using the inverse of the fitted similarity transform, so recognition
 * always runs against full-resolution source pixels (requirement: full-res
 * face detection, including for HEIC full-decode buffers) rather than a
 * downscaled 640px detection-space crop.
 */
export function alignFace(image: DecodedImage, landmarksOriginal: Array<[number, number]>): Buffer {
  const { a, b, tx, ty } = fitSimilarityTransform(landmarksOriginal, ARCFACE_TEMPLATE);
  const det = a * a + b * b || 1e-9;

  const aligned = Buffer.alloc(RECOGNITION_INPUT_SIZE * RECOGNITION_INPUT_SIZE * 3);
  for (let oy = 0; oy < RECOGNITION_INPUT_SIZE; oy += 1) {
    for (let ox = 0; ox < RECOGNITION_INPUT_SIZE; ox += 1) {
      const dx = ox - tx;
      const dy = oy - ty;
      const srcX = (a * dx + b * dy) / det;
      const srcY = (-b * dx + a * dy) / det;
      const outIdx = (oy * RECOGNITION_INPUT_SIZE + ox) * 3;
      aligned[outIdx] = Math.round(bilinearSample(image, srcX, srcY, 0));
      aligned[outIdx + 1] = Math.round(bilinearSample(image, srcX, srcY, 1));
      aligned[outIdx + 2] = Math.round(bilinearSample(image, srcX, srcY, 2));
    }
  }
  return aligned;
}

function alignedCropToTensor(aligned: Buffer): Float32Array {
  const planeSize = RECOGNITION_INPUT_SIZE * RECOGNITION_INPUT_SIZE;
  const tensorData = new Float32Array(3 * planeSize);
  for (let i = 0; i < planeSize; i += 1) {
    tensorData[i] = (aligned[i * 3] - RECOGNITION_MEAN) / RECOGNITION_STD;
    tensorData[planeSize + i] = (aligned[i * 3 + 1] - RECOGNITION_MEAN) / RECOGNITION_STD;
    tensorData[2 * planeSize + i] = (aligned[i * 3 + 2] - RECOGNITION_MEAN) / RECOGNITION_STD;
  }
  return tensorData;
}

function l2Normalize(vector: Float32Array): number[] {
  let sumSquares = 0;
  for (let i = 0; i < vector.length; i += 1) sumSquares += vector[i] * vector[i];
  const norm = Math.sqrt(sumSquares) || 1e-9;
  const out = new Array<number>(vector.length);
  for (let i = 0; i < vector.length; i += 1) out[i] = vector[i] / norm;
  return out;
}

export interface DetectFacesResult {
  faces: DetectedFace[];
  // Pixel dimensions of the decoded image the boxes/landmarks below are
  // measured against (post EXIF-rotation) — callers that persist faces must
  // store these alongside each face so a viewer can scale a box correctly
  // even when displaying something other than this exact full-res decode
  // (e.g. a smaller cached thumbnail).
  imageWidth: number;
  imageHeight: number;
}

/**
 * Detects faces in a full-resolution image buffer, returning one descriptor
 * per face. Runs entirely in the main process — no window/DOM required.
 */
export async function detectFaces(imageBuffer: Buffer): Promise<DetectFacesResult> {
  await loadFaceModels();
  if (!detectionSession || !recognitionSession) {
    throw new Error('Face models failed to load');
  }

  const image = await decodeToRawRgb(imageBuffer);
  const { tensorData, scale } = await letterboxForDetection(image);

  const inputTensor = new ort.Tensor('float32', tensorData, [1, 3, DETECTION_INPUT_SIZE, DETECTION_INPUT_SIZE]);
  const inputName = detectionSession.inputNames[0];
  const outputs = await detectionSession.run({ [inputName]: inputTensor });
  const candidates = decodeScrfdOutputs(outputs, detectionSession.outputNames);
  const kept = nonMaxSuppression(candidates);

  const faces: DetectedFace[] = [];
  for (const candidate of kept) {
    const [x1, y1, x2, y2] = candidate.box.map((v) => v / scale) as [number, number, number, number];
    const landmarksOriginal: Array<[number, number]> = candidate.kps.map(([kx, ky]) => [kx / scale, ky / scale]);

    const aligned = alignFace(image, landmarksOriginal);
    const recTensor = new ort.Tensor('float32', alignedCropToTensor(aligned), [1, 3, RECOGNITION_INPUT_SIZE, RECOGNITION_INPUT_SIZE]);
    const recInputName = recognitionSession.inputNames[0];
    const recOutputs = await recognitionSession.run({ [recInputName]: recTensor });
    const embedding = recOutputs[recognitionSession.outputNames[0]].data as Float32Array;

    faces.push({
      box: {
        x: Math.max(0, x1),
        y: Math.max(0, y1),
        width: Math.max(0, x2 - x1),
        height: Math.max(0, y2 - y1),
      },
      confidence: candidate.score,
      landmarks: landmarksOriginal.map(([x, y]) => ({ x, y })),
      descriptor: l2Normalize(embedding),
    });
  }

  return { faces, imageWidth: image.width, imageHeight: image.height };
}

/**
 * Runs detection constrained to (a margin around) a single user-drawn box —
 * backs manual face tagging (user draws a box around a face the automatic
 * pass missed) via faces:compute-descriptor-for-region in main.ts. Reuses
 * detectFaces() unchanged on a crop of just that region, then remaps the
 * result's box/landmarks back to the original image's coordinate space.
 */
export async function detectFaceInRegion(
  imageBuffer: Buffer,
  box: { x: number; y: number; width: number; height: number },
  marginRatio = 0.2
): Promise<DetectedFace | null> {
  const image = await decodeToRawRgb(imageBuffer);
  const marginX = box.width * marginRatio;
  const marginY = box.height * marginRatio;
  const cropX = Math.max(0, Math.round(box.x - marginX));
  const cropY = Math.max(0, Math.round(box.y - marginY));
  const cropWidth = Math.min(image.width - cropX, Math.round(box.width + marginX * 2));
  const cropHeight = Math.min(image.height - cropY, Math.round(box.height + marginY * 2));
  if (cropWidth <= 0 || cropHeight <= 0) return null;

  const cropBuffer = await sharp(image.data, { raw: { width: image.width, height: image.height, channels: 3 } })
    .extract({ left: cropX, top: cropY, width: cropWidth, height: cropHeight })
    .jpeg({ quality: 95 })
    .toBuffer();

  const { faces: facesInCrop } = await detectFaces(cropBuffer);
  if (facesInCrop.length === 0) return null;

  // Closest to the crop's center — the face the user actually meant to box.
  const cropCenterX = cropWidth / 2;
  const cropCenterY = cropHeight / 2;
  const best = facesInCrop.reduce((closest, candidate) => {
    const candidateCenter = { x: candidate.box.x + candidate.box.width / 2, y: candidate.box.y + candidate.box.height / 2 };
    const closestCenter = { x: closest.box.x + closest.box.width / 2, y: closest.box.y + closest.box.height / 2 };
    const candidateDist = Math.hypot(candidateCenter.x - cropCenterX, candidateCenter.y - cropCenterY);
    const closestDist = Math.hypot(closestCenter.x - cropCenterX, closestCenter.y - cropCenterY);
    return candidateDist < closestDist ? candidate : closest;
  });

  return {
    ...best,
    box: { x: best.box.x + cropX, y: best.box.y + cropY, width: best.box.width, height: best.box.height },
    landmarks: best.landmarks.map((l) => ({ x: l.x + cropX, y: l.y + cropY })),
    // Remapped into the ORIGINAL (uncropped) image's coordinate space above,
    // so the reference frame is that original image's full dimensions, not
    // the crop's — matches what detectFaces() stamps for a normal full scan.
    imageWidth: image.width,
    imageHeight: image.height,
  };
}
