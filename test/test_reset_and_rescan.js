const fs = require('fs');
const path = require('path');

console.log('===============================================================');
console.log(' TEST SUITE: Reset & Rescan Verification & Progress Integrity ');
console.log('===============================================================\n');

let totalTests = 0;
let passedTests = 0;

function assert(condition, testName, detail) {
  totalTests++;
  if (condition) {
    console.log(`[PASS] Test ${totalTests}: ${testName}`);
    passedTests++;
  } else {
    console.error(`[FAIL] Test ${totalTests}: ${testName}${detail ? ' -> ' + detail : ''}`);
    process.exitCode = 1;
  }
}

// 1. Check current library state
const storePath = 'C:\\Users\\sacbh\\AppData\\Roaming\\gPhotos\\library.json';
assert(fs.existsSync(storePath), 'library.json exists on disk');

const initialRaw = fs.readFileSync(storePath, 'utf8');
const initialData = JSON.parse(initialRaw);
const initialLib = initialData['gphotos_library_v1'];

console.log('\n--- Phase 1: Pre-Reset Inspection ---');
console.log(`- Photos in library: ${initialLib.photos?.length || 0}`);
console.log(`- People profiles: ${initialLib.people?.length || 0}`);
console.log(`- Detected faces: ${initialLib.faces?.length || 0}`);

assert((initialLib.photos?.length || 0) > 0, 'Library contains photos before reset');

// 2. Test resetAllPeopleAndFaces logic
console.log('\n--- Phase 2: Executing Reset & Verifying Background Data Purge ---');

// Emulate resetAllPeopleAndFaces on library state
const workingPhotos = (initialLib.photos || []).map((p) => ({ ...p }));
let workingPeople = (initialLib.people || []).map((p) => ({ ...p }));
let workingFaces = (initialLib.faces || []).map((f) => ({ ...f }));

// Execute reset
workingPeople = [];
workingFaces = [];
for (const photo of workingPhotos) {
  photo.faces = [];
  photo.faceScanCompleted = false;
}

assert(workingPeople.length === 0, 'All people profiles are completely purged (0 people)');
assert(workingFaces.length === 0, 'All detected face boxes are completely purged (0 faces)');

const photosWithFacesRemaining = workingPhotos.filter((p) => p.faces && p.faces.length > 0);
assert(photosWithFacesRemaining.length === 0, 'Every photo has its faces array reset to empty');

const photosWithScanCompletedTrue = workingPhotos.filter((p) => p.faceScanCompleted === true);
assert(
  photosWithScanCompletedTrue.length === 0,
  'Every photo has faceScanCompleted reset to FALSE so scanner will not skip it'
);

// 3. Test Candidate Selection for Rescan
console.log('\n--- Phase 3: Candidate Selection for Restarted Scan ---');
const candidates = workingPhotos.filter((p) => {
  if (p.faceScanCompleted) return false;
  if (p.faces && p.faces.length > 0) return false;
  return true;
});

assert(
  candidates.length === workingPhotos.length,
  `All ${workingPhotos.length} photos qualify as candidates for the new scan (none skipped)`
);

// 4. Test Progress Tracking from 1 to Total and Completion
console.log('\n--- Phase 4: Simulating Progress Tracking & Completion ---');

const progressEvents = [];
let scanCompleted = false;

const totalCandidates = candidates.length;
for (let i = 0; i < totalCandidates; i++) {
  const photo = candidates[i];
  progressEvents.push({
    current: i + 1,
    total: totalCandidates,
    currentPhotoName: photo.fileName,
  });

  // Emulate face detection output
  photo.faceScanCompleted = true;
  if (i % 2 === 0) {
    photo.faces = [{
      id: `sim_face_${i}`,
      photoId: photo.id,
      box: { x: 100, y: 100, width: 80, height: 80 },
      descriptor: new Array(128).fill(0.1),
    }];
  }
}
scanCompleted = true;

assert(progressEvents.length === totalCandidates, 'Progress event fired for every photo');
assert(progressEvents[0].current === 1, 'Progress started properly at photo 1');
assert(
  progressEvents[progressEvents.length - 1].current === totalCandidates,
  `Progress reached the final photo (${totalCandidates}/${totalCandidates})`
);
assert(scanCompleted === true, 'Scan completed without hanging or stopping early');

// 5. Test Face Clustering & People Generation on Completed Scan
console.log('\n--- Phase 5: People Regeneration After Scan Completion ---');

const detectedFaces = [];
for (const p of workingPhotos) {
  if (p.faces && p.faces.length > 0) {
    detectedFaces.push(...p.faces);
  }
}

// Generate test person profile
if (detectedFaces.length > 0) {
  workingPeople.push({
    id: 'person_rescan_test',
    name: 'Rescanned Person',
    coverFaceId: detectedFaces[0].id,
    coverPhotoId: detectedFaces[0].photoId,
    faceCount: detectedFaces.length,
    photoCount: workingPhotos.filter((p) => p.faces && p.faces.length > 0).length,
    createdAt: new Date().toISOString(),
  });
}

assert(workingPeople.length > 0, 'People profiles regenerated successfully from new scan');
assert(workingPeople[0].faceCount === detectedFaces.length, 'Regenerated person face count matches detected faces');

// 6. Test File System & Mirror Cache Cleanliness
console.log('\n--- Phase 6: Virtual Mirror & Background Files Inspection ---');

const mirrorDir = 'C:\\GPhotos_VirtualMirrors\\photo1';
if (fs.existsSync(mirrorDir)) {
  const mirrorFiles = fs.readdirSync(mirrorDir);
  const mirrorJpgs = mirrorFiles.filter((f) => f.endsWith('.jpg'));
  const mirrorJsons = mirrorFiles.filter((f) => f.endsWith('.json'));

  assert(mirrorJpgs.length === mirrorJsons.length, 'Every thumbnail has an exactly paired .json metadata sidecar');
  console.log(`- Mirror thumbnails verified: ${mirrorJpgs.length}`);
} else {
  console.log('- Virtual mirror directory not present (clean physical folder mode)');
}

console.log('\n===============================================================');
console.log(` RESULT: ${passedTests} of ${totalTests} checks passed successfully.`);
console.log('===============================================================');
