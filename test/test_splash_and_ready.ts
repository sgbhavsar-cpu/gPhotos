import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';

async function verify() {
  console.log('🚀 TESTING STARTUP SPLASH SCREEN & SMOOTH REVEAL PROTOCOL...');

  // 1. Static Asset Verification
  const splashPath = path.join(__dirname, '../dist-electron/main/splash.html');
  if (!fs.existsSync(splashPath)) {
    throw new Error(`dist-electron/main/splash.html missing at ${splashPath}`);
  }
  const splashContent = fs.readFileSync(splashPath, 'utf8');
  if (!splashContent.includes('gPhotos') || !splashContent.includes('progress-bar-fill')) {
    throw new Error('splash.html missing required brand or progress bar elements');
  }
  console.log('  ✓ Desktop Electron splash.html verified successfully.');

  // 2. Inline Browser Splash Verification
  const indexPath = path.join(__dirname, '../dist/index.html');
  const indexContent = fs.readFileSync(indexPath, 'utf8');
  if (!indexContent.includes('id="app-splash-screen"') || !indexContent.includes('inline-bar-fill')) {
    throw new Error('dist/index.html missing inline 0ms #app-splash-screen container');
  }
  console.log('  ✓ Browser 0ms inline splash loader verified in dist/index.html.');

  // 3. Browser Lifecycle Test
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  let appReadyCalled = false;
  await page.exposeFunction('mockElectronAppReady', () => {
    appReadyCalled = true;
  });

  await page.addInitScript(() => {
    // Inject mock electronAPI if running in direct browser
    if (!(window as any).electronAPI) {
      (window as any).electronAPI = {};
    }
    const orig = (window as any).electronAPI.sendAppReady;
    (window as any).electronAPI.sendAppReady = () => {
      (window as any).mockElectronAppReady();
      if (typeof orig === 'function') orig();
    };
  });

  console.log('  Navigating to http://192.168.29.30:5174/...');
  await page.goto('http://192.168.29.30:5174/', { waitUntil: 'domcontentloaded' });

  // Right after DOM content loaded, verify splash is visible
  const splashLocator = page.locator('#app-splash-screen');
  const isSplashPresent = await splashLocator.count();
  console.log(`  ✓ Initial DOM Splash element detected: ${isSplashPresent > 0}`);

  // Wait for React hydration and library data fetch
  await page.waitForTimeout(1500);

  // Check if splash has received 'loaded' class or was removed
  const isLoadedOrGone = await page.evaluate(() => {
    const el = document.getElementById('app-splash-screen');
    return !el || el.classList.contains('loaded') || window.getComputedStyle(el).opacity === '0';
  });

  console.log(`  ✓ Splash loader gracefully dismissed after mount: ${isLoadedOrGone}`);
  console.log(`  ✓ electronAPI.sendAppReady() signal triggered: ${appReadyCalled}`);

  // Capture screenshot of rendered app
  const screenshotPath = 'scratch/splash_transition_verified.png';
  await page.screenshot({ path: screenshotPath });
  console.log(`  ✓ Screenshot saved to: ${screenshotPath}`);

  // Copy to artifact folder for inspection
  const artifactDest = 'C:\\Users\\sacbh\\.gemini\antigravity-ide\\brain\\a3893469-880d-4d13-967f-4954e05d7910\\splash_transition_verified.png';
  try {
    fs.copyFileSync(screenshotPath, artifactDest);
  } catch {}

  await browser.close();

  if (isSplashPresent > 0 && isLoadedOrGone && appReadyCalled) {
    console.log('\n🎉 SUCCESS: Startup splash screen & smooth reveal verified perfectly!');
  } else {
    throw new Error('Verification failed: splash did not transition or sendAppReady was not called');
  }
}

verify().catch((err) => {
  console.error('❌ Splash verification failed:', err);
  process.exit(1);
});
