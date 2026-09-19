import fs from 'fs';
import path from 'path';
import { app } from 'electron';

// Person profile photos are cropped client-side from whatever photo/face is
// currently the person's cover, which may live on a network share or a
// virtual-storage mirror. Persisting that crop to a local folder here means
// the "People" list always has a profile picture available, independent of
// which network storage is currently selected/reachable.

function getAvatarDir(): string {
  const dir = path.join(app.getPath('userData'), 'person-avatars');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
  return dir;
}

function sanitizeIdSegment(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * The cache key ties the saved file to whichever face/photo produced it (e.g.
 * the person's coverFaceId), so changing a person's cover face naturally
 * invalidates the old file instead of serving a stale crop.
 */
function getAvatarFileName(personId: string, cacheKey: string): string {
  return `${sanitizeIdSegment(personId)}__${sanitizeIdSegment(cacheKey || 'default')}.jpg`;
}

export function getPersonAvatarPath(personId: string, cacheKey: string): string | null {
  const filePath = path.join(getAvatarDir(), getAvatarFileName(personId, cacheKey));
  return fs.existsSync(filePath) ? filePath : null;
}

/** Removes any previously saved avatar file(s) for this person, regardless of cache key. */
function clearExistingAvatars(personId: string): void {
  const dir = getAvatarDir();
  const prefix = `${sanitizeIdSegment(personId)}__`;
  try {
    for (const entry of fs.readdirSync(dir)) {
      if (entry.startsWith(prefix)) {
        try {
          fs.unlinkSync(path.join(dir, entry));
        } catch {}
      }
    }
  } catch {}
}

export function savePersonAvatar(
  personId: string,
  cacheKey: string,
  dataUrl: string
): { success: boolean; filePath?: string; error?: string } {
  try {
    const match = /^data:image\/(\w+);base64,(.+)$/.exec(dataUrl);
    if (!match) {
      return { success: false, error: 'Invalid image data URL' };
    }
    const buffer = Buffer.from(match[2], 'base64');
    clearExistingAvatars(personId);
    const filePath = path.join(getAvatarDir(), getAvatarFileName(personId, cacheKey));
    fs.writeFileSync(filePath, buffer);
    return { success: true, filePath };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export function deletePersonAvatar(personId: string): void {
  clearExistingAvatars(personId);
}
