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
  descriptor: number[]; // 512-dimensional ArcFace embedding vector (see faceDetectionEngine.ts)
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
  // True once every face currently on this photo is confirmed (including
  // the trivial zero-faces case) — set automatically as faces get confirmed,
  // or explicitly via a bulk curation action (e.g. "Remove Unknown Faces").
  // Blocks automatic/bulk face (re-)detection from touching this photo until
  // the user explicitly re-runs "Scan Faces" on it (which clears the lock).
  facesLocked?: boolean;
  sharpnessScore?: number;
  rotation?: number;
  isHeicRotated?: boolean;
  heicRotation?: number;
  // Source file's filesystem modified-time (ms since epoch) as of the last
  // time this photo's bytes were actually read for thumbnail/face
  // processing. Compared against the source file's current mtime (and
  // fileSize) on each rescan so an unchanged file can skip re-reading
  // entirely instead of being re-hydrated/re-detected every pass.
  originalMtimeMs?: number;
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

export type InventoryStatus = 'not_started' | 'scanning' | 'completed' | 'failed';

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

  // Inventory gate (see docs/PIPELINE_REDESIGN_DEV_DOC.md §3.2): until
  // inventoryStatus is 'completed', no thumbnail/face processing runs for
  // this storage. Once completed, inventoryTotalFiles is the single fixed
  // count every UI surface (sidebar, Virtual Storage view) displays — no
  // more independently-computed, possibly-disagreeing counts.
  inventoryStatus?: InventoryStatus;
  inventoryTotalFiles?: number;
  inventoryCompletedAt?: string;
  inventoryError?: string;
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
  // Source file's filesystem mtime (ms since epoch) captured at the same
  // time originalFileSize was read, so a later sync can detect "unchanged"
  // without any extra stat/read beyond the one already done for the
  // thumbnail incremental-skip check.
  sourceMtimeMs?: number;
  dateTaken: string;
  width?: number;
  height?: number;
  thumbnailPath: string;
  storageName: string;
  storageRoot: string;
  relativePath: string;
  exif?: ExifMetadata;
  location?: LocationMetadata;
  faces?: DetectedFace[];
  faceScanCompleted?: boolean;
  rotation?: number;
  isHeicRotated?: boolean;
  heicRotation?: number;
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
  phase: 'idle' | 'scanning' | 'thumbnails' | 'faces' | 'completed' | 'paused' | 'interrupted' | 'error';
  thumbnailCurrent: number;
  thumbnailTotal: number;
  faceCurrent: number;
  faceTotal: number;
  percent: number;
  message?: string;
  currentFile?: string;
  error?: string;
  lastProcessedIndex?: number;
  canResume?: boolean;
}

export interface StorageSyncCheckpoint {
  storageName: string;
  networkSourcePath: string;
  localMirrorRoot: string;
  phase: 'scanning' | 'thumbnails' | 'completed' | 'paused' | 'interrupted' | 'error';
  processedCount: number;
  totalDiscovered: number;
  lastProcessedIndex: number;
  lastProcessedFile?: string;
  percent: number;
  timestamp: number;
  updatedAt: string;
}

export interface ThumbnailWorkerCheckpoint {
  processedCount: number;
  totalQueuedCount: number;
  currentFileName?: string;
  lastSavedTime: number;
  isFinished: boolean;
  libraryPath?: string;
}

export interface LibraryScanStatus {
  libraryPath: string;
  libraryName: string;
  totalPhotos: number;
  thumbnailCachedCount: number;
  thumbnailTotalCount: number;
  thumbnailLastIndex: number;
  thumbnailLastFile?: string;
  thumbnailCompleted: boolean;
  thumbnailPercent: number;
  faceScannedCount: number;
  faceTotalCount: number;
  faceDetectedCount: number;
  faceLastIndex: number;
  faceLastFile?: string;
  faceCompleted: boolean;
  facePercent: number;
  phase: 'idle' | 'thumbnails' | 'faces' | 'completed' | 'paused' | 'interrupted' | 'error';
  message?: string;
  lastUpdated: string;
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
  // Set by browserShim.ts when running over HTTP (mobile/LAN browser)
  // instead of via real Electron IPC — some capabilities (a native folder
  // picker chief among them) have no browser equivalent, so callers use
  // this flag to fall back to something that works instead of silently
  // no-oping on a call the shim can't actually fulfil.
  isBrowserShim?: boolean;
  isElectron?: boolean;
  selectDirectory: () => Promise<string | null>;
  scanDirectory: (dirPath: string) => Promise<Photo[]>;
  readExif: (filePath: string) => Promise<{ exif?: ExifMetadata; location?: LocationMetadata; dateTaken?: string }>;
  analyzeDryRun: (options: OrganizeOptions) => Promise<DryRunSummary>;
  executeOrganize: (options: OrganizeOptions) => Promise<{ success: boolean; movedCount: number; errors: string[] }>;
  onOrganizeProgress: (callback: (progress: OrganizeProgress) => void) => () => void;
  readFileAsBase64: (filePath: string) => Promise<string>;
  saveLibraryData: (key: string, data: any) => Promise<boolean>;
  loadLibraryData: (key: string, libraryDir?: string) => Promise<any>;
  syncVirtualStorage: (config: VirtualStorageConfig) => Promise<SyncVirtualStorageResult>;
  scanVirtualMirror: (mirrorDirPath: string) => Promise<Photo[]>;
  discoverMirrors: (rootPath?: string) => Promise<VirtualStorageConfig[]>;
  getDefaultMirrorRoot?: () => Promise<string>;
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
  trashFiles: (filePaths: string[]) => Promise<{ success: boolean; trashedCount: number; trashedPaths: string[]; errors: string[] }>;
  deleteFilesPermanently: (filePaths: string[]) => Promise<{ success: boolean; deletedCount: number; deletedPaths: string[]; errors: string[] }>;
  rotatePhoto: (filePath: string, rotationDegrees: number, originalRemotePath?: string) => Promise<{ success: boolean; isQueued?: boolean; newPath?: string; message?: string; error?: string; isHeic?: boolean; isHeicRotated?: boolean; heicRotation?: number; rotation?: number }>;
  processPendingRotations?: () => Promise<{ processed: number; remaining: number; error?: string }>;
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
  getWebServerPin?: () => Promise<{ pin: string; error?: string }>;
  regenerateWebServerPin?: () => Promise<{ pin: string; error?: string }>;
  listPairedDevices?: () => Promise<PairedDeviceInfo[]>;
  revokePairedDevice?: (deviceId: string) => Promise<{ success: boolean; error?: string }>;
  revokeAllPairedDevices?: () => Promise<{ success: boolean; error?: string }>;
  prepareHeicHq?: (filePath: string, photoId: string) => Promise<string | null>;
  cleanupHeicHq?: (photoId: string) => Promise<boolean>;
  getBatchThumbnails: (params: {
    items: Array<{ path: string; originalPath?: string }>;
    size?: number;
  }) => Promise<{ thumbnails: Record<string, string> }>;
  sendAppReady?: () => void;
  getCatalogMeta: (libraryDir?: string) => Promise<CatalogMeta>;
  getCatalogPage: (params: { pageIndex: number; pageSize?: number; libraryDir?: string }) => Promise<{ photos: Photo[]; totalPages: number; totalPhotos: number }>;
  switchLibrary: (targetPath: string) => Promise<{ meta: CatalogMeta; firstPage: Photo[] }>;
  getSpriteCoordinate?: (photoPath: string) => Promise<SpriteCoordinate | null>;
  getSpriteCoordinatesBatch?: (photoPaths: string[]) => Promise<Record<string, SpriteCoordinate | null>>;
  getThumbnailPreCacheStatus?: () => Promise<{
    isRunning: boolean;
    current: number;
    total: number;
    cpuPercent: number;
    ramMb: number;
    paused: boolean;
    currentFile?: string;
  }>;
  startThumbnailPreCache?: (photos?: Photo[]) => Promise<{ started: boolean }>;
   pauseThumbnailPreCache?: () => Promise<{ paused: boolean }>;
  getStorageCheckpoints?: () => Promise<Record<string, StorageSyncCheckpoint>>;
  getLibraryStatus?: (libraryPath: string) => Promise<LibraryScanStatus | null>;
  saveLibraryStatus?: (status: Partial<LibraryScanStatus> & { libraryPath: string }) => Promise<LibraryScanStatus>;
  getAllLibraryStatuses?: () => Promise<Record<string, LibraryScanStatus>>;
  refreshThumbnailsFromSource?: (
    items: Array<{ filePath: string; originalRemotePath?: string }>
  ) => Promise<{ refreshedCount: number; errors: string[] }>;
  getStorageDetails?: (storageName: string, mirrorRoot?: string) => Promise<StorageDetails | null>;
  getAllStorageDetails?: (mirrorRoot?: string) => Promise<Record<string, StorageDetails>>;

  // Person profile-photo local cache (independent of network storage reachability)
  getPersonAvatarPath?: (personId: string, cacheKey: string) => Promise<string | null>;
  savePersonAvatar?: (personId: string, cacheKey: string, dataUrl: string) => Promise<{ success: boolean; filePath?: string; error?: string }>;
  deletePersonAvatar?: (personId: string) => Promise<boolean>;

  // OneDrive Files On-Demand space reclaim
  getOneDriveStatus?: () => Promise<{ detectedRoots: string[]; reclaimEnabled: boolean; supported: boolean }>;
  setOneDriveReclaimEnabled?: (enabled: boolean) => Promise<boolean>;
  markOneDriveReclaimable?: (filePaths: string[]) => Promise<{ markedCount: number }>;
  runOneDriveHealthCheck?: () => Promise<{ checked: number; stillHydrated: number }>;
  getOneDriveReclaimHealth?: () => Promise<{ broken: boolean; pendingCount: number; recentFailureRate: number; checkedCount: number }>;
  resetOneDriveReclaimHealth?: () => Promise<boolean>;

  // Unified per-photo sync (thumbnail+sidecar) — interleaved with face
  // detection in the renderer so each photo fully completes (including an
  // OneDrive unpin request) before the next one's original is hydrated.
  syncOnePhoto?: (config: VirtualStorageConfig, remoteFile: string) => Promise<{
    success: boolean;
    skipped: boolean;
    bytesRead: number;
    originalSize: number;
    thumbnailSize: number;
    localThumbPath?: string;
    localMetaPath?: string;
    sidecar?: any;
    error?: string;
  }>;
  listSourceFiles?: (sourcePath: string) => Promise<string[]>;

  // Logging (see docs/PIPELINE_REDESIGN_DEV_DOC.md §3.8) — routes renderer
  // log calls into the same rotated log file the main process writes to.
  logFromRenderer?: (level: 'debug' | 'info' | 'warn' | 'error', scope: string, message: string, meta?: Record<string, unknown>) => void;
  getLogLevelOverride?: () => Promise<boolean>;
  setLogLevelOverride?: (overrideDebug: boolean) => Promise<boolean>;

  // Inventory gate (see docs/PIPELINE_REDESIGN_DEV_DOC.md §3.2)
  scanStorageInventory?: (networkSourcePath: string) => Promise<{
    status: 'completed' | 'failed';
    totalFiles: number;
    completedAt?: string;
    error?: string;
  }>;
  getPhotosByStorageName?: (storageName: string, mirrorRoot?: string) => Promise<Photo[]>;

  // Main-process face detection (see src/main/services/faceDetectionEngine.ts
  // + pipelineOrchestrator.ts) — replaces the old renderer-side face-api.js
  // engine for every photo, local or network.
  detectFacesBatch?: (photos: Photo[]) => Promise<{
    results: Array<{ photoId: string; ran: boolean; faceCount: number; locked: boolean; skippedReason?: string; faces: DetectedFace[] }>;
    people: Person[];
  }>;
  detectFacesForced?: (photo: Photo) => Promise<{
    ran: boolean; faceCount: number; locked: boolean; skippedReason?: string; faces: DetectedFace[]; people: Person[];
  }>;
  computeDescriptorForRegion?: (
    sourceFilePath: string,
    box: { x: number; y: number; width: number; height: number }
  ) => Promise<{ descriptor: number[]; confidence: number } | null>;
}

export interface StorageDetails {
  storageName: string;
  totalPhotos: number;
  thumbnailCachedCount: number;
  thumbnailTotalCount: number;
  faceScannedCount: number;
  faceTotalCount: number;
  facesDetectedCount: number;
  phase: 'completed' | 'thumbnails' | 'faces' | 'interrupted' | 'idle';
  percent: number;
  canResume?: boolean;
}

export interface TimelineMonthSummary {
  year: number;
  month: number;
  label: string;
  count: number;
  firstPhotoIndex: number;
}

export interface PlaceSummaryItem {
  id: string;
  name: string;
  city?: string;
  country?: string;
  latitude: number;
  longitude: number;
  photoCount: number;
  coverPhotoId?: string;
  coverFilePath?: string;
}

export interface CatalogMeta {
  version: number;
  totalPhotos: number;
  totalAlbums: number;
  totalPeople: number;
  totalPlaces: number;
  earliestDate?: string;
  latestDate?: string;
  timelineSummary: TimelineMonthSummary[];
  placesSummary: PlaceSummaryItem[];
  albumsSummary: Array<{ id: string; title: string; count: number; coverPhotoId?: string }>;
  peopleSummary: Array<{ id: string; name: string; count: number }>;
  recentLibraries: string[];
  currentDirectory: string | null;
  selectedFolder: string | null;
  pageSize: number;
  totalPages: number;
  lastUpdated: string;
}

export interface SpriteCoordinate {
  spriteId: string;
  url: string;
  col: number;
  row: number;
  x: number;
  y: number;
  width: number;
  height: number;
  sheetWidth: number;
  sheetHeight: number;
}

export interface PairedDeviceInfo {
  id: string;
  label: string;
  createdAt: string;
  lastSeenAt: string;
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
  maxCpuPercent?: number;
  maxRamMb?: number;
  enableThumbnailPreCache?: boolean;
  currentCpuPercent?: number;
  currentRamMb?: number;
  thumbnailsPreCachedCount?: number;
  thumbnailsPreCachedTotal?: number;
  isPreCachingActive?: boolean;
  currentPreCacheFile?: string;
}

export interface BackgroundServiceSettings {
  runAtStartup: boolean;
  minimizeToTray: boolean;
  isPaused: boolean;
  syncIntervalMinutes: number;
  systemServiceInstalled?: boolean;
  maxCpuPercent?: number; // Cap background CPU usage (default: 40%)
  maxRamMb?: number; // Cap background RAM usage in MB (default: 1024 MB / 1 GB)
  enableThumbnailPreCache?: boolean; // Pre-cache thumbnails in background (default: true)
}

declare global {
  interface Window {
    electronAPI?: IElectronAPI;
  }
}
