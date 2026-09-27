import type { Photo, RelocationPhotoInput } from '../../../types';
import { libraryStore } from './libraryStore';
import { requestFolderBrowser } from './folderBrowserController';
import { notify, notifyError } from './notifications';

export interface RelocationFlowSummary {
  targetDir: string;
  moved: number;
  skipped: number;
  failed: number;
}

const toInput = (p: Photo): RelocationPhotoInput => ({
  id: p.id,
  filePath: p.filePath,
  fileName: p.fileName,
  originalRemotePath: p.originalRemotePath,
  isVirtual: p.isVirtual,
  storageName: p.storageName,
});

/** The few most common reasons, "reason (x3)", so a big skipped list stays readable. */
export function summariseReasons(items: Array<{ reason?: string }>, max = 3): string {
  const counts = new Map<string, number>();
  for (const it of items) counts.set(it.reason || 'unknown reason', (counts.get(it.reason || 'unknown reason') || 0) + 1);
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([reason, n]) => (n > 1 ? `${reason} (${n})` : reason))
    .join('; ');
}

/**
 * Interactive "move these photos to a folder" flow, e.g. for an album:
 *   1. ask the main process which library/storage folder the photos live in (and which of them can move at all);
 *   2. let the user browse to a destination INSIDE that folder (new sub-folders can be created);
 *   3. confirm, then physically move the originals (and their local thumbnails) and bring the library state in line.
 * Returns null when nothing was moved (cancelled, or not possible); errors are shown to the user.
 */
export async function movePhotosToFolder(
  photos: Photo[],
  options: { label: string; onProgress?: (done: number, total: number) => void } = { label: 'photos' }
): Promise<RelocationFlowSummary | null> {
  const api = window.electronAPI;
  if (!api?.planPhotoRelocation || !api?.relocatePhotos || (api as any).isBrowserShim) {
    notify('error', 'Moving photos to another folder is only available in the desktop app.');
    return null;
  }
  if (photos.length === 0) {
    notify('info', 'There are no photos to move.');
    return null;
  }

  try {
    const inputs = photos.map(toInput);
    const plan = await api.planPhotoRelocation(inputs);
    if (!plan.root || plan.movableIds.length === 0) {
      notify('error', `None of these photos can be moved: ${summariseReasons(plan.skipped.map((s) => ({ reason: s.reason }))) || 'no folder found'}.`);
      return null;
    }

    const movableCount = plan.movableIds.length;
    const target = await requestFolderBrowser({
      title: `Move ${movableCount} photo${movableCount === 1 ? '' : 's'} to…`,
      initialPath: plan.root.path,
      restrictToRoot: plan.root.path,
      confirmLabel: 'Move Here',
      allowNewFolder: true,
      hint: `The photos stay inside "${plan.root.label}". Pick the destination folder, or type a name to create a new one.`,
    });
    if (!target) return null;

    const skippedNote = plan.skipped.length
      ? `\n\n${plan.skipped.length} photo${plan.skipped.length === 1 ? '' : 's'} will NOT be moved: ${summariseReasons(plan.skipped)}.`
      : '';
    const ok = window.confirm(
      `Move ${movableCount} photo${movableCount === 1 ? '' : 's'} from ${options.label} to:\n\n${target}\n\n` +
        `This moves the original files on disk. Albums, faces and people stay attached to the photos.${skippedNote}`
    );
    if (!ok) return null;

    const unsubscribe = api.onPhotoRelocationProgress?.((p) => options.onProgress?.(p.done, p.total));
    let outcome;
    try {
      const movableSet = new Set(plan.movableIds);
      outcome = await api.relocatePhotos({ photos: inputs.filter((i) => movableSet.has(i.id)), targetDir: target });
    } finally {
      try {
        unsubscribe?.();
      } catch {}
    }

    if (outcome.error) {
      notify('error', `Could not move the photos: ${outcome.error}`);
      return null;
    }

    const moved = outcome.results.filter((r) => r.status === 'moved' && r.newId && r.newFilePath);
    if (moved.length > 0) {
      libraryStore.applyPhotoRelocations(
        moved.map((r) => ({
          oldId: r.oldId,
          newId: r.newId!,
          newFilePath: r.newFilePath!,
          newOriginalRemotePath: r.newOriginalRemotePath,
          newFileName: r.newFileName,
        }))
      );
      await libraryStore.flushSaveImmediately();
    }

    const failed = outcome.results.filter((r) => r.status === 'failed');
    const skipped = outcome.results.filter((r) => r.status === 'skipped');
    if (moved.length > 0) {
      notify('success', `Moved ${moved.length} photo${moved.length === 1 ? '' : 's'} to "${target}".`);
    }
    if (failed.length > 0) {
      notify('error', `${failed.length} photo${failed.length === 1 ? '' : 's'} could not be moved and were left where they were: ${summariseReasons(failed)}.`);
    }
    if (moved.length === 0 && failed.length === 0) {
      notify('info', `Nothing was moved${skipped.length ? `: ${summariseReasons(skipped)}` : ''}.`);
    }
    return { targetDir: target, moved: moved.length, skipped: skipped.length + plan.skipped.length, failed: failed.length };
  } catch (err) {
    notifyError('Move photos', err);
    return null;
  }
}
