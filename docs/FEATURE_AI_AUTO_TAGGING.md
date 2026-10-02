# Feature: Background AI Auto-Tagging (Local Ollama)

Status: implemented. Companion to [FEATURE_VIDEO_LIBRARY_SUPPORT.md](FEATURE_VIDEO_LIBRARY_SUPPORT.md) (same request, two independent features). See [CODE_REVIEW_2026-09-26.md](CODE_REVIEW_2026-09-26.md) for ongoing fix log conventions this follows.

## 1. Problem

"Search with AI" can match a photo by a Smart Flow **tag** (`&tag` autocomplete) or by free-text matched against a cached **caption** — but both only exist for a photo once some Smart Flow has actually been run against it. A fresh library (or one where the user never ran Smart Flows) has no captions/tags at all, so `&`-tag search, and any future caption-text search, comes up empty. Requested: a background task — in spirit like thumbnail pre-caching — that keeps every photo described and tagged automatically using the local Ollama model, with no manual Smart Flow run required.

## 2. Design

### 2.1 Reuse, not a parallel system

Everything this needs already exists:

| Need | Existing piece |
|---|---|
| Durable per-photo caption + tags store, survives restart | `photoContentCache.ts` → SQLite `photo_content` table (`libraryRepository.ts`) |
| Local vision call, batched, sized to the model's context window | `ollamaVisionService.classifyImagesBatchLocal` + `computeLocalBatchSize` |
| Prompt asking for a caption + tags regardless of a match verdict | `visionClassify.buildBatchClassifyPrompt` / `parseBatchClassifyResponse` |
| "Which photos still need this" | **the cache itself** — a photo with no `photo_content` row (or an empty caption) hasn't been described yet |

So this feature is a new orchestration loop, `aiAutoIndexService.ts`, that is effectively Smart Flows' own Pass 2 (local Ollama only — **no cloud escalation**, see §2.3) run automatically, against a generic "describe this photo" prompt, over every photo lacking a cache entry. No new checkpoint file is needed: `photoContentCache` having an entry *is* the checkpoint, so a restart resumes for free and a manual Smart Flow run on the same photo later is also a free cache hit.

### 2.2 Generic description

The shared prompt (`buildBatchClassifyPrompt`) always asks for a match verdict against *some* description. Auto-tagging doesn't have a real one, so it uses a fixed, neutral string: `"the general content of this photo"`. The `match`/`confidence` fields are produced but ignored by this feature — only `caption`/`tags` are used — and the verdict is still recorded under that one normalized key in `photo_content.verdicts_json`, which is harmless (an unrelated Smart Flow query never happens to normalize to that exact sentence).

### 2.3 Why local-only, no cloud fallback

Smart Flows escalates an unsure local answer to the cloud because a *user-run, capped, consented* action justifies spending a cloud call to get a reliable verdict. This feature runs unattended, continuously, over the *entire* library — silently uploading the whole library to a cloud provider the moment Ollama hiccups would be a serious, surprising privacy regression. So: local Ollama only. If Ollama/the vision model isn't reachable, the loop simply doesn't run (checked once per attempt via `isVisionAvailable()`), and resumes next time it's reachable — no error surfaced beyond a quiet status line.

### 2.4 Lifecycle

- **Off by default.** Settings → Search with AI → new "Auto-describe & tag photos (background)" toggle, persisted alongside the existing Ollama config (`localStorage`, key `gphotos_ai_auto_index_v1`).
- When enabled **and** a library is open, a loop starts: filter `allPhotos` to non-video photos with no (or empty-caption) `photo_content` entry, batch them (`computeLocalBatchSize`, same sizing math as Smart Flows), call `classifyImagesBatchLocal`, record results, yield (`setTimeout` ~300 ms) between batches so it never starves the UI thread's event loop, repeat until none remain or disabled.
- Re-triggered whenever new photos are added to the open library (same place Smart Flow candidates would grow) and whenever a library is opened/switched.
- A single shared in-process flag defers the auto-index loop whenever a **manual** Smart Flow run is in flight (`setManualFlowRunning`/`isManualFlowRunning` in a tiny shared module) — both features hit the same local Ollama server, and letting them collide doubles the load exactly when the user is actively waiting on a manual run.
- Settings panel shows a live `done / total` status line and a Pause/Resume control; closing Settings does not stop the loop (same convention as thumbnail pre-caching).

### 2.5 One photo per local vision call — never batched

`computeLocalBatchSize` (`ollamaVisionService.ts`) is pinned to `1`, so "batch them" above is, in
practice, one photo per call. This wasn't the original design (local batch size used to scale with
the configured context window, up to 20) — it was changed after a real, confirmed report: a small
(7B-class) local model, given more than one image in a single request, can return a well-formed,
correctly-sized, *plausibly self-indexed* response that nevertheless conflates which photo is which —
the model's own reported `"image"` index (see `docs/CODE_REVIEW_2026-09-26.md` §45) can itself be a
confident, consistent lie, which no amount of response-shape validation can catch after the fact. One
photo per call makes that entire class of bug structurally impossible, at the cost of throughput —
correctness wins for data recorded with zero human review. See §48 of the code review doc for the
full writeup. `smartFlowsService.ts`'s local pass is pinned the same way, for the identical reason.

### 2.6 Non-goals / explicitly out of scope

- No new UI search feature (`&tag` matching already reads from the same cache — it benefits automatically, zero `aiSearchService.ts` changes needed).
- No per-photo progress persisted outside the cache (no separate checkpoint JSON — see §2.1).
- No video files (skipped; see the video feature doc — a vision-classify batch call expects still images).
- No CPU/RAM duty-cycling like `thumbnailWorkerService` — vision calls are already seconds-long and self-throttling; a flat inter-batch delay is enough.

## 3. User Stories

1. **As a user with Ollama already set up for Smart Flows**, I turn on "Auto-describe & tag photos" once in Settings, and over time (while the app is open) every photo in my library gets a caption and tags without me running any Smart Flow — so `&tag` search and future caption search work library-wide.
2. **As a user without Ollama installed**, the toggle is visible but turning it on just shows "No local vision model available — will start automatically once Ollama is reachable" — nothing breaks, nothing silently calls a cloud API.
3. **As a user who also runs a manual Smart Flow**, my manual run isn't slowed down by the background loop fighting it for the same local model — the background loop backs off while the manual run is active and resumes after.
4. **As a user who restarts the app mid-way**, indexing resumes from wherever it left off (no re-describing already-done photos), because "done" is just "has a cache entry", not a separate progress file that could drift from reality.
5. **As a user who disables the toggle**, the loop stops promptly (checked once per batch) and nothing further is sent to Ollama.
6. **As a user with videos in the library** (see companion feature), none of them are ever sent to the vision model by this feature.

## 4. Test Cases

Unit tests in `test/vitest/aiAutoIndexService.spec.ts` (vitest, isolated APPDATA per the project's standing test rule):

| # | Scenario | Expected |
|---|---|---|
| T1 | Library of 5 photos, none cached, Ollama available | All 5 get a `photo_content` entry with non-empty caption after the loop settles |
| T2 | 3 of 5 photos already have a cache entry | Only the other 2 are sent to `classifyImagesBatchLocal` |
| T3 | Ollama unavailable (`isVisionAvailable` → false) | Loop makes zero vision calls; status reflects "waiting for Ollama" |
| T4 | Toggle disabled mid-run | No further batches are started after the next check point |
| T5 | A manual Smart Flow sets `isManualFlowRunning() === true` | Auto-index defers (no batch starts) until it's released |
| T6 | A photo has `isVideo: true` | Never included in a candidate batch |
| T7 | `classifyImagesBatchLocal` throws for one batch | That batch's photos stay uncached (retried on the next pass); loop continues to the next batch, not halted |
| T8 | A photo already has a non-empty caption from a prior Smart Flow run | Not re-sent (treated as already-indexed, even though its tags came from a flow-specific description) |
| T9 | Context-window-based batch size | Uses the same `computeLocalBatchSize(effectiveContext)` as Smart Flows — asserted via a spy, not re-derived |

Manual/Playwright coverage: see `test/e2e/aiAutoIndex.spec.ts` in the companion Playwright suite description in [FEATURE_VIDEO_LIBRARY_SUPPORT.md](FEATURE_VIDEO_LIBRARY_SUPPORT.md) §6 (shared harness) — verifies the Settings toggle renders, persists across a reload, and the status line updates.

## 5. Files touched

- New: `src/renderer/src/services/aiAutoIndexService.ts`, `src/renderer/src/services/visionJobLock.ts` (the tiny shared "manual flow running" flag).
- Modified: `src/renderer/src/views/SettingsView.tsx` (toggle + status UI), `src/renderer/src/services/smartFlowsService.ts` (sets the shared lock around `runFlow`), `src/renderer/src/App.tsx` (kicks off a pass alongside the existing idle-driven thumbnail/face-queue background tasks).
- New test: `test/vitest/aiAutoIndexService.spec.ts` (T1-T7, T9 from §4 above — all passing). T8 isn't a separate test: it's exercised by the same code path as T2 (both are "already has a cached caption, skip it").
- Settings-toggle E2E: see `test/test_video_and_autotag_settings_e2e.ts`, documented in the companion video feature doc §6 (shared harness, launches the real isolated app).
