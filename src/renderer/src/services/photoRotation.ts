import type { Photo } from '../../../types';
import { libraryStore } from './libraryStore';
import { bumpImageVersion } from './imageVersion';
import { invalidateAvatarSprite } from './avatarSpriteLoader';
import { evictAndRefreshThumbnail } from './asyncImageLoader';
import { notify, notifyError } from './notifications';

/**
 * Everything that must follow a SUCCESSFUL physical rotation of `photo` by `degrees` clockwise (its local
 * thumbnail was rotated, and its original too or the rotation was queued for when the storage is back):
 *
 *  1. new image URLs, so no view keeps showing the old pixels;
 *  2. the face boxes rotate with the picture (they are stored in the old orientation);
 *  3. person avatars cut from this photo are rebuilt from the rotated image and the updated boxes.
 *
 * Never throws: a failure here must not turn a rotation that worked into an error.
 */
export async function afterPhotoRotated(photo: Photo, degrees: number, thumbSize = 250): Promise<void> {
  try {
    bumpImageVersion(photo.filePath, photo.thumbnailPath);
    evictAndRefreshThumbnail(photo.thumbnailPath || photo.filePath, photo.originalRemotePath, thumbSize);

    const { skippedFaces, avatarPersonIds } = libraryStore.applyPhotoRotation(photo.id, degrees);
    if (skippedFaces > 0) {
      notify('info', `${skippedFaces} face${skippedFaces === 1 ? '' : 's'} on "${photo.fileName}" could not be moved with the rotation; re-scan faces on this photo to fix them.`);
    }

    if (avatarPersonIds.length > 0) {
      // The avatar builder reads face boxes from the database, so the rotated boxes must be saved first.
      await libraryStore.flushSaveImmediately();
      await Promise.all(
        avatarPersonIds.map((id) => Promise.resolve(window.electronAPI?.deletePersonAvatar?.(id)).catch(() => {}))
      );
      avatarPersonIds.forEach(invalidateAvatarSprite);
    }
  } catch (err) {
    notifyError('Update faces after rotating a photo', err);
  }
}
