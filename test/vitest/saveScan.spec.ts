import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Guards the cheap save scan (per-Photo-object signature cache + guard, periodic/blur full re-sign) and the
// coalesced catalog-page notifications. Uses only the store's public API plus the same window mock as
// incrementalSave.spec.ts (no real user data is touched).
const STORAGE_KEY = 'gphotos_library_v1';

function photo(id: string, extra: Record<string, any> = {}): any {
  return {
    id, filePath: `C:\\p\\${id}.jpg`, fileName: `${id}.jpg`, fileSize: 1, dateTaken: '2026-01-01',
    year: 2026, month: 1, day: 1, isFavorite: false, faces: [], ...extra,
  };
}

function face(photoId: string, n: number, personId?: string): any {
  return {
    id: `${photoId}_f${n}`, photoId, box: { x: n, y: n, width: 10, height: 10 }, descriptor: new Array(128).fill(0.1 * (n + 1)),
    confidence: 0.9, personId, isConfirmed: false,
  };
}

// Deep, independent content fingerprint (descriptors excluded) - the "full scan" reference.
const refSig = (p: any) => JSON.stringify({ ...p, faces: (p.faces || []).map((f: any) => ({ ...f, descriptor: undefined })) });

function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('libraryStore save scan', () => {
  let store: any;
  let saves: Array<{ key: string; data: any }>;
  let listeners: Record<string, () => void>;
  let onLibrarySave: ((data: any) => void) | null = null;
  let hookError: any = null; // doSave swallows save errors, so assertion failures inside the fake are kept here

  const setup = async (opts: { catalogPages?: (i: number) => any[] } = {}) => {
    saves = [];
    listeners = {};
    onLibrarySave = null;
    hookError = null;
    (globalThis as any).window = {
      addEventListener: (ev: string, fn: () => void) => { listeners[ev] = fn; },
      electronAPI: {
        loadLibraryData: async () => null,
        saveLibraryData: async (key: string, data: any) => {
          if (key === STORAGE_KEY) { try { onLibrarySave?.(data); } catch (e) { hookError = hookError || e; throw e; } }
          saves.push({ key, data });
          return true;
        },
        ...(opts.catalogPages ? { getCatalogPage: async ({ pageIndex }: any) => ({ photos: opts.catalogPages!(pageIndex) }) } : {}),
      },
    };
    vi.resetModules();
    const mod = await import('../../src/renderer/src/services/libraryStore');
    store = new mod.LibraryManager();
    await new Promise((r) => setTimeout(r, 20));
    saves.length = 0;
    return mod;
  };

  afterEach(() => {
    if (store?.saveDebounceTimer) clearTimeout(store.saveDebounceTimer);
    delete (globalThis as any).window;
  });

  const persist = async () => {
    if (store.saveDebounceTimer) { clearTimeout(store.saveDebounceTimer); store.saveDebounceTimer = null; }
    saves.length = 0;
    await store.persistNow();
    return saves.filter((s) => s.key === STORAGE_KEY).pop()!.data;
  };

  describe('(a) equivalence with a full scan', () => {
    it('sends exactly what a full scan would, and the database ends up equal to memory, over random mutations', async () => {
      for (const seed of [1, 2, 3]) {
        await setup();
        const rnd = makeRng(seed);
        const pick = <T,>(a: T[]): T => a[Math.floor(rnd() * a.length)];
        store.state.photos = Array.from({ length: 40 }, (_, i) => photo(`p${i}`, { faces: i % 3 === 0 ? [face(`p${i}`, 0), face(`p${i}`, 1)] : [] }));
        store.state.faces = store.state.photos.flatMap((p: any) => p.faces);
        store.state.people = [];

        // Reference model of "what was last saved" + a fake database applying the payload like main does.
        let refBaseline: Map<string, string> | null = null;
        const db = new Map<string, string>();
        const pendingRemoved = new Set<string>();
        let nextId = 1000;
        let incrementalSaves = 0, fullSaves = 0, removalSaves = 0;

        // Runs inside the fake saveLibraryData, i.e. synchronously with the store's scan: every save
        // (debounced, immediate from notify(true), or ours) is compared with the full-scan reference.
        onLibrarySave = (data) => {
          const current = store.getState().photos as any[];
          const currentSigs = new Map(current.map((p) => [p.id, refSig(p)] as [string, string]));
          let expected: string[];
          if (!refBaseline) {
            expected = current.map((p) => p.id);
          } else {
            const removed = [...refBaseline.keys()].filter((id) => !currentSigs.has(id));
            expected = removed.every((id) => pendingRemoved.has(id))
              ? current.filter((p) => refBaseline!.get(p.id) !== currentSigs.get(p.id)).map((p) => p.id)
              : current.map((p) => p.id);
          }
          const sent: any[] = data.photos;
          expect(sent.map((p) => p.id).sort()).toEqual([...expected].sort());
          // apply like main: removedIds delete; partial = upsert, otherwise replace everything
          (data.removedIds || []).forEach((id: string) => db.delete(id));
          if (!data.isPartialPageSet) db.clear();
          for (const p of sent) db.set(p.id, refSig(p));
          (data.removedIds || []).forEach((id: string) => pendingRemoved.delete(id));
          if (data.isPartialPageSet) incrementalSaves++; else fullSaves++;
          if (data.removedIds?.length) removalSaves++;
          refBaseline = currentSigs;
        };
        const check = async () => {
          await store.saveChain; // drain saves already kicked off by notify(true)
          await persist();
          if (hookError) throw hookError;
          const current = store.getState().photos as any[];
          // the database must equal memory
          expect([...db.entries()].sort()).toEqual(current.map((p) => [p.id, refSig(p)] as [string, string]).sort());
        };

        await check();
        for (let step = 0; step < 60; step++) {
          const ps = store.getState().photos as any[];
          const op = Math.floor(rnd() * 9);
          if (op === 0 && ps.length) store.toggleFavorite(pick(ps).id);
          else if (op === 1 && ps.length) store.excludePhotos([pick(ps).id, pick(ps).id], rnd() < 0.5);
          else if (op === 2 && ps.length) store.updatePhoto({ ...pick(ps), rotation: Math.floor(rnd() * 4) * 90, location: { lat: rnd(), lng: rnd() } });
          else if (op === 3 && ps.length) store.updatePhotos([{ id: pick(ps).id, fileName: `r${step}.jpg` }, { id: pick(ps).id, isFavorite: true }]);
          else if (op === 4 && ps.length > 5) {
            const ids = [pick(ps).id, pick(ps).id];
            store.removePhotos(ids);
            ids.forEach((id) => pendingRemoved.add(id));
          } else if (op === 5) store.addPhotos([photo(`n${nextId++}`), photo(`n${nextId++}`)]);
          else if (op === 6 && ps.length) {
            const target = pick(ps.filter((p) => p.faces && p.faces.length > 0).concat(ps.slice(0, 1)));
            store.addManualFace(target.id, { x: 5, y: 5, width: 20, height: 20 });
          } else if (op === 7) {
            const withFace = ps.filter((p) => p.faces && p.faces.length > 0);
            if (withFace.length) store.deleteFaceDetection(pick(pick(withFace).faces as any[]).id);
          } else if (op === 8) {
            const withFace = ps.filter((p) => p.faces && p.faces.length > 0);
            if (withFace.length) store.confirmFace(pick(pick(withFace).faces as any[]).id);
          }
          if (rnd() < 0.6) await check(); // several edits often ride one save
        }
        await check();
        // the run really exercised both paths (not vacuous)
        expect(incrementalSaves).toBeGreaterThan(10);
        expect(fullSaves).toBeGreaterThanOrEqual(1);
        expect(removalSaves).toBeGreaterThan(0);
      }
    });
  });

  describe('(b) in-place mutations', () => {
    beforeEach(async () => {
      await setup();
      store.state.photos = [photo('a', { faces: [face('a', 0, 'x')] }), photo('b'), photo('c')];
      store.state.people = [{ id: 'x', name: 'X', faceCount: 1, photoCount: 1 }];
      await persist(); // baseline
    });

    it('catches a top-level in-place edit on the very next save (guard)', async () => {
      store.state.photos[1].isFavorite = true;
      expect((await persist()).photos.map((p: any) => p.id)).toEqual(['b']);
    });

    it('catches a nested in-place edit (a face field) via the periodic full re-sign', async () => {
      store.state.photos[0].faces[0].personId = 'y';
      let sentAt = -1;
      for (let i = 1; i <= 20 && sentAt < 0; i++) {
        if ((await persist()).photos.some((p: any) => p.id === 'a')) sentAt = i;
      }
      expect(sentAt).toBeGreaterThan(0);
      expect(sentAt).toBeLessThanOrEqual(20);
      // ...and once saved it is not re-sent
      expect((await persist()).photos).toHaveLength(0);
    });

    it('catches a nested in-place edit as soon as the window loses focus', async () => {
      store.state.photos[0].faces[0].isConfirmed = true;
      expect((await persist()).photos).toHaveLength(0); // the cheap scan cannot see it
      saves.length = 0;
      listeners.blur();
      await store.saveChain;
      const sent = saves.filter((s) => s.key === STORAGE_KEY).pop()!.data.photos.map((p: any) => p.id);
      expect(sent).toEqual(['a']);
    });

    it('does not save on blur when nothing changed', async () => {
      saves.length = 0;
      listeners.blur();
      await store.saveChain;
      expect(saves).toHaveLength(0);
    });

    it('an unchanged face confirmation through the store API is seen immediately (touch)', async () => {
      store.state.faces = [store.state.photos[0].faces[0]];
      store.confirmFace('a_f0');
      expect((await persist()).photos.map((p: any) => p.id)).toEqual(['a']);
    });
  });

  describe('(c) benchmark at 100k photos', () => {
    it('steady-state save (one edit) is much cheaper than the old full re-sign + filter', async () => {
      await setup();
      const N = 100_000;
      const photos: any[] = [];
      for (let i = 0; i < N; i++) {
        photos.push(photo(`id${i}`, {
          filePath: `C:\\photos\\2024\\img${i}.jpg`, fileDate: '2024-01-01T10:00:00Z', width: 4000, height: 3000, sharpnessScore: 50,
          faceScanCompleted: true, storageName: 'x',
          exif: { make: 'Canon', model: 'EOS', iso: 100, fNumber: 2.8, exposureTime: 0.01, focalLength: 35, lens: 'EF 35mm', orientation: 1, software: 'x', dateTimeOriginal: '2024:01:01 10:00:00' },
          location: i % 2 ? { lat: 1.5, lng: 2.5, name: 'Somewhere', city: 'X', country: 'Y' } : undefined,
          faces: i % 3 ? [] : [face(`id${i}`, 0, 'p1')],
        }));
      }
      store.state.photos = photos;
      store.state.people = [{ id: 'p1', name: 'P', faceCount: 1, photoCount: 1 }];
      store.stampPersisted(photos, true); // as if just loaded from the DB
      await persist(); // warm: first save caches faces/entries

      // OLD algorithm (verbatim shape of the previous doSave scan), measured on the same data.
      const oldSig = (p: any): string => {
        let faceSig = '';
        if (p.faces) for (const f of p.faces) faceSig += `${f.id},${f.personId ?? ''},${f.isConfirmed ? 1 : 0},${f.isManual ? 1 : 0},${f.box?.x},${f.box?.y},${f.box?.width},${f.box?.height};`;
        return [p.filePath, p.fileName, p.fileSize, p.fileDate, p.dateTaken, p.year, p.month, p.day, p.width, p.height, p.isFavorite, p.isVirtual,
          p.originalRemotePath, p.storageName, p.isExcluded, p.faceScanCompleted, p.facesLocked, p.sharpnessScore, p.rotation, p.isHeicRotated,
          p.heicRotation, p.originalMtimeMs, p.exif ? JSON.stringify(p.exif) : '', p.location ? JSON.stringify(p.location) : '',
          p.faces ? p.faces.length : -1, faceSig].join('|');
      };
      const oldBaseline = new Map<string, string>();
      for (const p of photos) oldBaseline.set(p.id, oldSig(p));
      const oldScan = () => {
        for (const p of store.state.photos) if (p.faceScanCompleted || (p.faces && p.faces.length > 0)) store.cachePhotoFaces(p, p.faces || [], p.faceScanCompleted);
        store.state.photos.some((p: any) => p.faces && p.faces.length > 0);
        const cur = new Map<string, string>();
        for (const p of store.state.photos) cur.set(p.id, oldSig(p));
        for (const id of oldBaseline.keys()) if (!cur.has(id)) break;
        return store.state.photos.filter((p: any) => oldBaseline.get(p.id) !== cur.get(p.id));
      };

      const time = (fn: () => void, reps = 5) => {
        const ts: number[] = [];
        for (let i = 0; i < reps; i++) { const t = performance.now(); fn(); ts.push(performance.now() - t); }
        return ts.sort((a, b) => a - b)[Math.floor(ts.length / 2)];
      };
      const oldMs = time(oldScan);

      // NEW: one photo edited (object replaced, as toggleFavorite does), then a real save through the public path.
      const newTimes: number[] = [];
      let lastSent = 0;
      for (let i = 0; i < 5; i++) {
        store.toggleFavorite(`id${i * 7}`);
        if (store.saveDebounceTimer) { clearTimeout(store.saveDebounceTimer); store.saveDebounceTimer = null; }
        // toggleFavorite itself is O(N) (findIndex + array copy); time only the save
        const t = performance.now();
        await store.persistNow();
        newTimes.push(performance.now() - t);
        lastSent = saves.filter((s) => s.key === STORAGE_KEY).pop()!.data.photos.length;
      }
      newTimes.sort((a, b) => a - b);
      const newMs = newTimes[Math.floor(newTimes.length / 2)];
      expect(lastSent).toBe(1);

      // A forced full re-sign (every 20th save / blur) still costs about the old scan, but is amortised.
      store.forceFullResign = true;
      const t0 = performance.now();
      await store.persistNow();
      const fullMs = performance.now() - t0;

      console.log(`[bench 100k] old scan+filter: ${oldMs.toFixed(1)}ms  new save (1 edit): ${newMs.toFixed(1)}ms  forced full re-sign save: ${fullMs.toFixed(1)}ms  (1-in-${20} saves)`);
      expect(newMs).toBeLessThan(oldMs);
    }, 120_000);
  });

  describe('coalesced catalog-page notifications', () => {
    const page = (i: number) => Array.from({ length: 100 }, (_, k) => photo(`pg${i}_${k}`));

    it('notifies once (plus the final one) for a run of pages, with everything loaded at the end', async () => {
      await setup({ catalogPages: page });
      store.state.catalogMeta = { totalPages: 11, totalPhotos: 1100 };
      store.state.photos = page(0);
      store.currentCatalogPage = 0;
      let notifications = 0;
      let lastCount = 0;
      store.subscribe(() => { notifications++; lastCount = store.getState().photos.length; });

      await store.loadNextCatalogPages(10);
      expect(store.getState().photos).toHaveLength(1100);
      expect(lastCount).toBe(1100); // the last notification always sees the whole run
      expect(notifications).toBeLessThanOrEqual(3); // was 10 (one per page)
      expect(notifications).toBeGreaterThanOrEqual(1);
    });

    it('still notifies immediately for a single scroll-triggered page load', async () => {
      await setup({ catalogPages: page });
      store.state.catalogMeta = { totalPages: 5, totalPhotos: 500 };
      store.state.photos = page(0);
      store.currentCatalogPage = 0;
      let notifications = 0;
      store.subscribe(() => { notifications++; });
      await store.loadNextCatalogPage();
      await store.loadNextCatalogPage();
      expect(notifications).toBe(2);
    });

    it('a trailing page is flushed after the interval even if the run is still going', async () => {
      let release: (() => void) | null = null;
      await setup({ catalogPages: (i) => page(i) });
      vi.useFakeTimers();
      try {
        // page 3 hangs until released, keeping the run open
        const orig = (globalThis as any).window.electronAPI.getCatalogPage;
        (globalThis as any).window.electronAPI.getCatalogPage = async (a: any) => {
          if (a.pageIndex === 3) await new Promise<void>((r) => { release = r; });
          return orig(a);
        };
        store.state.catalogMeta = { totalPages: 6, totalPhotos: 600 };
        store.state.photos = page(0);
        store.currentCatalogPage = 0;
        let counts: number[] = [];
        store.subscribe(() => counts.push(store.getState().photos.length));
        const run = store.loadNextCatalogPages(5);
        await vi.advanceTimersByTimeAsync(0);
        // pages 1,2 done, page 3 in flight: the first notified at once, the second is pending on the timer
        expect(counts).toEqual([200]);
        await vi.advanceTimersByTimeAsync(300);
        expect(counts[counts.length - 1]).toBe(300);
        release!();
        await vi.advanceTimersByTimeAsync(0);
        await run;
        expect(counts[counts.length - 1]).toBe(600);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
