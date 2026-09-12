import './setup_dom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import assert from 'assert';
import { libraryStore } from '../src/renderer/src/services/libraryStore';
import { Sidebar } from '../src/renderer/src/components/Sidebar';
import { Photo, VirtualStorageConfig, NetworkStorageProgress } from '../src/types';
import { syncVirtualStorage } from '../src/main/services/virtualMirrorService';
import fs from 'fs';
import path from 'path';

console.log('🧪 RUNNING RESPONSIVENESS, INSTANT STARTUP & NETWORK PROGRESS TESTS...');

const container = document.createElement('div');
document.body.appendChild(container);
const root = createRoot(container);

const renderView = async (element: React.ReactElement) => {
  await act(async () => {
    root.render(element);
  });
  await new Promise((r) => setTimeout(r, 60));
};

async function runTests() {
  let passed = 0;

  // -------------------------------------------------------------
  // Test 1: Instant Startup & Deferred Background Verification
  // -------------------------------------------------------------
  console.log('▶ Test 1: Instant Startup First Paint');
  const startPhotos: Photo[] = [
    {
      id: 'p_test_1',
      filePath: 'C:\\mock\\photo1.jpg',
      fileName: 'photo1.jpg',
      dateTaken: new Date().toISOString(),
      fileSize: 1024,
      width: 800,
      height: 600,
    },
    {
      id: 'p_test_2',
      filePath: 'C:\\mock\\photo2.jpg',
      fileName: 'photo2.jpg',
      dateTaken: new Date().toISOString(),
      fileSize: 2048,
      width: 800,
      height: 600,
      isVirtual: true,
      storageName: 'NAS',
      originalRemotePath: '\\\\NAS\\Photos\\photo2.jpg',
    },
  ];

  libraryStore.init({ photos: startPhotos });
  const t0 = performance.now();
  const state = libraryStore.getState();
  const duration = performance.now() - t0;

  assert.strictEqual(state.photos.length, 2, 'Photos should be instantly available in library store');
  assert.ok(duration < 25, `Initial retrieval took ${duration.toFixed(2)}ms (must be <25ms)`);
  console.log(`  ✓ Library data retrieved in ${duration.toFixed(2)}ms with ${state.photos.length} photos ready for instant paint`);
  passed++;

  // -------------------------------------------------------------
  // Test 2: Debounced Disk Persistence
  // -------------------------------------------------------------
  console.log('▶ Test 2: Debounced Disk Persistence prevents IPC/Disk Flooding');
  let saveCount = 0;
  (window as any).electronAPI = {
    saveLibraryData: async () => {
      saveCount++;
      return true;
    },
    loadLibraryData: async () => null,
    checkFileExists: async () => true,
  };

  // Perform 25 rapid photo updates
  for (let i = 0; i < 25; i++) {
    libraryStore.updatePhotoQuietly({
      ...startPhotos[0],
      sharpnessScore: i * 2,
    });
  }
  libraryStore.notify(); // schedules debounced save

  assert.strictEqual(saveCount, 0, 'saveLibraryData should NOT be called immediately upon rapid updates');
  console.log('  ✓ 25 rapid photo updates queued without triggering immediate disk write');

  // Wait 600ms for debounce timer to fire
  await new Promise((r) => setTimeout(r, 650));
  assert.strictEqual(saveCount, 1, `saveLibraryData should only be called ONCE after debounce (actual: ${saveCount})`);
  console.log(`  ✓ Debounced save triggered exactly 1 time for 25 updates`);
  passed++;

  // -------------------------------------------------------------
  // Test 3: Network Storage Live Thumbnail Progress in Sidebar
  // -------------------------------------------------------------
  console.log('▶ Test 3: Sidebar Network Storage List displays Thumbnail Generation Progress');
  const mockStorages: VirtualStorageConfig[] = [
    {
      id: 'storage_nas',
      name: 'Family_NAS',
      networkSourcePath: '\\\\NAS\\Family',
      localMirrorRoot: 'C:\\GPhotos_VirtualMirrors',
      totalItems: 85,
    },
  ];

  const thumbProgressMap: Record<string, NetworkStorageProgress> = {
    Family_NAS: {
      storageName: 'Family_NAS',
      phase: 'thumbnails',
      thumbnailCurrent: 42,
      thumbnailTotal: 85,
      faceCurrent: 0,
      faceTotal: 0,
      percent: 49,
      currentFile: 'vacation_42.jpg',
    },
  };

  await renderView(
    React.createElement(Sidebar, {
      activeTab: "photos",
      onSelectTab: () => {},
      state: libraryStore.getState(),
      onOpenFolder: () => {},
      onTriggerFaceDetection: () => {},
      virtualStorages: mockStorages,
      storageProgressMap: thumbProgressMap,
    })
  );

  const textContent1 = container.textContent || '';
  assert.ok(textContent1.includes('Thumbnails: 42/85'), 'Sidebar must display current thumbnail generation progress');
  assert.ok(textContent1.includes('49%'), 'Sidebar must display percentage for thumbnails');
  console.log('  ✓ Sidebar successfully renders live thumbnail progress: "Thumbnails: 42/85" and "49%"');
  passed++;

  // -------------------------------------------------------------
  // Test 4: Network Storage Live Face Recognition Progress in Sidebar
  // -------------------------------------------------------------
  console.log('▶ Test 4: Sidebar Network Storage List displays Face Recognition Progress');
  const faceProgressMap: Record<string, NetworkStorageProgress> = {
    Family_NAS: {
      storageName: 'Family_NAS',
      phase: 'faces',
      thumbnailCurrent: 85,
      thumbnailTotal: 85,
      faceCurrent: 21,
      faceTotal: 42,
      percent: 50,
      currentFile: 'vacation_21.jpg',
    },
  };

  await renderView(
    React.createElement(Sidebar, {
      activeTab: "photos",
      onSelectTab: () => {},
      state: libraryStore.getState(),
      onOpenFolder: () => {},
      onTriggerFaceDetection: () => {},
      virtualStorages: mockStorages,
      storageProgressMap: faceProgressMap,
    })
  );

  const textContent2 = container.textContent || '';
  assert.ok(textContent2.includes('Faces: 21/42'), 'Sidebar must display face recognition progress');
  assert.ok(textContent2.includes('50%'), 'Sidebar must display percentage for face recognition');
  console.log('  ✓ Sidebar successfully renders live face recognition progress: "Faces: 21/42" and "50%"');
  passed++;

  // -------------------------------------------------------------
  // Test 5: Completed Phase Indicator in Sidebar
  // -------------------------------------------------------------
  console.log('▶ Test 5: Sidebar displays Up to date indicator upon completion');
  const completedProgressMap: Record<string, NetworkStorageProgress> = {
    Family_NAS: {
      storageName: 'Family_NAS',
      phase: 'completed',
      thumbnailCurrent: 85,
      thumbnailTotal: 85,
      faceCurrent: 42,
      faceTotal: 42,
      percent: 100,
    },
  };

  await renderView(
    React.createElement(Sidebar, {
      activeTab: "photos",
      onSelectTab: () => {},
      state: libraryStore.getState(),
      onOpenFolder: () => {},
      onTriggerFaceDetection: () => {},
      virtualStorages: mockStorages,
      storageProgressMap: completedProgressMap,
    })
  );

  const textContent3 = container.textContent || '';
  assert.ok(textContent3.includes('Up to date'), 'Sidebar must show Up to date status upon completion');
  console.log('  ✓ Sidebar displays "✓ Up to date" indicator');
  passed++;

  // -------------------------------------------------------------
  // Test 6: Non-blocking syncVirtualStorage Progress Emission
  // -------------------------------------------------------------
  console.log('▶ Test 6: syncVirtualStorage emits phase: "thumbnails", storageName, and yields');
  const tempRemoteDir = path.join(__dirname, 'mock_remote_sync_test');
  const tempMirrorDir = path.join(__dirname, 'mock_mirror_sync_test');

  if (!fs.existsSync(tempRemoteDir)) fs.mkdirSync(tempRemoteDir, { recursive: true });
  if (!fs.existsSync(tempMirrorDir)) fs.mkdirSync(tempMirrorDir, { recursive: true });

  fs.writeFileSync(path.join(tempRemoteDir, 'sample1.jpg'), Buffer.from('fake-image-data-1'));
  fs.writeFileSync(path.join(tempRemoteDir, 'sample2.jpg'), Buffer.from('fake-image-data-2'));

  const emittedProgress: any[] = [];
  const syncResult = await syncVirtualStorage(
    {
      id: 'test_sync_id',
      name: 'TestMirror',
      networkSourcePath: tempRemoteDir,
      localMirrorRoot: tempMirrorDir,
    },
    (prog) => {
      emittedProgress.push({ ...prog });
    }
  );

  assert.ok(syncResult.success, 'Sync should complete successfully');
  assert.ok(emittedProgress.length > 0, 'Progress events must be emitted during sync');
  assert.ok(
    emittedProgress.some((p) => p.phase === 'thumbnails' && p.storageName === 'TestMirror'),
    'Progress events must include phase: "thumbnails" and storageName'
  );
  assert.ok(
    emittedProgress.some((p) => p.phase === 'completed' && p.percent === 100),
    'Progress must reach phase: "completed" with 100%'
  );

  console.log(`  ✓ syncVirtualStorage successfully emitted ${emittedProgress.length} progress events with storageName & phase`);
  passed++;

  // Cleanup temporary test folders
  try {
    fs.rmSync(tempRemoteDir, { recursive: true, force: true });
    fs.rmSync(tempMirrorDir, { recursive: true, force: true });
  } catch {}

  console.log(`\n🎉 ALL ${passed}/${passed} RESPONSIVENESS AND PROGRESS TESTS PASSED!`);
}

runTests().catch((err) => {
  console.error('❌ Test failed with error:', err);
  process.exit(1);
});
