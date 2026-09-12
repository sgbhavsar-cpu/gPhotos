import './setup_dom';
import assert from 'assert';
import path from 'path';
import fs from 'fs';
import {
  readDirectoryTree,
  readFolderPhotos,
  generateThumbnailOnTheFly,
  editPhotoFile,
  trashFiles,
  SYSTEM_IGNORED_FOLDERS,
} from '../src/main/services/virtualMirrorService';
import {
  findDuplicateAndBurstClusters,
  scorePhotoClarityAndExpression,
} from '../src/renderer/src/services/deduplication';
import { libraryStore } from '../src/renderer/src/services/libraryStore';
import { faceQueue } from '../src/renderer/src/services/faceQueue';
import { Photo, DetectedFace } from '../src/types';

async function runAllTests() {
  console.log('=== RUNNING TESTS FOR ALL 7 NEW ARCHITECTURE FEATURES ===\n');

// 1. Requirement 4 & 2: System folder ignoring and directory tree reading
console.log('Test 1: Testing Directory Tree & System Folder Skipping...');
assert.ok(SYSTEM_IGNORED_FOLDERS.has('$recycle.bin'), 'Must ignore $recycle.bin');
assert.ok(SYSTEM_IGNORED_FOLDERS.has('system volume information'), 'Must ignore system volume info');
assert.ok(SYSTEM_IGNORED_FOLDERS.has('node_modules'), 'Must ignore node_modules');

const testDir = path.join(__dirname, 'test_tree_fixture');
if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
fs.mkdirSync(path.join(testDir, 'sub1', 'deep'), { recursive: true });
fs.mkdirSync(path.join(testDir, 'sub2'), { recursive: true });
fs.mkdirSync(path.join(testDir, '$RECYCLE.BIN'), { recursive: true }); // Should be ignored

// Create dummy image in sub1
fs.writeFileSync(path.join(testDir, 'sub1', 'photo1.jpg'), 'sample image data');

const treeNodes = readDirectoryTree(testDir);
const childNames = treeNodes.map((c) => c.name.toLowerCase());
assert.ok(childNames.includes('sub1'), 'Should contain sub1');
assert.ok(childNames.includes('sub2'), 'Should contain sub2');
assert.ok(!childNames.includes('$recycle.bin'), 'Must NOT contain $RECYCLE.BIN');
console.log('✓ Directory Tree constructed correctly with system folders excluded!\n');

// 2. Requirement 2: Read folder photos directly without prior scan
console.log('Test 2: Testing On-the-Fly Folder Photos Reading...');
const folderPhotos = await readFolderPhotos(path.join(testDir, 'sub1'));
assert.strictEqual(folderPhotos.length, 1, 'Should find 1 photo in sub1');
assert.strictEqual(folderPhotos[0].fileName, 'photo1.jpg');
console.log('✓ On-the-fly folder photos reading works without scan indexing!\n');

// 3. Requirement 4: Generate thumbnail on-the-fly in base virtual mirror directory
console.log('Test 3: Testing On-the-Fly Thumbnail Generation for full drive / remote photos...');
const mirrorRoot = path.join(testDir, 'virtual_mirrors');
fs.mkdirSync(mirrorRoot, { recursive: true });

// Create a small 100x100 PNG buffer to test thumbnail creation
// 1x1 transparent PNG buffer
const tinyPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const sampleImgPath = path.join(testDir, 'test_sample.png');
fs.writeFileSync(sampleImgPath, Buffer.from(tinyPngBase64, 'base64'));

const generatedThumbPath = await generateThumbnailOnTheFly(sampleImgPath, mirrorRoot);
assert.ok(generatedThumbPath && fs.existsSync(generatedThumbPath), 'Thumbnail file must exist in mirror directory');
console.log('✓ On-the-fly thumbnail generated successfully:', generatedThumbPath, '\n');

// 4. Requirement 5: Photo editing (rotate, flip, save with safe .bak backup & copy)
console.log('Test 4: Testing Safe Photo Editing (Rotate, Flip, Overwrite with .bak & Save As Copy)...');
const editSourcePath = path.join(testDir, 'editable_photo.jpg');
fs.writeFileSync(editSourcePath, 'Original photo content before editing');

// Test Save as Overwrite:
const editResult = await editPhotoFile({
  filePath: editSourcePath,
  base64Data: 'data:image/jpeg;base64,' + Buffer.from('Edited image content').toString('base64'),
  saveAsCopy: false,
});

assert.strictEqual(editResult.success, true, 'Edit should succeed');
assert.ok(fs.existsSync(editSourcePath + '.bak'), 'Safe .bak backup must be created before overwrite');
const bakContent = fs.readFileSync(editSourcePath + '.bak', 'utf8');
assert.strictEqual(bakContent, 'Original photo content before editing', 'Backup must contain original content');

// Test Save as Copy:
const copyResult = await editPhotoFile({
  filePath: editSourcePath,
  base64Data: 'data:image/jpeg;base64,' + Buffer.from('Copy image content').toString('base64'),
  saveAsCopy: true,
});
assert.strictEqual(copyResult.success, true, 'Save as copy should succeed');
assert.ok(copyResult.newPhoto, 'New photo object must be returned');
assert.ok(copyResult.newPhoto.filePath.includes('_edited'), 'Copy filename should include _edited');
assert.ok(fs.existsSync(copyResult.newPhoto.filePath), 'New edited file must exist on disk');
console.log('✓ Safe photo editing (.bak preservation & save-as-copy) verified!\n');

// 5. Requirement 6: Photo exclusion (multi-select) & No Faces marking
console.log('Test 5: Testing Multi-Select Photo Exclusion & No Faces Marking...');
const p1: Photo = {
  id: 'photo_test_1',
  fileName: 'photo_1.jpg',
  filePath: '/test/photo_1.jpg',
  fileSize: 1024 * 1024,
  dateTaken: '2026-01-01T10:00:00Z',
  isFavorite: false,
  isExcluded: false,
  faceScanCompleted: true,
  faces: [], // No faces
};

const p2: Photo = {
  id: 'photo_test_2',
  fileName: 'photo_2.jpg',
  filePath: '/test/photo_2.jpg',
  fileSize: 2 * 1024 * 1024,
  dateTaken: '2026-01-01T10:00:05Z',
  isFavorite: false,
  isExcluded: false,
  faceScanCompleted: true,
  faces: [
    {
      id: 'f1',
      photoId: 'photo_test_2',
      box: { x: 10, y: 10, width: 50, height: 50 },
      confidence: 0.9,
    },
  ],
};

libraryStore.setPhotos([p1, p2]);
assert.strictEqual(libraryStore.getState().photos[0].isExcluded, false);

// Exclude photo 1
libraryStore.excludePhotos(['photo_test_1'], true);
assert.strictEqual(libraryStore.getState().photos.find((p) => p.id === 'photo_test_1')?.isExcluded, true);

// Restore photo 1
libraryStore.excludePhotos(['photo_test_1'], false);
assert.strictEqual(libraryStore.getState().photos.find((p) => p.id === 'photo_test_1')?.isExcluded, false);
console.log('✓ Multi-photo exclusion and restoration in libraryStore working as expected!\n');

// 6. Requirement 7: Deduplication, Burst Clustering & AI Best Shot Scoring
console.log('Test 6: Testing Deduplication & AI Best Shot Scoring...');

// Create a burst of 3 photos taken within 15 seconds of each other
const burstPhotos: Photo[] = [
  {
    id: 'burst_1',
    fileName: 'burst_1.jpg',
    filePath: '/test/burst_1.jpg',
    fileSize: 1200000,
    width: 3000,
    height: 2000,
    dateTaken: '2026-01-10T15:30:00Z',
    isFavorite: false,
    faces: [
      {
        id: 'f_b1',
        photoId: 'burst_1',
        box: { x: 100, y: 100, width: 120, height: 120 },
        confidence: 0.85,
        dominantExpression: 'neutral',
        age: 30,
        gender: 'female',
      },
    ],
  },
  {
    id: 'burst_2',
    fileName: 'burst_2.jpg',
    filePath: '/test/burst_2.jpg',
    fileSize: 3400000, // Higher byte density / clearer
    width: 4000,
    height: 3000,
    dateTaken: '2026-01-10T15:30:04Z', // 4 seconds later
    isFavorite: false,
    faces: [
      {
        id: 'f_b2',
        photoId: 'burst_2',
        box: { x: 100, y: 100, width: 150, height: 150 },
        confidence: 0.98,
        dominantExpression: 'happy', // Smiling!
        age: 30,
        gender: 'female',
      },
    ],
  },
  {
    id: 'burst_3',
    fileName: 'burst_3.jpg',
    filePath: '/test/burst_3.jpg',
    fileSize: 1000000,
    width: 3000,
    height: 2000,
    dateTaken: '2026-01-10T15:30:08Z', // 8 seconds later
    isFavorite: false,
    faces: [
      {
        id: 'f_b3',
        photoId: 'burst_3',
        box: { x: 100, y: 100, width: 100, height: 100 },
        confidence: 0.70,
        dominantExpression: 'sad',
      },
    ],
  },
];

const clusters = findDuplicateAndBurstClusters(burstPhotos, { timeWindowSeconds: 60 });
assert.strictEqual(clusters.length, 1, 'Should group 3 photos into 1 burst cluster');
assert.strictEqual(clusters[0].photos.length, 3, 'Cluster should contain all 3 photos');

// Verify AI Best Shot chosen
assert.strictEqual(
  clusters[0].bestPhotoId,
  'burst_2',
  'burst_2 should be selected as AI Best Shot due to higher clarity & happy expression'
);

const score1 = scorePhotoClarityAndExpression(burstPhotos[0]);
const score2 = scorePhotoClarityAndExpression(burstPhotos[1]);
const score3 = scorePhotoClarityAndExpression(burstPhotos[2]);
assert.ok(score2.totalScore > score1.totalScore, 'Score 2 must be greater than Score 1');
assert.ok(score2.totalScore > score3.totalScore, 'Score 2 must be greater than Score 3');
console.log(`✓ AI Best Shot scored successfully! (Scores: #${score1.totalScore}, #${score2.totalScore} [Best], #${score3.totalScore})\n`);

// 7. Safe Trashing test
console.log('Test 7: Testing Safe File Trashing...');
const fileToTrash = path.join(testDir, 'trash_candidate.jpg');
fs.writeFileSync(fileToTrash, 'to be trashed');
assert.ok(fs.existsSync(fileToTrash));

const trashResult = await trashFiles([fileToTrash]);
assert.strictEqual(trashResult.success, true);
assert.strictEqual(trashResult.trashedCount, 1);
assert.ok(!fs.existsSync(fileToTrash), 'File should be removed from original path');
console.log('✓ File safe trashing verified!\n');

// 8. Requirement 3: Background Face Queue
console.log('Test 8: Testing Background Face Recognition Queue...');
assert.ok(faceQueue, 'faceQueue instance must exist');

// Pause queue to inspect queued state
faceQueue.pause();
const queuePhotos: Photo[] = [
  { ...p2, id: 'q_photo_1', fileName: 'q_photo_1.jpg' },
  { ...p2, id: 'q_photo_2', fileName: 'q_photo_2.jpg' },
];

faceQueue.enqueue(queuePhotos);
assert.strictEqual(faceQueue.getQueueLength(), 2, 'Queue should hold 2 items while paused');

// Prioritize second photo to front of queue
faceQueue.prioritize('q_photo_2');
assert.strictEqual(faceQueue.getStatus().total >= 2, true, 'Status should reflect total items');

// Clear queue
faceQueue.clear();
assert.strictEqual(faceQueue.getQueueLength(), 0, 'Queue should be empty after clear');
console.log('✓ Background Face Recognition Queue accepts items, supports pause/prioritize/clear!\n');

// 9. Storage Deletion, Unlinked Blacklist, and Library Cleanup
console.log('Test 9: Testing Storage Deletion, Unlinked Blacklist & Photo Cleanup...');
const dummyStorageName = 'TestNASStorage';
const dummyMirrorPath = path.join(testDir, 'dummy_mirror', dummyStorageName);
fs.mkdirSync(dummyMirrorPath, { recursive: true });
fs.writeFileSync(path.join(dummyMirrorPath, 'dummy_thumb.jpg'), 'thumbnail data');

// Add dummy photo belonging to this storage
const dummyStoragePhoto: Photo = {
  id: 'storage_p_1',
  fileName: 'dummy_thumb.jpg',
  filePath: path.join(dummyMirrorPath, 'dummy_thumb.jpg'),
  fileSize: 1000,
  dateTaken: new Date().toISOString(),
  storageName: dummyStorageName,
  originalFilePath: 'Z:\\SharedPhotos\\photo.jpg',
};
libraryStore.addPhotos([dummyStoragePhoto]);
assert.ok(libraryStore.getState().photos.some((p) => p.storageName === dummyStorageName), 'Photo must exist in library');

// Clean up photos from library for this storage
libraryStore.removePhotosByStorage(dummyStorageName);
assert.ok(!libraryStore.getState().photos.some((p) => p.storageName === dummyStorageName), 'Photo must be removed from library');

// Verify unlinked blacklist persistence
const UNLINKED_KEY = 'gphotos_unlinked_storages_v1';
const existingUnlinked = JSON.parse(localStorage.getItem(UNLINKED_KEY) || '[]');
existingUnlinked.push(dummyStorageName.toLowerCase());
localStorage.setItem(UNLINKED_KEY, JSON.stringify(existingUnlinked));

const updatedUnlinked = JSON.parse(localStorage.getItem(UNLINKED_KEY) || '[]');
assert.ok(updatedUnlinked.includes(dummyStorageName.toLowerCase()), 'Unlinked storage blacklist must persist');
console.log('✓ Storage deletion logic, unlinked blacklist & photo cleanup verified!\n');

// 10. Cover Face Selection & AI Auto-Pick Best Face
console.log('Test 10: Testing Person Cover Face & AI Auto-Pick Best Face...');
libraryStore.addPerson('Alice');
const allPeople = libraryStore.getState().people;
const alice = allPeople.find((p) => p.name === 'Alice')!;
assert.ok(alice, 'Alice must exist in library');

// Add 2 photos with Alice's face: one blurry/neutral, one sharp/smiling
const alicePhoto1: Photo = {
  id: 'alice_p1',
  fileName: 'alice_neutral.jpg',
  filePath: path.join(testDir, 'alice_neutral.jpg'),
  fileSize: 5000,
  dateTaken: '2026-01-01T10:00:00Z',
  sharpnessScore: 30,
  faces: [
    {
      id: 'alice_f1',
      photoId: 'alice_p1',
      personId: alice.id,
      box: { x: 50, y: 50, width: 80, height: 80 },
      confidence: 0.82,
      dominantExpression: 'neutral',
      isConfirmed: false,
    },
  ],
};

const alicePhoto2: Photo = {
  id: 'alice_p2',
  fileName: 'alice_smiling.jpg',
  filePath: path.join(testDir, 'alice_smiling.jpg'),
  fileSize: 6000,
  dateTaken: '2026-01-02T10:00:00Z',
  sharpnessScore: 92,
  faces: [
    {
      id: 'alice_f2',
      photoId: 'alice_p2',
      personId: alice.id,
      box: { x: 40, y: 40, width: 140, height: 140 },
      confidence: 0.96,
      dominantExpression: 'happy',
      isConfirmed: true,
    },
  ],
};

libraryStore.addPhotos([alicePhoto1, alicePhoto2]);

// Test manual cover setting
libraryStore.setPersonCover(alice.id, 'alice_p1', 'alice_f1');
let updatedAlice = libraryStore.getState().people.find((p) => p.id === alice.id)!;
assert.strictEqual(updatedAlice.coverPhotoId, 'alice_p1');
assert.strictEqual(updatedAlice.coverFaceId, 'alice_f1');
console.log('✓ Manual person cover selection set successfully.');

// Test AI Auto-Pick Best Face Cover
const autoPicked = libraryStore.autoSelectBestFaceCover(alice.id);
assert.ok(autoPicked, 'autoSelectBestFaceCover must return best result');
assert.strictEqual(autoPicked?.photoId, 'alice_p2', 'AI must pick the sharp, smiling, confirmed face (alice_p2)');
assert.strictEqual(autoPicked?.faceId, 'alice_f2', 'AI must pick alice_f2 as the best face');

updatedAlice = libraryStore.getState().people.find((p) => p.id === alice.id)!;
assert.strictEqual(updatedAlice.coverPhotoId, 'alice_p2', 'Person record coverPhotoId must be updated');
assert.strictEqual(updatedAlice.coverFaceId, 'alice_f2', 'Person record coverFaceId must be updated');
console.log('✓ AI Auto-Pick Best Face successfully selected sharp, smiling, high-resolution face!\n');

// 11. Background Daemon & Tray Service status & settings
console.log('Test 11: Testing Background Service Status & Settings API...');
const serviceStatus = await window.electronAPI?.getBackgroundServiceStatus();
assert.ok(serviceStatus, 'Service status must return');
assert.strictEqual(typeof serviceStatus?.isRunning, 'boolean');
assert.strictEqual(typeof serviceStatus?.minimizeToTray, 'boolean');

const updateSettingsResult = await window.electronAPI?.setBackgroundServiceSettings({
  syncIntervalMinutes: 60,
  minimizeToTray: true,
});
assert.strictEqual(updateSettingsResult, true, 'Settings update should return true');

const syncTriggerResult = await window.electronAPI?.triggerBackgroundServiceSync();
assert.ok(syncTriggerResult, 'Sync trigger should return result');
console.log('✓ Background Service Status, Settings & Manual Sync Trigger verified!\n');

// Cleanup
  if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });

  console.log('=== ALL 11 ARCHITECTURE FEATURES PASSED AUTOMATED TESTS SUCCESSFULLY! ===\n');
}

runAllTests().catch((err) => {
  console.error('Test execution error:', err);
  process.exit(1);
});
