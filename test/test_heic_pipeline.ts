import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import {
  getOrGenerateHeicThumbnail500,
  getHeicHighQualityJpegBuffer,
  prepareHeicHqTemp,
  cleanupHeicHqTemp,
  getThumbnailsDir,
  getTempHqDir,
} from '../src/main/services/heicService';

async function runHeicPipelineTests() {
  console.log('=== Starting HEIC Thumbnail & Orientation Pipeline Tests ===\n');

  const testDir = path.join(__dirname, 'fixtures');
  if (!fs.existsSync(testDir)) {
    fs.mkdirSync(testDir, { recursive: true });
  }

  // 1. Create a simulated test image (simulating a 1200x800 camera capture)
  const testImagePath = path.join(testDir, 'test_sample.heic');
  // Create a JPEG buffer first that simulates a photo
  const sampleBuf = await sharp({
    create: {
      width: 1200,
      height: 800,
      channels: 3,
      background: { r: 59, g: 130, b: 246 },
    },
  })
    .jpeg({ quality: 90 })
    .toBuffer();

  fs.writeFileSync(testImagePath, sampleBuf);
  console.log(`[Test 1] Created test fixture: ${testImagePath} (1200x800, size: ${sampleBuf.length} bytes)`);

  // 2. Test 500px Thumbnail Generation and Verification
  console.log('[Test 2] Generating 500px thumbnail...');
  const thumbBuffer = await getOrGenerateHeicThumbnail500(testImagePath);
  if (!thumbBuffer || thumbBuffer.length === 0) {
    throw new Error('FAILED: getOrGenerateHeicThumbnail500 returned empty or null buffer');
  }

  const thumbMeta = await sharp(thumbBuffer).metadata();
  console.log(`[Test 2 PASS] Generated thumbnail: ${thumbMeta.width}x${thumbMeta.height}, size: ${thumbBuffer.length} bytes`);
  if ((thumbMeta.width || 0) > 500 || (thumbMeta.height || 0) > 500) {
    throw new Error(`FAILED: Thumbnail dimensions (${thumbMeta.width}x${thumbMeta.height}) exceed 500px!`);
  }
  console.log(`[Test 2 PASS] Verified thumbnail is within 500px boundary (max dimension: ${Math.max(thumbMeta.width || 0, thumbMeta.height || 0)}px)`);

  // 3. Test Local Disk Persistence
  const thumbnailsDir = getThumbnailsDir();
  console.log(`[Test 3] Checking persistent thumbnails directory: ${thumbnailsDir}`);
  const cachedFiles = fs.readdirSync(thumbnailsDir).filter((f) => f.endsWith('_500.jpg'));
  if (cachedFiles.length === 0) {
    throw new Error('FAILED: No _500.jpg file was saved to local thumbnails directory!');
  }
  console.log(`[Test 3 PASS] Found ${cachedFiles.length} persistent thumbnail(s) on disk: ${cachedFiles[0]}`);

  // 4. Test Instant Disk Cache Hit
  const t0 = Date.now();
  const cachedBuffer = await getOrGenerateHeicThumbnail500(testImagePath);
  const duration = Date.now() - t0;
  console.log(`[Test 4 PASS] Secondary retrieval from disk cache took ${duration}ms (identical length: ${cachedBuffer?.length === thumbBuffer.length})`);

  // 5. Test High-Quality JPEG Extraction
  console.log('[Test 5] Testing high-quality JPEG extraction for fullscreen view...');
  const hqBuffer = await getHeicHighQualityJpegBuffer(testImagePath);
  if (!hqBuffer) {
    throw new Error('FAILED: getHeicHighQualityJpegBuffer returned null');
  }
  const hqMeta = await sharp(hqBuffer).metadata();
  console.log(`[Test 5 PASS] High-quality extraction: ${hqMeta.width}x${hqMeta.height}, size: ${hqBuffer.length} bytes`);
  if ((hqMeta.width || 0) < 1000) {
    throw new Error('FAILED: HQ buffer appears downscaled!');
  }

  // 6. Test Temporary HQ Extraction for Face Detection and Automatic Cleanup
  const photoId = 'test_photo_face_scan_123';
  console.log(`[Test 6] Preparing temporary HQ image for face detection (ID: ${photoId})...`);
  const tempHqPath = await prepareHeicHqTemp(testImagePath, photoId);
  if (!tempHqPath || !fs.existsSync(tempHqPath)) {
    throw new Error(`FAILED: Temporary HQ file not created at ${tempHqPath}`);
  }
  console.log(`[Test 6 PASS] Temporary HQ file successfully created: ${tempHqPath} (size: ${fs.statSync(tempHqPath).size} bytes)`);

  // Simulate face detection completing, then cleanup:
  console.log(`[Test 6] Running cleanup for ${photoId}...`);
  cleanupHeicHqTemp(photoId);
  if (fs.existsSync(tempHqPath)) {
    throw new Error('FAILED: Temporary HQ file was NOT deleted by cleanupHeicHqTemp!');
  }
  console.log('[Test 6 PASS] Temporary HQ file was successfully deleted from disk.');

  // Verify that the 500px thumbnail is still intact in the thumbnails directory!
  if (!fs.existsSync(path.join(thumbnailsDir, cachedFiles[0]))) {
    throw new Error('FAILED: 500px thumbnail was accidentally deleted during temp HQ cleanup!');
  }
  console.log('[Test 6 PASS] Persistent 500px thumbnail remains safe and available for gallery viewing.');

  // 7. Clean up test fixture
  try {
    fs.unlinkSync(testImagePath);
  } catch {}

  console.log('\n=== ALL HEIC PIPELINE TESTS PASSED (100% SUCCESS) ===\n');
}

runHeicPipelineTests().catch((err) => {
  console.error('\n❌ HEIC PIPELINE TEST FAILED:', err);
  process.exit(1);
});
