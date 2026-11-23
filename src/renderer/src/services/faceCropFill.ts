// Idle job: makes the sharp face crops that do not exist yet (faces found before crops were kept), named people first, so the
// first look at someone's Zoomed Faces is rarely a slow one. Runs a few faces at a time and stops the moment the user is active.
import { libraryStore } from './libraryStore';
import type { FaceCropRequestInput } from '../../../types';

let running = false;
let stopRequested = false;
const BATCH = 24;
const isPlaceholderName = (n: string | undefined) => !n || /^Person(\s+\d+)?$/i.test(n.trim());

export function stopFaceCropFill(): void {
  stopRequested = true;
  void window.electronAPI?.stopFillingFaceCrops?.();
}

/** The faces worth a crop, named people first; videos and faces without a box are left out. */
export function facesNeedingCrops(limit = 100000): FaceCropRequestInput[] {
  const st = libraryStore.getState();
  const named = new Set(st.people.filter((p) => !isPlaceholderName(p.name)).map((p) => p.id));
  const first: FaceCropRequestInput[] = [];
  const rest: FaceCropRequestInput[] = [];
  for (const photo of st.photos) {
    if (photo.isVideo || !photo.faces?.length) continue;
    for (const f of photo.faces) {
      if (!f.box || !f.personId) continue; // unknown faces do not appear in Zoomed Faces
      const req: FaceCropRequestInput = {
        filePath: photo.filePath, originalRemotePath: photo.originalRemotePath, isVirtual: photo.isVirtual, storageName: photo.storageName,
        faceId: f.id, box: f.box, imageWidth: f.imageWidth, imageHeight: f.imageHeight,
      };
      (named.has(f.personId) ? first : rest).push(req);
    }
  }
  return [...first, ...rest].slice(0, limit);
}

export async function runFaceCropFill(): Promise<void> {
  const api = window.electronAPI;
  if (running || !api?.fillFaceCrops) return;
  running = true;
  stopRequested = false;
  try {
    const todo = facesNeedingCrops();
    for (let i = 0; i < todo.length && !stopRequested; i += BATCH) {
      const res = await api.fillFaceCrops(todo.slice(i, i + BATCH));
      // Nothing made and nothing already there: every face in this batch is unreachable (offline, unreadable) — do not spin on them.
      if (res.made === 0 && res.skipped === 0 && res.failed > 0 && i > BATCH * 20) break;
    }
  } catch {
    // best effort
  } finally {
    running = false;
  }
}
