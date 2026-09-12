import * as faceapi from '@vladmandic/face-api/dist/face-api.esm.js';
import { DetectedFace, Person, Photo } from '../../types';
import { getLocalPhotoUrl } from './libraryStore';
import { normalizeVector } from './clustering';

let modelsLoaded = false;
let modelLoadingPromise: Promise<boolean> | null = null;

/**
 * Initializes WebGPU or WebGL backend for high-performance neural inference.
 */
async function initAccelerationBackend(): Promise<void> {
  try {
    if (faceapi.tf && typeof faceapi.tf.setBackend === 'function') {
      const current = faceapi.tf.getBackend();
      if (current !== 'webgpu' && current !== 'webgl') {
        try {
          await faceapi.tf.setBackend('webgpu');
          await faceapi.tf.ready();
          console.log('Hardware acceleration: WebGPU initialized for face-api');
        } catch {
          await faceapi.tf.setBackend('webgl');
          await faceapi.tf.ready();
          console.log('Hardware acceleration: WebGL initialized for face-api');
        }
      }
    }
  } catch (err) {
    console.warn('Backend acceleration setup notice:', err);
  }
}

export async function loadFaceModels(): Promise<boolean> {
  if (modelsLoaded) return true;
  if (modelLoadingPromise) return modelLoadingPromise;

  modelLoadingPromise = (async () => {
    await initAccelerationBackend();

    // In Electron, models are served via privileged gphoto://models. In browser dev, via /models
    const modelBaseUri = (typeof window !== 'undefined' && window.location?.protocol?.startsWith('http'))
      ? '/models'
      : (window.electronAPI ? 'gphoto://models' : './models');
    console.log(`Loading face-api AI models from ${modelBaseUri}...`);

    try {
      await Promise.all([
        faceapi.nets.ssdMobilenetv1.loadFromUri(modelBaseUri),
        faceapi.nets.faceLandmark68Net.loadFromUri(modelBaseUri),
        faceapi.nets.faceRecognitionNet.loadFromUri(modelBaseUri),
        faceapi.nets.ageGenderNet.loadFromUri(modelBaseUri),
        faceapi.nets.faceExpressionNet.loadFromUri(modelBaseUri),
      ]);
      modelsLoaded = true;
      console.log('SSD MobileNet face-api models with Age, Gender & Expressions successfully loaded!');
      return true;
    } catch (err) {
      console.warn('Failed to load ssdMobilenetv1, attempting tinyFaceDetector fallback...', err);
      try {
        await Promise.all([
          faceapi.nets.tinyFaceDetector.loadFromUri(modelBaseUri),
          faceapi.nets.faceLandmark68TinyNet.loadFromUri(modelBaseUri),
          faceapi.nets.faceRecognitionNet.loadFromUri(modelBaseUri),
          faceapi.nets.ageGenderNet.loadFromUri(modelBaseUri),
          faceapi.nets.faceExpressionNet.loadFromUri(modelBaseUri),
        ]);
        modelsLoaded = true;
        console.log('TinyFaceDetector face-api models with Age, Gender & Expressions successfully loaded!');
        return true;
      } catch (fallbackErr) {
        console.error('All face model loading failed:', fallbackErr);
        modelsLoaded = false;
        modelLoadingPromise = null;
        return false;
      }
    }
  })();

  return modelLoadingPromise;
}

export async function detectFacesInImage(
  source: HTMLImageElement | HTMLCanvasElement | string,
  photoIdOrPath?: string,
  originalRemotePath?: string,
  preferOriginal = false
): Promise<DetectedFace[]> {
  const ready = await loadFaceModels();
  if (!ready) {
    console.warn(`Cannot detect faces: models are not loaded.`);
    return [];
  }

  let targetElement: HTMLImageElement | HTMLCanvasElement;
  let actualPhotoId = 'unknown';

  try {
    if (typeof source !== 'string') {
      targetElement = source;
      actualPhotoId = photoIdOrPath || 'unknown';
    } else {
      let filePath = source;
      actualPhotoId = photoIdOrPath || source;

      // Check if arguments were reversed: detectFacesInImage(photo.id, photo.filePath)
      if (
        photoIdOrPath &&
        typeof photoIdOrPath === 'string' &&
        (photoIdOrPath.includes('\\') ||
          photoIdOrPath.includes('/') ||
          photoIdOrPath.startsWith('http') ||
          photoIdOrPath.startsWith('gphoto://'))
      ) {
        filePath = photoIdOrPath;
        actualPhotoId = source;
      }

      const isHeic = typeof filePath === 'string' && /\.(heic|heif)$/i.test(filePath);
      let preparedHqPathOrUrl: string | null = null;
      if (isHeic && typeof window !== 'undefined' && window.electronAPI?.prepareHeicHq) {
        try {
          preparedHqPathOrUrl = await window.electronAPI.prepareHeicHq(filePath, actualPhotoId);
        } catch {}
      }

      // Convert filePath to loadable URL (using original/HQ photo for HEIC or preferOriginal)
      const url = preparedHqPathOrUrl
        ? (preparedHqPathOrUrl.startsWith('http') || preparedHqPathOrUrl.startsWith('gphoto://')
            ? preparedHqPathOrUrl
            : getLocalPhotoUrl(preparedHqPathOrUrl, undefined, true))
        : getLocalPhotoUrl(filePath, originalRemotePath, isHeic ? true : preferOriginal);

      const img = new Image();
      img.crossOrigin = 'anonymous';

      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error(`Failed to load image from URL: ${url}`));
        img.src = url;
      });

      targetElement = img;
    }

    try {
      let detections: any = null;

      if (faceapi.nets.ssdMobilenetv1.isLoaded) {
        let pipeline = faceapi.detectAllFaces(
          targetElement,
          new faceapi.SsdMobilenetv1Options({ minConfidence: 0.35 })
        ) as any;

        if (faceapi.nets.faceLandmark68Net.isLoaded) {
          pipeline = pipeline.withFaceLandmarks();
        }
        if (faceapi.nets.faceExpressionNet.isLoaded) {
          pipeline = pipeline.withFaceExpressions();
        }
        if (faceapi.nets.ageGenderNet.isLoaded) {
          pipeline = pipeline.withAgeAndGender();
        }
        if (faceapi.nets.faceRecognitionNet.isLoaded) {
          pipeline = pipeline.withFaceDescriptors();
        }
        detections = await pipeline;
      } else if (faceapi.nets.tinyFaceDetector.isLoaded) {
        let pipeline = faceapi.detectAllFaces(
          targetElement,
          new faceapi.TinyFaceDetectorOptions({ scoreThreshold: 0.35 })
        ) as any;

        if (faceapi.nets.faceLandmark68TinyNet.isLoaded) {
          pipeline = pipeline.withFaceLandmarks(true);
        }
        if (faceapi.nets.faceExpressionNet.isLoaded) {
          pipeline = pipeline.withFaceExpressions();
        }
        if (faceapi.nets.ageGenderNet.isLoaded) {
          pipeline = pipeline.withAgeAndGender();
        }
        if (faceapi.nets.faceRecognitionNet.isLoaded) {
          pipeline = pipeline.withFaceDescriptors();
        }
        detections = await pipeline;
      }

      if (!detections || detections.length === 0) return [];

      const imgWidth = (targetElement as HTMLImageElement).naturalWidth || targetElement.width;
      const imgHeight = (targetElement as HTMLImageElement).naturalHeight || targetElement.height;

      return detections.map((det: any, index: number) => {
        // Determine dominant expression (happy, neutral, sad, surprised, etc.)
        let dominantExpression: string | undefined = undefined;
        let expressions: Record<string, number> | undefined = undefined;

        if (det.expressions) {
          expressions = det.expressions;
          let maxProb = 0;
          for (const [expr, prob] of Object.entries(det.expressions)) {
            if ((prob as number) > maxProb && (prob as number) > 0.3) {
              maxProb = prob as number;
              dominantExpression = expr;
            }
          }
        }
        const rawDescriptor = det.descriptor ? Array.from(det.descriptor) : new Array(128).fill(0);
        const normalizedDescriptor = normalizeVector(rawDescriptor as number[]);

        return {
          id: `face_${actualPhotoId}_${index}_${Date.now()}`,
          photoId: actualPhotoId,
          box: {
            x: Math.round(det.detection.box.x),
            y: Math.round(det.detection.box.y),
            width: Math.round(det.detection.box.width),
            height: Math.round(det.detection.box.height),
          },
          imageWidth: imgWidth,
          imageHeight: imgHeight,
          descriptor: normalizedDescriptor,
          confidence: Number(det.detection.score.toFixed(3)),
          age: typeof det.age === 'number' ? Math.round(det.age) : undefined,
          gender: det.gender,
          genderProbability:
            typeof det.genderProbability === 'number'
              ? Number(det.genderProbability.toFixed(2))
              : undefined,
          expressions,
          dominantExpression,
        };
      });
    } finally {
      const isHeic = typeof source === 'string' && /\.(heic|heif)$/i.test(source);
      if (isHeic && typeof window !== 'undefined' && window.electronAPI?.cleanupHeicHq) {
        window.electronAPI.cleanupHeicHq(actualPhotoId).catch(() => {});
      }
    }
  } catch (err) {
    console.error(`Error detecting faces in photo ${actualPhotoId}:`, err);
    return [];
  }
}

export {
  euclideanDistance,
  cosineDistance,
  normalizeVector,
  computeQualityWeightedCentroid,
  clusterFaces,
} from './clustering';

export function cropFaceAvatar(
  img: HTMLImageElement,
  box: { x: number; y: number; width: number; height: number }
): string {
  try {
    const canvas = document.createElement('canvas');
    const padding = 0.25; // 25% margin around face
    const px = Math.max(0, box.x - box.width * padding);
    const py = Math.max(0, box.y - box.height * padding);
    const pw = Math.min(img.naturalWidth - px, box.width * (1 + padding * 2));
    const ph = Math.min(img.naturalHeight - py, box.height * (1 + padding * 2));

    const size = 160;
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return '';

    ctx.drawImage(img, px, py, pw, ph, 0, 0, size, size);
    return canvas.toDataURL('image/jpeg', 0.85);
  } catch {
    return '';
  }
}

export async function computeDescriptorForBox(
  imageElement: HTMLImageElement,
  box: { x: number; y: number; width: number; height: number }
): Promise<number[] | undefined> {
  const ready = await loadFaceModels();
  if (!ready) return undefined;
  try {
    const canvas = document.createElement('canvas');
    const margin = 0.2;
    const marginX = box.width * margin;
    const marginY = box.height * margin;
    const imgW = imageElement.naturalWidth || imageElement.width || 1000;
    const imgH = imageElement.naturalHeight || imageElement.height || 1000;
    const cropX = Math.max(0, Math.round(box.x - marginX));
    const cropY = Math.max(0, Math.round(box.y - marginY));
    const cropW = Math.min(imgW - cropX, Math.round(box.width + marginX * 2));
    const cropH = Math.min(imgH - cropY, Math.round(box.height + marginY * 2));

    canvas.width = Math.max(1, cropW);
    canvas.height = Math.max(1, cropH);
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;
    ctx.drawImage(imageElement, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);

    let singleDet: any = null;
    if (faceapi.nets.ssdMobilenetv1.isLoaded) {
      singleDet = await (faceapi
        .detectSingleFace(canvas, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.15 })) as any)
        .withFaceLandmarks()
        .withFaceDescriptor();
    } else if (faceapi.nets.tinyFaceDetector.isLoaded) {
      singleDet = await (faceapi
        .detectSingleFace(canvas, new faceapi.TinyFaceDetectorOptions({ scoreThreshold: 0.15 })) as any)
        .withFaceLandmarks(true)
        .withFaceDescriptor();
    }

    if (singleDet && singleDet.descriptor) {
      return normalizeVector(Array.from(singleDet.descriptor));
    }
  } catch (err) {
    console.warn('Could not compute descriptor for manual box:', err);
  }
  return undefined;
}


