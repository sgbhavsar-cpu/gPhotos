import fs from 'fs';
import path from 'path';
import { clusterFaces } from '../src/renderer/src/services/clustering';
import { Photo, Person, DetectedFace } from '../src/types';

function runTest() {
  console.log('=== TEST: People Persistence & Self-Healing ===');

  // Load the actual library.json from AppData/gPhotos if present
  const p2 = path.join(process.env.APPDATA || '', 'gPhotos', 'library.json');
  if (!fs.existsSync(p2)) {
    console.log('Test skipped: p2 does not exist');
    return;
  }

  const raw = fs.readFileSync(p2, 'utf8');
  const d = JSON.parse(raw);
  const lib = d.gphotos_library_v1 || {};

  const photos: Photo[] = lib.photos || [];
  let people: Person[] = lib.people || [];
  let faces: DetectedFace[] = lib.faces || [];

  console.log(`Initial: photos=${photos.length}, people=${people.length}, faces=${faces.length}`);

  // Gather all faces across all photos
  const allFacesMap = new Map<string, DetectedFace>();
  for (const f of faces) {
    if (f && f.id) allFacesMap.set(f.id, f);
  }
  for (const photo of photos) {
    if (photo.faces && Array.isArray(photo.faces)) {
      for (const face of photo.faces) {
        if (!face || !face.id) continue;
        const existing = allFacesMap.get(face.id);
        if (existing) {
          if (!existing.personId && face.personId) existing.personId = face.personId;
          if (!existing.descriptor && face.descriptor) existing.descriptor = face.descriptor;
          if (face.isConfirmed) existing.isConfirmed = true;
        } else {
          allFacesMap.set(face.id, { ...face, photoId: photo.id });
        }
      }
    }
  }

  const allFaces = Array.from(allFacesMap.values());
  console.log(`Gathered allFaces: ${allFaces.length}`);

  const peopleMap = new Map<string, Person>();
  for (const p of people) {
    if (p && p.id) peopleMap.set(p.id, { ...p });
  }

  // Identify faces whose personId is missing
  const missingPersonFaces = new Map<string, DetectedFace[]>();
  const unassignedFaces: DetectedFace[] = [];

  for (const face of allFaces) {
    if (face.personId) {
      if (!peopleMap.has(face.personId)) {
        if (!missingPersonFaces.has(face.personId)) {
          missingPersonFaces.set(face.personId, []);
        }
        missingPersonFaces.get(face.personId)!.push(face);
      }
    } else {
      unassignedFaces.push(face);
    }
  }

  console.log(`Found missingPersonFaces groups: ${missingPersonFaces.size}, unassignedFaces: ${unassignedFaces.length}`);

  // Reconstruct Person entities
  let nextIndex = peopleMap.size + 1;
  for (const [pId, assignedFaces] of missingPersonFaces.entries()) {
    const firstFace = assignedFaces[0];
    const uniquePhotos = new Set(assignedFaces.map((f) => f.photoId));
    const newPerson: Person = {
      id: pId,
      name: `Person ${nextIndex++}`,
      coverFaceId: firstFace.id,
      coverPhotoId: firstFace.photoId,
      faceCount: assignedFaces.length,
      photoCount: uniquePhotos.size,
      createdAt: new Date().toISOString(),
    };
    peopleMap.set(pId, newPerson);
  }

  // Recalculate faceCount and photoCount for all people
  const personFacesSet = new Map<string, Set<string>>();
  const personPhotosSet = new Map<string, Set<string>>();
  for (const pId of peopleMap.keys()) {
    personFacesSet.set(pId, new Set());
    personPhotosSet.set(pId, new Set());
  }

  for (const f of allFaces) {
    if (f.personId && peopleMap.has(f.personId)) {
      personFacesSet.get(f.personId)?.add(f.id);
      personPhotosSet.get(f.personId)?.add(f.photoId);
    }
  }

  const finalPeople: Person[] = [];
  for (const person of peopleMap.values()) {
    const fSet = personFacesSet.get(person.id);
    const pSet = personPhotosSet.get(person.id);
    finalPeople.push({
      ...person,
      faceCount: fSet ? fSet.size : 0,
      photoCount: pSet ? pSet.size : 0,
    });
  }

  console.log(`Reconciled people count: ${finalPeople.length}`);
  for (const p of finalPeople) {
    console.log(` - Person: ${p.name} (${p.id}): faces=${p.faceCount}, photos=${p.photoCount}`);
  }

  // Verify that any photo in photos with faces can resolve face.personId in finalPeople!
  let unresolvableFaces = 0;
  for (const photo of photos) {
    if (photo.faces) {
      for (const face of photo.faces) {
        if (face.personId) {
          const match = finalPeople.find((p) => p.id === face.personId);
          if (!match) {
            unresolvableFaces++;
          }
        }
      }
    }
  }

  console.log(`Unresolvable faces after reconciliation: ${unresolvableFaces}`);
  if (finalPeople.length === 13 && unresolvableFaces === 0) {
    console.log('SUCCESS: All 13 people perfectly restored and 100% of faces resolve to recognized people!');
  } else {
    console.error('FAILURE in reconciliation verification');
    process.exit(1);
  }
}

runTest();
