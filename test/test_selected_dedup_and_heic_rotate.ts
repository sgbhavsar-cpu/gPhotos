import fs from 'fs';
import path from 'path';
import os from 'os';
import sharp from 'sharp';
import { createClusterFromSelectedPhotos } from '../src/renderer/src/services/deduplication';
import { rotatePhotoFile, rotatePhotoWithOfflineQueue } from '../src/main/services/virtualMirrorService';
import { Photo } from '../src/types';

console.log('=== RUNNING TESTS: SELECTED PHOTO DEDUPLICATION & HEIC ROTATION ===\n');

let passedTests = 0;
let totalTests = 0;

function assert(condition: boolean, name: string) {
  totalTests++;
  if (condition) {
    console.log(`[PASS] Test ${totalTests}: ${name}`);
    passedTests++;
  } else {
    console.error(`[FAIL] Test ${totalTests}: ${name}`);
    process.exitCode = 1;
  }
}

async function runAll() {
  // -------------------------------------------------------------
  // PART 1: Test Selected Photo Deduplication & Best Shot Scoring
  // -------------------------------------------------------------
  console.log('--- PART 1: Selected Deduplication Cluster & Best Shot ---');

  // Test 1: Fewer than 2 photos returns null
  const nullCluster = createClusterFromSelectedPhotos([]);
  assert(nullCluster === null, 'createClusterFromSelectedPhotos returns null for empty array');

  const singleCluster = createClusterFromSelectedPhotos([{ id: 'p1', fileName: '1.jpg', filePath: '/1.jpg', dateTaken: '2026-01-01', fileSize: 1000 }]);
  assert(singleCluster === null, 'createClusterFromSelectedPhotos returns null for single photo');

  // Test 2: Multiple selected photos grouped into 1 cluster with scores
  const samplePhotos: Photo[] = [
    {
      id: 'photo_blurry',
      fileName: 'IMG_1001.JPG',
      filePath: 'C:\\Photos\\IMG_1001.JPG',
      fileSize: 200000,
      width: 1920,
      height: 1080,
      dateTaken: '2026-05-10T14:30:00Z',
      faces: [
        {
          id: 'f1',
          box: { x: 100, y: 100, width: 80, height: 80 },
          confidence: 0.65,
          dominantExpression: 'neutral',
        },
      ],
    },
    {
      id: 'photo_best_shot',
      fileName: 'IMG_1002.JPG',
      filePath: 'C:\\Photos\\IMG_1002.JPG',
      fileSize: 2500000,
      width: 3840,
      height: 2160,
      dateTaken: '2026-05-10T14:30:02Z',
      faces: [
        {
          id: 'f2',
          box: { x: 150, y: 150, width: 120, height: 120 },
          confidence: 0.98,
          dominantExpression: 'happy',
        },
      ],
    },
    {
      id: 'photo_medium',
      fileName: 'IMG_1003.JPG',
      filePath: 'C:\\Photos\\IMG_1003.JPG',
      fileSize: 800000,
      width: 2560,
      height: 1440,
      dateTaken: '2026-05-10T14:30:04Z',
      faces: [
        {
          id: 'f3',
          box: { x: 120, y: 120, width: 90, height: 90 },
          confidence: 0.85,
          dominantExpression: 'neutral',
        },
      ],
    },
  ];

  const cluster = createClusterFromSelectedPhotos(samplePhotos);
  assert(cluster !== null, 'createClusterFromSelectedPhotos returned valid cluster');
  assert(cluster!.photos.length === 3, `Cluster contains 3 photos (got ${cluster?.photos.length})`);
  assert(cluster!.bestPhotoId === 'photo_best_shot', `Correctly chose best shot photo_best_shot (got ${cluster?.bestPhotoId})`);
  assert(cluster!.scores['photo_best_shot'] !== undefined, 'Scores dictionary contains photo_best_shot');
  assert(
    cluster!.scores['photo_best_shot'].totalScore > cluster!.scores['photo_blurry'].totalScore,
    'Best shot has higher score than blurry photo'
  );
  assert(
    cluster!.scores['photo_best_shot'].expressionScore > cluster!.scores['photo_blurry'].expressionScore,
    'Smiling photo gets higher expression score'
  );

  // -------------------------------------------------------------
  // PART 2: Test HEIC Thumbnail Rotation
  // -------------------------------------------------------------
  console.log('\n--- PART 2: HEIC Local Thumbnail Rotation ---');
  const tempDir = path.join(os.tmpdir(), `gphotos_heic_test_${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    const thumbPath = path.join(tempDir, 'IMG_9999.heic');
    const jsonPath = path.join(tempDir, 'IMG_9999.json');

    // Create a 400x200 JPEG buffer saved to thumbPath (named .heic as in Virtual Mirrors)
    const initialJpg = await sharp({
      create: { width: 400, height: 200, channels: 3, background: { r: 50, g: 100, b: 200 } }
    }).jpeg().toBuffer();

    fs.writeFileSync(thumbPath, initialJpg);
    fs.writeFileSync(
      jsonPath,
      JSON.stringify({
        fileName: 'IMG_9999.heic',
        width: 400,
        height: 200,
        originalFilePath: '\\\\NAS\\FamilyPhotos\\IMG_9999.heic',
        storageName: 'TestNas',
      }, null, 2)
    );

    // Call rotatePhotoWithOfflineQueue on this HEIC thumbnail
    const rotateResult = await rotatePhotoWithOfflineQueue({
      localFilePath: thumbPath,
      originalRemotePath: '\\\\NAS\\FamilyPhotos\\IMG_9999.heic',
      rotationDegrees: 90,
    });

    assert(rotateResult.success === true, `HEIC rotation succeeded: ${rotateResult.message}`);
    assert(rotateResult.isQueued === false, 'HEIC rotation does not queue unsupported remote mutation');

    // Verify sidecar JSON was updated with swapped width/height and rotation 90
    const meta = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    assert(meta.width === 200, `Sidecar JSON width updated to 200 (got ${meta.width})`);
    assert(meta.height === 400, `Sidecar JSON height updated to 400 (got ${meta.height})`);
    assert(meta.rotation === 90, `Sidecar JSON rotation set to 90 (got ${meta.rotation})`);

    // Verify the actual image file on disk was physically rotated to 200x400
    const rotatedInfo = await sharp(thumbPath).metadata();
    assert(rotatedInfo.width === 200, `Rotated image file width is 200 (got ${rotatedInfo.width})`);
    assert(rotatedInfo.height === 400, `Rotated image file height is 400 (got ${rotatedInfo.height})`);

    // -------------------------------------------------------------
    // PART 3: Test Direct Raw HEIC Rotation & Persistent Caching
    // -------------------------------------------------------------
    console.log('\n--- PART 3: Direct Raw HEIC Rotation & Persistent Caching ---');
    const { getHeicSavedRotation, saveHeicSavedRotation, clearHeicSavedRotation } = await import('../src/main/services/heicRotationStore');
    const { rotateCachedHeicThumbnail, getOrGenerateCachedThumbnail } = await import('../src/main/services/thumbnailCacheService');

    const testRawHeicPath = path.join(tempDir, 'IMG_RAW_HEIC.heic');
    clearHeicSavedRotation(testRawHeicPath);

    // Verify initial rotation is 0
    assert(getHeicSavedRotation(testRawHeicPath) === 0, 'Initial HEIC rotation is 0');

    // Create a mock raw image file at testRawHeicPath
    const sampleBuffer = await sharp({
      create: { width: 300, height: 150, channels: 3, background: { r: 100, g: 150, b: 200 } }
    }).jpeg().toBuffer();
    fs.writeFileSync(testRawHeicPath, sampleBuffer);

    // Rotate HEIC thumbnail by 90 degrees
    const totalRot1 = await rotateCachedHeicThumbnail(testRawHeicPath, 90);
    assert(totalRot1 === 90, `rotateCachedHeicThumbnail returned 90 degrees (got ${totalRot1})`);
    assert(getHeicSavedRotation(testRawHeicPath) === 90, 'Persistent HEIC rotation store saved 90 degrees');

    // Generate/fetch cached thumbnail - verify it generates and caches rotated
    const thumbResult = await getOrGenerateCachedThumbnail(testRawHeicPath, 250);
    assert(thumbResult !== null, 'getOrGenerateCachedThumbnail returned thumbnail result for HEIC');
    if (thumbResult && thumbResult.filePath) {
      assert(fs.existsSync(thumbResult.filePath), 'Rotated thumbnail exists on disk in cache directory');
    }

    // Accumulate second rotation (+90 degrees -> 180)
    const totalRot2 = await rotateCachedHeicThumbnail(testRawHeicPath, 90);
    assert(totalRot2 === 180, `Second rotation accumulated to 180 degrees (got ${totalRot2})`);
    assert(getHeicSavedRotation(testRawHeicPath) === 180, 'Persistent HEIC rotation store saved 180 degrees');

    // Test calling rotatePhotoWithOfflineQueue on a raw HEIC file
    const queueResult = await rotatePhotoWithOfflineQueue({
      localFilePath: testRawHeicPath,
      rotationDegrees: 90,
    });
    assert(queueResult.success === true, 'rotatePhotoWithOfflineQueue succeeded for raw HEIC');
    assert(queueResult.isHeic === true, 'Result flagged as isHeic: true');
    assert(queueResult.isHeicRotated === true, 'Result flagged as isHeicRotated: true');
    assert(queueResult.heicRotation === 270, `Result heicRotation is 270 (got ${queueResult.heicRotation})`);
    assert(queueResult.rotation === 270, `Result rotation is 270 (got ${queueResult.rotation})`);

    // Clean up test HEIC path
    clearHeicSavedRotation(testRawHeicPath);
    assert(getHeicSavedRotation(testRawHeicPath) === 0, 'HEIC rotation cleanly cleared from store');

  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }

  console.log(`\n=== ALL TESTS FINISHED: ${passedTests}/${totalTests} PASSED ===`);
}

runAll().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
