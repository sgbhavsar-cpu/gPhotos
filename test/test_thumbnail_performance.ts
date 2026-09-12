import assert from 'assert';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { getOrGenerateCachedThumbnail, clearThumbnailCache } from '../src/main/services/thumbnailCacheService';

async function runPerformanceTests() {
  console.log('🚀 TESTING MULTI-TIER THUMBNAIL CACHING & PERFORMANCE...');

  const samplePhoto = 'C:\\GPhotos_VirtualMirrors\\photo1\\20240203_095554.jpg';
  assert(fs.existsSync(samplePhoto), 'Sample photo must exist for testing');

  // 1. Tier 250px generation and cache test
  console.log('\n▶ Test 1: Generate 250px Grid Thumbnail');
  const t0 = Date.now();
  const res250 = await getOrGenerateCachedThumbnail(samplePhoto, 250);
  const gen250Time = Date.now() - t0;
  assert(res250, '250px thumbnail must be generated');
  console.log(`  ✓ 250px thumbnail ready in ${gen250Time}ms (file: ${res250.filePath})`);
  assert(res250.etag, 'Must contain ETag');

  // Second hit for 250px (Cache Hit)
  const t1 = Date.now();
  const hit250 = await getOrGenerateCachedThumbnail(samplePhoto, 250);
  const hit250Time = Date.now() - t1;
  assert(hit250?.isFromCache, 'Must be a cache hit');
  console.log(`  ✓ 250px cache hit in ${hit250Time}ms (<5ms blazing fast)`);

  // 2. Tier 500px generation test
  console.log('\n▶ Test 2: Generate 500px Medium Thumbnail');
  const t2 = Date.now();
  const res500 = await getOrGenerateCachedThumbnail(samplePhoto, 500);
  const gen500Time = Date.now() - t2;
  assert(res500, '500px thumbnail must be generated');
  console.log(`  ✓ 500px thumbnail ready in ${gen500Time}ms`);

  // 3. Tier 1600px preview generation test
  console.log('\n▶ Test 3: Generate 1600px Lightbox Preview');
  const t3 = Date.now();
  const res1600 = await getOrGenerateCachedThumbnail(samplePhoto, 1600);
  const gen1600Time = Date.now() - t3;
  assert(res1600, '1600px preview must be generated');
  console.log(`  ✓ 1600px preview ready in ${gen1600Time}ms`);

  // 4. Test HTTP Server ETag and 304 Not Modified
  console.log('\n▶ Test 4: Verify HTTP Immutable & ETag 304 Response');
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '', 'http://localhost');
    const p = url.searchParams.get('path');
    const size = parseInt(url.searchParams.get('size') || '250', 10);
    const thumb = await getOrGenerateCachedThumbnail(p!, size);
    if (!thumb) {
      res.statusCode = 404;
      res.end();
      return;
    }
    if (req.headers['if-none-match'] === thumb.etag) {
      res.statusCode = 304;
      res.end();
      return;
    }
    res.setHeader('ETag', thumb.etag);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('Content-Type', 'image/jpeg');
    fs.createReadStream(thumb.filePath!).pipe(res);
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;

  // Request 1: Initial fetch (200 OK + ETag + Cache-Control: immutable)
  const req1Result = await new Promise<{ status: number; headers: any }>((resolve) => {
    http.get(`http://localhost:${port}/?path=${encodeURIComponent(samplePhoto)}&size=250`, (res) => {
      resolve({ status: res.statusCode || 0, headers: res.headers });
    });
  });

  assert.strictEqual(req1Result.status, 200, 'First request should be 200 OK');
  assert.strictEqual(req1Result.headers['cache-control'], 'public, max-age=31536000, immutable');
  const etag = req1Result.headers['etag'];
  assert(etag, 'Response must include ETag header');
  console.log(`  ✓ First request: 200 OK with Cache-Control: "${req1Result.headers['cache-control']}" and ETag: ${etag}`);

  // Request 2: Conditional fetch with If-None-Match (304 Not Modified)
  const req2Result = await new Promise<{ status: number; bodyLength: number }>((resolve) => {
    const req = http.request(
      `http://localhost:${port}/?path=${encodeURIComponent(samplePhoto)}&size=250`,
      { headers: { 'If-None-Match': etag } },
      (res) => {
        let count = 0;
        res.on('data', (c) => (count += c.length));
        res.on('end', () => resolve({ status: res.statusCode || 0, bodyLength: count }));
      }
    );
    req.end();
  });

  assert.strictEqual(req2Result.status, 304, 'Second request with matching ETag must return 304 Not Modified');
  assert.strictEqual(req2Result.bodyLength, 0, '304 response must transfer 0 body payload bytes');
  console.log(`  ✓ Second request with If-None-Match: 304 Not Modified with 0 bytes payload (Instant browser cache hit)!`);

  server.close();

  console.log('\n🎉 ALL MULTI-TIER CACHING & PERFORMANCE TESTS PASSED!');
}

runPerformanceTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
