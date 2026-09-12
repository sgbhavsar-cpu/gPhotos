import { Photo, DuplicateCluster } from '../../types';

/**
 * Calculates a sharpness and quality score for a photo.
 * Uses detection confidence, face expressions, resolution, and byte density.
 */
export function calculatePhotoQualityScore(photo: Photo): {
  totalScore: number;
  sharpnessScore: number;
  expressionScore: number;
  eyeOpenScore: number;
  resolutionScore: number;
  reasons: string[];
} {
  const reasons: string[] = [];

  // 1. Resolution score (0 - 25)
  const megapixels = ((photo.width || 2000) * (photo.height || 1500)) / 1_000_000;
  const resolutionScore = Math.min(25, Math.round(megapixels * 2));
  if (megapixels > 8) reasons.push('High resolution');

  // 2. Sharpness score (0 - 40)
  // Byte density (bytes per pixel) is a well-established proxy for detail vs blur in JPEG compression
  const pixelCount = (photo.width || 2000) * (photo.height || 1500);
  const bytesPerPixel = photo.fileSize / Math.max(1, pixelCount);
  let sharpness = Math.min(40, Math.round(bytesPerPixel * 100));

  // If faces are detected, factor in detector confidence
  if (photo.faces && photo.faces.length > 0) {
    const avgFaceConf = photo.faces.reduce((acc, f) => acc + (f.confidence || 0.8), 0) / photo.faces.length;
    sharpness = Math.round(sharpness * 0.4 + avgFaceConf * 40 * 0.6);
    if (avgFaceConf >= 0.9) reasons.push('Crisp face focus');
  }

  // 3. Expression score (0 - 25)
  let expressionScore = 15;
  if (photo.faces && photo.faces.length > 0) {
    let bestExprBonus = 0;
    for (const f of photo.faces) {
      if (f.dominantExpression === 'happy') {
        bestExprBonus = Math.max(bestExprBonus, 10);
      } else if (f.dominantExpression === 'surprised' || f.dominantExpression === 'neutral') {
        bestExprBonus = Math.max(bestExprBonus, 5);
      }
    }
    expressionScore = Math.min(25, 15 + bestExprBonus);
    if (bestExprBonus >= 10) reasons.push('Smiling / Pleasant expression');
  }

  // 4. Eye & Gaze score (0 - 10)
  let eyeOpenScore = 8;
  if (photo.faces && photo.faces.length > 0) {
    // Frontal aspect ratio indicates subject looking toward camera
    const isFrontal = photo.faces.every((f) => {
      const ratio = f.box.width / Math.max(1, f.box.height);
      return ratio >= 0.75 && ratio <= 1.25;
    });
    if (isFrontal) {
      eyeOpenScore = 10;
      reasons.push('Looking at camera');
    }
  }

  const totalScore = Math.min(100, Math.round(sharpness + expressionScore + eyeOpenScore + resolutionScore));

  return {
    totalScore,
    sharpnessScore: sharpness,
    expressionScore,
    eyeOpenScore,
    resolutionScore,
    reasons,
  };
}

export function getPhotoCanonicalKey(p: Photo): string {
  const pathStr = (p.originalRemotePath || p.filePath || '').toLowerCase().replace(/\\/g, '/');
  return pathStr || p.id;
}

/**
 * Finds bursts and duplicate photos in the library and groups them into clusters.
 */
export function identifyDuplicateClusters(
  photos: Photo[],
  options?: { timeWindowSeconds?: number }
): DuplicateCluster[] {
  const windowMs = (options?.timeWindowSeconds || 20) * 1000;

  // 1. Deduplicate physical files by canonical path so the same photo is never compared against itself
  const uniquePhotosMap = new Map<string, Photo>();
  for (const p of photos) {
    if (p.isExcluded) continue;
    const key = getPhotoCanonicalKey(p);
    if (!uniquePhotosMap.has(key)) {
      uniquePhotosMap.set(key, p);
    } else {
      // Merge best attributes (faces, non-virtual preference)
      const existing = uniquePhotosMap.get(key)!;
      if (p.faces && p.faces.length > (existing.faces?.length || 0)) {
        uniquePhotosMap.set(key, p);
      }
    }
  }

  const eligiblePhotos = Array.from(uniquePhotosMap.values())
    .sort((a, b) => new Date(a.dateTaken).getTime() - new Date(b.dateTaken).getTime());

  const clusters: DuplicateCluster[] = [];
  const visitedIds = new Set<string>();

  for (let i = 0; i < eligiblePhotos.length; i++) {
    const p1 = eligiblePhotos[i];
    if (visitedIds.has(p1.id)) continue;

    const group: Photo[] = [p1];
    const t1 = new Date(p1.dateTaken).getTime();
    const p1Key = getPhotoCanonicalKey(p1);
    const p1People = new Set((p1.faces || []).map((f) => f.personId).filter(Boolean));

    for (let j = i + 1; j < eligiblePhotos.length; j++) {
      const p2 = eligiblePhotos[j];
      if (visitedIds.has(p2.id)) continue;

      const p2Key = getPhotoCanonicalKey(p2);
      // Strictly prevent identical physical files from matching as duplicate shots
      if (p1Key === p2Key || p1.id === p2.id) {
        continue;
      }

      const t2 = new Date(p2.dateTaken).getTime();
      const timeDiff = Math.abs(t2 - t1);

      // Must be taken within the time window
      if (timeDiff > windowMs) break;

      // Check similarity:
      // Condition A: Same identified people
      const p2People = new Set((p2.faces || []).map((f) => f.personId).filter(Boolean));
      let isSamePeople = false;
      if (p1People.size > 0 && p2People.size > 0) {
        let intersection = 0;
        p1People.forEach((id) => {
          if (p2People.has(id)) intersection++;
        });
        if (intersection > 0 && intersection === p1People.size && intersection === p2People.size) {
          isSamePeople = true;
        }
      }

      // Condition B: Both have same number of faces (or both 0 faces with similar aspect ratio)
      const sameFaceCount = (p1.faces?.length || 0) === (p2.faces?.length || 0);

      // Condition C: Close filename sequence (e.g. IMG_001.jpg and IMG_002.jpg)
      const base1 = p1.fileName.replace(/\D/g, '');
      const base2 = p2.fileName.replace(/\D/g, '');
      const isSequence =
        base1 &&
        base2 &&
        base1 !== base2 &&
        Math.abs(parseInt(base1, 10) - parseInt(base2, 10)) <= 3;

      if (isSamePeople || (timeDiff <= 10000 && sameFaceCount) || isSequence) {
        group.push(p2);
        visitedIds.add(p2.id);
      }
    }

    if (group.length >= 2) {
      visitedIds.add(p1.id);

      // Score each photo in the cluster to identify best shot
      const scoresMap: DuplicateCluster['scores'] = {};
      let bestPhotoId = group[0].id;
      let highestScore = -1;
      let bestReasons: string[] = [];

      for (const item of group) {
        const scoreData = calculatePhotoQualityScore(item);
        scoresMap[item.id] = {
          totalScore: scoreData.totalScore,
          sharpnessScore: scoreData.sharpnessScore,
          expressionScore: scoreData.expressionScore,
          eyeOpenScore: scoreData.eyeOpenScore,
          resolutionScore: scoreData.resolutionScore,
        };

        if (scoreData.totalScore > highestScore) {
          highestScore = scoreData.totalScore;
          bestPhotoId = item.id;
          bestReasons = scoreData.reasons;
        }
      }

      const isBurst = group.length >= 3;
      clusters.push({
        id: `cluster_${p1.id}`,
        clusterType: isBurst ? 'burst' : 'similar',
        photos: group,
        bestPhotoId,
        bestReason: bestReasons.length > 0 ? bestReasons.join(' • ') : '⭐ Best overall quality & sharpness',
        scores: scoresMap,
      });
    }
  }

  return clusters;
}

export const findDuplicateAndBurstClusters = identifyDuplicateClusters;
export const scorePhotoClarityAndExpression = calculatePhotoQualityScore;
