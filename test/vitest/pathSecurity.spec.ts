import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resetDbForTests, setActiveLibrary } from '../../src/main/services/db';
import { setSetting } from '../../src/main/services/libraryRepository';
import { isPathAllowed, assertPathAllowed, assertPathsAllowed } from '../../src/main/services/pathSecurity';

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

  it('assertPathsAllowed rejects the whole batch if even one path is disallowed', () => {
    const allowed = path.join(libraryDir, 'a.jpg');
    const disallowed = path.join(outsideDir, 'b.jpg');
    expect(() => assertPathsAllowed([allowed, allowed], 'batch')).not.toThrow();
    expect(() => assertPathsAllowed([allowed, disallowed], 'batch')).toThrow(/Access denied/);
  });
});
