// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('album chapters', () => {
  let mod: any;

  beforeEach(async () => {
    (window as any).electronAPI = { loadLibraryData: async () => null, saveLibraryData: async () => true };
    localStorage.clear();
    vi.resetModules();
    mod = await import('../../src/renderer/src/services/libraryStore');
    const s = mod.libraryStore.getState();
    s.photos = [1, 2, 3, 4].map((n) => ({ id: `p${n}`, filePath: `C:\\p${n}.jpg`, fileName: `p${n}.jpg`, fileSize: 1, dateTaken: '2026-01-01', year: 2026, month: 1, day: 1 }));
    s.albums = [];
  });

  const album = () => mod.libraryStore.getState().albums[0];

  it('a plain album (no chapters) behaves exactly as before — getUnchapteredPhotoIds is just photoIds', () => {
    const a = mod.libraryStore.createAlbum('Wedding', undefined, ['p1', 'p2']);
    expect(a.chapters).toBeUndefined();
    expect(mod.libraryStore.getUnchapteredPhotoIds(a)).toEqual(['p1', 'p2']);
  });

  it('createChapter with initial photos adds them to both the chapter and the album, and sets lastUsedChapterId', () => {
    const a = mod.libraryStore.createAlbum('Wedding');
    const chapter = mod.libraryStore.createChapter(a.id, ' Day 1 — Ceremony ', ['p1', 'p2']);

    expect(chapter.title).toBe('Day 1 — Ceremony');
    expect(album().chapters).toHaveLength(1);
    expect(album().chapters[0].photoIds).toEqual(['p1', 'p2']);
    expect(album().photoIds).toEqual(['p1', 'p2']); // pulled into the album too
    expect(album().lastUsedChapterId).toBe(chapter.id);
    expect(album().chapters[0].coverPhotoId).toBe('p1'); // auto-set from the first photo
  });

  it('a photo belongs to at most one chapter — adding it to a second chapter removes it from the first', () => {
    const a = mod.libraryStore.createAlbum('Wedding');
    const day1 = mod.libraryStore.createChapter(a.id, 'Day 1', ['p1', 'p2']);
    const day2 = mod.libraryStore.createChapter(a.id, 'Day 2', []);

    mod.libraryStore.addPhotosToChapter(a.id, day2.id, ['p2']);

    const chapters = album().chapters;
    expect(chapters.find((c: any) => c.id === day1.id).photoIds).toEqual(['p1']);
    expect(chapters.find((c: any) => c.id === day2.id).photoIds).toEqual(['p2']);
    expect(album().photoIds.sort()).toEqual(['p1', 'p2']); // still in the album exactly once
    expect(album().lastUsedChapterId).toBe(day2.id); // most recently added-to
  });

  it('addPhotosToChapter with insertBeforePhotoId reorders within the same chapter', () => {
    const a = mod.libraryStore.createAlbum('Wedding');
    const day1 = mod.libraryStore.createChapter(a.id, 'Day 1', ['p1', 'p2', 'p3']);

    mod.libraryStore.addPhotosToChapter(a.id, day1.id, ['p3'], 'p1'); // move p3 to just before p1

    expect(album().chapters[0].photoIds).toEqual(['p3', 'p1', 'p2']);
  });

  it('addPhotosToChapter with insertBeforePhotoId also positions a photo arriving from another chapter', () => {
    const a = mod.libraryStore.createAlbum('Wedding');
    const day1 = mod.libraryStore.createChapter(a.id, 'Day 1', ['p1', 'p2']);
    const day2 = mod.libraryStore.createChapter(a.id, 'Day 2', ['p3']);

    mod.libraryStore.addPhotosToChapter(a.id, day1.id, ['p3'], 'p2'); // p3 moves in, right before p2

    expect(album().chapters.find((c: any) => c.id === day1.id).photoIds).toEqual(['p1', 'p3', 'p2']);
    expect(album().chapters.find((c: any) => c.id === day2.id).photoIds).toEqual([]);
  });

  it('removePhotosFromChapter sends a photo back to the album\'s unchaptered bucket, without removing it from the album', () => {
    const a = mod.libraryStore.createAlbum('Wedding');
    const chapter = mod.libraryStore.createChapter(a.id, 'Day 1', ['p1', 'p2']);

    mod.libraryStore.removePhotosFromChapter(a.id, chapter.id, ['p1']);

    expect(album().chapters[0].photoIds).toEqual(['p2']);
    expect(album().photoIds).toEqual(['p1', 'p2']);
    expect(mod.libraryStore.getUnchapteredPhotoIds(album())).toEqual(['p1']);
  });

  it('removePhotosFromAllChapters drops photos back to the default bucket regardless of which chapter(s) held them', () => {
    const a = mod.libraryStore.createAlbum('Wedding');
    const day1 = mod.libraryStore.createChapter(a.id, 'Day 1', ['p1', 'p2']);
    mod.libraryStore.createChapter(a.id, 'Day 2', ['p3']);

    const ok = mod.libraryStore.removePhotosFromAllChapters(a.id, ['p1', 'p3']); // one from each chapter

    expect(ok).toBe(true);
    expect(album().chapters.find((c: any) => c.id === day1.id).photoIds).toEqual(['p2']);
    expect(album().chapters.find((c: any) => c.title === 'Day 2').photoIds).toEqual([]);
    expect(mod.libraryStore.getUnchapteredPhotoIds(album()).sort()).toEqual(['p1', 'p3']);
    expect(album().photoIds.sort()).toEqual(['p1', 'p2', 'p3']); // still in the album, just unchaptered
  });

  it('removePhotosFromAllChapters is a no-op on an album with no chapters', () => {
    const a = mod.libraryStore.createAlbum('Wedding', undefined, ['p1']);
    expect(mod.libraryStore.removePhotosFromAllChapters(a.id, ['p1'])).toBe(false);
  });

  it('deleteChapter drops the chapter but keeps its photos in the album (now unchaptered)', () => {
    const a = mod.libraryStore.createAlbum('Wedding');
    const chapter = mod.libraryStore.createChapter(a.id, 'Day 1', ['p1', 'p2']);

    const ok = mod.libraryStore.deleteChapter(a.id, chapter.id);

    expect(ok).toBe(true);
    expect(album().chapters).toEqual([]);
    expect(album().photoIds).toEqual(['p1', 'p2']);
    expect(album().lastUsedChapterId).toBeUndefined();
  });

  it('renameChapter and reorderChapters', () => {
    const a = mod.libraryStore.createAlbum('Wedding');
    const c1 = mod.libraryStore.createChapter(a.id, 'Day 1');
    const c2 = mod.libraryStore.createChapter(a.id, 'Day 2');

    mod.libraryStore.renameChapter(a.id, c1.id, 'Day One — Ceremony');
    expect(album().chapters.find((c: any) => c.id === c1.id).title).toBe('Day One — Ceremony');

    mod.libraryStore.reorderChapters(a.id, [c2.id, c1.id]);
    expect(album().chapters.map((c: any) => c.id)).toEqual([c2.id, c1.id]);
  });

  it('removePhotosFromAlbum also strips the photo out of whichever chapter held it', () => {
    const a = mod.libraryStore.createAlbum('Wedding');
    const chapter = mod.libraryStore.createChapter(a.id, 'Day 1', ['p1', 'p2']);

    mod.libraryStore.removePhotosFromAlbum(a.id, ['p1']);

    expect(album().photoIds).toEqual(['p2']);
    expect(album().chapters.find((c: any) => c.id === chapter.id).photoIds).toEqual(['p2']);
  });
});
