import { JSDOM } from 'jsdom';
import assert from 'assert';

console.log('=== Verifying App Component Rendering & Hook Execution in JSDOM ===');

const dom = new JSDOM('<!DOCTYPE html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost:5173',
  pretendToBeVisual: true,
});

(global as any).window = dom.window;
(global as any).document = dom.window.document;
(global as any).navigator = dom.window.navigator;
(global as any).Image = dom.window.Image;
(global as any).HTMLElement = dom.window.HTMLElement;

const storageMap = new Map();
const mockLocalStorage = {
  getItem: (k: string) => storageMap.get(k) ?? null,
  setItem: (k: string, v: string) => storageMap.set(k, String(v)),
  removeItem: (k: string) => storageMap.delete(k),
  clear: () => storageMap.clear(),
};
(global as any).localStorage = mockLocalStorage;
(globalThis as any).localStorage = mockLocalStorage;
dom.window.localStorage = mockLocalStorage;

// Mock electronAPI
(global as any).window.electronAPI = {
  loadLibraryData: async () => null,
  saveLibraryData: async () => true,
  getStorageCheckpoints: async () => ({}),
  getAllLibraryStatuses: async () => [],
  startThumbnailPreCache: async () => ({ started: true }),
  sendAppReady: () => {},
  onBackgroundScanProgress: () => () => {},
  onMirrorProgress: () => () => {},
};

// Also set on globalThis
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;

async function testRender() {
  const React = await import('react');
  const ReactDOM = await import('react-dom/client');
  const { App } = await import('../src/renderer/src/App');
  const { PeopleView } = await import('../src/renderer/src/views/PeopleView');
  const { GalleryView } = await import('../src/renderer/src/views/GalleryView');
  const { AlbumsView } = await import('../src/renderer/src/views/AlbumsView');
  const { PlacesMapView } = await import('../src/renderer/src/views/PlacesMapView');

  const container = dom.window.document.getElementById('root')!;
  const root = ReactDOM.createRoot(container);

  // 1. Mount App
  console.log('1. Mounting <App />...');
  await React.act(async () => {
    root.render(React.createElement(App));
  });
  console.log('✓ <App /> mounted without ReferenceErrors.');

  // 2. Mount GalleryView directly
  console.log('2. Mounting <GalleryView />...');
  const galleryDiv = dom.window.document.createElement('div');
  const galleryRoot = ReactDOM.createRoot(galleryDiv);
  await React.act(async () => {
    galleryRoot.render(
      React.createElement(GalleryView, {
        photos: [],
        onSelectPhoto: () => {},
        onToggleFavorite: () => {},
        onOpenFolder: () => {},
      })
    );
  });
  console.log('✓ <GalleryView /> rendered without ReferenceErrors.');

  // 3. Mount PeopleView directly
  console.log('3. Mounting <PeopleView />...');
  const peopleDiv = dom.window.document.createElement('div');
  const peopleRoot = ReactDOM.createRoot(peopleDiv);
  await React.act(async () => {
    peopleRoot.render(
      React.createElement(PeopleView, {
        people: [{ id: 'p1', name: 'Person 1', faceCount: 1, photoCount: 1, createdAt: '' }],
        photos: [{ id: 'ph1', filePath: 'test.jpg', fileName: 'test.jpg' }],
        onUpdatePersonName: () => {},
        onMergePeople: () => {},
        onSelectPhoto: () => {},
        onToggleFavorite: () => {},
        onTriggerFaceDetection: () => {},
        isDetectingFaces: false,
      })
    );
  });
  console.log('✓ <PeopleView /> rendered without ReferenceErrors.');

  // 4. Mount AlbumsView directly
  console.log('4. Mounting <AlbumsView />...');
  const albumsDiv = dom.window.document.createElement('div');
  const albumsRoot = ReactDOM.createRoot(albumsDiv);
  await React.act(async () => {
    albumsRoot.render(
      React.createElement(AlbumsView, {
        photos: [],
        albums: [],
        onSelectPhoto: () => {},
      })
    );
  });
  console.log('✓ <AlbumsView /> rendered without ReferenceErrors.');

  // 5. Mount VirtualStorageView directly
  console.log('5. Mounting <VirtualStorageView />...');
  const { VirtualStorageView } = await import('../src/renderer/src/views/VirtualStorageView');
  const vsDiv = dom.window.document.createElement('div');
  const vsRoot = ReactDOM.createRoot(vsDiv);
  await React.act(async () => {
    vsRoot.render(
      React.createElement(VirtualStorageView, {
        onLoadMirroredPhotos: () => {},
        onStoragesUpdated: () => {},
        onBrowseFolderTree: () => {},
        onScanStorageFaces: () => {},
        storageProgressMap: {},
      })
    );
  });
  console.log('✓ <VirtualStorageView /> rendered without ReferenceErrors.');

  console.log('\n🎉 ALL VIEWS MOUNTED AND EXECUTED WITH ZERO ERRORS!');
  process.exit(0);
}

testRender().catch((err) => {
  console.error('💥 Render Test Failed:', err);
  process.exit(1);
});
