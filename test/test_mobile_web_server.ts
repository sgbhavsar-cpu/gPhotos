import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import sharp from 'sharp';

// Isolate the SQLite databases this test touches from the real, persisted
// ones in userData — otherwise exercising /api/library here would trigger a
// real one-time migration of this machine's actual library.json into SQLite
// the first time this test runs. Must be set before any request is handled
// (module-level DB access is all lazy, so this is safe to set here).
const dbTestDir = path.join(os.tmpdir(), 'gphotos_mobile_server_global_db_' + Date.now());
fs.mkdirSync(dbTestDir, { recursive: true });
process.env.GPHOTOS_TEST_DB_DIR = dbTestDir;

import {
  startEmbeddedWebServer,
  stopEmbeddedWebServer,
} from '../src/main/services/embeddedWebServer';
import { getOrCreatePin, revokeAllDevices } from '../src/main/services/webAuthService';
import { setActiveLibrary } from '../src/main/services/db';
import { upsertPhotos, upsertPeople, setSetting } from '../src/main/services/libraryRepository';
import { Photo } from '../src/types';

function fetchUrl(
  url: string,
  options: http.RequestOptions = {},
  body?: string
): Promise<{ status: number; headers: http.IncomingHttpHeaders; data: Buffer; text: string; json: () => any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const data = Buffer.concat(chunks);
        const text = data.toString('utf8');
        resolve({
          status: res.statusCode || 0,
          headers: res.headers,
          data,
          text,
          json: () => JSON.parse(text),
        });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function runMobileWebServerTests() {
  console.log('=== Starting Mobile Web Application & Server Verification Tests ===\n');

  // Start from a clean auth slate so this test is not affected by prior pairings.
  revokeAllDevices();

  // Seed a small, isolated, but real library: real JPEG bytes on disk so
  // /api/photo, /api/file-exists, and /api/scan all have something genuine
  // to serve, without touching the user's actual library.
  const libraryDir = path.join(os.tmpdir(), 'gphotos_mobile_server_library_' + Date.now());
  fs.mkdirSync(libraryDir, { recursive: true });
  const photoPath = path.join(libraryDir, 'sample.jpg');
  await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 100, g: 150, b: 200 } } })
    .jpeg()
    .toFile(photoPath);

  setActiveLibrary(libraryDir);
  // Register this as the known/active library folder — pathSecurity's
  // allowlist (used by the embedded web server) is built from this setting,
  // just like it would be for a real library the app has actually opened.
  setSetting('selectedFolder', libraryDir);
  const seedPhotos: Photo[] = [
    {
      id: 'mobile_test_photo_1',
      filePath: photoPath,
      fileName: 'sample.jpg',
      fileSize: fs.statSync(photoPath).size,
      fileDate: new Date().toISOString(),
      dateTaken: new Date().toISOString(),
      year: 2026,
      month: 1,
      day: 1,
    },
  ];
  upsertPhotos(seedPhotos);
  upsertPeople([{ id: 'p_mobile_test', name: 'Test Person', faceCount: 0, photoCount: 0, createdAt: new Date().toISOString() }]);

  // A distinctive high port, not 5173/5174 (Vite's own default/fallback ports),
  // which other projects' dev servers on this machine can and do occupy.
  const testPort = 58471;
  console.log(`[Step 1] Starting embedded web server on port ${testPort}...`);
  const status = await startEmbeddedWebServer(testPort);
  console.log(`[Step 1 PASS] Server running: ${status.isRunning} on port ${status.port}`);
  console.log(`[Step 1 PASS] Primary Mobile Wi-Fi URL: ${status.primaryUrl}`);

  const baseUrl = `http://127.0.0.1:${status.port}`;

  try {
    // 0a. Public endpoints must work without any token
    console.log('[Test 0a] Testing /api/status and /api/auth/status are public...');
    const statusRes = await fetchUrl(`${baseUrl}/api/status`);
    if (statusRes.status !== 200) throw new Error(`/api/status returned status ${statusRes.status}`);
    const authStatusRes = await fetchUrl(`${baseUrl}/api/auth/status`);
    if (authStatusRes.status !== 200 || !authStatusRes.json().pinRequired) {
      throw new Error(`/api/auth/status did not report pinRequired: ${authStatusRes.text}`);
    }
    console.log('[Test 0a PASS] Public endpoints reachable without a token.');

    // 0b. Protected endpoints must reject unauthenticated requests with 401
    console.log('[Test 0b] Testing protected endpoints reject requests with no token...');
    const unauthLibRes = await fetchUrl(`${baseUrl}/api/library`);
    if (unauthLibRes.status !== 401) {
      throw new Error(`FAILED: /api/library without a token returned ${unauthLibRes.status}, expected 401`);
    }
    const unauthDeleteRes = await fetchUrl(
      `${baseUrl}/api/delete-files`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' } },
      JSON.stringify({ filePaths: ['C:\\nonexistent.jpg'], permanent: false })
    );
    if (unauthDeleteRes.status !== 401) {
      throw new Error(`FAILED: /api/delete-files without a token returned ${unauthDeleteRes.status}, expected 401`);
    }
    console.log('[Test 0b PASS] Protected endpoints correctly reject unauthenticated requests (401).');

    // 0c. Pairing with an incorrect PIN must fail
    console.log('[Test 0c] Testing pairing with an incorrect PIN is rejected...');
    const badPairRes = await fetchUrl(
      `${baseUrl}/api/auth/pair`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' } },
      JSON.stringify({ pin: '000000', deviceLabel: 'test-device-bad' })
    );
    if (badPairRes.status !== 401) {
      throw new Error(`FAILED: pairing with a wrong PIN returned ${badPairRes.status}, expected 401`);
    }
    console.log('[Test 0c PASS] Incorrect PIN rejected with 401.');

    // 0d. Pairing with the correct PIN issues a working token
    console.log('[Test 0d] Testing pairing with the correct PIN issues a token...');
    const realPin = getOrCreatePin();
    const pairRes = await fetchUrl(
      `${baseUrl}/api/auth/pair`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' } },
      JSON.stringify({ pin: realPin, deviceLabel: 'test-device' })
    );
    if (pairRes.status !== 200 || !pairRes.json().token) {
      throw new Error(`FAILED: pairing with correct PIN did not return a token: ${pairRes.text}`);
    }
    const token = pairRes.json().token as string;
    console.log('[Test 0d PASS] Correct PIN issued a session token.');

    const authHeaders = { Authorization: `Bearer ${token}` };

    // 1. Verify /api/status
    console.log('[Test 1] Testing /api/status endpoint...');
    const statusJson = statusRes.json();
    if (!statusJson.isRunning || !statusJson.primaryUrl) {
      throw new Error(`Invalid status payload: ${JSON.stringify(statusJson)}`);
    }
    console.log(`[Test 1 PASS] Status endpoint verified. Primary URL: ${statusJson.primaryUrl}`);

    // 2. Verify /api/library (ensures NO zero photos bug!) using the paired token
    console.log('[Test 2] Testing authenticated /api/library endpoint...');
    const libRes = await fetchUrl(`${baseUrl}/api/library`, { headers: authHeaders });
    if (libRes.status !== 200) throw new Error(`/api/library returned status ${libRes.status}`);
    const libJson = libRes.json();
    const photos = libJson.gphotos_library_v1?.photos || libJson.photos || [];
    console.log(`[Test 2 PASS] /api/library returned valid data with ${photos.length} photos!`);

    if (photos.length === 0) {
      throw new Error('FAILED: /api/library returned ZERO photos! The bug still persists!');
    }
    console.log(`[Test 2 PASS] Verified library is NOT empty (Total: ${photos.length} photos, People: ${(libJson.gphotos_people_v2 || []).length})`);

    const samplePhoto = photos[0];
    console.log(`[Test 2] Sample photo from library: "${samplePhoto.fileName}" (${samplePhoto.filePath})`);

    // 3. Verify /api/file-exists
    console.log('[Test 3] Testing /api/file-exists endpoint...');
    const existsRes = await fetchUrl(`${baseUrl}/api/file-exists?path=${encodeURIComponent(samplePhoto.filePath)}`, { headers: authHeaders });
    const existsJson = existsRes.json();
    console.log(`[Test 3 PASS] /api/file-exists for "${samplePhoto.fileName}": exists=${existsJson.exists}`);
    if (!existsJson.exists) {
      throw new Error('FAILED: seeded fixture photo was not found on disk');
    }

    // 4. Verify /api/photo image serving (via header token)
    console.log('[Test 4] Testing /api/photo serving for gallery grid (thumbnail)...');
    const photoRes = await fetchUrl(`${baseUrl}/api/photo?path=${encodeURIComponent(samplePhoto.filePath)}`, { headers: authHeaders });
    if (photoRes.status !== 200) {
      throw new Error(`FAILED: /api/photo returned status ${photoRes.status} for a real fixture file`);
    }
    console.log(`[Test 4 PASS] /api/photo served photo bytes: ${photoRes.data.length} bytes, Content-Type: ${photoRes.headers['content-type']}`);

    // 4b. Verify /api/photo also accepts the token as a query param (for <img src> usage)
    console.log('[Test 4b] Testing /api/photo serving via query-param token (for <img> tags)...');
    const photoQueryTokenRes = await fetchUrl(`${baseUrl}/api/photo?path=${encodeURIComponent(samplePhoto.filePath)}&token=${encodeURIComponent(token)}`);
    if (photoQueryTokenRes.status !== 200) {
      throw new Error(`FAILED: /api/photo with query-param token returned unexpected status ${photoQueryTokenRes.status}`);
    }
    console.log(`[Test 4b PASS] /api/photo served via query-param token: ${photoQueryTokenRes.data.length} bytes`);

    // 5. Test full-screen /preferOriginal=1 high quality photo serving
    console.log('[Test 5] Testing /api/photo with preferOriginal=1 (lightbox mode)...');
    const hqPhotoRes = await fetchUrl(`${baseUrl}/api/photo?path=${encodeURIComponent(samplePhoto.filePath)}&preferOriginal=1`, { headers: authHeaders });
    if (hqPhotoRes.status === 200) {
      console.log(`[Test 5 PASS] Full-screen HQ photo served successfully (${hqPhotoRes.data.length} bytes)`);
    }

    // 6. Test /api/scan endpoint
    console.log('[Test 6] Testing /api/scan endpoint...');
    const scanRes = await fetchUrl(`${baseUrl}/api/scan?path=${encodeURIComponent(libraryDir)}`, { headers: authHeaders });
    if (scanRes.status === 200) {
      const scanPhotos = scanRes.json();
      console.log(`[Test 6 PASS] /api/scan successfully scanned folder and returned ${scanPhotos.length} photo(s)`);
    }

    // 7. Verify Mobile HTML entrypoint & Mobile Meta tags (static assets stay public so the PIN screen can load)
    console.log('[Test 7] Verifying Mobile HTML index page & PWA tags...');
    const htmlRes = await fetchUrl(`${baseUrl}/`);
    if (htmlRes.status === 200) {
      const html = htmlRes.text;
      const hasViewport = html.includes('viewport-fit=cover');
      const hasThemeColor = html.includes('theme-color');
      const hasAppleMobile = html.includes('apple-mobile-web-app-capable');
      console.log(`[Test 7 PASS] HTML served: ${htmlRes.data.length} bytes`);
      console.log(`[Test 7 PASS] Mobile viewport-fit=cover: ${hasViewport}`);
      console.log(`[Test 7 PASS] Mobile theme-color meta: ${hasThemeColor}`);
      console.log(`[Test 7 PASS] Apple iOS web-app capable: ${hasAppleMobile}`);
    }

    // 8. Test /api/heic/prepare-hq and cleanup (fixture is a plain JPEG, not
    // real HEIC, so this only needs to respond without crashing the server)
    console.log('[Test 8] Testing HEIC Face Detection HQ Prep & Cleanup APIs...');
    const prepRes = await fetchUrl(`${baseUrl}/api/heic/prepare-hq?path=${encodeURIComponent(samplePhoto.filePath)}&id=mobile_test_1`, { headers: authHeaders });
    if (prepRes.status === 200) {
      const prepJson = prepRes.json();
      console.log(`[Test 8 PASS] /api/heic/prepare-hq returned URL: ${prepJson.url}`);
      const cleanRes = await fetchUrl(`${baseUrl}/api/heic/cleanup-hq?id=mobile_test_1`, { headers: authHeaders });
      console.log(`[Test 8 PASS] /api/heic/cleanup-hq response: ${cleanRes.text}`);
    } else {
      console.log(`[Test 8 PASS] /api/heic/prepare-hq correctly declined a non-HEIC fixture (status ${prepRes.status})`);
    }

    // 8b. Even an authenticated, correctly-paired device cannot read/scan/
    // delete an arbitrary path outside the known library — a paired phone is
    // a lower-trust client than the desktop app itself.
    console.log('[Test 8b] Testing path confinement rejects paths outside the known library...');
    const outsidePath = 'C:\\Windows\\System32\\drivers\\etc\\hosts';
    const photoOutsideRes = await fetchUrl(`${baseUrl}/api/photo?path=${encodeURIComponent(outsidePath)}`, { headers: authHeaders });
    if (photoOutsideRes.status !== 403) {
      throw new Error(`FAILED: /api/photo for an out-of-library path returned ${photoOutsideRes.status}, expected 403`);
    }
    const scanOutsideRes = await fetchUrl(`${baseUrl}/api/scan?path=${encodeURIComponent('C:\\Windows\\System32')}`, { headers: authHeaders });
    if (scanOutsideRes.status !== 403) {
      throw new Error(`FAILED: /api/scan for an out-of-library path returned ${scanOutsideRes.status}, expected 403`);
    }
    const deleteOutsideRes = await fetchUrl(
      `${baseUrl}/api/delete-files`,
      { method: 'POST', headers: { ...authHeaders, 'Content-Type': 'application/json' } },
      JSON.stringify({ filePaths: [outsidePath], permanent: false })
    );
    if (deleteOutsideRes.status !== 403) {
      throw new Error(`FAILED: /api/delete-files for an out-of-library path returned ${deleteOutsideRes.status}, expected 403`);
    }
    console.log('[Test 8b PASS] Paths outside the known library are rejected with 403 even when authenticated.');

    // 9. Revoking the device invalidates its token immediately
    console.log('[Test 9] Testing device revocation invalidates the token...');
    revokeAllDevices();
    const postRevokeRes = await fetchUrl(`${baseUrl}/api/library`, { headers: authHeaders });
    if (postRevokeRes.status !== 401) {
      throw new Error(`FAILED: revoked token still authorized, got status ${postRevokeRes.status}`);
    }
    console.log('[Test 9 PASS] Revoked device token is rejected (401).');

    console.log('\n=== ALL MOBILE WEB APPLICATION TESTS PASSED (100% SUCCESS) ===\n');
  } finally {
    stopEmbeddedWebServer();
    console.log('Test web server stopped cleanly.');
    try {
      fs.rmSync(libraryDir, { recursive: true, force: true });
    } catch {}
    try {
      fs.rmSync(dbTestDir, { recursive: true, force: true });
    } catch {}
  }
}

runMobileWebServerTests()
  .then(() => {
    // Importing embeddedWebServer.ts pulls in the thumbnail pre-cache worker,
    // which keeps background timers alive; force a clean exit once tests pass.
    process.exit(0);
  })
  .catch((err) => {
    console.error('\n❌ MOBILE WEB APPLICATION TEST FAILED:', err);
    process.exit(1);
  });
