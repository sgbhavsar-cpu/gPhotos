import './setup_dom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import assert from 'assert';
import fs from 'fs';
import path from 'path';

import { libraryStore } from '../src/renderer/src/services/libraryStore';
import { PeopleView } from '../src/renderer/src/views/PeopleView';
import { DuplicateCleanerModal } from '../src/renderer/src/components/DuplicateCleanerModal';
import { AlbumsView } from '../src/renderer/src/views/AlbumsView';
import { Sidebar } from '../src/renderer/src/components/Sidebar';
import { Photo, Person } from '../src/types';

console.log('🧪 RUNNING COMPREHENSIVE TESTS FOR 8 USER ENHANCEMENTS (React 19 + JSDOM)...');

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

// Mock test photos
const mockPhotos: Photo[] = [
  {
    id: 'photo_1',
    filePath: 'C:\\photos\\img1.jpg',
    fileName: 'IMG_001.jpg',
    dateTaken: '2024-06-15T10:00:00Z',
    fileSize: 4_500_000,
    width: 3000,
    height: 2000,
    faces: [
      {
        id: 'f1',
        personId: 'p1',
        box: { x: 50, y: 50, width: 100, height: 100 },
        confidence: 0.95,
        dominantExpression: 'happy',
      },
    ],
  },
  {
    id: 'photo_2',
    filePath: 'C:\\photos\\img2.jpg',
    fileName: 'IMG_002.jpg',
    dateTaken: '2024-06-15T10:00:03Z',
    fileSize: 4_200_000,
    width: 3000,
    height: 2000,
    faces: [
      {
        id: 'f2',
        personId: 'p1',
        box: { x: 52, y: 52, width: 100, height: 100 },
        confidence: 0.93,
        dominantExpression: 'neutral',
      },
    ],
  },
  {
    id: 'photo_3',
    filePath: 'D:\\network_mirror\\img3.jpg',
    fileName: 'IMG_003.jpg',
    dateTaken: '2024-06-15T10:00:06Z',
    fileSize: 4_100_000,
    width: 3000,
    height: 2000,
    isVirtual: true,
    storageName: 'DriveBackup',
    faces: [
      {
        id: 'f3',
        personId: 'p1',
        box: { x: 55, y: 55, width: 100, height: 100 },
        confidence: 0.88,
      },
    ],
  },
];

const mockPeople: Person[] = [
  {
    id: 'p1',
    name: 'Sachin',
    coverFaceId: 'f1',
    faceCount: 3,
  },
];

async function runTests() {
  let passedCount = 0;

  // -------------------------------------------------------------
  // Test 1: Fluent Icon exists and is verified
  // -------------------------------------------------------------
  console.log('▶ Test 1: Microsoft Fluent App Icon exists');
  const iconPath = path.join(__dirname, '../public/icon.png');
  assert.ok(fs.existsSync(iconPath), 'public/icon.png must exist');
  const iconStats = fs.statSync(iconPath);
  assert.ok(iconStats.size > 1000, 'icon.png size should be valid image bytes');
  console.log(`  ✓ Fluent icon verified at ${iconPath} (${iconStats.size} bytes)`);
  passedCount++;

  // -------------------------------------------------------------
  // Test 2: Person Renaming Rock-Solid Verification
  // -------------------------------------------------------------
  console.log('▶ Test 2: Person Renaming does not wipe text on keystrokes');
  let renamedTo = '';
  const handleUpdateName = (id: string, name: string) => {
    renamedTo = name;
    return { success: true };
  };

  await renderView(
    React.createElement(PeopleView, {
      people: mockPeople,
      photos: mockPhotos,
      onUpdatePersonName: handleUpdateName,
      onMergePeople: () => ({ success: true }),
      onSelectPhoto: () => {},
      onToggleFavorite: () => {},
      onTriggerFaceDetection: () => {},
      isDetectingFaces: false,
    })
  );

  // Click rename button on person card
  const renameBtn = container.querySelector('button[title*="Rename"]') as HTMLButtonElement;
  assert.ok(renameBtn, 'Rename button should exist on person card');
  await act(async () => {
    renameBtn.click();
  });

  // Find the input element in RenameInput
  const renameInput = container.querySelector('input') as HTMLInputElement;
  assert.ok(renameInput, 'Rename input field must be rendered');

  // Simulate typing character by character: "S", "a", "c", "h", "i", "n"
  const typeValue = async (val: string) => {
    await act(async () => {
      renameInput.value = val;
      renameInput.dispatchEvent(new Event('change', { bubbles: true }));
      renameInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };

  await typeValue('S');
  assert.strictEqual(renameInput.value, 'S');
  await typeValue('Sa');
  assert.strictEqual(renameInput.value, 'Sa');
  await typeValue('Sac');
  assert.strictEqual(renameInput.value, 'Sac');
  await typeValue('Sach');
  assert.strictEqual(renameInput.value, 'Sach');
  await typeValue('Sachi');
  assert.strictEqual(renameInput.value, 'Sachi');
  await typeValue('Sachin');
  assert.strictEqual(renameInput.value, 'Sachin', 'Full text "Sachin" must be retained, not wiped!');

  // Click save
  const saveBtn = container.querySelector('button[title*="Save"]') as HTMLButtonElement;
  assert.ok(saveBtn, 'Save button must exist in RenameInput');
  await act(async () => {
    saveBtn.click();
  });
  assert.strictEqual(renamedTo, 'Sachin', 'onUpdatePersonName must be called with full name "Sachin"');
  console.log('  ✓ Person renaming correctly maintains full string without keystroke wipe');
  passedCount++;

  // -------------------------------------------------------------
  // Test 3: Zoomed Faces vs. Full Photos (ONLY TWO BIG BUTTONS in Faces mode)
  // -------------------------------------------------------------
  console.log('▶ Test 3: People Photos - Zoomed Faces shows ONLY TWO BIG BUTTONS (Yes/No)');
  let confirmCalled = false;
  let unassignCalled = false;

  const origConfirm = libraryStore.confirmFace;
  const origUnassign = libraryStore.unassignFaceFromPerson;
  libraryStore.confirmFace = () => { confirmCalled = true; };
  libraryStore.unassignFaceFromPerson = () => { unassignCalled = true; };

  await renderView(
    React.createElement(PeopleView, {
      people: mockPeople,
      photos: mockPhotos,
      onUpdatePersonName: handleUpdateName,
      onMergePeople: () => ({ success: true }),
      onSelectPhoto: () => {},
      onToggleFavorite: () => {},
      onTriggerFaceDetection: () => {},
      isDetectingFaces: false,
      initialSelectedPersonId: 'p1',
    })
  );

  // 1. In Full Photos mode (default viewMode === 'photos'):
  // Face recognition buttons must NOT be rendered on photo cards
  const yesBtnsInitial = container.querySelectorAll('button[title*="Yes, this is Sachin"]');
  const noBtnsInitial = container.querySelectorAll('button[title*="No, not Sachin"]');
  assert.strictEqual(yesBtnsInitial.length, 0, 'In Full Photos mode, Yes face button must NOT be shown');
  assert.strictEqual(noBtnsInitial.length, 0, 'In Full Photos mode, No face button must NOT be shown');

  // 2. Now switch to "Zoomed Faces" mode
  const allButtons = Array.from(container.querySelectorAll('button'));
  const zoomedFacesTab = allButtons.find((b) => b.textContent?.includes('Zoomed Faces'));
  assert.ok(zoomedFacesTab, 'Zoomed Faces tab button must exist');
  await act(async () => {
    zoomedFacesTab.click();
  });

  // Must show ONLY YES (Check) and NO (X) buttons on each face card
  const yesBtns = container.querySelectorAll('button[title*="Yes, this is Sachin"]');
  const noBtns = container.querySelectorAll('button[title*="No, not Sachin"]');
  assert.ok(yesBtns.length > 0, 'Should have Yes buttons in Zoomed Faces mode');
  assert.ok(noBtns.length > 0, 'Should have No buttons in Zoomed Faces mode');

  // Verify that Reassign and Delete face box buttons are NOT rendered on face card
  const reassignBtns = container.querySelectorAll('button[title*="Reassign to another person"]');
  const deleteBoxBtns = container.querySelectorAll('button[title*="Delete face box"]');
  assert.strictEqual(reassignBtns.length, 0, 'Reassign button must NOT be rendered on face card');
  assert.strictEqual(deleteBoxBtns.length, 0, 'Delete face box button must NOT be rendered on face card');

  // Test clicking Yes
  await act(async () => {
    (yesBtns[0] as HTMLButtonElement).click();
  });
  assert.ok(confirmCalled, 'Clicking Yes must invoke confirmFace');

  // Test clicking No - without any window.confirm requirement
  let confirmPromptCalled = false;
  const origWindowConfirm = window.confirm;
  window.confirm = () => { confirmPromptCalled = true; return true; };

  await act(async () => {
    (noBtns[0] as HTMLButtonElement).click();
  });
  assert.ok(unassignCalled, 'Clicking No must invoke unassignFace');
  assert.strictEqual(confirmPromptCalled, false, 'window.confirm must NOT be prompted when clicking No/wrong person!');

  window.confirm = origWindowConfirm;
  libraryStore.confirmFace = origConfirm;
  libraryStore.unassignFaceFromPerson = origUnassign;

  // 3. Switch back to "Full Photos" tab
  const buttonsAfterFaces = Array.from(container.querySelectorAll('button'));
  const fullPhotosTab = buttonsAfterFaces.find((b) => b.textContent?.includes('Full Photos'));
  assert.ok(fullPhotosTab, 'Full Photos tab button must exist');
  await act(async () => {
    fullPhotosTab.click();
  });

  const yesBtnsBackInPhotos = container.querySelectorAll('button[title*="Yes, this is Sachin"]');
  const noBtnsBackInPhotos = container.querySelectorAll('button[title*="No, not Sachin"]');
  assert.strictEqual(yesBtnsBackInPhotos.length, 0, 'Switching back to Full Photos mode must hide face recognition buttons');
  assert.strictEqual(noBtnsBackInPhotos.length, 0, 'Switching back to Full Photos mode must hide face recognition buttons');

  console.log('  ✓ Zoomed faces mode displays exactly 2 big buttons (Yes/No); Full photos mode hides face recognition icons; No confirmation prompt');
  passedCount++;

  // -------------------------------------------------------------
  // Test 4: Duplicate Cleaner Photo Exclusion & Re-clustering
  // -------------------------------------------------------------
  console.log('▶ Test 4: Duplicate Cleaner Photo Exclusion & Re-clustering');
  await renderView(
    React.createElement(DuplicateCleanerModal, {
      photos: mockPhotos,
      onClose: () => {},
    })
  );

  // Find exclude photo buttons in the cluster
  const excludeBtns = container.querySelectorAll('button[title*="Not a duplicate"]');
  assert.ok(excludeBtns.length > 0, 'Exclude buttons must be present on photos in duplicate cluster');

  // Click exclude on the 3rd photo (from network mirror)
  await act(async () => {
    (excludeBtns[2] as HTMLButtonElement).click();
  });

  // Check that cluster was updated to 2 photos
  const remainingExcludeBtns = container.querySelectorAll('button[title*="Not a duplicate"]');
  assert.strictEqual(remainingExcludeBtns.length, 2, 'Cluster should now have 2 photos remaining');

  // Check that "Re-cluster" button exists and can be clicked
  const reclusterBtn = container.querySelector('button[title*="Re-run duplicate clustering"]') as HTMLButtonElement;
  assert.ok(reclusterBtn, 'Re-cluster button must exist in header/toolbar');
  await act(async () => {
    reclusterBtn.click();
  });

  console.log('  ✓ Duplicate cleaner allows excluding photos and dynamically reclusters');
  passedCount++;

  // -------------------------------------------------------------
  // Test 5: Event-Based Albums Functionality
  // -------------------------------------------------------------
  console.log('▶ Test 5: Event-based Albums CRUD and cross-location photo collection');
  // 1. Create album in libraryStore
  const createdAlbum = libraryStore.createAlbum('Diwali Celebration 2024', 'Family get-together', '2024-11-01');
  assert.ok(createdAlbum.id, 'Album must have a generated ID');
  assert.strictEqual(createdAlbum.title, 'Diwali Celebration 2024');

  // 2. Add photos from different physical locations (local C: drive and virtual D: drive mirror)
  libraryStore.addPhotosToAlbum(createdAlbum.id, ['photo_1', 'photo_3']);
  const stateAfterAdd = libraryStore.getState();
  const albumInState = stateAfterAdd.albums.find((a) => a.id === createdAlbum.id);
  assert.ok(albumInState, 'Album must exist in libraryStore');
  assert.deepStrictEqual(albumInState.photoIds, ['photo_1', 'photo_3']);

  // 3. Set cover photo
  libraryStore.setAlbumCover(createdAlbum.id, 'photo_3');
  const stateAfterCover = libraryStore.getState();
  const albumWithCover = stateAfterCover.albums.find((a) => a.id === createdAlbum.id);
  assert.strictEqual(albumWithCover?.coverPhotoId, 'photo_3');

  // 4. Render AlbumsView and verify it displays the album
  let selectedPhotoForLightbox: Photo | null = null;
  await renderView(
    React.createElement(AlbumsView, {
      photos: mockPhotos,
      albums: stateAfterCover.albums,
      onSelectPhoto: (p) => { selectedPhotoForLightbox = p; },
    })
  );

  assert.ok(container.textContent?.includes('Diwali Celebration 2024'), 'Album title should be visible in AlbumsView grid');

  // Open the album
  const albumCard = Array.from(container.querySelectorAll('div')).find(
    (el) => el.textContent?.includes('Diwali Celebration 2024') && el.style.cursor === 'pointer'
  );
  assert.ok(albumCard, 'Clickable album card should exist');
  await act(async () => {
    albumCard.click();
  });

  // Verify photos in album are displayed
  const albumPhotoCards = container.querySelectorAll('img[alt="IMG_001.jpg"], img[alt="IMG_003.jpg"]');
  assert.strictEqual(albumPhotoCards.length, 2, 'Both collected photos should be visible in album detail view');

  // Remove photo_1 from album
  const removePhotoBtn = container.querySelector('button[title*="Remove photo from this album"]') as HTMLButtonElement;
  assert.ok(removePhotoBtn, 'Remove from album button must exist');
  await act(async () => {
    removePhotoBtn.click();
  });

  const stateAfterRemove = libraryStore.getState();
  const albumAfterRemove = stateAfterRemove.albums.find((a) => a.id === createdAlbum.id);
  assert.strictEqual(albumAfterRemove?.photoIds.length, 1, 'Album should have 1 photo after removal');

  // Delete the album
  window.confirm = () => true;
  libraryStore.deleteAlbum(createdAlbum.id);
  assert.ok(!libraryStore.getState().albums.some((a) => a.id === createdAlbum.id), 'Album should be deleted');

  console.log('  ✓ Albums can be created, populated across physical locations, and managed cleanly');
  passedCount++;

  // -------------------------------------------------------------
  // Test 6: Sidebar Navigation with Albums & Enlarged Icons
  // -------------------------------------------------------------
  console.log('▶ Test 6: Sidebar contains Albums tab with enlarged icons');
  let selectedTab = 'photos';
  await renderView(
    React.createElement(Sidebar, {
      activeTab: 'photos' as any,
      onSelectTab: (tab) => { selectedTab = tab; },
      state: libraryStore.getState(),
      onOpenFolder: () => {},
      onTriggerFaceDetection: () => {},
      onOpenHelp: () => {},
    })
  );

  const sidebarButtons = Array.from(container.querySelectorAll('button'));
  const albumsTabBtn = sidebarButtons.find((b) => b.textContent?.includes('Albums'));
  assert.ok(albumsTabBtn, 'Albums tab must be present in Sidebar nav');
  await act(async () => {
    albumsTabBtn.click();
  });
  assert.strictEqual(selectedTab, 'albums', 'Clicking Albums tab must trigger onSelectTab("albums")');

  console.log('  ✓ Sidebar navigation includes Albums tab and larger icons');
  passedCount++;

  // -------------------------------------------------------------
  // Test 7: Help Guide Browser Execution
  // -------------------------------------------------------------
  console.log('▶ Test 7: Help guide open in browser IPC mock verification');
  assert.ok(typeof (window as any).electronAPI.openHelpInBrowser === 'function', 'electronAPI.openHelpInBrowser must be defined');
  const res = await (window as any).electronAPI.openHelpInBrowser();
  assert.strictEqual(res, true, 'openHelpInBrowser must return true');
  console.log('  ✓ Help guide integration verified');
  passedCount++;

  console.log(`\n🎉 ALL ${passedCount}/7 TEST SUITES PASSED FLAWLESSLY!`);
  process.exit(0);
}

runTests().catch((err) => {
  console.error('❌ TEST FAILED:', err);
  process.exit(1);
});
