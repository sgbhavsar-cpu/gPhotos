import fs from 'fs';
import path from 'path';
import os from 'os';
import sharp from 'sharp';
import { rotatePhotoFile, editPhotoFile, rotatePhotoWithOfflineQueue } from '../src/main/services/virtualMirrorService';
import { purgeHeicCache } from '../src/main/services/heicService';
import {
  purgeCachedThumbnailsForFile,
  refreshThumbnailsFromSource,
  getOrGenerateCachedThumbnail,
} from '../src/main/services/thumbnailCacheService';

async function runTests() {
  console.log('=== STARTING HEIC ROTATION & THUMBNAIL CACHE REFRESH TESTS ===\n');
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, message: string) {
    if (condition) {
      console.log(`[PASS] ${message}`);
      passed++;
    } else {
      console.error(`[FAIL] ${message}`);
      failed++;
    }
  }

  const testTempDir = path.join(os.tmpdir(), `gphotos_heic_test_${Date.now()}`);
  fs.mkdirSync(testTempDir, { recursive: true });

  try {
    // -------------------------------------------------------------
    // 1. HEIC Safety & Rejection Tests
    // -------------------------------------------------------------
    const mockHeicPath = path.join(testTempDir, 'sample_photo.HEIC');
    const mockHeicContent = Buffer.from('ftypheicMOCK_HEIC_FILE_HEADER_BYTES_DO_NOT_OVERWRITE');
    fs.writeFileSync(mockHeicPath, mockHeicContent);

    // Test 1: rotatePhotoFile rejects HEIC
    const rotateRes = await rotatePhotoFile(mockHeicPath, 90);
    assert(!rotateRes.success, 'rotatePhotoFile returns success: false for HEIC image');
    assert(
      typeof rotateRes.error === 'string' && rotateRes.error.includes('HEIC/HEIF'),
      `rotatePhotoFile provides explanatory error: "${rotateRes.error}"`
    );

    // Test 2: Source HEIC file content is completely intact and unchanged
    const afterRotateContent = fs.readFileSync(mockHeicPath);
    assert(
      afterRotateContent.equals(mockHeicContent),
      'Source HEIC file bytes are 100% preserved and untouched after rejected rotation'
    );

    // Test 3: editPhotoFile rejects HEIC
    const editRes = await editPhotoFile({
      filePath: mockHeicPath,
      base64Data: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==',
    });
    assert(!editRes.success, 'editPhotoFile returns success: false for HEIC image');
    assert(
      typeof editRes.error === 'string' && editRes.error.includes('HEIC/HEIF'),
      `editPhotoFile provides explanatory error: "${editRes.error}"`
    );

    // Test 4: rotatePhotoWithOfflineQueue rejects HEIC without queuing
    const queueRes = await rotatePhotoWithOfflineQueue({
      localFilePath: mockHeicPath,
      rotationDegrees: 90,
    });
    assert(!queueRes.success, 'rotatePhotoWithOfflineQueue returns success: false for HEIC image');
    assert(!queueRes.isQueued, 'rotatePhotoWithOfflineQueue does not enqueue HEIC rotation');

    // -------------------------------------------------------------
    // 2. Cache Purge & Refresh Tests
    // -------------------------------------------------------------
    // Test 5: purgeHeicCache executes cleanly without throwing
    let purgeClean = true;
    try {
      purgeHeicCache(mockHeicPath);
    } catch {
      purgeClean = false;
    }
    assert(purgeClean, 'purgeHeicCache runs cleanly on HEIC file path');

    // Create a real JPEG test photo
    const testJpgPath = path.join(testTempDir, 'real_test_photo.jpg');
    await sharp({
      create: {
        width: 600,
        height: 400,
        channels: 3,
        background: { r: 64, g: 128, b: 255 },
      },
    })
      .jpeg()
      .toFile(testJpgPath);

    assert(fs.existsSync(testJpgPath), 'Created valid test JPEG image file');

    // Test 6: getOrGenerateCachedThumbnail generates a 250px thumbnail
    const thumb250 = await getOrGenerateCachedThumbnail(testJpgPath, 250);
    assert(!!thumb250, 'getOrGenerateCachedThumbnail generated 250px thumbnail');
    assert(
      !!thumb250?.filePath && fs.existsSync(thumb250.filePath),
      `Cached 250px thumbnail file exists on disk: ${thumb250?.filePath}`
    );

    // Test 7: purgeCachedThumbnailsForFile clears cached files
    await purgeCachedThumbnailsForFile(testJpgPath);
    const cachedFileAfterPurge = thumb250?.filePath ? fs.existsSync(thumb250.filePath) : false;
    assert(!cachedFileAfterPurge, 'purgeCachedThumbnailsForFile removed cached thumbnail from disk');

    // Test 8: refreshThumbnailsFromSource refreshes thumbnails
    const refreshRes = await refreshThumbnailsFromSource([
      { filePath: testJpgPath },
    ]);
    assert(refreshRes.refreshedCount === 1, `refreshThumbnailsFromSource refreshed 1 photo (got ${refreshRes.refreshedCount})`);
    assert(refreshRes.errors.length === 0, 'refreshThumbnailsFromSource reported 0 errors');

    // Test 9: Verify fresh cached thumbnail exists after refresh
    const freshThumb250 = await getOrGenerateCachedThumbnail(testJpgPath, 250);
    assert(!!freshThumb250?.filePath && fs.existsSync(freshThumb250.filePath), 'Fresh thumbnail exists on disk after refresh');

    // Test 10: Virtual mirror scenario with remote original and local mirror thumbnail
    const remoteSourcePath = path.join(testTempDir, 'nas_original.jpg');
    const localMirrorThumbPath = path.join(testTempDir, 'local_mirror_thumb.jpg');
    await sharp({
      create: { width: 800, height: 600, channels: 3, background: { r: 200, g: 50, b: 50 } },
    }).jpeg().toFile(remoteSourcePath);

    fs.writeFileSync(localMirrorThumbPath, Buffer.from('stale_thumbnail_data'));

    const mirrorRefresh = await refreshThumbnailsFromSource([
      { filePath: localMirrorThumbPath, originalRemotePath: remoteSourcePath },
    ]);
    assert(mirrorRefresh.refreshedCount === 1, 'refreshThumbnailsFromSource refreshed virtual mirror item');
    const updatedMirrorThumb = fs.readFileSync(localMirrorThumbPath);
    assert(
      !updatedMirrorThumb.equals(Buffer.from('stale_thumbnail_data')),
      'Virtual mirror thumbnail was re-generated and updated from source file'
    );

  } finally {
    // Cleanup temporary test directory
    try {
      fs.rmSync(testTempDir, { recursive: true, force: true });
    } catch {}
  }

  console.log(`\n=== RESULTS: ${passed}/${passed + failed} TESTS PASSED ===`);
  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Test execution error:', err);
  process.exit(1);
});
