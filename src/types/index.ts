export interface ExifMetadata {
  cameraMake?: string;
  cameraModel?: string;
  lensModel?: string;
  iso?: number;
  fNumber?: number;
  exposureTime?: number;
  focalLength?: number;
  dateTimeOriginal?: string;
  orientation?: number;
}

export interface LocationMetadata {
  latitude: number;
  longitude: number;
  altitude?: number;
  city?: string;
  state?: string;
  country?: string;
  countryCode?: string;
  label?: string;
}

export interface DetectedFace {
  id: string;
  photoId: string;
  box: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  imageWidth?: number;
  imageHeight?: number;
  descriptor: number[]; // 128-dimensional CosFace embedding vector
  personId?: string;
  confidence: number;
  isConfirmed?: boolean;
  isManual?: boolean;
  age?: number;
  gender?: 'male' | 'female' | string;
  genderProbability?: number;
  expressions?: Record<string, number>;
  dominantExpression?: string;
}

export interface Person {
  id: string;
  name: string;
  coverFaceId?: string;
  coverPhotoId?: string;
  faceCount: number;
  photoCount: number;
  createdAt: string;
}

export interface Photo {
  id: string;
  filePath: string;
  fileName: string;
  fileSize: number;
  fileDate: string;
  dateTaken: string; // ISO date string used for timeline
  year: number;
  month: number;
  day: number;
  width?: number;
  height?: number;
  exif?: ExifMetadata;
  location?: LocationMetadata;
  faces?: DetectedFace[];
  isFavorite?: boolean;
  isVirtual?: boolean;
  originalRemotePath?: string;
  storageName?: string;
  isExcluded?: boolean;
  faceScanCompleted?: boolean;
  sharpnessScore?: number;
}

export interface FolderTreeNode {
  name: string;
  path: string;
  hasChildren: boolean;
  children?: FolderTreeNode[];
  photoCount?: number;
}

export interface BackgroundScanProgress {
  jobId: string;
  sourcePath: string;
  currentFile: string;
  processedCount: number;
  totalDiscovered: number;
  isComplete: boolean;
  newlyAddedPhotos?: Photo[];
  error?: string;
}

export interface EditPhotoOptions {
  filePath: string;
  originalPath?: string;
  rotationDegrees?: number; // 90, 180, 270
  flipHorizontal?: boolean;
  cropBox?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  saveAsCopy?: boolean;
  mirrorThumbnailPath?: string;
  base64Data?: string;
}

export interface EditPhotoResult {
  success: boolean;
  savedPath?: string;
  newPhoto?: Photo;
  error?: string;
}

export interface DuplicateCluster {
  id: string;
  clusterType: 'identical' | 'burst' | 'similar';
  photos: Photo[];
  bestPhotoId: string;
  bestReason: string;
  scores: Record<string, {
    totalScore: number;
    sharpnessScore: number;
    expressionScore: number;
    eyeOpenScore: number;
    resolutionScore: number;
  }>;
}

export interface VirtualStorageConfig {
  id: string;
  name: string;
  networkSourcePath: string;
  localMirrorRoot: string;
  lastSynced?: string;
  totalItems?: number;
  totalSizeSaved?: number;
  newlyAdded?: number;
  delayBetweenPhotosSec?: number;
  bandwidthLimitMbps?: number;
}

export interface SyncVirtualStorageResult {
  success: boolean;
  totalSynced: number;
  newlyAdded: number;
  totalSizeSaved: number;
  errors: string[];
}

export interface VirtualPhotoMetadata {
  fileName: string;
  originalFilePath: string;
  originalFileSize: number;
  dateTaken: string;
  width?: number;
  height?: number;
  thumbnailPath: string;
  storageName: string;
  storageRoot: string;
  relativePath: string;
  exif?: ExifMetadata;
  location?: LocationMetadata;
}

export interface MirrorProgress {
  storageName?: string;
  phase?: 'scanning' | 'thumbnails' | 'faces' | 'completed' | 'error';
  current: number;
  total: number;
  currentFile: string;
  status: 'scanning' | 'syncing' | 'completed' | 'error';
  errorMessage?: string;
  percent?: number;
}

export interface NetworkStorageProgress {
  storageName: string;
  phase: 'idle' | 'scanning' | 'thumbnails' | 'faces' | 'completed' | 'error';
  thumbnailCurrent: number;
  thumbnailTotal: number;
  faceCurrent: number;
  faceTotal: number;
  percent: number;
  message?: string;
  currentFile?: string;
  error?: string;
}

export interface PlaceAlbum {
  id: string;
  name: string;
  city?: string;
  country?: string;
  latitude: number;
  longitude: number;
  photoCount: number;
  coverPhotoId: string;
  coverFilePath?: string;
}

export type FolderStructure =
  | 'YYYY/YYYY-MM'
  | 'YYYY/MM - Month'
  | 'YYYY/YYYY-MM-DD'
  | 'YYYY/MM/DD';

export interface OrganizeOptions {
  sourceDir: string;
  targetDir: string;
  structure: FolderStructure;
  mode: 'copy' | 'move';
  conflictResolution: 'skip' | 'rename' | 'overwrite';
}

export interface DryRunItem {
  sourceFile: string;
  targetFile: string;
  date: string;
  isDuplicate: boolean;
  conflictAction: 'skip' | 'rename' | 'copy' | 'move';
  fileSize: number;
}

export interface DryRunSummary {
  totalFiles: number;
  items: DryRunItem[];
  totalSize: number;
  duplicateCount: number;
  targetFolders: string[];
}

export interface OrganizeProgress {
  current: number;
  total: number;
  currentFile: string;
  status: 'scanning' | 'organizing' | 'completed' | 'error' | 'idle';
  errorMessage?: string;
}

export interface Album {
  id: string;
  title: string;
  description?: string;
  coverPhotoId?: string;
  photoIds: string[];
  createdAt: string;
  updatedAt: string;
  eventDate?: string;
}

export interface IElectronAPI {
  selectDirectory: () => Promise<string | null>;
  scanDirectory: (dirPath: string) => Promise<Photo[]>;
  readExif: (filePath: string) => Promise<{ exif?: ExifMetadata; location?: LocationMetadata; dateTaken?: string }>;
  analyzeDryRun: (options: OrganizeOptions) => Promise<DryRunSummary>;
  executeOrganize: (options: OrganizeOptions) => Promise<{ success: boolean; movedCount: number; errors: string[] }>;
  onOrganizeProgress: (callback: (progress: OrganizeProgress) => void) => () => void;
  readFileAsBase64: (filePath: string) => Promise<string>;
  saveLibraryData: (key: string, data: any) => Promise<boolean>;
  loadLibraryData: (key: string) => Promise<any>;
  syncVirtualStorage: (config: VirtualStorageConfig) => Promise<SyncVirtualStorageResult>;
  scanVirtualMirror: (mirrorDirPath: string) => Promise<Photo[]>;
  discoverMirrors: (rootPath?: string) => Promise<VirtualStorageConfig[]>;
  openOriginalFile: (filePath: string) => Promise<boolean>;
  checkFileExists: (filePath: string) => Promise<boolean>;
  onMirrorProgress: (callback: (progress: MirrorProgress) => void) => () => void;

  // New capabilities
  startBackgroundScan: (sourcePath: string, mirrorRoot?: string, storageName?: string) => Promise<{ jobId: string }>;
  onBackgroundScanProgress: (callback: (progress: BackgroundScanProgress) => void) => () => void;
  readDirectoryTree: (dirPath: string) => Promise<FolderTreeNode[]>;
  readFolderPhotos: (folderPath: string) => Promise<Photo[]>;
  generateThumbnailOnTheFly: (sourceFilePath: string, mirrorDirPath?: string) => Promise<string | null>;
  editPhoto: (options: EditPhotoOptions) => Promise<EditPhotoResult>;
  trashFiles: (filePaths: string[]) => Promise<{ success: boolean; trashedCount: number; errors: string[] }>;
  deleteVirtualStorage: (params: { storageName: string; localMirrorRoot?: string; deleteDiskFiles: boolean }) => Promise<{ success: boolean; error?: string }>;

  // Background Daemon & Tray Service capabilities
  getBackgroundServiceStatus: () => Promise<BackgroundServiceStatus>;
  setBackgroundServiceSettings: (settings: Partial<BackgroundServiceSettings>) => Promise<boolean>;
  triggerBackgroundServiceSync: () => Promise<{ started: boolean }>;
  installSystemService: () => Promise<{ success: boolean; error?: string }>;
  uninstallSystemService: () => Promise<{ success: boolean; error?: string }>;
  getServiceLogs: () => Promise<string[]>;
  openHelpInBrowser: () => Promise<boolean>;
  createLibraryBackupZip: (customPath?: string) => Promise<{
    success: boolean;
    filePath?: string;
    fileSize?: number;
    totalPhotos?: number;
    totalPeople?: number;
    totalAlbums?: number;
    canceled?: boolean;
    error?: string;
  }>;
  openItemInFolder: (filePath: string) => Promise<boolean>;
  getWebServerStatus: () => Promise<WebServerStatus>;
  setWebServerSettings: (settings: { enabled: boolean; port: number }) => Promise<WebServerStatus>;
  prepareHeicHq?: (filePath: string, photoId: string) => Promise<string | null>;
  cleanupHeicHq?: (photoId: string) => Promise<boolean>;
  getBatchThumbnails: (params: {
    items: Array<{ path: string; originalPath?: string }>;
    size?: number;
  }) => Promise<{ thumbnails: Record<string, string> }>;
  sendAppReady?: () => void;
}

export interface WebServerStatus {
  enabled: boolean;
  isRunning: boolean;
  port: number;
  primaryIp: string;
  primaryUrl: string;
  allUrls: Array<{ name: string; url: string; ip: string }>;
  error?: string;
}

export interface BackgroundServiceStatus {
  isRunning: boolean;
  isPaused: boolean;
  runAtStartup: boolean;
  minimizeToTray: boolean;
  syncIntervalMinutes: number;
  lastSyncTime?: string;
  isScanningNow: boolean;
  activeScanStorage?: string;
  isSystemServiceInstalled?: boolean;
  systemServiceStatus?: 'running' | 'stopped' | 'not_installed';
  systemServicePid?: number;
  executionMode?: 'system_service' | 'app_thread';
}

export interface BackgroundServiceSettings {
  runAtStartup: boolean;
  minimizeToTray: boolean;
  isPaused: boolean;
  syncIntervalMinutes: number;
  systemServiceInstalled?: boolean;
}

declare global {
  interface Window {
    electronAPI?: IElectronAPI;
  }
}
