// Database backups: one .zip per library (network-drive mirror or local library) plus one for the global database
// (people registry, settings). Each zip holds a transactionally consistent snapshot of the SQLite file (VACUUM INTO — the live
// DB runs in WAL mode, so a plain file copy would miss recent commits) and a small manifest. The zip is written as a stream,
// so a database of many hundreds of MB never has to fit in memory.
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { getDbPath, getDbForLibraryPath, getGlobalDb } from './db';
import { discoverStoredMirrors } from './virtualMirrorService';
import { getDefaultMirrorRoot } from './pathSecurity';
import { getSetting } from './libraryRepository';

export interface DbBackupSource {
  /** 'global' or the library folder path. */
  id: string;
  kind: 'global' | 'library';
  label: string;
  /** Where the library's data comes from (the network drive / source folder), when known. */
  detail?: string;
  dir: string | null;
  dbPath: string;
  sizeBytes: number;
}

const GLOBAL_ID = 'global';

/** Every database that can be backed up: the global one, each stored mirror, and each recent local library that has a catalog. */
export function listDbBackupSources(): DbBackupSource[] {
  const out: DbBackupSource[] = [];
  const size = (p: string) => { try { return fs.statSync(p).size; } catch { return 0; } };
  const globalPath = getDbPath(null);
  out.push({ id: GLOBAL_ID, kind: 'global', label: 'People & settings (all libraries)', detail: 'The shared database: the people registry and app settings', dir: null, dbPath: globalPath, sizeBytes: size(globalPath) });
  const seen = new Set<string>();
  const add = (dir: string, label: string, detail?: string) => {
    const key = path.resolve(dir).toLowerCase();
    if (seen.has(key)) return;
    const dbPath = path.join(dir, '.gphotos_catalog', 'gphotos.db');
    if (!fs.existsSync(dbPath)) return;
    seen.add(key);
    out.push({ id: dir, kind: 'library', label, detail, dir, dbPath, sizeBytes: size(dbPath) });
  };
  try {
    const root = getDefaultMirrorRoot();
    for (const m of discoverStoredMirrors()) add(path.join(m.localMirrorRoot || root, m.name), m.name, m.networkSourcePath || undefined);
  } catch {}
  try {
    for (const dir of getSetting<string[]>('recentLibraries', []) || []) if (typeof dir === 'string' && dir) add(dir, path.basename(dir) || dir, dir);
  } catch {}
  return out;
}

export interface ZipFileInput {
  name: string;
  /** Either a file to stream in, or literal content. */
  filePath?: string;
  content?: string | Buffer;
}

const ZIP32_MAX = 0xfffffffe;

/** Writes a standard .zip (deflate, data descriptors) to `outPath`. Entries over 4 GB are not supported (no zip64). */
export async function writeZipStream(outPath: string, entries: ZipFileInput[]): Promise<void> {
  const out = fs.createWriteStream(outPath);
  let offset = 0;
  const central: Buffer[] = [];
  const write = (buf: Buffer) => new Promise<void>((resolve, reject) => { out.write(buf, (err) => (err ? reject(err) : resolve())); offset += buf.length; });
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  try {
    for (const entry of entries) {
      const nameBuf = Buffer.from(entry.name.replace(/\\/g, '/'), 'utf8');
      const headerOffset = offset;
      const lh = Buffer.alloc(30 + nameBuf.length);
      lh.writeUInt32LE(0x04034b50, 0);
      lh.writeUInt16LE(20, 4);
      lh.writeUInt16LE(0x0808, 6); // UTF-8 names + sizes/crc follow in a data descriptor
      lh.writeUInt16LE(8, 8);      // deflate
      lh.writeUInt16LE(dosTime, 10);
      lh.writeUInt16LE(dosDate, 12);
      lh.writeUInt16LE(nameBuf.length, 26);
      nameBuf.copy(lh, 30);
      await write(lh);

      let crc = 0, usize = 0, csize = 0;
      const deflate = zlib.createDeflateRaw({ level: 6 });
      const drained = new Promise<void>((resolve, reject) => {
        deflate.on('data', (chunk: Buffer) => { csize += chunk.length; if (!out.write(chunk)) { deflate.pause(); out.once('drain', () => deflate.resume()); } });
        deflate.on('end', resolve);
        deflate.on('error', reject);
        out.on('error', reject);
      });
      const feed = (chunk: Buffer) => { crc = zlib.crc32(chunk, crc); usize += chunk.length; return deflate.write(chunk) || new Promise<void>((r) => deflate.once('drain', () => r())); };
      if (entry.filePath) {
        for await (const chunk of fs.createReadStream(entry.filePath, { highWaterMark: 1 << 20 })) await feed(chunk as Buffer);
      } else {
        await feed(Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content ?? '', 'utf8'));
      }
      deflate.end();
      await drained;
      offset += csize;
      if (usize > ZIP32_MAX || csize > ZIP32_MAX) throw new Error(`"${entry.name}" is larger than 4 GB, which the zip format used here cannot hold.`);

      const dd = Buffer.alloc(16);
      dd.writeUInt32LE(0x08074b50, 0); dd.writeUInt32LE(crc >>> 0, 4); dd.writeUInt32LE(csize, 8); dd.writeUInt32LE(usize, 12);
      await write(dd);

      const ch = Buffer.alloc(46 + nameBuf.length);
      ch.writeUInt32LE(0x02014b50, 0);
      ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
      ch.writeUInt16LE(0x0808, 8); ch.writeUInt16LE(8, 10);
      ch.writeUInt16LE(dosTime, 12); ch.writeUInt16LE(dosDate, 14);
      ch.writeUInt32LE(crc >>> 0, 16); ch.writeUInt32LE(csize, 20); ch.writeUInt32LE(usize, 24);
      ch.writeUInt16LE(nameBuf.length, 28);
      ch.writeUInt32LE(headerOffset, 42);
      nameBuf.copy(ch, 46);
      central.push(ch);
    }
    const cd = Buffer.concat(central);
    const cdOffset = offset;
    await write(cd);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(cdOffset, 16);
    await write(eocd);
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
  } catch (err) {
    out.destroy();
    try { fs.unlinkSync(outPath); } catch {}
    throw err;
  }
}

const safeName = (s: string) => s.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || 'library';

export interface DbBackupResult {
  id: string;
  label: string;
  success: boolean;
  zipPath?: string;
  zipBytes?: number;
  error?: string;
}

/** Backs up the given sources into `destDir`, one zip each, sequentially. Never throws: each result carries its own error. */
export async function backupDatabases(
  chosen: DbBackupSource[],
  destDir: string,
  appVersion: string,
  onProgress?: (p: { index: number; total: number; label: string }) => void
): Promise<DbBackupResult[]> {
  fs.mkdirSync(destDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '_');
  const results: DbBackupResult[] = [];
  for (let i = 0; i < chosen.length; i++) {
    const src = chosen[i];
    onProgress?.({ index: i, total: chosen.length, label: src.label });
    const snapshot = path.join(os.tmpdir(), `gphotos_dbbackup_${process.pid}_${Date.now()}_${i}.db`);
    const zipPath = path.join(destDir, `gPhotos_${src.kind === 'global' ? 'People-and-settings' : safeName(src.label)}_${stamp}.zip`);
    try {
      // getDbPath() quietly falls back to the global database for a folder that is missing (a disconnected drive) — a zip of the
      // wrong database under this library's name would be worse than no zip.
      if (src.dir && !fs.existsSync(path.join(src.dir, '.gphotos_catalog', 'gphotos.db'))) throw new Error('The database for this library was not found (is the drive connected?).');
      const db = src.dir ? getDbForLibraryPath(src.dir) : getGlobalDb();
      db.exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`);
      const manifest = {
        app: 'gPhotos Desktop', version: appVersion, createdAt: new Date().toISOString(), kind: src.kind, name: src.label,
        source: src.detail ?? null, database: 'gphotos.db',
        restore: src.kind === 'global' ? 'Close gPhotos, then replace gphotos.db in the gPhotos folder under %APPDATA% with this file.' : 'Close gPhotos, then replace <library folder>\\.gphotos_catalog\\gphotos.db with this file.',
      };
      await writeZipStream(zipPath, [{ name: 'backup_manifest.json', content: JSON.stringify(manifest, null, 2) }, { name: 'gphotos.db', filePath: snapshot }]);
      results.push({ id: src.id, label: src.label, success: true, zipPath, zipBytes: fs.statSync(zipPath).size });
    } catch (err: any) {
      results.push({ id: src.id, label: src.label, success: false, error: err?.message || String(err) });
    } finally {
      try { fs.unlinkSync(snapshot); } catch {}
    }
  }
  return results;
}
