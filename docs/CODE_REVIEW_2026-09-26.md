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

## 15. New: Smart Flows — describe a kind of photo, then auto-album or auto-move it

`smartFlowsService.ts` + `SmartFlowsModal.tsx` (opened from the Sidebar) let the user define named
rules like "a screenshot of a Facebook/LinkedIn post", "a photo of a UPI payment", "a scanned bill"
or "a visiting card", and either collect matches into an album or move them to a folder.

- **Why cloud-only:** these descriptions need real visual understanding of the photo's pixels, which
  the app has no offline model for (face detection is a different, narrower model). Classification
  reuses the Gemini/OpenAI key already configured in "Search with AI". There is deliberately no
  local/offline fallback — a flow simply can't run without a provider configured.
- **Consent:** because this sends photo content to a third party, each flow needs its checkbox ticked
  once before its first run; there's no default-on path.
- **Manual + capped:** a flow only runs when the user clicks "Run now", and asks how many not-yet-seen
  photos to send that run (default 200, capped by however many are left) — running a flow never
  auto-classifies the whole library, or new photos, without being asked.
- **State:** each flow remembers which photos it already classified and which matched, in
  `localStorage`, scoped to the current library folder (`gphotos_smart_flows_v1:<library dir>`), so a
  re-run only spends new API calls and a photo isn't reclassified every time. The album/move action is
  re-applied to every match so far, not just the new ones, so results accumulate across runs.
- **Actions:** "album" creates or reuses an album by name (`libraryStore.createAlbum`/`addPhotosToAlbum`
  + an immediate `flushSaveImmediately()`); "move" reuses the existing `movePhotosToFolder` flow
  (§12), so it gets the same restricted folder browser, confirmation and error handling.
- Known ceiling (marked `ponytail:` in the code): a moved photo gets a new id, so a "move" flow's
  `matches` record for it goes stale; if that same file is ever re-scanned under its new id it can be
  reclassified once more. Harmless (one extra API call), not worth id-rename tracking for this.

### Token/cost optimization: batching + a shared local cache

Two of the classification cost isn't paid per (photo × flow) any more:

- **Batched vision calls.** `aiSearchService.classifyImagesBatch` sends up to 8 photos to Gemini/OpenAI
  in one request (`smartFlowsService`'s `BATCH_SIZE`), amortizing the fixed prompt/instruction tokens
  across the batch instead of paying them per photo. Every call also asks for a general one-sentence
  caption + a few content tags for each photo (screenshot, receipt, document, ...), at no extra
  round-trip, regardless of whether it matched.
- **Shared local cache (`photoContentCache.ts`).** That caption/tags — and the exact verdict — are kept
  per photo, **shared across every flow**, not just the one that asked. Before spending an API call,
  `runFlow` checks `tryLocalMatch(photoId, description)`:
  1. an earlier flow already asked this *exact* (normalized) description of this photo → reuse its
     verdict outright, no call;
  2. otherwise a plain keyword-overlap check between the new description and the cached caption/tags —
     confident hit or a confident-empty miss decide it locally; anything genuinely ambiguous falls
     through (`null`) and is escalated online as usual.
  Every online result — match or not — is fed back via `recordFinding`, so tags accumulate over time:
  the more flows that have looked at a photo, the more likely the next new flow can be decided for
  free. A run's result reports `fromCache` alongside `classified`/`matched`/`failed`.
- This is a plain keyword heuristic (like `aiSearchService`'s existing `smartLocalNlp`), not embeddings
  — it trades a little precision on ambiguous cases for zero-cost, deterministic answers on clear
  ones; ambiguous cases still get a real vision call, so accuracy on "yes" answers isn't compromised,
  only occasionally re-asks something a smarter local model could have skipped.

- Tests: `smartFlows.spec.ts` — consent gate; one batched call for several photos in one run, and a
  second run only sends the still-unclassified ones; an unreadable photo fails without blocking the
  rest of its batch; a whole-batch API error fails every photo in it; move-action wiring; **a second,
  different flow reusing the first flow's cached verdict for an identical description with zero new
  API calls, and again via cached tags/caption alone for a differently-worded description**;
  delete/consent isolation between flows.

## 16. Smart Flows: local Ollama first pass, a RAG index per library, and tags shown in the photo viewer

Three follow-ups to §15, all keeping the same consent/cap/cloud-fallback guarantees:

### Photo detail panel shows the cached AI tags
`PhotoLightbox.tsx` now has an "AI Tags" card (next to Camera & Location) that shows a photo's
cached caption + tag chips, whenever any Smart Flow has ever classified that photo. It reads
`photoContentCache.getEntry()` synchronously and warms the cache's in-memory mirror once on mount
(`ensureLoaded()` + a re-render when it resolves), so tags from a *previous* session show up
without needing a flow to run again first. Nothing shown for a photo no flow has ever looked at.

### Local Ollama vision model as a free first pass
`ollamaVisionService.ts` talks to a locally-running Ollama server (`http://localhost:11434`) —
`qwen2.5vl:7b` for vision (chosen for its OCR/document-reading strength — the target categories
are UPI payments, bills, visiting cards, all dense-text images) and `nomic-embed-text` for
embeddings. `runFlow`'s pipeline is now three tiers, each only reached when the one before it
couldn't decide:
1. **Shared local cache/RAG index** (free, instant) — unchanged in spirit from §15.
2. **Local Ollama** (free, private) — same batched multi-image prompt as the cloud tier (shared
   via `visionClassify.ts`, so both tiers ask the exact same question the exact same way). Only a
   confident answer (`confidence >= 0.75`, `LOCAL_CONFIDENCE_THRESHOLD`) is trusted outright,
   matching the "local-only when confident" choice — anything shakier still gets a cloud call
   before being filed into an album or moved. Ollama being unreachable, or not having the vision
   model pulled, is detected once per run (`isVisionAvailable`) and just skips straight to the
   cloud tier — no error, no behavior change from before this existed.
3. **Cloud** (Gemini/OpenAI, as in §15) — whatever's left.
`RunFlowResult` now reports `fromCache` and `fromLocalModel` alongside `matched`/`failed`, and the
Smart Flows modal shows whether a local model was detected.

### A per-library RAG index, not just a cache
The photo caption/tags/verdicts cache moved out of `localStorage` into a new `photo_content` table
in each library's own SQLite database (`db.ts`/`libraryRepository.ts`, alongside `photos`/`faces`/
`albums` — same per-library-file pattern, new IPC handlers `photoContent:get(-all)`/`:upsert`).
Every fresh vision result (local OR cloud) now also gets a **text embedding** of its caption/tags
via Ollama (`embedText`, free/local, best-effort — null when Ollama isn't reachable), stored
alongside the caption. `photoContentCache.tryLocalMatch` uses it for real semantic matching: the
current flow's description is embedded *once per run*, then compared by cosine similarity
(reusing `clustering.ts`'s `cosineDistance`, the same math as face-descriptor matching) against
every candidate photo's cached embedding — a confident similarity decides the match locally;
anything in between falls through to the existing plain-keyword heuristic, then to Ollama, then to
the cloud. A `localStorage` fallback keeps this working under the browser shim / in tests, where
there's no per-library database file to write into.

- Verified the real Ollama HTTP contracts (`/api/chat` with multiple `images` messages + `format`
  instructions, `/api/embed`) against a synthetic throwaway test image before trusting the
  integration — response shapes matched what the code assumes.
- Tests: `smartFlows.spec.ts` (+3 — a confident local answer skips the cloud entirely, a
  low-confidence local answer still escalates, Ollama being unavailable falls straight through
  with no error), `photoContentCache.spec.ts` (sqlite-backed mirror warms once and is reused,
  localStorage fallback round-trips across a simulated restart, tag merging, exact-verdict reuse,
  confident/ambiguous/miss embedding similarity bands falling through to the keyword heuristic),
  `photoContentStore.spec.ts` (the new table: round-trip, upsert replaces not duplicates, per-library
  isolation, `getAllPhotoContentEntries`).

## 17. New: Album Chapters

An album can now be split into named "chapters" (e.g. a wedding album into "Day 1 — Ceremony",
"Day 2 — Reception"), purely additive — an album with no chapters looks and behaves exactly as
before.

- **Data model:** `Album.chapters?: AlbumChapter[]` (id, title, `photoIds` — a subset of the
  album's own `photoIds`), plus `Album.lastUsedChapterId`. A photo belongs to at most one chapter
  at a time (like a folder); `libraryStore`'s new chapter mutations (`createChapter`,
  `addPhotosToChapter`, `removePhotosFromChapter`, `deleteChapter`, `renameChapter`,
  `reorderChapters`, `getUnchapteredPhotoIds`) enforce that — adding a photo to one chapter strips
  it from any other. Deleting a chapter never deletes photos; they fall back to the album's
  default (no-chapter) bucket. `removePhotosFromAlbum` also strips a removed photo out of whatever
  chapter held it.
- **Album detail view** (`AlbumsView.tsx`) renders one section per chapter — via the new
  `AlbumChapterSection` component — instead of one flat grid, each with its own windowed photo
  grid (multiple `VirtualCardGrid`s stacked in one scroll container; it already measures its own
  position independently, so this needed no changes to that component). Unchaptered photos land in
  a trailing "Other Photos" section. Each chapter section shows an **auto-generated cover**: a
  live CSS collage of up to 4 of its own photo thumbnails next to its (editable, click-to-rename)
  title — per the decision to keep this a UI-only rendering, never a saved file, so it's never
  counted as a photo, backed up, or shown in the main gallery.
- **Adding photos asks which chapter:** the "Add Photos" picker modal gets a chapter `<select>`
  (only shown once the album has chapters) defaulting to `lastUsedChapterId`; a per-tile "move to
  chapter" button (a small popover, `ChapterPicker.tsx`) lets an already-placed photo be
  reassigned, or a brand new chapter created on the spot.
- **One-click "Add to Album" from the photo viewer:** `PhotoLightbox`'s quick-add buttons (and its
  full "Add to Album" modal) default straight to the album's last-used chapter in one click,
  labelled "Add to X → Chapter"; a small chevron opens `ChapterPicker` to pick a different chapter
  (or "No chapter") before adding, without changing the default for next time unless that chapter
  is actually used.
- Not built: drag-and-drop between chapters (reassignment is via the per-tile popover or the bulk
  "Add Photos" chapter selector instead) and the video-wizard feature the chapters are meant to
  feed into (planned as a separate follow-up, using bundled FFmpeg for MP4 output per the chosen
  approach).
- Tests: `albumChapters.spec.ts` (all `libraryStore` mutations: single-chapter-membership
  enforcement, delete keeps photos, rename/reorder, cross-effect on `removePhotosFromAlbum`),
  `albumChapterUi.spec.ts` (`AlbumChapterSection`'s collage/rename/delete/move-up-down,
  `ChapterPicker`'s list/pick/create-new/backdrop-close).

### Addendum: Ollama host/model settings UI

The host and model names were originally hardcoded constants with no way to change them. Added
`getOllamaConfig`/`saveOllamaConfig` (localStorage-backed, like `aiSearchService`'s own config) and
a small settings form in the Smart Flows modal (gear icon next to the Ollama status line — host,
vision model, embedding model, "Save & Re-check"). All three call sites
(`isVisionAvailable`/`classifyImagesBatchLocal`/`embedText`) read from it. Tests:
`ollamaVisionService.spec.ts` (defaults, persistence across a simulated restart, each call site
using the configured host/model, trailing-slash-safe URL joining, stray-prose JSON extraction,
graceful `null`/`false` on failure).

## 18. Documentation updated for everything in §12–17

`USER_MANUAL.md` (new §15 Albums & Chapters, §16 Smart Flows incl. Ollama setup steps) and the
in-app `public/help.html` (new "Albums & Automation" nav group, plus small additions to the
existing photo-editing and filtering sections for face-marker-click-to-reassign, auto-rotate,
drag-select and Ctrl+wheel anchoring) — previously undocumented since being built earlier this
session. Both explicitly say the video-from-album wizard isn't built yet, rather than describing
a feature that doesn't exist.

## 19. Ollama settings moved to Settings (desktop + mobile), with a model picker and in-app download

Followed up on §16/18's addendum per explicit feedback: the Ollama host/model settings lived only
inside the Smart Flows modal, with free-text model name fields and no way to see what's actually
installed. Moved to `SettingsView.tsx` (shared by the desktop Settings tab and the mobile web
view — same component, no separate mobile surface needed) as a "Local AI Model (Ollama)" card,
right below the AI Photo Search card:

- **Model pickers, not free text**: `ollamaVisionService.listModels()` (new) calls Ollama's
  `/api/tags` and returns each installed model's name/size/capabilities; the vision and embedding
  `<select>`s are populated from whichever models report the matching capability (`"vision"`/
  `"embedding"`). Falls back to listing every installed model when the server doesn't report
  capabilities at all (older Ollama), rather than showing an empty list for a model that would
  actually work.
- **Fetch/download help when nothing compatible is installed**: a "Recommended models to
  download" list (`qwen2.5vl:7b`, `minicpm-v:8b`, `moondream:1.8b` for vision; `nomic-embed-text`
  for embedding) appears whenever the picker has no matching option, each with a **Download**
  button. `ollamaVisionService.pullModel()` (new) streams Ollama's own `/api/pull` NDJSON progress
  and reports it live; cancellable via `AbortController`.
- **A real bug found while building this**: the default host was `http://localhost:11434`. On this
  dev machine, "localhost" resolved to the IPv6 loopback, where a *different* Ollama process (an
  empty one) happened to be listening than the IPv4 one with the actual models — silently
  indistinguishable from "no models installed". Changed the default to the literal `127.0.0.1` to
  remove the ambiguity entirely; a user-set host is unaffected.
- `SmartFlowsModal.tsx` keeps its live status line but no longer duplicates the settings form —
  a "Configure" button now navigates to Settings (`onOpenSettings`, wired in `App.tsx` via
  `setActiveTab('settings')`) and closes the modal.
- Tests: `ollamaVisionService.spec.ts` (+6 — `listModels` capability parsing and graceful failure,
  `pullModel` streaming progress/error/cancel, using a fake chunked stream body).

## 20. New: Create a Video from an Album (FFmpeg-based export wizard)

A 5-step wizard (`VideoWizardModal.tsx`, opened via a "Create Video" button in `AlbumsView.tsx`'s
album detail header) turns an album's photos into a real MP4, per the earlier decision to bundle
FFmpeg rather than rely on browser `MediaRecorder` (universal social-media compatibility, real
transitions/quality control).

- **Rendering** (`videoExportService.ts`, main process): every slide (a photo, an up-to-4-photo
  collage, or a generated title card) is first normalized to the *exact* output resolution via
  `sharp` (crop-to-fill, matching how Instagram/YouTube expect frames) — this keeps FFmpeg's own
  filter graph trivial (no per-clip scale/pad filters). `ffmpeg-static` bundles a real FFmpeg
  binary (GPL build, libx264) per-platform; `electron-builder.yml`'s `asarUnpack` covers it the
  same way as the ONNX/sharp native binaries, since a packed asar can't run a child-process binary.
- **Transitions**: built as an FFmpeg `xfade` filter chain (a pure, unit-tested
  `buildFfmpegArgs()` — the classic FFmpeg-wiki offset formula, `offset_i = sum(durations[0..i]) -
  td*(i+1)`) when a transition is chosen, or a plain `concat` filter for hard cuts / a single
  slide. Real sizes are used for aspect+resolution (e.g. 9:16 "1080p" is 1080×1920, matching
  Instagram/YouTube's own naming, not a mathematically-derived guess).
- **Progress + cancellation**: FFmpeg's own `time=` stderr output is parsed for encode progress;
  an `AbortController` (single-flight — one export at a time) lets the wizard cancel a running
  render; a `photo` that fails to prepare (unsupported format, missing file) is skipped and
  reported (`skippedSlides`) instead of failing the whole export.
- **IPC**: `video:choose-output-path` (native save dialog — the renderer never invents a raw output
  path itself), `video:export` (progress via `video:export-progress` events, mirroring the existing
  `photos:relocate-progress`/`photos:orientation-progress` pattern), `video:cancel-export`. Source
  photo paths and the output path are validated with the existing `assertPathsAllowed`.
- **A real bug caught by testing, not just written correctly on paper**: the first version of the
  wizard's slide-plan derivation skipped *every* grouped photo unconditionally, including the
  group's own insertion point — so a collage group was silently never added to the video at all. A
  component test that actually walks the wizard (group two photos, advance to Review, and assert
  the resulting slide count) caught this before it shipped.
- Tests: `videoExportService.spec.ts` (pure filter-graph/offset math across hard-cut/crossfade/
  single-slide cases; a real end-to-end render through the bundled ffmpeg binary against synthetic
  images, probing the output file's actual duration; a failed-to-read photo is skipped, not fatal,
  unless every photo fails), `videoWizardModal.spec.ts` (default all-selected state, uncheck/group
  interactions building the right slide plan, Generate wired to `exportVideo` with the built
  request, disabled until an output path is chosen).
- Not built: reordering slides within the wizard (follows album/chapter order), audio/music,
  Ken Burns pan/zoom on individual photos — all noted as such in the user manual.

## 21. Fixes: chapter creation, chapter drag-and-drop, and a full video-wizard rework

Follow-up on §17/20 per explicit feedback that both features didn't work as needed.

### "Create Chapter" did nothing
Root cause: `handleCreateChapter` used `window.prompt()` to ask for a name. Electron's support for
the native `window.prompt()` dialog is unreliable — depending on window/webPreferences settings it
can resolve immediately with `null` with nothing ever shown on screen, silently turning "click the
button, type a name" into "click the button, nothing happens". The same risky call also existed in
`SmartFlowsModal.tsx` (asking how many photos to check per run). Both replaced with a new, plain
in-app `PromptModal.tsx` (a styled React modal — title/message/input/confirm/cancel, Escape to
cancel) that has no dependency on native dialog support at all.

### Drag-and-drop between chapters
`AlbumsView.tsx`: each photo tile is now `draggable` (once the album has any chapters); a small
checkmark toggle (bottom-left of the tile) lets several photos be pre-selected so a single drag
moves the whole group via `dataTransfer` (a JSON array of photo ids). `AlbumChapterSection.tsx`
gained an `onDropPhotoIds` prop — its root becomes a drop target (dashed highlight while dragging
over it) that calls `addPhotosToChapter`; the "Other Photos" bucket is a drop target the same way,
calling a new `libraryStore.removePhotosFromAllChapters()` (strips the dropped ids out of whichever
chapter(s) they were in, regardless of source — handles a mixed-origin multi-select drop cleanly).
The existing per-tile "move to chapter" popover is unchanged, kept alongside drag as an alternative.

### Video wizard: reworked to match the requested flow
Restructured from 5 steps to 4, moving reordering and the save-location picker to where they were
asked for:
1. **Group Photos** — collage grouping only (no include/exclude here anymore).
2. **Arrange Slides** (new) — every resulting slide (photo or collage) in one reorderable list:
   native HTML5 drag-and-drop **and** up/down arrow buttons (the buttons are there specifically so
   reordering isn't solely dependent on drag, which is harder to get exactly right and to test),
   plus a checkbox per row to leave a slide out of the video without touching the album/chapters.
3. **Video Settings** — unchanged content, but now also has the **"Choose Where to Save"** picker
   (previously on the last step) and a "Quality / Generation Speed" label (was "Quality") to make
   the speed tradeoff explicit.
4. **Review & Generate** — on success, the finished video **now opens automatically** in the OS
   default player (`shell.openPath` via a new `video:open-file` IPC handler, path-validated with
   the existing `assertPathsAllowed`), with "Open Video" and "Show in Folder" still offered
   manually. The live progress bar (preparing/encoding) was already wired correctly in §20; this
   pass didn't find a defect there, just moved it to the right step.

**A real bug in the collage-grouping insertion logic**, again caught by a test that walks through
real interactions rather than checking internals in isolation: the original derivation skipped
*every* grouped photo unconditionally when building the slide plan — including the group's own
insertion point — so a collage was silently absent from the plan sizing / order shown in step 2
(it collided with the earlier §20 bug on the same logic, in the rewritten version's step 1/2 split;
fixed the same way, verified by a test that groups two photos and asserts the resulting slide list
and count).

- Tests: `promptModal.spec.ts` (new — submit/cancel/backdrop/Escape/validation),
  `albumChapters.spec.ts` (+2 — `removePhotosFromAllChapters` across chapters and as a no-op with
  none), `albumChapterUi.spec.ts` (+2 — drop-target wiring, and rendering fine without the prop),
  `videoWizardModal.spec.ts` (rewritten for the new 4-step flow — grouping/ungrouping preserves
  slide position and count, Arrange Slides checkbox exclusion and both reorder mechanisms feed the
  right order/set into `exportVideo`, output-location on the settings step, auto-open on success).

## 22. Album ordering + wizard round 3: chapter-grouped step 1, collage styles, transition modes, default save path

### Album view
- **"Other Photos" disappears when empty.** Its section (and drop target) now renders only while at
  least one photo is in no chapter (it briefly always showed a placeholder). A photo can still go
  back to "no chapter" through its move-to-chapter popover, so nothing becomes unreachable.
- **Ordering photos inside a chapter.** `libraryStore.addPhotosToChapter` gained an optional
  `insertBeforePhotoId`, and now strips the moved ids from *every* chapter — including the target —
  before re-inserting, so one operation serves both "move in from elsewhere at a position" and
  "reorder within this chapter". Each tile in a chapter is a drop target (with `stopPropagation`,
  so the section-level "append at end" drop still handles drops on empty space); dropping a photo
  on itself is a no-op. `renderPhotoTile` now takes the chapter it is rendered in as context.

### Video wizard
- **Step 1 follows the album.** Slides start in album order (each chapter's photos in chapter
  order, then unchaptered ones) instead of the flat `photoIds` order, shown under chapter headings
  (`SlideEntry.chapterTitle`; headings only when the album has chapters). This is also the default
  order for step 2.
- **Collage styles.** "Group as Collage" opens `CollageStylePicker` — a live preview of Grid /
  Side by Side / Stacked / Featured built from the selected photos. The layout math was extracted
  into a pure shared module (`src/types/collageLayout.ts`, `computeCollageTiles`) used by *both*
  the popup previews and `videoExportService.renderCollageImage`, so a preview is exactly what is
  rendered; `videoExportService` re-exports it. The style rides on the slide
  (`VideoSlideInput.collageStyle`). I checked the compiled `dist-electron` output can load the
  shared module at runtime, since type-only imports had never proved that path.
- **Transition modes.** Single (one effect, incl. hard cut), Random (a different real effect per
  cut) and Pick several (random among the ticked effects). `buildFfmpegArgs` now takes either one
  transition or a per-cut list; a stray `none` in a list becomes `fade` (a hard cut can't be mixed
  into one xfade chain), and the duration maths is unchanged. The random picks are made once at
  Generate time.
- **Default save path** `<library>/videos/<album name>.mp4`, prefilled when the wizard opens; the
  service creates the missing folder. "Change Location" opens the dialog on that path.
- **A latent bug found on the way:** `video:export` ran the path allow-list on the output path, so
  a location chosen in the save dialog *outside* the library roots (Desktop, another drive) would
  have been rejected, contradicting the "native dialog picks work anywhere" convention used
  elsewhere. Dialog-chosen paths are now remembered in-process and accepted (also for
  `video:open-file`); anything else still has to pass the allow-list, and the output must be `.mp4`.
- Tests: `albumChapters.spec.ts` (+2: reorder within a chapter, positioned arrival from another
  chapter), `videoExportService.spec.ts` (+9: per-cut transitions, stray-`none` fallback, layout
  invariants for every style — inside the frame, no overlaps —, style-specific shapes, and a real
  render with styled collages + a per-cut list + a missing nested output folder),
  `videoWizardModal.spec.ts` (+8: chapter headings/order, no headings without chapters, the style
  popup and the chosen style reaching the request, cancelling it, all three transition modes, the
  default path and Change Location).

## 23. Ollama model download failed in the packaged app (403), and a lightbox view-mode control

### Root cause of "I can't download a model"
The packaged window is loaded with `loadFile` (a `file://` page), so every `fetch` from the
renderer carries `Origin: null`. Ollama's origin check answers **403** to that (verified against the
real server: `Origin: null` and `gphoto://…` → 403; `file://` and `http://localhost:5173` → 200/204).
Listing models and downloading them are both such requests, so both failed — but everything worked in
the Vite dev server (`http://localhost:5173` is allowed), which is why it was missed. The same
403 also silently disabled the Smart Flows local tier (`/api/chat`, `/api/embed`) in the packaged app.

Fix: all Ollama traffic now goes through the **main process** (`ollamaClient.ts`; Node's `fetch` sends
no Origin header, so there is nothing to reject). IPC: `ollama:request` (JSON calls),
`ollama:pull` (+ `ollama:pull-progress` events, one download per model, `ollama:cancel-pull`). The
handler only accepts http(s) addresses and `/api/` paths. `ollamaVisionService.ts` uses the bridge
when it exists and keeps the direct fetch only as the fallback for a plain browser / dev server /
tests. The failure reason ("Could not connect to Ollama — is it running?", Ollama's own
"model not found", …) is kept (`getLastOllamaError`) and shown in Settings and in the error notice,
instead of one generic sentence. The browser/phone view cannot reach the desktop's Ollama, so
that screen says so instead of appearing broken.

Tests: `ollamaClient.spec.ts` runs against a real local socket that, like Ollama, rejects any request
carrying an Origin header (proves none is sent), plus POST bodies, error bodies, unreachable server,
address/path validation, NDJSON pulls split across chunks, an error line, and cancel;
`ollamaVisionService.spec.ts` (+6) proves the desktop path uses the bridge *instead of* fetch, relays
only the right model's progress, exposes the failure reason and cancels via IPC.

### Lightbox: Fit / Fill / 1:1
Three buttons beside the zoom controls. The lightbox lays the picture out "fitted" and scales the
stage by `zoom`, so each mode is a zoom factor computed from what is on screen
(`viewModeZoom.ts`, pure and unit-tested): Fit = 1; Fill = enlarge until one side reaches the edge
(never below 1, aspect kept — not a distorting stretch); 1:1 = natural width / shown width (pan by
dragging, using the existing zoom>1 pan). The mode is remembered in `localStorage` and re-applied
when each photo loads (plus once after a photo change, for an already-cached picture whose load
event fires before the zoom reset).

## 24. Gallery "No Album" filter

New filter chip on the main gallery (`GalleryView.tsx`, `filterType: 'noalbum'`) showing visible photos that
are in no album. Membership is the union of every album's `photoIds` (chaptered photos are always also in
`photoIds`, so chapters need no special case). Because albums are edited *in place* (same array, same
objects — the app only shallow-copies the state object), the set is memoized on a cheap fingerprint
(id + `updatedAt` + size per album) instead of the array reference; keying on `albums` would have gone
stale after the first add/remove. Hidden (excluded) photos stay hidden, like in "All".
Tests: `galleryNoAlbumFilter.spec.ts` (real `GalleryView`, timeline stubbed): filter result, chapters, no
albums at all, live update through `addPhotosToAlbum`/`removePhotosFromAlbum`, and back to All.

## 25. Video wizard: music (local file or YouTube via yt-dlp), and a designer for title screen / end credits

Requested: a screen to pick a song (disk or YouTube link, start/end time, repeat to fill the video), and a
title-screen designer that fits the video size (a vertical video had its title run off-screen), reused for
optional end credits. The wizard is now 6 steps: Group, Arrange, Settings, **Music**, **Title & Credits**, Review.

**Root cause of the off-screen title.** `renderTitleSlide` drew the title as one unwrapped SVG line at 7.5% of the
frame *height*; on 1080x1920 that is ~144 px type, so a 50-character title was ~4,000 px wide in a 1080 px frame.
Fix: one pure layout, `layoutText` in `src/types/slideDesign.ts` (word-wrap → break over-long words → shrink the
font up to 40 steps → clamp the block inside a 4% margin), used by the designer preview, by the final card render
and by the main-process fallback title. Text size is a percentage of the frame's **shorter side** (a real render
showed "% of height" still gave portrait video oversized type that wrapped into the subtitle; short side leaves
landscape/square unchanged). Frame sizes come from one shared `src/types/videoFormat.ts`.

**Designer (renderer).** `SlideDesigner.tsx` + `services/slideDesignRender.ts`. The preview canvas has the video's
real pixel size (only CSS-scaled), so preview, drag hit-testing and the final card run the same code. The card is
rendered at generate time to a JPEG data URL and sent as a `kind: 'card'` slide with its own `seconds`; the
exporter fits it with sharp (`prepareCardImage`, only `data:image/(png|jpeg|webp);base64`) — an unreadable card is
skipped and counted, like a bad photo. A photo background that cannot be loaded aborts with a message instead of
silently rendering a plain card. Title first, credits last; per-slide durations feed `buildFfmpegArgs` (the xfade
offsets use each slide's real length) and the wizard's length estimate.

**Music.** `exportVideo` cuts `[start,end)` to a PCM wav (`-ss/-to` before `-i`), then feeds it as a second-pass input
(`-stream_loop -1` when repeating), `-t <video length>`, optional `volume` and a fade-out clamped to the video
length. Music shorter than the video without repeat ends early (the video keeps its length); longer is cut. A file
with no readable audio fails with "Could not use the chosen music" rather than exporting silently. Files come only
from the native open dialog or our own download (`userApprovedAudioFiles`), and `video:export` refuses any other
audio path.

**YouTube via yt-dlp** (`services/ytDlpService.ts`). Not bundled (YouTube breaks old copies within weeks). On demand:
the official release asset for the platform is downloaded to `<userData>/tools`, its SHA-256 compared with the
release's `SHA2-256SUMS` (missing entry or mismatch → discarded, nothing installed), then `--version` must run. A
yt-dlp on PATH is used when present. Downloads: YouTube hosts only (`youtube.com`, subdomains, `youtu.be` — look-alikes
such as `youtube.com.evil.com` are rejected), spawned with an argument array (no shell), `--no-playlist`, our ffmpeg via
`--ffmpeg-location`, mp3 output into `<userData>/audio_downloads`, and the address placed after `--` so it can never be
read as an option. Progress and cancel are wired through IPC; yt-dlp's stderr is translated into plain messages
(private, unavailable, rate-limited, bot check, offline). One download/install at a time. The UI reminds the user to use
music they have the right to use.

**Verification.** `slideDesign.spec.ts` (layout, incl. the vertical regression and short-side sizing),
`videoAudioAndCards.spec.ts` (real ffmpeg: card slide, trimmed+looped music, short/long music, non-audio file),
`ytDlpService.spec.ts` (27: URL validation, checksum parsing, install against a local server incl. tamper/missing
checksum, a stand-in yt-dlp script for arguments/progress/failure/cancel), `videoWizardDesignAndMusic.spec.ts` (25) and the
updated `videoWizardModal.spec.ts`. Two checks outside the suite: the real canvas code was run in a throw-away headless
Electron (own temp profile) to render title cards at 1080x1920 and 1920x1080 and inspect them — that is what exposed the
short-side sizing issue — and the real yt-dlp release was installed into a scratch folder (checksum verified, `--version`
ran, resolved as the managed copy). A real YouTube download was not run in the automated checks.

Known limits: a single word wider than the frame is broken across lines rather than shrunk; texts do not avoid each
other (each is placed independently — drag them apart); the preview audio is the first 20 s of the chosen section.

## 26. Video wizard: built-in royalty-free music library (20 tracks)

Requested: 20 royalty-free tracks the user can pick from a list showing name, artist and an image.

**Source and licence.** Kevin MacLeod / incompetech.com — the one catalogue with a public JSON index
(`pieces.json`) and stable direct mp3 URLs. Licence: Creative Commons Attribution 4.0, which allows use in
videos (including monetised) **provided a credit is shown**; the wording is taken from incompetech's own FAQ
("Title — Kevin MacLeod (incompetech.com), Licensed under Creative Commons: By Attribution 4.0,
creativecommons.org/licenses/by/4.0/"). Twenty tracks were chosen for photo slideshows across six moods
(upbeat, relaxed, emotional, cinematic, playful, acoustic); every URL was checked (HTTP 200) and the sizes and
durations in the catalogue are the real ones.

**Not bundled.** 20 tracks are 166 MB, which would triple the installer, so `src/types/musicCatalog.ts` holds only
data (id, title, category, file, duration, size, mood words) and `services/musicLibraryService.ts` downloads a track
on first use into `<userData>/music_library`, streaming to a `.part` file that is renamed only when complete
(anything under 50 KB, e.g. an error page, is rejected). The renderer sends a track **id**, never a URL, so only
catalogue tracks can be fetched; `music:fetch-track` then probes the file with ffmpeg and deletes it if it has no
audio. Downloads share the single-flight/cancel/progress channel of the YouTube download. No checksum is pinned on
purpose: incompetech re-issues files (one has a "2" in its file name), so a pin would silently break the feature;
the audio probe is the integrity check instead.

**Images.** incompetech publishes no per-track artwork, and hot-linking third-party images would need the network
just to draw a list. Each track therefore gets generated cover art: a mood-coloured gradient with a mood icon, a
slightly different shade per track (`MusicCover`).

**Credit is automatic.** `MusicSelection` carries `credit` for library tracks. The wizard adds a normal, editable text
line (id `music_credit`) to the credits design and turns the credits screen on; changing to another track replaces
it, and a local/YouTube file or Remove takes it off. The credits tab warns if the screen is off or the line was
deleted while a credited track is selected. "Reset design" re-adds the line.

**Verification.** `musicLibrary.spec.ts` (9: catalogue shape, URL encoding, credit text, and the downloader against a
local server — download once then cache, HTTP error, truncated file, unreachable, cancel with nothing left behind);
`videoWizardDesignAndMusic.spec.ts` (34, +9: list content and cover art, mood filter, Use/Preview, failure, credit
added / replaced / removed / warned). Outside the suite: one real track (Easy Lemon) was downloaded from
incompetech.com into a scratch folder — byte size equal to the catalogue, ffmpeg reads it as 126 s of audio — and used
as looped music in a real export (output has audio and video, 6 s). The other 19 were only checked for a live URL.

## 27. Fix: album chapters were never saved to disk

**Root cause.** Chapters (§17) were added to the renderer's `Album` objects, but the database layer was never taught about
them: the `albums` table has only title/description/cover/dates and `album_photos` holds only the album's own photo
order, so `upsertAlbum` silently dropped `album.chapters` (and `lastUsedChapterId`) on every save and `getAllAlbums`
could not return them. Chapters therefore existed only in memory until the app was closed. (The renderer side was fine:
every chapter edit calls `notify()`, which schedules a save that sends the full album list.)

**Fix.** `albums` gains two columns — `chapters_json` (the chapter list, including each chapter's photo order and cover)
and `last_used_chapter_id` — added to existing databases by `ensureColumn` on open, so no manual migration and no data
loss. `upsertAlbum` writes them; `getAllAlbums` reads them through `parseChapters`, which repairs what the album no longer
matches (photos that left the album, a photo listed in two chapters — first one wins, a cover or last-used id that no
longer exists) and treats unreadable JSON as "no chapters" rather than failing the album list. Empty chapters are kept.
`remapPhotoIdInDb` (moving photos to another folder changes their ids) now re-points ids inside the chapters as well, in
the same transaction. Zip backup/restore, the mobile web server, library switching and startup load all go through these
same functions, so they pick chapters up without further changes.

**Limit.** Chapters created before this fix were never written, so they cannot be recovered from disk; any that are still
open in a running old build are lost when it closes. Chapters made from now on persist.

**Tests.** `albumChaptersPersistence.spec.ts` (12): survive a real close-and-reopen of the database (order, cover,
last-used), empty chapters, renderer-style whole-list save incl. clearing, rename/move, no-chapter albums unchanged,
per-library isolation, the self-repair cases, an old database upgraded in place, id re-pointing on photo move, and the
real `handleStorageSave` → restart → `handleStorageLoad` path.

## 28. Album: gallery-style multi-select and a chapter drop bar while dragging

Requested: the same selection as the gallery (checkbox, press-and-drag to select many) so several photos can be dragged to a
chapter, and — while dragging — all chapters shown as targets at the top/side so the user never has to scroll to one.

**What existed.** Selection was a bottom-left circle shown only in albums that already had chapters, with no drag-select, and
a drag could only be dropped on a chapter section that happened to be on screen.

**Selection.** `components/albumSelection.tsx`: `useMarqueeSelect` gives a rubber band over the tiles (each tile carries
`data-album-photo-id`). It starts on empty space or on a tile's checkbox (`data-marquee-start`), never on the photo (a press on a
photo still opens/drags it), ignores buttons/inputs/links, needs 4 px of movement (so a click is a click), and is anchored to
the *content* so it stays right when the container scrolls. Ctrl/Cmd/Shift or a checkbox start ADD to the selection; a plain
background press replaces it and a plain background click clears it. Because the grid is windowed (off-screen rows are not in
the DOM) each tile's last hit-test result is remembered, so a photo scrolled out of the band keeps its state; near the top/bottom
edge the container auto-scrolls while the button is held. The click browsers fire after a drag that began and ended on a
checkbox is suppressed for that task only. `mousedown` is default-prevented on a background/checkbox start (no text selection, and
no native drag from the checkbox), and tiles are also `draggable={false}` while a band is armed. The checkbox is now on every tile
(not only in chaptered albums); with a selection, a plain click toggles instead of opening the photo (as in the gallery).

**Drop bar.** While a native drag is in progress, `ChapterDropBar` — `position: fixed` at the top of the photo area, so showing it
does not move the page under the cursor — lists every chapter (with counts) plus "Other Photos (no chapter)", highlights the one
under the pointer and performs the same move as dropping on a section. It is shown from a `setTimeout`, because changing the page
inside `dragstart` can make the browser cancel the drag. It is put away on drop, on `dragend` from the tile, and by document-level
`dragend`/`drop` listeners — the windowed grid can unmount the dragged tile, in which case its own `dragend` never arrives. Dragging
several selected photos uses a "N photos" drag image; dragging a photo outside the selection moves just that one.

**Selection bar.** Pinned to the bottom of the photo area while something is selected: count, "Move to chapter…" (the existing
`ChapterPicker`, including "New chapter" which now creates the chapter *with* the selected photos via `createChapter(album,
title, ids)`) and a clear button. This also covers touch screens, where HTML5 drag-and-drop does not work, and albums with no chapters.

**Verification.** `albumSelectionUi.spec.ts` (24, real `AlbumsView`, the windowed grid replaced by a plain list and tile rectangles
supplied, since jsdom has no layout): checkboxes everywhere, click vs toggle, Ctrl-click, band selects exactly the touched tiles and
shrinks back, replace vs add, checkbox start, follow-up-click suppression, no band from a photo/button, click-to-clear, the drop
bar's contents and count, drop → moved, multi-drag, unselected-photo drag, "Other Photos", dragend / detached dragend, selection
bar hidden while dragging, and the selection-bar move / new-chapter paths. **Not verified:** real mouse-driven native drag-and-drop in
Chromium (jsdom cannot start one) and the auto-scroll — both are covered only by reasoning and by the tests' simulated events, so
they are worth a quick manual try.

## 29. Settings tabs, Smart Flows scoped to an album, and an "AI Info" panel in Photo Details

Four small requests bundled together.

**Sidebar label.** "Settings & Mobile" (desktop sidebar) and "Settings & Mobile Server" (mobile drawer) both
just say **Settings** now — the tab itself still covers mobile/LAN sharing, just under its own tab (below).

**Settings is now tabbed.** `SettingsView.tsx` was one 2000+ line scroll of eight stacked cards. A new shared
`components/TopTabs.tsx` (a plain underline tab bar, no boxes/pills) sits at the top, and each card is wrapped in
`{activeSettingsTab === 'x' && (...)}` — no card's own JSX changed, only which ones render. Six tabs, grouping the
eight original cards: **General** (background sync + performance throttling), **Mobile & Sharing** (the old
Section 0), **Search with AI** (the AI-search card + the Ollama card, previously two separate scrolls apart),
**Duplicates**, **Backup**, **Logs**. The autosync feedback banner stays above the tab bar (it's already
self-clearing after a few seconds) so it's visible regardless of which tab is open. `TopTabs` takes a `size` prop
('md' for this page-level bar, 'sm' for a compact one) so the same component serves Photo Details below.

**Smart Flows can run against one album.** `runFlow()` already took an arbitrary photo array — nothing to change
there. `SmartFlowsModal` gained an `albums` prop and a "Run against" `<select>` (only shown when the library has
albums) next to the Ollama status line, defaulting to the whole library; picking an album filters the photos
passed to `runFlow` and the cap-prompt's "N left" count to that album's `photoIds`. `App.tsx` now passes
`albums={libraryState.albums}`.

**Photo Details: an "AI Info" panel with tabs.** The old inline "AI Tags" block (caption + tags only) is now
`components/PhotoAiInfoPanel.tsx`. An **Overview** tab keeps the caption/tags (with an explicit "nothing yet"
state instead of an empty card). A photo already checked by more than one Smart Flow also gets a **Smart Flows**
tab: each flow the photo has an entry for (`entry.verdicts[normalizeDescription(flow.description)]`, the same
lookup `photoContentCache` itself uses) is listed with its name, a check/cross for match, and its confidence —
letting the user see exactly what has been extracted about a photo and by which of their own rules, not just
whether it ended up in an album. No tab bar is shown at all when there's only one thing to show (plain caption/tags,
no flow has checked this photo more than once) — two tabs isn't worth showing for one section of content.

**Verification.** `settingsTabs.spec.ts` (3): default tab, only the active tab's cards are in the DOM and swapping
works, a General-tab action's feedback survives a tab switch. `smartFlowsModalScope.spec.ts` (6, `runFlow` mocked):
the picker lists the library + every album, whole-library is the default and sends everyone, picking an album
scopes the photos sent and the cap-prompt count, an empty album sends nothing, no albums hides the picker entirely.
`photoAiInfoPanel.spec.ts` (5): overview-only photo has no tab bar, an empty entry says so, a photo with two flow
verdicts gets both tabs with correct match/confidence text, an unrelated flow is left off the list, and the
description-normalization lookup matches `photoContentCache`'s own. Full suite: 657 passing (two known
load-sensitive timing specs — `heicWorkerClient` responsiveness, an ffmpeg-timing case in
`videoAudioAndCards` — failed only under full-suite parallel load and passed cleanly alone; unrelated to this change).

## 30. Fix: "Run now" showed no progress, and could be silently blocked with no cloud key set

**Reported.** A flow ("identify food dishes -> album") was consented and run; nothing visible happened.

**Root cause #1 — the Run button was gated on a cloud API key that a working setup may not need.**
`providerReady` required `provider === 'gemini' || 'openai'` *with a saved key*, and the button was
`disabled={!providerReady || ...}`. The default provider is `'local'` (no cloud at all), and the whole
point of the local-Ollama-first / shared-cache passes is that a flow can fully resolve without ever
touching the cloud — but the button didn't know that, so it silently refused to run. There was no
message explaining *why* nothing happened; the passive "flows can be created but can't run yet" banner
is easy to miss, and the button gives no feedback when disabled.

**Root cause #2 — the only feedback while running was a single line of text on the flow's own row**
(`Running... {done}/{total}`), which could sit at "0/0" for a while (cache pass is synchronous but the
`embedText`/`isVisionAvailable` calls before it are network round-trips) and looked identical to nothing
happening at all. A cloud failure (e.g. "no API key set") was swallowed into a `console.warn` and a
generic "N failed" toast — the actual, actionable reason never reached the UI.

**Fix.**
- The Run button no longer depends on `providerReady` — only on consent. The "no cloud key" banner is
  now purely informational ("...flows still run using the shared cache and a local Ollama model if
  one's available; anything that genuinely needs the cloud will show an error in its run log").
- `runFlow()` (`smartFlowsService.ts`) gained an optional `onLog(line)` callback alongside the existing
  numeric `onProgress`, emitting one `{ index, total, photoId, fileName, level, message }` line per
  photo per pass: a cache hit ("Already described — matches/does not match"), before a local-model
  batch ("Trying the local Ollama model..."), a low-confidence local result ("...unsure — escalating to
  the cloud"), before a cloud batch ("Sending to the configured cloud AI provider..."), an unreadable
  photo, and — the actual bug — a failed cloud call now logs **the real thrown message** per photo
  (`classifyImagesBatch` already throws "Set a Gemini or OpenAI API key..." — it was being discarded).
  A run with nothing to check, or nothing new, logs one explanatory line instead of nothing. A final
  summary line closes out the log. `onProgress`'s signature is unchanged, so every existing caller/test
  needed no changes.
- Clicking "Run now" and confirming the cap now opens `components/SmartFlowRunModal.tsx`: the flow's
  name/description/action, its source ("Whole library" or the chosen album, with how many photos are
  in scope), a progress bar, and the live scrolling log (colour-coded by level, auto-scrolling), ending
  in a summary line + Close button. Closing it does not cancel the run (`runFlow` has no abort signal)
  — it keeps going in the background and the flow list's counts still refresh via `onFinished`. Only one
  flow can run at a time (every row's button disables while any run modal is open).

**Verification.** `smartFlows.spec.ts` gained an `onLog` describe block (6 tests) including the exact
reported scenario: no cloud provider configured, `runFlow` still completes (doesn't throw/hang) and every
affected photo's log line carries the real "Set a Gemini or OpenAI API key..." message. `smartFlowRunModal.spec.ts`
(7): header/source/progress/log rendering, log formatting and colour, the finishing summary + Close, the
X closing immediately, `onFinished` firing on settle. `smartFlowsModalScope.spec.ts` gained a second describe
block (4 tests) reproducing the bug at the modal level: the button is enabled with no cloud key configured,
"Run now" opens the log modal, only one flow can run at a time, closing re-enables the buttons. Full suite:
676 passing.

## 31. "Run Smart Flow" on a selection (Photos gallery and Albums)

Requested: a button, shown when the user has multiple photos selected, to run a Smart Flow on just those.

**Scope model generalized.** `SmartFlowsModal`'s "Run against" picker already chose between the whole
library and one album (§29/30). It gained a third option, **`preselectedPhotos`**: an optional prop —
the photos the user had selected when they opened the modal via the new button, rather than via the
sidebar. When present, "Selected photos (N)" is listed first and is the scope the modal opens on; the
user can still switch to the whole library or an album from the same dropdown, same as before. Because
the modal is a single long-lived instance (`App.tsx` toggles `isOpen` rather than mounting/unmounting
it), the scope is re-defaulted in a `useEffect` keyed on `isOpen` so a later plain "Smart Flows" open
from the sidebar doesn't inherit a stale selection-based default.

**The button itself.** A `Wand2`-icon **"Run Smart Flow (N)"** button (disabled with nothing selected)
sits next to the existing bulk actions:
- **Photos gallery** (`GalleryView.tsx`, desktop bar and the compact mobile bar) — next to "Add to
  Album", behind a new `onRunSmartFlow?: (photos: Photo[]) => void` prop.
- **Albums** (`components/albumSelection.tsx`'s `AlbumSelectionBar`, used by `AlbumsView.tsx`'s
  gallery-style multi-select from §28) — next to "Move to chapter…", behind the same prop shape,
  threaded through `AlbumsView`'s own new `onRunSmartFlow` prop.

Both resolve the button's click to actual `Photo[]` objects (not just ids) before calling the handler.
`App.tsx` holds one `smartFlowsPreselect` state set by a shared `handleRunSmartFlowOnSelection`, passed
as `onRunSmartFlow` to both `GalleryView` instances (Photos, Favorites) and `AlbumsView`, and as
`preselectedPhotos` into the single global `SmartFlowsModal`; it's cleared whenever the modal is opened
from the sidebar instead, or closed.

**Verification.** `gallerySmartFlowButton.spec.ts` (4): hidden with no handler, appears and is
enabled/disabled correctly, hands back the real selected `Photo[]` on click. `albumSelectionUi.spec.ts`
gained a describe block (2 tests) covering the same on the album selection bar. `smartFlowsModalScope.spec.ts`
gained a describe block (5 tests): the scope picker defaults to and lists "Selected photos" first, running
with that default checks only those photos, switching back to the whole library still works, no
preselection falls back to the previous whole-library default, and the cap prompt says "in your selection".
Full suite: 687 passing.

## 32. "Search with AI": @person / #place mention autocomplete

Requested: typing "@" offers people, "#" offers places, both filtered by "contains" (so "bhavsar" matches
both "Sachin Bhavsar" and "Bhavsar Tarun").

**New shared component**, `components/MentionAutocompleteInput.tsx`: a drop-in replacement for a plain
text `<input>` that takes `sources: MentionSource[]` (one per trigger character, each with its item list
and an empty-state label). On every keystroke it looks at the text immediately before the caret for a
trigger character that starts a token (`(?:^|\s)([@#])(\S*)$` — so `@` only opens the list at the start of
a word, never mid-word as in "user@host"), filters that source's items with a plain case-insensitive
`.includes()` (contains, not prefix — exactly what was asked for), and shows up to 8 matches, deduplicated
and alphabetised. Picking one (click, or Enter/Tab while highlighted) replaces the trigger + partial text
with the item's plain name plus a trailing space — the final text is ordinary language with no leftover
`@`/`#`, e.g. "Photo of Sachin Bhavsar in Udaipur". Arrow-key/Home/End caret movement also re-checks for
an existing mention (so arrowing back into an earlier `@name` reopens its list), separately from the
plain typing path. Escape closes just the list — it calls both the React-synthetic and the underlying
native `stopPropagation()`, because a plain `window`-level Escape handler (App.tsx has one, to close
whichever modal is open) sits **outside** React's synthetic event system and only the native call reliably
stops it; verified in a test with a real `window` listener standing in for that handler.

**Wired into the AI search box** (`AiAssistantModal.tsx`, the "Ask AI" chat, previously undocumented in the
user manual — added as new §18/`#ai-photo-search`): `@` offers `people` (already a prop) with placeholder
auto-clustered names ("Person 12", not yet given a real one) filtered out — they aren't a meaningful thing
to search by yet; `#` offers a new `places?: PlaceAlbum[]` prop, wired from `App.tsx`'s `libraryState.places`
(the same data `PlacesMapView` uses). Only this one search box was in scope — Smart Flows' own description
field was left as a plain textarea.

**Verification.** `mentionAutocompleteInput.spec.ts` (14): no-op on plain text, `@`/`#` open their own
list, contains-filtering (the exact "bhavsar" case) and case-insensitivity, mid-word `@` ignored, empty
state, click-to-pick inserts the plain name, arrow-key list navigation + Enter/Tab to pick, arrowing back
into an earlier mention reopens its list, Enter with nothing open submits, Enter with zero matches falls
through to submit instead of getting stuck, and the Escape/window-listener non-bubbling proof above.
`aiAssistantMentions.spec.ts` (4): the real modal offers real people/places, excludes placeholder names,
inserts the picked name into the actual search box, and copes with no `places` prop at all. Full suite:
705 passing.

## 33. Fix: "#place" search picks didn't actually filter photos

**Reported.** Using the new `#place` autocomplete (§32) and running the search didn't use the location properly.

**Root cause, two separate bugs, both from the same source: place names are stored as combined "City,
Country" strings** (`PlaceAlbum.name` = `${city}, ${country}` when both are known — `catalogService.ts`'s
`placeKeyAndName`), which is exactly what `#` inserts into the query text — but nothing downstream was
built to expect a comma-combined value:

1. **Local NLP (no cloud provider configured, or a cloud call failed) never saw a location at all.**
   `smartLocalNlp`'s only location detection was a regex requiring a preposition immediately before the
   place — `in andaman`, `at goa`. The `#` mention inserts the bare name with nothing in front of it
   (e.g. "Photo of Udaipur, India"), so the regex simply never matched and `locationQuery` stayed unset —
   the location was silently dropped, not "used improperly" so much as never read.
2. **Even when a `locationQuery` WAS produced** (cloud LLM path, which can return the combined string
   verbatim since that's literally what appeared in the query text), `applyFilter`'s matching checked
   whether ONE of a photo's `label`/`city`/`country` fields **contained the whole combined string** —
   but a photo's `city` is just `"Udaipur"` and its `country` is separately `"India"`; neither field ever
   contains the combined `"Udaipur, India"`, so the filter matched nothing.

**Fix**, `aiSearchService.ts`:
- New `collectKnownLocationValues(photos)` (shared by both cloud prompts' `knownLocations` list, unchanged
  in spirit, and the new local detection below).
- `smartLocalNlp` now checks, before the preposition regex, whether any of the library's own known
  city/country/label values is mentioned **anywhere** in the query — the same technique the function
  already used for people (`foundPeople`, matched anywhere, no preposition needed) — and uses that known
  value's own casing as `locationQuery`. The preposition regex is kept as a fallback for a place not yet
  geotagged in the library at all.
- `applyFilter`'s location filter now splits `locationQuery` on commas and requires **every** part to
  appear somewhere across a photo's own `label`+`city`+`country` (joined into one haystack) — so "Udaipur,
  India" matches a photo whose city/country are stored separately, a right-city-wrong-country combination
  is correctly excluded, and a single bare place name still works exactly as before.

**Verification.** `aiSearchLocation.spec.ts` (10, new — `aiSearchService` had no prior tests at all):
`smartLocalNlp` recognises the exact bug scenario (a bare "Udaipur, India" mention, no preposition), the
older "in `<place>`" phrasing still works (now also picking up the library's own casing), a place not in
the library falls back to the raw phrase, a location combined with a person resolves both, and a plain
place name isn't confused with a person. `applyFilter`: combined-query matches only the right city (not
just anywhere in the country), a single bare name still matches, a right-country-wrong-city combination is
excluded, a photo with no location data is excluded. One end-to-end `search()` call reproduces the reported
scenario exactly (local/no-cloud-provider path, the default). Full suite: 715 passing.

## 34. Six requests: Smart Flows list bug, sidebar cleanup, Photos header, Add-to-Album redesign, Google Maps URL location editing, and the local-model image-size question

**1. Fix: Smart Flows opened empty even with flows already configured.** Root cause: `SmartFlowsModal`
is mounted once at app startup (`App.tsx` toggles only `isOpen`, never unmounts it) and its `flows` state
was seeded by a `useState(() => listFlows())` initializer — which runs at that first mount, before the
library (and the per-library storage key `listFlows()` reads) has actually loaded, so it permanently read
an empty list. Every later real "open" (sidebar, or the "Run Smart Flow" selection button) just toggled
`isOpen` on the same stale state — nothing ever re-read storage. Fixed with a `useEffect(() => { if
(isOpen) setFlows(listFlows()); }, [isOpen])`, mirroring the existing `ollamaReady` effect right above it.
`smartFlowsListRefresh.spec.ts` (2, real `smartFlowsService`, not mocked — a static mock would have hidden
exactly this timing bug): a flow saved to storage after the modal's first (closed) render still shows up
the next time it's opened; re-opening after closing picks up a flow created in between.

**2. Sidebar: removed "Clean Duplicates" and "Search with AI".** Both already exist in the Photos page's
own toolbar (`GalleryView.tsx`'s `cleanDuplicatesButton` / `askAiButton`) — the sidebar copies were a
second way to reach the exact same thing. Removed the buttons and their now-unused `onOpenDuplicateCleaner`
/ `onOpenAiAssistant` props/callbacks from `Sidebar.tsx` and its one call site in `App.tsx` (the `Layers`
icon import, only used there, removed too). Smart Flows stays — it isn't duplicated in the Photos toolbar.
`sidebarCleanup.spec.ts` (2).

**3. Photos page header: the library's name instead of "Timeline (N)".** The header used to read
"Timeline (1,234)" with a calendar icon — meaningless once you already know you're on the Photos page, and
not what identifies which library you're in (`MobileTopBar.tsx` already shows the library name; the
desktop Photos toolbar never did). Replaced with the library folder's own name (its last path segment) as
a plain title — a photo icon + `var(--text-primary)` text at `font-weight: 700`, not a colored pill/badge
like the neighbouring virtual-storage indicator — and dropped the count entirely (already shown next to
"Photos" in the sidebar nav, and in the "Hidden (N)" filter chip where relevant). A new `libraryFolder`
prop threads `libraryState.selectedFolder || libraryState.currentDirectory` down from `App.tsx`. Favorites
(same `GalleryView` component, `filterFavorite` prop) keeps its own "Favorite Photos" label unchanged —
that's real page context, not what was reported. `galleryHeader.spec.ts` (4).

**4. "Add to Album" rebuilt like the person picker.** The old dialog was a `<select>` of every album (with
"+ Create New Album..." as an option) plus a conditional title field and a submit button. New
`components/AlbumPicker.tsx` mirrors `PersonPicker.tsx` exactly: autofocused search box, "contains"
filtering ranked exact then prefix then contains (`rankAlbumsByQuery`, identical shape to
`rankPeopleByQuery`), a grid of cover-photo + title + photo-count cards, Enter picks the top match
immediately (click does too — no confirm step), and a dashed "Create new album" row when nothing matches
(offered whenever there is no exact title match, even alongside partial matches — same rule `PersonPicker`
already uses). Wired into `GalleryView.tsx`'s existing Add-to-Album dialog, replacing its whole form;
`handleAddSelectedToAlbum` split into `finishAddToAlbum` (does the add + toast + closes) plus
`handlePickAlbum` / `handleCreateAlbumAndAdd`. `albumPicker.spec.ts` (5, ranking + the component alone) and
`galleryAddToAlbum.spec.ts` (4, through the real dialog: autofocus, filter+Enter adds to the best match
with the dialog closing itself, no-match Enter creates a new album and adds to it, a card click adds
immediately).

**5. Location editing: paste a Google Maps link for exact coordinates, plus an explicit label field.**
Both callers of the shared `LocationPickerModal` (`PhotoLightbox.tsx`, `BulkEditModal.tsx`) get this from
one change. New pure module `services/googleMapsUrl.ts`: `parseGoogleMapsUrl` reads, in order of
precision, the `!3d<lat>!4d<lng>` marker inside a `data=` segment (the actual place pin — can differ from
the map's own pan/zoom center), an `@<lat>,<lng>,<zoom>z` path segment, or a `q=`/`query=`/`ll=` query
parameter; verified against real-shaped URLs (a `/maps/place/.../@.../data=!...!3d...!4d...` place link, a
bare `@lat,lng`, `?q=`, `?ll=`, a non-Google URL, a coords-less place link) before writing tests. A
shortened share link (`maps.app.goo.gl/...`, `goo.gl/maps/...`, `g.co/...`) carries no coordinates of its
own; a new main-process IPC handler `location:resolve-maps-url` (`fetch(url, { redirect: 'follow' })`,
returns `response.url`) follows it first — done in main, not the renderer, because the redirect's
destination is a plain `google.com` URL with no CORS allowance, so a renderer `fetch` can't read where it
landed. `LocationPickerModal.tsx` gained a "paste a Google Maps link" row (falls back to a clear inline
error — not Google, no coordinates found, or a short link with the resolve call itself failing) below the
existing OpenStreetMap name search, and an always-visible, always-editable Label field (pre-filled from
`initialLabel`) — previously the modal held a `label` value internally but exposed no input for it at all;
it only ever got set as a side effect of a successful name search, so pinning a spot straight from a map
click or a pasted link left no way to name it.

**Verification.** `googleMapsUrl.spec.ts` (24, pure parser): every URL shape above, negative coordinates,
short links and non-Google URLs correctly return null, an out-of-range "coordinate" (a version-number
look-alike) is rejected. `locationPickerGoogleMapsUrl.spec.ts` (10, Leaflet mocked — jsdom can't run it for
real, same approach as every other canvas/DOM-heavy dependency mocked elsewhere in this suite): a full link
places the pin at its exact coordinates and flies the map there, the `!3d!4d` marker is preferred over the
`@` center, a non-Google URL and a coords-less Google URL each give a clear distinct error, a short link is
resolved through the (mocked) IPC bridge then parsed, a missing bridge and a failed resolution each explain
themselves, Enter works the same as the button, and the label field is independently editable and reaches
`onConfirm` regardless of how the pin got there. `resolveMapsUrl.spec.ts` (4, a real local HTTP server
standing in for Google's redirect — not mocked): a single redirect and a multi-hop chain both resolve to
the real final URL, an unreachable server and a 404 (dead/expired share link) are both reported cleanly
rather than throwing. The real `maps.app.goo.gl`/`goo.gl` domains were confirmed live and reachable over
plain HTTPS (a made-up path 404s cleanly, no JS/meta-refresh involved), but resolving one specific, real,
currently-valid short link end-to-end was not — no such link was available to test against; treat that one
path as reasoned-through and locally verified, not proven against Google's live servers.

**Not changed:** the Places tab's own "Assign Location (N)" search (a separate, third location-picking UI,
not built on `LocationPickerModal`) does not have the Maps-URL paste or a label field yet — worth doing if
wanted, flagged here rather than silently left out.

**6. Local-model image size / "token size" question — answered, not a bug.** `smartFlowsService.ts`'s
`toBase64()` already sends a 512px-longest-edge cached thumbnail (`getLocalPhotoUrl(..., 512)` to
`thumbnailCacheService.ts`: `sharp(...).resize(512, 512, { fit: 'inside', withoutEnlargement: true
}).jpeg({ quality: 82 })`, typically 20-60 KB) to both the local Ollama model and the cloud provider — not
the original photo. This is already exactly the "downsample / use the 500px thumbnail" the question asked
about; nothing to change there. What a larger `num_ctx` (set outside gPhotos, in Ollama itself — the app
sends no `options.num_ctx` at all, only `temperature: 0`) actually buys: `BATCH_SIZE = 8` sends up to 8
images in one `/api/chat` call, and even a small 512px JPEG still costs the vision encoder a real,
non-trivial number of "image tokens" (a few hundred per image is typical for this class of model) — 8 of
them plus the prompt can plausibly have been overflowing Ollama's old default context window (often 2-4K)
before it was increased, causing a truncated/garbled JSON response. That is the likely reason the earlier
context size gave visibly better results. No repo-side hard cap exists on either photo size or context
length — both are fully delegated to Ollama's own configuration. The one lever gPhotos itself controls is
`BATCH_SIZE`; lowering it would shrink the worst-case per-call token load further at the cost of more
round-trips, but was not changed since it was not asked for — worth adjusting (or exposing as a setting) if
a batch is still coming back truncated even with the larger context now in place.

Full suite after items 1-5: 770 passing (93 files).

## 35. Follow-up to §34 item 6: local batch size raised to match a 32768 Ollama context window

The user set Ollama's own context window to 32k and asked for the app's local-model batch size to match.

**The sizing math** (per photo, at the 512px thumbnail already sent — see §34 item 6): roughly 300 vision
tokens (qwen2.5vl patches a 512px-class image into that order of tokens) + ~60 tokens for that photo's
slice of the JSON response ~= 360/photo, plus a ~350-token fixed prompt. On a 32768 window with ~10%
headroom reserved: (32768*0.9 - 350) / 360 ~= 81 photos would technically still fit in the context alone —
but two things cap it far below that in practice: the request would badly overrun the timeout (which was
sized for 8 photos), and small (7B-class) local models get noticeably less reliable at keeping a long JSON
array well-formed and in order well before the context itself runs out (one malformed batch fails every
photo in it — there is no partial credit). **16** was chosen instead: double the old throughput, using only
~13% of the 32768 budget even under the conservative per-photo estimate above, so there is room to spare
rather than sizing right to the edge.

**Changed:**
- `smartFlowsService.ts`: the single `BATCH_SIZE` split into `LOCAL_BATCH_SIZE = 16` (with the sizing math
  above written down right next to it) and `CLOUD_BATCH_SIZE = 8` (unchanged — cloud providers' own context
  windows are orders of magnitude larger, so this was never the constraint there, and nothing was reported
  about the cloud path).
- `ollamaVisionService.ts`: `classifyImagesBatchLocal` now explicitly sends `options: { num_ctx: 32768 }`
  on every local call, instead of trusting that whatever the user configured in Ollama (an env var, or a
  custom Modelfile — gPhotos has no reliable way to read back what a running server is actually using)
  matches what the app's own batch-size math assumes. This closes the loop in both directions: the app's
  assumption about the available context is now guaranteed true for this call regardless of the server's
  own default, and if the *user's own* Ollama context is set lower than this, the request for more than
  the model/hardware can give is silently capped by Ollama — bringing back the exact truncated-response
  problem this whole change is meant to avoid, which is why the code comment there points at lowering
  `LOCAL_BATCH_SIZE` to match instead of raising the request.
- The per-call timeout now scales with batch size (`Math.max(120000, items.length * 12000)`) instead of a
  fixed 120s regardless of how many photos are in the call — a real 16-photo batch takes longer than the
  old 8-photo one did, and cutting it off mid-generation would look identical to a model/parsing failure.

**Verification.** `ollamaVisionService.spec.ts` (+2): `num_ctx: 32768` is present on every local request
(checked via both the raw-fetch and the main-process-bridge paths), and the timeout is `120000` for a
1-photo batch but scales to `16 * 12000` for a 16-photo one. `smartFlows.spec.ts` (+2, through the real
`runFlow`): 17 photos against the local tier split into batches of 16 then 1 (not the old 8-ish chunking),
and the cloud tier still chunks at 8, unaffected. Full suite: 774 passing.

## 36. Smart Flows gets its own cloud config, and local batch size is now derived from the model's actual context — not a fixed 32768

Two related requests: (1) AI Search and Smart Flows were sharing one cloud provider/API-key config
(`gphotos_ai_search_config_v1`); the user wants them configurable separately, with Smart Flows
picking its own cloud fallback independent of Search's. (2) §35's fixed `num_ctx: 32768` assumed
every user has (and wants) a 32k context window — the user asked for the app to check the local
model's actual context window first and size the batch from that, instead of hardcoding one number.

**Why context can't just be auto-detected — probed against the user's own Ollama server:**
- `GET /api/tags` and `POST /api/show {model}` both return `model_info["<family>.context_length"]`
  — this is the model's architectural maximum from its GGUF metadata (e.g. 128000 for a qwen2.5vl
  build), not what the server is actually configured to run it at.
- `POST /api/show` also returns a `parameters` string, which only reflects `PARAMETER` lines baked
  into a custom Modelfile — it does **not** reflect the `OLLAMA_CONTEXT_LENGTH` environment
  variable, which is how most people actually set their context window (including this user).
- `GET /api/ps` (currently-loaded models) returns a real, live `context_length` for the running
  instance — but only for whatever context the *last request* happened to load it with; there is no
  way to ask "what would a fresh request get" without already knowing what to ask for.
- Net result, confirmed against the user's real server: **there is no Ollama API that reports back
  the effective `OLLAMA_CONTEXT_LENGTH` a user has configured.** It has to be entered in gPhotos
  itself. What *can* be read back reliably is the model's own hard ceiling (`/api/show`), so gPhotos
  uses that as a safety cap on whatever the user enters, rather than trusting either number alone.

**Changed:**
- `aiSearchService.ts`: split the single `config` into two independent slots — `config` (AI Search,
  unchanged storage key `gphotos_ai_search_config_v1`) and a new `smartFlowsConfig` (storage key
  `gphotos_smart_flows_ai_config_v1`), each with its own `provider`/`geminiApiKey`/`openaiApiKey`
  and its own load/save/get methods (`getSmartFlowsConfig`, `saveSmartFlowsConfig`,
  `loadSmartFlowsConfig`). `classifyImagesBatch` (and the Gemini/OpenAI batch helpers under it) now
  take the config as an explicit parameter instead of reading `this.config`, so the same classify
  path serves whichever config its caller passes.
- `smartFlowsService.ts`: its cloud-tier call now passes `aiSearchService.getSmartFlowsConfig()`
  instead of implicitly using the Search config.
- `SmartFlowsModal.tsx`: reads provider/key state (for the "no key configured" banner and the Run
  button) from `getSmartFlowsConfig()` instead of `getConfig()`.
- `SettingsView.tsx`: a new **"Smart Flows: Cloud Fallback"** card, structurally identical to the
  existing AI Search card (provider select, Gemini/OpenAI key inputs, its own save button/feedback
  banner) but bound to `smartFlowsConfig`/`saveSmartFlowsConfig`, placed between the AI Search card
  and the (shared) Ollama card.
- `ollamaVisionService.ts`: replaced the fixed `OLLAMA_NUM_CTX = 32768` from §35 with:
  - `OllamaConfig.contextWindow` (new field, default `4096` — Ollama's own out-of-the-box default,
    confirmed against the user's server for a model with no override), settable in Settings.
  - `getModelMaxContext(modelName)`: calls `/api/show`, returns the model's own architectural max.
  - `resolveEffectiveContext(config)`: `min(configured contextWindow, model's own max)` — the user's
    number, safety-capped by what the model can actually do; falls back to the configured number
    alone if the model-max lookup fails (offline, unknown model, etc.).
  - `computeLocalBatchSize(effectiveContext)`: same per-photo sizing math as §35 (~360 tokens/photo,
    ~350 fixed prompt tokens, 10% headroom), now driven by whatever context was actually resolved
    instead of a hardcoded 32768 — `floor((effectiveContext*0.9 - 350) / 360)`, capped at **20**
    (raised from §35's fixed 16, since 20 was already comfortably inside the reliability margin
    discussed there and is now reachable dynamically once a large-enough context is configured).
  - `classifyImagesBatchLocal` takes an optional `numCtx` 3rd parameter; when the caller already
    knows the effective context (as `smartFlowsService` now does, resolved once per run rather than
    once per batch), it's passed straight through and no extra request is made. Omitting it makes
    the function resolve it itself via an internal `/api/show` call first — kept for any other
    caller, and covered by its own tests below.
- `smartFlowsService.ts`: `runFlow` now resolves the effective context and batch size **once**, up
  front (`resolveEffectiveContext` + `computeLocalBatchSize`), logs it as the first line of every
  run ("Local model context: N tokens — sending up to M photos per call"), and uses that batch size
  for the local-tier chunking loop — replacing §35's fixed `LOCAL_BATCH_SIZE = 16` constant. The
  cloud tier's `CLOUD_BATCH_SIZE = 8` is unchanged.
- `SettingsView.tsx`: the Ollama card's "Ollama Host" row gained a sibling **"Context Window
  (tokens)"** number input (`min={512}`, `step={512}`), bound to `ollamaConfig.contextWindow`, with
  helper text pointing at matching whatever `OLLAMA_CONTEXT_LENGTH`/Modelfile setting the user has.

**What this means for the user's 32k setting:** §35's hardcoded 32768 is gone. To get the same
sizing now, set **Settings → Local AI Model (Ollama) → Context Window** to `32768` — gPhotos cannot
read that back from a running Ollama server (see above), so it must be entered once, here. Left at
the 4096 default, batches now size conservatively (~10 photos/call) rather than assuming a context
the user never actually configured in gPhotos.

**Verification.** `ollamaVisionService.spec.ts` (20 tests, all passing): default config includes
`contextWindow: 4096`; `classifyImagesBatchLocal` with an explicit `numCtx` skips the `/api/show`
lookup and sends that value straight through (both the raw-fetch and main-process-bridge paths);
with no `numCtx` given, it resolves one itself first (asserted as call 1 to `/api/show`, call 2 to
`/api/chat` with the resolved `num_ctx`), including a case proving the model's own max (from
`/api/show`) caps a higher configured value. `smartFlows.spec.ts` (19 tests, all passing, mocking
`getOllamaConfig`/`resolveEffectiveContext`/`computeLocalBatchSize` at a fixed 32768/16 for
determinism — the sizing math itself is `ollamaVisionService.spec.ts`'s job to verify): the local
tier still batches at 16 (now via the mocked `computeLocalBatchSize` rather than a hardcoded
constant), the cloud tier is unaffected at 8, and the new "Local model context: ..." log line is
asserted as the first line of a local-tier run (shifting the existing per-photo log assertions down
by one index). `smartFlowsListRefresh.spec.ts` and `smartFlowsModalScope.spec.ts`: both files' mocked
`aiSearchService` gained `getSmartFlowsConfig` alongside the existing `getConfig`, matching what
`SmartFlowsModal.tsx` now actually calls. Full suite: 775 passing, 3 skipped (unrelated), typecheck
clean.

## 37. Fix: Lightbox crop was just panning the photo, plus a PowerPoint-style handled crop frame

**Reported bug**: "Crop is not working, it is just dragging photo when try to crop."

**Root cause.** The crop overlay's draw-a-box handlers were registered as `onPointerDown` /
`onPointerMove` / `onPointerUp` and called `e.stopPropagation()` on the `PointerEvent`. But the
image container's pan handler (`handleMouseDown`, on `containerRef`) is a separate `onMouseDown`
listener. A browser dispatches `pointerdown` and `mousedown` as two independent events for the same
physical click — stopping one's propagation does nothing to the other. So every crop drag also fired
the container's mousedown-based pan logic; whenever `zoom > 1` (e.g. after using "Fill" or "1:1", or
just having scrolled to zoom in) `handleMouseDown` set `isDragging = true` and panned the stage in
parallel with the crop box being drawn, which is exactly what looked like "just dragging the photo."
`isTaggingMode` already had this same guard for the equivalent face-tagging overlay; `isCropping` did
not.

**Fix**: added `isCropping` to the same guard already used for `isTaggingMode`, in both
`handleMouseDown` and `handleDoubleClick` — the actual root cause, one line each, rather than trying
to make every overlay also stop the parallel mouse-event chain.

**The redesign (also requested)**: replace click-and-drag-to-draw-a-box with a persistent,
PowerPoint-style handled frame — drag inside it to move the whole crop area, drag any of its 8
corner/edge handles to resize it from the opposite edge, exactly like resizing a picture crop in
PowerPoint/Word.
- Clicking **"Crop"** now seeds a centered frame (8% inset on every side) instead of leaving
  `cropRect` empty until the user manually drew one.
- `cropDrawBox` (the old draw-in-progress state) is gone; a new `cropDrag` state tracks which handle
  (or `'move'`) is currently being dragged, plus the rect it started from.
- The resize/move math — given a handle, the rect at drag-start, and how far the pointer moved (as a
  fraction of the image box) — was pulled out into a standalone, dependency-free module,
  `cropFrameMath.ts` (`computeCropDragRect`), mirroring how `viewModeZoom.ts` already isolates the
  Fit/Fill/1:1 zoom math from `PhotoLightbox.tsx`. The JSX overlay is a thin wrapper: 8 small handle
  `div`s plus the frame body, each with its own `onPointerDown`/`onPointerMove`/`onPointerUp` using
  `setPointerCapture` (so dragging past a handle's own small hit area keeps working), calling into
  `computeCropDragRect` and clamping the result to `[0,1]` so a fast drag can never invert the rect
  or push it off the image.
- Kept the existing `cropRect` → pixel-crop pipeline in `handleApplyEdit` untouched (still a
  normalized 0–1 rect against the displayed image box) — only how the rect is *produced* changed.

**Verification.** New `cropFrameMath.spec.ts` (5 tests, pure function, no DOM): move translates and
clamps to image bounds in every direction; `e`/`s` handles grow/shrink from the fixed opposite
corner and cap at the image edge; `w`/`n` handles move the near edge while the far edge stays fixed;
a corner handle (`nw`) moves both its edges independently; shrinking past the minimum size stops at
the minimum without crossing or inverting the opposite edge. `PhotoLightbox.tsx` has no existing
test coverage (confirmed — no spec file references it), so nothing else needed updating. Typecheck
clean; `build:ui` and `build:electron` both succeed; full suite 779 passing / 3 skipped. One
unrelated failure on the full run (`heicWorkerClient.spec.ts`'s main-thread-responsiveness perf
benchmark, an event-loop-lag threshold check) reproduced as a false positive from running all 95
files concurrently on a loaded machine — confirmed by re-running that file alone, where it passes
(`in-process 990ms, worker 7ms`, both sides of its `>800`/`<250` thresholds).

## 38. Edit gated to full-resolution only, and thumbnails now refresh immediately on save

Two related requests: (1) the lightbox's Edit tool (crop/rotate/flip) must only operate on the true
full-resolution original — not a placeholder, a downsized OneDrive-offline fallback, or a failed
load — since `handleApplyEdit` bakes pixels straight from whatever's currently in `imgRef.current`
onto a canvas and saves that; editing too early would silently and permanently degrade the photo.
(2) after Save Changes/Save Copy, the photo's thumbnail must be recreated immediately, not left to
catch up whenever something else happens to refresh it.

**Part 1 — gating edit to full resolution.** A new derived `isFullResDisplayed` — `isLightboxImgLoaded
&& !lightboxImgError && !fallbackToThumbnail && isOriginalAvailable !== false` — captures exactly
the same condition the `<img>`'s own `src` already uses to decide whether it's requesting the true
original (`preferOriginal`) versus a downsized/cached fallback. `canEditNow = isHeic ||
isFullResDisplayed` — HEIC is exempt because its editor always bakes onto the local cached preview
by design (see the existing comment on `editPhotoFile`'s HEIC branch: the remote `.heic` master is
never touched).
- The **Edit** toggle button is now `disabled` (with an explanatory tooltip) whenever
  `!isEditing && !canEditNow` — starting an edit session is blocked, but exiting one already open
  never is.
- **Save Changes** / **Save Copy** are independently disabled the same way — the actual point where
  pixels get baked and written to disk, and the one that matters most: a fast click could otherwise
  save before the full-res swap finishes even if Edit was entered a moment earlier while it still
  qualified.
- `handleApplyEdit` itself also guards at the top (`if (!canEditNow) { notify(...); return; }`) —
  the root-cause fix, not just a UI-only disabled state, so nothing that could call it programmatically
  bypasses the check.

**Part 2 — recreating the thumbnail on save.** Investigation turned up a second, related gap:
`handleApplyEdit`'s success branch called neither `bumpImageVersion` nor `evictAndRefreshThumbnail`
— both already established elsewhere in this codebase (`photoRotation.ts`'s `afterPhotoRotated`,
used by the lightbox's own separate "instant rotate ±90°" toolbar button) as exactly the mechanism
that makes a photo's thumbnail refresh right after its pixels change. The crop/rotate/flip editor's
Save path had simply never been wired into it.
- On a successful save, `handleApplyEdit` now calls `bumpImageVersion` (cache-busts the `v=` query
  param every `getLocalPhotoUrl` call embeds) and `evictAndRefreshThumbnail` (drops + re-fetches the
  grid's in-memory batch-thumbnail cache) for every path whose bytes may have changed — the source
  path and, distinctly for a virtual/OneDrive mirror, the new photo record's own path.
- **A second staleness source found along the way**: `PhotoCard.tsx` prefers a pre-baked sprite-sheet
  tile over the batch thumbnail whenever one exists (`canUseSprite = spriteCoord && !isRotated`) —
  and neither `evictAndRefreshThumbnail` nor `afterPhotoRotated` touched that sprite cache, so a
  photo that had already been sprite-baked (common in a populated library) would keep showing its
  pre-edit pixels even after eviction, quick-rotate included. Fixed by adding an
  `invalidateSpriteCoordinate` path end to end:
  - `spriteService.ts` (main): removes a path's entry from the persisted sprite index and saves it,
    so the coordinate stops being handed out until some future rebake includes it again (the sprite
    sheet image itself isn't rewritten — that's a heavier operation left to whatever already
    triggers a full rebake).
  - New IPC (`sprite:invalidate`) + preload/type wiring, mirroring `sprite:get-coordinate`'s.
  - `asyncImageLoader.ts` (renderer): a client-side counterpart that drops the entry from
    `spriteCoordCache`, notifies `useSpriteCoordinate` subscribers so a mounted card re-renders
    immediately, and fires the IPC above.
  - Folded into `afterPhotoRotated` too (one extra line) — the same staleness class affects
    quick-rotate, and the fix was already sitting right there once the function existed.
- `handleApplyEdit` calls all three (`bumpImageVersion`, `evictAndRefreshThumbnail`,
  `invalidateSpriteCoordinate`) for each changed path on a successful save.

**Verification.** New `spriteCoordinateInvalidation.spec.ts` (5 tests, real `sharp`-baked sprite
sheets against an isolated per-spec `%APPDATA%`, mirroring `avatarSpriteService.spec.ts`'s pattern):
a freshly-baked photo has a coordinate; invalidating drops it; it's case-insensitive (matching how
lookups already work); the removal is persisted to disk, not just the in-memory index (proven via a
`vi.resetModules()` + fresh re-import, which must re-read `sprite_index.json` from a clean start);
invalidating an unbaked path is a harmless no-op. `afterPhotoRotated.spec.ts` (existing 4 tests, all
still passing) confirms the new sprite-invalidation call doesn't disturb its face-box-rotation/avatar
behavior — `window.electronAPI` there has no `invalidateSpriteCoordinate` mock, and the call is
optional-chained, so it's silently skipped exactly as designed. `PhotoLightbox.tsx` still has no
component-level test harness (confirmed — no spec file references it; building one from scratch was
judged out of proportion to this change), so the edit-gating logic itself is exercised only by
typecheck + manual review; the extracted, genuinely regression-risky pieces (sprite invalidation)
are what got dedicated tests. Typecheck clean; `build:ui` and `build:electron` both succeed; full
suite re-run clean.

## 39. "Search with AI": a third "&tag" mention-autocomplete for Smart Flow content tags

The user wanted a third autocomplete placeholder (alongside @person and #place) for the captions/tags
Smart Flows generates when it analyses a photo, and asked whether those tags are actually persisted
somewhere durable enough to filter on — if not, to store them in the database.

**They already were.** `photoContentCache.ts` (the per-photo caption/tag/embedding cache every Smart
Flow reads and writes, described in its own top-of-file comment) persists through the main process
into a table in the current library's own SQLite database via `upsertPhotoContentEntry`/
`getAllPhotoContentEntries`, with a `localStorage` fallback only for the browser-shim/test path where
there's no library database file to write into. No new storage was needed — this was purely a matter
of exposing what's already durably recorded through a new UI entry point and wiring it into search.

**Changed:**
- `photoContentCache.ts`: new `getAllKnownTags()` — every distinct tag recorded for any photo in the
  current library, read synchronously off the already-loaded in-memory mirror (same contract as
  `getEntry`). Also a new `resetForTests()`, mirroring `avatarSpriteLoader.ts`'s
  `resetAvatarSpriteLoaderForTests()` — the mirror is a module-level singleton, so a test that calls
  `recordFinding()` needs to reset it in `beforeEach` or a later test in the same file would still see
  its entries.
- `MentionAutocompleteInput.tsx`: `MentionSource['trigger']` widened from `'@' | '#'` to
  `'@' | '#' | '&'`, and the token-detection regex now recognises all three
  (`/(?:^|\s)([@#&])(\S*)$/`). No other changes — the component was already fully generic per trigger
  character.
- `AiAssistantModal.tsx`: a third `MentionSource` (`trigger: '&'`, items from `getAllKnownTags()`,
  empty-state "No tags found — run a Smart Flow first to generate some"). Warms
  `photoContentCache`'s in-memory mirror once on mount and forces a re-render when that resolves —
  the exact same `ensureLoaded()`-then-rerender pattern `PhotoLightbox.tsx`'s AI Info panel already
  uses, so tags from a past session show up without needing a flow to run again first. Placeholder
  text updated to mention all three triggers.
- `aiSearchService.ts`: new `AiPhotoFilter.tagsMustInclude?: string[]`.
  - `smartLocalNlp`: a new detection step mirrors the existing "#place" known-value loop — only tags
    this library has actually recorded (`getAllKnownTags()`) are recognised as a tag filter, mentioned
    anywhere in the query, so a random word is never misread as one. Multiple tags combine with AND,
    matching how `peopleMustInclude` already works.
  - `applyFilter`: a photo must have every required tag in its own `photoContentCache` entry
    (case-insensitive). A photo Smart Flow has never analysed has no entry at all, so it correctly
    never matches, rather than being treated as an unknown/undecided match.
  - `queryGemini`/`queryOpenAI`: both prompts now also pass the library's known content tags and ask
    for a `tagsMustInclude` field in the returned JSON, so a tag mention still works identically when
    a cloud provider is configured — the same approach these two already use for locations.
  - `generateSummaryTags` and the local-NLP explanation builder both mention matched tags.

**Verification.** New `aiSearchTags.spec.ts` (8 tests): a known tag mentioned in the query is detected
by `smartLocalNlp`; an unrecorded word is never mistaken for one; several known tags mentioned together
are all picked up; `applyFilter` matches only photos carrying every required tag (AND, not OR),
case-insensitively, excluding a photo Smart Flow has never analysed (rather than treating it as an
unknown match); and an end-to-end `search()` call on the local (no cloud provider) path. `MentionAutocompleteInput.spec.ts` (+1): typing "&" opens the tags list, alphabetically sorted, same
as the existing @/# tests. `aiAssistantMentions.spec.ts` (+2, through the real `AiAssistantModal`):
"&" lists tags recorded by a past Smart Flow run; with none recorded yet, "&" opens the empty-state
message instead of erroring. Typecheck clean; `build:ui` and `build:electron` both succeed; full
suite 795 passing / 3 skipped (unrelated). One unrelated failure on the full run
(`backgroundSyncUnified.spec.ts`'s bandwidth-throttling timing assertion, `best < 2000ms` measured
2260ms) reproduced as a false positive from running all 97 files concurrently on a loaded machine —
confirmed by re-running that file alone, where it passes in 795ms.

## 40. Photos toolbar tidy-up, a real Escape/navigation bug fix, and the two Smart Flow Settings cards merged

Three requests in one: (1) tidy the Photos toolbar to fit one line — drop a duplicate chip next to
the library name, and make Select/Clean Duplicates/Rescan/Ask AI icon-only with tooltips; (2)
"navigation and escape key is not handled properly" — track the screen so Escape always returns to
the exact previous screen; (3) merge Settings' two Smart Flow cards into one "Smart Flow
Configuration" section.

**1. Toolbar — `GalleryView.tsx`.** The "duplicate chip" wasn't actually the library name twice —
it was `firstVirtualStorageName` (a cyan badge naming the virtual/OneDrive storage) sitting right
next to the title, which for a OneDrive-backed library named e.g. "OneDrivePhotos" visually read as
the same text shown twice. Removed that badge outright, per the request — the header is now just
the library name. The four toolbar buttons (`selectButton`, `cleanDuplicatesButton`,
`rescanButton`, `askAiButton`) already all had icons; dropped their `<span>{label}</span>` text,
switched them to the same `btn-icon` 34×34 square treatment the zoom controls already use, and gave
`selectButton` a `title` tooltip (the other three already had one, just needed the label folded
into the tooltip text instead of sitting beside it).

**2. Escape/navigation — `App.tsx`, root cause found and fixed.** There already was a real
navigation-history stack (`tabHistoryRef`), not just "close whatever's open" — the Escape handler
is an ordered cascade: lightbox → global modals → AI filter/folder-tree/person sub-view → pop the
tab-history stack. The actual bug: **`setActiveTab(...)` was called directly, bypassing the
reset, from 8 other places** — `handleOpenFolder`, `handleSelectLibrary`, `handleOrganizeComplete`,
`handleLoadMirroredPhotos`, `handleSelectVirtualStorage`, `AiAssistantModal.onApplyFilter`,
`SmartFlowsModal.onOpenSettings`, and the Escape handler's own history-pop step — only
`handleSelectTab` (a literal Sidebar click) cleared `selectedPersonIdForView`/
`selectedFolderForTree` first. Concretely: view a Person's profile (People tab) → switch libraries
via the Library Switcher, which lands back on Photos without clearing that stale ref → later press
Escape from some other tab → the handler's step 3 finds `selectedPersonIdForView` still "set",
clears it, and returns — a screen the user can't see changed, so that Escape press visibly does
**nothing**. A second press is needed before anything actually happens. Exactly the reported
symptom.
- Fix: extracted the reset into `navigateToTab(tab)` (clears both sub-view refs, then switches),
  and routed every one of those 8 call sites through it instead of raw `setActiveTab`. The two
  sites that deliberately set ONE sub-view alongside the switch (`handleNavigateToPerson`, the
  Virtual Storage view's "browse this folder" callback) got a narrower, inline fix instead — clear
  only the *other* sub-view ref, not the one they're intentionally setting.
- The tab-history pop itself (dedupe trailing entries equal to the current tab, then pop one more
  for "previous", falling back to `'photos'` once empty) was pulled out verbatim into
  `services/tabHistory.ts`'s `popTabHistory()` — same reasoning as `cropFrameMath.ts`/
  `viewModeZoom.ts` earlier in this file: App.tsx has no test harness at all (zero existing specs
  import it — mounting the whole root component is its own undertaking), so the one piece of real
  branch/loop logic worth a dedicated check gets pulled into a pure, standalone function instead.

**3. Settings merge — `SettingsView.tsx`.** "Smart Flows: Cloud Fallback" and "Local AI Model
(Ollama)" were two separate cards back to back in the same tab; merged into one card titled
**"Smart Flow Configuration"**, with "Cloud Fallback" and "Local AI Model (Ollama)" as `<h3>`
sub-headings separated by a divider. Each half keeps its own independent state and "Save" button
(`aiSearchService.saveSmartFlowsConfig` vs `saveOllamaConfig`) — only the layout/heading changed,
not the save logic (per §36's reasoning for why those two configs are intentionally separate
underneath).

**Verification.** New `tabHistory.spec.ts` (6 tests): pops straight to the previous tab; dedupes a
run of the current tab at the top first; falls back once the stack only ever held the current tab,
and on a genuinely empty stack, without throwing; doesn't mutate the array it was given; a longer
back-and-forth sequence pops one tab at a time. `gallerySmartFlowButton.spec.ts` (1 fix): the
Select-mode-toggle lookup switched from `textContent === 'Select'` (now empty, icon-only) to
`title === 'Select photos'`. `sidebarCleanup.spec.ts`/`galleryHeader.spec.ts` confirmed unaffected
(they test the Sidebar and the title text itself, not the removed badge or button labels — a
repo-wide grep found no other test asserting on the old button text or the virtual-storage chip).
`settingsTabs.spec.ts` confirmed unaffected by the card merge. Typecheck clean; `build:ui` and
`build:electron` both succeed; full suite 802 passing / 3 skipped (unrelated), 0 failures.

## 41. Fix: a location named on the map never came back into the popup that opened it

Reported bug: select multiple photos → **Edit Date/Location** (`BulkEditModal`) → **Pin on Map**
(`LocationPickerModal`) → paste a Google Maps link, type a name, click **"Use This Location"** —
the typed name never appeared back in `BulkEditModal`'s own location text box, and its **Apply**
button stayed enabled regardless.

**Root cause.** `LocationPickerModal`'s "Use This Location" button was only ever gated on a pin
existing (`disabled={!pin}`) — the name/label field was optional. `BulkEditModal`'s `onConfirm`
handler already *did* write the label back (`if (label) setLocationInput(label)`), but only when
`label` was non-empty — so confirming with a pin and no name silently kept whatever
`locationInput` already held (blank, if nothing had been typed there either), which is exactly
"the name doesn't come back" from the user's side, and since `BulkEditModal`'s own Apply button is
gated on `locationInput` rather than on the map picker's internal state, it had no way to know a
name was ever expected and stayed enabled on stale/blank text.

**Fix — in the shared `LocationPickerModal.tsx`, not just its one caller** (it's also used by
`PhotoLightbox`'s single-photo location editor, so fixing it here covers both):
- New `needsLabel = !!pin && !label.trim()`.
- **"Use This Location" is now disabled whenever `needsLabel`** (`disabled={!pin || !label.trim()}`),
  not just when there's no pin — this is also the actual root-cause fix for the sync bug: once the
  button can never fire with an empty label, `onConfirm` always hands the caller a real name, so
  `BulkEditModal`'s `if (label) setLocationInput(label)` always runs.
- **Clear indication**: the label input's border turns amber and a `role="alert"` line — "Add a
  name for this place above before using it." — appears whenever a pin exists but the name is still
  empty; the coordinates line at the bottom also changes to "— now give it a name above" instead of
  "— drag the pin to fine-tune"; the button gets an explanatory `title` while disabled; and the
  placeholder itself now says "required".
- The `onClick` handler also checks `label.trim()` directly (`pin && label.trim() && onConfirm(...)`)
  as defense in depth, matching this codebase's existing convention of guarding a handler's own body
  rather than trusting `disabled` alone.

**Verification.** `locationPickerGoogleMapsUrl.spec.ts` (+4 new, 1 updated): pasting a valid Maps
link alone no longer enables confirm (the existing test asserting `disabled === false` right after
a URL paste was updated to also require typing a name first); the warning appears once a pin exists
with no name and clears once one is typed; clicking the disabled button never calls `onConfirm`;
whitespace-only text doesn't count as a name; an existing (pre-filled) label — the single-photo
editing case — already satisfies the requirement with no warning shown on open, so editing an
already-named location's coordinates is unaffected. New `bulkEditModalLocation.spec.ts` (1 test,
the exact reported scenario end-to-end through the real `BulkEditModal` + `LocationPickerModal`
pair): pin a location via a pasted Maps link, confirm is disabled until a name is typed, typing one
enables it, confirming closes the map popup and the name now shows in `BulkEditModal`'s own
location box, with its "Apply to N" button enabled. Typecheck clean; `build:ui` and
`build:electron` both succeed; full suite re-run clean.

## 42. Fix: rotating a photo could freeze the whole app for 20+ seconds

Reported with real logs: rotating a photo showed "Rotating (saving in 2s)..." for a long time,
with the main process's own hang watchdog logging `MAIN PROCESS STALL: blocked for ~20995ms.
In-flight IPC handlers: photo:rotate (running 21073ms)` and the renderer's IPC layer separately
reporting it was still waiting. `hangWatchdog.ts` (see its own header comment) measures real
event-loop drift via a self-correcting timer — this is a genuine main-process freeze, not just one
slow handler quietly taking a while in the background while everything else keeps working.

**Root cause.** `rotatePhotoFile` (the function `photo:rotate` ultimately calls) read, backed up
and wrote the photo with `fs.readFileSync`, `fs.copyFileSync`, `fs.statSync`, `fs.existsSync` and a
fully synchronous `writeFileAtomic` (temp-file-write + rename, both sync, plus an `Atomics.wait`
synchronous sleep for Windows' transient-lock retry). Every one of those runs on — and fully blocks
— whichever thread calls it. From Electron's main process, that is the single thread serving every
other IPC call, menu action and window repaint, so a slow read/write (a large file, or any file on
a degraded/slow network mount — exactly the kind of path this app's virtual-mirror/network-storage
feature targets) freezes the entire app for as long as that I/O takes, not just the one rotate
request. `rotateCachedHeicThumbnail`'s HEIC-rotation path had one smaller instance of the same bug
(a sync sidecar-JSON read) left over from an otherwise-already-async function.

**Fix: convert every one of those calls to its async equivalent**, so the SAME I/O still takes
however long a slow disk/network path takes, but no longer blocks anything else meanwhile.
- `jsonFile.ts`: added `writeFileAtomicAsync` and `writeJsonAtomicAsync` — async counterparts to
  the existing sync `writeFileAtomic`/`writeJsonAtomic` (which stay as they are: still correct and
  simpler for the many small, always-local config/JSON writes elsewhere that don't touch a
  network-mounted photo), using `fs.promises.writeFile`/`rename`/`unlink` and a `setTimeout`-based
  retry delay instead of `Atomics.wait`.
- `virtualMirrorService.ts`'s `rotatePhotoFile`: `fs.readFileSync` → `fs.promises.readFile`;
  `fs.existsSync`/`fs.copyFileSync` (the `.bak` backup) → `fs.promises.access`/`copyFile`;
  `fs.statSync` → `fs.promises.stat`; `writeFileAtomic` → `writeFileAtomicAsync`.
- `rotatePhotoWithOfflineQueue` (the caller): the two near-identical sidecar-metadata-JSON
  update blocks (HEIC and non-HEIC branches) converted the same way — `fs.existsSync` →
  `fs.promises.access`, `fs.readFileSync` → `fs.promises.readFile`, `writeJsonAtomic` →
  `writeJsonAtomicAsync`. `pending_rotations.json` (the offline-retry queue) was deliberately left
  sync — it's always a small file under the app's own local `userData` folder, never a
  network-mounted photo, so it was never actually part of this bug.
- `thumbnailCacheService.ts`'s `rotateCachedHeicThumbnail`: the sidecar `originalFilePath` lookup
  converted to `fs.promises.readFile` (and the redundant preceding `existsSync` check dropped — the
  surrounding `try/catch` already silently handles a missing file).

**Verification.** New test in `rotateOffline.spec.ts` — spies on `fs.readFileSync`/`writeFileSync`/
`copyFileSync`/`statSync`/`existsSync`/`renameSync` across a full online rotate (both the local
mirror thumbnail and a genuinely reachable "remote" original, so it exercises `rotatePhotoFile`
twice without touching the intentionally-still-sync local pending-rotations queue) and asserts none
of them were called — a direct regression guard against this exact bug coming back, that doesn't
depend on timing or a real slow disk to catch it. All 5 pre-existing tests in that file (offline
queueing, HEIC/RAW handling, double-rotation) still pass unchanged — the behavior is identical,
only the I/O is non-blocking now. Typecheck clean; `build:ui` and `build:electron` both succeed;
full suite 807 passing / 3 skipped (unrelated). One unrelated failure on the full run
(`heicWorkerClient.spec.ts`'s main-thread-responsiveness perf benchmark, `viaWorker < 250ms`
measured 278ms) reproduced as a false positive from running all 99 files concurrently on a loaded
machine — confirmed by re-running that file alone, where it passes (`in-process 990ms, worker 7ms`).

## 43. Follow-up to §42: the slow part is now a real background queue, not just non-blocking

§42 made the rotate pipeline's file I/O async so it stopped freezing the *whole app* — but the
*specific rotate request* still waited on the same slow write before the UI called it done, so a
network-mounted photo still felt stuck for however long that write took. The user's own framing of
the fix: rotate the thumbnail first and update the screen, do the real file rotation in a background
worker queue, and if that eventually fails, tell the user and roll the thumbnail back.

**What already existed to build on.** `pending_rotations.json` + `processPendingRotations()` (drained
every 30s by `backgroundDaemon.ts`, independent of any particular rotate request) was already a
working background-queue mechanism — just only used for the "source is currently offline" case.
Generalizing it to always carry the slow part turned out to need surprisingly little new machinery.

**Changed — `virtualMirrorService.ts`:**
- `rotatePhotoWithOfflineQueue`: the remote/original rotation is now **never** performed inline,
  online or offline. After the local mirror thumbnail is rotated (small, fast, already was the only
  part that updated the screen), the original is always hunch off to the queue:
  - No separate original at all (`remoteTarget === localFilePath`, a plain non-virtual photo) → done,
    same as before.
  - A RAW extension on the original → still rejected synchronously and immediately, exactly as
    before — this is a zero-I/O, purely extension-based check (no network round-trip needed), so
    there's no reason to make the user wait for a queue cycle to learn something that can never
    succeed. (The local mirror thumbnail is always a JPEG regardless of the original's real format,
    so this check is only trustworthy against the *original* path, never the thumbnail.)
  - Otherwise → `enqueuePendingRotation` + an un-awaited `processPendingRotations().catch(() => {})`
    "kick" (fire-and-forget, so the IPC call still returns immediately) so a *fast* reachable original
    finishes in a second or two instead of waiting for backgroundDaemon's next scheduled 30s tick,
    while a genuinely slow one just proceeds exactly as it would have anyway.
- `PendingRotationItem` gained `attempts?: number` (reset to 0 whenever a rotation is freshly
  enqueued or combined with more rotation — a new request deserves a fresh retry budget).
- `runPendingRotations()`: a reachable-but-genuinely-failing rotation (lock held by another process,
  a transient permission error, …) now gets up to `MAX_ROTATION_ATTEMPTS` (5) tries across separate
  drain cycles — not an immediate give-up on the first hiccup, and not a silent retry-forever either.
  An unsupported format discovered only once the original's actually reachable (rare now that RAW is
  caught synchronously up front, but still reachable via anything that enqueues directly) still drops
  on the very first attempt, same as before — retrying can never help there.
- New `onRotationFailure()` / `revertLocalThumbnailAndNotify()`: once an item gives up (attempts
  exhausted) or is dropped as unsupported, the local mirror thumbnail — which was optimistically
  rotated the moment the user clicked, before the original's own fate was known — is rotated back by
  the complementary degrees via the same `rotatePhotoFile`, undoing it, and a `RotationFailureInfo`
  (`originalRemotePath`, `localFilePath`, `rotationDegrees`, `reason`) is handed to anyone listening.
  A plain listener `Set`, not a direct Electron import — mirrors `thumbnailCacheService.ts`'s existing
  `onThumbnailCacheCleared`, keeping this file testable without a `BrowserWindow`.

**Wiring the notification through to the renderer:**
- `main.ts`: `onRotationFailure((info) => mainWindow?.webContents.send('photo:rotation-failed', info))`,
  registered once at startup — same `webContents.send` pattern `backgroundDaemon.ts` already uses
  for `mirror:progress`.
- `preload.ts` / `types/index.ts`: new `onPhotoRotationFailed`, mirroring `onMirrorProgress`'s exact
  subscribe/unsubscribe shape.
- `App.tsx`: subscribes once; on the event, shows a `notify('warning', ...)` toast naming the photo
  and the reason, then refreshes the client-side caches (`bumpImageVersion` +
  `evictAndRefreshThumbnail` + `invalidateSpriteCoordinate` — the same trio from §38's crop-save fix)
  so the grid re-fetches the now-reverted thumbnail bytes instead of continuing to show the stale
  rotated ones. Deliberately does **not** also re-rotate the photo's stored face boxes back (unlike a
  normal rotate's own `afterPhotoRotated`) — that would only matter if faces were re-scanned in the
  narrow window between the original rotation request and this eventual revert, an edge case of an
  edge case not worth the complexity here.
- `PhotoLightbox.tsx`: the rotate status message for `isQueued: true` updated from "the original
  storage is offline" (no longer the only reason this happens) to "the full-resolution original is
  finishing in the background."

**Verification.** `rotateOffline.spec.ts` (+5 new, 2 updated): the existing "online RAW rejected
synchronously" test needed no changes at all — confirms that exact behavior was preserved; the
"online, reachable, non-RAW" test updated from expecting an inline rotation to expecting it queued
(and, since the fire-and-forget kick can genuinely finish before the test's own next `await` in this
environment, rewritten to assert the eventual correct end state rather than a now-racy "untouched so
far" snapshot); new tests cover an online original queuing and draining via an explicit
`processPendingRotations()` call, a genuinely-failing-but-reachable original surviving under
`MAX_ROTATION_ATTEMPTS` retries before giving up (not giving up on just the first failure), the give-up
case reverting the local thumbnail back to its original dimensions and emitting exactly one
`RotationFailureInfo`, and an unsupported format discovered via the queue still reverting/reporting
(not just silently dropping) even without a `localFilePath` to revert. The existing sync-I/O regression
guard from §42 was narrowed to only check the photo's own paths (not the always-local, intentionally-
still-sync `pending_rotations.json`), since enqueuing now legitimately touches that file synchronously
on every call. Typecheck clean; `build:ui` and `build:electron` both succeed; full suite re-run clean.

## 44. Bulk "Add to Album" now asks which chapter, defaulting to "Others" on plain Enter

Picking an album in the multi-select "Add to Album" dialog used to add the selection straight away.
The user wanted a second step: pick the album, then pick which of its chapters the photos go into —
and if nothing is picked, pressing Enter should file them into a catch-all "Others" chapter instead
of silently adding them flat to the album (today, pressing Enter with nothing typed on step 1 just
added to the album's no-chapter bucket) — created the first time, reused after that.

**New: `components/ChapterSelectStep.tsx`** — the chapter counterpart of `AlbumPicker.tsx`, same
type-to-filter / Enter-picks-first-match-or-creates-new mechanic:
- `rankChaptersByQuery(chapters, query)`: the exact same exact/prefix/contains ranking as
  `AlbumPicker`'s own `rankAlbumsByQuery`, written as its own small standalone function (not a
  shared generic) rather than touching the existing, separately-tested one.
- A pinned **"Others"** card sits above the (filtered) chapter list at all times — clicking it, or
  pressing Enter with nothing typed, calls `onPickChapter(null)`; the caller resolves `null` to "find
  a chapter already named Others (case-insensitively), or create one." Filtered out of the ranked
  list below so a real "Others" chapter never appears twice.
- Typing a chapter's name and pressing Enter either picks the best match or creates a new chapter
  with that name — one keystroke away from "Others" is still "name something specific," same balance
  `AlbumPicker` already strikes for albums.
- Works identically for an album with zero chapters yet (shows an empty-state hint, offers "Others"
  regardless) — this step is never skipped just because an album hasn't used chapters before.
- A back arrow returns to album selection without adding anything.

**`GalleryView.tsx`**: new `albumPendingChapterSelection` state turns the dialog into two steps.
`handlePickAlbum`/`handleCreateAlbumAndAdd` now move to step 2 instead of adding immediately;
`finishAddToAlbumChapter(album, chapterId, newChapterTitle?)` replaces the old `finishAddToAlbum`,
routing to `libraryStore.createChapter` (new chapter) or `addPhotosToChapter` (existing one,
including the resolved "Others"), both of which already keep the album's own flat `photoIds` and
`lastUsedChapterId` in sync — no changes needed there. The dialog's own Escape handler now goes back
a step first (matching this app's established multi-step-modal convention) before closing outright;
the X button and backdrop click reset both dialog states so reopening it always starts at step 1.

**Verification.** New `chapterSelectStep.spec.ts` (5 tests): the pure ranking function's
exact/prefix/contains ordering, case-insensitivity, no-match, and contains-only cases.
`galleryAddToAlbum.spec.ts` rewritten for the two-step flow (10 tests, up from 4): picking an album
moves to step 2 without adding yet; picking a specific chapter by typing+Enter adds to it (and keeps
the album-level `photoIds` in sync); plain Enter creates-or-reuses "Others" (both cases, including
not duplicating an existing one); an album with zero chapters still offers the empty-state hint and
lands in "Others"; typing a brand-new chapter name creates and uses it; clicking the pinned "Others"
card matches plain Enter; the back arrow returns to step 1 without adding anything; creating a brand
new album still asks which chapter before finishing. Typecheck clean; `build:ui` and `build:electron`
both succeed; full suite 823 passing / 3 skipped (unrelated), 0 failures.

## 45. Fix: a vision model's batch answer could get silently mismatched to the wrong photo

Reported: "information returned from local model is associated with wrong image."

**Confirmed, and traced to the actual layer at fault.** Checked both ends of the pipeline that could
plausibly cause this: `smartFlowsService.ts`'s `readImages` (sequential `for...of`, never reorders)
and its result-zip (`results[j]` ↔ `withImages[j].photo`, a plain positional match) are both correct;
`ollamaVisionService.ts`'s `classifyImagesBatchLocal` builds one "Image i:" turn per photo in order,
correctly paired with that photo's own bytes. The actual gap was `visionClassify.ts`'s
`buildBatchClassifyPrompt`/`parseBatchClassifyResponse` — shared by the local Ollama pass and both
cloud providers — which asked for "a JSON array of exactly N objects, one per image IN ORDER" and
then trusted raw array position alone to mean "image 1, image 2, …". Smaller (7B-class) local vision
models are known to be less reliable at a few things under load — see §34/§35's batch-size notes —
and keeping strict positional order across several images in one multi-turn prompt is one of them:
the array comes back the right length, perfectly valid JSON, every object well-formed — just not
actually in request order. Every caption/tag/match from the first scrambled entry onward then gets
written into `photoContentCache` against the wrong photo, exactly matching the report.

**Fix.** Ask the model to say which photo each answer is about, and trust that over position:
- `buildBatchClassifyPrompt`: each object must now include `"image"` — the number from that photo's
  own "Image i" label (1-based) — framed explicitly as "this is how your answer gets matched back to
  the right photo, so get it right even if you list the objects in a different order than you were
  shown them."
- `parseBatchClassifyResponse`: maps by the declared `image` index instead of array position —
  **but only when every entry names a distinct, in-range image**. A response where some entries have
  it and others don't, or where two entries claim the same index, is just as likely to be a model
  that doesn't understand the field at all as one that's genuinely confused about ordering — mixing
  "trust the index" and "trust position" within one response is riskier than picking one strategy for
  the whole thing, so an incomplete/invalid set of indices falls all the way back to plain position
  (the previous behavior, unchanged) rather than being partially honored.
- Shared by `aiSearchService.ts`'s Gemini/OpenAI batch calls too, at no extra cost — they already
  label images "Image i:" the same way and parse through the same function, so the same self-describing
  check protects them from the identical failure mode even though it's rarer there.

**Verification.** New `visionClassify.spec.ts` (8 tests, the module had none before): a response
whose objects are listed out of order (3, 1, 2) still maps every caption to the right photo; a
well-behaved in-order response with indices still works (the common case); three distinct "don't
trust a broken index" cases — no entry has one, two entries claim the same one, one entry's index is
out of range — each correctly falls back to plain position rather than mixing strategies or crashing;
a response where only some entries carry an index also falls back, rather than half-trusting it;
the wrong-array-length rejection still throws exactly as before. `ollamaVisionService.spec.ts` and
`smartFlows.spec.ts` (39 tests between them, mocking the classify functions directly rather than
exercising `parseBatchClassifyResponse`) confirmed unaffected. Typecheck clean; `build:ui` and
`build:electron` both succeed; full suite re-run clean.

## 46. Fix: renaming a location showed the country too, and "#place" search could match the whole country

Reported: renaming a cluster of photos to "Andaman" displayed as "Andaman, India" instead; searching
`#andaman` then matched ~15,000 photos and showed the place as "India" alone.

**Confirmed — two separate bugs, both real, both now fixed.**

**Bug 1 — the rename display.** `handleSaveClusterLocationName` (PlacesMapView.tsx) correctly sets
`label`/`city` to exactly what the user typed, and deliberately leaves `country` alone (it's still
geographically correct — Andaman *is* in India). But `placesService.ts`'s `groupPhotosByPlace` —
which derives every place's displayed name, used by both the Places view and the "#place" search
autocomplete — only ever looked at `city`/`country`, synthesizing `"${city}, ${country}"` whenever
both existed, and never once considered the `label` field that exists specifically so a rename can
override that. Fixed: `albumName` now prefers a non-empty `label` over the derived string. Grouping
(`placeKey`, still `city_country`) is unchanged, so photos still cluster together correctly — only
the displayed name changes.

**Bug 2 — the search.** `smartLocalNlp`'s location-detection loop walked a flat, deduplicated set of
every city/country/label value in the library and took the *first* one that matched a substring of
the query — with no regard for which was more specific. `collectKnownLocationValues` adds a photo's
city before its country (so a single photo's own city usually wins against its own country), but
across *different* photos, whichever value some other, earlier-processed photo happened to contribute
to the set can just as easily land first. In a real library, a common country like "India" is likely
contributed by many photos well before a specific, less-common place like "Andaman" ever is — so
testing the query "Andaman, India" (what the "#place" autocomplete inserts) against the set in that
order found "India" first, matched it, and `break` before "Andaman" was ever checked — resolving the
whole search to the country, not the place. Fixed with a new `collectKnownLocationValuesBySpecificity`:
splits known values into `specific` (city + label) and `countries`, and the detection loop now checks
every specific value in full *before* any country value — a city/label can never lose to its own
country regardless of which photo the library happened to process first. Only used by the local-NLP
detection loop; `collectKnownLocationValues` (the flat version, used to list "known locations" in the
cloud providers' prompts) is untouched.

**Verification.** New `placesService.spec.ts` (5 tests, the module had none before): a custom label
wins over the derived name in both the city+country and city-only cases; the derived name is still
used exactly as before when no label is set; an empty/whitespace label is treated as no label;
photos at the same place with different labels still group together as one place. `aiSearchLocation.spec.ts`
(+1): reproduces the exact reported failure mode — two other-city India photos processed before an
Andaman one, so "India" would have landed in the known-values set first under the old code —
confirms `smartLocalNlp` still resolves to "Andaman" and `applyFilter` returns only the Andaman
photo, not all three India photos. Typecheck clean; `build:ui` and `build:electron` both succeed;
full suite 837 passing / 3 skipped (unrelated), 0 failures.

## 47. Follow-up to §46: the SAME bug lived a second time in the main process's startup summary

The user re-confirmed §46's symptom was still visible after that fix shipped. Re-investigating found
a second, independent copy of the exact same bug: `catalogService.ts`'s `placeKeyAndName` — used by
`computePlacesSummarySql` and `computePlacesSummary`, the SQL-backed/plain-JS fast-path summaries
that populate `libraryState.places` on every library open/switch (see `libraryStore.ts`'s
`meta.placesSummary` loads) — is a separate, hand-duplicated copy of §46's naming logic in the MAIN
process, which never looked at a photo's `label` either. §46's fix only reached the RENDERER's
`placesService.ts` (`groupPhotosByPlace`), which `updatePhotos()` already recomputes live right after
a rename within the same session — but the very next library open/switch overwrites `places` again
from this unfixed catalog summary, resurfacing "Andaman, India" regardless of the live-session fix.
This is why the bug looked unfixed to the user: the live-session display was already correct, but the
startup/reload path wasn't touched at all.

**Fix**: the identical one-line change as §46, applied to `placeKeyAndName` — a non-empty `label`
wins over the derived `"${city}, ${country}"` string, in both the `city`+`country` and `city`-only
branches. Also strengthened the cloud-provider prompts (`queryGemini`/`queryOpenAI` in
`aiSearchService.ts`) with an explicit instruction to return the most specific place (e.g. "Andaman")
rather than the bare country, covering the same ambiguity for whichever user has a cloud provider
configured for "Search with AI" instead of relying on the local pass — a best-effort prompt hint, not
independently verifiable by a unit test the way the deterministic code paths are.

**Verification.** New test in `wholeLibraryReads.spec.ts`: seeds one renamed ("Andaman", label set)
and one never-renamed ("Udaipur, India") photo, confirms both `computePlacesSummarySql` (the real
SQLite-backed path) and `computePlacesSummary` (its plain-JS sibling) return "Andaman" for the first
and the unchanged "Udaipur, India" for the second — exercising the actual fast-path functions the app
uses at startup, not just the renderer-side oracle. The file's existing SQL-vs-old-JS equivalence
tests (several timezone variants, 4000-8000 synthetic photos each) still pass unchanged, confirming
the fix didn't disturb that equivalence property. Typecheck clean; `build:ui`, `build:electron`, and
the Windows installer (`electron-builder --win`) all rebuilt successfully with this fix included —
the v2.2.0 artifacts built moments earlier (before this fix) were discarded and rebuilt fresh. Full
suite re-run clean: 838 passing, 3 skipped (unrelated), 0 failures.

## 48. Follow-up to §45: the self-reported "image" index wasn't enough — local batching removed entirely

Reported (with screenshots): two adjacent photos in the library each showed an AI Info caption that
actually described a *different* photo from the same run — not each other's (not a simple swap),
each one's displayed caption belonged to some other photo entirely. This is the exact failure mode
§45 was meant to fix, now observed again after that fix shipped — via the new always-on background
auto-tagging feature (`aiAutoIndexService.ts`, docs/FEATURE_AI_AUTO_TAGGING.md), which sends far more
local vision calls than manual Smart Flow runs ever did, and (unlike Smart Flows' human-reviewed
match/no-match verdicts) writes its caption/tags straight into the shared cache with zero review —
exactly where a mismatch is both more likely to occur and least likely to be caught before the user
sees it.

**Root cause: §45's fix narrows the failure, it doesn't close it.** `parseBatchClassifyResponse`
trusts a model's self-reported `"image"` index over array position — but only ever checked that the
indices were *present, distinct, and in range*, never that they were *correct*. A small (7B-class)
local model can return a well-formed, correctly-sized response where every entry carries a valid,
distinct, in-range `"image"` value that is nonetheless a confident, consistent lie — e.g.
consistently reporting "image: 1" for content that's actually about the second photo it was shown.
There is no way to detect this from the response's shape alone; by the time the array comes back,
whatever confusion happened inside the model's own attention over multiple images in one prompt has
already corrupted the mapping, index field included. §45's fix genuinely helps when the model gets
the *position* wrong while still tracking *which photo is which* correctly — it does nothing when
the model loses track of which photo is which in the first place.

**Fix: stop asking a local model to track more than one photo per request at all.**
`ollamaVisionService.ts`'s `MAX_LOCAL_BATCH_SIZE` (previously 20, sized from the context window via
`computeLocalBatchSize`) is now pinned to `1`. One photo per local vision call makes cross-photo
attribution confusion structurally impossible — there is no second image in the request for the
model to conflate the first one with. This applies everywhere `computeLocalBatchSize` is used:
`smartFlowsService.ts`'s local pass and `aiAutoIndexService.ts`'s background loop both now send
exactly one image per call, with no change to either's own calling code (both already compute their
batch size by calling this one function). Cloud providers are unaffected — their fixed
`CLOUD_BATCH_SIZE` batching stays as-is; nothing reported an issue there, and §45's index-based fix
still covers them as a second line of defense regardless.

The honest tradeoff: this is strictly slower (N local vision calls instead of batched ones) for both
the local Smart Flows pass and the background auto-tagging feature. Correctness clearly outweighs
throughput for data that's displayed as fact with no human review — Settings' Context Window help
text and the in-run log line were both updated to stop advertising "more photos per call" for a
bigger context window, since that's no longer true (the context window now only sizes a single call's
own token budget). The `computeLocalBatchSize` function and its token-budget math were kept rather
than deleted, as the sizing a future, more reliable local model might reintroduce batching with.

**What this does NOT fix**: photos already mis-captioned by a run before this fix shipped keep their
wrong caption/tags — `aiAutoIndexService`'s "already done" check is "has any non-empty caption",
which doesn't distinguish a correct caption from a wrong one, so an already-corrupted entry is never
automatically retried. The practical workaround with existing features: running any Smart Flow
against the affected photos re-sends them to vision (Smart Flows' own skip-check is per-flow-
description, not "has a caption"), overwriting the bad caption with a fresh, now-single-image,
correct one. No new "clear/retag" UI was built for this — not requested, and the existing Smart
Flow workaround already covers it.

**Verification.** New test in `ollamaVisionService.spec.ts`: `computeLocalBatchSize` returns `1`
regardless of context window size (512 through 128,000 tokens) — a direct regression lock on the
constant itself, which no prior test covered. `aiAutoIndexService.spec.ts` (8 tests) and
`smartFlows.spec.ts` (19 tests) both re-run clean unchanged — neither asserted a specific batch size
or call count that this affects (T1/T2/T7/T9 in the former all remain correct whether the local pass
makes one call or several, since the test fixtures size their mocked responses to however many
images an actual call carries). Typecheck clean. Full suite re-run clean (see below).
