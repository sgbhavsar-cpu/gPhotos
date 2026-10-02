# Feature: Video Files as Library Items (Thumbnail, Hover Preview, Playback)

Status: implemented. Companion to [FEATURE_AI_AUTO_TAGGING.md](FEATURE_AI_AUTO_TAGGING.md). See [CODE_REVIEW_2026-09-26.md](CODE_REVIEW_2026-09-26.md) for ongoing fix log conventions this follows.

## 1. Problem

gPhotos only ever scans/shows image files (confirmed: no `.mp4`/`isVideo`/`videoPath` anywhere in the codebase before this feature). Requested: scan a library folder for video files too, show a thumbnail + a "this is a video" badge in the gallery, play the video in-app on click, and — on a ~2s hover — play a short, auto-generated preview clip (sampled from ~10-20 frames across the video) inline in the tile, like YouTube/Google Photos hover previews.

## 2. Design

### 2.1 Why this is greenfield (and where it plugs in)

Nothing in scanning, the `Photo` type, the SQLite schema, the gallery grid, or the lightbox treats a video any differently from "not an image we can decode" today. Rather than a parallel "Video" system, a video is modeled as **the same `Photo` row** with `isVideo: true` — it already flows through every existing list/filter/album/sync code path for free; only the handful of places that actually decode pixels need a video-aware branch.

### 2.2 Data model

- `Photo.isVideo?: boolean`, `Photo.videoDurationSec?: number` (`src/types/index.ts`).
- `photos` table: `is_video INTEGER NOT NULL DEFAULT 0`, `video_duration_sec REAL` — added to `SCHEMA_STATEMENTS` (new DBs) and via `ensureColumn` (existing DBs), per `db.ts`'s established migration pattern.
- `libraryRepository.ts`: `rowToPhoto`, `UPSERT_PHOTO_SQL`, `photoToParams` extended with both fields.

### 2.3 Scanning

- `fileOrganizer.ts`: new `VIDEO_EXTENSIONS` (`.mp4 .mov .avi .mkv .webm .wmv .m4v`) and `isVideoFile()`, alongside the existing `isImageFile()`/`SUPPORTED_EXTENSIONS`. `scanDirectoryRecursive`'s file filter becomes `isImageFile(fullPath) || isVideoFile(fullPath)` — the one shared walk every scan path (local library open, virtual/network mirror sync) routes through, so both pick up videos from a single change.
- `scanPhotoDirectory()` (the function `catalogService.ts` calls to build a library's `Photo[]` on open) sets `isVideo` from `isVideoFile(filePath)` and, for a video, awaits `probeMedia(filePath)` (reused from `videoExportService.ts` — no ffprobe binary needed, parses ffmpeg's own stderr banner) to fill `videoDurationSec`. This one extra awaited ffmpeg process per **video** file (not per photo) matches the loop's existing per-file sequential-await cost profile; a library with few/no videos pays nothing extra.
- `exifParser.parsePhotoMetadata` needs no change: `exifr.parse()` on a video file already throws internally (caught, non-fatal) and the function already falls back to the file's mtime for `dateTaken` — the exact fallback a video needs.

### 2.4 Grid thumbnail (reuses the thumbnail cache/queue as-is)

`thumbnailCacheService.getOrGenerateCachedThumbnail(sourcePath, targetSize)` gains one new branch at the top of its generation pipeline: if `path.extname(sourcePath)` is a video extension, first extract a single frame via `ffmpeg -ss <t> -i <video> -frames:v 1 -f image2pipe -vcodec mjpeg -` (reusing `getFfmpegPath()` from `videoExportService.ts`) into an in-memory JPEG buffer, seeking to `min(1s, 10% of duration)` (probed once via `probeMedia`) rather than frame 0 — a video's very first frame is disproportionately likely to be black/blank. That buffer is then fed into the **existing** `sharp(buffer).resize(...).jpeg(...)` pipeline exactly like any other source, so every downstream concern (multi-tier caching by size, cache key by mtime, HEIC-style fallback chain, cache invalidation on purge) is unchanged. This also means video thumbnails ride the **existing** background thumbnail queue (`thumbnailWorkerService.ts`) automatically, with no new queue of its own.
- `gphoto://` protocol handler's `IMAGE_MIME` allowlist gate is unaffected for thumbnail requests (`getOrGenerateCachedThumbnail` is still called with `targetPath` = the video file, but only to *generate*; the 403 gate guards *serving raw bytes*, a separate concern — see §2.6).

### 2.5 Hover preview clip

New `src/main/services/videoPreviewService.ts`, **on-demand** (not a background sweep — see §2.8 for why):

1. `getOrGenerateVideoPreview(sourcePath)`: cache key = same `getCacheKey(path, mtimeMs, size)` scheme from `thumbnailCacheService` (`size` fixed to a sentinel, e.g. `-1`, so it never collides with a real thumbnail size bucket), cache dir `userData/cache/video_previews/`. Cache hit → return the existing `.mp4` path immediately.
2. Cache miss: `probeMedia()` for duration; pick **12** evenly-spaced timestamps across the middle 90% of the clip (skip first/last 5% — title cards / fade-to-black); extract each as a JPEG via the same seek+grab command as §2.4 (12 short ffmpeg processes — seeking is fast, no full decode); then one ffmpeg pass assembling the 12 JPEGs into a silent, muted, 320px-wide, ~2fps mp4 (`-framerate 2 -i frame_%02d.jpg -vf scale=320:-2 -c:v libx264 -pix_fmt yuv420p -movflags +faststart preview.mp4`) — a ~6 second looping preview. In-flight de-duplication (same `inFlightJobs` map pattern as thumbnails) so two simultaneous hovers on the same video don't double the work.
3. IPC: `video:get-preview` (invoke) → `preload.ts`'s `getVideoPreview(filePath, originalRemotePath, mtimeMs)`. Returns `{ path }` or `{ error }`; never throws across the IPC boundary.
4. `PhotoCard.tsx`: on `onMouseEnter`, starts a 2000 ms timer; if the mouse is still over the tile when it fires, calls `getVideoPreview` and, on success, swaps the static thumbnail `<img>` for a `<video autoPlay muted loop playsInline>` pointed at the returned path, positioned absolutely over the same spot. `onMouseLeave` clears the timer and unmounts the `<video>` (reverts to the thumbnail) regardless of whether generation finished. A still-generating preview on first-ever hover is not retried mid-hover — the tile just keeps showing the static thumbnail for that hover; the NEXT hover (now cached) shows the preview. This keeps hover feel simple and is why the one-time generation lives on-demand, not gating hover on a spinner.

### 2.6 Full playback (in-app, like a photo opens)

- `PhotoLightbox.tsx`: a new top-level branch — `photo.isVideo ? <video .../> : <existing image/pan/zoom stack>` — at the same slot the image currently renders. Uses native `controls` (play/pause/seek bar/volume/fullscreen — the browser's own video UI, same as every other video on the web), `autoPlay`, sized by the existing max-width/height box. Crop/rotate/edit toolbar buttons are hidden for a video (`!photo.isVideo` guard added to their existing conditional render) — none of those operations are meaningful for a video file. A "Video · m:ss" pill in the header (next to the filename, same convention as the existing `isVirtual`/"Original Full-Res" pills there) makes it unambiguous at a glance that this is a video, not just implicit from the player showing up.
- `PhotoCard.tsx`: besides the corner duration pill (§2.4's original design), an always-visible centered translucent play-circle (hidden only while the hover-preview clip is actually playing over it) makes a video tile unmistakable without needing to hover first — the corner pill alone wasn't judged clear enough on its own.
- `gphoto://` protocol handler: `IMAGE_MIME` gate extended with a parallel `VIDEO_MIME` map (`.mp4` → `video/mp4`, `.mov` → `video/quicktime`, `.mkv` → `video/x-matroska`, `.webm` → `video/webm`, `.avi` → `video/x-msvideo`, `.wmv` → `video/x-ms-wmv`, `.m4v` → `video/x-m4v`); the 403 check becomes `!IMAGE_MIME[ext] && !VIDEO_MIME[ext]`. A **new** branch, checked before the existing image branches, serves a video file with HTTP Range support (`206 Partial Content` + `Content-Range`/`Accept-Ranges`) so `<video>` can seek without downloading the whole file first — the existing image branches read the whole file into one `Response` and have no such need. `getLocalPhotoUrl(photo.filePath, photo.originalRemotePath, true, 0)` (same call shape the lightbox already uses for a full-res photo) reaches this branch unchanged.
  - Upgraded: `serveFileWithRangeSupport` (`rangeFileServer.ts`) streams directly off disk (`fs.createReadStream` → `Readable.toWeb` → the `Response` body) rather than buffering the requested range — or, previously, the WHOLE file on a no-Range request — into memory first. This matters specifically for a video on a OneDrive/Google Drive "Files On-Demand" placeholder: each streamed chunk only pulls the bytes actually read, so the desktop sync client fetches (and the player waits on) just that range instead of the whole file materializing first. A still-visible gap: a `<video>` tag's very first request to a URL it's never seen before isn't guaranteed to carry a `Range` header (Chromium/Electron do send one for most media requests, but it's not contractually guaranteed) — when it doesn't, the no-Range branch still correctly streams the entire file as one `200` response (per HTTP spec, no Range header means the full body), so a cold sync-client file with a slow/absent Range request on that very first hit could still mean the player waits on the whole transfer before playing. In practice this is rare for video elements in Chromium.
  - **What this is, and isn't**: this is streaming over the *local filesystem path* to whatever already resolves there — a locally-synced OneDrive/Google Drive folder (their desktop sync client's own Files-On-Demand/streaming-filesystem layer decides how much to actually fetch per read) or a local/NAS file. It is **not** a direct integration with the OneDrive (Microsoft Graph) or Google Drive REST APIs — this app has no cloud OAuth/API client for either service anywhere in the codebase. True "stream straight from the cloud API, no local sync client involved at all" is a materially larger, separately-scoped feature (OAuth flow, a Graph/Drive API client, their own byte-range fetch semantics) and wasn't built as part of this change — see the reply that introduced this note for the explicit scoping question back to the user.

### 2.7 Keeping videos out of image-only pipelines

Guarded with a plain `!photo.isVideo` filter at each enqueue site:
- Face detection (`faces:detect-batch` and the background face-scan queue) — a face scan on a video file isn't meaningful today.
- Smart Flows' candidate list (`smartFlowsService.ts`) and the new AI auto-index loop (see the companion doc) — a vision-classify batch call expects still images.
- Sprite sheet pre-baking (`spriteService.ts`) — sprites are a grid-thumbnail optimization; a video's thumbnail is still a static JPEG frame via §2.4, so sprites actually work unchanged for it, but excluding videos from the explicit sprite-bake-priority list avoids spending a sprite slot on a tile that already hits the background thumbnail cache fine on its own. *(Minor — not required for correctness, included for parity.)*

### 2.8 Rescanning a library that predates video support

A library (local folder or virtual/network mirror) opened for the first time scans fresh and picks
up videos automatically — no action needed. But an **already-indexed** library needs to be told to
look again, since nothing watches an arbitrary folder for changes:

- **Virtual/network mirrors already had a working "Rescan" action** (`syncVirtualStorage` →
  `scanDirectoryRecursive`, both updated for video support in §2.3) — it re-walks the source and
  picks up new videos with no further changes needed here.
- **Plain local libraries had no equivalent at all.** `switchCatalogLibrary` (`catalogService.ts`)
  deliberately skips re-scanning a folder once its database exists (by design — that's what makes
  reopening a library instant), so there was no existing path, and re-clicking "Open Folder" on an
  already-indexed path hits that same short-circuit. Added `rescanLocalLibrary` (`catalogService.ts`),
  a new `catalog:rescan-library` IPC, and `libraryStore.rescanLibrary()` — explicitly re-walks the
  folder via the same `scanPhotoDirectory` used for a first-time open. Unlike a first open, a rescan
  of an already-populated library must not blindly overwrite user edits: each freshly-scanned photo
  is merged against its existing DB row (by id, stable across rescans for the same `filePath`),
  carrying forward `isFavorite`/`isExcluded`/`rotation`/`isHeicRotated`/`heicRotation`/
  `faceScanCompleted`/`facesLocked`/`sharpnessScore`/`originalMtimeMs` — fields a disk scan has no way
  to know — while taking every disk-derived field (including `isVideo`/`videoDurationSec`) from the
  fresh scan. Exposed as the same **Rescan** toolbar button Photos already shows for a virtual
  library (`GalleryView.tsx`'s `rescanButton`, now rendered for a local library too via a new
  `onRescanLocalLibrary` prop, calling `handleRescanLocalLibrary` in `App.tsx`), so there's one
  consistent "check for anything new" action regardless of library type.
- Also fixed: `main.ts`'s `scanner:scan-directory` IPC handler turned out to be a **second,
  independent copy** of the photo-building logic in `scanPhotoDirectory` (used as a legacy/browser-shim
  fallback path), which hadn't been given `isVideo`/`videoDurationSec` handling — fixed to match.

### 2.9 Explicitly out of scope / deferred

- **No background sweep that pre-generates every video's hover preview ahead of time** (unlike thumbnails). The on-demand path (§2.5) already satisfies "hover for 2s → see a preview" on the very first real hover going forward, generation included; a sweep would only save the first hover's latency per video, at the cost of a whole new persistent queue/checkpoint. Documented here as the natural next step if that latency turns out to matter in practice.
- **No OS-native video player fallback.** Playback is the app's own in-lightbox `<video>` element, matching how a photo already opens — not `shell.openPath` (that's `video:open-file`, used only by the unrelated Video Wizard export flow).
- **No video editing** (trim, rotate, re-encode) of a library video — out of scope for this request.
- **No audio waveform / scrubbing thumbnails** beyond the 12-frame hover preview.

## 3. User Stories

1. **As a user with a mixed photo+video folder**, opening that library in gPhotos shows video files in the gallery alongside photos, each with a thumbnail and a small play-icon badge.
2. **As a user browsing the gallery**, hovering over a video tile for about 2 seconds starts a short, silent preview clip playing inline in the tile; moving the mouse away reverts to the static thumbnail.
3. **As a user**, clicking a video tile opens it full-screen in the app with standard play/pause/seek controls, the same way clicking a photo opens it full-screen.
4. **As a user**, the crop/rotate/edit tools are simply absent when viewing a video — nothing to click that wouldn't make sense.
5. **As a user whose video is actually a mislabeled/corrupt file**, a thumbnail/preview that fails to generate shows a plain fallback (existing `ImageOff` state / a generic film icon), not a crash or an endlessly-loading tile.
6. **As a user with a large library of mostly photos and a handful of videos**, opening/scanning the library isn't noticeably slower than before — the extra per-video duration probe is the only added cost, and only for actual videos.
7. **As a user**, videos never get swept into face scanning, Smart Flows, or the new AI auto-tagging — those stay photo-only.

## 4. Test Cases

Unit tests (vitest):

| # | File | Scenario | Expected |
|---|---|---|---|
| T1 | `fileOrganizer.spec.ts` (new cases) | `isVideoFile()` on each supported extension + a non-video extension | True only for video extensions, case-insensitively |
| T2 | `fileOrganizer.spec.ts` | `scanPhotoDirectory` over a temp dir with 1 photo + 1 video | Video's `Photo.isVideo === true`, photo's is falsy/absent; video has a `videoDurationSec` |
| T3 | `libraryRepository.spec.ts` (new cases) | `upsertPhoto`/`getPhotoById` round-trip for a video photo | `isVideo`/`videoDurationSec` survive a DB round trip |
| T4 | `videoPreviewService.spec.ts` (new) | Timestamp-picking function for N frames over a given duration, skipping the first/last 5% | Returns exactly N increasing timestamps within `[0.05*dur, 0.95*dur]` |
| T5 | `videoPreviewService.spec.ts` | Second concurrent call for the same video while generation is in flight | Both resolve to the same result; ffmpeg invoked only once (spy) |
| T6 | `videoPreviewService.spec.ts` | Cached preview already on disk | Returns immediately, no ffmpeg process spawned |
| T7 | `thumbnailCacheService.spec.ts` (new cases) | `getOrGenerateCachedThumbnail` on a video path | ffmpeg frame-grab is invoked (spy) before sharp resize; result still cached under the normal size-bucket path |
| T8 | `mainProtocolVideo.spec.ts` (new, testing the extracted Range-serving helper directly, not the whole Electron app) | Request with `Range: bytes=100-199` on a 1000-byte file | `206`, `Content-Range: bytes 100-199/1000`, body length 100 |
| T9 | same | Request with no `Range` header | `200`, full body, `Accept-Ranges: bytes` present |
| T10 | same | `Range` beyond file size | Falls back to a safe response rather than throwing (clamped end) |
| T11 | `smartFlowsService.spec.ts` / `aiAutoIndexService.spec.ts` | Candidate list includes a video photo | Video is excluded from candidates |

**What actually shipped, and why E1-E4 moved to a component test instead of Playwright:**

E1-E4 (hover-preview timing, the badge, moving the mouse away) are covered instead by a real-DOM
vitest component test, `test/vitest/photoCardVideo.spec.ts` — it mounts the actual `PhotoCard`
component (via `react-dom/client`, the same hand-rolled render pattern already used elsewhere in
this test suite, e.g. `promptModal.spec.ts`/`dragSelect.spec.ts`) and drives real `mouseover`/
`mouseout` DOM events with fake timers, asserting the badge text, the `<video>` element's
presence/absence, and that `getVideoPreview` is only ever called after the full 2s dwell. This
gives the same confidence as a Playwright DOM assertion would (neither approach does real pixel
rendering) without needing the full app's catalog/SQLite bootstrap faked just to get photos on
screen. `PhotoLightbox` (E4's video-playback branch) has **no existing test harness anywhere in
this codebase** — it's a 3000+ line, heavily stateful component with zero prior unit tests
(confirmed by searching the whole suite); that's a pre-existing condition, not something this
feature introduced, so its video branch is covered by careful code review + a clean typecheck
instead of a new, first-ever mount of that component.

E5 — the Settings toggle — IS a genuine Playwright test, `test/test_video_and_autotag_settings_e2e.ts`,
since it's reachable with no library open at all (sidesteps the native-file-dialog problem described
below entirely). It launches the real, built app via Playwright's `_electron` launcher against a
fresh temp `--user-data-dir`, clicks through to the toggle, and asserts it survives a reload. Builds
cleanly and the script is correct, but actually executing it requires a real interactive desktop
session to launch a GUI Electron window; the sandboxed tool environment this was developed in
could not launch one at all (Playwright's `electron.launch()` failed immediately with a generic
"Process failed to launch!", before any app code ran — an environment constraint, not a defect
in the app or the script). Run it locally after `npm run build:ui && npm run build:electron`:
`npx tsx test/test_video_and_autotag_settings_e2e.ts`.

Deferred (not written): a true Playwright run of E1-E4 against the real app, which needs either
native file-dialog automation (Playwright cannot drive OS-native dialogs) or faithfully replicating
the SQLite catalog bootstrap just to get a fixture library auto-opened with no dialog — both
meaningfully riskier/costlier than the equivalent coverage above for the same assurance.

## 5. Files touched

- Modified: `src/types/index.ts`, `src/main/services/db.ts`, `src/main/services/libraryRepository.ts`, `src/main/services/fileOrganizer.ts`, `src/main/services/virtualMirrorService.ts` (scan filter sites + `generateThumbnailBuffer`), `src/main/services/thumbnailCacheService.ts`, `src/main/services/videoExportService.ts` (added the shared `grabVideoFrame` helper), `src/main/main.ts` (protocol handler + new IPC), `src/preload/preload.ts`, `src/renderer/src/components/PhotoCard.tsx`, `src/renderer/src/components/PhotoLightbox.tsx`.
- New: `src/main/services/videoPreviewService.ts`, `src/main/services/rangeFileServer.ts` (the Range-serving logic, split out of main.ts purely so it's unit-testable without importing the whole Electron bootstrap).
- New tests: `test/vitest/{fileOrganizer,libraryRepositoryVideo,thumbnailCacheServiceVideo,videoPreviewService,rangeFileServer,photoCardVideo}.spec.ts`, `test/test_video_and_autotag_settings_e2e.ts` (Playwright, see §6).

## 6. Playwright harness notes

Per the project's standing rules (never touch the real `%APPDATA%\gPhotos` or the shared mirror root `C:\GPhotos_VirtualMirrors`, never drive a window the user is using): `test/test_video_and_autotag_settings_e2e.ts` launches its **own** Electron instance via `playwright`'s `_electron` launcher with `--user-data-dir` pointed at a fresh temp folder created per run, and removes that temp folder afterward. It never opens the app the user already has running, and never points at any real photo folder or the shared mirror root — it never opens a library at all (see §4's note on why E1-E4 moved to a component test instead).
