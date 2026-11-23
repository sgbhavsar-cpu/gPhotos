import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useEscapeLayer } from '../services/escapeStack';
import {
  X, Film, Check, Layers, PlayCircle, ChevronLeft, ChevronRight,
  FolderOpen, XCircle, RotateCcw, GripVertical, ChevronUp, ChevronDown, Ungroup, ExternalLink,
} from 'lucide-react';
import type { Album, Photo, VideoAspectRatio, VideoResolutionTier, VideoQuality, VideoTransition, VideoSlideInput, VideoCollageStyle } from '../../../types';
import { MAX_VIDEO_COLLAGE_PHOTOS } from '../../../types/collageLayout';
import { computeDimensions, VIDEO_TRANSITIONS, VIDEO_FILTERS, VIDEO_MOTIONS, CAPTION_POSITIONS, CAPTION_SIZES, CAPTION_COLORS, DEFAULT_CAPTION_STYLE, type VideoCaptionStyle, type VideoFilterName, type VideoMotionName } from '../../../types/videoFormat';
import { buildAutoCaption, faceFocus, NO_CAPTIONS, type CaptionOptions } from '../services/videoCaption';
import { VIDEO_TEMPLATES, EXPORT_PRESETS, estimateSizeMB, formatSizeMB, autoPickIds, type VideoTemplate, type ExportPreset } from '../services/videoPresets';
import { defaultTitleDesign, defaultCreditsDesign, makeText, type SlideDesign } from '../../../types/slideDesign';
import { libraryStore, getLocalPhotoUrl } from '../services/libraryStore';
import { CollageStylePicker } from './CollageStylePicker';
import { SlideTimeline, type TimelineItem } from './SlideTimeline';
import { TrimRange } from './TrimRange';
import { VoiceAndBeatPanel, type VoiceTrack } from './VoiceAndBeatPanel';
import { MusicStep, type MusicSelection } from './MusicStep';
import { SlideDesigner, designPhotoUrl } from './SlideDesigner';
import { renderDesignToDataUrl } from '../services/slideDesignRender';
import { notifyError } from '../services/notifications';

interface VideoWizardModalProps {
  isOpen: boolean;
  onClose: () => void;
  album: Album;
  photos: Photo[]; // the whole library's photos, to resolve ids
}

interface SlideEntry {
  id: string;
  kind: 'photo' | 'collage' | 'clip';
  photoIds: string[];
  included: boolean;
  /** 'clip' (an album video used as part of the output): the part to keep, in seconds of the source (end null = to the end), and its own sound. */
  trimStartSec?: number;
  trimEndSec?: number | null;
  /** Clip playback speed (default 1). */
  speed?: number;
  reverse?: boolean;
  holdSec?: number;
  keepSound?: boolean;
  /** Photo or collage: how long this slide stays up (seconds); unset = the video's seconds-per-photo setting. */
  seconds?: number;
  /** Per-slide overrides of the video-wide motion / look; a caption typed here replaces the automatic one. */
  motion?: VideoMotionName;
  filter?: VideoFilterName;
  caption?: string;
  /** The chapter this slide's (first) photo lives in, so step 1 can show photos grouped under their chapter headings. null = not in any chapter. */
  chapterTitle: string | null;
  collageStyle?: VideoCollageStyle;
}

type TransitionMode = 'single' | 'random' | 'multiple';


const TRANSITIONS: Array<{ value: VideoTransition; label: string }> = VIDEO_TRANSITIONS.map(([value, label]) => ({ value, label }));

const STEP_TITLES = ['Group Photos', 'Arrange Slides', 'Video Settings', 'Music', 'Title & Credits', 'Review & Generate'];
const LAST_STEP = STEP_TITLES.length;

const MUSIC_CREDIT_ID = 'music_credit';

/** Credits screen for an album; when the music needs a credit (CC BY), the line is already on it. */
const creditsDesignFor = (album: Album, credit?: string): SlideDesign => withMusicCredit(defaultCreditsDesign(album.title), credit);

function withMusicCredit(design: SlideDesign, credit?: string): SlideDesign {
  const rest = design.texts.filter((t) => t.id !== MUSIC_CREDIT_ID);
  if (!credit) return { ...design, texts: rest };
  return { ...design, texts: [...rest, makeText({ id: MUSIC_CREDIT_ID, text: credit, sizePct: 2.4, yPct: 80, bold: false, shadow: false, color: '#94a3b8' })] };
}

const titleDesignFor = (album: Album) => defaultTitleDesign(album.title, album.eventDate ? new Date(album.eventDate).getFullYear().toString() : undefined);
const MAX_COLLAGE = MAX_VIDEO_COLLAGE_PHOTOS; // up to 3 x 3 in one frame
// Random / multiple modes only pick real effects — a hard cut can't be mixed into one crossfade chain.
const REAL_TRANSITIONS = TRANSITIONS.filter((t) => t.value !== 'none').map((t) => t.value);

/** Slides in the album's own order: each chapter's photos in chapter order, then whatever is in no chapter. */
function buildInitialSlides(album: Album): SlideEntry[] {
  const titleOf = new Map<string, string>();
  for (const c of album.chapters || []) for (const id of c.photoIds) titleOf.set(id, c.title);
  const ordered = [...(album.chapters || []).flatMap((c) => c.photoIds), ...libraryStore.getUnchapteredPhotoIds(album)];
  const seen = new Set<string>();
  const ids = ordered.filter((id) => (seen.has(id) ? false : (seen.add(id), true)));
  const idSet = new Set(ids);
  const videos = new Map<string, Photo>();
  for (const p of libraryStore.getState().photos) if (p.isVideo && idSet.has(p.id)) videos.set(p.id, p);
  return ids.map((id): SlideEntry => {
    const v = videos.get(id);
    const base = { id: `s_${id}`, photoIds: [id], included: true, chapterTitle: titleOf.get(id) ?? null };
    // A video becomes a clip slide: by default its first CLIP_DEFAULT_MAX_SEC seconds, with its own sound.
    return v ? { ...base, kind: 'clip', trimStartSec: 0, trimEndSec: v.videoDurationSec ? Math.min(v.videoDurationSec, CLIP_DEFAULT_MAX_SEC) : null, keepSound: true } : { ...base, kind: 'photo' };
  });
}

const CLIP_DEFAULT_MAX_SEC = 15;
const fmtSec = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** Default save location: <library folder>/videos/<album name>.mp4 — null when there is no library folder to anchor it to. */
function defaultOutputPath(albumTitle: string): string | null {
  const root = libraryStore.getState().selectedFolder;
  if (!root) return null;
  const sep = root.includes('\\') ? '\\' : '/';
  const safe = albumTitle.replace(/[\\/:*?"<>|]/g, '_').trim() || 'video';
  return `${root.replace(/[\\/]+$/, '')}${sep}videos${sep}${safe}.mp4`;
}

export const VideoWizardModal: React.FC<VideoWizardModalProps> = ({ isOpen, onClose, album, photos }) => {
  const photoMap = useMemo(() => new Map(photos.map((p) => [p.id, p])), [photos]);
  const [step, setStep] = useState(1);

  const [slides, setSlides] = useState<SlideEntry[]>(() => buildInitialSlides(album));
  const [showStylePicker, setShowStylePicker] = useState(false);
  const [pickingForCollage, setPickingForCollage] = useState<Set<string>>(new Set()); // entry ids
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [timelineSelectedId, setTimelineSelectedId] = useState<string | null>(null);

  // Step 3
  const [aspectRatio, setAspectRatio] = useState<VideoAspectRatio>('16:9');
  const [resolution, setResolution] = useState<VideoResolutionTier>('1080p');
  const [quality, setQuality] = useState<VideoQuality>('good');
  const [transition, setTransition] = useState<VideoTransition>('fade');
  const [transitionMode, setTransitionMode] = useState<TransitionMode>('single');
  const [multiPool, setMultiPool] = useState<Set<VideoTransition>>(() => new Set<VideoTransition>(['fade', 'dissolve', 'wipeleft']));
  const [transitionDurationSec, setTransitionDurationSec] = useState(0.6);
  const [durationMode, setDurationMode] = useState<'perPhoto' | 'total'>('perPhoto');
  const [secondsPerItem, setSecondsPerItem] = useState(3);
  const [totalDurationInput, setTotalDurationInput] = useState(30);
  const [outputPath, setOutputPath] = useState<string | null>(null);
  // Step 3: video-wide look, camera movement on photos, and automatic captions (each slide can override them in step 2).
  const [defaultFilter, setDefaultFilter] = useState<VideoFilterName>('none');
  const [defaultMotion, setDefaultMotion] = useState<VideoMotionName>('none');
  const [captionOpts, setCaptionOpts] = useState<CaptionOptions>(NO_CAPTIONS);
  const [captionStyle, setCaptionStyle] = useState<VideoCaptionStyle>(DEFAULT_CAPTION_STYLE);
  // Step 1 "auto-pick": how long the finished video should be, and an optional template applied together with it.
  const [autoPickSec, setAutoPickSec] = useState(60);
  const [autoTemplateId, setAutoTemplateId] = useState('');

  // Step 4 (music) and step 5 (title screen / end credits, both made with the same designer)
  const [music, setMusic] = useState<MusicSelection | null>(null);
  const [includeTitle, setIncludeTitle] = useState(true);
  const [titleDesign, setTitleDesign] = useState<SlideDesign>(() => titleDesignFor(album));
  const [includeCredits, setIncludeCredits] = useState(false);
  const [creditsDesign, setCreditsDesign] = useState<SlideDesign>(() => defaultCreditsDesign(album.title));
  const [designTab, setDesignTab] = useState<'title' | 'credits'>('title');

  // Step 6
  const [isGenerating, setIsGenerating] = useState(false);
  const [progress, setProgress] = useState<{ stage: 'preparing' | 'encoding'; done: number; total: number } | null>(null);
  const [result, setResult] = useState<{ success: boolean; error?: string; skippedSlides: number; outputPath?: string } | null>(null);
  const unsubscribeRef = useRef<(() => void) | undefined>(undefined);
  // Live preview (see runPreview): state lives up here with the other hooks, before the closed-dialog early return.
  const [preview, setPreview] = useState<{ status: 'idle' | 'rendering' | 'ready' | 'error'; url?: string; error?: string; pct?: number }>({ status: 'idle' });
  const previewUnsubRef = useRef<(() => void) | undefined>(undefined);
  // Step 4 extras: voice-over tracks, and "cut on the beat" (the tempo found for the chosen music).
  const [voiceTracks, setVoiceTracks] = useState<VoiceTrack[]>([]);
  const [beat, setBeat] = useState<{ bpm: number } | null>(null);
  const [beatBusy, setBeatBusy] = useState(false);
  const beatShiftRef = useRef(0); // how far "cut on the beat" moved the music start, so switching it off can undo that

  useEffect(() => {
    if (!isOpen) return;
    setStep(1);
    setResult(null);
    setOutputPath(defaultOutputPath(album.title));
    setShowStylePicker(false);
    setSlides(buildInitialSlides(album));
    setPickingForCollage(new Set());
    setMusic(null);
    setVoiceTracks([]);
    setBeat(null);
    setIncludeTitle(true);
    setTitleDesign(titleDesignFor(album));
    setIncludeCredits(false);
    setCreditsDesign(defaultCreditsDesign(album.title));
    setDesignTab('title');
  }, [isOpen, album.id]);

  // A music track whose licence requires a credit (the built-in library) puts that credit on the end-credits
  // screen and turns the screen on. It is an ordinary text line, so the user can restyle it — or remove it.
  const musicCredit = music?.credit;
  useEffect(() => {
    setCreditsDesign((d) => withMusicCredit(d, musicCredit));
    if (musicCredit) setIncludeCredits(true);
  }, [musicCredit]);

  // Escape backs out one screen at a time: the preview player first (registered after the wizard, so it is in front), then the wizard.
  // While a video is being made Escape does nothing (it is swallowed, so it cannot reach the album view underneath).
  useEscapeLayer(isOpen, () => { if (!isGenerating) onClose(); });
  useEscapeLayer(isOpen && preview.status !== 'idle', () => { window.electronAPI?.cancelVideoExport?.(); setPreview({ status: 'idle' }); });

  if (!isOpen) return null;

  const includedSlides = slides.filter((s) => s.included);
  // Clips run for their trimmed length; only the still slides share the per-photo / total-length setting.
  const clipSeconds = (s: SlideEntry) => Math.max(0, (s.trimEndSec ?? photoMap.get(s.photoIds[0])?.videoDurationSec ?? 0) - (s.trimStartSec ?? 0)) / (s.speed ?? 1) + (s.holdSec ?? 0);
  const stillSlides = includedSlides.filter((s) => s.kind !== 'clip');
  const clipTotalSec = includedSlides.filter((s) => s.kind === 'clip').reduce((a, s) => a + clipSeconds(s), 0);
  const photoSlideCount = includedSlides.length;
  const effectiveSecondsPerItem = durationMode === 'total' && stillSlides.length > 0 ? Math.max(0.5, (totalDurationInput - clipTotalSec - stillSlides.reduce((a, s) => a + (s.seconds ?? 0), 0)) / Math.max(1, stillSlides.filter((s) => s.seconds === undefined).length)) : secondsPerItem;
  const totalCount = photoSlideCount + (includeTitle ? 1 : 0) + (includeCredits ? 1 : 0);
  const cardSeconds = (includeTitle ? titleDesign.seconds : 0) + (includeCredits ? creditsDesign.seconds : 0);
  const hasRealTransition = transitionMode !== 'single' || transition !== 'none';
  const useTransition = hasRealTransition && transitionDurationSec > 0 && totalCount > 1;
  const estimatedTotalDurationSec = Math.max(0, stillSlides.reduce((a, s) => a + (s.seconds ?? effectiveSecondsPerItem), 0) + clipTotalSec + cardSeconds - (useTransition ? transitionDurationSec * (totalCount - 1) : 0));
  // The frame the title / credits are designed in: exactly the size the video will be.
  const frame = computeDimensions(aspectRatio, resolution);
  const albumPhotos = (album.photoIds || []).map((id) => photoMap.get(id)).filter((p): p is Photo => !!p);
  const collageCount = slides.filter((s) => s.kind === 'collage').length;

  // Step 1 shows the slides in album order under their chapter headings (no headings for a chaptered-less album).
  const albumHasChapters = (album.chapters?.length || 0) > 0;
  const step1Groups: Array<{ key: string; title: string | null; entries: SlideEntry[] }> = [];
  for (const entry of slides) {
    const title = albumHasChapters ? (entry.chapterTitle ?? 'Other Photos') : null;
    const last = step1Groups[step1Groups.length - 1];
    if (last && last.title === title) last.entries.push(entry);
    else step1Groups.push({ key: 'g_' + entry.id, title, entries: [entry] });
  }

  const togglePicking = (entryId: string) => {
    const entry = slides.find((s) => s.id === entryId);
    if (!entry || entry.kind !== 'photo') return;
    setPickingForCollage((prev) => {
      const next = new Set(prev);
      if (next.has(entryId)) next.delete(entryId);
      else if (next.size < MAX_COLLAGE) next.add(entryId);
      return next;
    });
  };

  // The photos (in slide order) currently picked for a collage — what the style popup previews.
  const pickedPhotos = slides
    .filter((s) => pickingForCollage.has(s.id))
    .map((s) => photoMap.get(s.photoIds[0]))
    .filter((p): p is Photo => !!p);

  const chapterTitleOfPhoto = (photoId: string): string | null =>
    (album.chapters || []).find((c) => c.photoIds.includes(photoId))?.title ?? null;

  const confirmCollageGroup = (style: VideoCollageStyle) => {
    if (pickingForCollage.size < 2) return;
    setShowStylePicker(false);
    setSlides((prev) => {
      const picked = prev.filter((s) => pickingForCollage.has(s.id));
      const collageEntry: SlideEntry = {
        id: `collage_${Date.now()}`, kind: 'collage', photoIds: picked.flatMap((p) => p.photoIds), included: true,
        chapterTitle: picked[0]?.chapterTitle ?? null, collageStyle: style,
      };
      // Walk in original order: the first picked entry is replaced by the new collage (keeping its
      // position), every later picked entry is dropped (it's now represented by that one collage).
      const result: SlideEntry[] = [];
      let inserted = false;
      for (const s of prev) {
        if (pickingForCollage.has(s.id)) {
          if (!inserted) { result.push(collageEntry); inserted = true; }
          continue;
        }
        result.push(s);
      }
      return result;
    });
    setPickingForCollage(new Set());
  };

  const ungroupCollage = (entryId: string) => {
    setSlides((prev) => {
      const idx = prev.findIndex((s) => s.id === entryId);
      if (idx === -1) return prev;
      const entry = prev[idx];
      const expanded: SlideEntry[] = entry.photoIds.map((pid) => ({ id: `s_${pid}_${Date.now()}`, kind: 'photo', photoIds: [pid], included: entry.included, chapterTitle: chapterTitleOfPhoto(pid) }));
      return [...prev.slice(0, idx), ...expanded, ...prev.slice(idx + 1)];
    });
  };

  /**
   * "Cut on the beat": every slide lasts a whole number of beats (as close to the chosen length as the tempo allows), and the
   * music starts on its first beat, so each cut lands on a beat. Switching it off puts the music start back.
   */
  const toggleBeat = async (on: boolean) => {
    if (!on) {
      if (beat && music) setMusic({ ...music, startSec: Math.max(0, music.startSec - beatShiftRef.current) });
      beatShiftRef.current = 0;
      setBeat(null);
      return;
    }
    const api = window.electronAPI;
    if (!music || !api?.analyzeBeats) return;
    setBeatBusy(true);
    try {
      const info = await api.analyzeBeats(music.file.filePath, music.startSec, music.endSec);
      if (!info) { notifyError('Cut on the beat', new Error('No clear beat could be found in this music.')); return; }
      const beatSec = 60 / info.bpm;
      const beats = Math.max(1, Math.round(secondsPerItem / beatSec));
      setDurationMode('perPhoto');
      setSecondsPerItem(Math.round(beats * beatSec * 100) / 100);
      beatShiftRef.current = info.firstBeatSec;
      setMusic({ ...music, startSec: music.startSec + info.firstBeatSec });
      setBeat({ bpm: Math.round(info.bpm) });
    } finally {
      setBeatBusy(false);
    }
  };

  const applyTemplate = (t: VideoTemplate) => {
    setAspectRatio(t.aspectRatio);
    setResolution(t.resolution);
    if (Array.isArray(t.transition)) { setTransitionMode('multiple'); setMultiPool(new Set(t.transition)); }
    else { setTransitionMode('single'); setTransition(t.transition); }
    setTransitionDurationSec(t.transitionDurationSec);
    setSecondsPerItem(t.secondsPerItem);
    if (t.maxTotalSec) { setDurationMode('total'); setTotalDurationInput(t.maxTotalSec); } else setDurationMode('perPhoto');
    setDefaultFilter(t.filter);
    setDefaultMotion(t.motion);
    setCaptionOpts(t.captions);
  };

  const applyExportPreset = (pr: ExportPreset) => {
    setAspectRatio(pr.aspectRatio);
    setResolution(pr.resolution);
    setQuality(pr.quality);
    // A platform length limit: squeeze the slides so the video fits it.
    if (pr.maxSec && estimatedTotalDurationSec > pr.maxSec) { setDurationMode('total'); setTotalDurationInput(pr.maxSec); }
  };

  /** One click: apply a template (if chosen) and keep only the best shots that fit the wanted length. */
  const autoPick = () => {
    const tpl = VIDEO_TEMPLATES.find((t) => t.id === autoTemplateId);
    if (tpl) applyTemplate(tpl);
    const per = tpl ? tpl.secondsPerItem : secondsPerItem;
    const target = Math.max(2, Math.round(autoPickSec / Math.max(0.5, per)));
    const candidates = slides.filter((e) => e.kind !== 'collage').map((e) => photoMap.get(e.photoIds[0])).filter((p): p is Photo => !!p);
    const keep = new Set(autoPickIds(candidates, target));
    setSlides((prev) => prev.map((e) => (e.kind === 'collage' ? e : { ...e, included: keep.has(e.photoIds[0]) })));
  };

  /** Splits a clip at the middle of its kept part into two clips that play one after the other (each can then be trimmed or sped up on its own). */
  const splitClip = (entryId: string) => setSlides((prev) => {
    const i = prev.findIndex((s) => s.id === entryId);
    const c = prev[i];
    if (!c || c.kind !== 'clip') return prev;
    const dur = photoMap.get(c.photoIds[0])?.videoDurationSec ?? null;
    const a = c.trimStartSec ?? 0, b = c.trimEndSec ?? dur;
    if (b === null || b - a < 1) return prev; // too short to split
    const mid = Math.round(((a + b) / 2) * 10) / 10;
    const second: SlideEntry = { ...c, id: `${c.id}_b${Date.now().toString(36)}`, trimStartSec: mid, holdSec: c.holdSec };
    return [...prev.slice(0, i), { ...c, trimEndSec: mid, holdSec: 0 }, second, ...prev.slice(i + 1)];
  });
  const toggleIncluded = (entryId: string) => setSlides((prev) => prev.map((s) => (s.id === entryId ? { ...s, included: !s.included } : s)));

  const reorderSlide = (from: number, to: number) => setSlides((prev) => {
    if (from === to || from < 0 || to < 0 || from >= prev.length || to >= prev.length) return prev;
    const arr = [...prev];
    const [moved] = arr.splice(from, 1);
    arr.splice(to, 0, moved);
    return arr;
  });
  const timelineItems: TimelineItem[] = slides.map((e) => ({
    id: e.id,
    kind: e.kind,
    label: e.kind === 'collage' ? `Collage of ${e.photoIds.length}` : (photoMap.get(e.photoIds[0])?.fileName || 'Photo'),
    seconds: e.kind === 'clip' ? clipSeconds(e) : (e.seconds ?? effectiveSecondsPerItem),
    included: e.included,
    thumbUrl: (() => { const ph = photoMap.get(e.photoIds[0]); return ph ? getLocalPhotoUrl(ph.filePath, ph.originalRemotePath, false, 60) : undefined; })(),
  }));
  const selectTimelineSlide = (id: string) => {
    setTimelineSelectedId(id);
    document.querySelector(`[data-slide-row="${id}"]`)?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  };

  const moveSlide = (idx: number, delta: number) => {
    setSlides((prev) => {
      const target = idx + delta;
      if (target < 0 || target >= prev.length) return prev;
      const arr = [...prev];
      [arr[idx], arr[target]] = [arr[target], arr[idx]];
      return arr;
    });
  };

  const handleDrop = (dropIdx: number) => {
    if (draggedIndex === null || draggedIndex === dropIdx) { setDraggedIndex(null); return; }
    setSlides((prev) => {
      const arr = [...prev];
      const [moved] = arr.splice(draggedIndex, 1);
      arr.splice(dropIdx, 0, moved);
      return arr;
    });
    setDraggedIndex(null);
  };

  const handleChooseOutput = async () => {
    const api = window.electronAPI;
    if (!api?.chooseVideoOutputPath) return;
    // The dialog opens on the current (default: <library>/videos/<album>.mp4) location, not a bare file name.
    const suggested = outputPath || defaultOutputPath(album.title) || `${album.title.replace(/[\\/:*?"<>|]/g, '_')}.mp4`;
    const chosen = await api.chooseVideoOutputPath(suggested);
    if (chosen) setOutputPath(chosen);
  };

  /** The photo / collage / clip slides as the exporter takes them, with each slide's look, movement and caption applied. */
  const buildSlideInputs = (): VideoSlideInput[] => {
    const out: VideoSlideInput[] = [];
    for (const s of includedSlides) {
      const lead = photoMap.get(s.photoIds[0]);
      const peopleList = libraryStore.getState().people;
      const filter = s.filter ?? defaultFilter;
      const motion = s.motion ?? defaultMotion;
      // A caption typed on the slide wins; otherwise the automatic one from the switches in step 3.
      const caption = s.caption !== undefined ? s.caption : buildAutoCaption(lead, peopleList, s.chapterTitle, captionOpts);
      const look = { filter, ...(caption ? { caption } : {}) };
      const move = s.kind === 'clip' ? {} : { motion, ...(motion === 'face' ? { focus: faceFocus(lead) } : {}) };
      if (s.kind === 'collage') out.push({ kind: 'collage', seconds: s.seconds, collageStyle: s.collageStyle || 'grid', photoPaths: s.photoIds.map((id) => photoMap.get(id)?.filePath).filter((p): p is string => !!p), ...look, ...move });
      else if (s.kind === 'clip') {
        const p = photoMap.get(s.photoIds[0]);
        if (p) out.push({ kind: 'clip', clipPath: p.filePath, trimStartSec: s.trimStartSec ?? 0, trimEndSec: s.trimEndSec ?? null, speed: s.speed ?? 1, reverse: !!s.reverse, holdSec: s.holdSec ?? 0, muted: !s.keepSound, ...look });
      } else {
        const p = photoMap.get(s.photoIds[0]);
        out.push({ kind: 'photo', seconds: s.seconds, photoPaths: p ? [p.filePath] : [], ...look, ...move });
      }
    }
    return out;
  };

  /** One effect for every cut, or (random / multiple) an independently random pick per cut. */
  const pickTransitions = (slideCount: number): VideoTransition | VideoTransition[] => {
    const pool: VideoTransition[] = transitionMode === 'multiple' && multiPool.size > 0 ? Array.from(multiPool) : REAL_TRANSITIONS;
    return transitionMode === 'single' ? transition : Array.from({ length: Math.max(0, slideCount - 1) }, () => pool[Math.floor(Math.random() * pool.length)]);
  };

  // ── Live preview: a quick 360p draft of the first ~20 seconds of the current plan, played right in the wizard ──
  const runPreview = async () => {
    const api = window.electronAPI;
    if (!api?.previewVideo) return;
    // Keep the slides that fit the first ~20 s (always at least two, so a transition is visible).
    const all = buildSlideInputs();
    const kept: VideoSlideInput[] = [];
    let acc = 0;
    for (const sl of all) {
      if (kept.length >= 2 && acc >= 20) break;
      kept.push(sl);
      acc += sl.kind === 'clip' ? Math.max(0, ((sl.trimEndSec ?? 0) - (sl.trimStartSec ?? 0)) / (sl.speed ?? 1) + (sl.holdSec ?? 0)) || effectiveSecondsPerItem : (sl.seconds ?? effectiveSecondsPerItem);
    }
    setPreview({ status: 'rendering', pct: 0 });
    previewUnsubRef.current?.();
    previewUnsubRef.current = api.onVideoExportProgress?.((pr) => setPreview((cur) => (cur.status === 'rendering' ? { ...cur, pct: pr.stage === 'preparing' ? Math.round((pr.done / Math.max(1, pr.total)) * 50) : 50 + Math.round(pr.done / 2) } : cur)));
    try {
      const res = await api.previewVideo({
        slides: kept, aspectRatio, resolution: '360p', quality: 'draft', transition: pickTransitions(kept.length), transitionDurationSec,
        secondsPerItem: effectiveSecondsPerItem, outputPath: '',
        voice: voiceTracks.length ? voiceTracks.map((v) => ({ filePath: v.file.filePath, startSec: v.startSec, volume: v.volume })) : undefined,
        captionStyle,
        audio: music ? { filePath: music.file.filePath, startSec: music.startSec, endSec: music.endSec, loop: music.loop, fadeOutSec: 0, volume: music.volume } : undefined,
      });
      if (res.success && res.outputPath) setPreview({ status: 'ready', url: getLocalPhotoUrl(res.outputPath, undefined, true, 0) + '&t=' + Date.now() });
      else setPreview({ status: 'error', error: res.error || 'The preview could not be made.' });
    } catch (err) {
      setPreview({ status: 'error', error: (err as Error)?.message || 'The preview could not be made.' });
    } finally {
      previewUnsubRef.current?.();
    }
  };
  const closePreview = () => { window.electronAPI?.cancelVideoExport?.(); setPreview({ status: 'idle' }); };

  const handleGenerate = async () => {
    const api = window.electronAPI;
    if (!api?.exportVideo || !outputPath) return;
    setIsGenerating(true);
    setResult(null);
    setProgress({ stage: 'preparing', done: 0, total: totalCount });
    unsubscribeRef.current = api.onVideoExportProgress?.((p) => setProgress(p));

    // Title / credits cards are drawn here at the video's exact size (so text can't fall outside the frame)
    // and sent to the exporter as finished pictures.
    const renderCard = async (design: SlideDesign): Promise<VideoSlideInput> => {
      const bg = design.background;
      const bgPhoto = bg.kind === 'photo' ? photoMap.get(bg.photoId) : undefined;
      const imageDataUrl = await renderDesignToDataUrl(design, frame.width, frame.height, bgPhoto ? designPhotoUrl(bgPhoto) : undefined);
      return { kind: 'card', imageDataUrl, seconds: design.seconds };
    };
    let titleCard: VideoSlideInput | null = null;
    let creditsCard: VideoSlideInput | null = null;
    try {
      if (includeTitle) titleCard = await renderCard(titleDesign);
      if (includeCredits) creditsCard = await renderCard(creditsDesign);
    } catch (err) {
      unsubscribeRef.current?.();
      setIsGenerating(false);
      setProgress(null);
      setResult({ success: false, error: (err as Error)?.message || 'Could not draw the title screen.', skippedSlides: 0 });
      return;
    }

    const videoSlides: VideoSlideInput[] = [];
    if (titleCard) videoSlides.push(titleCard);
    videoSlides.push(...buildSlideInputs());

    if (creditsCard) videoSlides.push(creditsCard);

    // Decided once here so the export is repeatable.
    const transitionSpec = pickTransitions(videoSlides.length);

    try {
      const res = await api.exportVideo({
        slides: videoSlides, aspectRatio, resolution, quality, transition: transitionSpec, transitionDurationSec,
        secondsPerItem: effectiveSecondsPerItem, outputPath,
        voice: voiceTracks.length ? voiceTracks.map((v) => ({ filePath: v.file.filePath, startSec: v.startSec, volume: v.volume })) : undefined,
        captionStyle,
        audio: music ? { filePath: music.file.filePath, startSec: music.startSec, endSec: music.endSec, loop: music.loop, fadeOutSec: music.fadeOutSec, volume: music.volume } : undefined,
      });
      setResult(res);
      if (res.success && res.outputPath) {
        api.openVideoFile?.(res.outputPath).catch(() => {});
      }
    } catch (err) {
      notifyError('Generate video', err);
      setResult({ success: false, error: (err as Error)?.message || 'Unknown error', skippedSlides: 0 });
    } finally {
      unsubscribeRef.current?.();
      setIsGenerating(false);
      setProgress(null);
    }
  };

  const handleCancel = () => { window.electronAPI?.cancelVideoExport?.(); };

  const thumbFor = (entry: SlideEntry) => photoMap.get(entry.photoIds[0]);

  return (
    <div
      style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.78)', backdropFilter: 'blur(8px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' }}
      onClick={(e) => { if (e.target === e.currentTarget && !isGenerating) onClose(); }}
    >
      <div className="animate-in" style={{ backgroundColor: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-xl)', width: '100%', maxWidth: '900px', maxHeight: '88vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 24px', borderBottom: '1px solid var(--border-subtle)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <Film size={20} color="#ec4899" />
            <div>
              <h2 style={{ margin: 0, fontSize: '1.05rem' }}>Create Video — {album.title}</h2>
              <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>Step {step} of {LAST_STEP}: {STEP_TITLES[step - 1]}</span>
            </div>
          </div>
          <button className="btn btn-ghost btn-icon" onClick={onClose} disabled={isGenerating}><X size={20} /></button>
        </div>

        <div style={{ display: 'flex', gap: '4px', padding: '10px 24px 0' }}>
          {STEP_TITLES.map((t, i) => (
            <div key={t} style={{ flex: 1, height: '4px', borderRadius: '2px', backgroundColor: i < step ? '#ec4899' : 'var(--border-subtle)' }} />
          ))}
        </div>

        {step === 1 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', padding: '12px 24px 10px', borderBottom: '1px solid var(--border-subtle)' }}>
              <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                Select 2-9 photos and click <strong>"Group as Collage"</strong> to combine them into one frame. Everything not grouped stays its own slide — you'll choose the order (and can leave any out) in the next step.
              </p>
              <div data-testid="auto-pick" style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', fontSize: '0.82rem' }}>
                <strong>Auto video:</strong>
                <label style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <select className="input" aria-label="Video length" value={autoPickSec} onChange={(e) => setAutoPickSec(Number(e.target.value))} style={{ height: '32px' }}>
                    {[30, 60, 90, 120, 180].map((n) => <option key={n} value={n}>{n} s</option>)}
                  </select>
                </label>
                <select className="input" aria-label="Template" value={autoTemplateId} onChange={(e) => setAutoTemplateId(e.target.value)} style={{ height: '32px' }}>
                  <option value="">No template</option>
                  {VIDEO_TEMPLATES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                </select>
                <button className="btn btn-secondary" onClick={autoPick} style={{ fontSize: '0.78rem', padding: '5px 12px' }}>Pick the best shots</button>
                <span style={{ color: 'var(--text-muted)' }}>Keeps favourites, sharp shots and people; skips near-duplicates.</span>
              </div>
              {pickingForCollage.size > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 12px', borderRadius: 'var(--radius-md)', background: 'rgba(236, 72, 153, 0.12)', border: '1px solid rgba(236, 72, 153, 0.35)' }}>
                  <span style={{ fontSize: '0.82rem', flex: 1 }}>{pickingForCollage.size} photo{pickingForCollage.size === 1 ? '' : 's'} selected (2-9)</span>
                  <button className="btn btn-secondary" disabled={pickingForCollage.size < 2} onClick={() => setShowStylePicker(true)} style={{ fontSize: '0.78rem', padding: '5px 12px' }}>Group as Collage</button>
                  <button className="btn btn-ghost" onClick={() => setPickingForCollage(new Set())} style={{ fontSize: '0.78rem', padding: '5px 12px' }}>Clear</button>
                </div>
              )}
          </div>
        )}

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '20px 24px' }}>
          {step === 1 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))', gap: '10px' }}>
                {step1Groups.map((group) => (
                  <React.Fragment key={group.key}>
                    {group.title !== null && (
                      <h4 data-testid="step1-chapter-heading" style={{ gridColumn: '1 / -1', margin: '6px 0 0', fontSize: '0.9rem', fontWeight: 700, color: 'var(--text-secondary)' }}>{group.title}</h4>
                    )}
                    {group.entries.map((entry) => {
                  const isPicking = pickingForCollage.has(entry.id);
                  if (entry.kind === 'collage') {
                    const thumbs = entry.photoIds.slice(0, 4).map((id) => photoMap.get(id)).filter((p): p is Photo => !!p);
                    return (
                      <div key={entry.id} style={{ position: 'relative', aspectRatio: '1', borderRadius: 'var(--radius-md)', overflow: 'hidden', border: '2px solid rgba(236, 72, 153, 0.5)' }}>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gridTemplateRows: '1fr 1fr', gap: '2px', width: '100%', height: '100%' }}>
                          {thumbs.map((p) => <img key={p.id} src={getLocalPhotoUrl(p.filePath, p.originalRemotePath, false, 80)} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />)}
                        </div>
                        <button
                          onClick={() => ungroupCollage(entry.id)}
                          title="Ungroup"
                          style={{ position: 'absolute', top: '4px', right: '4px', width: '22px', height: '22px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(15,23,42,0.85)', border: '1px solid rgba(255,255,255,0.3)' }}
                        >
                          <Ungroup size={12} color="white" />
                        </button>
                      </div>
                    );
                  }
                  const photo = thumbFor(entry);
                  if (!photo) return null;
                  return (
                    <div
                      key={entry.id}
                      onClick={() => (entry.kind === 'clip' ? toggleIncluded(entry.id) : togglePicking(entry.id))}
                      title={entry.kind === 'clip' ? 'Video clip — click to include or leave it out' : undefined}
                      style={{ position: 'relative', aspectRatio: '1', borderRadius: 'var(--radius-md)', overflow: 'hidden', cursor: 'pointer', border: isPicking ? '2px solid #ec4899' : '1px solid var(--border-subtle)' }}
                    >
                      <img src={getLocalPhotoUrl(photo.filePath, photo.originalRemotePath, false, 160)} alt={photo.fileName} style={{ width: '100%', height: '100%', objectFit: 'cover', opacity: entry.included ? 1 : 0.35 }} />
                      {entry.kind === 'clip' && (
                        <span data-testid="step1-clip-badge" style={{ position: 'absolute', left: '6px', bottom: '6px', padding: '2px 6px', borderRadius: '4px', background: 'rgba(10,12,16,0.8)', color: '#f5b942', fontSize: '0.7rem', fontWeight: 700 }}>
                          {fmtSec(clipSeconds(entry))}
                        </span>
                      )}
                      {isPicking && (
                        <div style={{ position: 'absolute', top: '6px', left: '6px', width: '22px', height: '22px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: '#ec4899', border: '1px solid rgba(255,255,255,0.3)' }}>
                          <Check size={13} color="white" />
                        </div>
                      )}
                    </div>
                  );
                    })}
                  </React.Fragment>
                ))}
              </div>
            </div>
          )}

          {step === 2 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                Drag <GripVertical size={12} style={{ verticalAlign: 'middle' }} /> to reorder, or use the arrows. Uncheck anything you don't want in the video.
              </p>
              <SlideTimeline
                items={timelineItems}
                selectedId={timelineSelectedId}
                onSelect={selectTimelineSlide}
                onReorder={reorderSlide}
                onResize={(id, sec) => setSlides((prev) => prev.map((x) => (x.id === id ? { ...x, seconds: sec } : x)))}
              />
              {slides.map((entry, idx) => {
                const photo = entry.kind !== 'collage' ? thumbFor(entry) : null;
                const srcDur = entry.kind === 'clip' ? (thumbFor(entry)?.videoDurationSec ?? null) : null;
                const collageThumb = entry.kind === 'collage' ? thumbFor(entry) : null;
                return (
                  <div
                    key={entry.id}
                    data-slide-row={entry.id}
                    draggable
                    onDragStart={() => setDraggedIndex(idx)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => handleDrop(idx)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: '12px', padding: '8px 10px', borderRadius: 'var(--radius-md)',
                      border: '1px solid var(--border-subtle)', opacity: entry.included ? 1 : 0.45,
                      backgroundColor: draggedIndex === idx ? 'rgba(236, 72, 153, 0.08)' : 'transparent',
                    }}
                  >
                    <GripVertical size={16} color="var(--text-muted)" style={{ cursor: 'grab', flexShrink: 0 }} />
                    <input type="checkbox" checked={entry.included} onChange={() => toggleIncluded(entry.id)} style={{ flexShrink: 0 }} />
                    <div style={{ width: '44px', height: '44px', borderRadius: 'var(--radius-sm)', overflow: 'hidden', flexShrink: 0, backgroundColor: 'var(--bg-surface-elevated)' }}>
                      {entry.kind === 'collage'
                        ? <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gridTemplateRows: '1fr 1fr', gap: '1px', width: '100%', height: '100%' }}>
                            {entry.photoIds.slice(0, 4).map((id) => photoMap.get(id)).filter((p): p is Photo => !!p).map((p) => <img key={p.id} src={getLocalPhotoUrl(p.filePath, p.originalRemotePath, false, 60)} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />)}
                          </div>
                        : photo && <img src={getLocalPhotoUrl(photo.filePath, photo.originalRemotePath, false, 60)} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
                    </div>
                    <span style={{ flex: 1, fontSize: '0.85rem', minWidth: 0 }}>
                      {entry.kind === 'collage' ? <><Layers size={13} style={{ verticalAlign: 'middle', marginRight: '4px' }} />Collage of {entry.photoIds.length}</> : (photo?.fileName || 'Photo')}
                      {entry.kind === 'clip' && (
                        <span data-testid="clip-controls" style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginTop: '4px', fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                          <span style={{ color: '#f5b942', fontWeight: 700 }}>CLIP {fmtSec(clipSeconds(entry))}</span>
                          <label>from <input type="number" min={0} step={0.5} value={entry.trimStartSec ?? 0} style={{ width: '60px' }}
                            onChange={(e) => { const v = Math.max(0, Number(e.target.value) || 0); setSlides((prev) => prev.map((s) => (s.id === entry.id ? { ...s, trimStartSec: srcDur ? Math.min(v, Math.max(0, (s.trimEndSec ?? srcDur) - 0.5)) : v } : s))); }} /> s</label>
                          <label>to <input type="number" min={0} step={0.5} value={entry.trimEndSec ?? srcDur ?? ''} placeholder="end" style={{ width: '60px' }}
                            onChange={(e) => { const raw = e.target.value === '' ? null : Number(e.target.value); setSlides((prev) => prev.map((s) => (s.id === entry.id ? { ...s, trimEndSec: raw === null ? null : Math.min(srcDur ?? raw, Math.max(raw, (s.trimStartSec ?? 0) + 0.5)) } : s))); }} /> s{srcDur ? ` of ${fmtSec(srcDur)}` : ''}</label>
                          {srcDur ? (
                            <TrimRange duration={srcDur} start={entry.trimStartSec ?? 0} end={entry.trimEndSec ?? srcDur}
                              onChange={(a, b) => setSlides((prev) => prev.map((s) => (s.id === entry.id ? { ...s, trimStartSec: a, trimEndSec: b } : s)))} />
                          ) : null}
                          <label>speed <select aria-label="Clip speed" value={entry.speed ?? 1} style={{ fontSize: '0.78rem' }}
                            onChange={(e) => { const v = Number(e.target.value); setSlides((prev) => prev.map((s) => (s.id === entry.id ? { ...s, speed: v } : s))); }}>
                            {[0.25, 0.5, 1, 1.5, 2, 4].map((v) => <option key={v} value={v}>{v === 1 ? 'Normal' : `${v}x`}</option>)}
                          </select></label>
                          <label style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                            <input type="checkbox" aria-label="Play backwards" checked={!!entry.reverse} onChange={() => setSlides((prev) => prev.map((s) => (s.id === entry.id ? { ...s, reverse: !s.reverse } : s)))} /> Backwards
                          </label>
                          <label>freeze <select aria-label="Freeze the last frame" value={entry.holdSec ?? 0} style={{ fontSize: '0.78rem' }}
                            onChange={(e) => { const v = Number(e.target.value); setSlides((prev) => prev.map((s) => (s.id === entry.id ? { ...s, holdSec: v } : s))); }}>
                            {[0, 1, 2, 3, 5].map((v) => <option key={v} value={v}>{v === 0 ? 'No' : `${v} s`}</option>)}
                          </select></label>
                          <button type="button" className="btn btn-ghost" aria-label="Split this clip in two" title="Split at the middle of the kept part" style={{ padding: '0 6px', fontSize: '0.75rem' }}
                            onClick={() => splitClip(entry.id)}>Split</button>
                          <label style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                            <input type="checkbox" checked={!!entry.keepSound} onChange={() => setSlides((prev) => prev.map((s) => (s.id === entry.id ? { ...s, keepSound: !s.keepSound } : s)))} /> Keep sound
                          </label>
                        </span>
                      )}
                    </span>
                    <span data-testid="slide-look-controls" style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
                      {entry.kind !== 'clip' && (
                        <select aria-label="Movement for this slide" title="Camera movement for this slide" value={entry.motion ?? ''} style={{ width: '92px', fontSize: '0.72rem' }}
                          onChange={(e) => { const v = (e.target.value || undefined) as VideoMotionName | undefined; setSlides((prev) => prev.map((s) => (s.id === entry.id ? { ...s, motion: v } : s))); }}>
                          <option value="">Movement: video default</option>
                          {VIDEO_MOTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                        </select>
                      )}
                      <select aria-label="Look for this slide" title="Colour look for this slide" value={entry.filter ?? ''} style={{ width: '82px', fontSize: '0.72rem' }}
                        onChange={(e) => { const v = (e.target.value || undefined) as VideoFilterName | undefined; setSlides((prev) => prev.map((s) => (s.id === entry.id ? { ...s, filter: v } : s))); }}>
                        <option value="">Look: video default</option>
                        {VIDEO_FILTERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                      </select>
                      <input type="text" aria-label="Caption for this slide" title="Caption for this slide (empty = the automatic one)" placeholder="Caption" value={entry.caption ?? ''} style={{ width: '110px', fontSize: '0.72rem' }}
                        onChange={(e) => { const v = e.target.value; setSlides((prev) => prev.map((s) => (s.id === entry.id ? { ...s, caption: v === '' ? undefined : v } : s))); }} />
                    </span>
                    {entry.kind !== 'clip' && (
                      <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '0.75rem', color: 'var(--text-muted)', flexShrink: 0 }}>
                        <input type="number" min={0.5} step={0.5} aria-label="Seconds on screen" data-testid="slide-seconds" value={entry.seconds ?? ''} placeholder={String(+effectiveSecondsPerItem.toFixed(1))} style={{ width: '56px' }}
                          onChange={(e) => { const v = e.target.value === '' ? undefined : Math.max(0.5, Number(e.target.value) || 0.5); setSlides((prev) => prev.map((s) => (s.id === entry.id ? { ...s, seconds: v } : s))); }} /> s
                      </label>
                    )}
                    <button className="btn btn-ghost btn-icon" disabled={idx === 0} onClick={() => moveSlide(idx, -1)} style={{ width: '26px', height: '26px' }}><ChevronUp size={14} /></button>
                    <button className="btn btn-ghost btn-icon" disabled={idx === slides.length - 1} onClick={() => moveSlide(idx, 1)} style={{ width: '26px', height: '26px' }}><ChevronDown size={14} /></button>
                  </div>
                );
              })}
              {slides.length === 0 && <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>This album has no photos.</p>}
            </div>
          )}

          {step === 3 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '22px' }}>
              <div data-testid="templates-presets" style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', alignItems: 'center' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.85rem', fontWeight: 600 }}>
                  Template
                  <select className="input" aria-label="Video template" defaultValue="" onChange={(e) => { const t = VIDEO_TEMPLATES.find((x) => x.id === e.target.value); if (t) applyTemplate(t); }} style={{ height: '36px', width: '200px', fontWeight: 400 }}>
                    <option value="">Choose a template…</option>
                    {VIDEO_TEMPLATES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                  </select>
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.85rem', fontWeight: 600 }}>
                  Export for
                  <select className="input" aria-label="Export for" defaultValue="" onChange={(e) => { const pr = EXPORT_PRESETS.find((x) => x.id === e.target.value); if (pr) applyExportPreset(pr); }} style={{ height: '36px', width: '260px', fontWeight: 400 }}>
                    <option value="">Choose a destination…</option>
                    {EXPORT_PRESETS.map((pr) => <option key={pr.id} value={pr.id}>{pr.label}</option>)}
                  </select>
                </label>
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '10px' }}>Aspect Ratio</label>
                <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                  {(['16:9', '9:16', '1:1', '4:3'] as VideoAspectRatio[]).map((ar) => (
                    <button key={ar} className={`btn ${aspectRatio === ar ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setAspectRatio(ar)} style={{ padding: '10px 16px', fontSize: '0.85rem' }}>
                      {ar} {ar === '16:9' ? '(Landscape / YouTube)' : ar === '9:16' ? '(Reels / Stories)' : ar === '1:1' ? '(Square)' : ''}
                    </button>
                  ))}
                </div>
              </div>
              <div style={{ display: 'flex', gap: '32px', flexWrap: 'wrap' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '10px' }}>Resolution</label>
                  <div style={{ display: 'flex', gap: '10px' }}>
                    {(['720p', '1080p'] as VideoResolutionTier[]).map((r) => (
                      <button key={r} className={`btn ${resolution === r ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setResolution(r)} style={{ padding: '10px 16px', fontSize: '0.85rem' }}>{r}</button>
                    ))}
                  </div>
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '10px' }}>Quality / Generation Speed</label>
                  <div style={{ display: 'flex', gap: '10px' }}>
                    {(['draft', 'good', 'best'] as VideoQuality[]).map((q) => (
                      <button key={q} className={`btn ${quality === q ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setQuality(q)} style={{ padding: '10px 16px', fontSize: '0.85rem', textTransform: 'capitalize' }}>
                        {q}{q === 'draft' ? ' (fastest)' : q === 'best' ? ' (slowest, sharpest)' : ' (balanced)'}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '8px' }}>Transition Effect</label>
                <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', marginBottom: '10px' }}>
                  {([
                    ['single', 'One effect for every cut'],
                    ['random', 'Random (a different effect each cut)'],
                    ['multiple', 'Pick several (random among those)'],
                  ] as Array<[TransitionMode, string]>).map(([mode, label]) => (
                    <label key={mode} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.85rem' }}>
                      <input type="radio" name="transition-mode" checked={transitionMode === mode} onChange={() => setTransitionMode(mode)} /> {label}
                    </label>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: '14px', alignItems: 'center', flexWrap: 'wrap' }}>
                  {transitionMode === 'single' && (
                    <select className="input" value={transition} onChange={(e) => setTransition(e.target.value as VideoTransition)} style={{ height: '40px', width: '220px' }}>
                      {TRANSITIONS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                    </select>
                  )}
                  {transitionMode === 'multiple' && (
                    <div style={{ display: 'flex', gap: '8px 16px', flexWrap: 'wrap' }} data-testid="transition-pool">
                      {TRANSITIONS.filter((t) => t.value !== 'none').map((t) => (
                        <label key={t.value} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.82rem' }}>
                          <input
                            type="checkbox"
                            checked={multiPool.has(t.value)}
                            onChange={() => setMultiPool((prev) => {
                              const next = new Set(prev);
                              if (next.has(t.value)) next.delete(t.value);
                              else next.add(t.value);
                              return next;
                            })}
                          /> {t.label}
                        </label>
                      ))}
                    </div>
                  )}
                  {hasRealTransition && (
                    <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.82rem' }}>
                      Duration (s)
                      <input type="number" className="input" min={0.1} max={3} step={0.1} value={transitionDurationSec} onChange={(e) => setTransitionDurationSec(Math.max(0.1, parseFloat(e.target.value) || 0.1))} style={{ height: '36px', width: '80px' }} />
                    </label>
                  )}
                </div>
                {transitionMode === 'multiple' && multiPool.size === 0 && (
                  <div style={{ fontSize: '0.78rem', color: '#f59e0b', marginTop: '6px' }}>Nothing ticked — every effect will be used.</div>
                )}
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '8px' }}>Timing</label>
                <div style={{ display: 'flex', gap: '14px', alignItems: 'center', flexWrap: 'wrap' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.85rem' }}>
                    <input type="radio" checked={durationMode === 'perPhoto'} onChange={() => setDurationMode('perPhoto')} /> Seconds per photo
                  </label>
                  {durationMode === 'perPhoto' && <input type="number" className="input" min={0.5} max={30} step={0.5} value={secondsPerItem} onChange={(e) => setSecondsPerItem(Math.max(0.5, parseFloat(e.target.value) || 0.5))} style={{ height: '36px', width: '90px' }} />}
                  <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.85rem' }}>
                    <input type="radio" checked={durationMode === 'total'} onChange={() => setDurationMode('total')} /> Total video length (s)
                  </label>
                  {durationMode === 'total' && <input type="number" className="input" min={1} max={600} step={1} value={totalDurationInput} onChange={(e) => setTotalDurationInput(Math.max(1, parseFloat(e.target.value) || 1))} style={{ height: '36px', width: '90px' }} />}
                </div>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '6px' }}>
                  {photoSlideCount} slide{photoSlideCount === 1 ? '' : 's'} (~{effectiveSecondsPerItem.toFixed(1)}s each) → estimated total length: <strong>{estimatedTotalDurationSec.toFixed(1)}s</strong> · about <strong data-testid="size-estimate">{formatSizeMB(estimateSizeMB(estimatedTotalDurationSec, resolution, quality, !!music))}</strong>
                </div>
              </div>
              <div data-testid="look-motion-captions">
                <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '8px' }}>Look, Movement &amp; Captions</label>
                <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', alignItems: 'center' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.82rem' }}>
                    Colour look
                    <select className="input" aria-label="Colour look" value={defaultFilter} onChange={(e) => setDefaultFilter(e.target.value as VideoFilterName)} style={{ height: '36px', width: '150px' }}>
                      {VIDEO_FILTERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.82rem' }}>
                    Photo movement
                    <select className="input" aria-label="Photo movement" value={defaultMotion} onChange={(e) => setDefaultMotion(e.target.value as VideoMotionName)} style={{ height: '36px', width: '170px' }}>
                      {VIDEO_MOTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                  </label>
                </div>
                <div style={{ display: 'flex', gap: '14px', flexWrap: 'wrap', alignItems: 'center', marginTop: '10px', fontSize: '0.82rem' }}>
                  <span style={{ color: 'var(--text-muted)' }}>Add a caption with:</span>
                  {([['chapter', 'Chapter'], ['place', 'Place'], ['date', 'Date'], ['people', 'People']] as Array<[keyof CaptionOptions, string]>).map(([k, label]) => (
                    <label key={k} style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                      <input type="checkbox" checked={captionOpts[k]} onChange={() => setCaptionOpts((o) => ({ ...o, [k]: !o[k] }))} /> {label}
                    </label>
                  ))}
                </div>
                <div data-testid="caption-style" style={{ display: 'flex', gap: '14px', flexWrap: 'wrap', alignItems: 'center', marginTop: '10px', fontSize: '0.82rem' }}>
                  <span style={{ color: 'var(--text-muted)' }}>Caption style:</span>
                  <select className="input" aria-label="Caption position" value={captionStyle.position} onChange={(e) => setCaptionStyle((c) => ({ ...c, position: e.target.value as VideoCaptionStyle['position'] }))} style={{ height: '32px' }}>
                    {CAPTION_POSITIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                  <select className="input" aria-label="Caption size" value={captionStyle.size} onChange={(e) => setCaptionStyle((c) => ({ ...c, size: e.target.value as VideoCaptionStyle['size'] }))} style={{ height: '32px' }}>
                    {CAPTION_SIZES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                  <select className="input" aria-label="Caption colour" value={captionStyle.color} onChange={(e) => setCaptionStyle((c) => ({ ...c, color: e.target.value as VideoCaptionStyle['color'] }))} style={{ height: '32px' }}>
                    {CAPTION_COLORS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '8px' }}>Where to Save</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <button className="btn btn-secondary" onClick={handleChooseOutput} style={{ gap: '8px' }}>
                    <FolderOpen size={16} /> {outputPath ? 'Change Location' : 'Choose Where to Save'}
                  </button>
                  {outputPath && <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)', wordBreak: 'break-all' }}>{outputPath}</span>}
                </div>
              </div>
            </div>
          )}

          {step === 4 && (
            <>
              <MusicStep music={music} onChange={(m) => { if (beat) { setBeat(null); beatShiftRef.current = 0; } setMusic(m); }} videoLengthSec={estimatedTotalDurationSec} />
              <VoiceAndBeatPanel tracks={voiceTracks} onChange={setVoiceTracks} videoLengthSec={estimatedTotalDurationSec} hasMusic={!!music} beat={beat} beatBusy={beatBusy} onBeatToggle={toggleBeat} />
            </>
          )}

          {step === 5 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                Design the opening title screen and, if you like, a closing credits screen. Both are drawn at your video's exact size ({frame.width}×{frame.height}), so nothing runs off the edge.
              </p>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button className={`btn ${designTab === 'title' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setDesignTab('title')} style={{ fontSize: '0.82rem' }}>Title screen{includeTitle ? '' : ' (off)'}</button>
                <button className={`btn ${designTab === 'credits' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setDesignTab('credits')} style={{ fontSize: '0.82rem' }}>End credits{includeCredits ? '' : ' (off)'}</button>
              </div>
              {designTab === 'title' ? (
                <>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.88rem', fontWeight: 600 }}>
                    <input type="checkbox" checked={includeTitle} onChange={(e) => setIncludeTitle(e.target.checked)} /> Add a title screen at the start
                  </label>
                  {includeTitle && <SlideDesigner design={titleDesign} onChange={setTitleDesign} width={frame.width} height={frame.height} photos={albumPhotos} onReset={() => setTitleDesign(titleDesignFor(album))} />}
                </>
              ) : (
                <>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.88rem', fontWeight: 600 }}>
                    <input type="checkbox" checked={includeCredits} onChange={(e) => setIncludeCredits(e.target.checked)} /> Add an end-credits screen at the end
                  </label>
                  {musicCredit && (!includeCredits || !creditsDesign.texts.some((t) => t.id === MUSIC_CREDIT_ID)) && (
                    <div role="alert" style={{ fontSize: '0.8rem', color: '#f59e0b' }}>
                      The music you chose (Creative Commons Attribution) requires a credit in your video. Keep the end-credits screen with the music line, or credit the artist yourself.
                    </div>
                  )}
                  {includeCredits && <SlideDesigner design={creditsDesign} onChange={setCreditsDesign} width={frame.width} height={frame.height} photos={albumPhotos} onReset={() => setCreditsDesign(creditsDesignFor(album, musicCredit))} />}
                </>
              )}
            </div>
          )}

          {step === 6 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div style={{ padding: '16px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-subtle)', display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '0.85rem' }}>
                <div><strong>{photoSlideCount}</strong> slide{photoSlideCount === 1 ? '' : 's'} ({collageCount} collage{collageCount === 1 ? '' : 's'}){includeTitle ? ' + a title screen' : ''}{includeCredits ? ' + end credits' : ''}</div>
                <div>{music ? `Music: ${music.file.name} (${music.loop ? 'repeats to fill the video' : 'plays once'})` : 'No music'}</div>
                <div>{aspectRatio} · {resolution} · {quality} quality · {transition === 'none' ? 'hard cuts' : `"${transition}" transitions`}</div>
                <div>Estimated length: <strong>{estimatedTotalDurationSec.toFixed(1)}s</strong></div>
                <div style={{ wordBreak: 'break-all', color: 'var(--text-muted)' }}>{outputPath || 'No save location chosen — go back to Video Settings.'}</div>
              </div>

              {isGenerating && progress && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <div style={{ fontSize: '0.82rem' }}>
                    {progress.stage === 'preparing' ? `Preparing slides… ${progress.done}/${progress.total}` : `Encoding… ${progress.done}%`}
                  </div>
                  <div style={{ height: '8px', borderRadius: '4px', backgroundColor: 'var(--bg-surface-elevated)', overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${progress.stage === 'preparing' ? Math.round((progress.done / Math.max(1, progress.total)) * 100) : progress.done}%`, backgroundColor: '#ec4899', transition: 'width 0.2s' }} />
                  </div>
                  <button className="btn btn-ghost" onClick={handleCancel} style={{ alignSelf: 'flex-start', gap: '6px', fontSize: '0.82rem' }}><XCircle size={14} /> Cancel</button>
                </div>
              )}

              {result && (
                <div style={{ padding: '14px 16px', borderRadius: 'var(--radius-md)', border: `1px solid ${result.success ? 'rgba(16,185,129,0.35)' : 'rgba(244,63,94,0.35)'}`, background: result.success ? 'rgba(16,185,129,0.12)' : 'rgba(244,63,94,0.12)', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>
                    {result.success ? `✓ Video created and opened${result.skippedSlides ? ` (${result.skippedSlides} slide${result.skippedSlides === 1 ? '' : 's'} skipped — could not be read)` : ''}.` : `Could not create the video: ${result.error}`}
                  </span>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    {result.success && result.outputPath && (
                      <>
                        <button className="btn btn-secondary" onClick={() => window.electronAPI?.openVideoFile?.(result.outputPath!)} style={{ fontSize: '0.8rem', gap: '6px' }}>
                          <ExternalLink size={14} /> Open Video
                        </button>
                        <button className="btn btn-secondary" onClick={() => window.electronAPI?.openItemInFolder?.(result.outputPath!)} style={{ fontSize: '0.8rem', gap: '6px' }}>
                          <FolderOpen size={14} /> Show in Folder
                        </button>
                      </>
                    )}
                    {!result.success && (
                      <button className="btn btn-secondary" onClick={() => setResult(null)} style={{ fontSize: '0.8rem', gap: '6px' }}>
                        <RotateCcw size={14} /> Try Again
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', padding: '16px 24px', borderTop: '1px solid var(--border-subtle)' }}>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button className="btn btn-ghost" onClick={() => setStep((s) => Math.max(1, s - 1))} disabled={step === 1 || isGenerating} style={{ gap: '6px' }}>
              <ChevronLeft size={16} /> Back
            </button>
            {step >= 2 && !!window.electronAPI?.previewVideo && (
              <button className="btn btn-secondary" data-testid="preview-button" onClick={runPreview} disabled={isGenerating || preview.status === 'rendering' || photoSlideCount === 0} style={{ gap: '6px' }}>
                <PlayCircle size={16} /> Preview
              </button>
            )}
          </div>
          {step < LAST_STEP ? (
            <button className="btn btn-primary" disabled={step === 2 && photoSlideCount === 0} onClick={() => setStep((s) => Math.min(LAST_STEP, s + 1))} style={{ gap: '6px' }}>
              Next <ChevronRight size={16} />
            </button>
          ) : (
            !result && (
              <button className="btn btn-primary" disabled={!outputPath || isGenerating || photoSlideCount === 0} onClick={handleGenerate} style={{ gap: '8px' }}>
                <PlayCircle size={16} /> {isGenerating ? 'Generating…' : 'Generate Video'}
              </button>
            )
          )}
        </div>
      </div>

      {preview.status !== 'idle' && (
        <div data-testid="video-preview" style={{ position: 'fixed', inset: 0, zIndex: 1100, backgroundColor: 'rgba(0,0,0,0.85)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' }} onClick={(e) => { if (e.target === e.currentTarget) closePreview(); }}>
          <div style={{ backgroundColor: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-xl)', padding: '16px', width: 'min(720px, 100%)', display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <strong>Preview (first ~20 s, draft quality)</strong>
              <button className="btn btn-ghost btn-icon" onClick={closePreview} aria-label="Close preview"><X size={18} /></button>
            </div>
            {preview.status === 'rendering' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '30px 0', alignItems: 'center' }}>
                <span style={{ fontSize: '0.85rem' }}>Making the preview… {preview.pct ?? 0}%</span>
                <div style={{ width: '60%', height: '6px', borderRadius: '3px', backgroundColor: 'var(--bg-surface-elevated)', overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${preview.pct ?? 0}%`, backgroundColor: '#ec4899' }} />
                </div>
              </div>
            )}
            {preview.status === 'ready' && preview.url && <video src={preview.url} controls autoPlay style={{ width: '100%', maxHeight: '60vh', backgroundColor: '#000', borderRadius: 'var(--radius-md)' }} />}
            {preview.status === 'error' && <div style={{ color: '#f87171', fontSize: '0.85rem', padding: '16px 0' }}>{preview.error}</div>}
          </div>
        </div>
      )}

      {showStylePicker && (
        <CollageStylePicker
          photos={pickedPhotos}
          aspectRatio={aspectRatio}
          onPick={confirmCollageGroup}
          onCancel={() => setShowStylePicker(false)}
        />
      )}
    </div>
  );
};
