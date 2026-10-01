import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import {
  generateSpriteSheet,
  getSpriteCoordinate,
  invalidateSpriteCoordinate,
} from '../../src/main/services/spriteService';

// Covers the fix for "Edit ... should recreate thumbnail immediately": once a photo has been baked
// into a sprite sheet, editing it must not keep handing out that stale pre-edit tile.
describe('spriteService.invalidateSpriteCoordinate', () => {
  let dir: string;
  let photoPath: string;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gphotos_sprite_invalidate_'));
    photoPath = path.join(dir, 'photo.jpg');
    const buf = await sharp({ create: { width: 200, height: 200, channels: 3, background: { r: 10, g: 20, b: 30 } } }).jpeg().toBuffer();
    fs.writeFileSync(photoPath, buf);
    // A unique sheet ID per test — generateSpriteSheet() short-circuits (skipping the index update
    // entirely) if a sheet with the same ID already exists on disk, and the sprite cache dir is only
    // isolated per spec FILE (see setup/isolateAppData.ts), not per `it()`.
    await generateSpriteSheet(`sheet_${path.basename(dir)}`, [{ filePath: photoPath } as any]);
  });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  it('a freshly-baked photo has a coordinate', () => {
    expect(getSpriteCoordinate(photoPath)).not.toBeNull();
  });

  it('drops the coordinate so it is no longer handed out', () => {
    invalidateSpriteCoordinate(photoPath);
    expect(getSpriteCoordinate(photoPath)).toBeNull();
  });

  it('is case-insensitive, matching how coordinates are looked up', () => {
    invalidateSpriteCoordinate(photoPath.toUpperCase());
    expect(getSpriteCoordinate(photoPath)).toBeNull();
  });

  it('persists the removal to disk, not just the in-memory index', async () => {
    invalidateSpriteCoordinate(photoPath);

    // A fresh module instance's in-memory index starts empty and has to re-read sprite_index.json
    // from disk — so this only passes if the removal was actually persisted, not just cached.
    vi.resetModules();
    const fresh = await import('../../src/main/services/spriteService');
    expect(fresh.getSpriteCoordinate(photoPath)).toBeNull();
  });

  it('invalidating a path with no entry is a harmless no-op', () => {
    expect(() => invalidateSpriteCoordinate(path.join(dir, 'never-baked.jpg'))).not.toThrow();
  });
});
