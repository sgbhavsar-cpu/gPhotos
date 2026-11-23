// Face-data maintenance that works on one library's database directly (so it needs no photo to be loaded in the window):
//  - resetFaces: delete a mirror's face detections (optionally keeping the faces the user confirmed or drew by hand) and mark
//    its photos unscanned, so the normal scan detects them again;
//  - secondPass: match still-unknown faces to the people the user has confirmed, using only confirmed faces as the reference.
import type { DatabaseSync } from 'node:sqlite';
import { bumpFacesPeopleRevision, runInTransaction } from './db';
import { computeQualityWeightedCentroid, cosineDistance, euclideanDistance } from './faceClustering';
import type { DetectedFace } from '../../types';

export interface ResetFacesResult {
  deletedFaces: number;
  keptFaces: number;
  /** Photos marked unscanned, so the next scan picks them up. */
  photosReset: number;
  /** Ids of the faces that were deleted (for removing their crop files). */
  deletedFaceIds: string[];
}

/** How many faces a reset would delete / keep, without changing anything. */
export function previewResetFaces(db: DatabaseSync, deleteConfirmed: boolean): { total: number; confirmed: number; wouldDelete: number; wouldKeep: number } {
  const total = (db.prepare('SELECT COUNT(*) AS n FROM faces').get() as { n: number }).n;
  const confirmed = (db.prepare('SELECT COUNT(*) AS n FROM faces WHERE is_confirmed = 1 OR is_manual = 1').get() as { n: number }).n;
  return { total, confirmed, wouldDelete: deleteConfirmed ? total : total - confirmed, wouldKeep: deleteConfirmed ? 0 : confirmed };
}

/**
 * Deletes automatic face detections (and, if `deleteConfirmed`, the confirmed / hand-drawn ones too) from this library, and marks
 * photos for a fresh scan. A photo whose faces are all kept stays as it is (locked photos are skipped by the scan); every other
 * photo is unlocked and flagged unscanned, so the scan runs again — a face that was confirmed keeps its person when the new
 * detection lands on it (see detectFacesForPhoto). The people registry is never touched.
 */
export function resetFaces(db: DatabaseSync, opts: { deleteConfirmed: boolean }): ResetFacesResult {
  const keepSql = opts.deleteConfirmed ? '0' : '(is_confirmed = 1 OR is_manual = 1)';
  const deletedFaceIds = (db.prepare(`SELECT id FROM faces WHERE NOT ${keepSql}`).all() as Array<{ id: string }>).map((r) => r.id);
  const keptFaces = (db.prepare(`SELECT COUNT(*) AS n FROM faces WHERE ${keepSql}`).get() as { n: number }).n;
  let photosReset = 0;
  runInTransaction(() => {
    // Photos that lose a face are unlocked and flagged for a fresh scan first (the subquery needs the faces still in place)...
    const lost = db.prepare(`UPDATE photos SET face_scan_completed = 0, faces_locked = 0 WHERE COALESCE(is_video, 0) = 0 AND id IN (SELECT photo_id FROM faces WHERE NOT ${keepSql})`).run();
    db.prepare(`DELETE FROM faces WHERE NOT ${keepSql}`).run();
    // ...and so is every photo left with no face at all (it was scanned and found none, or all its faces were deleted). Only a
    // photo whose faces are all kept stays as it is.
    const empty = db.prepare('UPDATE photos SET face_scan_completed = 0, faces_locked = 0 WHERE COALESCE(is_video, 0) = 0 AND (face_scan_completed = 1 OR faces_locked = 1) AND NOT EXISTS (SELECT 1 FROM faces f WHERE f.photo_id = photos.id)').run();
    photosReset = Number((lost as { changes?: number | bigint }).changes ?? 0) + Number((empty as { changes?: number | bigint }).changes ?? 0);
  }, db);
  bumpFacesPeopleRevision();
  return { deletedFaces: deletedFaceIds.length, keptFaces, photosReset, deletedFaceIds };
}

export interface SecondPassAssignment { faceId: string; photoId: string; personId: string }
export interface SecondPassResult {
  assignments: SecondPassAssignment[];
  /** Unknown faces that were looked at. */
  candidates: number;
  /** People that had confirmed faces to learn from. */
  peopleUsed: number;
}

const PAGE = 1500;

/**
 * Second-phase scan. Reference = the faces the user confirmed (or drew by hand), grouped per person, from every database in
 * `referenceDbs`; looked at = faces in `targetDb` that belong to nobody (optionally only `onlyFaceIds`). A face is given to the
 * closest person only when it is close enough AND clearly closer than the runner-up (otherwise it stays unknown), and never to a
 * person who already appears in that photo. Nothing already assigned is changed.
 */
export async function secondPass(
  targetDb: DatabaseSync,
  referenceDbs: DatabaseSync[],
  opts?: { onlyFaceIds?: string[]; onlyPersonId?: string; threshold?: number; margin?: number; knownPeopleIds?: Set<string> }
): Promise<SecondPassResult> {
  const threshold = opts?.threshold ?? 0.42;
  const margin = opts?.margin ?? 0.05;

  // 1. Per-person centroid from confirmed faces.
  const byPerson = new Map<string, DetectedFace[]>();
  for (const db of referenceDbs) {
    const rows = db
      .prepare('SELECT id, photo_id, person_id, descriptor_json, confidence, is_confirmed, is_manual, box_width, box_height FROM faces WHERE person_id IS NOT NULL AND (is_confirmed = 1 OR is_manual = 1) AND descriptor_json IS NOT NULL')
      .all() as any[];
    for (const r of rows) {
      if (opts?.knownPeopleIds && !opts.knownPeopleIds.has(r.person_id)) continue;
      let descriptor: number[];
      try { descriptor = JSON.parse(r.descriptor_json); } catch { continue; }
      if (!Array.isArray(descriptor) || descriptor.length === 0) continue;
      const face = { id: r.id, photoId: r.photo_id, personId: r.person_id, descriptor, confidence: r.confidence ?? undefined, isConfirmed: !!r.is_confirmed, isManual: !!r.is_manual, box: { x: 0, y: 0, width: r.box_width ?? 0, height: r.box_height ?? 0 } } as DetectedFace;
      const list = byPerson.get(r.person_id);
      if (list) list.push(face); else byPerson.set(r.person_id, [face]);
    }
  }
  const centroids: Array<{ personId: string; centroid: number[] }> = [];
  for (const [personId, faces] of byPerson) {
    const c = computeQualityWeightedCentroid(faces);
    if (c.length > 0) centroids.push({ personId, centroid: c });
  }
  if (centroids.length === 0) return { assignments: [], candidates: 0, peopleUsed: 0 };

  // 2. Who is already in each photo of the target library (a person appears at most once per photo).
  const inPhoto = new Map<string, Set<string>>();
  for (const r of targetDb.prepare('SELECT photo_id, person_id FROM faces WHERE person_id IS NOT NULL').all() as any[]) {
    const s = inPhoto.get(r.photo_id);
    if (s) s.add(r.person_id); else inPhoto.set(r.photo_id, new Set([r.person_id]));
  }

  // 3. Look at the unknown faces, a page at a time (descriptors are big).
  const proposals: Array<SecondPassAssignment & { dist: number }> = [];
  let candidates = 0;
  const consider = (r: { id: string; photo_id: string; descriptor_json: string; rejected_person_ids?: string | null }) => {
    let rejected: string[] = [];
    if (r.rejected_person_ids) { try { const v = JSON.parse(r.rejected_person_ids); if (Array.isArray(v)) rejected = v; } catch {} }
    let d: number[];
    try { d = JSON.parse(r.descriptor_json); } catch { return; }
    if (!Array.isArray(d) || d.length === 0) return;
    candidates++;
    let best = Infinity, second = Infinity, bestPerson = '';
    for (const c of centroids) {
      if (rejected.includes(c.personId)) continue; // the user said this face is not that person
      const dist = Math.min(cosineDistance(d, c.centroid), euclideanDistance(d, c.centroid));
      if (dist < best) { second = best; best = dist; bestPerson = c.personId; }
      else if (dist < second) second = dist;
    }
    // For one person's "find more", everybody is still a competitor: a face that fits someone else as well is not claimed.
    if (opts?.onlyPersonId && bestPerson !== opts.onlyPersonId) return;
    if (best < threshold && second - best >= margin) proposals.push({ faceId: r.id, photoId: r.photo_id, personId: bestPerson, dist: best });
  };
  if (opts?.onlyFaceIds) {
    // A known set of faces (re-matching after a person was deleted): look them up directly instead of paging the whole table.
    const ids = opts.onlyFaceIds;
    for (let i = 0; i < ids.length; i += 400) {
      const chunk = ids.slice(i, i + 400);
      const rows = targetDb.prepare(`SELECT id, photo_id, descriptor_json, rejected_person_ids FROM faces WHERE person_id IS NULL AND descriptor_json IS NOT NULL AND id IN (${chunk.map(() => '?').join(',')})`).all(...chunk) as any[];
      for (const r of rows) consider(r);
      await new Promise<void>((r) => setImmediate(r));
    }
  } else {
    let lastRowid = 0;
    const page = targetDb.prepare('SELECT rowid AS _rid, id, photo_id, descriptor_json, rejected_person_ids FROM faces WHERE rowid > ? AND person_id IS NULL AND descriptor_json IS NOT NULL ORDER BY rowid LIMIT ?');
    for (;;) {
      const rows = page.all(lastRowid, PAGE) as any[];
      if (rows.length === 0) break;
      lastRowid = rows[rows.length - 1]._rid;
      await new Promise<void>((r) => setImmediate(r)); // keep the main process responsive between pages
      for (const r of rows) consider(r);
    }
  }

  // 4. Apply the closest first; skip a person who is already in that photo (including from this pass).
  proposals.sort((a, b) => a.dist - b.dist);
  const assignments: SecondPassAssignment[] = [];
  for (const p of proposals) {
    const s = inPhoto.get(p.photoId) ?? new Set<string>();
    if (s.has(p.personId)) continue;
    s.add(p.personId);
    inPhoto.set(p.photoId, s);
    assignments.push({ faceId: p.faceId, photoId: p.photoId, personId: p.personId });
  }

  if (assignments.length > 0) {
    runInTransaction(() => {
      const stmt = targetDb.prepare('UPDATE faces SET person_id = ?, is_confirmed = 0 WHERE id = ? AND person_id IS NULL');
      for (const a of assignments) stmt.run(a.personId, a.faceId);
    }, targetDb);
    bumpFacesPeopleRevision();
  }
  return { assignments, candidates, peopleUsed: centroids.length };
}
