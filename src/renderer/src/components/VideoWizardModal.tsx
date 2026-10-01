import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  X, Film, Check, Layers, PlayCircle, ChevronLeft, ChevronRight,
  FolderOpen, XCircle, RotateCcw, GripVertical, ChevronUp, ChevronDown, Ungroup, ExternalLink,
} from 'lucide-react';
import type { Album, Photo, VideoAspectRatio, VideoResolutionTier, VideoQuality, VideoTransition, VideoSlideInput, VideoCollageStyle } from '../../../types';
import { computeDimensions } from '../../../types/videoFormat';
import { defaultTitleDesign, defaultCreditsDesign, makeText, type SlideDesign } from '../../../types/slideDesign';
import { libraryStore, getLocalPhotoUrl } from '../services/libraryStore';
import { CollageStylePicker } from './CollageStylePicker';
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
  kind: 'photo' | 'collage';
  photoIds: string[];
  included: boolean;
  /** The chapter this slide's (first) photo lives in, so step 1 can show photos grouped under their chapter headings. null = not in any chapter. */
  chapterTitle: string | null;
  collageStyle?: VideoCollageStyle;
}

type TransitionMode = 'single' | 'random' | 'multiple';


const TRANSITIONS: Array<{ value: VideoTransition; label: string }> = [
  { value: 'none', label: 'None (hard cut)' },
  { value: 'fade', label: 'Fade' },
  { value: 'dissolve', label: 'Dissolve' },
  { value: 'wipeleft', label: 'Wipe left' },
  { value: 'wiperight', label: 'Wipe right' },
  { value: 'slideup', label: 'Slide up' },
  { value: 'slidedown', label: 'Slide down' },
  { value: 'circleopen', label: 'Circle open' },
];

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
const MAX_COLLAGE = 4;
// Random / multiple modes only pick real effects — a hard cut can't be mixed into one crossfade chain.
const REAL_TRANSITIONS = TRANSITIONS.filter((t) => t.value !== 'none').map((t) => t.value);

/** Slides in the album's own order: each chapter's photos in chapter order, then whatever is in no chapter. */
function buildInitialSlides(album: Album): SlideEntry[] {
  const titleOf = new Map<string, string>();
  for (const c of album.chapters || []) for (const id of c.photoIds) titleOf.set(id, c.title);
  const ordered = [...(album.chapters || []).flatMap((c) => c.photoIds), ...libraryStore.getUnchapteredPhotoIds(album)];
  const seen = new Set<string>();
  return ordered.filter((id) => (seen.has(id) ? false : (seen.add(id), true))).map((id) => ({
    id: `s_${id}`, kind: 'photo' as const, photoIds: [id], included: true, chapterTitle: titleOf.get(id) ?? null,
  }));
}

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

  useEffect(() => {
    if (!isOpen) return;
    setStep(1);
    setResult(null);
    setOutputPath(defaultOutputPath(album.title));
    setShowStylePicker(false);
    setSlides(buildInitialSlides(album));
    setPickingForCollage(new Set());
    setMusic(null);
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

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isGenerating) { e.stopImmediatePropagation(); onClose(); }
    };
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, [onClose, isGenerating]);

  if (!isOpen) return null;

  const includedSlides = slides.filter((s) => s.included);
  const photoSlideCount = includedSlides.length;
  const effectiveSecondsPerItem = durationMode === 'total' && photoSlideCount > 0 ? Math.max(0.5, totalDurationInput / photoSlideCount) : secondsPerItem;
  const totalCount = photoSlideCount + (includeTitle ? 1 : 0) + (includeCredits ? 1 : 0);
  const cardSeconds = (includeTitle ? titleDesign.seconds : 0) + (includeCredits ? creditsDesign.seconds : 0);
  const hasRealTransition = transitionMode !== 'single' || transition !== 'none';
  const useTransition = hasRealTransition && transitionDurationSec > 0 && totalCount > 1;
  const estimatedTotalDurationSec = Math.max(0, photoSlideCount * effectiveSecondsPerItem + cardSeconds - (useTransition ? transitionDurationSec * (totalCount - 1) : 0));
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

  const toggleIncluded = (entryId: string) => setSlides((prev) => prev.map((s) => (s.id === entryId ? { ...s, included: !s.included } : s)));

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
    for (const s of includedSlides) {
      if (s.kind === 'collage') videoSlides.push({ kind: 'collage', collageStyle: s.collageStyle || 'grid', photoPaths: s.photoIds.map((id) => photoMap.get(id)?.filePath).filter((p): p is string => !!p) });
      else {
        const p = photoMap.get(s.photoIds[0]);
        videoSlides.push({ kind: 'photo', photoPaths: p ? [p.filePath] : [] });
      }
    }

    if (creditsCard) videoSlides.push(creditsCard);

    // One effect for every cut, or (random / multiple) an independently random pick per cut from
    // either every real effect or just the ones ticked. Decided once here so the export is repeatable.
    const cuts = Math.max(0, videoSlides.length - 1);
    const pool: VideoTransition[] = transitionMode === 'multiple' && multiPool.size > 0 ? Array.from(multiPool) : REAL_TRANSITIONS;
    const transitionSpec: VideoTransition | VideoTransition[] =
      transitionMode === 'single' ? transition : Array.from({ length: cuts }, () => pool[Math.floor(Math.random() * pool.length)]);

    try {
      const res = await api.exportVideo({
        slides: videoSlides, aspectRatio, resolution, quality, transition: transitionSpec, transitionDurationSec,
        secondsPerItem: effectiveSecondsPerItem, outputPath,
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

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '20px 24px' }}>
          {step === 1 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                Select 2-4 photos and click <strong>"Group as Collage"</strong> to combine them into one frame. Everything not grouped stays its own slide — you'll choose the order (and can leave any out) in the next step.
              </p>
              {pickingForCollage.size > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 12px', borderRadius: 'var(--radius-md)', background: 'rgba(236, 72, 153, 0.12)', border: '1px solid rgba(236, 72, 153, 0.35)' }}>
                  <span style={{ fontSize: '0.82rem', flex: 1 }}>{pickingForCollage.size} photo{pickingForCollage.size === 1 ? '' : 's'} selected (2-4)</span>
                  <button className="btn btn-secondary" disabled={pickingForCollage.size < 2} onClick={() => setShowStylePicker(true)} style={{ fontSize: '0.78rem', padding: '5px 12px' }}>Group as Collage</button>
                  <button className="btn btn-ghost" onClick={() => setPickingForCollage(new Set())} style={{ fontSize: '0.78rem', padding: '5px 12px' }}>Clear</button>
                </div>
              )}
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
                      onClick={() => togglePicking(entry.id)}
                      style={{ position: 'relative', aspectRatio: '1', borderRadius: 'var(--radius-md)', overflow: 'hidden', cursor: 'pointer', border: isPicking ? '2px solid #ec4899' : '1px solid var(--border-subtle)' }}
                    >
                      <img src={getLocalPhotoUrl(photo.filePath, photo.originalRemotePath, false, 160)} alt={photo.fileName} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
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
              {slides.map((entry, idx) => {
                const photo = entry.kind === 'photo' ? thumbFor(entry) : null;
                const collageThumb = entry.kind === 'collage' ? thumbFor(entry) : null;
                return (
                  <div
                    key={entry.id}
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
                    <span style={{ flex: 1, fontSize: '0.85rem' }}>
                      {entry.kind === 'collage' ? <><Layers size={13} style={{ verticalAlign: 'middle', marginRight: '4px' }} />Collage of {entry.photoIds.length}</> : (photo?.fileName || 'Photo')}
                    </span>
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
                  {photoSlideCount} slide{photoSlideCount === 1 ? '' : 's'} (~{effectiveSecondsPerItem.toFixed(1)}s each) → estimated total length: <strong>{estimatedTotalDurationSec.toFixed(1)}s</strong>
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

          {step === 4 && <MusicStep music={music} onChange={setMusic} videoLengthSec={estimatedTotalDurationSec} />}

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
          <button className="btn btn-ghost" onClick={() => setStep((s) => Math.max(1, s - 1))} disabled={step === 1 || isGenerating} style={{ gap: '6px' }}>
            <ChevronLeft size={16} /> Back
          </button>
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
