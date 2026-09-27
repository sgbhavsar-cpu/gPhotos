// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';

const B = String.fromCharCode(92);
const photo = (n: number, extra: Record<string, any> = {}) => ({
  id: `p${n}`, filePath: ['C:', 'Mirrors', `IMG_${n}.jpg`].join(B), fileName: `IMG_${n}.jpg`, fileSize: 1, dateTaken: '2026-01-01',
  year: 2026, month: 1, day: 1, width: 200, height: 100, isVirtual: true,
  originalRemotePath: ['Z:', 'Photos', `IMG_${n}.jpg`].join(B),
  faces: [{ id: `p${n}_face_0`, photoId: `p${n}`, box: { x: 10, y: 20, width: 30, height: 40 }, imageWidth: 200, imageHeight: 100, descriptor: [0.1], confidence: 0.9, personId: 'alice' }],
  ...extra,
}) as any;

describe('autoRotateUpright', () => {
  let mod: any;
  let auto: any;
  let notices: any;
  let api: any;

  const load = async (photos: any[], detect: any[]) => {
    api = {
      detectPhotoOrientation: vi.fn(async () => detect),
      onOrientationProgress: vi.fn(() => () => {}),
      rotatePhoto: vi.fn(async () => ({ success: true, isQueued: false })),
      loadLibraryData: async () => null,
      saveLibraryData: async () => true,
      deletePersonAvatar: async () => {},
      getBatchThumbnails: async () => ({ thumbnails: {} }),
    };
    (window as any).electronAPI = api;
    (window as any).confirm = vi.fn(() => true);
    localStorage.clear();
    vi.resetModules();
    mod = await import('../../src/renderer/src/services/libraryStore');
    auto = await import('../../src/renderer/src/services/autoRotateUpright');
    notices = await import('../../src/renderer/src/services/notifications');
    const s = mod.libraryStore.getState();
    s.photos = photos;
    s.faces = photos.flatMap((p) => p.faces);
    s.people = [{ id: 'alice', name: 'Alice', faceCount: 1, photoCount: 1, createdAt: 'x', coverFaceId: photos[0]?.faces[0].id, coverPhotoId: photos[0]?.id }];
  };
  const messages = () => notices.getNotices().map((n: any) => n.message).join(' | ');
  beforeEach(() => vi.useRealTimers());

  it('rotates only the photos the detector is sure about, by the degrees it says, and leaves the rest alone', async () => {
    const photos = [photo(1), photo(2), photo(3), photo(4)];
    await load(photos, [
      { id: 'p1', status: 'rotate', rotation: 90, confidence: 0.9, faces: 2 },
      { id: 'p2', status: 'upright', rotation: 0, confidence: 0.9, faces: 1 },
      { id: 'p3', status: 'unknown', rotation: 0, confidence: 0, faces: 0, reason: 'no faces found' },
      { id: 'p4', status: 'rotate', rotation: 270, confidence: 0.8, faces: 1 },
    ]);

    const summary = await auto.autoRotateUpright(photos);

    expect(summary).toEqual({ rotated: 2, upright: 1, unknown: 1, failed: 0 });
    expect(api.rotatePhoto).toHaveBeenCalledTimes(2);
    expect(api.rotatePhoto).toHaveBeenCalledWith(photos[0].filePath, 90, photos[0].originalRemotePath);
    expect(api.rotatePhoto).toHaveBeenCalledWith(photos[3].filePath, 270, photos[3].originalRemotePath);
    const s = mod.libraryStore.getState();
    // the face boxes moved with the picture (90° clockwise: x = H - (y + h), y = x, w = h, h = w)
    expect(s.photos[0].faces[0].box).toEqual({ x: 100 - (20 + 40), y: 10, width: 40, height: 30 });
    expect(s.photos[1].faces[0].box).toEqual({ x: 10, y: 20, width: 30, height: 40 }); // untouched
    expect(messages()).toMatch(/2 rotated upright/);
    expect(messages()).toMatch(/1 already upright/);
    expect(messages()).toMatch(/no faces found/);
  });

  it('counts a failing photo, keeps going and reports why', async () => {
    const photos = [photo(1), photo(2)];
    await load(photos, [
      { id: 'p1', status: 'rotate', rotation: 180, confidence: 0.9, faces: 1 },
      { id: 'p2', status: 'failed', rotation: 0, confidence: 0, faces: 0, reason: 'storage is offline' },
    ]);
    api.rotatePhoto.mockResolvedValue({ success: false, error: 'file is locked' });

    const summary = await auto.autoRotateUpright(photos);

    expect(summary).toEqual({ rotated: 0, upright: 0, unknown: 0, failed: 2 });
    expect(messages()).toMatch(/file is locked/);
    expect(messages()).toMatch(/storage is offline/);
    expect(mod.libraryStore.getState().photos[0].faces[0].box).toEqual({ x: 10, y: 20, width: 30, height: 40 }); // nothing was rotated
  });

  it('asks first, and does nothing when the user says no', async () => {
    const photos = [photo(1)];
    await load(photos, [{ id: 'p1', status: 'rotate', rotation: 90, confidence: 0.9, faces: 1 }]);
    (window as any).confirm.mockReturnValue(false);
    expect(await auto.autoRotateUpright(photos)).toBeNull();
    expect(api.detectPhotoOrientation).not.toHaveBeenCalled();
    expect(api.rotatePhoto).not.toHaveBeenCalled();
  });

  it('is desktop-only and reports detector errors instead of throwing', async () => {
    const photos = [photo(1)];
    await load(photos, []);
    api.detectPhotoOrientation.mockRejectedValue(new Error('models missing'));
    expect(await auto.autoRotateUpright(photos)).toBeNull();
    expect(messages()).toMatch(/models missing/);

    (window as any).electronAPI = { isBrowserShim: true };
    expect(await auto.autoRotateUpright(photos)).toBeNull();
  });
});
