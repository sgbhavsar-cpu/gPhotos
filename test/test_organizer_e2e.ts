import assert from 'assert';
import path from 'path';
import fs from 'fs';
import { generateDryRun, executeOrganization } from '../src/main/services/fileOrganizer';
import { OrganizeOptions } from '../src/types';

async function runE2ETest() {
  console.log('=== RUNNING PHYSICAL FILE ORGANIZER E2E TEST ===\n');

  const testRoot = path.join(__dirname, 'temp_e2e_test');
  const sourceDir = path.join(testRoot, 'source');
  const targetDir = path.join(testRoot, 'target');

  // Setup test directory
  if (fs.existsSync(testRoot)) fs.rmSync(testRoot, { recursive: true, force: true });
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.mkdirSync(targetDir, { recursive: true });

  // Create sample image files
  const file1 = path.join(sourceDir, 'IMG_2024_01.jpg');
  const file2 = path.join(sourceDir, 'IMG_2024_02.png');
  const file3 = path.join(sourceDir, 'DUPLICATE.jpg');

  fs.writeFileSync(file1, 'fake jpeg content 1');
  fs.writeFileSync(file2, 'fake png content 2');
  fs.writeFileSync(file3, 'fake jpeg content 1'); // Duplicate content of file1

  console.log('Created test files in source directory.');

  const options: OrganizeOptions = {
    sourceDir,
    targetDir,
    structure: 'YYYY/YYYY-MM',
    mode: 'copy',
    conflictResolution: 'skip',
  };

  // 1. Test Dry Run
  console.log('Running Dry Run analysis...');
  const dryRun = await generateDryRun(options);
  console.log(`Dry run found ${dryRun.totalFiles} files, ${dryRun.targetFolders.length} target folders.`);
  assert.strictEqual(dryRun.totalFiles, 3, 'Should find 3 files');

  // 2. Test Execution
  console.log('Executing Physical Organization in Copy Mode...');
  const result = await executeOrganization(options, (progress) => {
    console.log(`  Progress: ${progress.current}/${progress.total} - ${progress.currentFile}`);
  });

  assert(result.success, 'Organization should succeed');
  assert.strictEqual(result.movedCount, 3, 'Should process 3 files');

  // Verify target directories exist
  const now = new Date();
  const year = now.getFullYear().toString();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const expectedFolder = path.join(targetDir, year, `${year}-${month}`);

  assert(fs.existsSync(expectedFolder), `Target folder ${expectedFolder} should exist`);
  const targetFiles = fs.readdirSync(expectedFolder);
  console.log(`Target folder contains: ${targetFiles.join(', ')}`);
  assert(targetFiles.includes('IMG_2024_01.jpg'), 'Target should have IMG_2024_01.jpg');
  assert(targetFiles.includes('IMG_2024_02.png'), 'Target should have IMG_2024_02.png');

  // Clean up test directories
  fs.rmSync(testRoot, { recursive: true, force: true });
  console.log('\n✓ Physical Date Organizer E2E verification test passed successfully!');
}

runE2ETest().catch((err) => {
  console.error('E2E Test Failed:', err);
  process.exit(1);
});
