# Thumbnail Caching & Face Detection Pipeline — Redesign

Status: Approved for implementation (decisions locked in via stakeholder Q&A on 2026-09-16)
Owner: Sachin Bhavsar
Related: [CURRENT_STATUS_AND_GAPS.md](CURRENT_STATUS_AND_GAPS.md), [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md)

## 1. Why this rewrite

The current codebase has **three independent processing paths** that each implement
thumbnail caching, face detection and OneDrive space-reclaim differently:

| Path | Thumbnail | Face detection | Unpin | Runs unattended? |
|---|---|---|---|---|
| OneDrive unified sync (`App.tsx` `handleUnifiedOneDriveSync`) | per-photo | per-photo, immediately after | per-photo, immediately after | No (needs renderer open) |
| Plain network sync (`virtualMirrorService.syncVirtualStorage`) | bulk, all files first | separate bulk pass afterward | n/a | No (needs renderer open) |
| Background daemon (`backgroundDaemon.runBackgroundSyncCycle`) | bulk | **cannot run at all** (face-api.js needs a DOM) | after thumbnails only | Yes |

This causes: OneDrive files being hydrated twice (once for thumbnails by the
daemon, once for faces later by the renderer), no fixed/authoritative file count,
and no way to run face detection unattended.

Root cause: face detection (`@vladmandic/face-api`) only runs in a browser-like
DOM/canvas context, so it has always been renderer-only. Everything else — the
three divergent orchestration paths, the missing inventory gate, the dual count
sources — is a downstream consequence of engineering around that constraint.

This redesign removes the constraint at its source (moves face detection into
the main process via a native ONNX engine) and then unifies the three paths into
one.

## 2. Decisions locked in

1. **Full unification**: one shared per-photo pipeline (thumbnail → face → unpin)
   used by OneDrive sync, plain network sync, AND the unattended background
   daemon. The daemon becomes capable of full thumbnail+face+unpin cycles with
   the app closed.
2. **Face engine**: replace `@vladmandic/face-api` (renderer/DOM-based) with a
   native ONNX pipeline running in the **main process**:
   [SCRFD](https://github.com/deepinsight/insightface) for detection +
   [ArcFace](https://github.com/deepinsight/insightface) (`w600k_r50`, 512-d
   embeddings) for recognition, executed via `onnxruntime-node`. No DOM, no
   hidden BrowserWindow, works with the app fully closed.
   - Windows x64 only (matches `electron-builder.yml`), so only one
     `onnxruntime-node` prebuilt binary needs to ship.
   - Licensing: personal/internal use only → InsightFace's non-commercial
     research license is acceptable for these model weights. **If this app is
     ever distributed/sold, the models must be swapped** (e.g. YuNet + a
     permissively-licensed recognition net) — flagged in code comments and
     `docs/CURRENT_STATUS_AND_GAPS.md`.
3. **Migration**: full reset. All existing `faces` and `people` rows are wiped
   (old 128-d face-api.js descriptors are incompatible with new 512-d ArcFace
   descriptors — no way to cross-match old vs new automatically). Users re-tag
   from scratch after upgrading. `photos.face_scan_completed` and the new
   `faces_locked` are reset to 0 for all photos as part of the same migration.
4. **Video files**: out of scope. Inventory, thumbnails, and face detection
   remain photo/image-only, matching today's `SUPPORTED_EXTENSIONS`.
5. **Count source of truth**: a proper `virtual_storages` table row (this table
   already exists in the schema but is currently unused — storage config is
   actually persisted as a JSON blob under a `settings` key). The rewrite makes
   this table authoritative: it stores the fixed inventory total and every UI
   surface (sidebar, Virtual Storage view) reads the same DB value. No more
   live disk-scan counts or divergent last-sync snapshots.
6. **Auto-lock**: a photo automatically becomes locked (excluded from future
   auto face-rescans) the moment every face currently attached to it is
   confirmed — including the trivial case of zero detected faces. No separate
   manual "verify" action is required, though the user can still force a
   rescan via a per-photo "Detect Faces" button, which unlocks it.
7. **Online-gating**: universal. Any photo whose source storage is currently
   unreachable (OneDrive not synced/hydrated, NAS offline, etc.) cannot have
   face detection run against it — the action is disabled with a reason shown.
   Editing existing face/person data (confirm, reassign, rename, delete face
   mark) always works offline, against locally cached DB rows.
8. **Logging**: `electron-log`, file rotation implemented as "shift on startup,
   keep last 5" (not electron-log's default size-based rotation). Level
   defaults to `debug` in dev builds and `info` in packaged builds; a hidden
   Settings toggle can force `debug` in a packaged build for field
   troubleshooting. Every user-initiated action gets a `debug`-level entry/exit
   log (the "assertion" logging requirement) — gated by level, never commented
   out.
9. **Naming convention**: maintain the existing convention (camelCase
   vars/functions, PascalCase classes/components, snake_case DB columns mapped
   to camelCase at the repository boundary) in new/changed code only. No
   speculative renaming of untouched code.
10. **Delivery**: sprint-by-sprint, stopping after each sprint for review before
    starting the next (see `PIPELINE_REDESIGN_SPRINT_PLAN.md`).

## 3. Target architecture

### 3.1 Data model changes

```sql
-- virtual_storages: becomes authoritative (was: JSON blob under settings key
-- 'gphotos_virtual_storages_v1'). Migration copies existing blob rows in.
ALTER TABLE virtual_storages ADD COLUMN storage_type TEXT NOT NULL DEFAULT 'plain';
  -- 'plain' | 'onedrive'
ALTER TABLE virtual_storages ADD COLUMN inventory_status TEXT NOT NULL DEFAULT 'not_started';
  -- 'not_started' | 'scanning' | 'completed' | 'failed'
ALTER TABLE virtual_storages ADD COLUMN inventory_total_files INTEGER NOT NULL DEFAULT 0;
ALTER TABLE virtual_storages ADD COLUMN inventory_completed_at TEXT;
ALTER TABLE virtual_storages ADD COLUMN inventory_error TEXT;
ALTER TABLE virtual_storages ADD COLUMN last_reachable_at TEXT;

-- photos: replace facesManuallyVerified with the unified auto-lock flag.
ALTER TABLE photos ADD COLUMN faces_locked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE photos ADD COLUMN thumbnail_cached_at TEXT;
ALTER TABLE photos ADD COLUMN onedrive_released_at TEXT;
-- face_scan_completed is kept as-is (still means "a detection attempt ran").

-- faces: tag which engine produced a row, so a future engine swap can
-- selectively invalidate instead of requiring another full reset.
ALTER TABLE faces ADD COLUMN detector_version TEXT NOT NULL DEFAULT 'scrfd-arcface-v1';
```

`photos.faces_manually_verified` is dropped in favor of `faces_locked` (same
purpose, now also set automatically — see §3.4).

### 3.2 Inventory gate (requirement 1 & 2)

State machine per `virtual_storages` row:

```
not_started --(user adds storage / clicks Rescan)--> scanning --> completed
                                                          \--> failed (retry re-enters scanning)
```

- While `inventory_status != 'completed'`: the pipeline does **not** process
  that storage's photos (no thumbnails, no face detection). The Virtual
  Storage view shows an "Inventorying… (N files found so far)" progress state
  instead of a fixed count. The sidebar excludes this storage's photos from
  the total until inventory completes (shows "counting…" next to it if it's
  the only storage).
- Inventory scan reuses `scanDirectoryRecursive` (`fileOrganizer.ts`) purely to
  **count** eligible files (no processing) and writes `inventory_total_files`
  + `inventory_completed_at` once done. This total becomes the fixed
  denominator shown everywhere ("124 of 340 processed").
- "Rescan" resets `inventory_status` to `scanning` and recomputes the total
  (picks up newly added files), without blocking already-processed photos
  from continuing to display.
- Both the sidebar photo count and the Virtual Storage view read
  `inventory_total_files` / `SELECT COUNT(*) FROM photos` joined against the
  same `virtual_storages` row — single source of truth, no live disk scans for
  display purposes (requirement 2).

### 3.3 Unified per-photo pipeline (requirement 3)

New module `src/main/services/pipelineOrchestrator.ts` replaces
`handleUnifiedOneDriveSync` (renderer), the plain-network branch of
`syncVirtualStorage`, and `backgroundDaemon.runBackgroundSyncCycle`'s
thumbnail-only logic. One code path, parameterized by storage type:

```
for each storage with inventory_status == 'completed':
  if storage is network-backed and not reachable: skip (log + surface status), continue to next storage
  for each pending photo (thumbnail_cached_at IS NULL OR (face_scan_completed = 0 AND faces_locked = 0)):
    1. ensure thumbnail cached (reuse thumbnailCacheService, unchanged)
    2. set thumbnail_cached_at
    3. if storage reachable AND NOT faces_locked:
         run face detection (new main-process ONNX engine) on full-resolution source
         persist faces, run incremental clustering
         set face_scan_completed = 1
         recompute faces_locked (see 3.4)
    4. if storage_type == 'onedrive' and file was hydrated:
         markFileForSpaceReclaim(filePath)  -- reuses existing oneDriveService, unchanged
         set onedrive_released_at
    5. CPU/RAM duty-cycle yield (reuses thumbnailWorkerService's existing throttle heuristic)
```

This runs identically whether triggered from the renderer (manual
"Sync"/"Rescan" button) or from the background daemon on its timer — same
function, different caller. The daemon can now run it to completion because
face detection no longer needs a DOM.

### 3.4 Face lock (requirement 6, already-approved auto semantics)

`faces_locked` is recomputed (not just set once) at every point where a
photo's face set changes:

- After initial detection: if 0 faces were detected, lock immediately (nothing
  to confirm). If faces were detected, leave unlocked.
- After any face-editing action (confirm, unconfirm, reassign, delete mark) —
  in the IPC handler, after persisting: `faces_locked = (COUNT(*) FROM faces
  WHERE photo_id = ? AND is_confirmed = 0) == 0`.
- The photo-detail "Detect Faces" button explicitly force-sets
  `face_scan_completed = 0, faces_locked = 0` for that one photo and enqueues
  it at high priority in the pipeline queue (reuses the existing
  high/normal/low priority concept from `faceQueue.ts`, ported to main).
- Locked photos are skipped by the pipeline's "pending photo" query above,
  even across full rescans, until explicitly unlocked.

### 3.5 Full-resolution face detection incl. HEIC (requirement 4)

`heicService.extractRawHeicJpeg()` currently prefers the embedded EXIF
thumbnail (fast, but not guaranteed full-resolution) for both thumbnailing and
face detection. The rewrite splits these:

- Thumbnailing keeps the existing fast path (embedded thumbnail preferred) —
  no requirement to change this, it's a resized cache image anyway.
- A new `heicService.getFullResolutionBufferForDetection()` **skips the
  embedded-thumbnail shortcut** and always goes through the full bitstream
  decode (`sharp()` direct decode → `heic-convert` fallback), so face
  detection always sees the true full-resolution pixels. This is slower per
  HEIC photo but only runs once per photo (result isn't cached beyond the
  detection call, same as today's temp-file cleanup pattern in
  `prepareHeicHqTemp`).
- Non-HEIC formats already pass the true original file to detection — no
  change needed there.

### 3.6 Online-gating for ad-hoc detection, offline edits allowed (requirement 5)

- `pipelineOrchestrator` checks `networkReachabilityCache.isPathReachable()`
  (existing service, reused) before attempting detection on any
  network-backed photo (OneDrive or plain/NAS) — applies universally per the
  locked decision.
- Renderer UI: the "Detect Faces" button (bulk and per-photo) queries
  reachability via IPC and disables itself with a tooltip ("Storage
  unavailable — reconnect to detect faces") when the relevant storage is
  offline. This reuses the existing `isKnownOfflineStorage` cache rather than
  probing on every render.
- Face/person edit actions (confirm, reassign, rename person, delete face
  mark) are pure DB writes against the local SQLite catalog — they have never
  depended on file reachability and continue to work offline unchanged.

### 3.7 Face detection engine (new, main process)

New `src/main/services/faceDetectionEngine.ts`:

- Loads SCRFD (detection) and ArcFace (`w600k_r50`, recognition) ONNX models
  from `resources/models-onnx/` via `onnxruntime-node`, once at startup
  (singleton, lazy-initialized on first use so app boot isn't blocked).
- `detectFaces(imageBuffer: Buffer): Promise<DetectedFace[]>` — decodes with
  `sharp` (already a dependency) into the tensor layout SCRFD expects, runs
  detection, crops+aligns each face, runs ArcFace to get a 512-d descriptor.
  Shape mirrors today's `DetectedFace` type (box, descriptor, confidence) so
  downstream code (clustering, `faces` table writes) needs minimal changes.
- Runs fully synchronously within a photo's pipeline step — no queue of its
  own needed; `pipelineOrchestrator`'s existing per-photo loop and CPU/RAM
  throttle double as the concurrency control.

`src/renderer/src/services/faceEngine.ts` and `faceQueue.ts` are deleted;
`clustering.ts` moves from renderer to `src/main/services/faceClustering.ts`
(pure logic, no DOM dependency, ports cleanly) and is invoked by
`pipelineOrchestrator` using the existing batching heuristic (every 8 photos /
10+ new faces / queue-empty) to avoid O(n²) reclustering per photo.

### 3.8 Logging & error handling

New `src/main/services/logger.ts`:

- Wraps `electron-log`. On app startup (before anything else logs):
  rotate `userData/logs/main.log` → `.1` → `.2` … `.5`, delete anything beyond
  `.5`. This is a startup-time shift, not electron-log's built-in size-based
  rotation — matches "last 5 log files available, rest removed on startup"
  literally.
- Renderer logs bridge to the same file via electron-log's built-in IPC
  transport, so one set of log files covers both processes.
- Level: `debug` when `!app.isPackaged`, `info` when packaged. A
  `settings` row (`log_level_override`) lets a packaged build be flipped to
  `debug` from Settings for field troubleshooting, without a rebuild.
- Every user-initiated action (add storage, rescan, detect faces, confirm
  face, reassign face, delete face mark, rename person, remove storage) logs
  at `debug` on entry (action + params) and at `debug`/`error` on completion
  (result or failure) — this satisfies the "assertion for each user action"
  requirement via level-gating instead of commented-out code.
- All IPC handlers and pipeline steps: consistent
  `try { ... } catch (err) { logger.error(...); return { success: false, error } }`
  pattern (extends the convention already used in most of the codebase —
  see `virtualMirrorService.processOneMirrorFile`'s `{success, error}`
  pattern — applied universally and now always logged, not just
  `console.warn`).

## 4. Non-goals / explicitly out of scope

- Video file inventory, thumbnails, or detection.
- Cross-platform (macOS/Linux) packaging of the ONNX runtime — Windows x64
  only, matching current `electron-builder.yml`.
- Preserving old face/person data across the engine switch (full reset,
  decision #3).
- Renaming variables/files outside the code this rewrite actually touches.

## 5. Risks & mitigations

| Risk | Mitigation |
|---|---|
| `onnxruntime-node` native binary breaks packaging (first native ML dep in this project) | Prototype the model load + a single inference call in Sprint 2 before wiring it into the pipeline; `sharp` already proves native modules package fine with electron-builder on this project. |
| Full reset wipes user's existing face tagging work | Called out explicitly in-app (one-time migration dialog: "Face recognition has been upgraded; you'll need to re-tag people") before the migration runs, not silent. |
| SCRFD/ArcFace accuracy differs from face-api.js (more/fewer faces detected, different confidence calibration) | Sprint 2 includes a manual spot-check against a handful of existing photos before Sprint 3 wires it into the live pipeline. |
| Daemon now doing full face detection unattended could spike CPU/battery on laptops | Reuse and extend the existing CPU/RAM duty-cycle throttle (`thumbnailWorkerService`) to gate the face-detection step too, not just thumbnails. |
