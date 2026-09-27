import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { writeJsonAtomic, readJsonSafe } from '../../src/main/services/jsonFile';

describe('jsonFile', () => {
  it('many writes to the same file in the same tick never collide and leave no temp files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gphotos_jsonfile_test_'));
    try {
      const file = path.join(dir, 'x.json');
      for (let i = 0; i < 200; i++) writeJsonAtomic(file, { i });
      expect(readJsonSafe(file, null)).toEqual({ i: 199 });
      expect(fs.readdirSync(dir)).toEqual(['x.json']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('quarantines unparsable JSON instead of overwriting it, and rethrows real read errors', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gphotos_jsonfile_test_'));
    try {
      const file = path.join(dir, 'bad.json');
      fs.writeFileSync(file, '{ not json');
      expect(readJsonSafe(file, { ok: true })).toEqual({ ok: true });
      expect(fs.readdirSync(dir).some((f) => f.startsWith('bad.json.corrupt-'))).toBe(true);
      expect(() => readJsonSafe(dir, null)).toThrow(); // a directory: EISDIR, not "empty"
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
