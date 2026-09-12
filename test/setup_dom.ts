/**
 * setup_dom.ts
 *
 * Pre-initializes JSDOM global window, document, and navigator
 * BEFORE any library (like Leaflet or React) evaluates.
 */

import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!DOCTYPE html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost:5173',
  pretendToBeVisual: true,
});

const { window } = dom;

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Assign to global
(global as any).window = window;
(global as any).document = window.document;
(global as any).navigator = window.navigator;
(global as any).alert = (msg: string) => {};
(window as any).alert = (msg: string) => {};

const util = require('util');
(global as any).TextEncoder = util.TextEncoder;
(global as any).TextDecoder = util.TextDecoder;
(globalThis as any).TextEncoder = util.TextEncoder;
(globalThis as any).TextDecoder = util.TextDecoder;
(window as any).TextEncoder = util.TextEncoder;
(window as any).TextDecoder = util.TextDecoder;

const storageMap = new Map<string, string>();
const mockLocalStorage = {
  getItem: (k: string) => storageMap.get(k) || null,
  setItem: (k: string, v: string) => storageMap.set(k, String(v)),
  removeItem: (k: string) => storageMap.delete(k),
  clear: () => storageMap.clear(),
  get length() { return storageMap.size; },
  key: (idx: number) => Array.from(storageMap.keys())[idx] || null,
};
(global as any).localStorage = mockLocalStorage;
(window as any).localStorage = mockLocalStorage;
(global as any).Element = window.Element;
(global as any).Node = window.Node;
(global as any).HTMLElement = window.HTMLElement;
(global as any).HTMLImageElement = window.HTMLImageElement;
(global as any).HTMLDivElement = window.HTMLDivElement;
(global as any).Image = window.Image;
(global as any).Event = window.Event;
(global as any).CustomEvent = window.CustomEvent;
(global as any).MouseEvent = window.MouseEvent;
(global as any).PointerEvent = (window as any).PointerEvent || window.MouseEvent;
(global as any).customElements = window.customElements;
(global as any).requestAnimationFrame = (cb: any) => setTimeout(cb, 16);
(global as any).cancelAnimationFrame = (id: any) => clearTimeout(id);
window.open = () => null;

// Canvas mock for Leaflet and Face-API
(window.HTMLCanvasElement.prototype as any).getContext = () => ({
  drawImage: () => {},
  getImageData: () => ({ data: new Uint8ClampedArray(4) }),
  putImageData: () => {},
  createImageData: () => [],
  setTransform: () => {},
  fillRect: () => {},
  clearRect: () => {},
  measureText: () => ({ width: 10 }),
});
(window.HTMLCanvasElement.prototype as any).toDataURL = () => 'data:image/jpeg;base64,mock';

// Complete mock for window.electronAPI
(window as any).electronAPI = {
  selectDirectory: async () => 'C:\\photos',
  scanDirectory: async () => [],
  saveLibraryData: async () => true,
  loadLibraryData: async () => null,
  scanVirtualMirror: async () => [],
  syncVirtualStorage: async () => ({ newlyAdded: 0, totalSynced: 0, totalSizeSaved: 0 }),
  discoverMirrors: async () => [],
  checkFileExists: async () => true,
  checkIsOnline: async () => true,
  readDirectoryTree: async () => [
    { name: 'Vacations', path: 'C:\\photos\\Vacations', hasChildren: true, photoCount: 4 },
    { name: 'Family', path: 'C:\\photos\\Family', hasChildren: false, photoCount: 2 },
  ],
  readFolderPhotos: async () => [],
  editPhoto: async () => ({ success: true }),
  trashFiles: async () => ({ success: true, trashedCount: 1, errors: [] }),
  startBackgroundScan: async () => ({ started: true }),
  onBackgroundScanProgress: () => () => {},
  deleteVirtualStorage: async () => ({ success: true }),
  getBackgroundServiceStatus: async () => ({
    isRunning: true,
    minimizeToTray: true,
    autoLaunchOnStartup: false,
    syncIntervalMinutes: 30,
    lastSyncTime: Date.now(),
  }),
  setBackgroundServiceSettings: async () => true,
  triggerBackgroundServiceSync: async () => ({ started: true }),
  installSystemService: async () => ({ success: true }),
  uninstallSystemService: async () => ({ success: true }),
  getServiceLogs: async () => [
    '[2026-09-12 11:50:00] Daemon started.',
    '[2026-09-12 11:55:00] Background sync cycle completed. Synced 0 items.',
  ],
  openHelpInBrowser: async () => true,
};
