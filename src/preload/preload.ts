import { contextBridge, ipcRenderer } from 'electron';
import {
  IElectronAPI,
  OrganizeOptions,
  DryRunSummary,
  OrganizeProgress
} from '../types';

const electronAPI: IElectronAPI = {
  selectDirectory: () => ipcRenderer.invoke('dialog:select-directory'),
  scanDirectory: (dirPath: string) => ipcRenderer.invoke('scanner:scan-directory', dirPath),
  readExif: (filePath: string) => ipcRenderer.invoke('scanner:read-exif', filePath),
  analyzeDryRun: (options: OrganizeOptions): Promise<DryRunSummary> =>
    ipcRenderer.invoke('organizer:analyze-dryrun', options),
  executeOrganize: (options: OrganizeOptions) =>
    ipcRenderer.invoke('organizer:execute', options),
  onOrganizeProgress: (callback: (progress: OrganizeProgress) => void) => {
    const subscription = (_event: any, progress: OrganizeProgress) => callback(progress);
    ipcRenderer.on('organizer:progress', subscription);
    return () => {
      ipcRenderer.removeListener('organizer:progress', subscription);
    };
  },
  readFileAsBase64: (filePath: string) => ipcRenderer.invoke('file:read-base64', filePath),
  saveLibraryData: (key: string, data: any) => ipcRenderer.invoke('storage:save', key, data),
  loadLibraryData: (key: string, libraryDir?: string) => ipcRenderer.invoke('storage:load', key, libraryDir),
  syncVirtualStorage: (config) => ipcRenderer.invoke('mirror:sync-storage', config),
  scanVirtualMirror: (mirrorDirPath) => ipcRenderer.invoke('mirror:scan-virtual-mirror', mirrorDirPath),
  discoverMirrors: (rootPath) => ipcRenderer.invoke('mirror:list-stored-mirrors', rootPath),
  getDefaultMirrorRoot: () => ipcRenderer.invoke('mirror:get-default-root'),
  browseDirectory: (targetPath) => ipcRenderer.invoke('fs:browse-directory', targetPath),
  openOriginalFile: (filePath) => ipcRenderer.invoke('mirror:open-original', filePath),
  checkFileExists: (filePath) => ipcRenderer.invoke('file:check-exists', filePath),
  onMirrorProgress: (callback) => {
    const subscription = (_event: any, progress: any) => callback(progress);
    ipcRenderer.on('mirror:progress', subscription);
    return () => {
      ipcRenderer.removeListener('mirror:progress', subscription);
    };
  },
  startBackgroundScan: (sourcePath: string, mirrorRoot?: string, storageName?: string) =>
    ipcRenderer.invoke('mirror:start-bg-scan', sourcePath, mirrorRoot, storageName),
  onBackgroundScanProgress: (callback) => {
    const subscription = (_event: any, progress: any) => callback(progress);
    ipcRenderer.on('mirror:bg-scan-progress', subscription);
    return () => {
      ipcRenderer.removeListener('mirror:bg-scan-progress', subscription);
    };
  },
  readDirectoryTree: (dirPath: string) => ipcRenderer.invoke('storage:read-directory-tree', dirPath),
  readFolderPhotos: (folderPath: string) => ipcRenderer.invoke('storage:read-folder-photos', folderPath),
  generateThumbnailOnTheFly: (sourceFilePath: string, mirrorDirPath?: string) =>
    ipcRenderer.invoke('storage:generate-thumb-on-the-fly', sourceFilePath, mirrorDirPath),
  editPhoto: (options) => ipcRenderer.invoke('photo:edit', options),
  trashFiles: (filePaths: string[]) => ipcRenderer.invoke('file:trash-files', filePaths),
  deleteFilesPermanently: (filePaths: string[]) => ipcRenderer.invoke('file:delete-permanently', filePaths),
  rotatePhoto: (filePath: string, rotationDegrees: number, originalRemotePath?: string) =>
    ipcRenderer.invoke('photo:rotate', { filePath, rotationDegrees, originalRemotePath }),
  processPendingRotations: () => ipcRenderer.invoke('photo:process-pending-rotations'),
  deleteVirtualStorage: (params) => ipcRenderer.invoke('mirror:delete-storage', params),
  getBackgroundServiceStatus: () => ipcRenderer.invoke('service:get-status'),
  setBackgroundServiceSettings: (settings) => ipcRenderer.invoke('service:set-settings', settings),
  triggerBackgroundServiceSync: () => ipcRenderer.invoke('service:trigger-sync'),
  installSystemService: () => ipcRenderer.invoke('service:install-system-service'),
  uninstallSystemService: () => ipcRenderer.invoke('service:uninstall-system-service'),
  getServiceLogs: () => ipcRenderer.invoke('service:get-logs'),
  openHelpInBrowser: () => ipcRenderer.invoke('help:open-in-browser'),
  createLibraryBackupZip: (customPath?: string) => ipcRenderer.invoke('backup:export-zip', customPath),
  openItemInFolder: (filePath: string) => ipcRenderer.invoke('shell:show-item-in-folder', filePath),
  getWebServerStatus: () => ipcRenderer.invoke('webserver:get-status'),
  setWebServerSettings: (settings) => ipcRenderer.invoke('webserver:set-settings', settings),
  getWebServerPin: () => ipcRenderer.invoke('webserver:get-pin'),
  regenerateWebServerPin: () => ipcRenderer.invoke('webserver:regenerate-pin'),
  listPairedDevices: () => ipcRenderer.invoke('webserver:list-devices'),
  revokePairedDevice: (deviceId: string) => ipcRenderer.invoke('webserver:revoke-device', deviceId),
  revokeAllPairedDevices: () => ipcRenderer.invoke('webserver:revoke-all-devices'),
  prepareHeicHq: (filePath: string, photoId: string) => ipcRenderer.invoke('heic:prepare-hq', filePath, photoId),
  getBatchThumbnails: (params) => ipcRenderer.invoke('thumbnails:get-batch', params),
  sendAppReady: () => ipcRenderer.send('app:ready'),
  getCatalogMeta: (libraryDir?: string) => ipcRenderer.invoke('catalog:get-meta', libraryDir),
  getCatalogPage: (params) => ipcRenderer.invoke('catalog:get-page', params),
  switchLibrary: (targetPath: string) => ipcRenderer.invoke('catalog:switch-library', targetPath),
  getSpriteCoordinate: (photoPath: string) => ipcRenderer.invoke('sprite:get-coordinate', photoPath),
  getSpriteCoordinatesBatch: (photoPaths: string[]) => ipcRenderer.invoke('sprite:get-coordinates-batch', photoPaths),
  getThumbnailPreCacheStatus: () => ipcRenderer.invoke('service:get-precache-status'),
  startThumbnailPreCache: (photos) => ipcRenderer.invoke('service:start-precache', photos),
  pauseThumbnailPreCache: () => ipcRenderer.invoke('service:pause-precache'),
  getStorageCheckpoints: () => ipcRenderer.invoke('mirror:get-storage-checkpoints'),
  getLibraryStatus: (libraryPath: string) => ipcRenderer.invoke('library:get-status', libraryPath),
  saveLibraryStatus: (status: any) => ipcRenderer.invoke('library:save-status', status),
  getAllLibraryStatuses: () => ipcRenderer.invoke('library:get-all-statuses'),
  refreshThumbnailsFromSource: (items: Array<{ filePath: string; originalRemotePath?: string }>) =>
    ipcRenderer.invoke('thumbnails:refresh-from-source', items),
  getStorageDetails: (storageName: string, mirrorRoot?: string) =>
    ipcRenderer.invoke('mirror:get-storage-details', storageName, mirrorRoot),
  getAllStorageDetails: (mirrorRoot?: string) =>
    ipcRenderer.invoke('mirror:get-all-storage-details', mirrorRoot),
  getPersonAvatarPath: (personId: string, cacheKey: string) =>
    ipcRenderer.invoke('person:get-avatar-path', personId, cacheKey),
  savePersonAvatar: (personId: string, cacheKey: string, dataUrl: string) =>
    ipcRenderer.invoke('person:save-avatar', personId, cacheKey, dataUrl),
  deletePersonAvatar: (personId: string) => ipcRenderer.invoke('person:delete-avatar', personId),
  getOneDriveStatus: () => ipcRenderer.invoke('onedrive:get-status'),
  setOneDriveReclaimEnabled: (enabled: boolean) => ipcRenderer.invoke('onedrive:set-reclaim-enabled', enabled),
  markOneDriveReclaimable: (filePaths: string[]) => ipcRenderer.invoke('onedrive:mark-reclaimable', filePaths),
  runOneDriveHealthCheck: () => ipcRenderer.invoke('onedrive:run-health-check'),
  getOneDriveReclaimHealth: () => ipcRenderer.invoke('onedrive:get-reclaim-health'),
  resetOneDriveReclaimHealth: () => ipcRenderer.invoke('onedrive:reset-reclaim-health'),
  syncOnePhoto: (config, remoteFile: string) => ipcRenderer.invoke('mirror:sync-one-photo', config, remoteFile),
  scanStorageInventory: (networkSourcePath: string) => ipcRenderer.invoke('mirror:scan-inventory', networkSourcePath),
  getPhotosByStorageName: (storageName: string, mirrorRoot?: string) =>
    ipcRenderer.invoke('mirror:get-photos-by-storage', storageName, mirrorRoot),
  detectFacesBatch: (photos) => ipcRenderer.invoke('faces:detect-batch', photos),
  detectFacesForced: (photo) => ipcRenderer.invoke('faces:detect-one-forced', photo),
  computeDescriptorForRegion: (sourceFilePath: string, box) =>
    ipcRenderer.invoke('faces:compute-descriptor-for-region', sourceFilePath, box),
  listSourceFiles: (sourcePath: string) => ipcRenderer.invoke('mirror:list-source-files', sourcePath),
  logFromRenderer: (level, scope: string, message: string, meta?: Record<string, unknown>) =>
    ipcRenderer.send('logger:write', level, scope, message, meta),
  getLogLevelOverride: () => ipcRenderer.invoke('logger:get-level-override'),
  setLogLevelOverride: (overrideDebug: boolean) => ipcRenderer.invoke('logger:set-level-override', overrideDebug),
};

contextBridge.exposeInMainWorld('electronAPI', electronAPI);
