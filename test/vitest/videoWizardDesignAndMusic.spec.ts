// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { VideoWizardModal } from '../../src/renderer/src/components/VideoWizardModal';
import { parseTime, formatTime } from '../../src/renderer/src/components/MusicStep';
import * as render from '../../src/renderer/src/services/slideDesignRender';

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

describe('parseTime / formatTime', () => {
  it('reads m:ss, h:mm:ss, plain seconds and decimals; blank is null; junk is NaN', () => {
    expect(parseTime('1:05')).toBe(65);
    expect(parseTime('65')).toBe(65);
    expect(parseTime('1:02:03')).toBe(3723);
    expect(parseTime('0:12.5')).toBe(12.5);
    expect(parseTime('  ')).toBeNull();
    expect(parseTime('abc')).toBeNaN();
    expect(parseTime('1:2:3:4')).toBeNaN();
    expect(parseTime('-5')).toBeNaN();
  });
  it('formats seconds as m:ss (with a tenth when needed)', () => {
    expect(formatTime(65)).toBe('1:05');
    expect(formatTime(0)).toBe('0:00');
    expect(formatTime(12.5)).toBe('0:12.5');
  });
});

describe('VideoWizardModal — music, title screen and end credits', () => {
  let root: Root;
  let host: HTMLElement;
  const photos = [1, 2, 3, 4].map(photo);
  const album = { id: 'a1', title: 'Trip', photoIds: photos.map((p) => p.id), createdAt: 'x', updatedAt: 'x' } as any;
  let api: any;
  const tone = { filePath: 'C:\\Music\\song.mp3', name: 'song.mp3', durationSec: 200 };

  beforeEach(() => {
    vi.mocked(render.renderDesignToDataUrl).mockClear();
    api = {
      chooseVideoOutputPath: vi.fn(async () => 'C:\\out\\Trip.mp4'),
      exportVideo: vi.fn(async () => ({ success: true, skippedSlides: 0, outputPath: 'C:\\out\\Trip.mp4', durationSec: 9 })),
      cancelVideoExport: vi.fn(async () => true),
      onVideoExportProgress: vi.fn(() => () => {}),
      openItemInFolder: vi.fn(async () => true),
      openVideoFile: vi.fn(async () => true),
      chooseAudioFile: vi.fn(async () => tone),
      getAudioPreview: vi.fn(async () => 'data:audio/mpeg;base64,QUJD'),
      getYtDlpStatus: vi.fn(async () => ({ installed: false })),
      installYtDlp: vi.fn(async () => ({ ok: true, version: '2026.01.01' })),
      downloadYouTubeAudio: vi.fn(async () => ({ ok: true, file: { filePath: 'C:\\dl\\yt.mp3', name: 'yt.mp3', durationSec: 90 } })),
      cancelYouTubeDownload: vi.fn(async () => true),
      onAudioFetchProgress: vi.fn(() => () => {}),
      getMusicLibraryCached: vi.fn(async () => ['easy-lemon']),
      fetchMusicTrack: vi.fn(async (id: string) => ({ ok: true, file: { filePath: 'C:\\Lib\\' + id + '.mp3', name: id + '.mp3', durationSec: 200 } })),
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

  const mount = async () => { await act(async () => { root.render(React.createElement(VideoWizardModal, { isOpen: true, onClose: vi.fn(), album, photos })); }); };
  const btn = (t: string) => Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes(t)) as HTMLButtonElement;
  const next = async (n = 1) => { for (let i = 0; i < n; i++) await act(async () => { btn('Next').click(); }); };
  const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };
  const setValue = async (el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
    await act(async () => { setter.call(el, value); el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })); });
  };
  const byLabel = <T extends HTMLElement>(label: string) => host.querySelector(`[aria-label="${label}"]`) as T;
  /** Mounts, picks the save location in settings, and lands on the Music step (4). */
  const toMusicStep = async () => {
    await mount();
    await next(2);
    await act(async () => { btn('Choose Where to Save').click(); });
    await flush();
    await next();
  };
  const toDesignStep = async () => { await toMusicStep(); await next(); };
  const clickGenerate = async () => { await act(async () => { btn('Generate Video').click(); }); await flush(); return api.exportVideo.mock.calls[0]?.[0]; };

  it('has a Music step and a Title & Credits step between settings and review', async () => {
    await mount();
    await next(3);
    expect(host.textContent).toContain('Step 4 of 6: Music');
    await next();
    expect(host.textContent).toContain('Step 5 of 6: Title & Credits');
    await next();
    expect(host.textContent).toContain('Step 6 of 6: Review & Generate');
  });

  describe('Music', () => {
    // the Music step opens on the built-in library; these tests are about the file / YouTube tabs
    const toMusic = async () => { await toMusicStep(); await act(async () => { btn('From this computer').click(); }); };

    it('is optional: with nothing chosen the export has no audio', async () => {
      await toMusic();
      await next(2);
      const req = await clickGenerate();
      expect(req.audio).toBeUndefined();
    });

    it('choosing a file shows it, defaults to repeat-to-fill, and explains how often it repeats', async () => {
      await toMusic();
      await act(async () => { btn('Choose an audio file').click(); });
      await flush();
      expect(host.querySelector('[data-testid="music-name"]')!.textContent).toBe('song.mp3');
      expect((host.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(true);
      // the 200s song is longer than the ~13.6s video, so no repeating is needed
      expect(host.querySelector('[data-testid="music-summary"]')!.textContent).toMatch(/long enough/);
    });

    it('a short clip section repeats to cover the video, and the summary says how many times', async () => {
      await toMusic();
      await act(async () => { btn('Choose an audio file').click(); });
      await flush();
      const start = byLabel<HTMLInputElement>('Start at');
      const end = byLabel<HTMLInputElement>('End at');
      await setValue(start, '1:00');
      await act(async () => { start.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
      await setValue(end, '1:05');
      await act(async () => { end.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
      expect(host.querySelector('[data-testid="music-summary"]')!.textContent).toMatch(/Using 0:05 .*plays 3 times/); // ceil(13.6 / 5)
    });

    it('the start/end, repeat, fade and volume choices are sent with the export', async () => {
      await toMusic();
      await act(async () => { btn('Choose an audio file').click(); });
      await flush();
      const start = byLabel<HTMLInputElement>('Start at');
      await setValue(start, '0:30');
      await act(async () => { start.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
      const end = byLabel<HTMLInputElement>('End at');
      await setValue(end, '1:00');
      await act(async () => { end.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
      await act(async () => { (host.querySelector('input[type="checkbox"]') as HTMLInputElement).click(); }); // repeat off
      await setValue(byLabel<HTMLInputElement>('Fade out seconds'), '3');
      await next(2); // title & credits, review
      const req = await clickGenerate();
      expect(req.audio).toEqual({ filePath: tone.filePath, startSec: 30, endSec: 60, loop: false, fadeOutSec: 3, volume: 1 });
    });

    it('an invalid time is rejected and the old value is kept', async () => {
      await toMusic();
      await act(async () => { btn('Choose an audio file').click(); });
      await flush();
      const start = byLabel<HTMLInputElement>('Start at');
      await setValue(start, '0:20');
      await act(async () => { start.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
      await setValue(start, 'banana');
      await act(async () => { start.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
      expect(start.value).toBe('0:20');
    });

    it('Preview asks the main process for just the chosen section and plays it', async () => {
      await toMusic();
      await act(async () => { btn('Choose an audio file').click(); });
      await flush();
      await act(async () => { btn('Preview this section').click(); });
      await flush();
      expect(api.getAudioPreview).toHaveBeenCalledWith('C:\\Music\\song.mp3', 0, null);
      expect((host.querySelector('[data-testid="music-preview"]') as HTMLAudioElement).getAttribute('src')).toBe('data:audio/mpeg;base64,QUJD');
    });

    it('a file with no readable audio is refused with a message', async () => {
      api.chooseAudioFile = vi.fn(async () => ({ filePath: 'C:\\x\\notes.txt', name: 'notes.txt', durationSec: null }));
      await toMusic();
      await act(async () => { btn('Choose an audio file').click(); });
      await flush();
      expect(host.querySelector('[role="alert"]')!.textContent).toMatch(/no audio/i);
      expect(host.querySelector('[data-testid="music-name"]')).toBeNull();
    });

    it('YouTube: offers to install yt-dlp first; once installed, a pasted link downloads and becomes the music', async () => {
      await toMusic();
      await act(async () => { btn('From YouTube').click(); });
      await flush();
      expect(host.textContent).toContain('yt-dlp');
      api.getYtDlpStatus = vi.fn(async () => ({ installed: true, source: 'managed', version: '2026.01.01' }));
      await act(async () => { btn('Install yt-dlp').click(); });
      await flush();
      expect(api.installYtDlp).toHaveBeenCalled();

      await setValue(byLabel<HTMLInputElement>('YouTube link'), 'https://youtu.be/abc');
      await act(async () => { btn('Download audio').click(); });
      await flush();
      expect(api.downloadYouTubeAudio).toHaveBeenCalledWith('https://youtu.be/abc');
      expect(host.querySelector('[data-testid="music-name"]')!.textContent).toBe('yt.mp3');
    });

    it('YouTube: a failed download shows the reason and keeps no music', async () => {
      api.getYtDlpStatus = vi.fn(async () => ({ installed: true, source: 'system', version: '1' }));
      api.downloadYouTubeAudio = vi.fn(async () => ({ ok: false, error: 'That video is private.' }));
      await toMusic();
      await act(async () => { btn('From YouTube').click(); });
      await flush();
      await setValue(byLabel<HTMLInputElement>('YouTube link'), 'https://youtu.be/abc');
      await act(async () => { btn('Download audio').click(); });
      await flush();
      expect(host.querySelector('[role="alert"]')!.textContent).toBe('That video is private.');
      expect(host.querySelector('[data-testid="music-name"]')).toBeNull();
    });

    it('Remove drops the music again', async () => {
      await toMusic();
      await act(async () => { btn('Choose an audio file').click(); });
      await flush();
      await act(async () => { btn('Remove').click(); });
      expect(host.querySelector('[data-testid="music-name"]')).toBeNull();
    });
  });

  describe('Free music library', () => {
    const row = (id: string) => host.querySelector('[data-testid="music-track-' + id + '"]') as HTMLElement;
    const inRow = (id: string, label: string) => row(id).querySelector('[aria-label="' + label + '"]') as HTMLButtonElement;
    const libPath = (id: string) => 'C:\\Lib\\' + id + '.mp3';

    it('opens on the library: 20 tracks, each with cover art, title, artist, mood and length', async () => {
      await toMusicStep();
      expect(host.querySelectorAll('[data-testid^="music-track-"]')).toHaveLength(20);
      expect(host.querySelectorAll('[data-testid="music-cover"]')).toHaveLength(20);
      const carefree = row('carefree');
      expect(carefree.textContent).toContain('Carefree');
      expect(carefree.textContent).toContain('Kevin MacLeod');
      expect(carefree.textContent).toContain('3:25');
      expect(carefree.textContent).toMatch(/Upbeat/);
      expect(row('easy-lemon').textContent).toContain('downloaded'); // from the cache list
      expect(row('carefree').textContent).not.toContain('downloaded');
      expect(host.textContent).toMatch(/Creative Commons/);
    });

    it('the mood buttons narrow the list', async () => {
      await toMusicStep();
      await act(async () => { btn('Emotional').click(); });
      const n = host.querySelectorAll('[data-testid^="music-track-"]').length;
      expect(n).toBeGreaterThan(0);
      expect(n).toBeLessThan(20);
      await act(async () => { btn('All').click(); });
      expect(host.querySelectorAll('[data-testid^="music-track-"]')).toHaveLength(20);
    });

    it('Use downloads the track if needed, selects it, and sends it with the export', async () => {
      await toMusicStep();
      await act(async () => { inRow('carefree', 'Use Carefree').click(); });
      await flush();
      expect(api.fetchMusicTrack).toHaveBeenCalledWith('carefree');
      expect(host.querySelector('[data-testid="music-name"]')!.textContent).toBe('carefree.mp3');
      expect(inRow('carefree', 'Use Carefree').textContent).toContain('Selected');
      await next(2);
      await act(async () => { btn('Generate Video').click(); });
      await flush();
      expect(api.exportVideo.mock.calls[0][0].audio).toMatchObject({ filePath: libPath('carefree'), startSec: 0, endSec: null, loop: true });
    });

    it('Preview fetches the track and plays the start of it, without selecting it', async () => {
      await toMusicStep();
      await act(async () => { inRow('wallpaper', 'Preview Wallpaper').click(); });
      await flush();
      expect(api.fetchMusicTrack).toHaveBeenCalledWith('wallpaper');
      expect(api.getAudioPreview).toHaveBeenCalledWith(libPath('wallpaper'), 0, null);
      expect(host.querySelector('[data-testid="library-preview"]')).not.toBeNull();
      expect(host.querySelector('[data-testid="music-name"]')).toBeNull();
    });

    it('a failed download shows the reason and selects nothing', async () => {
      api.fetchMusicTrack = vi.fn(async () => ({ ok: false, error: 'Could not reach incompetech.com — check the internet connection.' }));
      await toMusicStep();
      await act(async () => { inRow('carefree', 'Use Carefree').click(); });
      await flush();
      expect(host.querySelector('[role="alert"]')!.textContent).toContain('incompetech.com');
      expect(host.querySelector('[data-testid="music-name"]')).toBeNull();
    });

    describe('the required credit', () => {
      const creditDesigns = () => vi.mocked(render.renderDesignToDataUrl).mock.calls.map((c) => c[0]).filter((d) => d.texts.some((t) => t.id === 'music_credit'));
      const generate = async () => { await next(2); await act(async () => { btn('Generate Video').click(); }); await flush(); return api.exportVideo.mock.calls[0][0]; };

      it('using a library track turns the end credits on and puts the credit line on them', async () => {
        await toMusicStep();
        await act(async () => { inRow('carefree', 'Use Carefree').click(); });
        await flush();
        const req = await generate();
        expect(req.slides.map((sl: any) => sl.kind)).toEqual(['card', 'photo', 'photo', 'photo', 'photo', 'card']); // title + credits
        const d = creditDesigns();
        expect(d).toHaveLength(1);
        const line = d[0].texts.find((t) => t.id === 'music_credit')!.text;
        expect(line).toContain('"Carefree" by Kevin MacLeod (incompetech.com)');
        expect(line).toContain('By Attribution 4.0');
      });

      it('switching to another library track replaces the credit; a file from the computer removes it', async () => {
        await toMusicStep();
        await act(async () => { inRow('carefree', 'Use Carefree').click(); });
        await flush();
        await act(async () => { inRow('wallpaper', 'Use Wallpaper').click(); });
        await flush();
        await act(async () => { btn('From this computer').click(); });
        await act(async () => { btn('Choose a different file').click(); });
        await flush();
        const req = await generate();
        expect(req.audio.filePath).toBe(tone.filePath);
        expect(creditDesigns()).toHaveLength(0);
      });

      it('Remove on the chosen track takes its credit off the credits screen', async () => {
        await toMusicStep();
        await act(async () => { inRow('carefree', 'Use Carefree').click(); });
        await flush();
        await act(async () => { btn('Remove').click(); });
        await generate();
        expect(creditDesigns()).toHaveLength(0);
      });

      it('the credits tab warns if the screen is switched off while a credited track is in use', async () => {
        await toMusicStep();
        await act(async () => { inRow('carefree', 'Use Carefree').click(); });
        await flush();
        await next();
        await act(async () => { btn('End credits').click(); });
        expect(host.querySelector('[role="alert"]')).toBeNull();
        await act(async () => { (host.querySelector('input[type="checkbox"]') as HTMLInputElement).click(); }); // credits off
        expect(host.querySelector('[role="alert"]')!.textContent).toMatch(/requires a credit/);
      });
    });
  });

  describe('Title & Credits designer', () => {
    /** Goes to the designer step, runs `setup`, then generates and returns the export request. */
    const generateWith = async (setup: () => Promise<void>) => {
      await toDesignStep();
      await setup();
      await next();
      return clickGenerate();
    };

    it('by default: a title card first, no credits; each card carries its own on-screen seconds', async () => {
      const req = await generateWith(async () => {});
      expect(req.slides).toHaveLength(5);
      expect(req.slides[0]).toMatchObject({ kind: 'card', seconds: 4 });
      expect(req.slides.filter((s: any) => s.kind === 'card')).toHaveLength(1);
    });

    it('turning the title off and the credits on puts the credits card LAST', async () => {
      const req = await generateWith(async () => {
        await act(async () => { (host.querySelector('input[type="checkbox"]') as HTMLInputElement).click(); }); // title off
        await act(async () => { btn('End credits').click(); });
        await act(async () => { (host.querySelector('input[type="checkbox"]') as HTMLInputElement).click(); }); // credits on
      });
      expect(req.slides).toHaveLength(5);
      expect(req.slides[0].kind).toBe('photo');
      expect(req.slides[4]).toMatchObject({ kind: 'card', seconds: 5 });
    });

    it('both on: title first and credits last', async () => {
      const req = await generateWith(async () => {
        await act(async () => { btn('End credits').click(); });
        await act(async () => { (host.querySelector('input[type="checkbox"]') as HTMLInputElement).click(); });
      });
      expect(req.slides.map((s: any) => s.kind)).toEqual(['card', 'photo', 'photo', 'photo', 'photo', 'card']);
    });

    it.each([
      ['16:9', 1920, 1080],
      ['9:16', 1080, 1920],
      ['1:1', 1080, 1080],
      ['4:3', 1440, 1080],
    ])('the card is drawn at the exact video frame size (%s → %ix%i), so vertical video is not cropped', async (aspect, w, h) => {
      await mount();
      await next(2);
      await act(async () => { btn(aspect).click(); });
      await act(async () => { btn('Choose Where to Save').click(); });
      await flush();
      await next(3);
      await clickGenerate();
      const call = vi.mocked(render.renderDesignToDataUrl).mock.calls[0];
      expect([call[1], call[2]]).toEqual([w, h]);
    });

    it('the designer previews at that same size, and editing text changes what is rendered', async () => {
      await mount();
      await next(2);
      await act(async () => { btn('9:16').click(); });
      await act(async () => { btn('Choose Where to Save').click(); });
      await flush();
      await next(2);
      const canvas = host.querySelector('[data-testid="design-canvas"]') as HTMLCanvasElement;
      expect([canvas.width, canvas.height]).toEqual([1080, 1920]);

      await setValue(byLabel<HTMLTextAreaElement>('Text'), 'Goa 2026');
      await setValue(byLabel<HTMLSelectElement>('Font'), 'Georgia');
      await setValue(byLabel<HTMLInputElement>('Font size'), '10');
      await setValue(byLabel<HTMLInputElement>('Text colour'), '#ff0000');
      await act(async () => { byLabel<HTMLButtonElement>('Italic').click(); });
      await act(async () => { byLabel<HTMLButtonElement>('Align left').click(); });
      await next();
      await clickGenerate();
      const design = vi.mocked(render.renderDesignToDataUrl).mock.calls[0][0];
      expect(design.texts[0]).toMatchObject({ text: 'Goa 2026', fontFamily: 'Georgia', sizePct: 10, color: '#ff0000', italic: true, align: 'left' });
    });

    it('Add text adds a line to the design; Remove text takes the selected one away', async () => {
      await toDesignStep();
      const chips = () => host.querySelectorAll('[data-testid="text-chip"]').length;
      const before = chips();
      await act(async () => { btn('Add text').click(); });
      expect(chips()).toBe(before + 1);
      await act(async () => { btn('Remove text').click(); });
      expect(chips()).toBe(before);
    });

    it('a photo background: pick from the album, and the darken slider is available', async () => {
      await toDesignStep();
      await act(async () => { Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'photo')!.click(); });
      const grid = host.querySelector('[data-testid="bg-photo-grid"]')!;
      expect(grid.querySelectorAll('img')).toHaveLength(4);
      await act(async () => { (grid.querySelectorAll('img')[2] as HTMLElement).click(); });
      expect(byLabel('Darken background')).not.toBeNull();
      await next();
      await clickGenerate();
      const [design, , , photoUrl] = vi.mocked(render.renderDesignToDataUrl).mock.calls[0];
      expect(design.background).toMatchObject({ kind: 'photo', photoId: 'p3' });
      expect(decodeURIComponent(photoUrl as string)).toContain('IMG_3.jpg');
    });

    it('if the card cannot be drawn the export is not started and the reason is shown', async () => {
      vi.mocked(render.renderDesignToDataUrl).mockRejectedValueOnce(new Error('The background photo could not be loaded (its storage may be offline).'));
      await mount();
      await next(2);
      await act(async () => { btn('Choose Where to Save').click(); });
      await flush();
      await next(3);
      await act(async () => { btn('Generate Video').click(); });
      await flush();
      expect(api.exportVideo).not.toHaveBeenCalled();
      expect(host.textContent).toContain('background photo could not be loaded');
    });

    it('the estimated length on the settings step counts the title card', async () => {
      await mount();
      await next(2);
      // 4 photos x 3s + 4s title - 4 cuts x 0.6s fade
      expect(host.textContent).toContain('13.6s');
    });
  });
});
