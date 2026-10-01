import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resetDbForTests, setActiveLibrary, getDb, getDbForLibraryPath } from '../../src/main/services/db';
import { upsertAlbum, getAllAlbums, replaceAllAlbums, remapPhotoIdInDb } from '../../src/main/services/libraryRepository';
import type { Album } from '../../src/types';

const chapter = (id: string, title: string, photoIds: string[], extra: any = {}) => ({ id, title, photoIds, createdAt: 't0', updatedAt: 't1', ...extra });
const album = (over: Partial<Album> = {}): Album => ({
  id: 'a1', title: 'Goa Trip', photoIds: ['p1', 'p2', 'p3', 'p4'], createdAt: 't0', updatedAt: 't1', ...over,
});

describe('album chapters are saved to disk', () => {
  let tempDir: string;
  let libA: string;
  let libB: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gphotos_chapters_'));
    process.env.GPHOTOS_TEST_DB_DIR = tempDir;
    libA = path.join(tempDir, 'LibA');
    libB = path.join(tempDir, 'LibB');
    fs.mkdirSync(libA, { recursive: true });
    fs.mkdirSync(libB, { recursive: true });
    resetDbForTests();
    setActiveLibrary(libA);
  });
  afterEach(() => {
    resetDbForTests();
    delete process.env.GPHOTOS_TEST_DB_DIR;
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  /** Closes every open database handle and reopens the library from the file — what an app restart does. */
  const restart = () => { resetDbForTests(); setActiveLibrary(libA); };

  it('chapters, their photo order, cover and the last-used chapter survive a restart', () => {
    upsertAlbum(album({
      chapters: [
        chapter('c1', 'Day 1 — Beach', ['p3', 'p1'], { coverPhotoId: 'p1' }),
        chapter('c2', 'Day 2 — Fort', ['p2']),
      ],
      lastUsedChapterId: 'c2',
    }));
    restart();
    const [loaded] = getAllAlbums();
    expect(loaded.chapters).toEqual([
      chapter('c1', 'Day 1 — Beach', ['p3', 'p1'], { coverPhotoId: 'p1' }),
      chapter('c2', 'Day 2 — Fort', ['p2']),
    ]);
    expect(loaded.lastUsedChapterId).toBe('c2');
    expect(loaded.photoIds).toEqual(['p1', 'p2', 'p3', 'p4']); // the album's own order is untouched
  });

  it('a chapter with no photos yet (just created) is kept', () => {
    upsertAlbum(album({ chapters: [chapter('c1', 'New chapter', [])] }));
    restart();
    expect(getAllAlbums()[0].chapters).toEqual([chapter('c1', 'New chapter', [])]);
  });

  it('the renderer\'s whole-list save (replaceAllAlbums) stores chapters, and removing every chapter clears them', () => {
    replaceAllAlbums([album({ chapters: [chapter('c1', 'One', ['p1'])] })]);
    restart();
    expect(getAllAlbums()[0].chapters).toHaveLength(1);

    replaceAllAlbums([album({ chapters: [], lastUsedChapterId: undefined })]);
    restart();
    const loaded = getAllAlbums()[0];
    expect(loaded.chapters).toBeUndefined();
    expect(loaded.lastUsedChapterId).toBeUndefined();
  });

  it('renaming a chapter and moving photos between chapters are saved', () => {
    replaceAllAlbums([album({ chapters: [chapter('c1', 'A', ['p1', 'p2']), chapter('c2', 'B', [])] })]);
    replaceAllAlbums([album({ chapters: [chapter('c1', 'A renamed', ['p1']), chapter('c2', 'B', ['p2'])] })]);
    restart();
    const ch = getAllAlbums()[0].chapters!;
    expect(ch.map((c) => [c.title, c.photoIds])).toEqual([['A renamed', ['p1']], ['B', ['p2']]]);
  });

  it('an album without chapters still loads exactly as before (no chapters key)', () => {
    upsertAlbum(album());
    restart();
    const loaded = getAllAlbums()[0];
    expect('chapters' in loaded).toBe(false);
    expect('lastUsedChapterId' in loaded).toBe(false);
  });

  it('chapters belong to their own library', () => {
    upsertAlbum(album({ chapters: [chapter('c1', 'Only in A', ['p1'])] }));
    setActiveLibrary(libB);
    expect(getAllAlbums()).toEqual([]);
    setActiveLibrary(libA);
    expect(getAllAlbums()[0].chapters).toHaveLength(1);
  });

  describe('a stored chapter list is checked against the album when it is read', () => {
    it('drops photos that are no longer in the album, a photo claimed by two chapters (first wins), and a cover that left', () => {
      // The album now holds only p1..p3 — p4 and 'gone' were removed after the chapters were written.
      upsertAlbum(album({
        photoIds: ['p1', 'p2', 'p3'],
        chapters: [
          chapter('c1', 'A', ['p1', 'gone', 'p4'], { coverPhotoId: 'p4' }),
          chapter('c2', 'B', ['p1', 'p2']),
        ],
      }));
      const ch = getAllAlbums()[0].chapters!;
      expect(ch[0].photoIds).toEqual(['p1']);
      expect(ch[0].coverPhotoId).toBeUndefined();
      expect(ch[1].photoIds).toEqual(['p2']);
    });

    it('a last-used chapter that no longer exists is dropped', () => {
      upsertAlbum(album({ chapters: [chapter('c1', 'A', [])], lastUsedChapterId: 'c1' }));
      getDb().prepare('UPDATE albums SET last_used_chapter_id = ? WHERE id = ?').run('deleted-chapter', 'a1');
      expect(getAllAlbums()[0].lastUsedChapterId).toBeUndefined();
    });

    it('unreadable stored chapters read as "no chapters" instead of breaking the album list', () => {
      upsertAlbum(album({ chapters: [chapter('c1', 'A', ['p1'])] }));
      getDb().prepare('UPDATE albums SET chapters_json = ? WHERE id = ?').run('{not json', 'a1');
      const loaded = getAllAlbums();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].chapters).toBeUndefined();
      getDb().prepare('UPDATE albums SET chapters_json = ? WHERE id = ?').run('{"a":1}', 'a1'); // valid JSON, wrong shape
      expect(getAllAlbums()[0].chapters).toBeUndefined();
    });
  });

  it('a database created before chapters existed is upgraded in place, keeping its albums', () => {
    upsertAlbum(album({ chapters: [chapter('c1', 'A', ['p1'])] }));
    const db = getDb();
    db.exec('ALTER TABLE albums DROP COLUMN chapters_json');
    db.exec('ALTER TABLE albums DROP COLUMN last_used_chapter_id');
    restart(); // opening the library must add the columns back

    const cols = (getDb().prepare('PRAGMA table_info(albums)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['chapters_json', 'last_used_chapter_id']));
    expect(getAllAlbums()[0]).toMatchObject({ id: 'a1', title: 'Goa Trip', photoIds: ['p1', 'p2', 'p3', 'p4'] });

    upsertAlbum(album({ chapters: [chapter('c9', 'After upgrade', ['p2'])] }));
    restart();
    expect(getAllAlbums()[0].chapters![0].title).toBe('After upgrade');
  });

  it('moving a photo (its id changes) re-points it inside the chapters too, and only in the albums that hold it', () => {
    upsertAlbum(album({ chapters: [chapter('c1', 'A', ['p1', 'p2'], { coverPhotoId: 'p1' })] }));
    upsertAlbum(album({ id: 'a2', title: 'Other', photoIds: ['p2', 'p9'], chapters: [chapter('c9', 'Z', ['p9'])] }));

    remapPhotoIdInDb(getDbForLibraryPath(libA), { oldId: 'p1', newId: 'p1-moved', filePath: 'D:\\new\\p1.jpg', fileName: 'p1.jpg' } as any);
    restart();

    const byId = new Map(getAllAlbums().map((a) => [a.id, a]));
    expect(byId.get('a1')!.photoIds).toContain('p1-moved');
    expect(byId.get('a1')!.chapters![0].photoIds).toEqual(['p1-moved', 'p2']);
    expect(byId.get('a1')!.chapters![0].coverPhotoId).toBe('p1-moved');
    expect(byId.get('a2')!.chapters![0].photoIds).toEqual(['p9']); // untouched
  });
});

describe('album chapters through the real save / load handlers the app uses', () => {
  let tempDir: string;
  let lib: string;
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gphotos_chapters_h_'));
    process.env.GPHOTOS_TEST_DB_DIR = tempDir;
    lib = path.join(tempDir, 'Lib');
    fs.mkdirSync(lib, { recursive: true });
    resetDbForTests();
  });
  afterEach(() => {
    resetDbForTests();
    delete process.env.GPHOTOS_TEST_DB_DIR;
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  it('what the renderer saves after "Create Chapter" comes back after a restart', async () => {
    const { handleStorageSave, handleStorageLoad, STORAGE_KEY } = await import('../../src/main/services/storageHandlers');
    const saved = handleStorageSave(STORAGE_KEY, {
      photos: [], isPartialPageSet: true, people: [], selectedFolder: lib, recentLibraries: [],
      albums: [album({ chapters: [chapter('c1', 'Day 1', ['p1', 'p2']), chapter('c2', 'Day 2', [])], lastUsedChapterId: 'c1' })],
    });
    expect(saved.success).toBe(true);

    resetDbForTests(); // app restart
    const loaded: any = await handleStorageLoad(STORAGE_KEY, lib, { includePhotos: false });
    expect(loaded.albums).toHaveLength(1);
    expect(loaded.albums[0].chapters.map((c: any) => [c.title, c.photoIds])).toEqual([['Day 1', ['p1', 'p2']], ['Day 2', []]]);
    expect(loaded.albums[0].lastUsedChapterId).toBe('c1');
  });
});
