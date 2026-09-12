import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

interface ConsoleRecord {
  type: string;
  text: string;
  location?: { url: string; lineNumber: number; columnNumber: number };
}

interface NetworkFailure {
  url: string;
  method: string;
  error: string;
}

export async function runBrowserInspection(targetUrl: string = 'http://192.168.29.30:5174/') {
  console.log(`\n======================================================`);
  console.log(`🔍 STARTING BROWSER AUDIT & CONSOLE LOG ANALYSIS`);
  console.log(`🌐 Target: ${targetUrl}`);
  console.log(`======================================================\n`);

  const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const consoleRecords: ConsoleRecord[] = [];
  const pageErrors: string[] = [];
  const networkFailures: NetworkFailure[] = [];
  const apiRequests: Array<{ url: string; status: number; durationMs: number }> = [];

  const browser = await chromium.launch({
    executablePath: fs.existsSync(edgePath) ? edgePath : undefined,
    headless: true,
    args: ['--disable-extensions', '--no-sandbox', '--disable-setuid-sandbox'],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });

  const page = await context.newPage();

  // 1. Hook console log tracker
  page.on('console', (msg) => {
    const loc = msg.location();
    const record: ConsoleRecord = {
      type: msg.type(),
      text: msg.text(),
      location: loc ? { url: loc.url || '', lineNumber: loc.lineNumber || 0, columnNumber: loc.columnNumber || 0 } : undefined,
    };
    consoleRecords.push(record);
  });

  // 2. Hook uncaught page runtime exceptions
  page.on('pageerror', (err) => {
    pageErrors.push(`${err.name}: ${err.message}\n${err.stack || ''}`);
  });

  // 3. Hook network request failures
  page.on('requestfailed', (req) => {
    networkFailures.push({
      url: req.url(),
      method: req.method(),
      error: req.failure()?.errorText || 'Unknown request failure',
    });
  });

  // 4. Hook API response tracking
  const requestStartTimes = new Map<string, number>();
  page.on('request', (req) => {
    requestStartTimes.set(req.url(), Date.now());
  });

  page.on('response', (res) => {
    const start = requestStartTimes.get(res.url());
    const durationMs = start ? Date.now() - start : 0;
    if (res.url().includes('/api/')) {
      apiRequests.push({
        url: res.url(),
        status: res.status(),
        durationMs,
      });
    }
  });

  try {
    console.log(`Navigating to ${targetUrl}...`);
    await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 15000 });
    console.log(`Page loaded. Waiting 2.5s for React hydration and background store initialization...`);
    await page.waitForTimeout(2500);

    // DOM Analysis
    const pageTitle = await page.title();
    console.log(`Page title: "${pageTitle}"`);

    // Check sidebar photo count
    const sidebarText = await page.evaluate(() => {
      const el = document.body;
      return el ? el.innerText : '';
    });

    const hasNoPhotosHeader = sidebarText.includes('No Photos in Library Yet');
    const hasPhotosInSidebar = /Photos\s*\(?(\d+)\)?/i.test(sidebarText);
    const photosMatch = sidebarText.match(/Photos\s*\(?(\d+)\)?/i);
    const detectedPhotoCount = photosMatch ? parseInt(photosMatch[1], 10) : 0;

    console.log(`Sidebar photo count detected: ${detectedPhotoCount}`);
    console.log(`"No Photos in Library Yet" visible: ${hasNoPhotosHeader}`);

    // Check photo cards and image elements
    const imageElements = await page.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll('img'));
      return imgs.map((img) => ({
        src: img.src,
        complete: img.complete,
        naturalWidth: img.naturalWidth,
        naturalHeight: img.naturalHeight,
      }));
    });

    const photoImgs = imageElements.filter((i) => i.src.includes('/api/photo') || i.src.includes('blob:'));
    console.log(`Rendered photo images: ${photoImgs.length} (total img tags: ${imageElements.length})`);
    const loadedSuccessfully = photoImgs.filter((i) => i.complete && i.naturalWidth > 0).length;
    console.log(`Photos loaded with valid natural dimensions: ${loadedSuccessfully}/${photoImgs.length}`);

    // Click test: If Open Library button exists, test clicking it
    const openLibraryButtons = await page.$$('button:has-text("Open Library")');
    if (openLibraryButtons.length > 0) {
      console.log(`Found ${openLibraryButtons.length} "Open Library" button(s). Clicking first button...`);
      await openLibraryButtons[0].click();
      await page.waitForTimeout(2000);
      const afterClickImgs = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('img')).filter(
          (i) => i.src.includes('/api/photo') || i.src.includes('blob:')
        ).length;
      });
      console.log(`Photo images after clicking "Open Library": ${afterClickImgs}`);
    }

    // Capture screenshot
    const screenshotDir = path.join(__dirname, '..', 'scratch');
    fs.mkdirSync(screenshotDir, { recursive: true });
    const screenshotPath = path.join(screenshotDir, 'browser_audit_result.png');
    await page.screenshot({ path: screenshotPath, fullPage: false });
    console.log(`📸 Screenshot captured: ${screenshotPath}`);

    // Console Logs Breakdown & Categorization
    console.log(`\n------------------------------------------------------`);
    console.log(`📋 CONSOLE LOG AUDIT REPORT`);
    console.log(`------------------------------------------------------`);
    console.log(`Total console records: ${consoleRecords.length}`);
    const byType = consoleRecords.reduce((acc, cur) => {
      acc[cur.type] = (acc[cur.type] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    console.log(`By Type:`, JSON.stringify(byType));

    const errors = consoleRecords.filter((c) => c.type === 'error');
    const warnings = consoleRecords.filter((c) => c.type === 'warning');

    if (errors.length > 0) {
      console.log(`\n❌ Console Errors (${errors.length}):`);
      errors.forEach((e, idx) => console.log(`  ${idx + 1}. [${e.location?.url || 'unknown'}:${e.location?.lineNumber}] ${e.text}`));
    } else {
      console.log(`\n✅ Zero console errors detected!`);
    }

    if (warnings.length > 0) {
      console.log(`\n⚠️ Console Warnings (${warnings.length}):`);
      warnings.forEach((w, idx) => console.log(`  ${idx + 1}. [${w.location?.url || 'unknown'}:${w.location?.lineNumber}] ${w.text}`));
    }

    console.log(`\n------------------------------------------------------`);
    console.log(`🌐 API REQUEST AUDIT`);
    console.log(`------------------------------------------------------`);
    apiRequests.forEach((req) => {
      console.log(`  [${req.status}] ${req.url} (${req.durationMs}ms)`);
    });

    if (networkFailures.length > 0) {
      console.log(`\n❌ Network Failures (${networkFailures.length}):`);
      networkFailures.forEach((f) => console.log(`  ${f.method} ${f.url} -> ${f.error}`));
    } else {
      console.log(`\n✅ Zero network request failures!`);
    }

    if (pageErrors.length > 0) {
      console.log(`\n💥 Uncaught Page Errors (${pageErrors.length}):`);
      pageErrors.forEach((e) => console.log(e));
    } else {
      console.log(`\n✅ Zero uncaught page runtime exceptions!`);
    }

    return {
      success: pageErrors.length === 0 && networkFailures.length === 0,
      detectedPhotoCount,
      photoImagesCount: photoImgs.length,
      loadedPhotosCount: loadedSuccessfully,
      consoleErrorsCount: errors.length,
      consoleWarningsCount: warnings.length,
      pageErrorsCount: pageErrors.length,
      networkFailuresCount: networkFailures.length,
    };
  } finally {
    await browser.close();
  }
}

// Run if called directly
if (require.main === module) {
  const target = process.argv[2] || 'http://127.0.0.1:5174/';
  runBrowserInspection(target)
    .then((res) => {
      console.log('\nAudit complete:', JSON.stringify(res, null, 2));
      process.exit(res.success ? 0 : 1);
    })
    .catch((err) => {
      console.error('\nAudit execution failed:', err);
      process.exit(1);
    });
}
