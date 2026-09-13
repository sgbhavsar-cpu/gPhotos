/**
 * test_5photo_library_workflow.ts
 *
 * Automated regression and release test suite requested by user:
 * Creates a small 5-photo test library fixture and practically verifies:
 * 1. Library Switching: Switching to another library and switching back does NOT
 *    restart face recognition from photo #1 and retains all detected faces and people names.
 * 2. Photo Deletion: Deleting a photo does NOT restart face recognition from photo #1,
 *    updates face and photo counts, safely reassigns cover photos, and NEVER forgets people names.
 * 3. Complete Person Photo Deletion: Even if all photos of a person are deleted,
 *    their custom name identity is preserved and not reset to "Person X".
 */

import './setup_dom';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { libraryStore, LibraryManager } from '../src/renderer/src/services/libraryStore';
import { Photo, DetectedFace, Person } from '../src/types';

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
  console.log(`  ✓ ${message}`);
}

async function run5PhotoWorkflowTests() {
  console.log('===============================================================');
  console.log('🧪 Starting 5-Photo Library Workflow & Regression Test Suite');
  console.log('===============================================================\n');

  // Setup mock storage map for electronAPI to test realistic IPC persistence
  const persistentStorage = new Map<string, any>();
  (window as any).electronAPI.saveLibraryData = async (key: string, data: any) => {
    persistentStorage.set(key, JSON.parse(JSON.stringify(data)));
    return true;
  };
  (window as any).electronAPI.loadLibraryData = async (key: string) => {
    const item = persistentStorage.get(key);
    return item ? JSON.parse(JSON.stringify(item)) : null;
  };

  // 1. Create a small 5-photo folder fixture (Library A) and a 3-photo folder fixture (Library B)
  const tempBase = path.join(os.tmpdir(), `gphotos_test_5photo_${Date.now()}`);
  const libADir = path.join(tempBase, 'small_lib_A');
  const libBDir = path.join(tempBase, 'small_lib_B');
  fs.mkdirSync(libADir, { recursive: true });
  fs.mkdirSync(libBDir, { recursive: true });

  const dummyJpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x01, 0x00, 0x60, 0x00, 0x60, 0x00, 0x00, 0xff, 0xd9]);

  const filesA = ['photo_1.jpg', 'photo_2.jpg', 'photo_3.jpg', 'photo_4.jpg', 'photo_5.jpg'];
  for (const f of filesA) {
    fs.writeFileSync(path.join(libADir, f), dummyJpg);
  }

  const filesB = ['photo_b1.jpg', 'photo_b2.jpg', 'photo_b3.jpg'];
  for (const f of filesB) {
    fs.writeFileSync(path.join(libBDir, f), dummyJpg);
  }

  console.log(`📁 Test Fixtures Created:`);
  console.log(`   - Library A: ${libADir} (${filesA.length} photos)`);
  console.log(`   - Library B: ${libBDir} (${filesB.length} photos)\n`);

  // Define 5 Photo objects for Library A
  const photosA: Photo[] = filesA.map((fileName, idx) => ({
    id: `photo_a_${idx + 1}`,
    filePath: path.join(libADir, fileName),
    fileName,
    fileSize: dummyJpg.length,
    fileDate: new Date().toISOString(),
    dateTaken: new Date(2026, 0, idx + 1).toISOString(),
    year: 2026,
    month: 1,
    day: idx + 1,
    isFavorite: false,
  }));

  // Define 3 Photo objects for Library B
  const photosB: Photo[] = filesB.map((fileName, idx) => ({
    id: `photo_b_${idx + 1}`,
    filePath: path.join(libBDir, fileName),
    fileName,
    fileSize: dummyJpg.length,
    fileDate: new Date().toISOString(),
    dateTaken: new Date(2026, 1, idx + 1).toISOString(),
    year: 2026,
    month: 2,
    day: idx + 1,
    isFavorite: false,
  }));

  try {
    // -------------------------------------------------------------------------
    // TEST 1: Initial Load & Face Recognition on 5 Photos
    // -------------------------------------------------------------------------
    console.log('👉 TEST 1: Initial Face Recognition & Custom Naming on 5 Photos');
    const enrichedA = libraryStore.setPhotos(photosA, libADir);
    assert(libraryStore.getState().photos.length === 5, 'Library A loaded with 5 photos');

    // Simulate Face Detection:
    // Person 1 (Alice): detected in photo 1 & photo 2
    // Person 2 (Bob): detected in photo 3 & photo 4
    // Photo 5: Landscape with 0 faces
    const descAlice = new Array(128).fill(0.1);
    const descBob = new Array(128).fill(0.9);

    const face1: DetectedFace = {
      id: 'face_1',
      photoId: 'photo_a_1',
      box: { x: 50, y: 50, width: 100, height: 100 },
      descriptor: descAlice,
      confidence: 0.95,
      isConfirmed: true,
    };
    const face2: DetectedFace = {
      id: 'face_2',
      photoId: 'photo_a_2',
      box: { x: 60, y: 60, width: 105, height: 105 },
      descriptor: descAlice,
      confidence: 0.94,
      isConfirmed: true,
    };
    const face3: DetectedFace = {
      id: 'face_3',
      photoId: 'photo_a_3',
      box: { x: 70, y: 70, width: 90, height: 90 },
      descriptor: descBob,
      confidence: 0.92,
      isConfirmed: true,
    };
    const face4: DetectedFace = {
      id: 'face_4',
      photoId: 'photo_a_4',
      box: { x: 80, y: 80, width: 95, height: 95 },
      descriptor: descBob,
      confidence: 0.91,
      isConfirmed: true,
    };

    // Update faces & people in store
    libraryStore.updateFacesAndPeople([face1, face2, face3, face4]);

    const state1 = libraryStore.getState();
    assert(state1.people.length >= 2, `Clustering detected at least 2 people (actual: ${state1.people.length})`);

    // Assign custom names "Alice" and "Bob"
    const personAlice = state1.people.find((p) => p.id === face1.personId) || state1.people[0];
    const personBob = state1.people.find((p) => p.id === face3.personId) || state1.people[1];

    libraryStore.updatePersonName(personAlice.id, 'Alice');
    libraryStore.updatePersonName(personBob.id, 'Bob');

    // Mark all 5 photos as faceScanCompleted and persist
    for (const p of libraryStore.getState().photos) {
      p.faceScanCompleted = true;
      libraryStore.cachePhotoFaces(p, p.faces || [], true);
    }
    await libraryStore.persistNow();

    const verifiedPeople = libraryStore.getState().people;
    const aliceObj = verifiedPeople.find((p) => p.name === 'Alice');
    const bobObj = verifiedPeople.find((p) => p.name === 'Bob');
    assert(aliceObj !== undefined, 'Person "Alice" created and named successfully');
    assert(bobObj !== undefined, 'Person "Bob" created and named successfully');
    assert(aliceObj?.photoCount === 2, `Alice photoCount is 2 (actual: ${aliceObj?.photoCount})`);
    assert(bobObj?.photoCount === 2, `Bob photoCount is 2 (actual: ${bobObj?.photoCount})`);

    // Verify candidates to scan in Library A
    const unscannedCandidatesA = libraryStore.getState().photos.filter((p) => !p.faceScanCompleted);
    assert(unscannedCandidatesA.length === 0, 'Zero unscanned candidate photos remain in Library A');
    console.log('   ✅ Test 1 Passed!\n');

    // -------------------------------------------------------------------------
    // TEST 2: Switch Library to Library B, then Switch Back to Library A
    // -------------------------------------------------------------------------
    console.log('👉 TEST 2: Library Switch Test (Lib A -> Lib B -> Lib A)');
    // Switch to Library B
    libraryStore.setPhotos(photosB, libBDir);
    assert(libraryStore.getState().photos.length === 3, 'Switched to Library B (3 photos loaded)');

    // Simulate switching BACK to Library A
    // Note: scanDirectory returns fresh photo objects lacking in-memory faces
    const freshScanA: Photo[] = filesA.map((fileName, idx) => ({
      id: `photo_a_${idx + 1}`,
      filePath: path.join(libADir, fileName),
      fileName,
      fileSize: dummyJpg.length,
      fileDate: new Date().toISOString(),
      dateTaken: new Date(2026, 0, idx + 1).toISOString(),
      year: 2026,
      month: 1,
      day: idx + 1,
      isFavorite: false,
    }));

    const restoredA = libraryStore.setPhotos(freshScanA, libADir);
    assert(restoredA.length === 5, 'Switched back to Library A (5 photos loaded)');

    // Check candidate count: Face recognition MUST NOT restart from photo #1!
    const candidatesAfterSwitch = restoredA.filter((p) => {
      if (p.faceScanCompleted) return false;
      if (p.faces && p.faces.length > 0) return false;
      return true;
    });

    assert(
      candidatesAfterSwitch.length === 0,
      `Face recognition candidates after switch is 0! Does NOT restart from photo #1 (candidates: ${candidatesAfterSwitch.length})`
    );

    // Verify all photos have their faceScanCompleted flag and faces restored
    const photo1Restored = restoredA.find((p) => p.id === 'photo_a_1');
    assert(photo1Restored?.faceScanCompleted === true, 'Photo 1 retained faceScanCompleted === true');
    assert((photo1Restored?.faces?.length || 0) > 0, 'Photo 1 retained detected faces');

    const photo5Restored = restoredA.find((p) => p.id === 'photo_a_5');
    assert(photo5Restored?.faceScanCompleted === true, 'Photo 5 (landscape) retained faceScanCompleted === true');

    // Verify people names: Alice and Bob MUST NOT be forgotten or reset to "Person X"
    const currentPeople = libraryStore.getState().people;
    const restoredAlice = currentPeople.find((p) => p.name === 'Alice');
    const restoredBob = currentPeople.find((p) => p.name === 'Bob');

    assert(restoredAlice !== undefined, 'Person name "Alice" was preserved 100% across library switch');
    assert(restoredBob !== undefined, 'Person name "Bob" was preserved 100% across library switch');
    console.log('   ✅ Test 2 Passed!\n');

    // -------------------------------------------------------------------------
    // TEST 3: Photo Deletion (Delete 1 photo containing a person's face)
    // -------------------------------------------------------------------------
    console.log('👉 TEST 3: Photo Deletion Test (Delete photo_2 containing Alice\'s face)');
    // Delete photo 2
    libraryStore.removePhotos(['photo_a_2']);

    const photosAfterDelete = libraryStore.getState().photos;
    assert(photosAfterDelete.length === 4, `Library A now has 4 photos (actual: ${photosAfterDelete.length})`);
    assert(photosAfterDelete.find((p) => p.id === 'photo_a_2') === undefined, 'photo_a_2 successfully removed');

    // Check candidate count: Face recognition MUST NOT restart from photo #1!
    const candidatesAfterDelete = photosAfterDelete.filter((p) => {
      if (p.faceScanCompleted) return false;
      if (p.faces && p.faces.length > 0) return false;
      return true;
    });
    assert(
      candidatesAfterDelete.length === 0,
      `Face recognition candidates after deletion is 0! Does NOT restart from photo #1 (candidates: ${candidatesAfterDelete.length})`
    );

    // Verify Alice's name and counts: Alice must STILL be named "Alice"
    const peopleAfterDelete = libraryStore.getState().people;
    const aliceAfterDelete = peopleAfterDelete.find((p) => p.id === aliceObj!.id);
    assert(aliceAfterDelete !== undefined, 'Alice identity still exists in people list');
    assert(aliceAfterDelete?.name === 'Alice', `Alice name is STILL "Alice", NOT forgotten or reset to Person X (actual: "${aliceAfterDelete?.name}")`);
    assert(aliceAfterDelete?.photoCount === 1, `Alice photoCount accurately updated to 1 (actual: ${aliceAfterDelete?.photoCount})`);
    assert(aliceAfterDelete?.coverPhotoId === 'photo_a_1', `Alice coverPhotoId safely points to remaining photo 1 (actual: "${aliceAfterDelete?.coverPhotoId}")`);

    // Verify Bob's name is also untouched
    const bobAfterDelete = peopleAfterDelete.find((p) => p.id === bobObj!.id);
    assert(bobAfterDelete?.name === 'Bob', `Bob name is STILL "Bob" (actual: "${bobAfterDelete?.name}")`);
    console.log('   ✅ Test 3 Passed!\n');

    // -------------------------------------------------------------------------
    // TEST 4: Deleting All Photos of a Person (Identity & Name Retention)
    // -------------------------------------------------------------------------
    console.log('👉 TEST 4: Deleting All Photos of Bob (photo_a_3 and photo_a_4)');
    libraryStore.removePhotos(['photo_a_3', 'photo_a_4']);

    const photosAfterBobDelete = libraryStore.getState().photos;
    assert(photosAfterBobDelete.length === 2, `Library A now has 2 photos (photo 1 and photo 5)`);

    // Candidates count must still be 0
    const candidatesAfterBobDelete = photosAfterBobDelete.filter((p) => !p.faceScanCompleted && (!p.faces || p.faces.length === 0));
    assert(candidatesAfterBobDelete.length === 0, 'Face recognition does NOT restart after deleting all photos of Bob');

    // Bob's custom name MUST STILL BE IN MEMORY AND NOT WIPED!
    const peopleAfterBobDelete = libraryStore.getState().people;
    const bobRetained = peopleAfterBobDelete.find((p) => p.id === bobObj!.id);
    assert(bobRetained !== undefined, 'Bob identity is retained in registry even with 0 current photos');
    assert(bobRetained?.name === 'Bob', `Bob custom name "Bob" is NEVER forgotten or reset (actual: "${bobRetained?.name}")`);
    assert(bobRetained?.faceCount === 0, 'Bob faceCount is 0');
    assert(bobRetained?.photoCount === 0, 'Bob photoCount is 0');
    console.log('   ✅ Test 4 Passed!\n');

    // -------------------------------------------------------------------------
    // TEST 5: IPC / Storage Persistence Verification
    // -------------------------------------------------------------------------
    console.log('👉 TEST 5: Global Persistent Storage Verification');
    await libraryStore.persistNow();

    const savedGlobalPeople = persistentStorage.get('gphotos_people_v2');
    assert(Array.isArray(savedGlobalPeople), 'gphotos_people_v2 was persisted to central storage');
    assert(savedGlobalPeople.some((p: any) => p.name === 'Alice'), 'Alice is saved in global people registry');
    assert(savedGlobalPeople.some((p: any) => p.name === 'Bob'), 'Bob is saved in global people registry');

    const savedGlobalFaces = persistentStorage.get('gphotos_face_cache_v2');
    assert(Array.isArray(savedGlobalFaces), 'gphotos_face_cache_v2 was persisted to central storage');
    assert(savedGlobalFaces.length > 0, `Face cache contains ${savedGlobalFaces.length} indexed keys`);
    console.log('   ✅ Test 5 Passed!\n');

    console.log('===============================================================');
    console.log('🎉 ALL 5 PRACTICAL WORKFLOW TESTS PASSED SUCCESSFULLY!');
    console.log('   - No face recognition restarts from photo #1 on library switch');
    console.log('   - No face recognition restarts on photo deletion');
    console.log('   - People names ("Alice", "Bob") preserved 100% without loss');
    console.log('===============================================================');
  } finally {
    // Cleanup fixtures
    try {
      fs.rmSync(tempBase, { recursive: true, force: true });
    } catch {}
  }
}

run5PhotoWorkflowTests().catch((err) => {
  console.error('Test run failed with error:', err);
  process.exit(1);
});
