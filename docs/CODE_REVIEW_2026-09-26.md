# Code review: quality, performance and error handling (2026-09-26)

Base commit: `ef6da5d` (v2.0.0). Scope: the whole app (main process, preload, renderer, LAN web server, scripts).
Goal set by the owner: review code quality and performance, and make sure the app never fails without telling the user.

## 1. How this was done

1. Six read-only audits, one per area (main.ts/IPC/security, data services, workers/daemon, web server, renderer core, renderer views).
2. Fixes applied per area with disjoint file ownership; `tsc` clean after each.
3. A second, independent five-slice review of the resulting diff. Its 26 findings are listed in section 5 and are fixed in this same change set (status column).

## 2. Incident during this work (read this)

Running the vitest suite before redirecting `APPDATA` touched the **real** `%APPDATA%\gPhotos`: `gphotos.db`, `libraries_status.json`, `storage_sync_checkpoints.json`, `main.log`. One spec (`backgroundSyncUnified`) also processed the real `pending_rotations.json` (3 rotations for `V:\` originals; nothing was applied because `V:` was unreachable).

- DB verified afterwards on a scratch copy: `quick_check` ok, 7,613 people (60 named); no face-data reset ran.
- `libraries_status.json` already contained 70 leaked temp-test keys out of 82 from earlier runs. Left untouched.
- **Fix:** `vitest.config.ts` now sets `test.env.APPDATA/LOCALAPPDATA` to a throwaway temp dir. Always run tests with that config (or redirect `APPDATA` yourself).

## 3. What changed (summary)

| Area | Change |
|---|---|
| Type safety | Renderer imported types from a non-existent path, so it compiled as `any`. Paths fixed; `npm run typecheck` added and run first by `npm test`. Exposed a `PhotoCard` crash (variable used before declaration) and a scan toast that read fields main never sends. |
| Error surface | New `services/notifications.ts` + `components/NoticeHost.tsx` (sticky error toasts, dedupe, copy details). `main.tsx` routes `error`, `unhandledrejection`, `onCaughtError`, `onUncaughtError` to it and to the log file. `ErrorBoundary` logs, has `resetKey`/`compact`, guards clipboard. Each main view has its own boundary reset on tab change. |
| Main process | Uncaught exceptions/rejections logged and shown (max 1 dialog/min). Startup/UI-load failures no longer leave a splash with no window. `protocol.handle` registered once. Logger/smoke-test/single-instance ordering fixed. `storage:load` and catalog reads now reject instead of returning "empty". `mirror:delete-storage` can no longer trash the mirror root and has no permanent-delete fallback. `photo:edit/rotate/write-metadata` validate paths and coordinates. `gphoto://` serves image types only and clamps `size`. Dead `file:read-base64` removed. `UV_THREADPOOL_SIZE=16`. |
| Data safety | Atomic writes (`jsonFile.ts`) for checkpoints, sidecars, queues, status, backups, thumbnails. Corrupt JSON is quarantined instead of overwritten. Prune skipped after a partial/empty scan. Rotate honours EXIF orientation and requires a backup. Organizer no longer overwrites when two sources map to one target. Empty people/faces lists no longer wipe tables unless explicit (`allowEmpty`). Deleted photos are removed from the DB (`removedIds`). |
| LAN web server | Remote allow-list excludes `userData`/temp; phones cannot widen trusted roots; body size caps; timing-safe PIN; global failure cap; `stream.pipeline` for files; image whitelist + `nosniff`; port validation; `serve_mobile.js` binds to localhost by default. |
| Workers / performance | Face worker: per-worker pending, 3-min timeout, pool resize, idle terminate. Thumbnail/HEIC caches atomic, LRU byte budget, in-flight dedupe. Daemon: per-storage isolation, no stat overwrites, idempotent init. Renderer: memoised lookups, page-append dedupe, capped tile lists, fetch-slot leak fixed. |

Not done on purpose (each is a larger change): HEIC decode in a worker thread, keyset pagination for library reads, face-clustering rewrite, dirty-id save tracking, virtualising every grid.

## 4. Behaviour changes to be aware of

- Phones can no longer add new storages or open libraries not already opened on the desktop.
- Album picker, Places assign modal, cover-face picker, folder grid and cluster tray cap the tiles they show (Select All still selects every match).
- Duplicate cleaner refuses to delete when nothing would be kept.
- `storage:load` failures now surface as errors instead of an empty library.

## 5. Second-review findings and their status

Verdict: CONFIRMED = re-read in code by the coordinator; PLAUSIBLE = reported by a reviewer, not independently confirmed.
Status: updated as fixes land (`Fixed` / `Deferred (reason)`).

| # | Sev | File | Finding | Verdict | Status |
|---|---|---|---|---|---|
| 1 | High | `renderer/services/libraryStore.ts` | `setPhotos` clears the load-failure guard even if the people registry failed to load; next save sends `[]` people with `allowEmpty` and wipes every person | CONFIRMED | Fixed |
| 2 | High | `main/services/heicRotationStore.ts` | `saveHeicSavedRotation` loads twice; a failed first load then a good second load resets `heicLoadFailed` and overwrites the file with one entry | CONFIRMED | Fixed |
| 3 | High | `main/services/fileOrganizer.ts` | EXDEV fallback deletes the pre-existing target after `COPYFILE_EXCL` throws `EEXIST` | CONFIRMED | Fixed |
| 4 | High | `main/services/virtualMirrorService.ts` | A second `syncVirtualStorage` joins the in-flight run and ignores its options/config (e.g. face detection off) | CONFIRMED | Fixed |
| 5 | High | `main/services/virtualMirrorService.ts` | One undeletable stale mirror file sets sync `success:false`; renderer then never saves totals | CONFIRMED | Fixed |
| 6 | Med | `main/services/virtualMirrorService.ts` | Local rotate failure returns an error instead of falling through to the offline queue | PLAUSIBLE | Fixed |
| 7 | Med | `main/services/webAuthService.ts` | Transient read error treated as corruption: new PIN, all phones unpaired | CONFIRMED | Fixed |
| 8 | Med | `main/services/pipelineOrchestrator.ts` | Worker-crash failures counted against innocent co-batched photos, which end up permanently "scanned, no faces" | PLAUSIBLE | Fixed |
| 9 | Med | `main/services/pipelineOrchestrator.ts` | Non-ENOENT read errors retried forever (no cap) | PLAUSIBLE | Fixed |
| 10 | Med | `main/services/networkReachabilityCache.ts` | Probe key per file (not per share) lets many hung probes exhaust the libuv pool | PLAUSIBLE | Fixed |
| 11 | Med | `main/services/thumbnailWorkerService.ts` | Transient stat failure stored as permanent failure for the session | PLAUSIBLE | Fixed |
| 12 | Med | `main/services/embeddedWebServer.ts` | `/api/rotate-photo` body uncapped, no abort handling | CONFIRMED | Fixed |
| 13 | Med | `main/services/embeddedWebServer.ts` | Disabling the server is ignored when the port field is invalid | CONFIRMED | Fixed |
| 14 | Med | `main/services/webAuthService.ts` | Global failure cap lets one LAN host block all pairing; message says "a minute" | PLAUSIBLE | Fixed |
| 15 | Med | `main/services/embeddedWebServer.ts` | `/api/delete-files` accepts directories/roots and empty entries | PLAUSIBLE | Fixed |
| 16 | Med | `renderer/App.tsx` | Deferred startup existence check can clear the library the user just opened | PLAUSIBLE | Fixed |
| 17 | Med | `renderer/App.tsx` | Superseded face sweep leaves `isDetectingFaces` stuck true | PLAUSIBLE | Fixed |
| 18 | Med | `renderer/views/VirtualStorageView.tsx` | Poll tick overwrites storages added/removed during its await | PLAUSIBLE | Fixed |
| 19 | Med | `renderer/components/BulkEditModal.tsx` | Stale full-photo snapshot spread back into the store after the write phase | PLAUSIBLE | Fixed |
| 20 | Med | `renderer/components/SetCoverPhotoModal.tsx` | Avatar save `{success:false}` ignored; cover still changes | PLAUSIBLE | Fixed |
| 21 | Med | `renderer/components/DuplicateCleanerModal.tsx` | Delete uses pre-await `clusters` closure; concurrent edits lost | PLAUSIBLE | Fixed |
| 22 | Low | `renderer/services/faceQueue.ts` | `decode-failed` photos re-enqueued every idle tick forever | PLAUSIBLE | Fixed |
| 23 | Low | `renderer/browserShim.ts` | `switchLibrary` swallows the new 403 | CONFIRMED | Fixed |
| 24 | Low | `renderer/services/aiSearchService.ts` | LLM `dateRange.year` as string yields zero results silently | PLAUSIBLE | Fixed |
| 25 | Low | `renderer/views/SettingsView.tsx` | Slider labels ignore draft; missed release never commits | PLAUSIBLE | Fixed |
| 26 | Low | `renderer/services/notifications.ts` | Repeated notice keeps the first occurrence's dismiss timer | CONFIRMED | Fixed |

## 6. How the second-review findings were fixed

All 26 are fixed. Notes on the non-obvious ones:

- **#1** A separate `peopleLoadFailed` flag in `libraryStore`; it is cleared only by a later successful people load, never by `setPhotos`/`switchLibrary`. While set, the people key is not sent (photo saves still are).
- **#2** `persistHeicRotations` only writes the *cached* (fully loaded) map, so a map from a failed read can never be persisted, however often a load flag is reset.
- **#4** Syncs for one storage are now serialised: a second caller waits, then runs its own pass with its own options/progress callback (it no longer receives someone else's result).
- **#5** Prune problems are returned as `warnings` (new optional field on `SyncVirtualStorageResult`), not `errors`, so `success` reflects whether photos were mirrored.
- **#7** The auth file is read with `readJsonSafe`; an unreadable file yields a temporary, never-cached, never-saved config (pairing then fails loudly instead of re-issuing a PIN and dropping all devices).
- **#8** `FaceWorkerError.attributable` marks only the request that plausibly caused a worker failure (timeout, or sole request on a crashed worker); only those count toward "undecodable".
- **#9** Permanent read errors (EACCES, EPERM, EISDIR, EIO, ...) get the same bounded retries; environmental ones (EBUSY, network) still retry indefinitely.
- **#10** While the first probe against a share is in flight, other callers for that share wait for it, so a dead share ties up at most one libuv thread.
- **#11** Failed thumbnails are retried after 10 minutes and given up on after 3 attempts (was: never again this session).
- **#14** The 429 response now says how long to wait (`Retry-After` header too), and regenerating the PIN in Settings clears the lockout.
- **#25/#26/others** See the renderer changes in `SettingsView.tsx`, `notifications.ts` etc.

Extra hardening found while verifying: `writeFileAtomic` used a temp name based on `Date.now()`, so two writes in the same millisecond could collide (seen as an `EPERM` in a test run). It now uses a unique name and retries a transient Windows rename failure.

## 7. Verification

- `npm run typecheck` (renderer + main): clean.
- `vitest`, `APPDATA` redirected by `vitest.config.ts`: **43 files, 283 tests pass, 3 opt-in benchmarks skipped** (`GPHOTOS_BENCH=1` enables them). `legacyScripts.spec.ts` is excluded on purpose: it wraps scripts that can touch real data.
- New specs: `reviewFixes.spec.ts` (HEIC rotation store and auth config under a simulated `EBUSY`, lockout recovery), `peopleLoadFailure.spec.ts`, `saveFailure.spec.ts`, `jsonFile.spec.ts`; `peopleSaveSemantics.spec.ts` updated for the explicit-empty rule.
- `vite build`: succeeds.
- **Not verified:** the Electron app itself was not launched by this work, and the UI-only changes (sliders, modals, `App.tsx` flows) have no runtime test. Rebuild (`npm run build:electron` / `npm run dist:win`) and smoke-test before release. The running app keeps using the old build until then.

## 8. Deferred items (completed afterwards)

Each was done with an equivalence or regression spec against the old behaviour and, where performance was the point, a measurement.

| Item | What was done | Measured / proven |
|---|---|---|
| HEIC decode off the main thread | `heicWorker.ts` + `heicWorkerClient.ts`: worker pool (default 1, max 2), two-priority queue (thumbnails before full-res, no starvation), 2-min timeout, crash isolation, idle terminate, in-process fallback if the worker cannot start; `asarUnpack` entry added | Fake-worker tests for pool/limiter/timeout/crash (11 tests). Event-loop lag 990 ms on the main thread vs 9 ms on the worker, using a 1 s CPU loop as the stand-in. **No real HEVC HEIC could be decoded here**, so the real worker was only smoke-tested with invalid input. |
| Keyset pagination | `getAllPhotosChunked`, `getAllPhotosForSummary`, `getAllFacesChunked` use keyset paging; new index `idx_photos_date_taken_id`; `buildMeta` computes timeline/place summaries in SQL and no longer loads every photo | Deep-equal against the old implementations (kept as oracles) over many duplicate/odd dates and locations; writers interleaving between chunks neither duplicate nor drop rows (old paging did). Paging 348–500 ms → 71–84 ms at 100k rows; summaries about 20% faster; faces read roughly unchanged. |
| Face clustering | Same results, far less work: incremental centroids, early-stop distance, exact triangle-inequality pruning, and a per-cache incremental session so each photo clusters only its new faces | Deep-equal vs old main and renderer implementations on seeded libraries (up to 20,000 faces, ties, confirmed/manual faces). 20k faces / 300 people: renderer 128–137 s → 3.4 s, main 50 s → 1.7 s, per-photo pipeline step 121–232 ms → 8 ms. |
| Cheaper saves | Per-photo signature cache with a change guard, periodic (every 20th) and on-blur/unload full re-sign as a safety net, coalesced page notifications, removals stay incremental via `removedIds` | Equivalence spec over random store operations; save after one edit at 100k photos: ~140 ms → ~17–25 ms. |
| Virtualised grids | Organizer grid and table, folder grid, album detail and picker, Places assign grid and tray, cover-face picker; incremental month grouping; pan in the lightbox no longer re-renders per mouse move | Windowing specs (only the visible range mounts, Select All still selects everything, last item reachable); incremental grouping equals a full regroup over random appended pages. |
| Mirror / scan IO | EXIF read no longer reads whole files; async directory scans; storage-details computed from listings (four duplicate computations merged); async mirror scan and folder reads with bounded parallelism; negative cache for HEIC rotation sidecars | Equivalence specs; on local disk wall time is about the same (the gain is not blocking on a dead SMB share). `main.ts` and the daemon now use the async storage-details functions. |
| Residual hardening | Symlink/junction-safe path allow-list; HTTP `Range` support; service-worker cache fixes; face pool serialised per worker with pixel cap and RSS back-off; thumbnail "already cached" probes run 32 wide | Junction-escape, Range and fast-forward specs. |

### Known limits and things to check on screen

- **Real HEIC decode** through the new worker is untested (no decodable file available). Try a real HEVC photo after rebuilding.
- **First open of an existing library** builds the new `idx_photos_date_taken_id` index once; on a very large library that can take a few seconds.
- **Catalog summaries** now run as two synchronous SQL queries (~0.4 s and ~0.3 s at 100k realistic rows) instead of yielding every 5,000 rows; well under the "not responding" threshold but a longer single block.
- **Fixed row/tile heights** in the new virtual lists (216 px folder tile, 214 px Organizer tile, 190 px cover-face tile): confirm captions are not clipped. The timeline scrubber's active-year highlight can lag by up to one row.
- **Saves:** an in-place edit to nested face/exif/location data made outside the store is picked up within 20 saves, on window blur, or on unload (nothing in the renderer does this today).
- **Service worker** (`sw.js`) only runs on secure contexts, so it is effectively inactive on plain `http://192.168.x.x`; the server's own cache headers apply there.
- **Symlinks on UNC paths** are compared lexically (no `realpath`) so an unreachable share cannot stall the main process.

### Deliberately not done

- Top-K exemplar cap in clustering (not exact; the exact pruning above gives the speed-up).
- Downscaling before the face detector's raw decode (descriptors would change).
- Changing the global-DB fallback in `getDbPath` (44 references across 11 files rely on it for first-run/new-library flows).
- Caching parsed descriptor JSON on reads (output shape must stay identical).
## 9. Post-release fix: sync of very large storages (reported from the running app)

Symptom (storage "821"): `Failed to prioritize already-scanned photos ... RangeError: Maximum call stack size exceeded`, then `mirror:sync-storage error: The "path" argument must be of type string. Received undefined`, and the UI toast "Sync of 821 finished with errors".

Cause (already present in `ef6da5d`, not introduced by this review): the sync reordered its file list with `remoteFiles.length = 0; remoteFiles.push(...alreadyDone, ...needsWork)`. Spreading a few hundred thousand entries into one call overflows the stack; because the list had already been emptied, the failure left it empty and the batch loop then read `undefined` paths for every remaining index.

Fix: `partitionInPlace` (stable, never empties or spreads the array; unchanged if the predicate throws) and a guard so one bad list entry is reported as a per-file failure instead of aborting the whole sync. Tests: `partitionInPlace.spec.ts` (900k entries) and `largeLibrarySync.spec.ts` (real `syncVirtualStorage` over a 200k-entry list in an isolated temp library); the unit test fails against the old behaviour. `push(...bigArray)` throws `RangeError` at 900k in Electron's own runtime. Other spread sites in `src` were checked and are bounded (page/chunk sized).

Also found and repaired: three em-dashes in comments in `virtualMirrorService.ts` had been written as single cp1252 bytes (invalid UTF-8). All source files were re-scanned; none remain.

Not caused by this work: the repeated `MAIN PROCESS STALL ~3.4s` lines. `hang-watchdog.log` shows stalls of 3 s or more on every day since 2026-09-19 (hundreds to thousands per day; 117 so far today). The new SQL catalog summaries were measured on a copy of storage 821's real catalog DB (25,166 photos): timeline 57 ms, places 15 ms, so they are not the cause. The 818k figure in the log is the global thumbnail pre-cache total across all libraries, not one library. The stalls themselves still need a profile against the live app.
### 9a. Sync now stops when the source storage goes away mid-run

Before: every remaining file failed and was logged/reported individually (a lost 800k-photo share meant hundreds of thousands of error strings and a very long "sync"). Now `syncVirtualStorage` counts consecutive per-file failures; every 3rd it checks `isPathReachable` on the source (bounded by a timeout, offline verdict cached). If the source is gone it stops at once: the result is `success:false, sourceUnavailable:true` with a clear first error ("Source storage ... became unavailable after N of M files - sync stopped. It will continue automatically once the storage is reachable again."), a progress event with `status:'error'`, nothing is pruned, and only the first 50 file errors are kept (the rest are counted). The checkpoint is saved as `interrupted` with no resumable index on purpose: the file list is re-ordered per pass, so a saved array position would point at a different file next time; the next pass re-walks and skips unchanged files cheaply. Bad files on a healthy source are unaffected (no false stop). Tests: `sourceUnavailableSync.spec.ts` (fails when the breaker is disabled).
## 10. Rotating photos (and the people in them)

Reported: rotation "still not working properly": the local cached thumbnail should be rotated, and the original queued when its storage is offline. The rotate IPC itself completed fine in the real log; the problems were around it. Each was reproduced or measured before being fixed:

- **Stale pixels everywhere else.** A throwaway Electron probe showed that an `<img>` re-loading the *same URL* gets the first bitmap back (10x20 stayed 10x20 after the file became 20x10), even with `no-cache` + ETag and without asking the handler again. After a physical rotation the lightbox (re-opened), People/Album views and face crops kept showing the old orientation. Photo URLs now carry a per-photo version (`&v=N`, `imageVersion.ts`, remembered in localStorage) that is bumped on rotation.
- **Face boxes stayed in the old orientation.** Nothing rotated them, so face overlays and person avatars pointed at the wrong region (visible in the log as forced re-detects right after rotating). `libraryStore.applyPhotoRotation` now rotates each box and its reference frame with the picture and swaps the photo size; avatars cut from the photo are rebuilt after the boxes are saved. Faces with an unknown frame are reported, not guessed.
- **HEIC originals rotated twice as far as their thumbnail.** `saveHeicSavedRotation` on the local file also mirrors onto the original via the sidecar, and the code then saved the original again (90 became 180). `addSavedRotation` now reads every path's previous value first and sets each path once (also used by the cache-rotation helper and `editPhotoFile`).
- **HEIC-named mirror thumbnails rotated twice when their cache was regenerated.** The flag means "rotate when decoding" for a real HEIC but "already baked in" for a JPEG that is merely named `.heic`. It is now applied only to real containers (`getSavedRotationForContent`).
- **Camera RAW masters could be overwritten.** Rotating a reconnected original re-encoded it with sharp. RAW originals (`.nef .dng .cr2 ...`) are now left untouched: the local thumbnail is still rotated, nothing is queued, and an already-queued entry is dropped instead of retrying forever.
- **Lightbox.** Quick clicks are added up and applied as one rotation; the CSS preview is dropped exactly when the rotated picture has loaded (no flash, no double rotation); a queued rotation says so.
- Lazy `require('./heicRotationStore')` calls (which only resolve in the compiled build) became normal imports, which also made this flow testable.

Tests: `rotateOffline.spec.ts` (isolated harness: mirror thumbnail present, original offline; HEIC, RAW and repeated rotations), `rotateOfflinePathGate.spec.ts`, `photoRotation.spec.ts`, `afterPhotoRotated.spec.ts`.

Still by design: for a HEIC original the rotation is stored as a flag on its path rather than queued (queuing too would double-apply when it drains). JPEG originals are still re-encoded by sharp when rotated in place (not lossless); a lossless (jpegtran-style) rotation is not implemented.
## 11. Drag selection in the gallery

Rule now (Explorer-style), in `VirtualizedTimelineGallery`: a plain press + drag starts a **new** selection (the earlier one is replaced once the drag actually starts); **Ctrl/Cmd** + press + drag **adds** the dragged block to the current selection and never toggles or removes anything that was already selected, even where the new block overlaps it. Before, every drag kept the old selection, so a fresh selection could not be started by dragging. Clicks are unchanged (Ctrl+click toggles; the click that ends a drag is ignored). Tests: `dragSelect.spec.ts` mounts the real gallery with a stub card (the plain-drag case fails against the old rule).
## 12. New: move an album's photos to a folder, and auto-rotate upright

### Move album photos to a folder (Albums screen, "Move to Folder...")
- Flow: `planRelocation` (main) finds the library folder / network storage the photos live in and which can move; the in-app folder browser opens **restricted to that folder** (can't browse above it; a "new folder" name box creates a sub-folder); confirm; `relocatePhotos` moves the originals; the renderer re-points its state (`libraryStore.applyPhotoRelocations`) and saves at once.
- Photo ids and face ids are derived from file paths, so a move is more than `rename`: per photo it moves the original plus same-name `.xmp` / `.aae` / `.bak` files, and for virtual-storage photos also the local mirror thumbnail and its sidecar (rewritten), then re-keys the photo, its faces, album membership/cover and people covers in one DB transaction, and follows rotation flags and queued rotations. Any failure undoes that photo completely. Nothing is ever overwritten (name clashes become `name (1).ext`) and nothing is deleted except a verified cross-device copy's source.
- Safety: destination must be inside the same root (real-path checked); photos in other roots or in an offline storage are skipped with a reason; refused while that storage is syncing; only the desktop app (not the LAN browser client).
- Tests: `photoRelocation.spec.ts` (plain and virtual moves, a real `syncVirtualStorage` afterwards finds no duplicates and prunes nothing, name clashes, escape attempts, two rollback cases), `photoRelocationFlow.spec.ts`, `moveToFolderUi.spec.ts`.
- Known limits: an `.xmp`/`.aae` shared by two same-name photos moves with the first only; cross-volume moves and an incomplete rollback are untested; the "never overwrite" check has a tiny race with other programs.

### Auto-rotate upright (Gallery selection bar, "Auto-Rotate Upright")
- Uses the face detector at 0/90/180/270 degrees on a small copy of each photo (the local thumbnail for storage photos; the original is never read over the network). A photo is rotated only when one orientation shows clearly more (>= 2x) face evidence than all others; otherwise it is left alone and counted ("no faces found", "weak face signal", "ambiguous"). Rotations go through the existing safe rotate pipeline (thumbnail now, original when reachable or queued, face boxes and avatars updated).
- Validation: 44/44 correct decisions on 11 real public-domain face photos displayed at all four rotations (and 88/88 at low resolution), zero wrong decisions; but all rotations were synthetic and every face was a posed frontal portrait. Not tested: candid or sideways-camera photos, profiles, children, people lying down.
- **It cannot orient photos without faces** (landscapes, documents, food, pets): they are reported and never rotated. Object/scene-based orientation would need a separate model that is not in the app.
- Tests: `orientation.spec.ts` (rotate helper vs sharp, decision rules, service), `orientationRealDetector.spec.ts` (only with `GPHOTOS_FACE_FIXTURES` pointing at local images), `autoRotateUpright.spec.ts`.
## 13. Keeping the same photo in view when the thumbnail size changes

`VirtualizedTimelineGallery` (and so the Gallery and a person's photo list) now re-scrolls after every size change, using `zoomAnchor.ts` and the real layout (month header 52 px, row pitch = thumbnail height + gap, newest month first):
- **Toolbar** (or any change of the `zoomLevel` prop): the thumbnail at the top-left of the viewport is found in the OLD layout and the NEW layout is scrolled so that thumbnail's row sits at the top. At a month header (or the first half-row after it) the month start is the anchor so the header stays visible. Columns are recomputed for the new size, so the same photo can land in a different column of the top row; it is always in the top row.
- **Ctrl + mouse wheel** (a plain wheel still just scrolls): the thumbnail under the pointer is recorded (and how far down inside it), and after the zoom that same thumbnail is placed under the pointer vertically. Horizontally the column count changes, so exact x alignment is not possible.
- Not applied between the Years/Months summary views and the grid sizes (they are different layouts).
Tests: `zoomAnchor.spec.ts` (pure math against an independent layout model over all size pairs, plus the real gallery driven by both the toolbar and Ctrl+wheel; they fail when the adjustment is disabled). Not verified in a real browser: Chromium's own scroll anchoring could interact with the programmatic scroll.

## 14. Face marker click = assign / reassign person

In the photo viewer, clicking a face box (`PhotoLightbox.tsx`) now opens the Assign / Reassign person dialog for that face (searchable, click or Enter to assign). The name label chips (confirm, wrong person, rename, delete, go to person) keep their own actions. Ignored while tagging a new face, and when the press moved more than 4 px (a drag-pan of a zoomed photo that began on the box). Not covered by an automated test (PhotoLightbox has no component harness); typecheck and UI build pass.
