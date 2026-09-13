import assert from 'assert';
import path from 'path';
import fs from 'fs';
import {
  formatTargetDirectory,
  getUniqueTargetFilePath,
  computeFileHash
} from '../src/main/services/fileOrganizer';
import { findApproximateLocation } from '../src/main/services/exifParser';
import {
  euclideanDistance,
  cosineDistance,
  normalizeVector,
  computeQualityWeightedCentroid,
  clusterFaces,
} from '../src/renderer/src/services/clustering';
import { groupPhotosByPlace } from '../src/renderer/src/services/placesService';
import { getLocalPhotoUrl, libraryStore } from '../src/renderer/src/services/libraryStore';
import { discoverStoredMirrors } from '../src/main/services/virtualMirrorService';
import { DetectedFace, Person, Photo } from '../src/types';

console.log('=== RUNNING TESTS FOR GOOGLE PHOTOS DESKTOP CORE LOGIC ===\n');

// 1. Test Physical Date Organizer Directory Formats
console.log('Test 1: Testing Directory Formatting by Date...');
const sampleDate = new Date('2024-08-15T14:30:00.000Z');
const baseDir = 'C:\\Photos\\Organized';

const path1 = formatTargetDirectory(baseDir, sampleDate, 'YYYY/YYYY-MM');
assert.strictEqual(path1, path.join(baseDir, '2024', '2024-08'), 'YYYY/YYYY-MM structure mismatch');

const path2 = formatTargetDirectory(baseDir, sampleDate, 'YYYY/MM - Month');
assert.strictEqual(path2, path.join(baseDir, '2024', '08 - August'), 'YYYY/MM - Month structure mismatch');

const path3 = formatTargetDirectory(baseDir, sampleDate, 'YYYY/YYYY-MM-DD');
assert.strictEqual(path3, path.join(baseDir, '2024', '2024-08-15'), 'YYYY/YYYY-MM-DD structure mismatch');

const path4 = formatTargetDirectory(baseDir, sampleDate, 'YYYY/MM/DD');
assert.strictEqual(path4, path.join(baseDir, '2024', '08', '15'), 'YYYY/MM/DD structure mismatch');
console.log('✓ All 4 date folder formats formatted correctly!\n');

// 2. Test Collision Handling & Unique File Path
console.log('Test 2: Testing Unique File Name Generation on Collision...');
const tempTestDir = path.join(__dirname, 'temp_test_dir');
if (!fs.existsSync(tempTestDir)) fs.mkdirSync(tempTestDir, { recursive: true });

const existingFile = path.join(tempTestDir, 'photo.jpg');
fs.writeFileSync(existingFile, 'sample content 1');

const uniqueCandidate = getUniqueTargetFilePath(tempTestDir, 'photo.jpg');
assert.strictEqual(uniqueCandidate, path.join(tempTestDir, 'photo_1.jpg'), 'Collision candidate should append _1');

// Clean up temp
fs.unlinkSync(existingFile);
fs.rmdirSync(tempTestDir);
console.log('✓ Unique filename collision handling works correctly!\n');

// 3. Test EXIF GPS Reverse Geocoding
console.log('Test 3: Testing GPS Reverse Geocoding...');
const parisLoc = findApproximateLocation(48.8584, 2.2945); // Eiffel Tower
assert.strictEqual(parisLoc.city, 'Paris', 'Expected Paris');
assert.strictEqual(parisLoc.country, 'France', 'Expected France');

const nyLoc = findApproximateLocation(40.7128, -74.0060); // NYC
assert.strictEqual(nyLoc.city, 'New York', 'Expected New York');

const tokyoLoc = findApproximateLocation(35.6762, 139.6503); // Tokyo
assert.strictEqual(tokyoLoc.city, 'Tokyo', 'Expected Tokyo');
console.log('✓ GPS coordinates correctly resolved to Paris, New York, and Tokyo!\n');

// 4. Test Face Recognition 128-D Biometric Clustering
console.log('Test 4: Testing 128-D Face Vector Clustering...');

// Vector 1: Alice face 1
const aliceVector1 = new Array(128).fill(0.1);
// Vector 2: Alice face 2 (close distance to Alice 1: Euclidean dist ~0.2)
const aliceVector2 = new Array(128).fill(0.12);
// Vector 3: Bob face 1 (orthogonal / distant: Euclidean dist > 0.8)
const bobVector1 = new Array(128).fill(0.5);

const distAliceSame = euclideanDistance(aliceVector1, aliceVector2);
const distAliceBob = euclideanDistance(aliceVector1, bobVector1);

console.log(`  Distance between Alice Face 1 and Alice Face 2: ${distAliceSame.toFixed(4)} (< 0.55 threshold)`);
console.log(`  Distance between Alice Face 1 and Bob Face 1: ${distAliceBob.toFixed(4)} (> 0.55 threshold)`);

assert(distAliceSame < 0.55, 'Alice photos should be under threshold');
assert(distAliceBob > 0.55, 'Alice and Bob photos should exceed threshold');

const mockFaces: DetectedFace[] = [
  {
    id: 'f1',
    photoId: 'p1',
    box: { x: 10, y: 10, width: 80, height: 80 },
    descriptor: aliceVector1,
    confidence: 0.98,
  },
  {
    id: 'f2',
    photoId: 'p2',
    box: { x: 20, y: 20, width: 85, height: 85 },
    descriptor: aliceVector2,
    confidence: 0.97,
  },
  {
    id: 'f3',
    photoId: 'p3',
    box: { x: 15, y: 15, width: 90, height: 90 },
    descriptor: bobVector1,
    confidence: 0.95,
  },
];

const clusterResult = clusterFaces(mockFaces, [], 0.55);
console.log(`  Identified ${clusterResult.people.length} distinct people clusters.`);

assert.strictEqual(clusterResult.people.length, 2, 'Should cluster into exactly 2 people');
const personA = clusterResult.people.find((p) => p.faceCount === 2);
const personB = clusterResult.people.find((p) => p.faceCount === 1);

assert(personA != null, 'Person with 2 faces should exist (Alice)');
assert(personB != null, 'Person with 1 face should exist (Bob)');
assert.strictEqual(clusterResult.updatedFaces[0].personId, clusterResult.updatedFaces[1].personId, 'f1 and f2 should have same personId');
assert.notStrictEqual(clusterResult.updatedFaces[0].personId, clusterResult.updatedFaces[2].personId, 'f1 and f3 should have different personId');

console.log('✓ Face clustering accurately separated 2 distinct people clusters!\n');

// 5. Test Multi-Face In Single Photo Uniqueness Constraint
console.log('Test 5: Testing Single-Photo Multi-Face Disqualification...');
// Create two faces in the SAME photo with identical/extremely close embeddings (like twins or same descriptor)
const twinFacesInSamePhoto: DetectedFace[] = [
  {
    id: 'face_photo1_left',
    photoId: 'photo_group_1',
    box: { x: 10, y: 10, width: 80, height: 80 },
    descriptor: new Array(128).fill(0.1), // Alice vector
    confidence: 0.99,
  },
  {
    id: 'face_photo1_right',
    photoId: 'photo_group_1', // SAME photo!
    box: { x: 120, y: 10, width: 80, height: 80 },
    descriptor: new Array(128).fill(0.105), // Extremely close to Alice (dist ~0.05 < 0.55)
    confidence: 0.98,
  },
];

const twinClustering = clusterFaces(twinFacesInSamePhoto, [], 0.55);
console.log(`  Identified ${twinClustering.people.length} distinct people in the single group photo.`);
assert.strictEqual(twinClustering.people.length, 2, 'Two faces in the same photo MUST be assigned to 2 different people!');
assert.notStrictEqual(
  twinClustering.updatedFaces[0].personId,
  twinClustering.updatedFaces[1].personId,
  'Two faces in the same photo must NEVER share the same personId!'
);
console.log('✓ Single photo multi-face uniqueness constraint verified successfully!\n');

// 6. Test Virtual Storage Incremental Rescan / Refresh
console.log('Test 6: Testing Virtual Storage Incremental Rescan / Refresh...');
import { syncVirtualStorage } from '../src/main/services/virtualMirrorService';

const mockNetDir = path.join(__dirname, 'temp_mock_nas');
const mockLocalMirror = path.join(__dirname, 'temp_local_mirror');

if (!fs.existsSync(mockNetDir)) fs.mkdirSync(mockNetDir, { recursive: true });
if (!fs.existsSync(mockLocalMirror)) fs.mkdirSync(mockLocalMirror, { recursive: true });

// Add photo 1 to network folder
const p1Path = path.join(mockNetDir, 'photo1.jpg');
fs.writeFileSync(p1Path, 'dummy jpeg content 1');

const storageConfig = {
  id: 'test_nas',
  name: 'TestNAS',
  networkSourcePath: mockNetDir,
  localMirrorRoot: mockLocalMirror,
};

async function testRescan() {
  // First Sync: Should find 1 photo and add 1
  const run1 = await syncVirtualStorage(storageConfig);
  assert.strictEqual(run1.totalSynced, 1, 'Run 1 should sync 1 file');
  assert.strictEqual(run1.newlyAdded, 1, 'Run 1 should have newlyAdded = 1');
  console.log(`  Run 1: Synced ${run1.totalSynced} items (+${run1.newlyAdded} newly added).`);

  // Repeat Rescan without adding files: Should report 0 newly added
  const run2 = await syncVirtualStorage(storageConfig);
  assert.strictEqual(run2.totalSynced, 1, 'Run 2 should report 1 file');
  assert.strictEqual(run2.newlyAdded, 0, 'Run 2 should have newlyAdded = 0 (up-to-date)');
  console.log(`  Run 2: Rescan reported up-to-date (+${run2.newlyAdded} new).`);

  // Add photo 2 to network folder
  const p2Path = path.join(mockNetDir, 'photo2.jpg');
  fs.writeFileSync(p2Path, 'dummy jpeg content 2');

  // Third Sync: Should detect photo 2 as newly added!
  const run3 = await syncVirtualStorage(storageConfig);
  assert.strictEqual(run3.totalSynced, 2, 'Run 3 should have 2 total synced');
  assert.strictEqual(run3.newlyAdded, 1, 'Run 3 should have newlyAdded = 1');
  console.log(`  Run 3: Rescan detected newly added photo (+${run3.newlyAdded} new)!`);

  // Clean up
  fs.rmSync(mockNetDir, { recursive: true, force: true });
  fs.rmSync(mockLocalMirror, { recursive: true, force: true });
  console.log('✓ Virtual Storage incremental rescan / refresh logic passed!\n');

  // 7. Test Reassign Face: "This is not Renuka, but Monika"
  console.log('Test 7: Testing Face Reassignment ("This is not Renuka, but Monika")...');
  const { libraryStore } = await import('../src/renderer/src/services/libraryStore');
  const { Photo } = await import('../src/types');

  const faceA: DetectedFace = {
    id: 'face_renuka_1',
    photoId: 'photo_100',
    box: { x: 10, y: 10, width: 60, height: 60 },
    descriptor: new Array(128).fill(0.2),
    confidence: 0.95,
    personId: 'person_renuka',
  };

  const photo100 = {
    id: 'photo_100',
    fileName: 'family.jpg',
    filePath: 'C:\\photos\\family.jpg',
    createdAt: new Date().toISOString(),
    faces: [faceA],
  };

  const personRenuka = {
    id: 'person_renuka',
    name: 'Renuka',
    faceCount: 1,
    photoCount: 1,
    coverFaceId: 'face_renuka_1',
    coverPhotoId: 'photo_100',
    createdAt: new Date().toISOString(),
  };

  libraryStore.setPhotos([photo100 as any]);
  libraryStore.getState().faces = [faceA];
  libraryStore.getState().people = [personRenuka];

  // Reassign face_renuka_1 to "Monika"
  const reassignRes = libraryStore.reassignFaceToPerson('face_renuka_1', 'Monika');
  assert.strictEqual(reassignRes.success, true, 'Reassignment to Monika should succeed');

  const monika = libraryStore.getState().people.find((p) => p.name === 'Monika');
  assert(monika != null, 'Monika should now exist in people list');
  assert.strictEqual(faceA.personId, monika.id, 'Face should now belong to Monika');
  console.log('✓ Successfully reassigned face from Renuka to Monika!\n');

  // 8. Test Constraint: Cannot reassign to a person who already has a face in the same photo
  console.log('Test 8: Testing Multi-Face Single-Photo Reassignment Constraint...');
  const faceMonikaInPhoto200: DetectedFace = {
    id: 'face_monika_photo200',
    photoId: 'photo_200',
    box: { x: 10, y: 10, width: 60, height: 60 },
    descriptor: new Array(128).fill(0.2),
    confidence: 0.95,
    personId: monika.id,
  };
  const faceStrangerInPhoto200: DetectedFace = {
    id: 'face_stranger_photo200',
    photoId: 'photo_200',
    box: { x: 100, y: 10, width: 60, height: 60 },
    descriptor: new Array(128).fill(0.8),
    confidence: 0.90,
    personId: 'person_stranger',
  };
  const photo200 = {
    id: 'photo_200',
    fileName: 'party.jpg',
    filePath: 'C:\\photos\\party.jpg',
    createdAt: new Date().toISOString(),
    faces: [faceMonikaInPhoto200, faceStrangerInPhoto200],
  };
  libraryStore.setPhotos([photo100 as any, photo200 as any]);
  libraryStore.getState().faces.push(faceMonikaInPhoto200, faceStrangerInPhoto200);

  // Try to reassign faceStrangerInPhoto200 to Monika (who is ALREADY in photo_200)
  const conflictRes = libraryStore.reassignFaceToPerson('face_stranger_photo200', 'Monika');
  assert.strictEqual(conflictRes.success, false, 'Conflict reassignment must fail');
  assert(conflictRes.error?.includes('One photo cannot contain two faces of the same person'), 'Error message should explain single-photo constraint');
  console.log(`  Constraint enforced: "${conflictRes.error}"`);
  console.log('✓ Disallowed duplicate person assignment in same photo!\n');

  // 9. Test Merge People: Merge two detected clusters into one with preferred name
  console.log('Test 9: Testing Merge People with Preferred Name Selection...');
  const faceCluster1: DetectedFace = {
    id: 'face_c1',
    photoId: 'photo_c1',
    box: { x: 10, y: 10, width: 50, height: 50 },
    descriptor: new Array(128).fill(0.3),
    confidence: 0.92,
    personId: 'person_cluster_a',
  };
  const faceCluster2: DetectedFace = {
    id: 'face_c2',
    photoId: 'photo_c2',
    box: { x: 10, y: 10, width: 50, height: 50 },
    descriptor: new Array(128).fill(0.31),
    confidence: 0.93,
    personId: 'person_cluster_b',
  };

  const photoC1 = {
    id: 'photo_c1',
    fileName: 'pic1.jpg',
    filePath: 'C:\\photos\\pic1.jpg',
    createdAt: new Date().toISOString(),
    faces: [faceCluster1],
  };
  const photoC2 = {
    id: 'photo_c2',
    fileName: 'pic2.jpg',
    filePath: 'C:\\photos\\pic2.jpg',
    createdAt: new Date().toISOString(),
    faces: [faceCluster2],
  };

  const personClusterA = {
    id: 'person_cluster_a',
    name: 'Person 1',
    faceCount: 1,
    photoCount: 1,
    coverFaceId: 'face_c1',
    coverPhotoId: 'photo_c1',
    createdAt: new Date().toISOString(),
  };
  const personClusterB = {
    id: 'person_cluster_b',
    name: 'Monika Sharma',
    faceCount: 1,
    photoCount: 1,
    coverFaceId: 'face_c2',
    coverPhotoId: 'photo_c2',
    createdAt: new Date().toISOString(),
  };

  libraryStore.setPhotos([photoC1 as any, photoC2 as any]);
  libraryStore.getState().faces = [faceCluster1, faceCluster2];
  libraryStore.getState().people = [personClusterA, personClusterB];

  // Merge Person 1 into Monika Sharma with preferred name "Monika Sharma"
  const mergeSuccess = libraryStore.mergePeople('person_cluster_b', 'person_cluster_a', 'Monika Sharma');
  assert.strictEqual(mergeSuccess, true, 'Merge should succeed');

  const mergedPerson = libraryStore.getState().people.find((p) => p.name === 'Monika Sharma');
  assert(mergedPerson != null, 'Merged person Monika Sharma must exist');
  assert.strictEqual(mergedPerson.faceCount, 2, 'Merged person should contain both faces');
  assert.strictEqual(faceCluster1.personId, mergedPerson.id, 'Cluster 1 face must be updated to merged person');
  assert.strictEqual(faceCluster2.personId, mergedPerson.id, 'Cluster 2 face must be updated to merged person');
  console.log('✓ People successfully merged with preferred name "Monika Sharma"!\n');

  // 10. Test Auto-Discovery of Virtual Mirrors from disk
  console.log('Test 10: Testing Auto-Discovery of Stored Mirrors on disk...');
  const discovered = discoverStoredMirrors('C:\\GPhotos_VirtualMirrors');
  console.log(`  Discovered ${discovered.length} mirrors on disk:`, discovered.map((d) => `${d.name} (${d.totalItems} items)`));
  const photo1Storage = discovered.find((d) => d.name === 'photo1');
  assert(photo1Storage != null, 'photo1 mirror folder must be discovered on disk');
  assert(photo1Storage.totalItems > 0, 'photo1 mirror must contain indexed photos');
  console.log('✓ Virtual mirror "photo1" auto-discovered from disk with correct item count!\n');

  // 11. Test Delete Person from People List
  console.log('Test 11: Testing Delete Person from People List...');
  const personToDeleteId = mergedPerson.id;
  await libraryStore.deletePerson(personToDeleteId);
  const remainingPerson = libraryStore.getState().people.find((p) => p.id === personToDeleteId);
  assert.strictEqual(remainingPerson, undefined, 'Deleted person must not exist in state.people');
  const unassignedFace1 = libraryStore.getState().faces.find((f) => f.id === 'face_c1');
  const unassignedFace2 = libraryStore.getState().faces.find((f) => f.id === 'face_c2');
  assert.strictEqual(unassignedFace1?.personId, undefined, 'Face 1 must be unassigned after person deletion');
  assert.strictEqual(unassignedFace2?.personId, undefined, 'Face 2 must be unassigned after person deletion');
  assert.strictEqual(unassignedFace1?.isConfirmed, false, 'Face 1 isConfirmed must be reset');
  console.log('✓ Delete person successfully removed person and unassigned all their faces!\n');

  // 12. Test Manual Face Tagging on Photograph
  console.log('Test 12: Testing Manual Face Tagging directly on Photograph...');
  const manualBox = { x: 50, y: 60, width: 120, height: 130 };
  const manualFace = libraryStore.addManualFace('photo_c1', manualBox, [0.4, 0.4, 0.4]);
  assert(manualFace != null, 'Manual face must be created');
  assert.strictEqual(manualFace.isManual, true, 'isManual must be true');
  assert.strictEqual(manualFace.isConfirmed, true, 'isConfirmed must be true');
  assert.deepStrictEqual(manualFace.box, manualBox, 'Box coordinates must match');
  const targetPhoto = libraryStore.getState().photos.find((p) => p.id === 'photo_c1');
  const photoHasManualFace = targetPhoto?.faces?.some((f) => f.id === manualFace.id);
  assert.strictEqual(photoHasManualFace, true, 'Target photo must contain manual face');
  console.log('✓ Manual face successfully created and appended to photo!\n');

  // 13. Test Single-Photo High-Precision Detection & Duplicate Prevention
  console.log('Test 13: Testing Single-Photo Face Detection with Learned Assignments & Single-Photo Uniqueness...');
  const rahulDescriptor = new Array(128).fill(0.2);
  const rahulFace: DetectedFace = {
    id: 'face_rahul_known',
    photoId: 'photo_rahul_prev',
    box: { x: 10, y: 10, width: 50, height: 50 },
    descriptor: rahulDescriptor,
    confidence: 0.95,
    isConfirmed: true,
  };
  const rahulPerson: Person = {
    id: 'person_rahul',
    name: 'Rahul',
    faceCount: 1,
    photoCount: 1,
    createdAt: new Date().toISOString(),
  };
  rahulFace.personId = rahulPerson.id;

  libraryStore.getState().people = [rahulPerson];
  libraryStore.getState().faces.push(rahulFace);

  // New detections in photo_c2:
  // Face D1 matches Rahul closely (distance ~0.05, well below 0.48)
  const d1Descriptor = new Array(128).fill(0.204);
  // Face D2 also matches Rahul (distance ~0.08)
  const d2Descriptor = new Array(128).fill(0.207);

  const newDetections: DetectedFace[] = [
    {
      id: 'det_1',
      photoId: 'photo_c2',
      box: { x: 30, y: 30, width: 60, height: 60 },
      descriptor: d1Descriptor,
      confidence: 0.94,
    },
    {
      id: 'det_2',
      photoId: 'photo_c2',
      box: { x: 120, y: 30, width: 60, height: 60 },
      descriptor: d2Descriptor,
      confidence: 0.91,
    },
  ];

  const updatedPhoto = await libraryStore.detectAndMatchFacesForPhoto('photo_c2', newDetections, 0.48);
  assert(updatedPhoto.faces != null && updatedPhoto.faces.length >= 2, 'Photo must have faces');

  // Verify Single-Photo Uniqueness: In photo_c2, NO TWO FACES CAN BE ASSIGNED TO RAHUL!
  const rahulAssignmentsInPhoto = updatedPhoto.faces.filter((f) => f.personId === rahulPerson.id);
  assert.strictEqual(rahulAssignmentsInPhoto.length, 1, 'Exactly ONE face in the photo can be assigned to Rahul');
  assert.strictEqual(rahulAssignmentsInPhoto[0].id, 'det_1', 'Closest matching face (det_1) must be assigned to Rahul');
  console.log('✓ Single-photo high-precision matching verified with strict duplicate prevention!\n');

  // 14. Test GPS Reverse Geocoding for Regional Indian Cities
  console.log('Test 14: Testing Regional Indian GPS Reverse Geocoding...');
  const suratLoc = findApproximateLocation(21.150925, 72.804526);
  assert.strictEqual(suratLoc.city, 'Surat', 'Expected Surat');
  assert.strictEqual(suratLoc.country, 'India', 'Expected India');

  const chennaiLoc = findApproximateLocation(12.965568, 80.191362);
  assert.strictEqual(chennaiLoc.city, 'Chennai', 'Expected Chennai');
  assert.strictEqual(chennaiLoc.country, 'India', 'Expected India');

  const halolLoc = findApproximateLocation(22.4984, 73.4727);
  assert.strictEqual(halolLoc.city, 'Halol', 'Expected Halol');
  assert.strictEqual(halolLoc.country, 'India', 'Expected India');

  const bhavnagarLoc = findApproximateLocation(21.7645, 72.1519);
  assert.strictEqual(bhavnagarLoc.city, 'Bhavnagar', 'Expected Bhavnagar');

  const dholkaLoc = findApproximateLocation(22.7200, 72.4600);
  assert.strictEqual(dholkaLoc.city, 'Dholka', 'Expected Dholka');
  console.log('✓ GPS coordinates for Surat, Chennai, Halol, Bhavnagar, and Dholka resolved with precision!\n');

  // 15. Test Place Albums Separation (No Country-Level Single Point Collapse)
  console.log('Test 15: Testing Multi-Location Separation in Places Grouping...');
  const mockGeoPhotos: Photo[] = [
    {
      id: 'p_surat',
      filePath: 'C:\\thumb_surat.jpg',
      fileName: 'surat.jpg',
      fileSize: 1000,
      fileDate: new Date().toISOString(),
      dateTaken: new Date().toISOString(),
      year: 2026, month: 1, day: 14,
      location: { latitude: 21.150925, longitude: 72.804526, city: 'Surat', country: 'India' }
    },
    {
      id: 'p_chennai',
      filePath: 'C:\\thumb_chennai.jpg',
      fileName: 'chennai.jpg',
      fileSize: 1000,
      fileDate: new Date().toISOString(),
      dateTaken: new Date().toISOString(),
      year: 2026, month: 1, day: 30,
      location: { latitude: 12.965568, longitude: 80.191362, city: 'Chennai', country: 'India' }
    },
    {
      id: 'p_halol',
      filePath: 'C:\\thumb_halol.jpg',
      fileName: 'halol.jpg',
      fileSize: 1000,
      fileDate: new Date().toISOString(),
      dateTaken: new Date().toISOString(),
      year: 2026, month: 7, day: 26,
      location: { latitude: 22.4984, longitude: 73.4727, city: 'Halol', country: 'India' }
    },
    {
      id: 'p_unknown_grid',
      filePath: 'C:\\thumb_unknown.jpg',
      fileName: 'unknown.jpg',
      fileSize: 1000,
      fileDate: new Date().toISOString(),
      dateTaken: new Date().toISOString(),
      year: 2026, month: 5, day: 10,
      location: { latitude: 24.5854, longitude: 73.7125, country: 'India' } // Udaipur area without explicit city
    }
  ];

  const albums = groupPhotosByPlace(mockGeoPhotos);
  console.log('  Created place albums:', albums.map(a => `${a.name} (${a.latitude.toFixed(2)}, ${a.longitude.toFixed(2)})`));
  assert.strictEqual(albums.length, 4, 'Must create 4 distinct albums and NOT collapse all into one country point');
  const albumNames = albums.map(a => a.name);
  assert(albumNames.some(n => n.includes('Surat')), 'Must contain Surat album');
  assert(albumNames.some(n => n.includes('Chennai')), 'Must contain Chennai album');
  assert(albumNames.some(n => n.includes('Halol')), 'Must contain Halol album');
  console.log('✓ Verified place albums separate geographically and never collapse into a single point!\n');

  // 16. Test getLocalPhotoUrl with preferOriginal
  console.log('Test 16: Testing High-Res Original Photo URL Generation...');
  // Mock window.electronAPI
  (global as any).window = { electronAPI: {} };
  const thumbPath = 'C:\\GPhotos_VirtualMirrors\\photo1\\sample.jpg';
  const remoteOrigPath = 'C:\\NetworkDrive\\Photos\\sample.jpg';

  const defaultUrl = getLocalPhotoUrl(thumbPath, remoteOrigPath, false);
  assert(defaultUrl.includes('path=' + encodeURIComponent(thumbPath)), 'Must include thumb path');
  assert(defaultUrl.includes('originalPath=' + encodeURIComponent(remoteOrigPath)), 'Must include original remote path');
  assert(!defaultUrl.includes('preferOriginal=1'), 'Default thumbnail URL should not prefer original');

  const highResUrl = getLocalPhotoUrl(thumbPath, remoteOrigPath, true);
  assert(highResUrl.includes('preferOriginal=1'), 'High-res request URL must have preferOriginal=1');
  console.log('✓ High-res original photo URL successfully generated with preferOriginal=1!\n');

  // 17. Test CosFace L2 Normalization & Cosine Angular Distance
  console.log('Test 17: Testing CosFace L2 Normalization & Cosine Metric...');
  const unnorm1 = [3, 4]; // norm = 5
  const norm1 = normalizeVector(unnorm1);
  assert(Math.abs(norm1[0] - 0.6) < 1e-6, 'L2 norm component x mismatch');
  assert(Math.abs(norm1[1] - 0.8) < 1e-6, 'L2 norm component y mismatch');

  const vecA = normalizeVector([1, 0, 0]);
  const vecB = normalizeVector([1, 0, 0]);
  const vecC = normalizeVector([0, 1, 0]);
  const vecD = normalizeVector([-1, 0, 0]);

  assert(Math.abs(cosineDistance(vecA, vecB)) < 1e-6, 'Identical vectors should have cosine distance 0');
  assert(Math.abs(cosineDistance(vecA, vecC) - 1.0) < 1e-6, 'Orthogonal vectors should have cosine distance 1');
  assert(Math.abs(cosineDistance(vecA, vecD) - 2.0) < 1e-6, 'Opposite vectors should have cosine distance 2');
  console.log('✓ CosFace L2 normalization and cosine angular metric verified!\n');

  // 18. Test Quality-Weighted Centroids
  console.log('Test 18: Testing Quality-Weighted Centroid Calculation...');
  const testFace1: DetectedFace = {
    id: 'tf1',
    photoId: 'tp1',
    box: { x: 0, y: 0, width: 200, height: 200 },
    descriptor: normalizeVector(new Array(128).fill(1)),
    confidence: 0.99,
    isConfirmed: true, // 2.5x multiplier
  };
  const testFace2: DetectedFace = {
    id: 'tf2',
    photoId: 'tp2',
    box: { x: 0, y: 0, width: 50, height: 50 },
    descriptor: normalizeVector(new Array(128).fill(-1)),
    confidence: 0.35,
    isConfirmed: false,
  };

  const weightedCentroid = computeQualityWeightedCentroid([testFace1, testFace2]);
  assert.strictEqual(weightedCentroid.length, 128, 'Centroid length must match descriptor length');
  assert(weightedCentroid[0] > 0, 'Confirmed face must dominate quality-weighted centroid');
  const centroidNorm = Math.sqrt(weightedCentroid.reduce((acc, v) => acc + v * v, 0));
  assert(Math.abs(centroidNorm - 1.0) < 1e-4, 'Centroid must be unit normalized');
  console.log('✓ Quality-weighted centroid heavily weights confirmed & large faces and resists low-confidence drift!\n');

  // 19. Test canMergePeople returning Conflict Photo object
  console.log('Test 19: Testing canMergePeople returning Conflict Photo Object...');
  const personP1: Person = { id: 'p_monika', name: 'Monika', faceCount: 1, photoCount: 1, createdAt: '' };
  const personP2: Person = { id: 'p_renuka', name: 'Renuka', faceCount: 1, photoCount: 1, createdAt: '' };

  const conflictPhoto: Photo = {
    id: 'photo_group_conflict',
    filePath: 'C:\\Photos\\group.jpg',
    fileName: 'group.jpg',
    fileSize: 1000,
    fileDate: '', dateTaken: '2026-01-01', year: 2026, month: 1, day: 1,
    faces: [
      { id: 'f_p1', photoId: 'photo_group_conflict', box: { x: 10, y: 10, width: 80, height: 80 }, descriptor: new Array(128).fill(0.1), personId: 'p_monika', confidence: 0.9 },
      { id: 'f_p2', photoId: 'photo_group_conflict', box: { x: 120, y: 10, width: 80, height: 80 }, descriptor: new Array(128).fill(0.5), personId: 'p_renuka', confidence: 0.9 },
    ]
  };

  libraryStore.setPhotos([conflictPhoto]);
  libraryStore.updatePersonName(personP1.id, personP1.name);

  const mergeCheck = libraryStore.canMergePeople('p_monika', 'p_renuka');
  assert.strictEqual(mergeCheck.canMerge, false, 'Should be detected as conflict');
  assert(mergeCheck.conflictPhoto, 'Conflict check must return the conflicting photo object');
  assert.strictEqual(mergeCheck.conflictPhoto?.id, 'photo_group_conflict', 'Conflict photo ID mismatch');
  assert.strictEqual(mergeCheck.conflictPhotoName, 'group.jpg', 'Conflict photo name mismatch');
  console.log('✓ canMergePeople returned conflictPhoto object for clickable Lightbox opening!\n');

  // 20. Test Learned Face Propagation on Manual Reassignment
  console.log('Test 20: Testing Learned Face Propagation across Library...');
  const monikaProfileVec = normalizeVector(new Array(128).fill(0.2));
  const photoWithConfirmedMonika: Photo = {
    id: 'photo_monika_anchor',
    filePath: 'C:\\Photos\\monika_anchor.jpg',
    fileName: 'monika_anchor.jpg',
    fileSize: 1000,
    fileDate: '', dateTaken: '2026-01-02', year: 2026, month: 1, day: 2,
    faces: [
      { id: 'f_monika_confirmed', photoId: 'photo_monika_anchor', box: { x: 10, y: 10, width: 100, height: 100 }, descriptor: monikaProfileVec, personId: 'p_monika', confidence: 0.99, isConfirmed: true, isManual: true }
    ]
  };

  const photoWithUnassignedFace: Photo = {
    id: 'photo_unassigned_monika',
    filePath: 'C:\\Photos\\monika_unassigned.jpg',
    fileName: 'monika_unassigned.jpg',
    fileSize: 1000,
    fileDate: '', dateTaken: '2026-01-03', year: 2026, month: 1, day: 3,
    faces: [
      { id: 'f_candidate', photoId: 'photo_unassigned_monika', box: { x: 20, y: 20, width: 90, height: 90 }, descriptor: normalizeVector(new Array(128).fill(0.21)), confidence: 0.88 }
    ]
  };

  libraryStore.setPhotos([photoWithConfirmedMonika, photoWithUnassignedFace]);
  const propResult = libraryStore.propagateLearnedFaces('p_monika');
  console.log('  Propagated learned faces result:', propResult);
  assert.strictEqual(propResult.newlyAssignedCount, 1, 'Should auto-propagate to 1 unassigned face');

  const updatedTargetPhoto = libraryStore.getState().photos.find(p => p.id === 'photo_unassigned_monika');
  assert.strictEqual(updatedTargetPhoto?.faces?.[0].personId, 'p_monika', 'Unassigned face should now be recognized as Monika');
  console.log('✓ Learned face propagation successfully recognized person in unassigned library photos!\n');

  // 21. Test Reset All People and Faces
  console.log('Test 21: Testing Reset All People and Faces...');
  assert(libraryStore.getState().photos.some(p => p.faces && p.faces.length > 0), 'Must have faces before reset');
  libraryStore.resetAllPeopleAndFaces();

  const stateAfterReset = libraryStore.getState();
  assert.strictEqual(stateAfterReset.people.length, 0, 'People list must be empty after reset');
  assert.strictEqual(stateAfterReset.faces.length, 0, 'Faces list must be empty after reset');
  assert(stateAfterReset.photos.every(p => !p.faces || p.faces.length === 0), 'All photo faces must be purged');
  console.log('✓ Reset All People and Faces completely wiped all biometric data for fresh start!\n');

  // 22. Test Person Renaming & Duplicate Name Auto-Merging
  console.log('Test 22: Testing Person Renaming & Duplicate Name Auto-Merging...');
  const personR1: Person = { id: 'p_rename_1', name: 'Person 1', faceCount: 1, photoCount: 1, createdAt: '' };
  const personR2: Person = { id: 'p_rename_2', name: 'Person 2', faceCount: 1, photoCount: 1, createdAt: '' };
  const photoR1: Photo = {
    id: 'photo_r1',
    filePath: 'C:\\Photos\\r1.jpg',
    fileName: 'r1.jpg',
    fileSize: 1000,
    fileDate: '', dateTaken: '2026-01-01', year: 2026, month: 1, day: 1,
    faces: [
      { id: 'f_r1', photoId: 'photo_r1', box: { x: 10, y: 10, width: 50, height: 50 }, descriptor: new Array(128).fill(0.1), personId: 'p_rename_1', confidence: 0.95 }
    ]
  };
  const photoR2: Photo = {
    id: 'photo_r2',
    filePath: 'C:\\Photos\\r2.jpg',
    fileName: 'r2.jpg',
    fileSize: 1000,
    fileDate: '', dateTaken: '2026-01-02', year: 2026, month: 1, day: 2,
    faces: [
      { id: 'f_r2', photoId: 'photo_r2', box: { x: 10, y: 10, width: 50, height: 50 }, descriptor: new Array(128).fill(0.11), personId: 'p_rename_2', confidence: 0.95 }
    ]
  };

  libraryStore.setPhotos([photoR1, photoR2]);
  libraryStore.getState().people = [personR1, personR2];
  libraryStore.getState().faces = [...photoR1.faces!, ...photoR2.faces!];

  // 1. Rename Person 1 to "Monika"
  const renameRes1 = libraryStore.updatePersonName('p_rename_1', 'Monika');
  assert.strictEqual(renameRes1.success, true, 'Renaming Person 1 to Monika should succeed');
  assert.strictEqual(libraryStore.getState().people.find(p => p.id === 'p_rename_1')?.name, 'Monika', 'Name should be Monika');

  // 2. Rename Person 2 to "Monika" (different photos, so auto-merge should occur)
  const renameRes2 = libraryStore.updatePersonName('p_rename_2', 'Monika');
  assert.strictEqual(renameRes2.success, true, 'Renaming to existing name should succeed via merge');
  assert.strictEqual(renameRes2.merged, true, 'Should report merged');
  assert.strictEqual(libraryStore.getState().people.length, 1, 'Should now be a single merged Monika');
  assert.strictEqual(libraryStore.getState().people[0].name, 'Monika', 'Remaining person should be Monika');
  assert.strictEqual(libraryStore.getState().faces.filter(f => f.personId === 'p_rename_1').length, 2, 'Both faces should belong to Monika');
  console.log('✓ Person Renaming & Auto-Merging into existing name passed!\n');

  // 23. Test Active Learning Face Confirmation & Learned Centroid Propagation
  console.log('Test 23: Testing Active Learning Face Confirmation & Learned Propagation...');
  libraryStore.resetAllPeopleAndFaces();

  const testPersonAlice: Person = {
    id: 'p_alice_learn',
    name: 'Alice',
    faceCount: 1,
    photoCount: 1,
    createdAt: new Date().toISOString()
  };

  const photoAliceConfirmed: Photo = {
    id: 'photo_alice_conf',
    filePath: 'C:\\Photos\\alice_conf.jpg',
    fileName: 'alice_conf.jpg',
    fileSize: 1000,
    fileDate: '', dateTaken: '2026-01-01', year: 2026, month: 1, day: 1,
    faces: [
      {
        id: 'face_alice_unconf',
        photoId: 'photo_alice_conf',
        box: { x: 10, y: 10, width: 100, height: 100 },
        descriptor: normalizeVector(new Array(128).fill(0.2)),
        personId: 'p_alice_learn',
        isConfirmed: false,
        confidence: 0.95
      }
    ]
  };

  const photoAliceUnassigned: Photo = {
    id: 'photo_alice_unassigned',
    filePath: 'C:\\Photos\\alice_unassigned.jpg',
    fileName: 'alice_unassigned.jpg',
    fileSize: 1000,
    fileDate: '', dateTaken: '2026-01-02', year: 2026, month: 1, day: 2,
    faces: [
      {
        id: 'face_candidate',
        photoId: 'photo_alice_unassigned',
        box: { x: 10, y: 10, width: 100, height: 100 },
        descriptor: normalizeVector(new Array(128).fill(0.2)),
        isConfirmed: false,
        confidence: 0.90
      }
    ]
  };

  libraryStore.setPhotos([photoAliceConfirmed, photoAliceUnassigned]);
  libraryStore.getState().people = [testPersonAlice];

  // setPhotos() already runs its own reconciliation pass, which (given these two
  // faces share an identical descriptor) may have proactively matched them to each
  // other under an auto-generated person id. Reset both the per-photo and flat face
  // lists to the original, not-yet-propagated fixture objects so this test can
  // verify that confirmFace() itself is what triggers the propagation/match below,
  // rather than piggybacking on setPhotos()'s own auto-matching.
  const stateConfirmedPhoto = libraryStore.getState().photos.find((p) => p.id === photoAliceConfirmed.id)!;
  const stateUnassignedPhoto = libraryStore.getState().photos.find((p) => p.id === photoAliceUnassigned.id)!;
  stateConfirmedPhoto.faces = [photoAliceConfirmed.faces![0]];
  stateUnassignedPhoto.faces = [photoAliceUnassigned.faces![0]];
  libraryStore.getState().faces = [...photoAliceConfirmed.faces!, ...photoAliceUnassigned.faces!];

  // Call confirmFace
  const confirmResult = libraryStore.confirmFace('face_alice_unconf');
  assert(confirmResult.newlyAssignedCount >= 1, 'confirmFace must automatically propagate learned centroid and match unassigned photos');
  assert.strictEqual(photoAliceConfirmed.faces![0].isConfirmed, true, 'Target face must be marked confirmed');
  assert.strictEqual(photoAliceUnassigned.faces![0].personId, 'p_alice_learn', 'Unassigned photo must be matched to Alice');
  console.log('✓ confirmFace automatically triggered 2.5x weighted centroid propagation and discovered matching library photos!\n');

  console.log('=== ALL 23 CORE TESTS PASSED WITH 100% SUCCESS ===\n');

  // One-time sync of existing disk sidecars with new city entries
  const mirrorDir = 'C:\\GPhotos_VirtualMirrors\\photo1';
  if (fs.existsSync(mirrorDir)) {
    const sidecars = fs.readdirSync(mirrorDir).filter((f) => f.endsWith('.json'));
    let count = 0;
    for (const f of sidecars) {
      const p = path.join(mirrorDir, f);
      const meta = JSON.parse(fs.readFileSync(p, 'utf-8'));
      if (meta.location && meta.location.latitude && meta.location.longitude) {
        const loc = findApproximateLocation(meta.location.latitude, meta.location.longitude);
        if (loc.city !== meta.location.city || loc.country !== meta.location.country) {
          meta.location.city = loc.city;
          meta.location.country = loc.country;
          meta.location.label = loc.city ? `${loc.city}, ${loc.country}` : loc.country;
          fs.writeFileSync(p, JSON.stringify(meta, null, 2), 'utf-8');
          count++;
        }
      }
    }
    if (count > 0) {
      console.log(`Updated ${count} existing sidecars with precise cities on disk!`);
    }
  }
}

testRescan();

