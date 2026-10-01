// Runs before every spec file: gives that file its OWN %APPDATA% (vitest.config.ts already points the whole suite at a
// throwaway dir, but spec files run in parallel workers, and a queue/status file one spec leaves in a shared dir —
// e.g. pending_rotations.json — showed up in another spec's assertions).
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll } from 'vitest';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gphotos_vitest_appdata_'));
process.env.APPDATA = dir;
process.env.LOCALAPPDATA = dir;

afterAll(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* a handle may still be open on Windows; it is a temp dir */ }
});
