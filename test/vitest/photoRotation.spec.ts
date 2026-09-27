import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rotateBox, resolveFaceFrame, normalizeDegrees } from '../../src/renderer/src/services/faceGeometry';

const makeStorage = () => {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => (data.has(k) ? data.get(k)! : null),
    setItem: (k: string, v: string) => void data.set(k, String(v)),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
  };
};

// A point (px, py) in a W x H image, after the image is rotated `deg` clockwise.
const rotPoint = (px: number, py: number, W: number, H: number, deg: number): [number, number] => {
  switch (normalizeDegrees(deg)) {
    case 90: return [H - py, px];
    case 180: return [W - px, H - py];
    case 270: return [py, W - px];
    default: return [px, py];
  }
};

describe('rotateBox', () => {
  it('equals the bounding box of the rotated corners, for every quarter turn', () => {
    const W = 200, H = 100;
    const box = { x: 10, y: 20, width: 30, height: 40 };
    for (const deg of [0, 90, 180, 270]) {
      const corners = [
        rotPoint(box.x, box.y, W, H, deg),
        rotPoint(box.x + box.width, box.y + box.height, W, H, deg),
      ];
      const xs = corners.map((c) => c[0]);
      const ys = corners.map((c) => c[1]);
      const out = rotateBox(box, W, H, deg);
      expect(out.box).toEqual({ x: Math.min(...xs), y: Math.min(...ys), width: Math.abs(xs[0] - xs[1]), height: Math.abs(ys[0] - ys[1]) });
      const swap = deg === 90 || deg === 270;
      expect([out.frameW, out.frameH]).toEqual(swap ? [H, W] : [W, H]);
    }
  });

  it('four quarter turns, or 90 then 270, bring every box back; the box stays inside the frame', () => {
    const W = 640, H = 480;
    for (let i = 0; i < 200; i++) {
      const w = 1 + (i * 7) % 90, h = 1 + (i * 13) % 80;
      const box = { x: (i * 31) % (W - w), y: (i * 17) % (H - h), width: w, height: h };
      let cur = { box, frameW: W, frameH: H };
      for (let k = 0; k < 4; k++) {
        cur = rotateBox(cur.box, cur.frameW, cur.frameH, 90);
        expect(cur.box.x).toBeGreaterThanOrEqual(0);
        expect(cur.box.y).toBeGreaterThanOrEqual(0);
        expect(cur.box.x + cur.box.width).toBeLessThanOrEqual(cur.frameW);
        expect(cur.box.y + cur.box.height).toBeLessThanOrEqual(cur.frameH);
      }
      expect(cur).toEqual({ box, frameW: W, frameH: H });
      const there = rotateBox(box, W, H, 90);
      expect(rotateBox(there.box, there.frameW, there.frameH, 270)).toEqual({ box, frameW: W, frameH: H });
      const half = rotateBox(box, W, H, 180);
      expect(rotateBox(half.box, half.frameW, half.frameH, 180)).toEqual({ box, frameW: W, frameH: H });
    }
  });

  it('a face at the top-left of a landscape photo ends up top-right after 90 degrees clockwise', () => {
    const out = rotateBox({ x: 0, y: 0, width: 20, height: 10 }, 200, 100, 90);
    expect(out.box).toEqual({ x: 90, y: 0, width: 10, height: 20 });
    expect([out.frameW, out.frameH]).toEqual([100, 200]);
  });

  it('normalises odd angles', () => {
    expect(normalizeDegrees(-90)).toBe(270);
    expect(normalizeDegrees(450)).toBe(90);
    expect(normalizeDegrees(0)).toBe(0);
  });
});

describe('resolveFaceFrame', () => {
  const box = { x: 5, y: 5, width: 20, height: 20 };
  it('prefers the frame recorded with the face', () => {
    expect(resolveFaceFrame({ box, imageWidth: 800, imageHeight: 600 }, { width: 4000, height: 3000 })).toEqual({ w: 800, h: 600 });
  });
  it('falls back to a 500px thumbnail frame for boxes that fit it on a big photo, else the photo size', () => {
    expect(resolveFaceFrame({ box }, { width: 4000, height: 3000 })).toEqual({ w: 500, h: 375 });
    expect(resolveFaceFrame({ box: { x: 900, y: 100, width: 50, height: 50 } }, { width: 4000, height: 3000 })).toEqual({ w: 4000, h: 3000 });
    expect(resolveFaceFrame({ box }, { width: 400, height: 300 })).toEqual({ w: 400, h: 300 });
  });
  it('is null when nothing is known', () => {
    expect(resolveFaceFrame({ box }, {})).toBeNull();
  });
});

describe('libraryStore.applyPhotoRotation and versioned photo URLs', () => {
  let mod: any;
  let store: any;
  const face = (id: string, extra: Record<string, any> = {}) => ({
    id, photoId: 'p1', box: { x: 10, y: 20, width: 30, height: 40 }, descriptor: [0.1], confidence: 0.9, personId: 'alice', ...extra,
  });

  beforeEach(async () => {
    (globalThis as any).localStorage = makeStorage();
    (globalThis as any).window = {
      addEventListener: () => {},
      electronAPI: { loadLibraryData: async () => null, saveLibraryData: async () => true },
    };
    vi.resetModules();
    mod = await import('../../src/renderer/src/services/libraryStore');
    store = new mod.LibraryManager();
    await new Promise((r) => setTimeout(r, 20));
  });
  afterEach(() => {
    if (store?.saveDebounceTimer) clearTimeout(store.saveDebounceTimer);
    delete (globalThis as any).window;
    delete (globalThis as any).localStorage;
  });

  const load = (photoExtra: Record<string, any> = {}, faces = [face('f1', { imageWidth: 200, imageHeight: 100 })], people?: any[]) => {
    const photo: any = { id: 'p1', filePath: 'C:\\m\\p1.jpg', fileName: 'p1.jpg', fileSize: 1, dateTaken: '2026-01-01', year: 2026, month: 1, day: 1, width: 200, height: 100, faces, ...photoExtra };
    store.state.photos = [photo];
    store.state.faces = [...faces]; // the same objects, like a real library
    store.state.people = people || [{ id: 'alice', name: 'Alice', faceCount: 1, photoCount: 1, createdAt: 'x', coverFaceId: 'f1', coverPhotoId: 'p1' }];
    return photo;
  };

  it('rotates the box and its frame once, swaps the photo size, and reports whose avatar is affected', () => {
    load();
    const res = store.applyPhotoRotation('p1', 90);
    expect(res).toEqual({ rotatedFaces: 1, skippedFaces: 0, avatarPersonIds: ['alice'] });
    const f = store.getState().photos[0].faces[0];
    expect(f.box).toEqual({ x: 100 - (20 + 40), y: 10, width: 40, height: 30 }); // H - (y+h), x, h, w
    expect([f.imageWidth, f.imageHeight]).toEqual([100, 200]);
    expect([store.getState().photos[0].width, store.getState().photos[0].height]).toEqual([100, 200]);
    expect(store.getState().faces[0]).toBe(f); // still the shared object, not rotated twice
  });

  it('four quarter turns restore the original boxes and size', () => {
    load();
    for (let i = 0; i < 4; i++) store.applyPhotoRotation('p1', 90);
    const p = store.getState().photos[0];
    expect(p.faces[0].box).toEqual({ x: 10, y: 20, width: 30, height: 40 });
    expect([p.faces[0].imageWidth, p.faces[0].imageHeight]).toEqual([200, 100]);
    expect([p.width, p.height]).toEqual([200, 100]);
  });

  it('rotates separate copies of the same face (photo.faces vs state.faces) exactly once each', () => {
    const inPhoto = face('f1', { imageWidth: 200, imageHeight: 100 });
    load({}, [inPhoto]);
    store.state.faces = [{ ...inPhoto, box: { ...inPhoto.box } }]; // a distinct copy
    store.applyPhotoRotation('p1', 180);
    expect(store.getState().photos[0].faces[0].box).toEqual({ x: 160, y: 40, width: 30, height: 40 });
    expect(store.getState().faces[0].box).toEqual({ x: 160, y: 40, width: 30, height: 40 });
  });

  it('skips faces whose frame is unknown instead of guessing, and only touches the rotated photo', () => {
    load({ width: undefined, height: undefined }, [face('f1'), face('f2', { imageWidth: 200, imageHeight: 100 })]);
    const res = store.applyPhotoRotation('p1', 90);
    expect(res.rotatedFaces).toBe(1);
    expect(res.skippedFaces).toBe(1);
    expect(store.getState().photos[0].faces[0].box).toEqual({ x: 10, y: 20, width: 30, height: 40 }); // untouched
    expect(store.applyPhotoRotation('missing', 90)).toEqual({ rotatedFaces: 0, skippedFaces: 0, avatarPersonIds: [] });
    expect(store.applyPhotoRotation('p1', 0)).toEqual({ rotatedFaces: 0, skippedFaces: 0, avatarPersonIds: [] });
  });

  it('does not flag people whose avatar comes from another photo', () => {
    load({}, [face('f1', { imageWidth: 200, imageHeight: 100 })], [
      { id: 'alice', name: 'Alice', faceCount: 1, photoCount: 1, createdAt: 'x', coverFaceId: 'other_face', coverPhotoId: 'p9' },
    ]);
    expect(store.applyPhotoRotation('p1', 90).avatarPersonIds).toEqual([]);
  });

  it('photo URLs change after the image is bumped, and stay changed across a restart', async () => {
    const versions = await import('../../src/renderer/src/services/imageVersion');
    const before = mod.getLocalPhotoUrl('C:\\m\\p1.jpg', undefined, false, 250);
    expect(before).not.toContain('&v=');
    versions.bumpImageVersion('C:\\m\\p1.jpg');
    const after = mod.getLocalPhotoUrl('C:\\m\\p1.jpg', undefined, false, 250);
    expect(after).toBe(before + '&v=1');
    expect(mod.getLocalPhotoUrl('C:\\m\\p1.jpg', 'Z:\\o\\p1.jpg', true)).toContain('&v=1'); // every size/mode
    expect(mod.getLocalPhotoUrl('C:\\m\\other.jpg', undefined, false, 250)).not.toContain('&v='); // other photos keep their URLs

    versions.bumpImageVersion('c:/m/P1.JPG'); // same file spelled differently
    expect(mod.getLocalPhotoUrl('C:\\m\\p1.jpg')).toContain('&v=2');

    versions.resetImageVersionsForTests(); // "restart": state is re-read from localStorage
    expect(mod.getLocalPhotoUrl('C:\\m\\p1.jpg')).toContain('&v=2');
  });

  it('keeps working when storage is unavailable', async () => {
    (globalThis as any).localStorage = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    const versions = await import('../../src/renderer/src/services/imageVersion');
    versions.resetImageVersionsForTests();
    expect(() => versions.bumpImageVersion('C:\\m\\p1.jpg')).not.toThrow();
    expect(mod.getLocalPhotoUrl('C:\\m\\p1.jpg')).toContain('&v=1'); // still versioned for this session
  });
});
