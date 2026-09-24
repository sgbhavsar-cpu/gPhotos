import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import { getAvatarSprites, configureAvatarSpritesForTests, avatarSpriteKey, AVATAR_TILE } from '../../src/main/services/avatarSpriteService';

describe('avatarSpriteService: person avatars packed into sprite sheets', () => {
  let dir: string;
  const avatarFile = (p: string, k: string) => path.join(dir, 'avatars', `${p}__${k}.jpg`);
  const spriteFile = (id: string) => path.join(dir, 'sprites', `${id}.webp`);

  const makeAvatar = async (p: string, k: string, color: { r: number; g: number; b: number }) => {
    const buf = await sharp({ create: { width: 220, height: 220, channels: 3, background: color } }).jpeg().toBuffer();
    fs.writeFileSync(avatarFile(p, k), buf);
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gphotos_avsprite_'));
    fs.mkdirSync(path.join(dir, 'avatars'));
    fs.mkdirSync(path.join(dir, 'sprites'));
    configureAvatarSpritesForTests({
      avatarPath: (p, k) => (fs.existsSync(avatarFile(p, k)) ? avatarFile(p, k) : null),
      spritePath: spriteFile,
    });
  });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  it('packs several avatars into one sheet with correct tile positions and pixels', async () => {
    await makeAvatar('a', 'f1', { r: 255, g: 0, b: 0 });
    await makeAvatar('b', 'f2', { r: 0, g: 255, b: 0 });
    await makeAvatar('c', 'f3', { r: 0, g: 0, b: 255 });

    const res = await getAvatarSprites([
      { personId: 'a', cacheKey: 'f1' },
      { personId: 'b', cacheKey: 'f2' },
      { personId: 'c', cacheKey: 'f3' },
    ]);
    const a = res[avatarSpriteKey('a', 'f1')]!, b = res[avatarSpriteKey('b', 'f2')]!, c = res[avatarSpriteKey('c', 'f3')]!;
    expect([a.spriteId === b.spriteId, b.spriteId === c.spriteId]).toEqual([true, true]); // one sheet, one transfer
    expect([a.col, b.col, c.col]).toEqual([0, 1, 2]);
    expect(a.rows).toBe(1);

    const meta = await sharp(fs.readFileSync(spriteFile(a.spriteId))).metadata();
    expect([meta.width, meta.height]).toEqual([10 * AVATAR_TILE, AVATAR_TILE]);

    // The tile at each coordinate really is that person's avatar colour.
    const raw = await sharp(fs.readFileSync(spriteFile(a.spriteId))).removeAlpha().raw().toBuffer();
    const px = (col: number) => { const i = (AVATAR_TILE / 2 * 10 * AVATAR_TILE + col * AVATAR_TILE + AVATAR_TILE / 2) * 3; return [raw[i], raw[i + 1], raw[i + 2]]; };
    expect(px(0)[0]).toBeGreaterThan(200); // red-ish
    expect(px(1)[1]).toBeGreaterThan(200); // green-ish
    expect(px(2)[2]).toBeGreaterThan(200); // blue-ish
  });

  it('reuses existing tiles (no rebuild) and returns null for people without an avatar file', async () => {
    await makeAvatar('a', 'f1', { r: 9, g: 9, b: 9 });
    const first = await getAvatarSprites([{ personId: 'a', cacheKey: 'f1' }]);
    const sheetsBefore = fs.readdirSync(path.join(dir, 'sprites')).filter((f) => f.endsWith('.webp')).length;

    const second = await getAvatarSprites([{ personId: 'a', cacheKey: 'f1' }, { personId: 'ghost', cacheKey: 'x' }]);
    expect(second[avatarSpriteKey('a', 'f1')]).toEqual(first[avatarSpriteKey('a', 'f1')]);
    expect(second[avatarSpriteKey('ghost', 'x')]).toBeNull();
    expect(fs.readdirSync(path.join(dir, 'sprites')).filter((f) => f.endsWith('.webp')).length).toBe(sheetsBefore);
  });

  it('rebuilds a tile when the same cover face is re-cropped (avatar file changed)', async () => {
    await makeAvatar('a', 'f1', { r: 255, g: 0, b: 0 });
    const first = (await getAvatarSprites([{ personId: 'a', cacheKey: 'f1' }]))[avatarSpriteKey('a', 'f1')]!;

    await makeAvatar('a', 'f1', { r: 0, g: 0, b: 255 });
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(avatarFile('a', 'f1'), future, future); // guarantee a different mtime
    const second = (await getAvatarSprites([{ personId: 'a', cacheKey: 'f1' }]))[avatarSpriteKey('a', 'f1')]!;
    expect(second.spriteId).not.toBe(first.spriteId);
  });

  it('splits more than 50 avatars across sheets, and skips a corrupt avatar without failing the rest', async () => {
    const items: Array<{ personId: string; cacheKey: string }> = [];
    for (let i = 0; i < 55; i++) {
      await makeAvatar(`p${i}`, 'f', { r: i, g: 50, b: 50 });
      items.push({ personId: `p${i}`, cacheKey: 'f' });
    }
    fs.writeFileSync(avatarFile('p3', 'f'), 'not a jpeg');

    const res = await getAvatarSprites(items);
    expect(res[avatarSpriteKey('p3', 'f')]).toBeNull(); // corrupt -> renderer crops live instead
    const ids = new Set(Object.values(res).filter(Boolean).map((c) => c!.spriteId));
    expect(ids.size).toBe(2); // 50 + the remaining 4 good ones
    expect(Object.values(res).filter(Boolean)).toHaveLength(54);
  });

  it('serialises concurrent requests for the same avatars into one build', async () => {
    await makeAvatar('a', 'f1', { r: 1, g: 2, b: 3 });
    const [r1, r2] = await Promise.all([
      getAvatarSprites([{ personId: 'a', cacheKey: 'f1' }]),
      getAvatarSprites([{ personId: 'a', cacheKey: 'f1' }]),
    ]);
    expect(r1[avatarSpriteKey('a', 'f1')]).toEqual(r2[avatarSpriteKey('a', 'f1')]);
    expect(fs.readdirSync(path.join(dir, 'sprites')).filter((f) => f.endsWith('.webp'))).toHaveLength(1);
  });

  // ---- face baking: people with no saved avatar are cropped from the local thumbnail ----
  describe('baking missing avatars from the cover face', () => {
    const RED = { r: 255, g: 0, b: 0 };
    const BLUE = { r: 0, g: 0, b: 255 };

    /** width x height blue image with a red square at (sx,sy) of side `side`, saved as a jpeg (optionally EXIF-rotated). */
    const makeThumb = async (name: string, width: number, height: number, sx: number, sy: number, side: number, orientation?: number) => {
      const red = await sharp({ create: { width: side, height: side, channels: 3, background: RED } }).png().toBuffer();
      let img = sharp({ create: { width, height, channels: 3, background: BLUE } }).composite([{ input: red, left: sx, top: sy }]).jpeg({ quality: 95 });
      if (orientation) img = img.withMetadata({ orientation });
      const file = path.join(dir, name);
      fs.writeFileSync(file, await img.toBuffer());
      return file;
    };

    const tilePixel = async (sheetId: string, col: number, row: number, dx: number, dy: number) => {
      const raw = await sharp(fs.readFileSync(spriteFile(sheetId))).removeAlpha().raw().toBuffer();
      const sheetW = 10 * AVATAR_TILE;
      const i = ((row * AVATAR_TILE + dy) * sheetW + col * AVATAR_TILE + dx) * 3;
      return { r: raw[i], g: raw[i + 1], b: raw[i + 2] };
    };

    it('crops the face region: red face in the middle of the tile, background at the corners (box scaled from original size)', async () => {
      // thumbnail 500x400, red face square at (200,150) size 50. Original was 1000x800, so the box is 2x.
      const file = await makeThumb('t1.jpg', 500, 400, 200, 150, 50);
      configureAvatarSpritesForTests({
        avatarPath: () => null,
        spritePath: spriteFile,
        faceSource: () => ({ filePath: file, box: { x: 400, y: 300, width: 100, height: 100 }, imageWidth: 1000, imageHeight: 800 }),
      });
      const res = await getAvatarSprites([{ personId: 'a', cacheKey: 'face_1' }]);
      const c = res[avatarSpriteKey('a', 'face_1')]!;
      expect(c).toBeTruthy();
      const centre = await tilePixel(c.spriteId, c.col, c.row, 80, 80);
      const corner = await tilePixel(c.spriteId, c.col, c.row, 4, 4);
      expect(centre.r).toBeGreaterThan(200); // face square is centred
      expect(corner.b).toBeGreaterThan(200); // padding shows the blue background
    });

    it('respects EXIF orientation: the box is in the displayed (rotated) image, so the crop must be too', async () => {
      // stored 400x500 with orientation 6 (displayed 500x400). Stored red square at x 100..150, y 300..350
      // -> displayed x 150..200, y 100..150. Box is given in displayed coordinates.
      const file = await makeThumb('t2.jpg', 400, 500, 100, 300, 50, 6);
      configureAvatarSpritesForTests({
        avatarPath: () => null,
        spritePath: spriteFile,
        faceSource: () => ({ filePath: file, box: { x: 150, y: 100, width: 50, height: 50 }, imageWidth: 500, imageHeight: 400 }),
      });
      const c = (await getAvatarSprites([{ personId: 'a', cacheKey: 'face_2' }]))[avatarSpriteKey('a', 'face_2')]!;
      const centre = await tilePixel(c.spriteId, c.col, c.row, 80, 80);
      expect(centre.r).toBeGreaterThan(200);
    });

    it('accepts a box already in the thumbnail own pixels when no original size is known, and rejects one that cannot fit', async () => {
      const file = await makeThumb('t3.jpg', 500, 400, 200, 150, 50);
      configureAvatarSpritesForTests({
        avatarPath: () => null,
        spritePath: spriteFile,
        faceSource: (k) => k === 'ok'
          ? { filePath: file, box: { x: 200, y: 150, width: 50, height: 50 } }
          : { filePath: file, box: { x: 4000, y: 3000, width: 500, height: 500 } }, // outside a 500x400 image, no size given
      });
      const res = await getAvatarSprites([{ personId: 'a', cacheKey: 'ok' }, { personId: 'b', cacheKey: 'bad' }]);
      expect(res[avatarSpriteKey('a', 'ok')]).toBeTruthy();
      expect(res[avatarSpriteKey('b', 'bad')]).toBeNull(); // renderer falls back to the live crop
    });

    it('a thumbnail tile is reused without rebuilding, and a saved avatar file replaces it', async () => {
      const file = await makeThumb('t4.jpg', 500, 400, 200, 150, 50);
      let faceLookups = 0;
      configureAvatarSpritesForTests({
        avatarPath: (p, k) => (fs.existsSync(avatarFile(p, k)) ? avatarFile(p, k) : null),
        spritePath: spriteFile,
        faceSource: () => { faceLookups++; return { filePath: file, box: { x: 400, y: 300, width: 100, height: 100 }, imageWidth: 1000, imageHeight: 800 }; },
      });
      const key = avatarSpriteKey('a', 'f');
      const first = (await getAvatarSprites([{ personId: 'a', cacheKey: 'f' }]))[key]!;
      const sheets = () => fs.readdirSync(path.join(dir, 'sprites')).filter((f) => f.endsWith('.webp')).length;
      expect(sheets()).toBe(1);

      const again = (await getAvatarSprites([{ personId: 'a', cacheKey: 'f' }]))[key]!;
      expect(again.spriteId).toBe(first.spriteId);
      expect(faceLookups).toBe(1); // no second bake
      expect(sheets()).toBe(1);

      // the sharper saved avatar (all green) now exists -> it wins over the provisional tile
      await makeAvatar('a', 'f', { r: 0, g: 255, b: 0 });
      const upgraded = (await getAvatarSprites([{ personId: 'a', cacheKey: 'f' }]))[key]!;
      expect(upgraded.spriteId).not.toBe(first.spriteId);
      expect((await tilePixel(upgraded.spriteId, upgraded.col, upgraded.row, 80, 80)).g).toBeGreaterThan(200);
    });

    it('returns null when there is neither a saved avatar nor a usable face source', async () => {
      configureAvatarSpritesForTests({ avatarPath: () => null, spritePath: spriteFile, faceSource: () => null });
      const res = await getAvatarSprites([{ personId: 'a', cacheKey: 'nope' }]);
      expect(res[avatarSpriteKey('a', 'nope')]).toBeNull();
    });
  });
});
