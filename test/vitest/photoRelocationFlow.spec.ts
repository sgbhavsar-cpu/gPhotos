// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';

const browser = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../../src/renderer/src/services/folderBrowserController', () => ({
  requestFolderBrowser: browser.request,
}));

const B = String.fromCharCode(92);
const w = (...parts: string[]) => parts.join(B);

const ROOT = w('Z:', 'Photos');
const TARGET = w(ROOT, 'Best of 2024');

const photo = (n: number, extra: Record<string, any> = {}) => ({
  id: `old${n}`, filePath: w('C:', 'Mirrors', 'NAS', `IMG_${n}.jpg`), fileName: `IMG_${n}.jpg`, fileSize: 1, dateTaken: '2026-01-01',
  year: 2026, month: 1, day: 1, isVirtual: true, storageName: 'NAS', originalRemotePath: w(ROOT, 'Inbox', `IMG_${n}.jpg`),
  faces: [{ id: `old${n}_face_0`, photoId: `old${n}`, box: { x: 1, y: 1, width: 5, height: 5 }, descriptor: [0.1], confidence: 0.9, personId: 'alice' }],
  ...extra,
}) as any;

describe('movePhotosToFolder (album → folder)', () => {
  let flow: any;
  let mod: any;
  let api: any;
  let saves: string[];

  const load = async (photos: any[]) => {
    saves = [];
    api = {
      planPhotoRelocation: vi.fn(async (inputs: any[]) => ({ root: { kind: 'storage', label: 'NAS', path: ROOT }, movableIds: inputs.map((i) => i.id), skipped: [] })),
      relocatePhotos: vi.fn(async ({ photos: ps, targetDir }: any) => ({
        root: { kind: 'storage', label: 'NAS', path: ROOT },
        results: ps.map((p: any) => ({
          oldId: p.id, status: 'moved', newId: 'new' + p.id.slice(3), newFilePath: w('C:', 'Mirrors', 'NAS', 'Best of 2024', p.fileName),
          newOriginalRemotePath: w(targetDir, p.fileName), newFileName: p.fileName,
        })),
      })),
      onPhotoRelocationProgress: vi.fn(() => () => {}),
      loadLibraryData: async () => null,
      saveLibraryData: async (key: string) => { saves.push(key); return true; },
    };
    (window as any).electronAPI = api;
    (window as any).confirm = vi.fn(() => true);
    localStorage.clear();
    vi.resetModules();
    mod = await import('../../src/renderer/src/services/libraryStore');
    flow = await import('../../src/renderer/src/services/photoRelocationFlow');
    const s = mod.libraryStore.getState();
    s.photos = photos;
    s.faces = photos.flatMap((p) => p.faces);
    s.people = [{ id: 'alice', name: 'Alice', faceCount: photos.length, photoCount: photos.length, createdAt: 'x', coverPhotoId: photos[0]?.id, coverFaceId: photos[0]?.faces[0].id }];
    s.albums = [{ id: 'a1', title: 'Trip', photoIds: photos.map((p) => p.id), coverPhotoId: photos[0]?.id, createdAt: 'x', updatedAt: 'x' }];
    return photos;
  };
  beforeEach(() => { browser.request.mockReset(); });

  it('opens the folder browser restricted to the storage folder, then moves and re-points everything', async () => {
    const photos = await load([photo(1), photo(2)]);
    browser.request.mockResolvedValue(TARGET);

    const summary = await flow.movePhotosToFolder(photos, { label: 'the album "Trip"' });

    const req = browser.request.mock.calls[0][0];
    expect(req.restrictToRoot).toBe(ROOT);
    expect(req.initialPath).toBe(ROOT);
    expect(req.allowNewFolder).toBe(true);
    expect((window as any).confirm.mock.calls[0][0]).toContain(TARGET);
    expect(api.relocatePhotos).toHaveBeenCalledWith({ photos: expect.any(Array), targetDir: TARGET });
    expect(summary).toEqual({ targetDir: TARGET, moved: 2, skipped: 0, failed: 0 });

    const s = mod.libraryStore.getState();
    expect(s.photos.map((p: any) => p.id)).toEqual(['new1', 'new2']);
    expect(s.photos[0].filePath).toBe(w('C:', 'Mirrors', 'NAS', 'Best of 2024', 'IMG_1.jpg'));
    expect(s.photos[0].originalRemotePath).toBe(w(TARGET, 'IMG_1.jpg'));
    expect(s.albums[0].photoIds).toEqual(['new1', 'new2']); // the album still holds the same photos
    expect(s.albums[0].coverPhotoId).toBe('new1');
    expect(s.faces.map((f: any) => [f.id, f.photoId])).toEqual([['new1_face_0', 'new1'], ['new2_face_0', 'new2']]);
    expect(s.photos[0].faces[0].id).toBe('new1_face_0'); // the photo's own face objects moved too
    expect(s.people[0].coverPhotoId).toBe('new1');
    expect(s.people[0].coverFaceId).toBe('new1_face_0');
    expect(saves).toContain('gphotos_library_v1'); // saved right away
    expect((mod.libraryStore as any).pendingRemovedIds.has('old1')).toBe(false); // already sent with that save
  });

  it('does nothing when the user cancels the folder dialog or the confirmation', async () => {
    const photos = await load([photo(1)]);
    browser.request.mockResolvedValue(null);
    expect(await flow.movePhotosToFolder(photos)).toBeNull();
    expect(api.relocatePhotos).not.toHaveBeenCalled();

    browser.request.mockResolvedValue(TARGET);
    (window as any).confirm.mockReturnValue(false);
    expect(await flow.movePhotosToFolder(photos)).toBeNull();
    expect(api.relocatePhotos).not.toHaveBeenCalled();
    expect(mod.libraryStore.getState().photos[0].id).toBe('old1');
  });

  it('explains why and never opens the browser when no photo can be moved', async () => {
    const photos = await load([photo(1)]);
    api.planPhotoRelocation.mockResolvedValue({ root: null, movableIds: [], skipped: [{ id: 'old1', fileName: 'IMG_1.jpg', reason: 'its storage is offline' }] });
    const notices = await import('../../src/renderer/src/services/notifications');
    expect(await flow.movePhotosToFolder(photos)).toBeNull();
    expect(browser.request).not.toHaveBeenCalled();
    expect(notices.getNotices().map((n: any) => n.message).join(' ')).toMatch(/offline/);
  });

  it('applies only the photos that really moved and reports the others', async () => {
    const photos = await load([photo(1), photo(2), photo(3)]);
    browser.request.mockResolvedValue(TARGET);
    api.relocatePhotos.mockResolvedValue({
      root: { kind: 'storage', label: 'NAS', path: ROOT },
      results: [
        { oldId: 'old1', status: 'moved', newId: 'new1', newFilePath: w('C:', 'M', 'IMG_1.jpg'), newOriginalRemotePath: w(TARGET, 'IMG_1.jpg') },
        { oldId: 'old2', status: 'failed', reason: 'file is locked' },
        { oldId: 'old3', status: 'skipped', reason: 'already in this folder' },
      ],
    });
    const notices = await import('../../src/renderer/src/services/notifications');

    const summary = await flow.movePhotosToFolder(photos);

    expect(summary).toMatchObject({ moved: 1, failed: 1, skipped: 1 });
    expect(mod.libraryStore.getState().photos.map((p: any) => p.id)).toEqual(['new1', 'old2', 'old3']);
    const shown = notices.getNotices().map((n: any) => n.message).join(' | ');
    expect(shown).toMatch(/Moved 1 photo/);
    expect(shown).toMatch(/file is locked/);
  });

  it('a whole-run error from the main process leaves the library untouched', async () => {
    const photos = await load([photo(1)]);
    browser.request.mockResolvedValue(TARGET);
    api.relocatePhotos.mockResolvedValue({ root: null, results: [], error: 'Target is outside the library' });
    expect(await flow.movePhotosToFolder(photos)).toBeNull();
    expect(mod.libraryStore.getState().photos[0].id).toBe('old1');
  });

  it('is desktop-only', async () => {
    const photos = await load([photo(1)]);
    (window as any).electronAPI = { isBrowserShim: true };
    expect(await flow.movePhotosToFolder(photos)).toBeNull();
    expect(browser.request).not.toHaveBeenCalled();
  });
});
