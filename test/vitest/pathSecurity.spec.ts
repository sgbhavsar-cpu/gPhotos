import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resetDbForTests, setActiveLibrary } from '../../src/main/services/db';
import { setSetting } from '../../src/main/services/libraryRepository';
import { isPathAllowed, assertPathAllowed, assertPathsAllowed, clearPathSecurityCache } from '../../src/main/services/pathSecurity';

describe('pathSecurity', () => {
  let tempDir: string;
  let libraryDir: string;
  let mirrorRoot: string;
  let outsideDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gphotos_pathsecurity_test_'));
    process.env.GPHOTOS_TEST_DB_DIR = tempDir;
    resetDbForTests();

    libraryDir = path.join(tempDir, 'MyLibrary');
    mirrorRoot = path.join(tempDir, 'Mirrors');
    outsideDir = path.join(tempDir, 'NotAllowed');
    fs.mkdirSync(libraryDir, { recursive: true });
    fs.mkdirSync(mirrorRoot, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });

    setSetting('selectedFolder', libraryDir);
    setSetting('gphotos_virtual_storages_v1', [
      { id: 's1', name: 'NAS', networkSourcePath: '\\\\NAS\\Family', localMirrorRoot: mirrorRoot },
    ]);
  });

  afterEach(() => {
    resetDbForTests();
    delete process.env.GPHOTOS_TEST_DB_DIR;
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('allows paths inside the active library folder', () => {
    expect(isPathAllowed(path.join(libraryDir, 'photo.jpg'))).toBe(true);
    expect(isPathAllowed(path.join(libraryDir, 'sub', 'photo.jpg'))).toBe(true);
    expect(isPathAllowed(libraryDir)).toBe(true);
  });

  it('allows paths inside a configured virtual storage mirror root or network source', () => {
    expect(isPathAllowed(path.join(mirrorRoot, 'NAS', 'photo.jpg'))).toBe(true);
    expect(isPathAllowed('\\\\NAS\\Family\\photo.jpg')).toBe(true);
  });

  it('rejects paths outside every known root', () => {
    expect(isPathAllowed(path.join(outsideDir, 'photo.jpg'))).toBe(false);
    expect(isPathAllowed('C:\\Windows\\System32\\config\\SAM')).toBe(false);
  });

  it('rejects a directory-traversal attempt that escapes an allowed root', () => {
    const traversal = path.join(libraryDir, '..', 'NotAllowed', 'secret.txt');
    expect(isPathAllowed(traversal)).toBe(false);
  });

  it('rejects an empty or missing path', () => {
    expect(isPathAllowed('')).toBe(false);
    expect(isPathAllowed(undefined)).toBe(false);
    expect(isPathAllowed(null)).toBe(false);
  });

  it('assertPathAllowed throws for a disallowed path and is silent for an allowed one', () => {
    expect(() => assertPathAllowed(path.join(libraryDir, 'a.jpg'), 'test')).not.toThrow();
    expect(() => assertPathAllowed(path.join(outsideDir, 'a.jpg'), 'test')).toThrow(/Access denied/);
  });

  it('rejects relative candidates instead of resolving them against cwd', () => {
    expect(isPathAllowed('photo.jpg')).toBe(false);
    expect(isPathAllowed(path.relative(process.cwd(), path.join(libraryDir, 'a.jpg')))).toBe(false);
  });

  it('rejects a junction/symlink inside an allowed root that points outside it', () => {
    const secret = path.join(outsideDir, 'secret.txt');
    fs.writeFileSync(secret, 'x');
    const link = path.join(libraryDir, 'escape');
    fs.symlinkSync(outsideDir, link, 'junction');
    clearPathSecurityCache();
    expect(isPathAllowed(path.join(link, 'secret.txt'))).toBe(false);
    // not-yet-existing file beneath the link resolves via its nearest existing ancestor
    expect(isPathAllowed(path.join(link, 'new', 'file.txt'))).toBe(false);
    // a link that stays inside the root is fine
    const inner = path.join(libraryDir, 'real');
    fs.mkdirSync(inner);
    fs.symlinkSync(inner, path.join(libraryDir, 'alias'), 'junction');
    clearPathSecurityCache();
    expect(isPathAllowed(path.join(libraryDir, 'alias', 'a.jpg'))).toBe(true);
  });

  it('allows a not-yet-existing file under an allowed root', () => {
    expect(isPathAllowed(path.join(libraryDir, 'new', 'deep', 'a.jpg'))).toBe(true);
  });

  it('lookalike sibling prefixes are rejected', () => {
    expect(isPathAllowed(libraryDir + '_evil')).toBe(false);
    expect(isPathAllowed(path.join(libraryDir + '_evil', 'a.jpg'))).toBe(false);
  });

  it('case-folds only on Windows', () => {
    const upper = path.join(libraryDir.toUpperCase(), 'A.JPG');
    expect(isPathAllowed(upper)).toBe(process.platform === 'win32');
  });

  it('does not treat a filesystem root candidate as allowed unless it is a configured root', () => {
    expect(isPathAllowed(path.parse(libraryDir).root)).toBe(false);
  });

  it('assertPathsAllowed rejects the whole batch if even one path is disallowed', () => {
    const allowed = path.join(libraryDir, 'a.jpg');
    const disallowed = path.join(outsideDir, 'b.jpg');
    expect(() => assertPathsAllowed([allowed, allowed], 'batch')).not.toThrow();
    expect(() => assertPathsAllowed([allowed, disallowed], 'batch')).toThrow(/Access denied/);
  });
});
