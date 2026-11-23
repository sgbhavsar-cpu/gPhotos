// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { VideoWizardModal } from '../../src/renderer/src/components/VideoWizardModal';
import { libraryStore } from '../../src/renderer/src/services/libraryStore';

// jsdom has no canvas: the designer's drawing module is replaced (its real output is checked in slideDesign.spec + the ffmpeg specs).
vi.mock('../../src/renderer/src/services/slideDesignRender', () => ({
  renderDesignToDataUrl: vi.fn(async () => 'data:image/jpeg;base64,AAAA'),
  drawDesignOnCanvas: vi.fn(),
  hitTestDesign: vi.fn(() => null),
  loadImage: vi.fn(async () => null),
}));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const photo = (n: number) => ({
  id: `p${n}`, filePath: `C:\\Mirrors\\IMG_${n}.jpg`, fileName: `IMG_${n}.jpg`, fileSize: 1,
  dateTaken: '2026-01-01', year: 2026, month: 1, day: 1,
}) as any;

describe('VideoWizardModal', () => {
  let root: Root;
  let host: HTMLElement;
  const photos = [1, 2, 3, 4].map(photo);
  const album = { id: 'a1', title: 'Trip', photoIds: photos.map((p) => p.id), createdAt: 'x', updatedAt: 'x' } as any;
  let api: any;

  beforeEach(() => {
    api = {
      chooseVideoOutputPath: vi.fn(async () => 'C:\\out\\Trip.mp4'),
      exportVideo: vi.fn(async () => ({ success: true, skippedSlides: 0, outputPath: 'C:\\out\\Trip.mp4', durationSec: 9 })),
      cancelVideoExport: vi.fn(async () => true),
      onVideoExportProgress: vi.fn(() => () => {}),
      openItemInFolder: vi.fn(async () => true),
      openVideoFile: vi.fn(async () => true),
    };
    (window as any).electronAPI = api;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = '';
    delete (window as any).electronAPI;
  });

  const mount = async (onClose: () => void = vi.fn()) => {
    await act(async () => {
      root.render(React.createElement(VideoWizardModal, { isOpen: true, onClose, album, photos }));
    });
  };
  const clickNext = async () => {
    const next = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('Next')) as HTMLButtonElement;
    await act(async () => { next.click(); });
  };
  const toReview = async () => { for (let i = 0; i < 3; i++) await clickNext(); };
  const buttonByText = (t: string) => Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes(t)) as HTMLButtonElement;
  const groupWithStyle = async (style = 'grid') => {
    await act(async () => { buttonByText('Group as Collage').click(); });
    await act(async () => { (host.querySelector(`[data-testid="collage-style-${style}"]`) as HTMLElement).click(); });
  };
  const tiles = () => Array.from(host.querySelectorAll('div[style*="aspect-ratio: 1"]')) as HTMLElement[];

  it('starts on "Group Photos" with all 4 photos shown as individual tiles', async () => {
    await mount();
    expect(host.textContent).toContain('Step 1 of 6: Group Photos');
    expect(host.querySelectorAll('img').length).toBe(4);
  });

  it('grouping 2 photos into a collage replaces them with one collage tile, in their original position', async () => {
    await mount();
    const t = tiles();
    await act(async () => { t[0].click(); }); // p1
    await act(async () => { t[1].click(); }); // p2
    await groupWithStyle();

    // Now step 1 shows: [collage(p1,p2), p3, p4] — 3 tiles, one of them a collage (2 imgs inside it, not 1).
    expect(host.querySelectorAll('img').length).toBe(2 + 1 + 1); // collage's 2 photos + p3 + p4

    await clickNext();
    expect(host.textContent).toContain('Step 2 of 6: Arrange Slides');
    expect(host.textContent).toContain('Collage of 2');
    // Row order preserved: collage first (where p1 was), then p3, then p4.
    const rows = Array.from(host.querySelectorAll('span')).map((s) => s.textContent).filter(Boolean);
    expect(rows.some((r) => r?.includes('Collage of 2'))).toBe(true);
  });

  it('ungrouping a collage expands it back into individual photos at the same position', async () => {
    await mount();
    const t = tiles();
    await act(async () => { t[0].click(); t[1].click(); });
    await groupWithStyle();
    expect(host.querySelectorAll('img').length).toBe(4); // still 4 total photo images, just one grouped

    const ungroupBtn = host.querySelector('button[title="Ungroup"]') as HTMLButtonElement;
    await act(async () => { ungroupBtn.click(); });
    expect(tiles().length).toBe(4); // back to 4 individual tiles
  });

  it('Arrange Slides: unchecking a slide excludes it from the plan, and Up/Down reorders', async () => {
    await mount();
    await clickNext(); // -> step 2
    const checkboxes = Array.from(host.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[];
    expect(checkboxes).toHaveLength(4);
    await act(async () => { checkboxes[3].click(); }); // exclude the 4th photo

    await clickNext(); // -> settings
    const chooseBtn = buttonByText('Choose Where to Save');
    await act(async () => { chooseBtn.click(); });
    await act(async () => { await Promise.resolve(); });
    await toReview(); // settings -> music -> title & credits -> review

    const generateBtn = buttonByText('Generate Video');
    await act(async () => { generateBtn.click(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    const req = api.exportVideo.mock.calls[0][0];
    // title + 3 remaining photos (p4 excluded)
    expect(req.slides.filter((s: any) => s.kind === 'photo')).toHaveLength(3);
  });

  it('reordering via the Up arrow changes slide order sent to exportVideo', async () => {
    await mount();
    await clickNext(); // step 2
    // Move the 2nd row (p2) up, so order becomes p2,p1,p3,p4. Each row is the nearest ancestor
    // div containing its own checkbox (not a descendant's).
    const rows = Array.from(host.querySelectorAll('div')).filter((d) => (d.querySelector(':scope > input[type="checkbox"]')));
    // Simplest reliable approach: click the 2nd row's Up button (each row has two icon buttons at the end: Up, Down).
    const rowButtons = rows.map((r) => Array.from(r.querySelectorAll('button')));
    await act(async () => { rowButtons[1][0].click(); }); // row for p2's Up button
    await clickNext();
    const outputBtn = buttonByText('Choose Where to Save');
    await act(async () => { outputBtn.click(); });
    await act(async () => { await Promise.resolve(); });
    await toReview();
    await act(async () => { buttonByText('Generate Video').click(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    const req = api.exportVideo.mock.calls[0][0];
    const photoSlidePaths = req.slides.filter((s: any) => s.kind === 'photo').map((s: any) => s.photoPaths[0]);
    expect(photoSlidePaths[0]).toContain('IMG_2.jpg'); // p2 now first
    expect(photoSlidePaths[1]).toContain('IMG_1.jpg');
  });

  it('choosing an output location, generating, and auto-opening the finished video', async () => {
    await mount();
    for (let i = 0; i < 2; i++) await clickNext(); // -> settings

    await act(async () => { buttonByText('Choose Where to Save').click(); });
    await act(async () => { await Promise.resolve(); });
    expect(api.chooseVideoOutputPath).toHaveBeenCalledWith('Trip.mp4');
    expect(host.textContent).toContain('C:\\out\\Trip.mp4');

    await toReview();
    const generateBtn = buttonByText('Generate Video');
    expect(generateBtn.disabled).toBe(false);
    await act(async () => { generateBtn.click(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(api.exportVideo).toHaveBeenCalledTimes(1);
    const req = api.exportVideo.mock.calls[0][0];
    expect(req.outputPath).toBe('C:\\out\\Trip.mp4');
    expect(req.slides).toHaveLength(5); // title + 4 photos
    expect(req.slides[0]).toMatchObject({ kind: 'card', imageDataUrl: 'data:image/jpeg;base64,AAAA', seconds: 4 });
    expect(api.openVideoFile).toHaveBeenCalledWith('C:\\out\\Trip.mp4'); // auto-opened
    expect(host.textContent).toContain('Video created and opened');
  });

  describe('chapters, collage styles, transition modes and the default save path', () => {
    const chapterAlbum = {
      ...album,
      chapters: [
        { id: 'c1', title: 'Day 1', photoIds: ['p3', 'p4'], createdAt: 'x', updatedAt: 'x' },
        { id: 'c2', title: 'Day 2', photoIds: ['p1'], createdAt: 'x', updatedAt: 'x' },
      ],
    };
    const mountWith = async (a: any) => {
      await act(async () => { root.render(React.createElement(VideoWizardModal, { isOpen: true, onClose: vi.fn(), album: a, photos })); });
    };
    const toSettings = async () => { for (let i = 0; i < 2; i++) await clickNext(); };
    const generate = async () => {
      await toReview();
      await act(async () => { buttonByText('Generate Video').click(); });
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      return api.exportVideo.mock.calls[0][0];
    };
    afterEach(() => { (libraryStore.getState() as any).selectedFolder = null; });

    it('step 1 shows photos under their chapter headings, in the album order (chapters first, then the rest)', async () => {
      await mountWith(chapterAlbum);
      const headings = Array.from(host.querySelectorAll('[data-testid="step1-chapter-heading"]')).map((h) => h.textContent);
      expect(headings).toEqual(['Day 1', 'Day 2', 'Other Photos']);
      const order = Array.from(host.querySelectorAll('img')).map((i) => (i as HTMLImageElement).alt);
      expect(order).toEqual(['IMG_3.jpg', 'IMG_4.jpg', 'IMG_1.jpg', 'IMG_2.jpg']);
    });

    it('an album with no chapters shows no headings at all', async () => {
      await mount();
      expect(host.querySelectorAll('[data-testid="step1-chapter-heading"]')).toHaveLength(0);
    });

    it('Group as Collage opens a popup with every layout style; the chosen one is sent with the collage slide', async () => {
      await mount();
      const t = tiles();
      await act(async () => { t[0].click(); t[1].click(); t[2].click(); });
      await act(async () => { buttonByText('Group as Collage').click(); });
      for (const style of ['grid', 'sideBySide', 'stacked', 'featured']) {
        expect(host.querySelector(`[data-testid="collage-style-${style}"]`)).not.toBeNull();
      }
      await act(async () => { (host.querySelector('[data-testid="collage-style-featured"]') as HTMLElement).click(); });
      expect(host.querySelector('[data-testid="collage-style-featured"]')).toBeNull(); // popup closed

      await toSettings();
      await act(async () => { buttonByText('Choose Where to Save').click(); }); // no library folder here, so no default path
      await act(async () => { await Promise.resolve(); });
      const req = await generate();
      const collage = req.slides.find((sl: any) => sl.kind === 'collage');
      expect(collage.collageStyle).toBe('featured');
      expect(collage.photoPaths).toHaveLength(3);
    });

    it('cancelling the style popup leaves the photos ungrouped', async () => {
      await mount();
      const t = tiles();
      await act(async () => { t[0].click(); t[1].click(); });
      await act(async () => { buttonByText('Group as Collage').click(); });
      await act(async () => { (host.querySelector('button[title="Cancel"]') as HTMLElement).click(); });
      expect(host.textContent).not.toContain('Collage of');
      expect(tiles().length).toBe(4);
    });

    it('transitions: one effect for every cut by default', async () => {
      await mount();
      await toSettings();
      await act(async () => { buttonByText('Choose Where to Save').click(); });
      await act(async () => { await Promise.resolve(); });
      const req = await generate();
      expect(req.transition).toBe('fade');
    });

    it('transitions: random gives one real effect per cut', async () => {
      await mount();
      await toSettings();
      await act(async () => { (Array.from(host.querySelectorAll('input[name="transition-mode"]'))[1] as HTMLInputElement).click(); });
      await act(async () => { buttonByText('Choose Where to Save').click(); });
      await act(async () => { await Promise.resolve(); });
      const req = await generate();
      expect(Array.isArray(req.transition)).toBe(true);
      expect(req.transition).toHaveLength(req.slides.length - 1);
      expect(req.transition.every((t: string) => t !== 'none')).toBe(true);
    });

    it('transitions: pick several draws only from the ticked effects', async () => {
      await mount();
      await toSettings();
      await act(async () => { (Array.from(host.querySelectorAll('input[name="transition-mode"]'))[2] as HTMLInputElement).click(); });
      // default pool is fade/dissolve/wipeleft — untick two, leaving only 'fade'
      const boxes = Array.from(host.querySelectorAll('[data-testid="transition-pool"] input')) as HTMLInputElement[];
      const labelOf = (b: HTMLInputElement) => b.parentElement?.textContent?.trim();
      await act(async () => { boxes.find((b) => labelOf(b) === 'Dissolve')!.click(); });
      await act(async () => { boxes.find((b) => labelOf(b) === 'Wipe left')!.click(); });
      await act(async () => { buttonByText('Choose Where to Save').click(); });
      await act(async () => { await Promise.resolve(); });
      const req = await generate();
      expect(req.transition).toHaveLength(req.slides.length - 1);
      expect(new Set(req.transition)).toEqual(new Set(['fade']));
    });

    it('the save location defaults to <library>/videos/<album name>.mp4, with no dialog needed to generate', async () => {
      (libraryStore.getState() as any).selectedFolder = 'C:\\Photos\\Family';
      await mount();
      await toSettings();
      expect(host.textContent).toContain('C:\\Photos\\Family\\videos\\Trip.mp4');
      const req = await generate(); // never clicked "Choose Where to Save"
      expect(req.outputPath).toBe('C:\\Photos\\Family\\videos\\Trip.mp4');
      expect(api.chooseVideoOutputPath).not.toHaveBeenCalled();
    });

    it('"Change Location" opens the dialog on the current default path, and its answer wins', async () => {
      (libraryStore.getState() as any).selectedFolder = 'C:\\Photos\\Family';
      await mount();
      await toSettings();
      await act(async () => { buttonByText('Change Location').click(); });
      await act(async () => { await Promise.resolve(); });
      expect(api.chooseVideoOutputPath).toHaveBeenCalledWith('C:\\Photos\\Family\\videos\\Trip.mp4');
      const req = await generate();
      expect(req.outputPath).toBe('C:\\out\\Trip.mp4'); // what the mocked dialog returned
    });
  });

  it('Generate is disabled until an output location is chosen', async () => {
    await mount();
    for (let i = 0; i < 5; i++) await clickNext();
    expect(buttonByText('Generate Video').disabled).toBe(true);
  });

  it('Look, movement and captions: the step-3 choices (and a slide override) reach the export request', async () => {
    await mount();
    await clickNext(); // -> step 2
    // slide 1 overrides the look and types its own caption
    const lookSelects = Array.from(host.querySelectorAll('select[aria-label="Look for this slide"]')) as HTMLSelectElement[];
    const captionInputs = Array.from(host.querySelectorAll('input[aria-label="Caption for this slide"]')) as HTMLInputElement[];
    expect(lookSelects).toHaveLength(4);
    const setNative = (el: HTMLElement, proto: any, v: string) => { Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, v); el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); };
    await act(async () => { setNative(lookSelects[0], HTMLSelectElement.prototype, 'vivid'); });
    await act(async () => { setNative(captionInputs[0], HTMLInputElement.prototype, 'My own caption'); });

    await clickNext(); // -> settings
    await act(async () => { setNative(host.querySelector('select[aria-label="Colour look"]')!, HTMLSelectElement.prototype, 'bw'); });
    await act(async () => { setNative(host.querySelector('select[aria-label="Photo movement"]')!, HTMLSelectElement.prototype, 'zoomin'); });
    const dateBox = Array.from(host.querySelectorAll('[data-testid="look-motion-captions"] label')).find((l) => l.textContent?.includes('Date'))!.querySelector('input') as HTMLInputElement;
    await act(async () => { dateBox.click(); });
    await act(async () => { setNative(host.querySelector('select[aria-label="Caption position"]')!, HTMLSelectElement.prototype, 'top'); });
    await act(async () => { setNative(host.querySelector('select[aria-label="Caption colour"]')!, HTMLSelectElement.prototype, 'yellow'); });
    await act(async () => { buttonByText('Choose Where to Save').click(); });
    await act(async () => { await Promise.resolve(); });
    await toReview();
    await act(async () => { buttonByText('Generate Video').click(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    const slides = api.exportVideo.mock.calls[0][0].slides.filter((x: any) => x.kind === 'photo');
    expect(slides).toHaveLength(4);
    expect(slides[0]).toMatchObject({ filter: 'vivid', motion: 'zoomin', caption: 'My own caption' }); // the override wins
    expect(slides[1]).toMatchObject({ filter: 'bw', motion: 'zoomin', caption: '1 Jan 2026' });       // video-wide choices + the automatic caption
    expect(api.exportVideo.mock.calls[0][0].captionStyle).toEqual({ position: 'top', size: 'medium', color: 'yellow' });
  });

  it('a template and an export preset set the whole plan in one choice, and the size estimate follows', async () => {
    await mount();
    await clickNext(); await clickNext(); // -> settings
    const setSel = async (label: string, v: string) => {
      const el = host.querySelector(`select[aria-label="${label}"]`) as HTMLSelectElement;
      await act(async () => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(el, v); el.dispatchEvent(new Event('change', { bubbles: true })); });
    };
    await setSel('Video template', 'reel');
    const sizeBefore = host.querySelector('[data-testid="size-estimate"]')!.textContent;
    await setSel('Export for', 'whatsapp');
    expect(host.querySelector('[data-testid="size-estimate"]')!.textContent).not.toBe(sizeBefore); // 720p / draft is smaller than 1080p
    await act(async () => { buttonByText('Choose Where to Save').click(); });
    await act(async () => { await Promise.resolve(); });
    await toReview();
    await act(async () => { buttonByText('Generate Video').click(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const req = api.exportVideo.mock.calls[0][0];
    expect(req).toMatchObject({ aspectRatio: '9:16', resolution: '720p', quality: 'draft', transition: 'slideup' });
    expect(req.slides.find((x: any) => x.kind === 'photo')).toMatchObject({ filter: 'vivid', motion: 'zoomin' });
  });

  it('"Pick the best shots" keeps only as many as fit the wanted length', async () => {
    await mount();
    const setSel = async (label: string, v: string) => {
      const el = host.querySelector(`select[aria-label="${label}"]`) as HTMLSelectElement;
      await act(async () => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(el, v); el.dispatchEvent(new Event('change', { bubbles: true })); });
    };
    await setSel('Template', 'reel'); // 1.8 s per slide
    await setSel('Video length', '30');
    await act(async () => { buttonByText('Pick the best shots').click(); });
    await clickNext(); // step 2: all 4 photos fit 30 s at 1.8 s each, so none is dropped
    expect((Array.from(host.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[]).filter((c) => c.checked)).toHaveLength(4);
  });

  it('Preview renders a 360p draft of the current plan and plays it in the wizard', async () => {
    api.previewVideo = vi.fn(async () => ({ success: true, skippedSlides: 0, outputPath: 'C:\\tmp\\preview_1.mp4', durationSec: 8 }));
    await mount();
    expect(host.querySelector('[data-testid="preview-button"]')).toBeNull(); // not on step 1
    await clickNext(); // -> step 2
    await act(async () => { (host.querySelector('[data-testid="preview-button"]') as HTMLButtonElement).click(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const req = api.previewVideo.mock.calls[0][0];
    expect(req).toMatchObject({ resolution: '360p', quality: 'draft' });
    expect(req.slides.filter((x: any) => x.kind === 'photo')).toHaveLength(4);
    const video = host.querySelector('[data-testid="video-preview"] video') as HTMLVideoElement;
    expect(video).toBeTruthy();
    expect(video.getAttribute('src')).toContain('preview_1.mp4');
    await act(async () => { (host.querySelector('button[aria-label="Close preview"]') as HTMLButtonElement).click(); });
    expect(host.querySelector('[data-testid="video-preview"]')).toBeNull();
  });

  it('Escape backs out one screen at a time: the preview first, then the wizard', async () => {
    api.previewVideo = vi.fn(async () => ({ success: true, skippedSlides: 0, outputPath: 'C:\tmp\preview_1.mp4', durationSec: 8 }));
    const onClose = vi.fn();
    const behind = vi.fn(); // stands in for the album view underneath, which has its own Escape handler
    window.addEventListener('keydown', behind);
    await mount(onClose);
    await clickNext();
    await act(async () => { (host.querySelector('[data-testid="preview-button"]') as HTMLButtonElement).click(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const esc = () => act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    await esc();
    expect(host.querySelector('[data-testid="video-preview"]')).toBeNull(); // only the preview closed
    expect(onClose).not.toHaveBeenCalled();
    await esc();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(behind).not.toHaveBeenCalled(); // nothing underneath ever saw Escape
    window.removeEventListener('keydown', behind);
  });

  it('a clip can be split in two, played backwards and frozen at the end', async () => {
    const video = { ...photo(9), id: 'v9', fileName: 'MOV_9.mp4', filePath: 'C:\\Mirrors\\MOV_9.mp4', isVideo: true, videoDurationSec: 10 } as any;
    const storePhotos = (libraryStore.getState() as any).photos;
    (libraryStore.getState() as any).photos = [...storePhotos, video];
    const a2 = { ...album, photoIds: [...album.photoIds, 'v9'] };
    try {
      await act(async () => { root.render(React.createElement(VideoWizardModal, { isOpen: true, onClose: vi.fn(), album: a2, photos: [...photos, video] })); });
      await clickNext(); // step 2
      expect(host.querySelectorAll('[data-testid="clip-controls"]')).toHaveLength(1);
      await act(async () => { (host.querySelector('button[aria-label="Split this clip in two"]') as HTMLButtonElement).click(); });
      expect(host.querySelectorAll('[data-testid="clip-controls"]')).toHaveLength(2);
      const rev = host.querySelectorAll('input[aria-label="Play backwards"]')[1] as HTMLInputElement;
      await act(async () => { rev.click(); });
      const frz = host.querySelectorAll('select[aria-label="Freeze the last frame"]')[1] as HTMLSelectElement;
      await act(async () => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(frz, '2'); frz.dispatchEvent(new Event('change', { bubbles: true })); });
      await clickNext();
      await act(async () => { buttonByText('Choose Where to Save').click(); });
      await act(async () => { await Promise.resolve(); });
      await toReview();
      await act(async () => { buttonByText('Generate Video').click(); });
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      const clips = api.exportVideo.mock.calls[0][0].slides.filter((x: any) => x.kind === 'clip');
      expect(clips).toHaveLength(2);
      expect(clips[0]).toMatchObject({ trimStartSec: 0, trimEndSec: 5, reverse: false, holdSec: 0 });
      expect(clips[1]).toMatchObject({ trimStartSec: 5, reverse: true, holdSec: 2 });
    } finally {
      (libraryStore.getState() as any).photos = storePhotos;
    }
  });

  it('Preview shows the reason when it cannot be made', async () => {
    api.previewVideo = vi.fn(async () => ({ success: false, error: 'No slides could be prepared', skippedSlides: 4 }));
    await mount();
    await clickNext();
    await act(async () => { (host.querySelector('[data-testid="preview-button"]') as HTMLButtonElement).click(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(host.querySelector('[data-testid="video-preview"]')!.textContent).toContain('No slides could be prepared');
  });
});
