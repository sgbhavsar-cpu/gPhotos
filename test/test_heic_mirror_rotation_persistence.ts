import fs from 'fs';
import path from 'path';
import os from 'os';
import sharp from 'sharp';

// Isolate heic_rotations.json (and any other test-config-dir-scoped store) from
// this machine's real userData — otherwise rotating the synthetic test photos
// below would write into the real heic_rotations.json / webserver_auth.json.
const testConfigDir = path.join(os.tmpdir(), 'gphotos_heic_rotation_test_' + Date.now());
fs.mkdirSync(testConfigDir, { recursive: true });
process.env.GPHOTOS_TEST_CONFIG_DIR = testConfigDir;

import { rotatePhotoWithOfflineQueue, editPhotoFile } from '../src/main/services/virtualMirrorService';
import { getHeicSavedRotation, resetHeicRotationCacheForTests } from '../src/main/services/heicRotationStore';

console.log('=== STARTING HEIC MIRROR-THUMBNAIL ROTATION PERSISTENCE TESTS ===\n');

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
  const tempDir = path.join(os.tmpdir(), `gphotos_heic_mirror_rot_${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    resetHeicRotationCacheForTests();

    // Simulates a network-mirrored HEIC photo: the LOCAL file is the mirror's
    // always-JPEG thumbnail preview, while originalRemotePath points at the
    // real .heic master on the network share (here just a distinct local
    // path standing in for "somewhere else", since the bug is about path
    // bookkeeping, not actual network I/O or HEIC decoding).
    const localMirrorThumb = path.join(tempDir, 'IMG_0001.jpg');
    const remoteHeicMaster = path.join(tempDir, 'IMG_0001.heic');

    const sourceImgBuf = await sharp({
      create: { width: 100, height: 50, channels: 3, background: { r: 100, g: 150, b: 200 } },
    }).jpeg().toBuffer();
    fs.writeFileSync(localMirrorThumb, sourceImgBuf);
    // The remote master only needs to exist for this test's assertions about
    // the flag store — its bytes are never decoded here.
    fs.writeFileSync(remoteHeicMaster, sourceImgBuf);

    // -------------------------------------------------------------
    // TEST 1: Rotating a mirror-thumbnail HEIC photo (local=.jpg mirror
    // thumbnail distinct from originalRemotePath=.heic master) must record
    // the rotation flag under the REMOTE path, not just the local one.
    // -------------------------------------------------------------
    const res = await rotatePhotoWithOfflineQueue({
      localFilePath: localMirrorThumb,
      originalRemotePath: remoteHeicMaster,
      rotationDegrees: 90,
    });

    assert(res.success === true, 'rotatePhotoWithOfflineQueue succeeded');
    assert(res.heicRotation === 90, `Reported heicRotation is 90 (got ${res.heicRotation})`);

    const localMeta = await sharp(localMirrorThumb).metadata();
    assert(localMeta.width === 50 && localMeta.height === 100, 'Local mirror thumbnail bytes were physically rotated 90°');

    // This is the actual regression: code that displays the photo at full
    // resolution (PhotoLightbox's "preferOriginal") and the catalog-page
    // rotation backfill both look up the saved rotation keyed by
    // originalRemotePath, not the local mirror path.
    const remoteRotation = getHeicSavedRotation(remoteHeicMaster);
    assert(remoteRotation === 90, `getHeicSavedRotation(remote master path) returns 90 (got ${remoteRotation}) — this is what the Lightbox full-res view and catalog backfill look up`);

    const localRotation = getHeicSavedRotation(localMirrorThumb);
    assert(localRotation === 90, `getHeicSavedRotation(local mirror path) also returns 90 (got ${localRotation})`);

    // -------------------------------------------------------------
    // TEST 2: A second rotation accumulates correctly (90 + 90 = 180) under
    // both keys, not just resetting to the latest delta.
    // -------------------------------------------------------------
    const res2 = await rotatePhotoWithOfflineQueue({
      localFilePath: localMirrorThumb,
      originalRemotePath: remoteHeicMaster,
      rotationDegrees: 90,
    });
    assert(res2.heicRotation === 180, `Second +90° rotation accumulates to 180 (got ${res2.heicRotation})`);
    assert(getHeicSavedRotation(remoteHeicMaster) === 180, `Remote-path flag accumulated to 180 (got ${getHeicSavedRotation(remoteHeicMaster)})`);
    assert(getHeicSavedRotation(localMirrorThumb) === 180, `Local-path flag accumulated to 180 (got ${getHeicSavedRotation(localMirrorThumb)})`);

    // -------------------------------------------------------------
    // TEST 3: Real-world edge case observed in an actual synced library —
    // the "mirror thumbnail" is sometimes genuinely raw HEIC bytes copied
    // as-is (HEIC-to-JPEG conversion failed during sync), not an actual
    // JPEG preview, despite sitting at a distinct local mirror path. This
    // must not double-count the rotation delta (rotatePhotoFile's own
    // byte-sniff already delegates to rotateCachedHeicThumbnail, which
    // records the flag itself — the caller must read it back, not add
    // the delta again).
    // -------------------------------------------------------------
    const rawHeicLocal = path.join(tempDir, 'IMG_0002.heic');
    const rawHeicRemote = path.join(tempDir, 'remote', 'IMG_0002.heic');
    fs.mkdirSync(path.dirname(rawHeicRemote), { recursive: true });
    // Minimal bytes that are neither JPEG (0xFFD8) nor WebP (RIFF) — enough
    // for rotatePhotoFile's byte-sniff to treat this as genuine raw HEIC,
    // without needing a fully valid HEIC bitstream for this test's purpose.
    const fakeHeicBytes = Buffer.from([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]);
    fs.writeFileSync(rawHeicLocal, fakeHeicBytes);
    fs.writeFileSync(rawHeicRemote, fakeHeicBytes);

    const res3 = await rotatePhotoWithOfflineQueue({
      localFilePath: rawHeicLocal,
      originalRemotePath: rawHeicRemote,
      rotationDegrees: 90,
    });
    assert(res3.success === true, 'Raw-HEIC-as-mirror-thumbnail rotation succeeded');
    assert(res3.heicRotation === 90, `Reported heicRotation is exactly 90, not double-counted (got ${res3.heicRotation})`);
    assert(getHeicSavedRotation(rawHeicRemote) === 90, `Remote-path flag is 90, not double-counted (got ${getHeicSavedRotation(rawHeicRemote)})`);
    assert(getHeicSavedRotation(rawHeicLocal) === 90, `Local-path flag is 90, not double-counted (got ${getHeicSavedRotation(rawHeicLocal)})`);

    // -------------------------------------------------------------
    // TEST 4: The OTHER rotation path — PhotoLightbox's Edit mode
    // (Rotate buttons + "Save Changes"), which goes through editPhotoFile
    // with a canvas-rendered base64Data, not rotatePhotoWithOfflineQueue.
    // This path never touched heicRotationStore at all before this fix —
    // the local mirror thumbnail got the correct baked-in pixels, but the
    // remote .heic master's rotation lookup stayed at 0, so viewing the
    // photo at full resolution (which reads the untouched remote master)
    // showed it un-rotated again.
    // -------------------------------------------------------------
    const lightboxLocalThumb = path.join(tempDir, 'IMG_0003.jpg');
    const lightboxRemoteHeic = path.join(tempDir, 'IMG_0003.heic');
    const rotatedCanvasBuf = await sharp({
      create: { width: 50, height: 100, channels: 3, background: { r: 10, g: 20, b: 30 } },
    }).jpeg().toBuffer();
    fs.writeFileSync(lightboxLocalThumb, sourceImgBuf);
    fs.writeFileSync(lightboxRemoteHeic, sourceImgBuf);

    const editRes = await editPhotoFile({
      filePath: lightboxLocalThumb,
      originalPath: lightboxRemoteHeic,
      mirrorThumbnailPath: lightboxLocalThumb,
      base64Data: `data:image/jpeg;base64,${rotatedCanvasBuf.toString('base64')}`,
      rotationDegrees: 90,
    });

    assert(editRes.success === true, 'editPhotoFile (Lightbox Edit mode) succeeded for a HEIC-mirror photo');
    assert((editRes.newPhoto as any)?.heicRotation === 90, `editPhotoFile reports heicRotation 90 on the returned photo (got ${(editRes.newPhoto as any)?.heicRotation})`);
    assert(getHeicSavedRotation(lightboxRemoteHeic) === 90, `getHeicSavedRotation(remote master) is 90 after a Lightbox edit (got ${getHeicSavedRotation(lightboxRemoteHeic)}) — this is what full-resolution viewing looks up`);
    assert(getHeicSavedRotation(lightboxLocalThumb) === 90, `getHeicSavedRotation(local mirror) is 90 after a Lightbox edit (got ${getHeicSavedRotation(lightboxLocalThumb)})`);

    const savedLocalBuf = fs.readFileSync(lightboxLocalThumb);
    assert(savedLocalBuf.equals(rotatedCanvasBuf), 'Local mirror thumbnail file bytes were overwritten with the canvas-rendered (rotated) image');
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
    try {
      fs.rmSync(testConfigDir, { recursive: true, force: true });
    } catch {}
  }

  console.log(`\n======================================================`);
  console.log(`TEST SUMMARY: ${passedTests} / ${totalTests} tests passed.`);
  console.log(`======================================================\n`);
}

runTests().catch((err) => {
  console.error('Test execution failed:', err);
  process.exitCode = 1;
});
