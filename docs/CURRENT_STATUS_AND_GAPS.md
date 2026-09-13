# gPhotos — Current Status & Gap Analysis

**Date:** 2026-09-13
**Scope:** Full repository review (`C:\sac\progs\gphotos`) against the product's stated goals, including a review of the currently uncommitted working tree.

---

## 1. Product goals (as stated)

1. A Google-Photos-style app, usable from **Windows desktop (Electron)** and as a **mobile web app** (browser, same LAN), with face detection, fast preview of large libraries via cached thumbnails, and people identification.
2. An **AI chatbot** that can search photos by person and location.
3. **Fastest possible browsing experience.**
4. **Basic photo editing.**
5. Scan photos for **location info (GPS EXIF)**, and let the user **override** it.

This document assesses how much of that exists today, what's mid-flight, and what's missing — so it can drive prioritization.

---

## 2. Architecture snapshot

- **Stack:** Electron 41 + React 19 + TypeScript + Vite 8. Single-user, local-first, Windows-first (some cross-platform allowances, several Windows-only hardcodes).
- **Main process** (`src/main/main.ts`): owns all IPC handlers, window/splash lifecycle, a custom `gphoto://` protocol for serving local files to the renderer, and the atomic `library.json` writer.
- **Service layer** (`src/main/services/`):
  - `catalogService.ts` — paginated catalog (`catalog_meta.json` + `chunks/page_N.json`) so the renderer never loads the full library on startup — real and wired end-to-end.
  - `thumbnailCacheService.ts` / `thumbnailWorkerService.ts` / `spriteService.ts` — multi-tier disk-cached JPEG thumbnails (sharp-backed, 4-way concurrency, CPU/RAM-throttled background pre-cache) + baked WebP sprite sheets (10×5 grids) for near-zero-cost grid rendering.
  - `virtualMirrorService.ts` — NAS/SMB/USB "virtual storage" mirroring: scans a remote source, writes local thumbnails + EXIF sidecars, never moves/alters remote originals.
  - `heicService.ts` / `heicRotationStore.ts` (new, uncommitted) — HEIC decode via EXIF-embedded thumbnail → sharp → `heic-convert` WASM fallback, plus a persisted rotation store.
  - `backgroundDaemon.ts` — system tray, registry-based "run at startup," periodic background sync timer, CPU/RAM duty-cycle throttling.
  - `embeddedWebServer.ts` — an HTTP server that mirrors nearly every IPC capability as a JSON API; this **is** the mobile-web-app delivery mechanism (same SPA bundle served over LAN).
  - `fileOrganizer.ts`, `exifParser.ts`, `zipBackupService.ts`, `libraryStatusService.ts`.
- **Renderer** (`src/renderer/src/`): view-per-nav-item SPA (`GalleryView`, `PeopleView`, `AlbumsView`, `PlacesMapView`, `VirtualStorageView`, `FolderTreeView`, `OrganizerView`, `SettingsView`), a hand-rolled global store (`libraryStore.ts`, not Redux/Zustand), on-device face recognition (`@vladmandic/face-api`, WebGL/WebGPU), duplicate/burst detection (`deduplication.ts`).
- **Data storage:** no database — everything is flat JSON. `library.json` is the source of truth; the catalog chunks are a derived, rebuild-on-every-save read cache. No SQLite/LevelDB anywhere in the stack.

---

## 3. Goal-by-goal status

### 3.1 Desktop + mobile web app, one codebase

**Status: Mostly done, but the mobile delivery path has a critical security gap.**

- The Electron desktop app and the "mobile web app" are **the same SPA bundle** — `embeddedWebServer.ts` serves `dist/index.html` and re-exposes IPC-equivalent capability as ~20 REST endpoints. This is a good architecture: no separate mobile codebase to maintain.
- The mobile-optimized chrome (`MobileTopBar.tsx`, `MobileBottomNav.tsx`, `MobileMenuDrawer.tsx`) is complete and wired — every button calls a real handler, no stubs. All 9 desktop sidebar views are reachable on mobile (5 via bottom nav, all 9 via the drawer).
- **Critical gap — no authentication on the LAN server.** `embeddedWebServer.ts` binds `0.0.0.0` (not `127.0.0.1`), sets `Access-Control-Allow-Origin: *`, and has **zero auth** of any kind — no password, token, or pairing code. Endpoints include full read of the photo library, `/api/photo?path=...` (arbitrary local file read, no path confinement to the library root), `/api/delete-files` (permanent delete), and `/api/switch-library` (repoints the whole app to any disk path). **Anyone on the same Wi-Fi/LAN can browse, exfiltrate, modify, or permanently delete the user's entire photo library with no credentials.** This is fine for a private home LAN the user fully trusts, but is not safe on shared/guest/office networks and should be called out to the user explicitly, or fixed, before this is relied on as a real feature.
- A second, mostly-duplicate implementation (`scripts/serve_mobile.js`) exists as a standalone dev/test harness, not used by the shipped app, but it's drifted from `embeddedWebServer.ts` (e.g. different backup behavior on rotate) and is a maintenance liability.
- **OneDrive/Google Drive as a direct network source** (explicitly requested by the user in `userinput.md`): not implemented as a first-class integration — it currently only works if the user already has the vendor's desktop sync client mapping the cloud drive to a local/UNC path, which `virtualMirrorService.ts` then treats like any other folder. There's no OneDrive/Google Drive API integration for browsing cloud-only (not-yet-downloaded) files.

### 3.2 Face detection & people identification

**Status: Done, real, no stubs.**

- On-device inference via `@vladmandic/face-api` (SSD MobileNet primary, TinyFaceDetector fallback) with WebGPU→WebGL backend selection, 128-d embeddings, age/gender/expression nets.
- Clustering (`clustering.ts`) uses a quality-weighted centroid (detector confidence × 2.5× manual-confirmation weight × face-size weight) on unit-hypersphere cosine distance — a legitimate, reasonably sophisticated approach, not a toy implementation.
- Face scanning is confirmed to always run against full-resolution images: `faceEngine.ts` hard-codes `preferOriginal=true` regardless of caller intent (the `preferOriginal` parameter is accepted but never actually read), and for HEIC files it round-trips through `prepareHeicHq` → full-quality JPEG in a `temp_hq/` folder → detection → `cleanupHeicHq` deletes the temp file — matching the user's explicit request exactly.
- The "double counting" complaint (2871 photos showing ~double) has a plausible, code-confirmed mechanism, though not a proven root cause: different scan entry points construct `Photo.id` and `originalRemotePath` differently (`scanner:scan-directory` in `main.ts` vs. `readFolderPhotos`/`scanVirtualMirrorDirectory` in `virtualMirrorService.ts`), and renderer-side dedup (`libraryStore.ts`'s `deduplicatePhotoList`) keys on `(originalRemotePath || filePath).toLowerCase()`. If the same physical file enters the library twice via two different scan paths whose canonical key strings don't match exactly — e.g. a local folder scan combined with a Virtual Storage mirror pointed at the same underlying source — both copies survive as distinct records with distinct ids, and face-queue dedup (keyed on `photo.id`) won't catch it either, so each gets queued and counted separately. Worth checking directly against the user's actual storage configuration.
- Name-loss protection exists: `main.ts`'s `storage:save` has an explicit guard against overwriting non-empty `people`/`faces` arrays with smaller/empty ones from a partial save — but the guard is a size-heuristic (`existingLib.photos.length > data.photos.length && data.photos.length <= 100`), not an explicit "this is a partial update" flag, so it's fragile if the catalog page size (100) ever changes.
- Two separate "scan photos" and "scan faces" actions still exist as the user flagged — they have not been merged into a single pass over network storage.

### 3.3 Fast preview of large libraries via cached thumbnails

**Status: Done — the most mature subsystem in the codebase.**

- Real, disk-backed, multi-tier thumbnail cache (150/200/250/300/500/1600px), sharp-powered with `nativeImage` and raw-passthrough fallbacks, keyed by `sha1(path:mtime:size)`, 4-way concurrency limiter, in-flight de-duplication.
- Baked WebP sprite sheets (50 thumbnails per sheet) let the gallery render a page of thumbnails as CSS background-position offsets into a handful of images instead of hundreds of individual requests — a genuinely fast-path optimization.
- Background pre-cache worker (`thumbnailWorkerService.ts`) with disk-persisted checkpointing (resumable across restarts) and a working CPU/RAM duty-cycle throttle (measures `process.cpuUsage()`/`memoryUsage()`, computes a proportional sleep to stay under configured caps).
- Catalog pagination (`catalog_meta.json` + `chunks/page_N.json`) + a hand-rolled two-level (month-group + row) virtualized gallery (`VirtualizedTimelineGallery.tsx`) mean the renderer never has to hold/render the full library at once.
- **Gap:** cache eviction is manual-only (no automatic LRU/size cap) — a very large, long-used library will grow the thumbnail cache and sprite directories unbounded until the user manually clears them.
- **Gap:** rotated photos permanently fall off the sprite-sheet fast path once rotated (`PhotoCard.tsx` forces per-request fetching for any photo with a saved rotation) — a real but narrow performance regression for that subset of photos.

### 3.4 AI chatbot — search by people and location

**Status: Partial — real LLM wiring exists but is off by default; the shipped default is keyword/regex matching, not a conversational agent.**

- `aiSearchService.ts` supports three modes: `local` (default), `gemini`, `openai`. Out of the box (`provider: 'local'`, empty API keys), **100% of search behavior is regex/keyword matching** against already-extracted metadata (person names via literal word-boundary match against the People list, location via a `near/in/at` regex, year via a 4-digit regex, "alone"/"childhood" pattern heuristics) — not an LLM, no external call.
- Real Gemini and OpenAI integrations do exist (`fetch()` calls to `generativelanguage.googleapis.com` and `api.openai.com`, prompting for structured JSON filters) and are fully coded, but only activate if the user pastes their own paid API key into Settings — there is no default/bundled AI credential, and **no Anthropic/Claude integration** exists at all (only Gemini and OpenAI are supported).
- Even with a cloud key configured, it's a single-turn NL→filter translator (one query → one JSON filter → apply to the in-memory photo array), not a conversational agent with memory or follow-up capability.
- **Gap vs. goal:** "AI-based chatbot" as stated implies something closer to a real assistant; today it is honestly closer to "smart search with an optional LLM-powered parser." If the intent is to ship a working AI search experience without requiring every user to obtain their own API key, this needs either a bundled/managed key (with associated cost/privacy tradeoffs) or a clearer positioning as "optional AI, offline keyword search by default."

### 3.5 Fastest browsing experience

**Status: Architecturally strong, with two live scalability concerns.**

- Catalog pagination + hand-rolled virtualization + sprite sheets (see §3.3) give a genuinely fast steady-state browsing experience, and the design intent (documented in `startup_activity_audit.md`) is sound.
- **Gap — write-path scalability:** `library.json` is still the single source of truth and is fully read-parsed-and-rewritten on **every** save (`storage:save` in `main.ts`), including single-field changes (e.g. toggling one favorite). At the repo's own stated 500K-photo scale (~250–320MB library.json, per `startup_activity_audit.md`), every save round-trips hundreds of MB of JSON. The catalog-chunk rebuild triggered after each save is also a full re-sort/rewrite of all chunks (same O(N) cost, just spread across files), not incremental — so the "fast reads" architecture doesn't extend to fast writes.
- **Gap — catalog/library.json can silently diverge:** the catalog rebuild after a save is fire-and-forget (not awaited, failure only logged), and different IPC handlers read from different sources (`storage:load` reads `library.json`; `catalog:get-page` reads chunk files) — if a rebuild ever fails, the desktop UI (catalog-driven) and any code path still touching `library.json` directly can disagree about photo counts/contents with no reconciliation.
- **Startup time:** the 40-second startup time flagged by the user is not fully explained by anything found in code — model loading is already deferred (15s idle before face-api even loads), and no forced full rescan happens on the steady-state path. The most likely real-world causes are large `library.json` I/O, antivirus scanning of the unpacked/unsigned Electron tree, or the renderer's "fallback" full-rescan path firing when the catalog is missing/stale — none of which is proven from static review alone; needs a profiling pass against the user's actual library size.

### 3.6 Basic photo editing

**Status: Partial — rotate and flip work; crop is implemented server-side but has no UI, so it's effectively dead.**

- **Rotate:** two independent, real implementations — a dedicated sharp-backed `photo:rotate` IPC (used by quick-rotate buttons on cards and in the lightbox) and a canvas-pre-baked rotate inside the "Edit" mode (`photo:edit`). Includes an offline queue for network-mirror sources (rotate now, apply when the source becomes reachable) and HEIC-aware handling.
- **Flip (horizontal):** implemented via HTML5 Canvas in the lightbox's Edit mode, saved through `photo:edit`.
- **Crop:** the `EditPhotoOptions.cropBox` field and a `nativeImage.crop()` fallback exist server-side, but **no UI ever populates `cropBox`** — the renderer's only caller of `editPhoto` always sends pre-rendered `base64Data` instead. The crop-shaped icon visible in the lightbox is actually the face-tagging tool, not a cropping tool. This is essentially unimplemented from a user's perspective.
- Save-as-copy vs. overwrite-with-`.bak`-backup is fully implemented and works well.
- **Verified bug (uncommitted branch, confirmed by actually running the test):** `npx tsx test/test_selected_dedup_and_heic_rotate.ts` → **26/28 pass, 2 fail** — "Test 14: Rotated image file width is 200 (got 400)" / "Test 15: ...height is 400 (got 200)". HEIC-named files that are actually JPEG bytes (as produced by the virtual-mirror thumbnail pipeline) get their sidecar metadata rotated correctly (width/height/rotation fields all update correctly on disk), but the physical mirror thumbnail file itself is not — `rotateCachedHeicThumbnail()` only rotates *derived* cache copies, not the original mirror file the gallery may read directly. This directly contradicts the user's explicit ask ("rotate only thumbnail what we have in our folder") and needs a fix before that branch merges. (The rest of the rotation/dedup work on this branch is solid: the selection-based dedup cluster picker, the raw-HEIC rotation + persistent rotation store, and the hover-rotate 2s-debounce UI all pass their tests / check out on code review.)

### 3.7 Location scanning + user override

**Status: Done for extraction; override exists but is narrower than "click the map."**

- GPS EXIF extraction (`exifParser.ts`, via `exifr`) is reliable, with graceful fallback to filesystem timestamps when EXIF is missing.
- Reverse geocoding (coordinates → city/country label) is **not** a live API call — it's an offline nearest-neighbor lookup against a hardcoded list of ~35 known places (mostly India + a few global cities), with crude bounding-box fallbacks for larger regions and a final "Earth" catch-all. Anything outside those ~35 points gets a vague or empty label.
- **Override/assignment** ("Custom Geotagging," `PlacesMapView.tsx`) is real and does persist actual new coordinates — but only for photos that currently have **no** location, and only via a text search against the live OpenStreetMap Nominatim API (pick a landmark/city by name), not by dragging a pin or clicking a point on the map. There is no `dragend`/`draggable` marker handler anywhere in the codebase.
- Renaming a location's display label on an **already-geotagged** photo (from the lightbox or a map cluster) only changes the text label, not the underlying coordinates — so a user cannot currently correct a wrong GPS fix via a simple UI action; they'd have to be routed through the "unlocated photos only" assignment flow, which doesn't apply once a (possibly wrong) location already exists.
- **Gap vs. stated goal** ("override it if user wants to"): true override of an *existing, incorrect* location is not supported today — only initial assignment to previously-unlocated photos.

---

## 4. In-flight work (uncommitted, on `main` as of this review)

23 modified files + 2 new untracked files (+1093/−372 lines), not yet committed. The coherent theme is **HEIC rotation persistence + progress-count accuracy + a save-race-condition fix**:

- `main.ts`: `storage:save` now serializes all writes through a promise queue (`savePromiseQueue`) to prevent concurrent-write corruption of `library.json` — a genuine correctness fix. Also restores saved HEIC rotation onto freshly-scanned photos.
- `catalogService.ts`: paginated catalog reads now apply any persisted HEIC rotation from the new `heicRotationStore`.
- `thumbnailCacheService.ts`: new `rotateCachedHeicThumbnail()` function rotates all cached-size JPEGs for a HEIC source (see the bug noted in §3.6 — it doesn't reach the original mirror thumbnail file).
- `virtualMirrorService.ts`: HEIC rotation now actually executes (previously returned "not supported"); JPEG/WebP-disguised-as-`.heic` files are now sniffed and routed correctly for most, but not all, code paths.
- `thumbnailWorkerService.ts`: progress totals now cross-validated against the library's actual photo count (fixes inflated progress percentages).
- Renderer: `VirtualStorageView.tsx` (+162) adds per-storage loading states and progress maps (thumbnail + face counts shown separately per configured storage, addressing the "Jainish shows faces but not thumbnails, Photo1 shows nothing" complaint); `PeopleView.tsx` (+114) adds a proper "Loading recognized people..." state instead of a blank/zero-count flash; `PhotoCard.tsx` (+75) adds the hover rotate button with 2s debounce; `deduplication.ts` (+52) adds `createClusterFromSelectedPhotos()` for the "treat selected images as one cluster" request.
- New untracked: `src/main/services/heicRotationStore.ts` (242 lines) and `test/test_selected_dedup_and_heic_rotate.ts` (220 lines, 26/28 passing).
- **Not yet wired into the test gate:** the new test file isn't referenced by `package.json`'s `test` script, so its 2 known failures (the HEIC-rotation bug above) would not block `npm run build`.

---

## 5. Confirmed issues to fix

| # | Issue | Where | Severity |
|---|---|---|---|
| 1 | Unauthenticated LAN web server exposes full read/write/delete of the entire library and arbitrary local file paths to any device on the same network | `src/main/services/embeddedWebServer.ts`, `scripts/serve_mobile.js` | **High** |
| 2 | IPC handlers for file read/delete/scan accept unvalidated paths (no confinement to library/mirror roots); `gphoto://` protocol reads any path from a query string with `bypassCSP: true` | `src/main/main.ts` (many handlers) | High (mitigated today by no remote content in the renderer, but a real XSS or supply-chain issue would make it exploitable) |
| 3 | HEIC-named-but-JPEG mirror thumbnail files don't get physically rotated — only derived caches and sidecar metadata do | `virtualMirrorService.ts` (`rotatePhotoWithOfflineQueue`), `thumbnailCacheService.ts` (`rotateCachedHeicThumbnail`) — verified failing test | Medium (data/display inconsistency, actively being worked on) |
| 4 | `bandwidthLimitMbps` setting is captured in the UI and persisted but never enforced anywhere (dead config) | `types/index.ts:151`, `VirtualStorageView.tsx`, missing from `virtualMirrorService.ts`/`backgroundDaemon.ts` | Medium — directly requested by the user and not delivered |
| 5 | `delayBetweenPhotosSec` only throttles the manual "Sync Now" path, not the unattended periodic background daemon sync — which is the actual "don't hog my bandwidth while I work" use case | `backgroundDaemon.ts` (`runBackgroundSyncCycle`) vs. `virtualMirrorService.ts` (`syncVirtualStorage`) | Medium |
| 6 | `library.json` full rewrite on every save; catalog rebuild is a full re-sort/rewrite, not incremental; rebuild is fire-and-forget and can silently diverge from `library.json` | `main.ts` (`storage:save`), `catalogService.ts` (`buildAndSaveCatalog`) | Medium–High at large scale (500K-photo target) |
| 7 | No crop UI despite server-side support existing — dead feature surface | Renderer (no caller populates `cropBox`) | Low–Medium |
| 8 | Existing (possibly wrong) photo locations cannot be corrected/overridden — only unlocated photos can be assigned a location | `PlacesMapView.tsx` | Medium — directly requested by the user |
| 9 | Duplicated `userData` path-guessing logic across 3 files (`heicService.ts`, `heicRotationStore.ts`, `embeddedWebServer.ts`), a residue of an app rename (`gPhotos` vs `gphotos-desktop`) — latent source of "my data disappeared" bugs | Multiple | Low (works today, fragile) |
| 10 | Two "scan photos" / "scan faces" buttons instead of one unified pass | Renderer scan triggers | Low — usability, explicitly requested |

---

## 6. Test coverage assessment

- 38 files in `test/`, but `package.json`'s `test` script only wires up 4 (`test:imports`, `test:render`, `test:smoke`, `test:workflow`). The other ~34 — including every HEIC, throttling, checkpoint/resume, 500K-scale, and mobile-server test — are unwired ad hoc scripts, not part of any build/CI gate.
- No test framework (no Jest/Vitest/Mocha) — all tests are hand-rolled `assert()` + console-log scripts run manually via `tsx`/`node`.
- No CI configuration exists in the repo at all (`.github/workflows/` absent) — nothing runs any of this automatically on push.
- Some tests are not portable/reproducible (hardcoded LAN IPs, reliance on a specific developer's real `%APPDATA%\gPhotos\library.json`).
- Net effect: real regressions (like the HEIC-rotation bug found during this review) can and do slip past `npm test`/`npm run build` today.

---

## 7. Recommended near-term priorities

Roughly in order of impact vs. effort, based on the gaps above:

1. **Lock down or clearly gate the LAN web server** (issue #1/#2) — at minimum a shared PIN/passphrase or pairing flow before this is presented as a real "use it from your phone" feature; document the current risk for the user in the meantime.
2. **Finish and merge the in-flight HEIC rotation branch**, fixing the mirror-thumbnail-not-rotated bug (#3), and wire the new test into `npm test` so it can't regress silently.
3. **Wire `bandwidthLimitMbps` and extend `delayBetweenPhotosSec` into the background daemon's own sync loop** (#4/#5) — both explicitly requested and both have a working reference implementation to copy (the CPU/RAM proportional-sleep pattern already in `thumbnailWorkerService.ts`).
4. **Add a real "correct this location" action** for already-geotagged photos (#8) — reuse the existing Nominatim search UI, just relax the "must be unlocated" precondition.
5. **Decide the AI chatbot's default posture**: either ship a bundled/managed AI key so the chatbot goal is met out of the box, or explicitly reposition it as "offline smart search, optional AI upgrade" in the UI/docs so expectations match reality.
6. **Address `library.json` write-path scalability** before pushing further at the 500K-photo target — likely needs either incremental catalog updates or a real embedded database (SQLite) for the write path, while keeping the read-optimized catalog for browsing.
7. **Stand up a minimal CI gate** running at least the currently-orphaned integration tests (HEIC pipeline, checkpoint/resume, mobile server) on every push, so fixes like #3 above don't need to be manually rediscovered.
8. Lower priority: unify the two scan buttons into one pass, add real crop UI or remove the dead `cropBox` plumbing, consolidate the duplicated `userData` path-guessing logic into one helper.

---

## 8. What's genuinely solid today

Worth calling out explicitly, since a gap document skews negative: the thumbnail caching/sprite pipeline, the paginated-catalog + virtualized-gallery browsing architecture, the on-device face recognition/clustering, the offline-safe rotation queue for network sources, the atomic/serialized `library.json` writer, and the people-name-preservation guard are all real, working, and reasonably sophisticated — not stubs or scaffolding. The core "fast browsing of a large local library with face recognition" experience the product is built around is largely delivered; the gaps above are concentrated in the newer/aspirational goals (AI chatbot, mobile-web security, location override, crop) and in scaling the write path for very large libraries.
