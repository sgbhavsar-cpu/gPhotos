import fs from 'fs';
import path from 'path';
import os from 'os';
import sharp from 'sharp';
import {
  saveStorageCheckpoint,
  loadStorageCheckpoint,
  getAllStorageCheckpoints,
  syncVirtualStorage,
} from '../src/main/services/virtualMirrorService';
import { thumbnailWorker } from '../src/main/services/thumbnailWorkerService';
import { StorageSyncCheckpoint, VirtualStorageConfig } from '../src/types';

console.log('=== STARTING STORAGE SYNC & THUMBNAIL WORKER CHECKPOINT & RESUME TESTS ===\n');

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
  const tempDir = path.join(os.tmpdir(), `gphotos_checkpoint_test_${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  const networkSource = path.join(tempDir, 'RemoteNAS');
  fs.mkdirSync(networkSource, { recursive: true });

  const localMirrorRoot = path.join(tempDir, 'LocalMirrors');
  fs.mkdirSync(localMirrorRoot, { recursive: true });

  // Isolate the shared thumbnailWorker singleton's checkpoint from the real,
  // persisted userData checkpoint — otherwise this test both pollutes a real
  // library's progress tracking and can take a very long time reconciling
  // against a large real queue.
  const workerCheckpointDir = path.join(tempDir, 'worker_checkpoint');
  fs.mkdirSync(workerCheckpointDir, { recursive: true });
  thumbnailWorker.useIsolatedStateForTests(workerCheckpointDir);

  try {
    // Generate 25 sample image files in networkSource
    const sampleJpg = await sharp({
      create: { width: 40, height: 40, channels: 3, background: { r: 100, g: 150, b: 200 } }
    }).jpeg().toBuffer();

    const filePaths: string[] = [];
    for (let i = 0; i < 25; i++) {
      const p = path.join(networkSource, `img_${String(i).padStart(3, '0')}.jpg`);
      fs.writeFileSync(p, sampleJpg);
      filePaths.push(p);
    }

    // -------------------------------------------------------------
    // TEST 1: Storage Sync Checkpoint Save & Load
    // -------------------------------------------------------------
    const storageName = 'TestNAS';
    const initialCp: StorageSyncCheckpoint = {
      storageName,
      networkSourcePath: networkSource,
      localMirrorRoot,
      phase: 'interrupted',
      processedCount: 10,
      totalDiscovered: 25,
      lastProcessedIndex: 9,
      lastProcessedFile: path.basename(filePaths[9]),
      percent: 40,
      timestamp: Date.now(),
      updatedAt: new Date().toISOString(),
    };

    saveStorageCheckpoint(initialCp);

    const loadedCp = loadStorageCheckpoint(storageName, localMirrorRoot);
    assert(loadedCp !== null, 'loadStorageCheckpoint returned non-null checkpoint');
    assert(loadedCp?.storageName === storageName, 'Checkpoint storageName matches');
    assert(loadedCp?.lastProcessedIndex === 9, 'Checkpoint lastProcessedIndex matches 9');
    assert(loadedCp?.processedCount === 10, 'Checkpoint processedCount matches 10');
    assert(loadedCp?.percent === 40, 'Checkpoint percent matches 40%');

    // -------------------------------------------------------------
    // TEST 2: getAllStorageCheckpoints Discovery
    // -------------------------------------------------------------
    const allCp = getAllStorageCheckpoints(localMirrorRoot);
    assert(!!allCp[storageName], 'getAllStorageCheckpoints includes TestNAS');
    assert(allCp[storageName]?.phase === 'interrupted', 'getAllStorageCheckpoints phase is interrupted');

    // -------------------------------------------------------------
    // TEST 3: Interrupted Sync Auto-Resumes from index 10
    // -------------------------------------------------------------
    const config: VirtualStorageConfig = {
      id: 'test_storage_1',
      name: storageName,
      networkSourcePath: networkSource,
      localMirrorRoot,
      delayBetweenPhotosSec: 0,
    };

    const progressEvents: any[] = [];
    const syncResult = await syncVirtualStorage(config, (progress) => {
      progressEvents.push({ ...progress });
    });

    assert(syncResult.success === true, 'syncVirtualStorage finished successfully after resume');
    assert(syncResult.totalSynced === 25, `syncVirtualStorage totalSynced is 25 (got ${syncResult.totalSynced})`);

    // Verify progress events showed resumption
    const resumeEvent = progressEvents.find((e) => e.currentFile && e.currentFile.includes('Resuming from photo 11'));
    assert(resumeEvent !== undefined, 'Found resume progress event indicating resumption from photo 11');

    // Checkpoint after full completion should be marked 'completed'
    const completedCp = loadStorageCheckpoint(storageName, localMirrorRoot);
    assert(completedCp !== null, 'Completed checkpoint exists');
    assert(completedCp?.phase === 'completed', `Checkpoint phase is completed (got ${completedCp?.phase})`);
    assert(completedCp?.percent === 100, `Checkpoint percent is 100% (got ${completedCp?.percent})`);
    assert(completedCp?.processedCount === 25, `Checkpoint processedCount is 25 (got ${completedCp?.processedCount})`);

    // -------------------------------------------------------------
    // TEST 4: ThumbnailWorker Checkpoint Save, Load & Flush
    // -------------------------------------------------------------
    thumbnailWorker.saveCheckpoint(false);
    const workerStatus = thumbnailWorker.getStatus();
    assert(typeof workerStatus.current === 'number', 'ThumbnailWorker status returns current count');
    assert(typeof workerStatus.total === 'number', 'ThumbnailWorker status returns total count');

    thumbnailWorker.flushCheckpoint();
    assert(true, 'thumbnailWorker.flushCheckpoint completed cleanly without error');

    // -------------------------------------------------------------
    // TEST 5: LibraryStatusService accurate per-library save & get
    // -------------------------------------------------------------
    const testLibPath = path.join(tempDir, 'TestLibraryFolder');
    fs.mkdirSync(testLibPath, { recursive: true });

    const { libraryStatusService } = await import('../src/main/services/libraryStatusService');
    libraryStatusService.saveLibraryStatus({
      libraryPath: testLibPath,
      libraryName: 'TestLibraryFolder',
      totalPhotos: 6264,
      thumbnailCachedCount: 2000,
      thumbnailTotalCount: 6264,
      thumbnailLastIndex: 1999,
      thumbnailLastFile: 'photo_1999.jpg',
      thumbnailCompleted: false,
      thumbnailPercent: 32,
      faceScannedCount: 2000,
      faceTotalCount: 6264,
      faceDetectedCount: 450,
      faceLastIndex: 1999,
      faceLastFile: 'photo_1999.jpg',
      faceCompleted: false,
      facePercent: 32,
      phase: 'interrupted',
    });

    const libStatus = libraryStatusService.getLibraryStatus(testLibPath);
    assert(libStatus !== null, 'Library status retrieved for testLibPath');
    assert(libStatus?.thumbnailCachedCount === 2000, `thumbnailCachedCount is 2000 (got ${libStatus?.thumbnailCachedCount})`);
    assert(libStatus?.faceScannedCount === 2000, `faceScannedCount is 2000 (got ${libStatus?.faceScannedCount})`);
    assert(libStatus?.faceDetectedCount === 450, `faceDetectedCount is 450 (got ${libStatus?.faceDetectedCount})`);
    assert(libStatus?.thumbnailPercent === 32, `thumbnailPercent is 32% (got ${libStatus?.thumbnailPercent})`);

    // -------------------------------------------------------------
    // TEST 6: ThumbnailWorker restores library checkpoint and fast-forwards
    // -------------------------------------------------------------
    thumbnailWorker.loadCheckpoint(testLibPath);
    const restoredStatus = thumbnailWorker.getStatus();
    assert(restoredStatus.current >= 2000, `ThumbnailWorker restored current count >= 2000 (got ${restoredStatus.current})`);
    assert(restoredStatus.total >= 6264, `ThumbnailWorker restored total count >= 6264 (got ${restoredStatus.total})`);

  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }

  console.log(`\n=== RESULTS: ${passedTests}/${totalTests} TESTS PASSED ===\n`);
  if (passedTests !== totalTests) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
