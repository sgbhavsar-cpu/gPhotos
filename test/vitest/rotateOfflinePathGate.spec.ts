import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resetDbForTests } from '../../src/main/services/db';
import { setSetting } from '../../src/main/services/libraryRepository';
import { isPathAllowed, assertPathsAllowed, clearPathSecurityCache } from '../../src/main/services/pathSecurity';

const B = String.fromCharCode(92); // a single backslash
const win = (...parts: string[]) => parts.join(B);

// The rotate/edit/metadata IPC handlers validate their paths first. A storage that is OFFLINE (disconnected
// mapped drive, sleeping NAS) must still pass: that is exactly when the rotation has to be queued.
describe('path allow-list with the original storage offline', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gphotos_pathgate_test_'));
    process.env.GPHOTOS_TEST_DB_DIR = dir;
    resetDbForTests();
    clearPathSecurityCache();
  });
  afterEach(() => {
    resetDbForTests();
    delete process.env.GPHOTOS_TEST_DB_DIR;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  });

  const configure = (networkSourcePath: string, localMirrorRoot: string) =>
    setSetting('gphotos_virtual_storages_v1', [{ id: 's1', name: 'NAS', networkSourcePath, localMirrorRoot }]);
  const freeDriveLetter = () => 'QRSTUVWXYZ'.split('').find((l) => !fs.existsSync(l + ':' + B))!; // not connected right now

  it('accepts a photo under a configured storage whose drive letter is not connected', () => {
    const root = win(freeDriveLetter() + ':', 'Backups', 'Photos');
    const photo = win(root, '2010', 'IMG_1.JPG');
    configure(root, path.join(dir, 'Mirrors'));
    expect(isPathAllowed(photo)).toBe(true);
    expect(() => assertPathsAllowed([path.join(dir, 'Mirrors', 'NAS', 'IMG_1.JPG'), photo], 'photo:rotate')).not.toThrow();
  });

  it('accepts a photo under a configured UNC storage that is unreachable', () => {
    const root = B + B + win('no-such-nas.invalid', 'photos');
    configure(root, path.join(dir, 'Mirrors'));
    expect(isPathAllowed(win(root, '2010', 'IMG_1.JPG'))).toBe(true);
  });

  it('still rejects paths outside every configured root', () => {
    const letter = freeDriveLetter();
    configure(win(letter + ':', 'Backups', 'Photos'), path.join(dir, 'Mirrors'));
    expect(isPathAllowed(win(letter + ':', 'Other', 'IMG_1.JPG'))).toBe(false);
  });
});
