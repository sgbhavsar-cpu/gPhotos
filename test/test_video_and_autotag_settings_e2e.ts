/**
 * test_video_and_autotag_settings_e2e.ts
 *
 * Playwright E2E smoke test for the two features in
 * docs/FEATURE_AI_AUTO_TAGGING.md and docs/FEATURE_VIDEO_LIBRARY_SUPPORT.md.
 *
 * Launches a FRESH, ISOLATED instance of the real built app via Playwright's Electron launcher,
 * pointed at its own temp --user-data-dir — never the real %APPDATA%\gPhotos, never a library the
 * user actually has open, and never a live/running instance of the app (see the project's standing
 * "never test-launch gPhotos against real data" / "don't drive a window the user is using" rules).
 *
 * Scope: this covers what's safely automatable without either (a) driving a native OS file-picker
 * dialog (Playwright cannot do this) or (b) reverse-engineering the exact catalog/SQLite bootstrap
 * shape just to fake-populate a library — the Settings toggle is reachable with NO library open at
 * all, so it's covered here end-to-end against the real running app. The video-gallery scenarios
 * (E1-E4 in the feature doc) are covered instead by the real-DOM vitest component test
 * test/vitest/photoCardVideo.spec.ts (hover-preview timing + badge) and the Range-serving/thumbnail/
 * scanning unit tests — PhotoLightbox itself has no direct test harness anywhere in this codebase
 * (a known, pre-existing limitation, not specific to this change) so its video branch is covered by
 * careful code review + a clean typecheck instead.
 *
 * Requires `npm run build:ui && npm run build:electron` to have been run first.
 */
import { _electron as electron } from 'playwright';
import fs from 'fs';
import os from 'os';
import path from 'path';

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
  console.log(`  ✓ ${message}`);
}

async function run() {
  console.log('===============================================================');
  console.log('🧪 Video library + AI auto-tagging — Settings E2E (isolated instance)');
  console.log('===============================================================\n');

  const mainJs = path.join(__dirname, '../dist-electron/main/main.js');
  if (!fs.existsSync(mainJs)) {
    throw new Error(`Built main process entry not found at ${mainJs} — run "npm run build:ui && npm run build:electron" first.`);
  }

  // A fresh, isolated profile dir — this is what keeps this run from ever touching the real
  // %APPDATA%\gPhotos or anything the user's own running instance has open.
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gphotos_e2e_userdata_'));
  console.log(`📁 Isolated --user-data-dir: ${userDataDir}\n`);

  const app = await electron.launch({
    args: [mainJs, `--user-data-dir=${userDataDir}`],
    timeout: 60000,
  });

  try {
    const window = await app.firstWindow({ timeout: 30000 });
    await window.waitForLoadState('domcontentloaded');
    console.log('✓ App window opened\n');

    // Give React a moment to mount past the splash screen.
    await window.waitForTimeout(3000);

    const settingsNav = window.getByText('Settings', { exact: true }).first();
    await settingsNav.click({ timeout: 15000 });
    assert(true, 'Clicked the Settings nav item');

    const searchTab = window.getByText('Search with AI', { exact: true }).first();
    await searchTab.click({ timeout: 15000 });
    assert(true, 'Opened the "Search with AI" settings tab');

    const toggleLabel = window.getByText('Automatically describe & tag photos in the background', { exact: false });
    await toggleLabel.waitFor({ state: 'visible', timeout: 15000 });
    assert(true, 'The "Auto-Describe & Tag Photos (Background)" toggle is visible');

    const checkbox = window.locator('input[type="checkbox"]').filter({ hasNot: window.locator(':checked') }).first();
    // Simpler, robust locator: the checkbox immediately preceding the label text.
    const toggle = toggleLabel.locator('xpath=preceding-sibling::input[@type="checkbox"]').first();
    const before = await toggle.isChecked();
    await toggle.click();
    const after = await toggle.isChecked();
    assert(after === !before, 'Clicking the toggle flips its checked state');

    await window.reload();
    await window.waitForLoadState('domcontentloaded');
    await window.waitForTimeout(3000);
    await window.getByText('Settings', { exact: true }).first().click({ timeout: 15000 });
    await window.getByText('Search with AI', { exact: true }).first().click({ timeout: 15000 });
    const toggleAfterReload = window.getByText('Automatically describe & tag photos in the background', { exact: false })
      .locator('xpath=preceding-sibling::input[@type="checkbox"]').first();
    await toggleAfterReload.waitFor({ state: 'visible', timeout: 15000 });
    const persisted = await toggleAfterReload.isChecked();
    assert(persisted === after, 'The toggle state survives a reload (localStorage persistence)');

    console.log('\n🎉 SUCCESS: Settings toggle for background AI auto-tagging works end-to-end.');
  } finally {
    await app.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

run().catch((err) => {
  console.error('❌ E2E test failed:', err);
  process.exit(1);
});
