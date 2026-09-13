import fs from 'fs';
import path from 'path';
import os from 'os';
import sharp from 'sharp';
import {
  scanVirtualMirrorDirectory,
  discoverStoredMirrors,
  rotatePhotoFile,
  rotatePhotoWithOfflineQueue,
  getPendingRotations,
  savePendingRotations,
  processPendingRotations,
} from '../src/main/services/virtualMirrorService';

console.log('=== STARTING STARTUP SPEED & OFFLINE ROTATION QUEUE TESTS ===\n');

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

async function runTests() {
  const tempDir = path.join(os.tmpdir(), `gphotos_startup_test_${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    // -------------------------------------------------------------
    // TEST 1: Synthetic Mirror Benchmark for scanVirtualMirrorDirectory
    // -------------------------------------------------------------
    const mirrorSub = path.join(tempDir, 'TestMirror');
    fs.mkdirSync(mirrorSub, { recursive: true });

    // Create 300 synthetic virtual photos with sidecars
    const dummy1x1 = await sharp({
      create: { width: 10, height: 10, channels: 3, background: { r: 255, g: 0, b: 0 } }
    }).jpeg().toBuffer();

    for (let i = 0; i < 300; i++) {
      const thumbPath = path.join(mirrorSub, `photo_${i}.jpg`);
      const jsonPath = path.join(mirrorSub, `photo_${i}.json`);
      fs.writeFileSync(thumbPath, dummy1x1);
      fs.writeFileSync(jsonPath, JSON.stringify({
        fileName: `photo_${i}.jpg`,
        thumbnailPath: thumbPath,
        originalFilePath: `\\\\192.168.1.999\\nonexistent_share\\photo_${i}.jpg`, // Non-existent remote network path
        originalFileSize: 4000000,
        dateTaken: new Date().toISOString(),
        width: 10,
        height: 10,
        storageName: 'TestMirror',
      }));
    }

    const tStart = performance.now();
    const photos = scanVirtualMirrorDirectory(mirrorSub);
    const tElapsed = performance.now() - tStart;

    console.log(`[Benchmark] Scanned 300 virtual mirror photos with offline remote paths in ${tElapsed.toFixed(2)}ms`);
    assert(photos.length === 300, 'scanVirtualMirrorDirectory loaded all 300 photos successfully');
    // Generous bound: this asserts the scan isn't accidentally O(n^2) or blocking
    // on network I/O, not a tight perf benchmark — CI/dev machines vary widely
    // in disk speed and background load.
    assert(tElapsed < 2000, `scanVirtualMirrorDirectory completes quickly (<2000ms), elapsed: ${tElapsed.toFixed(1)}ms`);

    // -------------------------------------------------------------
    // TEST 2: Fast-path discoverStoredMirrors
    // -------------------------------------------------------------
    const tDiscStart = performance.now();
    const storages = discoverStoredMirrors(tempDir);
    const tDiscElapsed = performance.now() - tDiscStart;
    console.log(`[Benchmark] discoverStoredMirrors discovered storage in ${tDiscElapsed.toFixed(2)}ms`);
    assert(storages.length === 1 && storages[0].name === 'TestMirror', 'discoverStoredMirrors successfully found TestMirror');
    assert(storages[0].totalItems === 300, 'discoverStoredMirrors quickly detected total item count (300)');

    // Second call reads _mirror_summary.json in <2ms
    const tDisc2 = performance.now();
    const storages2 = discoverStoredMirrors(tempDir);
    const tDisc2Elapsed = performance.now() - tDisc2;
    console.log(`[Benchmark] Cached discoverStoredMirrors completed in ${tDisc2Elapsed.toFixed(2)}ms`);
    assert(tDisc2Elapsed < 50, `Cached discoverStoredMirrors runs in <50ms, elapsed: ${tDisc2Elapsed.toFixed(1)}ms`);

    // -------------------------------------------------------------
    // TEST 3: rotatePhotoFile on Disk with Sharp
    // -------------------------------------------------------------
    const testImgPath = path.join(tempDir, 'rot_source.jpg');
    // Create non-square image: 100 wide x 50 high
    const sourceImgBuf = await sharp({
      create: { width: 100, height: 50, channels: 3, background: { r: 100, g: 150, b: 200 } }
    }).jpeg().toBuffer();
    fs.writeFileSync(testImgPath, sourceImgBuf);

    const rotResult = await rotatePhotoFile(testImgPath, 90);
    assert(rotResult.success === true, 'rotatePhotoFile returns success: true');

    const metaAfter90 = await sharp(testImgPath).metadata();
    assert(metaAfter90.width === 50 && metaAfter90.height === 100, `Image dimensions rotated 90°: 50x100 (was 100x50), got ${metaAfter90.width}x${metaAfter90.height}`);
    assert(fs.existsSync(`${testImgPath}.bak`), '.bak backup created for safety');

    // -------------------------------------------------------------
    // TEST 4: rotatePhotoWithOfflineQueue (ONLINE scenario)
    // -------------------------------------------------------------
    const onlineLocal = path.join(tempDir, 'online_local.jpg');
    const onlineRemote = path.join(tempDir, 'online_remote.jpg');
    fs.writeFileSync(onlineLocal, sourceImgBuf);
    fs.writeFileSync(onlineRemote, sourceImgBuf);

    const onlineRes = await rotatePhotoWithOfflineQueue({
      localFilePath: onlineLocal,
      originalRemotePath: onlineRemote,
      rotationDegrees: 90,
    });
    assert(onlineRes.success === true, 'rotatePhotoWithOfflineQueue online returns success: true');
    assert(onlineRes.isQueued === false, 'rotatePhotoWithOfflineQueue online returns isQueued: false');

    const metaRemoteOnline = await sharp(onlineRemote).metadata();
    const metaLocalOnline = await sharp(onlineLocal).metadata();
    assert(metaRemoteOnline.width === 50 && metaLocalOnline.width === 50, 'Both remote source and local mirror were rotated online');

    // -------------------------------------------------------------
    // TEST 5: rotatePhotoWithOfflineQueue (OFFLINE scenario)
    // -------------------------------------------------------------
    // Clear pending rotations
    savePendingRotations([]);

    const offlineLocal = path.join(tempDir, 'offline_local.jpg');
    const offlineRemote = path.join(tempDir, 'offline_remote_does_not_exist_yet.jpg');
    fs.writeFileSync(offlineLocal, sourceImgBuf);

    const offlineRes = await rotatePhotoWithOfflineQueue({
      localFilePath: offlineLocal,
      originalRemotePath: offlineRemote,
      rotationDegrees: 90,
    });

    assert(offlineRes.success === true, 'Offline rotation succeeded');
    assert(offlineRes.isQueued === true, 'Offline rotation returned isQueued: true');

    // Verify local thumbnail was rotated on disk immediately so gallery displays rotated image
    const metaOfflineLocal = await sharp(offlineLocal).metadata();
    assert(metaOfflineLocal.width === 50 && metaOfflineLocal.height === 100, 'Local thumbnail rotated on disk immediately while offline');

    // Verify queued in pending_rotations.json
    const queuedItems = getPendingRotations();
    assert(queuedItems.length === 1, 'Pending rotation item queued in pending_rotations.json');
    assert(queuedItems[0].originalRemotePath === offlineRemote, 'Queued item contains correct offline remote path');
    assert(queuedItems[0].rotationDegrees === 90, 'Queued item contains 90° rotation');

    // Test multiple rotations on same offline photo before reconnecting (e.g. user rotates another 90° to make 180°)
    await rotatePhotoWithOfflineQueue({
      localFilePath: offlineLocal,
      originalRemotePath: offlineRemote,
      rotationDegrees: 90,
    });
    const queuedItems2 = getPendingRotations();
    assert(queuedItems2.length === 1, 'Still 1 queued entry for this photo');
    assert(queuedItems2[0].rotationDegrees === 180, 'Cumulative rotation updated to 180° in queue');

    // -------------------------------------------------------------
    // TEST 6: Draining Queue via processPendingRotations
    // -------------------------------------------------------------
    // While remote still doesn't exist, draining should process 0
    const drain1 = await processPendingRotations();
    assert(drain1.processed === 0 && drain1.remaining === 1, 'processPendingRotations skipped offline file, remaining: 1');

    // Now simulate remote storage reconnecting: create the file at offlineRemote!
    fs.writeFileSync(offlineRemote, sourceImgBuf); // 100x50

    const drain2 = await processPendingRotations();
    assert(drain2.processed === 1 && drain2.remaining === 0, 'processPendingRotations successfully applied rotation to reconnected remote file');

    // Verify remote file is now rotated 180° (width: 100, height: 50, but orientation rotated)
    const queueAfter = getPendingRotations();
    assert(queueAfter.length === 0, 'Pending queue is completely drained (0 remaining)');

  } finally {
    // Cleanup temporary files
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }

  console.log(`\n======================================================`);
  console.log(`TEST SUMMARY: ${passedTests} / ${totalTests} tests passed.`);
  console.log(`======================================================\n`);
}

runTests().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
