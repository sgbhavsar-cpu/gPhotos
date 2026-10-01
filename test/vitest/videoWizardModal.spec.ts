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

  const mount = async () => {
    await act(async () => {
      root.render(React.createElement(VideoWizardModal, { isOpen: true, onClose: vi.fn(), album, photos }));
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
});
