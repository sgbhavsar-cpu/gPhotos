import fs from 'fs';
import path from 'path';
import os from 'os';
import { thumbnailWorker } from '../src/main/services/thumbnailWorkerService';
import { Photo } from '../src/types';

async function runThumbnailProgressTest() {
  console.log('================================================================');
  console.log('⚡ TEST: NETWORK STORAGE BACKGROUND THUMBNAIL CACHING & PROGRESS');
  console.log('================================================================\n');

  const testDir = path.join(os.tmpdir(), `gphotos_precache_test_${Date.now()}`);
  fs.mkdirSync(testDir, { recursive: true });

  try {
    // ------------------------------------------------------------------------
    // Step 1: Initial Status Check
    // ------------------------------------------------------------------------
    console.log('📊 Step 1: Checking Initial Worker Status...');
    const initialStatus = thumbnailWorker.getStatus();
    console.log('  Initial Status:', initialStatus);
    if (typeof initialStatus.current !== 'number' || typeof initialStatus.total !== 'number') {
      throw new Error('Worker status missing numeric current or total fields');
    }
    console.log('  ✓ Initial status reported accurately.');

    // ------------------------------------------------------------------------
    // Step 2: Enqueueing Synthetic Mirror Photos
    // ------------------------------------------------------------------------
    console.log('\n📁 Step 2: Creating Synthetic Network Mirror Photos and Enqueueing...');
    const testPhotos: Photo[] = [];
    let sharp: any = null;
    try {
      sharp = require('sharp');
    } catch {}

    for (let i = 1; i <= 6; i++) {
      const imgPath = path.join(testDir, `remote_mirror_photo_${i}.jpg`);
      if (sharp) {
        await sharp({
          create: {
            width: 100,
            height: 100,
            channels: 3,
            background: { r: i * 30, g: 100, b: 200 }
          }
        }).jpeg().toFile(imgPath);
      } else {
        fs.writeFileSync(imgPath, 'synthetic-image-bytes');
      }

      testPhotos.push({
        id: `mirror_p_${i}`,
        filePath: imgPath,
        fileName: `remote_mirror_photo_${i}.jpg`,
        fileSize: 1024,
        fileDate: new Date().toISOString(),
        dateTaken: new Date().toISOString(),
        year: 2026,
        month: 9,
        day: 13,
        isVirtual: true,
        storageName: 'TestNAS',
        originalRemotePath: `\\\\NAS\\Photos\\photo_${i}.jpg`,
      });
    }

    // Set resource limits (e.g. 40% CPU, 1024MB RAM)
    thumbnailWorker.setResourceLimits({
      maxCpuPercent: 40,
      maxRamMb: 1024,
      enabled: true,
    });

    // Enqueue photos
    thumbnailWorker.enqueuePhotos(testPhotos);

    const queuedStatus = thumbnailWorker.getStatus();
    console.log(`  After Enqueue: current=${queuedStatus.current}, total=${queuedStatus.total}, isRunning=${queuedStatus.isRunning}`);
    if (queuedStatus.total < 6) {
      throw new Error(`Expected at least 6 total items, got ${queuedStatus.total}`);
    }
    console.log('  ✓ Photos successfully enqueued into background worker.');

    // ------------------------------------------------------------------------
    // Step 3: Pause & Resume Verification
    // ------------------------------------------------------------------------
    console.log('\n⏸️ Step 3: Testing Pause and Resume functionality...');
    thumbnailWorker.pause();
    const pausedStatus = thumbnailWorker.getStatus();
    console.log(`  Paused Status: isPaused=${pausedStatus.paused}`);
    if (!pausedStatus.paused) {
      throw new Error('Worker was expected to be paused');
    }

    thumbnailWorker.resume();
    const resumedStatus = thumbnailWorker.getStatus();
    console.log(`  Resumed Status: isPaused=${resumedStatus.paused}`);
    if (resumedStatus.paused) {
      throw new Error('Worker was expected to be resumed');
    }
    console.log('  ✓ Pause and Resume toggled correctly.');

    // ------------------------------------------------------------------------
    // Step 4: Await Background Processing with Progress Updates
    // ------------------------------------------------------------------------
    console.log('\n⏳ Step 4: Monitoring Background Thumbnail Processing Progress...');
    const maxWaitMs = 15000;
    const startWait = Date.now();

    while (Date.now() - startWait < maxWaitMs) {
      const currentStatus = thumbnailWorker.getStatus();
      const pct = currentStatus.total > 0
        ? Math.round((currentStatus.current / currentStatus.total) * 100)
        : 0;

      console.log(`  [PROGRESS] ${currentStatus.current}/${currentStatus.total} cached (${pct}%) | Active=${currentStatus.isRunning} | File=${currentStatus.currentFile || 'idle'}`);

      if (currentStatus.current >= currentStatus.total) {
        console.log('  ✓ All queued thumbnails processed in background!');
        break;
      }
      await new Promise((r) => setTimeout(r, 400));
    }

    const finalStatus = thumbnailWorker.getStatus();
    const finalPercent = finalStatus.total > 0
      ? Math.round((finalStatus.current / finalStatus.total) * 100)
      : 100;

    console.log(`  Final State: current=${finalStatus.current}, total=${finalStatus.total}, percent=${finalPercent}%`);
    if (finalStatus.current < 6) {
      throw new Error(`Expected at least 6 photos processed, got ${finalStatus.current}`);
    }

    console.log('\n================================================================');
    console.log('✅ ALL TESTS PASSED: BACKGROUND THUMBNAIL CACHING & PROGRESS!');
    console.log('================================================================');
    process.exit(0);
  } catch (err) {
    console.error('❌ Test failed:', err);
    process.exit(1);
  } finally {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  }
}

runThumbnailProgressTest();
