// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('afterPhotoRotated', () => {
  const calls: string[] = [];
  let mod: any;
  let helper: any;
  let versions: any;
  let notices: any;

  beforeEach(async () => {
    calls.length = 0;
    localStorage.clear();
    (globalThis as any).window.electronAPI = {
      loadLibraryData: async () => null,
      saveLibraryData: async (key: string) => { calls.push(`save:${key}`); return true; },
      deletePersonAvatar: async (id: string) => { calls.push(`deleteAvatar:${id}`); },
      getBatchThumbnails: async () => ({ thumbnails: {} }),
    };
    vi.resetModules();
    mod = await import('../../src/renderer/src/services/libraryStore');
    helper = await import('../../src/renderer/src/services/photoRotation');
    versions = await import('../../src/renderer/src/services/imageVersion');
    notices = await import('../../src/renderer/src/services/notifications');
  });
  afterEach(() => {
    mod.libraryStore.saveDebounceTimer && clearTimeout(mod.libraryStore.saveDebounceTimer);
  });

  const setup = (faceExtra: Record<string, any> = { imageWidth: 200, imageHeight: 100 }) => {
    const face = { id: 'f1', photoId: 'p1', box: { x: 10, y: 20, width: 30, height: 40 }, descriptor: [0.1], confidence: 0.9, personId: 'alice', ...faceExtra };
    const photo: any = { id: 'p1', filePath: 'C:\\m\\p1.jpg', fileName: 'p1.jpg', fileSize: 1, dateTaken: '2026-01-01', year: 2026, month: 1, day: 1, width: 200, height: 100, faces: [face] };
    const s = mod.libraryStore.getState();
    s.photos = [photo];
    s.faces = [face];
    s.people = [{ id: 'alice', name: 'Alice', faceCount: 1, photoCount: 1, createdAt: 'x', coverFaceId: 'f1', coverPhotoId: 'p1' }];
    return photo;
  };

  it('rotates the boxes, bumps the URL version, saves the boxes and only then deletes the affected avatar', async () => {
    const photo = setup();
    await helper.afterPhotoRotated(photo, 90);

    expect(mod.libraryStore.getState().photos[0].faces[0].box).toEqual({ x: 40, y: 10, width: 40, height: 30 });
    expect(versions.getImageVersion(photo.filePath)).toBe(1);
    const firstSave = calls.findIndex((c) => c.startsWith('save:'));
    const del = calls.indexOf('deleteAvatar:alice');
    expect(firstSave).toBeGreaterThanOrEqual(0);
    expect(del).toBeGreaterThan(firstSave); // the avatar builder reads boxes from the DB, so they must be saved first
  });

  it('does not touch avatars when nobody s avatar comes from the photo', async () => {
    const photo = setup();
    mod.libraryStore.getState().people[0].coverFaceId = 'elsewhere';
    mod.libraryStore.getState().people[0].coverPhotoId = 'p9';
    await helper.afterPhotoRotated(photo, 90);
    expect(calls.some((c) => c.startsWith('deleteAvatar'))).toBe(false);
  });

  it('tells the user when a face cannot be moved (unknown frame) instead of failing silently', async () => {
    const photo = setup({});
    photo.width = undefined;
    photo.height = undefined;
    await helper.afterPhotoRotated(photo, 90);
    const shown = notices.getNotices().map((n: any) => n.message).join(' | ');
    expect(shown).toMatch(/could not be moved with the rotation/);
  });

  it('never throws, even if the avatar cleanup fails', async () => {
    const photo = setup();
    (window as any).electronAPI.deletePersonAvatar = async () => { throw new Error('disk error'); };
    await expect(helper.afterPhotoRotated(photo, 90)).resolves.toBeUndefined();
  });
});
