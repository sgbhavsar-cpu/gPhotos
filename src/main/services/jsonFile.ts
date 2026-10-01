import fs from 'fs';

let tmpCounter = 0;

/** Synchronous pause for the rare rename retry (renames are already sync here; waits are ~ms). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Writes `data` to `filePath` via a temp file in the same directory plus a
 * rename, so a crash / power loss / network drop mid-write can never leave a
 * truncated file at the final path. Throws on failure (temp file is cleaned up).
 */
export function writeFileAtomic(filePath: string, data: string | Buffer, mode?: number): void {
  // Unique per call: two writes to the same file in the same millisecond must not share a temp file.
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${++tmpCounter}`;
  try {
    if (typeof data === 'string') fs.writeFileSync(tmp, data, mode === undefined ? 'utf-8' : { encoding: 'utf-8', mode });
    else fs.writeFileSync(tmp, data, mode === undefined ? undefined : { mode });
    // On Windows a rename onto a file that is momentarily open (antivirus, indexer, another reader)
    // fails with EPERM/EBUSY/EACCES; those clear within milliseconds, so retry briefly.
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(tmp, filePath);
        break;
      } catch (err: any) {
        const transient = err && (err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES');
        if (!transient || attempt >= 5) throw err;
        sleepSync(20 * (attempt + 1));
      }
    }
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

export function writeJsonAtomic(filePath: string, data: unknown, space: number | undefined = 2): void {
  writeFileAtomic(filePath, JSON.stringify(data, null, space));
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Same temp-file-plus-rename atomic write as writeFileAtomic above, but non-blocking end to end —
 * for any write of a file whose path might be a slow/degraded network mount (a photo being edited
 * in place, say) rather than a small local config file. The sync version's `fs.*Sync` calls (and
 * its `Atomics.wait`-based retry sleep) run on — and fully block — whichever thread calls them;
 * from Electron's main process that is the one thread serving every other IPC call, menu action and
 * window repaint, so a single slow network write there freezes the entire app, not just this call.
 */
export async function writeFileAtomicAsync(filePath: string, data: Buffer, mode?: number): Promise<void> {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${++tmpCounter}`;
  try {
    await fs.promises.writeFile(tmp, data, mode === undefined ? undefined : { mode });
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.promises.rename(tmp, filePath);
        break;
      } catch (err: any) {
        const transient = err && (err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES');
        if (!transient || attempt >= 5) throw err;
        await delay(20 * (attempt + 1));
      }
    }
  } catch (err) {
    await fs.promises.unlink(tmp).catch(() => {});
    throw err;
  }
}

export async function writeJsonAtomicAsync(filePath: string, data: unknown, space: number | undefined = 2): Promise<void> {
  await writeFileAtomicAsync(filePath, Buffer.from(JSON.stringify(data, null, space), 'utf-8'));
}

/**
 * Reads + parses a JSON file. Missing file -> `fallback`. A file that exists
 * but does not parse is renamed to `<name>.corrupt-<timestamp>` (so the next
 * save cannot silently destroy the evidence) and `fallback` is returned. A
 * genuine read error (EBUSY, EACCES, ...) is RETHROWN rather than treated as
 * "empty" — callers must not overwrite a file they merely failed to read.
 */
export function readJsonSafe<T>(filePath: string, fallback: T): T {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err: any) {
    if (err && err.code === 'ENOENT') return fallback;
    throw err;
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed === null || parsed === undefined ? fallback : (parsed as T);
  } catch (parseErr) {
    try {
      fs.renameSync(filePath, `${filePath}.corrupt-${Date.now()}`);
    } catch {}
    console.warn(`[jsonFile] ${filePath} was not valid JSON; moved aside and using defaults:`, parseErr);
    return fallback;
  }
}
