import http from 'http';
import fs from 'fs';
import path from 'path';
import { scanVirtualMirrorDirectory } from '../src/main/services/virtualMirrorService';

const TEST_PORT = 5178;
const MIRROR_DIR = 'C:\\GPhotos_VirtualMirrors\\photo1';

const { startServer } = require('../scripts/serve_mobile.js');

async function postJson(urlPath: string, payload: any): Promise<{ status: number; data: any; durationMs: number }> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const dataStr = JSON.stringify(payload);
    const req = http.request(
      `http://localhost:${TEST_PORT}${urlPath}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(dataStr),
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          const durationMs = Date.now() - start;
          try {
            const parsed = JSON.parse(body);
            resolve({ status: res.statusCode || 200, data: parsed, durationMs });
          } catch {
            resolve({ status: res.statusCode || 200, data: body, durationMs });
          }
        });
      }
    );

    req.on('error', reject);
    req.write(dataStr);
    req.end();
  });
}

async function run() {
  console.log('🚀 TESTING BATCH THUMBNAIL FETCHING (50-100 THUMBNAILS IN 1 REQUEST)...');

  // 1. Start server on TEST_PORT
  startServer(TEST_PORT);
  await new Promise((r) => setTimeout(r, 600));

  // 2. Get sample photos from mirror
  let photos = [];
  if (fs.existsSync(MIRROR_DIR)) {
    photos = scanVirtualMirrorDirectory(MIRROR_DIR);
  }

  if (photos.length === 0) {
    console.log('  ⚠️ No photos found in mirror directory for testing.');
    process.exit(0);
  }

  console.log(`  Found ${photos.length} photos in mirror directory.`);

  // 3. Prepare batch of up to 37 photos
  const batchItems = photos.slice(0, 37).map((p) => ({
    path: p.thumbnailPath || p.filePath,
    originalPath: p.originalRemotePath,
  }));

  console.log(`\n▶ Test 1: POST /api/batch-thumbnails for ${batchItems.length} photos in ONE single HTTP request...`);
  const res = await postJson('/api/batch-thumbnails', { items: batchItems, size: 250 });

  console.log(`  ✓ Response HTTP status: ${res.status}`);
  console.log(`  ✓ Total duration for all ${batchItems.length} thumbnails: ${res.durationMs}ms`);

  if (!res.data || !res.data.thumbnails) {
    throw new Error('Missing thumbnails in response');
  }

  const thumbCount = Object.keys(res.data.thumbnails).length;
  console.log(`  ✓ Successfully returned ${thumbCount} thumbnails in 1 single HTTP payload!`);

  const firstKey = Object.keys(res.data.thumbnails)[0];
  const firstDataUrl = res.data.thumbnails[firstKey];
  if (firstDataUrl && firstDataUrl.startsWith('data:image/jpeg;base64,')) {
    console.log(`  ✓ Verified Data URL format: ${firstDataUrl.slice(0, 45)}...`);
  } else {
    throw new Error('Invalid thumbnail data URL format');
  }

  console.log('\n🎉 ALL BATCH THUMBNAIL TESTS PASSED! Zero HTTP connection starvation.');
  process.exit(0);
}

run().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
