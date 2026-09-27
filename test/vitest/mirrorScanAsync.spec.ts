import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let tempDir: string;
process.env.GPHOTOS_TEST_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gphotos_mirror_scan_cfg_'));

import { scanDirectoryRecursive } from '../../src/main/services/fileOrganizer';
import {
  scanVirtualMirrorDirectory,
  readFolderPhotos,
  getStorageDetails,
  scanStorageDetailsPhysical,
  getStorageDetailsFast,
} from '../../src/main/services/virtualMirrorService';
import {
  getHeicSavedRotation,
  setHeicSavedRotation,
  resetHeicRotationCacheForTests,
  resetHeicNegativeCacheForTests,
} from '../../src/main/services/heicRotationStore';

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gphotos_mirror_scan_'));
});
afterEach(() => {
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

describe('scanDirectoryRecursive (async)', () => {
  it('walks nested folders, skips ignored/hidden dirs and thumbnails, dedupes companion pairs, in readdir order', async () => {
    const mk = (rel: string) => {
      const p = path.join(tempDir, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, 'x');
    };
    mk('a.jpg');
    mk('IMG_1.jpg');
    mk('IMG_1.heic'); // master wins over the companion jpg
    mk('sub/b.png');
    mk('sub/deeper/c.jpeg');
    mk('sub/notes.txt');
    mk('.hidden/x.jpg');
    mk('@eaDir/y.jpg');
    mk('thumbs/z.jpg');
    mk('sub/photo_thumb.jpg');
    mk('sub/synophoto_thumb_1.jpg');

    const info = { hadErrors: false };
    const result = (await scanDirectoryRecursive(tempDir, info)).map((p) => path.relative(tempDir, p).replace(/\\/g, '/'));
    expect(info.hadErrors).toBe(false);
    expect(result).toEqual(['sub/deeper/c.jpeg', 'sub/b.png', 'a.jpg', 'IMG_1.heic']);
  });

  it('a missing root gives an empty list and hadErrors=true', async () => {
    const info = { hadErrors: false };
    expect(await scanDirectoryRecursive(path.join(tempDir, 'nope'), info)).toEqual([]);
    expect(info.hadErrors).toBe(true);
  });

  it('does not use the synchronous readdir/exists calls', async () => {
    fs.writeFileSync(path.join(tempDir, 'a.jpg'), 'x');
    const realReaddir = fs.readdirSync;
    const realExists = fs.existsSync;
    let syncCalls = 0;
    (fs as any).readdirSync = (...a: any[]) => { syncCalls++; return (realReaddir as any)(...a); };
    (fs as any).existsSync = (...a: any[]) => { syncCalls++; return (realExists as any)(...a); };
    try {
      await scanDirectoryRecursive(tempDir);
    } finally {
      (fs as any).readdirSync = realReaddir;
      (fs as any).existsSync = realExists;
    }
    expect(syncCalls).toBe(0);
  });
});

describe('scanVirtualMirrorDirectory (async, bounded parallel)', () => {
  /** The pre-refactor synchronous walk, kept here as the reference for ordering/content. */
  function referenceScan(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.')) referenceScan(full, out);
      } else if (entry.isFile() && entry.name.endsWith('.json')) {
        try {
          const meta = JSON.parse(fs.readFileSync(full, 'utf-8'));
          if (fs.existsSync(meta.thumbnailPath)) out.push(meta.thumbnailPath);
        } catch {}
      }
    }
    return out;
  }

  function writeSidecar(dir: string, name: string, over: Record<string, unknown> = {}, withThumb = true) {
    fs.mkdirSync(dir, { recursive: true });
    const thumb = path.join(dir, `${name}.jpg`);
    if (withThumb) fs.writeFileSync(thumb, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    fs.writeFileSync(
      path.join(dir, `${name}.json`),
      JSON.stringify({ fileName: `${name}.jpg`, thumbnailPath: thumb, dateTaken: '2022-05-06T07:08:09.000Z', originalFileSize: 10, width: 4, height: 3, ...over })
    );
  }

  it('returns exactly the photos (and order) the old synchronous walk did', async () => {
    for (let i = 0; i < 70; i++) writeSidecar(tempDir, `top_${String(i).padStart(3, '0')}`);
    for (let i = 0; i < 40; i++) writeSidecar(path.join(tempDir, '2021', '05'), `n_${i}`);
    writeSidecar(path.join(tempDir, '.hidden'), 'skip_me');
    writeSidecar(tempDir, 'no_thumb', {}, false);
    fs.writeFileSync(path.join(tempDir, 'broken.json'), '{not json');
    writeSidecar(tempDir, 'nodate', { dateTaken: 'garbage', faces: [{ x: 1 }] });
    fs.writeFileSync(path.join(tempDir, 'nothumbfield.json'), JSON.stringify({ fileName: 'x' }));

    const expected = referenceScan(tempDir);
    const photos = await scanVirtualMirrorDirectory(tempDir);
    expect(photos.map((p) => p.filePath)).toEqual(expected);
    expect(photos.length).toBe(70 + 40 + 1);
    const nodate = photos.find((p) => p.fileName === 'nodate.jpg')!;
    expect(Number.isNaN(nodate.year)).toBe(false);
    expect(nodate.faceScanCompleted).toBe(true);
    expect(photos[0].isVirtual).toBe(true);
    expect(photos[0].id).toBe(Buffer.from(photos[0].filePath).toString('base64'));
  });

  it('missing folder returns []', async () => {
    expect(await scanVirtualMirrorDirectory(path.join(tempDir, 'missing'))).toEqual([]);
  });
});

describe('readFolderPhotos (bounded parallel)', () => {
  it('returns photos in readdir order, skipping non-images and unreadable entries', async () => {
    const names: string[] = [];
    for (let i = 0; i < 20; i++) {
      const n = `p_${String(i).padStart(2, '0')}.jpg`;
      names.push(n);
      fs.writeFileSync(path.join(tempDir, n), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    }
    fs.writeFileSync(path.join(tempDir, 'readme.txt'), 'hi');
    fs.mkdirSync(path.join(tempDir, 'folder.jpg')); // a dir named like an image: not a file

    const photos = await readFolderPhotos(tempDir);
    expect(photos.map((p) => p.fileName)).toEqual(names);
    expect(photos.every((p) => p.isVirtual === false && p.originalRemotePath === p.filePath)).toBe(true);
    expect(await readFolderPhotos(path.join(tempDir, 'missing'))).toEqual([]);
  });
});

describe('storage details: sync listing walk agrees with the async one', () => {
  it('getStorageDetails === scanStorageDetailsPhysical (nested, housekeeping, missing thumbnails)', async () => {
    const root = path.join(tempDir, 'mirrors');
    const dir = path.join(root, 's1');
    const nested = path.join(dir, '2020', '01');
    fs.mkdirSync(nested, { recursive: true });
    fs.mkdirSync(path.join(dir, '.gphotos_catalog'), { recursive: true });
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(path.join(dir, `a${i}.jpg`), 'x');
      fs.writeFileSync(path.join(dir, `a${i}.json`), '{}');
    }
    fs.writeFileSync(path.join(nested, 'b.json'), '{}'); // no thumbnail
    fs.writeFileSync(path.join(dir, '_sync_checkpoint.json'), '{}');
    fs.writeFileSync(path.join(dir, '.gphotos_catalog', 'x.json'), '{}');

    const sync = getStorageDetails('s1', root);
    const asyncD = await scanStorageDetailsPhysical('s1', root);
    expect(sync).toEqual(asyncD);
    expect(sync.totalPhotos).toBe(6);
    expect(sync.thumbnailCachedCount).toBe(5);
    // Fast path with no checkpoint knows nothing about the folder.
    expect(getStorageDetailsFast('s1', root).totalPhotos).toBe(0);
  });

  it('getStorageDetails opens no sidecar file', () => {
    const root = path.join(tempDir, 'mirrors');
    const dir = path.join(root, 's1');
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 10; i++) {
      fs.writeFileSync(path.join(dir, `a${i}.jpg`), 'x');
      fs.writeFileSync(path.join(dir, `a${i}.json`), '{}');
    }
    const realRead = fs.readFileSync;
    let opened = 0;
    (fs as any).readFileSync = (...a: any[]) => { if (String(a[0]).endsWith('.json') && String(a[0]).includes('s1')) opened++; return (realRead as any)(...a); };
    try {
      expect(getStorageDetails('s1', root).totalPhotos).toBe(10);
    } finally {
      (fs as any).readFileSync = realRead;
    }
    expect(opened).toBe(0);
  });
});

describe('getHeicSavedRotation negative-lookup cache', () => {
  beforeEach(() => {
    resetHeicRotationCacheForTests();
    resetHeicNegativeCacheForTests();
  });

  function countReads<T>(fn: () => T): { result: T; reads: number } {
    const realRead = fs.readFileSync;
    let reads = 0;
    (fs as any).readFileSync = (...a: any[]) => { if (String(a[0]).endsWith('.json') && !String(a[0]).endsWith('heic_rotations.json')) reads++; return (realRead as any)(...a); };
    try {
      return { result: fn(), reads };
    } finally {
      (fs as any).readFileSync = realRead;
    }
  }

  it('only touches disk once for a path with no sidecar', () => {
    const f = path.join(tempDir, 'IMG_9.heic');
    const first = countReads(() => getHeicSavedRotation(f));
    expect(first.result).toBe(0);
    expect(first.reads).toBe(1);
    const again = countReads(() => { for (let i = 0; i < 100; i++) getHeicSavedRotation(f); });
    expect(again.reads).toBe(0);
  });

  it('skipSidecar and UNC paths never touch disk', () => {
    const local = path.join(tempDir, 'IMG_1.heic');
    fs.writeFileSync(path.join(tempDir, 'IMG_1.json'), JSON.stringify({ heicRotation: 90 }));
    expect(countReads(() => getHeicSavedRotation(local, { skipSidecar: true }))).toMatchObject({ result: 0, reads: 0 });
    expect(countReads(() => getHeicSavedRotation('\\\\nas\\photos\\IMG_1.heic'))).toMatchObject({ result: 0, reads: 0 });
    // ...while the normal local lookup still reads the sidecar and finds the rotation.
    expect(countReads(() => getHeicSavedRotation(local))).toMatchObject({ result: 90, reads: 1 });
  });

  it('a saved rotation invalidates the cached miss', () => {
    const f = path.join(tempDir, 'IMG_2.heic');
    expect(getHeicSavedRotation(f)).toBe(0);
    setHeicSavedRotation(f, 180);
    expect(getHeicSavedRotation(f)).toBe(180);
  });
});
