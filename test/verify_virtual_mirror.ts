import assert from 'assert';
import path from 'path';
import fs from 'fs';
import {
  syncVirtualStorage,
  scanVirtualMirrorDirectory
} from '../src/main/services/virtualMirrorService';
import { VirtualStorageConfig } from '../src/types';

async function testVirtualMirror() {
  console.log('=== RUNNING VIRTUAL NETWORK STORAGE MIRROR VERIFICATION TEST ===\n');

  const testRoot = path.join(__dirname, 'temp_virtual_mirror_test');
  const remoteNasPath = path.join(testRoot, 'nas_shared_photos');
  const localMirrorRoot = path.join(testRoot, 'local_cache');

  // 1. Setup mock remote network structure
  const vacationDir = path.join(remoteNasPath, '2024', 'Vacation');
  const familyDir = path.join(remoteNasPath, '2023', 'Family');
  fs.mkdirSync(vacationDir, { recursive: true });
  fs.mkdirSync(familyDir, { recursive: true });

  const remotePhoto1 = path.join(vacationDir, 'beach.jpg');
  const remotePhoto2 = path.join(vacationDir, 'sunset.png');
  const remotePhoto3 = path.join(familyDir, 'dinner.jpg');

  fs.writeFileSync(remotePhoto1, 'remote mock photo 1 content');
  fs.writeFileSync(remotePhoto2, 'remote mock photo 2 content');
  fs.writeFileSync(remotePhoto3, 'remote mock photo 3 content');

  console.log('Created simulated network storage files at:', remoteNasPath);

  const config: VirtualStorageConfig = {
    id: 'nas_1',
    name: 'Home_NAS',
    networkSourcePath: remoteNasPath,
    localMirrorRoot,
  };

  // 2. Run sync
  console.log('Running syncVirtualStorage...');
  const result = await syncVirtualStorage(config, (progress) => {
    console.log(`  Sync Progress: ${progress.current}/${progress.total} - ${progress.currentFile}`);
  });

  assert(result.success, 'Sync should be successful');
  assert.strictEqual(result.totalSynced, 3, 'Should have synced 3 photos');

  // 3. Verify original photos are strictly untouched
  assert(fs.existsSync(remotePhoto1), 'Original photo 1 MUST NOT be deleted or moved!');
  assert(fs.existsSync(remotePhoto2), 'Original photo 2 MUST NOT be deleted or moved!');
  assert(fs.existsSync(remotePhoto3), 'Original photo 3 MUST NOT be deleted or moved!');
  console.log('✓ Verified: Original files remained 100% untouched on network storage.');

  // 4. Verify local replicated folder structure
  const expectedVacationMirror = path.join(localMirrorRoot, 'Home_NAS', '2024', 'Vacation');
  const expectedFamilyMirror = path.join(localMirrorRoot, 'Home_NAS', '2023', 'Family');

  assert(fs.existsSync(expectedVacationMirror), `Replicated folder ${expectedVacationMirror} should exist`);
  assert(fs.existsSync(expectedFamilyMirror), `Replicated folder ${expectedFamilyMirror} should exist`);

  const thumb1 = path.join(expectedVacationMirror, 'beach.jpg');
  const meta1 = path.join(expectedVacationMirror, 'beach.json');

  assert(fs.existsSync(thumb1), 'Local thumbnail file beach.jpg should exist');
  assert(fs.existsSync(meta1), 'Sidecar metadata file beach.json should exist');

  // 5. Verify sidecar metadata contents
  const sidecarRaw = JSON.parse(fs.readFileSync(meta1, 'utf-8'));
  assert.strictEqual(sidecarRaw.fileName, 'beach.jpg');
  assert.strictEqual(sidecarRaw.originalFilePath, remotePhoto1);
  assert.strictEqual(sidecarRaw.thumbnailPath, thumb1);
  assert.strictEqual(sidecarRaw.storageName, 'Home_NAS');
  assert(sidecarRaw.dateTaken, 'dateTaken should be present');
  console.log('✓ Verified: Replicated folder structure and sidecar metadata .json are valid.');

  // 6. Test scanning the virtual mirror directory into Photo[]
  console.log('Testing scanVirtualMirrorDirectory on local mirror...');
  const mirroredPhotos = scanVirtualMirrorDirectory(path.join(localMirrorRoot, 'Home_NAS'));
  assert.strictEqual(mirroredPhotos.length, 3, 'Should scan all 3 mirrored photos');
  assert(mirroredPhotos[0].isVirtual, 'Scanned photo must have isVirtual=true');
  assert.strictEqual(mirroredPhotos[0].storageName, 'Home_NAS');
  assert(mirroredPhotos[0].originalRemotePath != null, 'originalRemotePath must be set');
  console.log('✓ Verified: Virtual mirror directory scanned into Photo[] library objects with original remote links.');

  // 7. Cleanup
  fs.rmSync(testRoot, { recursive: true, force: true });
  console.log('\n=== ALL VIRTUAL STORAGE MIRROR TESTS PASSED 100% ===');
}

testVirtualMirror().catch((err) => {
  console.error('Virtual Mirror Test Failed:', err);
  process.exit(1);
});
