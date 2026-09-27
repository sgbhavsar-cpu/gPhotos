import fs from 'fs';
import path from 'path';
import type { DatabaseSync } from 'node:sqlite';
import { getDb, getDbForLibraryPath } from './db';
import { getSetting, remapPhotoIdInDb, remapPeopleCoversForPhoto } from './libraryRepository';
import { assertPathsAllowed } from './pathSecurity';
import { isPathReachable } from './networkReachabilityCache';
import { moveHeicSavedRotation } from './heicRotationStore';
import { photoIdForSidecar } from './pipelineOrchestrator';
import { getPendingRotations, savePendingRotations, getPendingMetadata, savePendingMetadata } from './virtualMirrorService';
import { purgeCachedThumbnailsForFile } from './thumbnailCacheService';
import { writeJsonAtomic, writeFileAtomic } from './jsonFile';
import type { VirtualStorageConfig } from '../../types';

/**
 * Physically moves photos to another folder INSIDE the library / network storage they already live in,
 * keeping every reference consistent (photo id and face ids are derived from paths).
 *
 *  - plain library photo: id = base64(filePath)
 *  - virtual-storage photo: the original lives on the network source; a local mirror thumbnail
 *    (mirrorRoot/<storage>/<relative dir>/<file name>) + sidecar `.json` mirror its folder layout and
 *    id = base64(thumbnail path). Moving the original therefore also moves the mirror pair, so the next
 *    sync sees the exact layout it would have produced itself (no duplicates, no prune).
 *
 * Nothing is ever overwritten or deleted: names are made unique, a failed photo is rolled back completely.
 */

export interface RelocationPhotoInput {
  id: string;
  filePath: string;
  fileName: string;
  originalRemotePath?: string;
  isVirtual?: boolean;
  storageName?: string;
}
export interface RelocationRoot { kind: 'storage' | 'library'; label: string; path: string }
export interface RelocationPlan {
  root: RelocationRoot | null;
  movableIds: string[];
  skipped: Array<{ id: string; fileName: string; reason: string }>;
}
export interface RelocationItemResult {
  oldId: string;
  status: 'moved' | 'skipped' | 'failed';
  reason?: string;
  newId?: string;
  newFilePath?: string;
  newOriginalRemotePath?: string;
  newFileName?: string;
}

const WIN = process.platform === 'win32';
const COMPANION_STEM_EXTS = ['.xmp', '.aae'];

// ---------------------------------------------------------------------------
// path helpers
// ---------------------------------------------------------------------------

/** Lexical comparison key: resolved, case-folded on Windows, no trailing separator. */
function fold(p: string): string {
  let r = path.resolve(p);
  if (WIN) r = r.toLowerCase();
  const root = path.parse(r).root;
  return r.length > root.length ? r.replace(/[\\/]+$/, '') : r;
}

function isInside(child: string, parent: string): boolean {
  const c = fold(child);
  const p = fold(parent);
  if (c === p) return true;
  return c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

/** realpath of the nearest existing ancestor + the missing tail (UNC left lexical, like pathSecurity). */
function realLoose(p: string): string {
  const abs = path.resolve(p);
  if (WIN && /^[\\/]{2}/.test(abs)) return abs;
  let cur = abs;
  let tail = '';
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(cur), tail);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      tail = tail ? path.join(path.basename(cur), tail) : path.basename(cur);
      cur = parent;
    }
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.promises.lstat(p);
    return true;
  } catch {
    return false;
  }
}

function errMsg(e: unknown): string {
  return (e as any)?.message || String(e);
}

/**
 * Directory segments from `rootPath` to `target` using the ON-DISK casing (Windows is case-insensitive, and the
 * sync derives mirror paths / ids from the casing the directory scan reports).
 */
async function canonicalRelSegments(rootPath: string, target: string): Promise<string[]> {
  const rel = path.relative(rootPath, target);
  if (!rel) return [];
  const out: string[] = [];
  let cur = rootPath;
  for (const seg of rel.split(/[\\/]+/).filter(Boolean)) {
    let actual = seg;
    if (WIN) {
      try {
        const names = await fs.promises.readdir(cur);
        if (!names.includes(seg)) {
          const hit = names.find((n) => n.toLowerCase() === seg.toLowerCase());
          if (hit) actual = hit;
        }
      } catch {}
    }
    out.push(actual);
    cur = path.join(cur, actual);
  }
  return out;
}

// ---------------------------------------------------------------------------
// filesystem moves (never overwrite)
// ---------------------------------------------------------------------------

async function crossDeviceMove(src: string, dst: string): Promise<void> {
  const st = await fs.promises.stat(src);
  await fs.promises.copyFile(src, dst, fs.constants.COPYFILE_EXCL);
  try {
    const copied = await fs.promises.stat(dst);
    if (copied.size !== st.size) throw new Error(`Copy verification failed for ${dst} (size mismatch)`);
    await fs.promises.utimes(dst, st.atime, st.mtime); // keep mtime: the sync's "unchanged" check compares it
    await fs.promises.unlink(src);
  } catch (e) {
    try { await fs.promises.unlink(dst); } catch {} // our own partial copy only; the source is intact
    throw e;
  }
}

/** rename src -> dst; refuses when dst exists; EXDEV falls back to copy + size verify + unlink. */
async function moveFile(src: string, dst: string): Promise<void> {
  if (await exists(dst)) throw new Error(`Destination already exists: ${dst}`);
  try {
    await fs.promises.rename(src, dst);
  } catch (e: any) {
    if (e?.code !== 'EXDEV') throw e;
    await crossDeviceMove(src, dst);
  }
}

// ---------------------------------------------------------------------------
// roots / planning
// ---------------------------------------------------------------------------

interface Home {
  key: string;
  root: RelocationRoot;
  storage?: VirtualStorageConfig;
  /** Folder whose per-library database holds this photo (storage mirror folder / library folder). */
  dbRoot: string;
}

function loadStorages(): VirtualStorageConfig[] {
  try {
    const s = getSetting<VirtualStorageConfig[]>('gphotos_virtual_storages_v1', []);
    return Array.isArray(s) ? s.filter((x) => x && x.name && x.networkSourcePath && x.localMirrorRoot) : [];
  } catch {
    return [];
  }
}

function loadLibraries(): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (p: unknown) => {
    if (typeof p !== 'string' || !p || !path.isAbsolute(p)) return;
    const k = fold(p);
    if (!seen.has(k)) { seen.add(k); out.push(p); }
  };
  try { add(getSetting<string | null>('selectedFolder', null)); } catch {}
  try { for (const l of getSetting<string[]>('recentLibraries', [])) add(l); } catch {}
  return out;
}

function resolveHome(p: RelocationPhotoInput, storages: VirtualStorageConfig[], libs: string[]): { home?: Home; reason?: string } {
  if (p.isVirtual || p.originalRemotePath) {
    if (!p.originalRemotePath) return { reason: 'No original file path is recorded for this photo.' };
    const containing = storages.filter((s) => isInside(p.originalRemotePath!, s.networkSourcePath));
    const best =
      containing.find((s) => p.storageName && s.name.toLowerCase() === p.storageName.toLowerCase()) ??
      containing.sort((a, b) => fold(b.networkSourcePath).length - fold(a.networkSourcePath).length)[0];
    if (!best) return { reason: `Not inside a configured network storage${p.storageName ? ` ("${p.storageName}")` : ''}.` };
    return {
      home: {
        key: `storage:${best.name.toLowerCase()}`,
        root: { kind: 'storage', label: best.name, path: best.networkSourcePath },
        storage: best,
        dbRoot: path.join(best.localMirrorRoot, best.name),
      },
    };
  }
  const lib = libs.filter((l) => isInside(p.filePath, l)).sort((a, b) => fold(b).length - fold(a).length)[0];
  if (!lib) return { reason: 'Not inside a known library folder.' };
  return { home: { key: `library:${fold(lib)}`, root: { kind: 'library', label: path.basename(lib) || lib, path: lib }, dbRoot: lib } };
}

function sourceOf(p: RelocationPhotoInput, home: Home): string {
  return home.storage ? p.originalRemotePath! : p.filePath;
}

interface InternalPlan {
  plan: RelocationPlan;
  homes: Map<string, Home>; // movable photo id -> home
  photos: Map<string, RelocationPhotoInput>;
}

async function buildPlan(inputPhotos: RelocationPhotoInput[]): Promise<InternalPlan> {
  const storages = loadStorages();
  const libs = loadLibraries();
  const skipped: RelocationPlan['skipped'] = [];
  const skip = (p: RelocationPhotoInput, reason: string) => skipped.push({ id: p.id, fileName: p.fileName, reason });

  const photos = new Map<string, RelocationPhotoInput>();
  for (const p of inputPhotos) if (p && p.id && !photos.has(p.id)) photos.set(p.id, p);

  const groups = new Map<string, { home: Home; items: RelocationPhotoInput[] }>();
  for (const p of photos.values()) {
    const { home, reason } = resolveHome(p, storages, libs);
    if (!home) { skip(p, reason!); continue; }
    const g = groups.get(home.key);
    if (g) g.items.push(p);
    else groups.set(home.key, { home, items: [p] });
  }

  // Reachability once per root; the biggest REACHABLE root wins (first seen on a tie).
  const reachable = new Map<string, boolean>();
  for (const [k, g] of groups) reachable.set(k, await isPathReachable(g.home.root.path));
  let best: { home: Home; items: RelocationPhotoInput[] } | null = null;
  for (const [k, g] of groups) {
    if (reachable.get(k) && (!best || g.items.length > best.items.length)) best = g;
  }
  for (const [k, g] of groups) {
    if (g === best) continue;
    for (const p of g.items) {
      if (!reachable.get(k)) {
        skip(p, g.home.root.kind === 'storage'
          ? `Storage "${g.home.root.label}" is offline or unreachable right now.`
          : `Library folder "${g.home.root.label}" is not reachable right now.`);
      } else {
        skip(p, `Belongs to ${g.home.root.kind === 'storage' ? 'storage' : 'library'} "${g.home.root.label}"; only one location can be moved at a time.`);
      }
    }
  }

  const movable: string[] = [];
  const homes = new Map<string, Home>();
  if (best) {
    const CHUNK = 16;
    for (let i = 0; i < best.items.length; i += CHUNK) {
      await Promise.all(
        best.items.slice(i, i + CHUNK).map(async (p) => {
          const src = sourceOf(p, best!.home);
          if (!(await exists(src))) return skip(p, best!.home.storage ? 'The original file is missing from the storage.' : 'The file is missing from disk.');
          if (best!.home.storage && !(await exists(p.filePath))) return skip(p, 'The local mirror copy is missing; sync the storage first.');
          movable.push(p.id);
          homes.set(p.id, best!.home);
        })
      );
    }
  }
  // keep the caller's order
  const order = new Map(Array.from(photos.keys()).map((id, i) => [id, i] as const));
  movable.sort((a, b) => order.get(a)! - order.get(b)!);
  skipped.sort((a, b) => order.get(a.id)! - order.get(b.id)!);

  return { plan: { root: best ? best.home.root : null, movableIds: movable, skipped }, homes, photos };
}

export async function planRelocation(photos: RelocationPhotoInput[]): Promise<RelocationPlan> {
  return (await buildPlan(photos)).plan;
}

// ---------------------------------------------------------------------------
// queues that store paths
// ---------------------------------------------------------------------------

const normKey = (s: string) => s.toLowerCase().replace(/\\/g, '/');
const queueId = (s: string) => Buffer.from(s).toString('base64').replace(/[/+=]/g, '_');

/** Re-points pending rotation / metadata queue entries from old paths to new ones. Throws if a queue cannot be saved. */
function remapQueues(pairs: Array<[string, string]>): void {
  const map = new Map(pairs.map(([a, b]) => [normKey(a), b] as const));
  const rot = getPendingRotations();
  let changed = false;
  for (const it of rot) {
    const o = map.get(normKey(it.originalRemotePath || ''));
    if (o) { it.originalRemotePath = o; it.id = queueId(o); changed = true; }
    const l = it.localFilePath ? map.get(normKey(it.localFilePath)) : undefined;
    if (l) { it.localFilePath = l; changed = true; }
  }
  if (changed && !savePendingRotations(rot)) throw new Error('Could not update the pending rotation queue');
  const meta = getPendingMetadata();
  changed = false;
  for (const it of meta) {
    const o = map.get(normKey(it.originalRemotePath || ''));
    if (o) { it.originalRemotePath = o; it.id = queueId(o); changed = true; }
  }
  if (changed && !savePendingMetadata(meta)) throw new Error('Could not update the pending metadata queue');
}

// ---------------------------------------------------------------------------
// one photo
// ---------------------------------------------------------------------------

async function movePhoto(p: RelocationPhotoInput, home: Home, targetDir: string, relSegs: string[]): Promise<RelocationItemResult> {
  const oldId = p.id;
  const srcOrig = sourceOf(p, home);
  const storage = home.storage;
  if (fold(path.dirname(srcOrig)) === fold(targetDir)) {
    return { oldId, status: 'skipped', reason: 'Already in this folder.' };
  }

  const undo: Array<() => Promise<void> | void> = [];
  const undoErrors: string[] = [];
  const srcDir = path.dirname(srcOrig);
  const oldName = path.basename(srcOrig);
  const ext = path.extname(oldName);
  const stem = path.basename(oldName, ext);

  try {
    // Companions that exist next to the original (dst names are derived per candidate name below).
    const companions: Array<{ src: string; suffix: (newName: string) => string }> = [];
    for (const e of COMPANION_STEM_EXTS) {
      const s = path.join(srcDir, stem + e);
      if (await exists(s)) companions.push({ src: s, suffix: (n) => path.basename(n, path.extname(n)) + e });
    }
    const bak = path.join(srcDir, oldName + '.bak');
    if (await exists(bak)) companions.push({ src: bak, suffix: (n) => n + '.bak' });

    // Mirror pair (virtual only). The sidecar is read/parsed BEFORE anything moves so a corrupt one fails early.
    const oldThumb = p.filePath;
    const oldSidecar = path.join(path.dirname(oldThumb), path.basename(oldThumb, path.extname(oldThumb)) + '.json');
    let sidecarRaw: string | null = null;
    let sidecarMeta: any = null;
    if (storage) {
      try {
        sidecarRaw = await fs.promises.readFile(oldSidecar, 'utf-8');
      } catch (e: any) {
        if (e?.code !== 'ENOENT') throw e;
      }
      if (sidecarRaw !== null) {
        try { sidecarMeta = JSON.parse(sidecarRaw); } catch { throw new Error(`The mirror sidecar is unreadable: ${oldSidecar}`); }
      }
    }
    const newThumbDir = storage ? path.join(home.dbRoot, ...relSegs) : '';
    const dbs = Array.from(new Set<DatabaseSync>([getDbForLibraryPath(home.dbRoot), getDb()]));

    // Pick a destination name that collides with nothing (original, companions, mirror pair, existing catalog ids).
    let newName = oldName;
    let picked: { newOrig: string; newThumb: string; newId: string; newSidecar: string; compDst: string[] } | null = null;
    for (let n = 0; n <= 999 && !picked; n++) {
      newName = n === 0 ? oldName : `${stem} (${n})${ext}`;
      const newOrig = path.join(targetDir, newName);
      const newThumb = storage ? path.join(newThumbDir, newName) : newOrig;
      const newSidecar = storage ? path.join(newThumbDir, path.basename(newName, path.extname(newName)) + '.json') : '';
      const newId = storage ? photoIdForSidecar(newThumb) : Buffer.from(newOrig).toString('base64');
      const compDst = companions.map((c) => path.join(targetDir, c.suffix(newName)));
      const probes = [newOrig, ...compDst, ...(storage ? [newThumb, newSidecar] : [])];
      let clash = false;
      for (const q of probes) if (await exists(q)) { clash = true; break; }
      if (!clash) {
        for (const db of dbs) {
          if (db.prepare('SELECT 1 FROM photos WHERE id = ?').get(newId)) { clash = true; break; }
        }
      }
      if (!clash) picked = { newOrig, newThumb, newId, newSidecar, compDst };
    }
    if (!picked) throw new Error('Could not find a free file name in the target folder.');
    const { newOrig, newThumb, newId, newSidecar, compDst } = picked;

    const touched = [srcOrig, newOrig, ...companions.map((c) => c.src), ...compDst];
    if (storage) touched.push(oldThumb, newThumb, oldSidecar, newSidecar);
    assertPathsAllowed(touched, 'move photo');

    let oldMtime: number | undefined;
    try { oldMtime = (await fs.promises.stat(srcOrig)).mtimeMs; } catch {}
    let oldThumbMtime: number | undefined;
    if (storage) { try { oldThumbMtime = (await fs.promises.stat(oldThumb)).mtimeMs; } catch {} }

    // (2) the original + companions
    await moveFile(srcOrig, newOrig);
    undo.push(() => moveFile(newOrig, srcOrig));
    for (let i = 0; i < companions.length; i++) {
      const c = companions[i];
      const d = compDst[i];
      await moveFile(c.src, d);
      undo.push(() => moveFile(d, c.src));
    }

    // (3) mirror thumbnail + sidecar (virtual only)
    let newOriginalRemotePath: string | undefined;
    if (storage) {
      newOriginalRemotePath = newOrig;
      await fs.promises.mkdir(newThumbDir, { recursive: true });
      await moveFile(oldThumb, newThumb);
      undo.push(() => moveFile(newThumb, oldThumb));
      if (sidecarMeta) {
        await moveFile(oldSidecar, newSidecar);
        undo.push(async () => {
          await moveFile(newSidecar, oldSidecar);
          writeFileAtomic(oldSidecar, sidecarRaw as string); // exact original content
        });
        const meta = { ...sidecarMeta };
        meta.fileName = newName;
        meta.originalFilePath = newOrig;
        meta.thumbnailPath = newThumb;
        meta.relativePath = path.relative(storage.networkSourcePath, newOrig);
        if (Array.isArray(meta.faces)) {
          meta.faces = meta.faces.map((f: any) =>
            f && typeof f === 'object'
              ? {
                  ...f,
                  photoId: newId,
                  id: typeof f.id === 'string' && f.id.startsWith(oldId) ? newId + f.id.slice(oldId.length) : f.id,
                }
              : f
          );
        }
        writeJsonAtomic(newSidecar, meta);
      }
    }

    // (4) database: one transaction per database, then the global people covers
    const remap = {
      oldId,
      newId,
      filePath: storage ? newThumb : newOrig,
      fileName: newName,
      originalRemotePath: newOriginalRemotePath,
    };
    const back = { oldId: newId, newId: oldId, filePath: p.filePath, fileName: p.fileName, originalRemotePath: storage ? p.originalRemotePath : undefined };
    for (const db of dbs) {
      remapPhotoIdInDb(db, remap);
      undo.push(() => remapPhotoIdInDb(db, back));
    }
    remapPeopleCoversForPhoto(oldId, newId);
    undo.push(() => remapPeopleCoversForPhoto(newId, oldId));

    // (4b) path-keyed side stores: rotation flags + offline queues
    const pairs: Array<[string, string]> = storage ? [[oldThumb, newThumb], [srcOrig, newOrig]] : [[srcOrig, newOrig]];
    const movedFlags: Array<[string, string]> = [];
    for (const [a, b] of pairs) if (moveHeicSavedRotation(a, b)) movedFlags.push([a, b]);
    if (movedFlags.length) undo.push(() => { for (const [a, b] of movedFlags) moveHeicSavedRotation(b, a); });
    remapQueues(pairs);
    undo.push(() => remapQueues(pairs.map(([a, b]) => [b, a] as [string, string])));

    // Stale cache entries for the old paths (best effort; keys are path-derived so they can no longer be hit).
    try { await purgeCachedThumbnailsForFile(srcOrig, oldMtime); } catch {}
    if (storage) { try { await purgeCachedThumbnailsForFile(oldThumb, oldThumbMtime); } catch {} }

    return {
      oldId,
      status: 'moved',
      newId,
      newFilePath: storage ? newThumb : newOrig,
      newOriginalRemotePath,
      newFileName: newName,
    };
  } catch (e) {
    for (const step of undo.reverse()) {
      try { await step(); } catch (ue) { undoErrors.push(errMsg(ue)); }
    }
    return {
      oldId,
      status: 'failed',
      reason: errMsg(e) + (undoErrors.length ? ` (rollback incomplete: ${undoErrors.join('; ')})` : ''),
    };
  }
}

// ---------------------------------------------------------------------------
// public entry
// ---------------------------------------------------------------------------

// Runs are serialized: two overlapping relocations could pick the same free name.
let runChain: Promise<unknown> = Promise.resolve();

export function relocatePhotos(params: {
  photos: RelocationPhotoInput[];
  targetDir: string;
  onProgress?: (done: number, total: number) => void;
}): Promise<{ results: RelocationItemResult[]; root: RelocationRoot | null; error?: string }> {
  const run = runChain.then(() => relocateImpl(params), () => relocateImpl(params));
  runChain = run.catch(() => undefined);
  return run;
}

async function relocateImpl(params: {
  photos: RelocationPhotoInput[];
  targetDir: string;
  onProgress?: (done: number, total: number) => void;
}): Promise<{ results: RelocationItemResult[]; root: RelocationRoot | null; error?: string }> {
  const { targetDir, onProgress } = params;
  const { plan, homes, photos } = await buildPlan(params.photos || []);
  const skippedById = new Map(plan.skipped.map((s) => [s.id, s.reason] as const));
  const all = Array.from(photos.values());
  const total = all.length;

  const failRun = (error: string) => ({
    root: plan.root,
    error,
    results: all.map<RelocationItemResult>((p) => ({ oldId: p.id, status: 'skipped', reason: skippedById.get(p.id) ?? error })),
  });

  if (!plan.root || plan.movableIds.length === 0) {
    return failRun(plan.root ? 'None of the selected photos can be moved.' : 'None of the selected photos can be moved (no reachable library or storage found).');
  }
  const root = plan.root;

  if (typeof targetDir !== 'string' || !targetDir || targetDir.includes('\0') || !path.isAbsolute(targetDir)) {
    return failRun('The destination must be an absolute folder path.');
  }
  const target = path.resolve(targetDir);
  if (!isInside(target, root.path) || !isInside(realLoose(target), realLoose(root.path))) {
    return failRun(`The destination must be inside "${root.label}" (${root.path}).`);
  }
  try {
    assertPathsAllowed([target], 'move photo destination');
  } catch (e) {
    return failRun(errMsg(e));
  }
  try {
    await fs.promises.mkdir(target, { recursive: true });
    if (!(await fs.promises.stat(target)).isDirectory()) throw new Error('not a folder');
  } catch (e) {
    return failRun(`Cannot use the destination folder: ${errMsg(e)}`);
  }
  // A junction created/found meanwhile could still point outside the root.
  if (!isInside(realLoose(target), realLoose(root.path))) {
    return failRun(`The destination must be inside "${root.label}" (${root.path}).`);
  }

  const relSegs = await canonicalRelSegments(root.path, target);
  const canonTarget = path.join(root.path, ...relSegs);

  const results: RelocationItemResult[] = [];
  let done = 0;
  for (const p of all) {
    const home = homes.get(p.id);
    let r: RelocationItemResult;
    if (!home) {
      r = { oldId: p.id, status: 'skipped', reason: skippedById.get(p.id) ?? 'Cannot be moved.' };
    } else {
      try {
        r = await movePhoto(p, home, canonTarget, relSegs);
      } catch (e) {
        r = { oldId: p.id, status: 'failed', reason: errMsg(e) };
      }
    }
    results.push(r);
    done++;
    try { onProgress?.(done, total); } catch {}
  }
  return { results, root };
}
