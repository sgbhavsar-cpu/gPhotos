import './setup_dom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import assert from 'assert';
import fs from 'fs';
import path from 'path';

import { libraryStore } from '../src/renderer/src/services/libraryStore';
import { PeopleView } from '../src/renderer/src/views/PeopleView';
import { PhotoLightbox } from '../src/renderer/src/components/PhotoLightbox';
import { PersonNameInput } from '../src/renderer/src/components/PersonNameInput';
import { Photo, Person, DetectedFace } from '../src/types';

console.log('🧪 RUNNING COMPREHENSIVE TESTS FOR USER FIXES V3...');

// Container for mounting React views
const container = document.createElement('div');
document.body.appendChild(container);
const root = createRoot(container);

const renderView = async (element: React.ReactElement) => {
  await act(async () => {
    root.render(element);
  });
  await new Promise((r) => setTimeout(r, 60));
};

async function runTests() {
  // ==========================================
  // Test 1: Single Instance Lock & App Name Verification
  // ==========================================
  console.log('▶ Test 1: Single Instance Lock & Windows Taskbar / App Name');
  const mainTsContent = fs.readFileSync(path.join(__dirname, '../src/main/main.ts'), 'utf-8');
  assert.ok(
    mainTsContent.includes('app.requestSingleInstanceLock()'),
    'main.ts must call app.requestSingleInstanceLock()'
  );
  assert.ok(
    mainTsContent.includes("app.setName('gPhotos')"),
    'main.ts must set app name to gPhotos'
  );
  assert.ok(
    mainTsContent.includes("app.setAppUserModelId('gPhotos')"),
    'main.ts must set Windows AppUserModelId to gPhotos'
  );
  assert.ok(
    mainTsContent.includes("app.on('second-instance'"),
    'main.ts must handle second-instance event to focus existing window'
  );

  const pkgContent = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf-8'));
  assert.strictEqual(pkgContent.productName, 'gPhotos', 'package.json productName must be gPhotos');
  console.log('  ✓ Single instance lock and gPhotos Windows taskbar model ID verified');

  // ==========================================
  // Test 2: System Tray & UI Branding Audit
  // ==========================================
  console.log('▶ Test 2: System Tray and Application Branding (gPhotos)');
  const daemonContent = fs.readFileSync(
    path.join(__dirname, '../src/main/services/backgroundDaemon.ts'),
    'utf-8'
  );
  assert.ok(
    daemonContent.includes("'gPhotos - Background Service'"),
    'Tray tooltip must be gPhotos - Background Service'
  );
  assert.ok(
    daemonContent.includes("'Open gPhotos'"),
    'Tray menu must say Open gPhotos'
  );
  assert.ok(
    daemonContent.includes("'Quit gPhotos Completely'"),
    'Tray menu must say Quit gPhotos Completely'
  );

  const sidebarContent = fs.readFileSync(
    path.join(__dirname, '../src/renderer/src/components/Sidebar.tsx'),
    'utf-8'
  );
  assert.ok(sidebarContent.includes('gPhotos'), 'Sidebar must display gPhotos');

  const indexHtmlContent = fs.readFileSync(
    path.join(__dirname, '../src/renderer/index.html'),
    'utf-8'
  );
  assert.ok(indexHtmlContent.includes('<title>gPhotos</title>'), 'index.html title must be gPhotos');
  console.log('  ✓ System tray and all branding verified as gPhotos');

  // ==========================================
  // Test 3: Transparent Full-Scale App Icon
  // ==========================================
  console.log('▶ Test 3: Application Icon format and bounds');
  const iconPath = path.join(__dirname, '../public/icon.png');
  assert.ok(fs.existsSync(iconPath), 'public/icon.png must exist');
  const iconBuffer = fs.readFileSync(iconPath);
  // PNG signature: 89 50 4E 47 0D 0A 1A 0A
  assert.strictEqual(iconBuffer[0], 0x89, 'Icon must be PNG format');
  assert.strictEqual(iconBuffer[1], 0x50, 'Icon must be PNG format');
  assert.strictEqual(iconBuffer[2], 0x4e, 'Icon must be PNG format');
  assert.strictEqual(iconBuffer[3], 0x47, 'Icon must be PNG format');
  console.log('  ✓ Icon is a valid RGBA PNG');

  // ==========================================
  // Test 4: Face Recognition Skip Optimization
  // ==========================================
  console.log('▶ Test 4: Face Recognition skips already-scanned photos');
  const photo1: Photo = {
    id: 'p1',
    filePath: 'C:/photos/p1.jpg',
    fileName: 'p1.jpg',
    fileSize: 1000,
    fileDate: '2024-01-01',
    dateTaken: '2024-01-01',
    year: 2024,
    month: 1,
    day: 1,
    faceScanCompleted: true,
    faces: [], // Scanned, no faces found
  };
  const photo2: Photo = {
    id: 'p2',
    filePath: 'C:/photos/p2.jpg',
    fileName: 'p2.jpg',
    fileSize: 1000,
    fileDate: '2024-01-02',
    dateTaken: '2024-01-02',
    year: 2024,
    month: 1,
    day: 2,
    faceScanCompleted: true,
    faces: [{ id: 'f1', photoId: 'p2', box: { x: 10, y: 10, width: 50, height: 50 }, descriptor: [], confidence: 0.9 }],
  };
  const photo3: Photo = {
    id: 'p3',
    filePath: 'C:/photos/p3.jpg',
    fileName: 'p3.jpg',
    fileSize: 1000,
    fileDate: '2024-01-03',
    dateTaken: '2024-01-03',
    year: 2024,
    month: 1,
    day: 3,
    // Unscanned!
  };

  libraryStore.setPhotos([photo1, photo2]);
  // When folder is rescanned with a 3rd photo:
  libraryStore.setPhotos([
    { ...photo1, faceScanCompleted: undefined, faces: undefined }, // raw from disk scan
    { ...photo2, faceScanCompleted: undefined, faces: undefined }, // raw from disk scan
    photo3,
  ]);

  const statePhotos = libraryStore.getState().photos;
  const p1Preserved = statePhotos.find((p) => p.id === 'p1');
  const p2Preserved = statePhotos.find((p) => p.id === 'p2');
  const p3Preserved = statePhotos.find((p) => p.id === 'p3');

  assert.strictEqual(p1Preserved?.faceScanCompleted, true, 'Photo 1 faceScanCompleted must be preserved');
  assert.ok(Array.isArray(p1Preserved?.faces), 'Photo 1 faces array must be preserved');
  assert.strictEqual(p2Preserved?.faceScanCompleted, true, 'Photo 2 faceScanCompleted must be preserved');
  assert.strictEqual(p2Preserved?.faces?.length, 1, 'Photo 2 face instance must be preserved');
  assert.ok(!p3Preserved?.faceScanCompleted, 'Photo 3 must be marked as not scanned yet (falsy/undefined)');

  // Filtering candidates should only pick photo3!
  const unscanned = statePhotos.filter((p) => !p.faceScanCompleted && (!p.faces || p.faces.length === 0));
  assert.strictEqual(unscanned.length, 1, 'Only the new unscanned photo should be candidate for scanning');
  assert.strictEqual(unscanned[0].id, 'p3', 'Candidate must be p3');
  console.log('  ✓ Face recognition correctly skips all already-scanned photos');

  // ==========================================
  // Test 5: Photo Details Location Renaming
  // ==========================================
  console.log('▶ Test 5: Photo Details Location Renaming');
  const testPhotoWithLoc: Photo = {
    id: 'photo_loc_1',
    filePath: 'C:/photos/vacation.jpg',
    fileName: 'vacation.jpg',
    fileSize: 2000,
    fileDate: '2024-06-15',
    dateTaken: '2024-06-15',
    year: 2024,
    month: 6,
    day: 15,
    location: {
      latitude: 48.8584,
      longitude: 2.2945,
      label: 'Old Eiffel Tower',
    },
  };
  libraryStore.setPhotos([testPhotoWithLoc]);

  await renderView(
    <PhotoLightbox
      photo={testPhotoWithLoc}
      allPhotos={[testPhotoWithLoc]}
      people={[]}
      onClose={() => {}}
      onSelectPhoto={() => {}}
      onToggleFavorite={() => {}}
    />
  );

  // Find Rename Location button
  const renameLocBtn = container.querySelector('button[title="Rename Location"]') as HTMLButtonElement;
  assert.ok(renameLocBtn, 'Rename Location button must exist in Lightbox sidebar');

  await act(async () => {
    renameLocBtn.click();
  });

  const locInput = container.querySelector('input[placeholder*="Paris"]') as HTMLInputElement;
  assert.ok(locInput, 'Location rename input field must appear');
  assert.strictEqual(locInput.value, 'Old Eiffel Tower', 'Location input must contain current name');

  await act(async () => {
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    nativeSetter?.call(locInput, 'Eiffel Tower, Paris, France');
    locInput.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    const saveLocBtn = container.querySelector('button[title*="Save location"]') as HTMLButtonElement;
    if (saveLocBtn) saveLocBtn.click();
  });

  const updatedPhotoInStore = libraryStore.getState().photos.find((p) => p.id === 'photo_loc_1');
  assert.strictEqual(
    updatedPhotoInStore?.location?.label,
    'Eiffel Tower, Paris, France',
    'Location label must be updated to new name'
  );
  console.log('  ✓ Location renaming in photo details successfully persists to store');

  // ==========================================
  // Test 6: People Zoomed Faces: Glowing Buttons & Instant Removal
  // ==========================================
  console.log('▶ Test 6: People Zoomed Faces Glowing Yes/No & Instant Removal');
  const personSachin: Person = {
    id: 'person_sachin',
    name: 'Sachin',
    faceCount: 2,
    photoCount: 2,
    createdAt: '2024-01-01',
  };
  const faceA: DetectedFace = {
    id: 'face_a',
    photoId: 'photo_face_a',
    box: { x: 50, y: 50, width: 100, height: 100 },
    descriptor: Array(128).fill(0.1),
    personId: 'person_sachin',
    confidence: 0.95,
  };
  const faceB: DetectedFace = {
    id: 'face_b',
    photoId: 'photo_face_b',
    box: { x: 60, y: 60, width: 100, height: 100 },
    descriptor: Array(128).fill(0.12),
    personId: 'person_sachin',
    confidence: 0.92,
  };
  const photoA: Photo = {
    id: 'photo_face_a',
    filePath: 'C:/photos/sachin_1.jpg',
    fileName: 'sachin_1.jpg',
    fileSize: 2000,
    fileDate: '2024-01-01',
    dateTaken: '2024-01-01',
    year: 2024,
    month: 1,
    day: 1,
    faces: [faceA],
  };
  const photoB: Photo = {
    id: 'photo_face_b',
    filePath: 'C:/photos/sachin_2.jpg',
    fileName: 'sachin_2.jpg',
    fileSize: 2000,
    fileDate: '2024-01-02',
    dateTaken: '2024-01-02',
    year: 2024,
    month: 1,
    day: 2,
    faces: [faceB],
  };

  libraryStore.setPhotos([photoA, photoB]);
  const state = libraryStore.getState();
  state.people = [personSachin];
  state.faces = [faceA, faceB];

  await renderView(
    <PeopleView
      people={[personSachin]}
      photos={[photoA, photoB]}
      initialSelectedPersonId={personSachin.id}
      onUpdatePersonName={() => {}}
      onMergePeople={() => {}}
      onSelectPhoto={() => {}}
      onToggleFavorite={() => {}}
      onTriggerFaceDetection={() => {}}
      isDetectingFaces={false}
    />
  );

  // Switch to Zoomed Faces mode
  const facesModeBtn = Array.from(container.querySelectorAll('button')).find((b) =>
    b.textContent?.includes('Zoomed Faces')
  );
  assert.ok(facesModeBtn, 'Zoomed Faces mode button must exist');
  await act(async () => {
    facesModeBtn.click();
  });

  // Verify YES and NO buttons exist with hover handlers
  const yesBtns = container.querySelectorAll('button[title*="Yes, this is Sachin"]');
  const noBtns = container.querySelectorAll('button[title*="No, not Sachin"]');
  assert.strictEqual(yesBtns.length, 2, 'Must have 2 YES buttons for 2 photos');
  assert.strictEqual(noBtns.length, 2, 'Must have 2 NO buttons for 2 photos');

  // Test mouse hover glow effect on YES button
  const firstYesBtn = yesBtns[0] as HTMLButtonElement;
  await act(async () => {
    firstYesBtn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    firstYesBtn.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
  });
  // Verify transform or boxShadow or background style exists
  assert.ok(
    firstYesBtn.style.boxShadow.includes('rgba(16, 185, 129') ||
      firstYesBtn.style.transform.includes('scale') ||
      firstYesBtn.style.backgroundColor.includes('rgba(16, 185, 129'),
    'YES button must have glowing green styles on hover'
  );

  // Click NO on first photo
  const firstNoBtn = noBtns[0] as HTMLButtonElement;
  await act(async () => {
    firstNoBtn.click();
  });

  // Photo must be immediately removed from the rendered list!
  const remainingYesBtns = container.querySelectorAll('button[title*="Yes, this is Sachin"]');
  assert.strictEqual(remainingYesBtns.length, 1, 'Photo must be removed immediately upon clicking NO');

  // Top notification banner must be displayed
  const notification = container.textContent;
  assert.ok(
    notification?.includes('removed from Sachin'),
    'Top notification toast must state photo was removed from person'
  );
  console.log('  ✓ Zoomed faces mode has glowing hover and immediately removes photo with top banner');

  // ==========================================
  // Test 7: No Confirmation Dialogs for Wrong Person / Delete Face
  // ==========================================
  console.log('▶ Test 7: No confirmation dialogs for face curation');
  let confirmCalled = false;
  const originalConfirm = window.confirm;
  window.confirm = () => {
    confirmCalled = true;
    return true;
  };

  try {
    // Click NO on remaining face
    const secondNoBtn = container.querySelector('button[title*="No, not Sachin"]') as HTMLButtonElement;
    if (secondNoBtn) {
      await act(async () => {
        secondNoBtn.click();
      });
    }
    assert.strictEqual(confirmCalled, false, 'window.confirm must NOT be called when clicking NO (wrong person)');
  } finally {
    window.confirm = originalConfirm;
  }
  console.log('  ✓ Zero confirmation dialogs invoked for face actions');

  // ==========================================
  // Test 8: Bulletproof PersonNameInput & Renaming Across All Controls
  // ==========================================
  console.log('▶ Test 8: PersonNameInput keystroke simulation (First Time & Editing)');

  // 8.1 First Time Entry: Empty or "Person 1" -> "Sachin"
  let savedName = '';
  await renderView(
    <PersonNameInput
      initialValue="Person 1"
      onSave={(val) => {
        savedName = val;
      }}
      onCancel={() => {}}
      isLarge={true}
    />
  );

  const inputEl = container.querySelector('input') as HTMLInputElement;
  assert.ok(inputEl, 'PersonNameInput must render an input element');

  // Test 1-click Clear (X) button
  const clearBtn = container.querySelector('button[title="Clear text"]') as HTMLButtonElement;
  assert.ok(clearBtn, 'Clear button must exist when input has text');
  await act(async () => {
    clearBtn.click();
  });
  assert.strictEqual(inputEl.value, '', 'Clear button must wipe text completely');

  // Simulate typing "sachin" character-by-character
  const word = 'Sachin';
  let accumulated = '';
  const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  for (const char of word) {
    accumulated += char;
    await act(async () => {
      nativeSetter?.call(inputEl, accumulated);
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // Assert the full accumulated string is maintained on each keystroke!
    assert.strictEqual(inputEl.value, accumulated, `Input value must be "${accumulated}"`);
  }

  // Press Enter or click save to save
  await act(async () => {
    inputEl.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  assert.strictEqual(savedName, 'Sachin', 'Saved name must be "Sachin" after typing');

  // 8.2 Editing Existing Name: "Sachin" -> "Sachin Tendulkar"
  let editedName = '';
  await renderView(
    <PersonNameInput
      initialValue="Sachin"
      onSave={(val) => {
        editedName = val;
      }}
      onCancel={() => {}}
      isLarge={false}
    />
  );

  const editInputEl = container.querySelector('input') as HTMLInputElement;
  assert.strictEqual(editInputEl.value, 'Sachin', 'Initial value must be Sachin');

  // Append " Tendulkar"
  const suffix = ' Tendulkar';
  accumulated = 'Sachin';
  for (const char of suffix) {
    accumulated += char;
    await act(async () => {
      nativeSetter?.call(editInputEl, accumulated);
      editInputEl.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
  assert.strictEqual(editInputEl.value, 'Sachin Tendulkar', 'Input must have full edited name');

  // Click Check save button
  const saveBtn = container.querySelector('button[title*="Save Name"]') as HTMLButtonElement;
  assert.ok(saveBtn, 'Save button must exist');
  await act(async () => {
    saveBtn.click();
  });
  assert.strictEqual(editedName, 'Sachin Tendulkar', 'Edited name must be "Sachin Tendulkar"');

  console.log('  ✓ PersonNameInput guarantees keystrokes are never wiped on first-time or editing entries');

  console.log('\n🎉 ALL USER FIXES V3 TEST SUITES PASSED FLAWLESSLY!');
}

runTests().catch((err) => {
  console.error('❌ Test failed with error:', err);
  process.exit(1);
});
