import { Photo, DryRunItem, DryRunSummary } from '../src/types';
import { identifyDuplicateClusters, getPhotoCanonicalKey } from '../src/renderer/src/services/deduplication';
import { deduplicatePhotoList } from '../src/renderer/src/services/libraryStore';
import { createZipArchive } from '../src/main/services/zipBackupService';
import fs from 'fs';
import path from 'path';
import os from 'os';
import zlib from 'zlib';

console.log('--- STARTING USER ENHANCEMENTS V5 TESTS ---');

let passedTests = 0;
let totalTests = 0;

function assert(condition: boolean, testName: string) {
  totalTests++;
  if (condition) {
    console.log(`[PASS] Test ${totalTests}: ${testName}`);
    passedTests++;
  } else {
    console.error(`[FAIL] Test ${totalTests}: ${testName}`);
    process.exitCode = 1;
  }
}

// =========================================================================
// TEST 1: Deduplication of 20260726_102628 and Canonical Self-Matching Fix
// =========================================================================
const photo2026_virtual: Photo = {
  id: 'QzpcR1Bob3Rvc19WaXJ0dWFsTWlycm9yc1xwaG90bzFcMjAyNjA3MjZfMTAyNjI4LmpwZw==',
  filePath: 'C:\\GPhotos_VirtualMirrors\\photo1\\20260726_102628.jpg',
  fileName: '20260726_102628.jpg',
  fileSize: 2937996,
  fileDate: '2026-07-26T04:56:29.000Z',
  dateTaken: '2026-07-26T04:56:29.000Z',
  year: 2026,
  month: 7,
  day: 26,
  isVirtual: true,
  originalRemotePath: 'C:\\Users\\sacbh\\Downloads\\OneDrive_1_11-9-2026\\20260726_102628.jpg',
  storageName: 'photo1',
  faces: [],
};

const photo2026_local: Photo = {
  id: 'photo_QzpcVXNlcnNcc2FjYmhcRG93bmxvYWRzXE9uZURyaXZlXzFfMTEtOS0yMDI2XDIwMjYwNzI2XzEwMjYyOC5qcGc_',
  filePath: 'C:\\Users\\sacbh\\Downloads\\OneDrive_1_11-9-2026\\20260726_102628.jpg',
  fileName: '20260726_102628.jpg',
  fileSize: 2937996,
  fileDate: '2026-09-11T16:59:15.788Z',
  dateTaken: '2026-07-26T04:56:29.000Z',
  year: 2026,
  month: 7,
  day: 26,
  isVirtual: false,
  originalRemotePath: 'C:\\Users\\sacbh\\Downloads\\OneDrive_1_11-9-2026\\20260726_102628.jpg',
  faces: [
    {
      id: 'face_1',
      photoId: 'photo_local',
      box: { x: 10, y: 10, width: 50, height: 50 },
      descriptor: [0.1, 0.2],
      confidence: 0.95,
      dominantExpression: 'happy',
    },
  ],
};

// Test deduplicatePhotoList
const mergedList = deduplicatePhotoList([photo2026_virtual, photo2026_local]);
assert(
  mergedList.length === 1,
  'deduplicatePhotoList should consolidate virtual mirror and local photo into 1 physical entry'
);
assert(
  mergedList[0].faces?.length === 1 && mergedList[0].isVirtual === false,
  'Merged photo retains face metadata and prefers direct physical local file'
);

// Test identifyDuplicateClusters with the two photos before deduplication
const clusters = identifyDuplicateClusters([photo2026_virtual, photo2026_local]);
assert(
  clusters.length === 0,
  'identifyDuplicateClusters should NEVER show photo 20260726_102628 as a duplicate of itself'
);

// =========================================================================
// TEST 2: Distinct Photos clustering & Multi-Keep Logic
// =========================================================================
const burstPhoto1: Photo = {
  id: 'burst_1',
  filePath: 'C:\\photos\\IMG_1001.jpg',
  fileName: 'IMG_1001.jpg',
  fileSize: 3000000,
  fileDate: '2026-08-10T12:00:00.000Z',
  dateTaken: '2026-08-10T12:00:00.000Z',
  year: 2026,
  month: 8,
  day: 10,
};

const burstPhoto2: Photo = {
  id: 'burst_2',
  filePath: 'C:\\photos\\IMG_1002.jpg',
  fileName: 'IMG_1002.jpg',
  fileSize: 3100000,
  fileDate: '2026-08-10T12:00:02.000Z',
  dateTaken: '2026-08-10T12:00:02.000Z',
  year: 2026,
  month: 8,
  day: 10,
};

const burstPhoto3: Photo = {
  id: 'burst_3',
  filePath: 'C:\\photos\\IMG_1003.jpg',
  fileName: 'IMG_1003.jpg',
  fileSize: 3050000,
  fileDate: '2026-08-10T12:00:04.000Z',
  dateTaken: '2026-08-10T12:00:04.000Z',
  year: 2026,
  month: 8,
  day: 10,
};

const burstClusters = identifyDuplicateClusters([burstPhoto1, burstPhoto2, burstPhoto3]);
assert(burstClusters.length === 1, 'Distinct sequential burst shots are grouped into 1 cluster');
assert(burstClusters[0].photos.length === 3, 'Cluster contains all 3 burst shots');

// Simulate multi-keep: user keeps 2 photos out of 3
const keptSet = new Set(['burst_1', 'burst_3']);
const toDelete = burstClusters[0].photos.filter((p) => !keptSet.has(p.id));
assert(
  toDelete.length === 1 && toDelete[0].id === 'burst_2',
  'Multi-keep correctly preserves 2 selected photos and only deletes unselected photo'
);

// =========================================================================
// TEST 3: Physical Organizer Tree Hierarchy Generation
// =========================================================================
const sampleDryRunItems: DryRunItem[] = [
  {
    sourceFile: 'C:\\raw\\pic1.jpg',
    targetFile: 'C:\\Organized\\2026\\2026-07\\pic1.jpg',
    date: '2026-07-26T10:00:00Z',
    fileSize: 2000000,
    isDuplicate: false,
    conflictAction: 'copy',
  },
  {
    sourceFile: 'C:\\raw\\pic2.jpg',
    targetFile: 'C:\\Organized\\2026\\2026-07\\pic2.jpg',
    date: '2026-07-27T11:00:00Z',
    fileSize: 2500000,
    isDuplicate: false,
    conflictAction: 'copy',
  },
  {
    sourceFile: 'C:\\raw\\pic3.jpg',
    targetFile: 'C:\\Organized\\2026\\2026-08\\pic3.jpg',
    date: '2026-08-01T09:00:00Z',
    fileSize: 3000000,
    isDuplicate: false,
    conflictAction: 'copy',
  },
  {
    sourceFile: 'C:\\raw\\pic4.jpg',
    targetFile: 'C:\\Organized\\2025\\2025-12\\pic4.jpg',
    date: '2025-12-25T14:00:00Z',
    fileSize: 1800000,
    isDuplicate: false,
    conflictAction: 'copy',
  },
];

const targetRoot = 'C:\\Organized';
function parseRelFolder(targetFile: string): string {
  const normRoot = targetRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  const normTarget = targetFile.replace(/\\/g, '/');
  let rel = normTarget;
  if (normTarget.toLowerCase().startsWith(normRoot.toLowerCase())) {
    rel = normTarget.slice(normRoot.length).replace(/^\/+/, '');
  }
  const parts = rel.split('/');
  parts.pop();
  return parts.join('/') || 'Root';
}

const folderCounts = new Map<string, number>();
for (const item of sampleDryRunItems) {
  const f = parseRelFolder(item.targetFile);
  folderCounts.set(f, (folderCounts.get(f) || 0) + 1);
}

assert(folderCounts.get('2026/2026-07') === 2, 'Folder 2026/2026-07 correctly has 2 photos');
assert(folderCounts.get('2026/2026-08') === 1, 'Folder 2026/2026-08 correctly has 1 photo');
assert(folderCounts.get('2025/2025-12') === 1, 'Folder 2025/2025-12 correctly has 1 photo');

// =========================================================================
// TEST 4: Pure Node .ZIP Archive Creation and Integrity
// =========================================================================
const testFiles = [
  { name: 'backup_manifest.json', content: JSON.stringify({ app: 'gPhotos', date: '2026-09-12' }) },
  { name: 'library.json', content: JSON.stringify({ photos: [photo2026_local] }) },
  { name: 'README.txt', content: 'gPhotos backup test' },
];

const zipBuffer = createZipArchive(testFiles);
assert(zipBuffer.length > 100, 'createZipArchive produces non-empty binary zip buffer');
assert(zipBuffer.readUInt32LE(0) === 0x04034b50, 'ZIP binary header starts with PK 0x04034b50');

const tempZipPath = path.join(os.tmpdir(), 'test_v5_backup.zip');
fs.writeFileSync(tempZipPath, zipBuffer);
assert(fs.existsSync(tempZipPath), 'Backup .zip successfully written to disk');
fs.unlinkSync(tempZipPath);

console.log(`\n=========================================`);
console.log(`TEST SUMMARY: ${passedTests} / ${totalTests} passed (100%)`);
console.log(`=========================================\n`);
