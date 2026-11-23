import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { DatabaseSync } from 'node:sqlite';
import { resetDbForTests, setActiveLibrary, getDbForLibraryPath } from '../../src/main/services/db';
import { writeZipStream, backupDatabases, type DbBackupSource } from '../../src/main/services/dbBackupService';

/** Minimal zip reader (central directory) — independent of the writer, so the test checks the real format. */
function readZip(file: string): Map<string, Buffer> {
  const buf = fs.readFileSync(file);
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  expect(eocd).toBeGreaterThanOrEqual(0);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    const dataStart = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
    const data = method === 8 ? zlib.inflateRawSync(buf.subarray(dataStart, dataStart + csize)) : buf.subarray(dataStart, dataStart + csize);
    expect(data.length).toBe(usize);
    expect(zlib.crc32(data) >>> 0).toBe(crc);
    out.set(name, data);
    p += 46 + nlen + elen + clen;
  }
  return out;
}

describe('database backup', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gphotos_dbbackup_test_'));
    process.env.GPHOTOS_TEST_DB_DIR = path.join(dir, 'userdata');
    fs.mkdirSync(process.env.GPHOTOS_TEST_DB_DIR, { recursive: true });
    resetDbForTests();
  });
  afterEach(() => {
    resetDbForTests();
    delete process.env.GPHOTOS_TEST_DB_DIR;
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch {}
  });

  it('the zip writer streams a large file and small literals into a valid archive', async () => {
    const big = path.join(dir, 'big.bin');
    const data = Buffer.alloc(5 * 1024 * 1024);
    for (let i = 0; i < data.length; i++) data[i] = (i * 31 + (i >> 8)) & 0xff; // compressible but not trivial
    fs.writeFileSync(big, data);
    const zip = path.join(dir, 'out.zip');
    await writeZipStream(zip, [{ name: 'note.txt', content: 'héllo' }, { name: 'sub/big.bin', filePath: big }]);
    const files = readZip(zip);
    expect([...files.keys()]).toEqual(['note.txt', 'sub/big.bin']);
    expect(files.get('note.txt')!.toString('utf8')).toBe('héllo');
    expect(files.get('sub/big.bin')!.equals(data)).toBe(true);
  });

  it('a library backup holds a consistent copy of its database (including recent WAL writes) and a manifest', async () => {
    const lib = path.join(dir, 'Library One');
    fs.mkdirSync(lib, { recursive: true });
    const db = getDbForLibraryPath(lib);
    db.exec("CREATE TABLE IF NOT EXISTS backup_probe (id INTEGER PRIMARY KEY, note TEXT)");
    db.prepare('INSERT INTO backup_probe (note) VALUES (?)').run('face data survives');
    const src: DbBackupSource = { id: lib, kind: 'library', label: 'Library One', detail: '\\\\nas\\photos', dir: lib, dbPath: path.join(lib, '.gphotos_catalog', 'gphotos.db'), sizeBytes: 1 };
    const dest = path.join(dir, 'backups');
    const results = await backupDatabases([src], dest, '9.9.9');
    expect(results).toHaveLength(1);
    expect(results[0].error).toBeUndefined();
    expect(results[0].success).toBe(true);
    expect(path.basename(results[0].zipPath!)).toMatch(/^gPhotos_Library One_\d{8}_\d{6}\.zip$/);

    const files = readZip(results[0].zipPath!);
    const manifest = JSON.parse(files.get('backup_manifest.json')!.toString('utf8'));
    expect(manifest).toMatchObject({ version: '9.9.9', kind: 'library', name: 'Library One', source: '\\\\nas\\photos' });
    const restored = path.join(dir, 'restored.db');
    fs.writeFileSync(restored, files.get('gphotos.db')!);
    const check = new DatabaseSync(restored);
    expect((check.prepare('SELECT note FROM backup_probe').get() as any).note).toBe('face data survives');
    check.close();
    expect(fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith(`gphotos_dbbackup_${process.pid}_`))).toEqual([]); // snapshot cleaned up
  });

  it('the global database gets its own zip, and one failing source does not stop the others', async () => {
    setActiveLibrary(null);
    const lib = path.join(dir, 'Broken');
    fs.mkdirSync(lib, { recursive: true });
    const sources: DbBackupSource[] = [
      { id: 'global', kind: 'global', label: 'People & settings (all libraries)', dir: null, dbPath: '', sizeBytes: 1 },
      { id: lib, kind: 'library', label: 'Broken', dir: path.join(dir, 'does-not-exist', 'x\0y'), dbPath: '', sizeBytes: 1 },
    ];
    const results = await backupDatabases(sources, path.join(dir, 'backups'), '1.0.0');
    expect(results[0].success).toBe(true);
    expect(path.basename(results[0].zipPath!)).toMatch(/^gPhotos_People-and-settings_/);
    expect(readZip(results[0].zipPath!).has('gphotos.db')).toBe(true);
    expect(results[1].success).toBe(false);
    expect(results[1].error).toBeTruthy();
  });
});
