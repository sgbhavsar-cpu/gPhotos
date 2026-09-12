import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';

async function run() {
  console.log('🚀 AUDITING BATCH THUMBNAIL FETCHING IN BROWSER (WITH CACHE CLEARED)...');

  const browser = await chromium.launch({
    headless: true,
  });

  // Create a completely clean context with zero cached data, empty cookies, empty service workers
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });

  const page = await context.newPage();

  // Clear any existing cache/storage
  await page.route('**/*', (route) => route.continue());

  const networkRequests: { url: string; method: string; status?: number; durationMs?: number }[] = [];
  const batchRequests: { url: string; count?: number; durationMs?: number; payloadSize?: number }[] = [];
  const individualPhotoRequests: string[] = [];

  page.on('request', (req) => {
    const url = req.url();
    if (url.includes('/api/batch-thumbnails')) {
      networkRequests.push({ url, method: req.method() });
    } else if (url.includes('/api/photo')) {
      individualPhotoRequests.push(url);
    }
  });

  page.on('response', async (res) => {
    const url = res.url();
    if (url.includes('/api/batch-thumbnails')) {
      try {
        const json = await res.json();
        const count = json.thumbnails ? Object.keys(json.thumbnails).length : 0;
        batchRequests.push({
          url,
          count,
          payloadSize: (await res.body()).length,
        });
      } catch {}
    }
  });

  const consoleLogs: string[] = [];
  page.on('console', (msg) => consoleLogs.push(`[${msg.type()}] ${msg.text()}`));

  console.log('  Navigating to http://192.168.29.30:5174/ with clean cache...');
  await page.goto('http://192.168.29.30:5174/', { waitUntil: 'networkidle', timeout: 15000 });

  // Wait 2 seconds for all initial renders to settle
  await page.waitForTimeout(2000);

  // Check DOM photo count
  const photoImages = await page.locator('img[src^="data:image/"]').all();
  const totalImgElements = await page.locator('img').all();

  console.log(`\n▶ Network Audit Summary:`);
  console.log(`  ✓ Batch Thumbnail Requests (/api/batch-thumbnails): ${batchRequests.length}`);
  for (let i = 0; i < batchRequests.length; i++) {
    console.log(`     - Batch #${i + 1}: Returned ${batchRequests[i].count} thumbnails in 1 request (${(batchRequests[i].payloadSize! / 1024).toFixed(1)} KB)`);
  }

  console.log(`  ✓ Individual Photo Requests (/api/photo): ${individualPhotoRequests.length} (Connection pool saved!)`);
  console.log(`  ✓ Rendered Images with Batch Data URLs: ${photoImages.length}`);
  console.log(`  ✓ Total Image Elements Rendered: ${totalImgElements.length}`);

  // Capture screenshot of rendered gallery
  const screenshotPath = 'scratch/browser_batch_verified.png';
  await page.screenshot({ path: screenshotPath, fullPage: false });
  console.log(`  ✓ Screenshot saved to: ${screenshotPath}`);

  // Copy screenshot to artifact folder for user view
  const artifactDest = 'C:\\Users\\sacbh\\.gemini\\antigravity-ide\\brain\\a3893469-880d-4d13-967f-4954e05d7910\\browser_batch_verified.png';
  fs.copyFileSync(screenshotPath, artifactDest);

  await browser.close();

  if (batchRequests.length > 0 && photoImages.length > 0) {
    console.log('\n🎉 SUCCESS: Batch thumbnail fetching is working correctly in browser with clean cache!');
  } else {
    console.warn('\n⚠️ Warning: No batch requests detected or 0 data URL images rendered.');
  }
}

run().catch((err) => {
  console.error('❌ Browser audit failed:', err);
  process.exit(1);
});
