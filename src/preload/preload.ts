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
  loadLibraryData: (key: string) => ipcRenderer.invoke('storage:load', key),
  syncVirtualStorage: (config) => ipcRenderer.invoke('mirror:sync-storage', config),
  scanVirtualMirror: (mirrorDirPath) => ipcRenderer.invoke('mirror:scan-virtual-mirror', mirrorDirPath),
  discoverMirrors: (rootPath) => ipcRenderer.invoke('mirror:list-stored-mirrors', rootPath),
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
};

contextBridge.exposeInMainWorld('electronAPI', electronAPI);
