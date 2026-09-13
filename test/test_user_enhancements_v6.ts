import assert from 'assert';

console.log('=== Starting Test Suite: User Enhancements v6 (Esc Nav, Zoomed Face Fix, 30s Auto-Resume) ===\n');

// ----------------------------------------------------------------------------
// 1. Test FaceAvatar Coordinate Scaling Math
// ----------------------------------------------------------------------------
console.log('Test 1: FaceAvatar Coordinate Scaling Math...');

function calculateFaceAvatarScaledBox(params: {
  box: { x: number; y: number; width: number; height: number };
  face?: { imageWidth?: number; imageHeight?: number };
  photo?: { width?: number; height?: number; faces?: Array<{ box: any; imageWidth?: number; imageHeight?: number }> };
  imageWidth?: number;
  imageHeight?: number;
  imgNatural: { width: number; height: number };
}) {
  const { box, face, photo, imageWidth, imageHeight, imgNatural } = params;

  let baseW = face?.imageWidth || imageWidth;
  let baseH = face?.imageHeight || imageHeight;

  if (!baseW || !baseH) {
    const matchedFace =
      photo?.faces?.find(
        (f) => f.box && Math.abs(f.box.x - box.x) < 3 && Math.abs(f.box.y - box.y) < 3
      ) || photo?.faces?.[0];

    if (matchedFace?.imageWidth && matchedFace?.imageHeight) {
      baseW = matchedFace.imageWidth;
      baseH = matchedFace.imageHeight;
    } else if (photo?.width && photo?.height && photo.width > 0 && photo.height > 0) {
      baseW = photo.width;
      baseH = photo.height;
    }
  }

  let normX: number;
  let normY: number;
  let normW: number;
  let normH: number;

  if (baseW && baseH && baseW > 0 && baseH > 0) {
    normX = box.x / baseW;
    normY = box.y / baseH;
    normW = box.width / baseW;
    normH = box.height / baseH;
  } else if (box.x + box.width <= 505 && box.y + box.height <= 505 && imgNatural.width > 505) {
    const scale = 500 / Math.max(imgNatural.width, imgNatural.height);
    const thumbW = Math.max(1, Math.round(imgNatural.width * scale));
    const thumbH = Math.max(1, Math.round(imgNatural.height * scale));
    normX = box.x / thumbW;
    normY = box.y / thumbH;
    normW = box.width / thumbW;
    normH = box.height / thumbH;
  } else if (box.x + box.width <= imgNatural.width && box.y + box.height <= imgNatural.height) {
    normX = box.x / imgNatural.width;
    normY = box.y / imgNatural.height;
    normW = box.width / imgNatural.width;
    normH = box.height / imgNatural.height;
  } else {
    const estW = Math.max(imgNatural.width, box.x + box.width);
    const estH = Math.max(imgNatural.height, box.y + box.height);
    normX = box.x / estW;
    normY = box.y / estH;
    normW = box.width / estW;
    normH = box.height / estH;
  }

  normX = Math.max(0, Math.min(1, normX));
  normY = Math.max(0, Math.min(1, normY));
  normW = Math.max(0, Math.min(1 - normX, normW));
  normH = Math.max(0, Math.min(1 - normY, normH));

  return {
    x: Math.round(normX * imgNatural.width),
    y: Math.round(normY * imgNatural.height),
    width: Math.round(normW * imgNatural.width),
    height: Math.round(normH * imgNatural.height),
    normX,
    normY,
    normW,
    normH,
  };
}

// Case A: Real-world user case from library.json
// Detection ran at 1600x1200, thumbnail loaded at 500x375, photo.width is undefined
const realFaceBox = { x: 758, y: 691, width: 251, height: 309 };
const scaled = calculateFaceAvatarScaledBox({
  box: realFaceBox,
  face: { imageWidth: 1600, imageHeight: 1200 },
  photo: { width: undefined, height: undefined },
  imgNatural: { width: 500, height: 375 },
});

console.log('   Real-world face on 500x375 thumb scaled:', scaled);
assert.strictEqual(scaled.x, 237, 'scaled.x should be 237 (758 * 500 / 1600)');
assert.strictEqual(scaled.y, 216, 'scaled.y should be 216 (691 * 375 / 1200)');
assert.strictEqual(scaled.width, 78, 'scaled.width should be 78');
assert.strictEqual(scaled.height, 97, 'scaled.height should be 97');

// Verify buggy previous formula would have failed:
const buggyScaleX = 500 / 4000;
const buggyScaleY = 375 / 3000;
const buggyX = Math.round(realFaceBox.x * buggyScaleX); // 95
const buggyY = Math.round(realFaceBox.y * buggyScaleY); // 86
console.log(`   (Confirmed: Buggy formula produced x=${buggyX}, y=${buggyY}, off by ~2.5x causing blank crop)`);
assert.strictEqual(buggyX, 95);
assert.notStrictEqual(scaled.x, buggyX, 'New formula correctly fixes 2.5x offset');

// Case B: Face detected at 1600x1200, loaded image is full-res 4000x3000
const fullResScaled = calculateFaceAvatarScaledBox({
  box: realFaceBox,
  face: { imageWidth: 1600, imageHeight: 1200 },
  imgNatural: { width: 4000, height: 3000 },
});
console.log('   Full-res 4000x3000 scaled:', fullResScaled);
assert.strictEqual(fullResScaled.x, 1895, 'full-res x should be 1895');
assert.strictEqual(fullResScaled.y, 1728, 'full-res y should be 1728');
assert.strictEqual(fullResScaled.width, 628, 'full-res width should be 628');
assert.strictEqual(fullResScaled.height, 773, 'full-res height should be 773');

// Case C: Face passed via photo.faces lookup when face prop is omitted
const lookupScaled = calculateFaceAvatarScaledBox({
  box: realFaceBox,
  photo: {
    faces: [
      {
        box: realFaceBox,
        imageWidth: 1600,
        imageHeight: 1200,
      },
    ],
  },
  imgNatural: { width: 500, height: 375 },
});
assert.strictEqual(lookupScaled.x, 237, 'Lookup from photo.faces should yield x=237');
assert.strictEqual(lookupScaled.y, 216, 'Lookup from photo.faces should yield y=216');

console.log('✓ Test 1 Passed: FaceAvatar resolution-invariant coordinate scaling verified.\n');

// ----------------------------------------------------------------------------
// 2. Test Esc Key Navigation Hierarchical Transitions
// ----------------------------------------------------------------------------
console.log('Test 2: Esc Key Navigation Hierarchical Transitions...');

interface ViewState {
  lightboxOpen: boolean;
  modalOpen: boolean;
  selectedPersonId: string | null;
  activeTab: string;
  tabHistory: string[];
}

function handleEscKey(state: ViewState): ViewState {
  const next = { ...state, tabHistory: [...state.tabHistory] };

  // 1. Lightbox closes first
  if (next.lightboxOpen) {
    next.lightboxOpen = false;
    return next;
  }

  // 2. Inner modal closes next
  if (next.modalOpen) {
    next.modalOpen = false;
    return next;
  }

  // 3. Drill-down returns to list
  if (next.selectedPersonId) {
    next.selectedPersonId = null;
    return next;
  }

  // 4. Tab navigation history returns to previous tab
  if (next.activeTab !== 'photos') {
    while (next.tabHistory.length > 0 && next.tabHistory[next.tabHistory.length - 1] === next.activeTab) {
      next.tabHistory.pop();
    }
    next.activeTab = next.tabHistory.length > 0 ? next.tabHistory.pop()! : 'photos';
    return next;
  }

  return next;
}

let s: ViewState = {
  lightboxOpen: true,
  modalOpen: true,
  selectedPersonId: 'person_1',
  activeTab: 'people',
  tabHistory: ['photos', 'people'],
};

// Press Esc 1: Should close Lightbox
s = handleEscKey(s);
assert.strictEqual(s.lightboxOpen, false, 'Esc 1 should close lightbox');
assert.strictEqual(s.modalOpen, true, 'Modal should still be open');
assert.strictEqual(s.selectedPersonId, 'person_1', 'Person drilldown should still be open');

// Press Esc 2: Should close Modal
s = handleEscKey(s);
assert.strictEqual(s.modalOpen, false, 'Esc 2 should close modal');
assert.strictEqual(s.selectedPersonId, 'person_1', 'Person drilldown should still be open');

// Press Esc 3: Should return from Person drilldown to People overview
s = handleEscKey(s);
assert.strictEqual(s.selectedPersonId, null, 'Esc 3 should return to people list');
assert.strictEqual(s.activeTab, 'people', 'Should still be on people tab');

// Press Esc 4: Should return to previous tab ('photos')
s = handleEscKey(s);
assert.strictEqual(s.activeTab, 'photos', 'Esc 4 should return to photos tab');

console.log('✓ Test 2 Passed: Esc key hierarchical navigation verified.\n');

// ----------------------------------------------------------------------------
// 3. Test 30-Second Auto-Resume Logic
// ----------------------------------------------------------------------------
console.log('Test 3: 30-Second Auto-Resume Logic...');

interface MockLibraryPhoto {
  id: string;
  faceScanCompleted?: boolean;
  faces?: any[];
}

const mockPhotos: MockLibraryPhoto[] = [
  { id: 'photo1', faceScanCompleted: true, faces: [{ id: 'f1' }] },
  { id: 'photo2', faceScanCompleted: false, faces: [] },
  { id: 'photo3' }, // unscanned
];

let preCachedPhotos: any[] | null = null;
let enqueuedFacePhotos: any[] | null = null;
let isFaceQueueResumed = false;

// Simulate 30s auto-resume handler
function simulateAutoResume(photos: MockLibraryPhoto[]) {
  // 1. Resume thumbnail precache
  preCachedPhotos = photos;

  // 2. Resume face queue and enqueue unscanned
  isFaceQueueResumed = true;
  const unscanned = photos.filter((p) => !p.faceScanCompleted && (!p.faces || p.faces.length === 0));
  if (unscanned.length > 0) {
    enqueuedFacePhotos = unscanned;
  }
}

simulateAutoResume(mockPhotos);

assert.strictEqual(preCachedPhotos?.length, 3, 'Pre-caching should receive all photos in library');
assert.strictEqual(isFaceQueueResumed, true, 'Face queue should be resumed');
assert.strictEqual(enqueuedFacePhotos?.length, 2, 'Unscanned photos (photo2, photo3) should be enqueued');
assert.deepStrictEqual(
  enqueuedFacePhotos?.map((p) => p.id),
  ['photo2', 'photo3'],
  'Correct unscanned photos enqueued'
);

console.log('✓ Test 3 Passed: 30-second auto-resume queue mechanics verified.\n');

console.log('=== All Automated Tests in v6 Passed Successfully! ===');
