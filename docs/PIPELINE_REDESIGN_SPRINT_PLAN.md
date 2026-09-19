# Thumbnail Caching & Face Detection Pipeline — Sprint Plan

Companion to [PIPELINE_REDESIGN_DEV_DOC.md](PIPELINE_REDESIGN_DEV_DOC.md). Six
sprints, implemented and reviewed one at a time — each sprint ends with the
app in a working, testable state.

## Sprint 0 — Logging foundation

No behavior change to thumbnails/faces; lays the groundwork every later
sprint's error handling depends on.

- **US-0.1**: As a developer, I want a central `logger` service wrapping
  `electron-log`, bridged from renderer to main, so all logs land in one
  place.
  - AC: `logger.debug/info/warn/error(scope, message, meta?)` available in
    both main and renderer; renderer calls appear in the same log file as
    main-process calls.
- **US-0.2**: As a user, I want old logs cleaned up automatically so they
  don't grow forever.
  - AC: On app startup, existing `main.log` is shifted to `.1`…`.5`; files
    beyond `.5` are deleted; verified via a vitest spec that seeds 7 fake log
    files and asserts only 5 remain after rotation runs.
- **US-0.3**: As a developer, I want dev builds verbose and packaged builds
  quiet by default, with a way to re-enable verbosity in the field.
  - AC: `!app.isPackaged` → `debug` level; packaged → `info`; a
    `log_level_override` settings row, toggleable from Settings UI, forces
    `debug` in a packaged build without a rebuild.
- **US-0.4**: As a developer, I want a consistent error-handling/logging
  pattern I can reuse in every subsequent sprint's IPC handlers.
  - AC: A short pattern documented (in code comments on `logger.ts`, not a
    separate doc) — `try/catch` → `logger.error(scope, err, context)` →
    `{success: false, error}` — and applied to at least one existing handler
    as a worked example.

## Sprint 1 — Inventory gate & unified counts

- **US-1.1**: As a user, when I add a network storage, I want the app to
  count all photos (incl. subfolders) before doing anything else, so I know
  processing hasn't silently started on a partial view.
  - AC: New storage → `inventory_status` starts `not_started` →
    `scanning` → `completed`; no thumbnail/face work is scheduled for that
    storage until `completed`.
- **US-1.2**: As a user, I want the same total photo count shown in the
  sidebar and in the Virtual Storage view once inventory finishes, so the
  numbers never disagree.
  - AC: Both UI surfaces read `virtual_storages.inventory_total_files` (or a
    join against it) for that storage; a vitest/integration test adds a
    storage with a known fixture file count and asserts both surfaces report
    the same number.
- **US-1.3**: As a user, I want to see inventory progress while it's running
  ("Inventorying… 214 files found so far") instead of a stale or wrong count.
  - AC: Virtual Storage view shows a distinct "scanning" state, not a partial
    count presented as final.
- **US-1.4**: As a user, clicking "Rescan" should pick up newly added files
  without disrupting photos already processed.
  - AC: Rescan re-enters `scanning`, updates `inventory_total_files`, and
    previously processed photos remain visible/untouched throughout.
- **US-1.5**: Migration — existing storages configured via the
  `gphotos_virtual_storages_v1` settings blob are migrated into the
  `virtual_storages` table on first run of the new version.
  - AC: A user with existing storages configured pre-upgrade sees them
    intact post-upgrade, with `inventory_status` seeded correctly (e.g.
    `completed` with the last known `totalItems` as an initial estimate,
    then corrected by the next rescan).

## Sprint 2 — ONNX face detection engine (isolated)

Built and unit-tested standalone before it's wired into the live pipeline in
Sprint 3, so a bad model swap doesn't block everything else.

- **US-2.1**: As a developer, I want SCRFD + ArcFace models loadable and
  runnable via `onnxruntime-node` in the main process, so face detection no
  longer needs a renderer/DOM.
  - AC: `faceDetectionEngine.detectFaces(buffer)` returns boxes + 512-d
    descriptors for a known test image; runs with the app's main window
    closed (proves no DOM dependency).
  - AC: Packaged build (`dist:win`) still launches and the models load
    correctly — proves `onnxruntime-node`'s native binary packages fine.
- **US-2.2**: As a developer, I want a sanity check that detection quality is
  acceptable before replacing the old engine everywhere.
  - AC: Manual spot-check note recorded (in the PR/commit description, not a
    new doc) comparing detection results on ~10 existing photos against the
    old face-api.js output.
- **US-2.3**: As a developer, I want the full-reset migration ready (but not
  yet triggered by the live pipeline), so Sprint 3 can flip it on safely.
  - AC: A migration function wipes `faces`/`people` and resets
    `photos.face_scan_completed`/`faces_locked` to 0, gated behind a schema
    version bump, with a one-time in-app notice explaining the reset before
    it runs.
- **US-2.4**: `faceClustering.ts` ported from renderer to main process.
  - AC: Existing clustering unit tests (if any) pass unchanged against the
    ported module; no DOM/browser API usage remains in it.

## Sprint 3 — Unified per-photo pipeline

The core rewrite: replaces the three divergent orchestration paths with one.

- **US-3.1**: As a user, whether I'm syncing OneDrive, a plain network
  folder, or the app is running unattended in the background, I want the
  same behavior: thumbnail, then face detection, then release, one photo at
  a time.
  - AC: `pipelineOrchestrator.ts` is the single entry point called by the
    renderer's sync/rescan actions AND by `backgroundDaemon`; the three old
    call sites (`handleUnifiedOneDriveSync`, the bulk branch of
    `syncVirtualStorage`, `runBackgroundSyncCycle`'s thumbnail-only logic)
    are removed.
- **US-3.2**: As a user, I want the background daemon to fully process
  photos (including faces) while the app window is closed.
  - AC: With the main window closed, adding photos to a watched storage
    results in thumbnails AND face-detected photos after the daemon's next
    cycle, verified via an integration test that drives the daemon directly.
- **US-3.3**: As a OneDrive user, I want my files released back to
  cloud-only storage right after processing, exactly once (not hydrated
  twice).
  - AC: A test fixture asserts `markFileForSpaceReclaim` is called exactly
    once per file per pipeline run, after both thumbnail and face steps
    complete for that file.
- **US-3.4**: As a user, I want face detection to use the true full-resolution
  image, including for HEIC photos.
  - AC: `getFullResolutionBufferForDetection` is used by the pipeline's face
    step (not the embedded-EXIF-thumbnail shortcut); a test HEIC fixture with
    a low-res embedded thumbnail but higher-res full image asserts the
    buffer passed to `detectFaces` matches full dimensions.
- **US-3.5**: As a user, if my network storage or OneDrive is offline, I
  don't want face detection to silently fail per-photo — I want it to not
  attempt at all, and clearly show why.
  - AC: Pipeline skips the face-detection step (leaves
    `face_scan_completed = 0`) for any photo on an unreachable storage,
    logs the skip reason, and the storage's UI status reflects "offline —
    face detection paused" rather than silently marking photos as scanned
    with zero faces.

## Sprint 4 — Face lock & renderer UI updates

- **US-4.1**: As a user, once I've confirmed every face on a photo, I don't
  want it re-scanned on future rescans.
  - AC: Confirming the last unconfirmed face on a photo sets
    `faces_locked = 1` automatically (no separate "verify" click needed);
    a subsequent full rescan of that storage does not touch that photo.
  - AC: A photo with zero detected faces is locked immediately after its
    (empty) detection pass.
- **US-4.2**: As a user, I want a visible way to force a re-scan of one
  specific locked photo.
  - AC: A "Detect Faces" button on the photo detail/lightbox view
    unlocks and re-enqueues that single photo at high priority, regardless
    of its current lock state.
- **US-4.3**: As a user, I want to still be able to rename a person, reassign
  a face, or remove a face mark even when my network storage is offline.
  - AC: These actions remain available and functional (DB-only writes) with
    `networkReachabilityCache` reporting the storage offline in a test.
- **US-4.4**: As a user, I want the "Detect Faces" action disabled with a
  clear reason when the relevant storage is offline.
  - AC: Bulk and per-photo "Detect Faces" controls are disabled with a
    tooltip/message when `isKnownOfflineStorage` is true for that photo's
    storage.
- **US-4.5**: Renderer cleanup — remove `faceEngine.ts`/`faceQueue.ts` and any
  UI code that assumed detection happens client-side; `PeopleView.tsx`,
  `FaceAvatar.tsx`, `ReassignFaceModal.tsx` updated to reflect
  main-process-driven detection (results arrive via IPC/DB refresh, not a
  renderer-local queue).

## Sprint 5 — Regression, cleanup, docs

- **US-5.1**: Full regression pass across the existing `npm test` suite plus
  new vitest specs added in Sprints 0–4, all green.
- **US-5.2**: Update `USER_MANUAL.md`/`README.md`/`docs/CURRENT_STATUS_AND_GAPS.md`
  to reflect the new pipeline, the one-time face-data reset users will see,
  and the new Settings log-level toggle.
- **US-5.3**: Remove now-dead code (`facesManuallyVerified` references, old
  `virtual_storages`-blob settings path, any leftover renderer face-detection
  code) confirmed via a repo-wide grep for removed symbols.
- **US-5.4**: Manual end-to-end smoke test: add a network storage, watch
  inventory → sequential processing → lock behavior → offline gating →
  OneDrive release, end to end, against a real (or realistic fixture) folder.

---

**Checkpoint protocol**: after each sprint, implementation stops for review
and testing before the next sprint begins, per the agreed delivery cadence.
