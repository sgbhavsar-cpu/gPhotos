# Video Generation Tool: Feature Roadmap (100 ideas)

Inspired by mobile/desktop editors such as VN Video Editor, adapted to what gPhotos is: a photo library that
already knows its albums, chapters, people, places and dates. Effort tags: **[S]** small (days), **[M]** medium
(1-2 weeks), **[L]** large (multi-week). Items marked ★ are the recommended first wave.

## Where we are today

The "Create Video" wizard (`VideoWizardModal.tsx`, `videoExportService.ts`) has six steps: Group Photos, Arrange
Slides, Video Settings, Music, Title & Credits, Review & Generate. It renders **photos only**: slide kinds are
`photo`, `collage` (grid / side-by-side / stacked / featured), `title` and `card`. One ffmpeg `xfade` chain joins them
with 8 transitions, a fixed seconds-per-slide, one music track (trim, loop, fade-out, volume), 4 aspect ratios,
720p/1080p, 3 quality levels. Videos that live in an album are **not** used in the output.

## Wishlist: videos inside the album become part of the output (items 1-14)

Design notes for the core of this request:
- Add a slide kind `clip` to `VideoSlideInput`: `{ kind: 'clip', clipPath, trimStartSec, trimEndSec, muted, volume }`.
- Pipeline: normalise every clip to the target size/fps/pixel format (scale + pad, same as photos), then join with
  the same `xfade` chain; `acrossfade` for clip audio. Probe duration/audio with the existing `probeMedia`.
- Clips and photos share one timeline, ordered by the album/chapter order (or date) by default.
- Remote/OneDrive videos must be copied or streamed to a local temp file before encoding; show that in "preparing".

1. ★[M] Include the album's videos as clips in the generated video (new `clip` slide kind).
2. ★[S] Step 1 shows videos with a badge and duration, selectable and groupable like photos.
3. ★[M] Trim each clip (in/out points) with a scrubber and live preview.
4. ★[S] Per-clip "keep original sound" toggle and volume.
5. ★[M] Automatic audio ducking: music lowers while a clip with sound plays, then returns.
6. [S] Per-clip speed: 0.25x, 0.5x, 1x, 2x, 4x (with pitch-corrected audio).
7. [M] Use only the "best part" of a long clip: auto-pick a highlight segment of N seconds.
8. [M] Split one long clip into several slides at chosen points.
9. [S] Mixed orientation handling: portrait clip in a landscape video gets blurred-background fill or fit/fill/crop choice.
10. [S] Frame rate and rotation normalisation (phone clips with rotation metadata, 30/60 fps mixes).
11. [M] Freeze frame: hold any frame of a clip for N seconds.
12. [M] Reverse a clip.
13. [S] Clip thumbnails (filmstrip) in the arrange step so long clips are easy to trim.
14. [S] Total-length readout that updates live as clips are trimmed or photos get durations.

## Timeline and editing (15-28)

15. ★[L] Real timeline view (replacing the list): slides as blocks with drag-to-reorder and drag-to-resize duration.
16. ★[S] Per-slide duration (today it is one global seconds-per-item).
17. ★[M] Live preview player inside the wizard (low-res proxy render of the current arrangement).
18. [M] Undo / redo across the whole wizard.
19. [S] Duplicate a slide.
20. [S] Split and delete on the timeline.
21. [M] Multi-select slides for batch duration/transition/effect edits.
22. [M] Ripple edit: deleting a slide closes the gap automatically.
23. [L] Second video track (overlay track) for picture-in-picture and stickers.
24. [M] Snap to beat markers and slide edges while dragging.
25. [S] Zoom the timeline in and out.
26. [S] Auto-save the wizard draft so closing the dialog never loses work.
27. [M] Save and reopen a video "project" per album (re-edit later without starting over).
28. [S] Keyboard shortcuts: space to play, arrows to step, S to split, Delete to remove.

## Transitions and motion (29-38)

29. ★[S] Expand transitions from 8 to 30+ (all the useful ffmpeg `xfade` names: zoom, pixelize, radial, circle close, etc.).
30. [S] Per-cut transition picker (the engine already accepts a per-cut list; expose it in the timeline).
31. [S] Per-cut transition duration.
32. [M] Whip-pan / slide + motion-blur transition.
33. [M] Glitch and light-leak transitions (overlay-based).
34. [M] Match-cut / zoom-through transition between similar photos.
35. [S] "Apply this transition to all" and "randomise all" buttons.
36. [M] Transition preview thumbnails (animated) in the picker.
37. [S] Fade from/to black or white at the very start and end.
38. [M] Cross-zoom between a wide photo and a detail crop of the same photo.

## Photo animation (39-46)

39. ★[M] Ken Burns (slow pan and zoom) on photos, with start/end rectangle editing.
40. ★[M] Face-aware Ken Burns: use detected faces so the camera drifts toward people, never cuts heads off.
41. [S] Zoom in / zoom out / pan left / pan right presets.
42. [M] Per-photo keyframes: position, scale, rotation, opacity over time.
43. [M] Parallax "3D photo" effect from an estimated depth map.
44. [M] Photo "pop-in" animation: slide, bounce, spin entrances and exits.
45. [S] Burst photos played as a fast stop-motion sequence.
46. [S] Live photo / motion photo support: use the embedded clip if the photo has one.

## Titles, text and captions (47-58)

47. ★[M] Text overlays on any slide with font, size, colour, shadow, outline, background box.
48. ★[S] Auto caption from the slide's metadata: place name, date, person names, album chapter title.
49. [M] Animated text presets: typewriter, fade-up, bounce, kinetic.
50. [S] Chapter title cards generated automatically from album chapters.
51. [S] Lower-third name tags using people tagged in the photo or video.
52. [M] Auto speech-to-text subtitles for clips with talking (local Whisper model, offline).
53. [S] Subtitle style presets (karaoke highlight, boxed, outlined) and an editable subtitle list.
54. [S] Font library: bundled fonts plus the system fonts, with Gujarati/Hindi script support.
55. [M] Stickers, emoji and shapes (arrows, hearts, frames) as overlays.
56. [S] Date stamp / "this day, N years ago" label.
57. [M] Moving map card: animated route or pin drop between places in the album (uses photo locations).
58. [S] End-credits roll built from people and places in the album.

## Audio (59-70)

59. ★[M] Multiple audio tracks: music, voice-over, ambient, each with its own volume.
60. ★[M] Voice-over recording in the wizard, aligned to the timeline.
61. ★[M] Beat detection and "cut on the beat": auto-set slide durations from the music tempo.
62. [S] Fade-in as well as fade-out, and crossfade between two songs.
63. [M] Waveform display on the timeline.
64. [S] Volume envelope (keyframed) for music.
65. [S] Sound effects library (whoosh, click, camera shutter) tied to transitions.
66. [M] Noise reduction for clip audio (ffmpeg `afftdn`).
67. [S] Audio normalisation (loudness target, e.g. -14 LUFS for social media).
68. [S] Mute whole video / extract audio only export (mp3).
69. [M] Royalty-free music built in, with mood and length filters.
70. [S] Remember recent songs and show them first; reuse the YouTube download cache.

## Filters, colour and look (71-80)

71. ★[S] One-tap filters (warm, cool, vintage, B&W, vivid, cinematic) applied to a slide or the whole video.
72. [M] LUT (.cube) import and application.
73. [S] Manual adjustments: brightness, contrast, saturation, temperature, tint, sharpness, vignette.
74. [S] Copy the look of one slide to others ("paste adjustments").
75. [M] Auto-enhance (exposure and colour balance) per photo and per clip.
76. [M] Video stabilisation for shaky phone clips (ffmpeg `vidstab`).
77. [S] Film grain, light leaks and dust overlays.
78. [S] Blur, mosaic and pixelate regions (hide a face or number plate).
79. [M] Background blur or replace for clips of people (segmentation model).
80. [S] Auto colour-match: make all slides of a chapter look consistent.

## Layout, overlays and collage (81-88)

81. ★[M] More collage layouts (up to 9 cells, custom grid, rounded corners, gaps, border colour).
82. [M] Animated collage: cells fly in one by one.
83. [L] Picture-in-picture: a clip or photo in a corner over another (needs the overlay track).
84. [M] Split screen with two clips playing side by side.
85. [S] Background style behind fitted photos: blur, solid colour, gradient.
86. [S] Frames and borders (polaroid, film strip, rounded) for photos.
87. [M] Mask shapes (circle, heart, star) for photos and clips.
88. [S] Safe-area guides for each social platform (Reels, Shorts, TikTok, WhatsApp status).

## Smart and AI features (89-96)

89. ★[M] "Auto video" in one click: choose an album, get a finished highlight video (best shots, mix of clips and photos, music).
90. [M] Pick the best photos automatically (sharp, eyes open, smiling, no duplicates) using existing quality and face data.
91. [S] Skip near-duplicates and bursts automatically, keep the best of each group.
92. [M] Person-focused video: "all moments of <person>" across albums, chronologically.
93. [M] Place-focused video: a trip video in route order using photo GPS.
94. [S] "Then and now" / year-in-review automatic recap per year.
95. [M] AI-written title and short story using the album's captions and tags.
96. [M] Smart pacing: hold on photos with faces longer, move quickly through scenery.

## Templates, export and workflow (97-100)

97. ★[M] Templates: a saved bundle of transition, filter, text style, music mood and aspect ratio (e.g. "Birthday", "Trip", "Wedding", "Reel").
98. ★[S] Export presets for WhatsApp, Instagram Reel, YouTube, 4K archive, with file-size estimate.
99. [M] 4K / 60 fps export and hardware encoding (NVENC / QuickSync / AMF) for speed.
100. [S] Background export queue: keep working, notify when done, then offer "Open", "Share" and "Add the video to the album".

## Suggested phasing

- **Wave 1 (the wishlist plus the biggest wins):** 1-5, 15-17, 29, 39-40, 47-48, 59-61, 71, 81, 89, 97-98.
- **Wave 2 (editing depth):** 6-14, 18-28, 30-38, 41-46, 49-58, 62-70.
- **Wave 3 (advanced):** 72-80, 82-88, 90-96, 99-100, plus the second track (23) and picture-in-picture (83).

## Technical risks to settle before building

- **Remote and offline sources:** album videos on OneDrive or a network mirror must be fetched or cached before encoding; decide the temp-space limit and what happens when a clip is offline (skip with a warning, as photos do today).
- **Encode time:** mixing clips makes renders much slower than photo slideshows; the preview needs a low-resolution proxy and the export needs progress and cancel (already present).
- **ffmpeg filter graph size:** a long timeline in one `xfade` chain gets heavy; render in segments and concatenate beyond roughly 60 slides.
- **Audio sync:** `xfade` has no audio twin, so clip audio needs a matching `acrossfade` chain or a separate mixed track.
