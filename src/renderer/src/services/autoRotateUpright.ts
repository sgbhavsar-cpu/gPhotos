import type { Photo, OrientationInput } from '../../../types';
import { libraryStore } from './libraryStore';
import { afterPhotoRotated } from './photoRotation';
import { notify, notifyError } from './notifications';
import { summariseReasons } from './photoRelocationFlow';

export interface AutoRotateSummary {
  rotated: number;
  upright: number;
  unknown: number;
  failed: number;
}

export type AutoRotateStage = 'detecting' | 'rotating';

const toInput = (p: Photo): OrientationInput => ({
  id: p.id,
  filePath: p.filePath,
  fileName: p.fileName,
  originalRemotePath: p.originalRemotePath,
  isVirtual: p.isVirtual,
});

/**
 * "Rotate to upright" for a selection: the main process looks at each photo (people's faces, at all four
 * orientations) and says how far it must turn; only photos where that is clear are rotated, through the same
 * safe pipeline as the rotate button (local thumbnail now, original when reachable or queued, face boxes and
 * avatars updated). Photos without a clear answer are left exactly as they are and counted.
 */
export async function autoRotateUpright(
  photos: Photo[],
  options: { onProgress?: (stage: AutoRotateStage, done: number, total: number) => void; skipConfirm?: boolean } = {}
): Promise<AutoRotateSummary | null> {
  const api = window.electronAPI;
  if (!api?.detectPhotoOrientation || !api?.rotatePhoto || (api as any).isBrowserShim) {
    notify('error', 'Automatic rotation is only available in the desktop app.');
    return null;
  }
  if (photos.length === 0) return null;

  if (!options.skipConfirm) {
    const ok = window.confirm(
      `Automatically rotate ${photos.length} photo${photos.length === 1 ? '' : 's'} so people are upright?\n\n` +
        'The app looks for faces in each photo. A photo is rotated only when its correct orientation is clear; ' +
        'photos without a clear answer (for example no faces) are left unchanged. Rotating changes the photo files.'
    );
    if (!ok) return null;
  }

  const byId = new Map(photos.map((p) => [p.id, p]));
  try {
    const unsubscribe = api.onOrientationProgress?.((p) => options.onProgress?.('detecting', p.done, p.total));
    let results;
    try {
      results = await api.detectPhotoOrientation(photos.map(toInput));
    } finally {
      try {
        unsubscribe?.();
      } catch {}
    }

    const summary: AutoRotateSummary = { rotated: 0, upright: 0, unknown: 0, failed: 0 };
    const toRotate = results.filter((r) => r.status === 'rotate' && r.rotation !== 0 && byId.has(r.id));
    const failures: Array<{ reason?: string }> = [];
    const unclear: Array<{ reason?: string }> = [];
    for (const r of results) {
      if (r.status === 'upright') summary.upright++;
      else if (r.status === 'unknown') {
        summary.unknown++;
        unclear.push({ reason: r.reason });
      } else if (r.status === 'failed') {
        summary.failed++;
        failures.push({ reason: r.reason });
      }
    }

    let done = 0;
    for (const r of toRotate) {
      const photo = byId.get(r.id)!;
      options.onProgress?.('rotating', done, toRotate.length);
      try {
        const res: any = await api.rotatePhoto(photo.filePath, r.rotation, photo.originalRemotePath);
        if (!res || res.success === false) throw new Error(res?.error || res?.message || 'rotation failed');
        const isHeic = /\.(heic|heif)$/i.test(photo.filePath) || /\.(heic|heif)$/i.test(photo.originalRemotePath || '');
        if (res?.isHeic || isHeic || res?.isHeicRotated) {
          const newRot = res?.heicRotation ?? (((photo.heicRotation || photo.rotation || 0) + r.rotation) % 360);
          libraryStore.updatePhoto({ ...photo, isHeicRotated: newRot !== 0, heicRotation: newRot, rotation: newRot });
        }
        await afterPhotoRotated(photo, r.rotation);
        summary.rotated++;
      } catch (err: any) {
        summary.failed++;
        failures.push({ reason: err?.message || String(err) });
      }
      done++;
    }
    options.onProgress?.('rotating', toRotate.length, toRotate.length);

    const parts = [
      `${summary.rotated} rotated upright`,
      summary.upright ? `${summary.upright} already upright` : '',
      summary.unknown ? `${summary.unknown} left unchanged (${summariseReasons(unclear, 2) || 'unclear'})` : '',
    ].filter(Boolean);
    notify(summary.rotated > 0 ? 'success' : 'info', parts.join(' · ') + '.');
    if (summary.failed > 0) {
      notify('error', `${summary.failed} photo${summary.failed === 1 ? '' : 's'} could not be checked or rotated: ${summariseReasons(failures)}.`);
    }
    return summary;
  } catch (err) {
    notifyError('Auto-rotate photos', err);
    return null;
  }
}
