# Overnight report — 2026-09-25

Written while you slept. Everything below was measured on your real library (23,880 photos, 5,600+ people) with the real app running. All changes are **uncommitted** in the working tree (30 modified + 16 new files, alongside your own earlier edits).

## Status at a glance
| | |
|---|---|
| Face detection | **23,880 / 23,880 scanned** (finished ~00:40 IST). One undecodable `.dng` had been blocking 100% — fixed. |
| Every screen + modal walked through | **19 / 19 steps pass** in each of the last 6 consecutive runs (3 of them back-to-back as a soak). Earlier runs failed 13/19 and 17/19 — that is how bugs 1 and 2 below were found. No crashes or "Not Responding" since the fixes. |
| Unit tests | **168 / 168 pass** (28 files). The slow legacy-script wrapper still has 8 failures that were failing before I started (list at the end). |
| App running now | Yes, on the latest build. Main process **~240 MB** (was 2.8 GB), renderer **~330 MB at start / ~900 MB after a full walk** (was 1.2–2.1 GB). |
| Databases | All 7 catalogs + the global DB passed `PRAGMA integrity_check` after every app restart tonight (each restart killed the app only between operations). |

## Bugs the UI walk found (each reproduced, fixed, and covered by a regression test)
1. **Clicking `Years` in Photos crashed the whole app** (React #300, "Rendered fewer hooks than expected"). A `useMemo` sat after the years/months/empty-list early returns in `VirtualizedTimelineGallery`. It also crashed any screen that went empty→non-empty. Test `timelineGalleryHooks.spec.ts` fails on the committed code. A scan of every component found no other case. The legacy `test_user_fixes_v4.tsx` that failed with this exact error now passes.
2. **Clicking `Clean Duplicates` (Photos toolbar) crashed the whole app.** `onClick={onOpenDuplicateCleaner}` passed the click *event* as the "cluster". Fixed at the source plus guards in `App` and the modal. Test `duplicateCleanerGuard.spec.ts` reproduces the exact `reading 'length'` crash without the fix.
3. **One ProRAW `.dng` held the library at 23,879 / 23,880 forever** (unsupported TIFF compression, retried every cycle). Permanent decode errors now mark the photo scanned with no faces; transient errors (worker crash, timeout) still retry. Test `decodeErrorClassifier.spec.ts`.

## "Not responding" — what I found and fixed tonight
| Cause | Before | After |
|---|---|---|
| Launch: renderer UI thread frozen while the app deserialised a huge `storage:load` message (every photo, its faces, then all faces again) | ~10.4 s frozen, two 5 s blocks | **1.9–2.1 s total**, worst single block 0.8 s (3 runs) |
| Launch: a **388 MB** leftover setting (`gphotos_face_cache_v2`, a stale copy of face data from the old JSON era) read, JSON-parsed and sent to the renderer on every start (~3.7 s frozen main process) | 388 MB blob | never read again, replaced with `[]` |
| Launch: face descriptors (15M numbers) serialised one by one | seconds | sent as raw `Float32Array` bytes, converted back losslessly |
| Status calls: `execSync('reg query')` on the main thread each time the UI asked for service status | ~3 s frozen per call | never blocks (cached, refreshed in the background) |
| Network Mirrors screen: "physical confirmation" opened and parsed all 24K sidecar files (~6 ms each) | **144 s** of grinding per visit | **95 ms**, identical counts (23,888 / 23,888) |
| Face scan rewrote all ~5,600 people rows for every photo | every photo | only people that changed |
| SQLite write-ahead logs never shrinking | 397 MB global, 364 MB catalog | global now **64 MB** (cap applied); catalog shrinks on its next clean checkpoint |
| Main-process memory | 2.8 GB | ~240 MB |
| Renderer memory | ~1.2 GB | ~330 MB at start, ~900 MB after a full walk |

Earlier this session (already reported): windowed People grid + sprite-sheet covers, incremental autosave, shared face cache, backgroundThrottling fix, avatar `gphoto://` 404 fix, storage-list wipe fix.

## Measured responsiveness (live, idle app, 40-second soak, one probe per second)
- IPC round trip p50 **38 ms**, p90 43 ms, max 49 ms.
- Renderer frame time p50 0 ms, max 8 ms.
- The overnight monitor also probes the UI + an IPC call every minute (`uiRoundTripMs`, `ipcRoundTripMs` columns; `-1` would mean no answer within 8 s). Recent values: 0–1 ms UI, 2–9 ms IPC.

## What the UI walk covers (all pass)
startup + sidebar · Photos gallery (images render, 0 broken) · timeline scroll (627,000 px tall, DOM stays ≤ 2,600 nodes) · zoom XS/S/M/L and Years/Months · photo lightbox open + Esc · Albums · People (25 covers from sprite sheets, 0 broken) · People search · open a person, Zoomed Faces / Full Photos, Esc back · Places map (17 markers) · Favorites · Network Mirrors (OneDrive listed, stays responsive) · Folder Tree · Organize by Date (nothing executed) · Settings & Mobile · Search-with-AI modal · Clean Duplicates modal (scan not started) · Switch Library modal · 40 s idle soak.
Opening a person takes ~40–65 ms to first paint, no UI-thread block, even for the biggest (2,758 photos).
Mobile web server (port 5173): every `/api/*` route answers 401 without credentials, including path-traversal attempts — auth is enforced.

**Deliberately not exercised** (destructive or needs you): deleting/merging/renaming people, executing Organize by Date, Reset & Rescan, Scan Photo Folder (native dialog), running the duplicate scan, rotating/editing metadata, mobile pairing with a real phone.

## Things you should know / decide
- **Global DB is still 786 MB on disk** even though the 388 MB blob is gone (SQLite keeps the freed pages). Running `VACUUM` with the app closed would reclaim about 390 MB; I didn't do it unattended.
- **Map tiles need internet**; markers load fine.
- **GPU process is ~1.2 GB** after a full walk (Places map + many thumbnails); it stays flat across repeated walks.
- The remaining ~2–3 s of startup renderer work is React rendering the first gallery page; further gains would need a bigger change.
- Laptop is on AC with sleep disabled on AC, screen off after 60 s (fine).
- Old build bundles pile up in `dist/assets` (~150 files) — harmless, safe to delete.

## Legacy test failures that pre-date tonight (unchanged, 8 of them)
`verify_core_logic.ts`, `verify_virtual_mirror.ts` (test cleanup hits a Windows file-lock EPERM; their actual checks pass), `test_all_screens_headless.ts`, `test_checkpoint_and_resume.ts` (hangs 420 s), `test_responsiveness_and_progress.ts` (sidebar text expectation), `test_thumbnail_performance.ts` (needs a sample photo), `test_user_enhancements_v2.ts`, `test_user_fixes_v3.tsx` (needs internet for geocoding). Five of these were confirmed failing identically on a clean `HEAD` checkout. Left as is.

## Files
- Overnight health log (one row/minute): `docs/overnight_monitor_2026-09-25.csv`
- New tests this session: `avatarSpriteService`, `avatarSpriteLoader`, `virtualCardGrid`, `faceClusterCache`, `incrementalSave`, `storageValidation`, `timelineGalleryHooks`, `duplicateCleanerGuard`, `decodeErrorClassifier`, `cachedProbe`, `expandDescriptors` (+ additions to `clustering`, `storageHandlers`, `storageDetailsFast`, `networkReachabilityCache`).
