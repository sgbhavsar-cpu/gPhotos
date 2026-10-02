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
  // Path of the cached thumbnail file (set by the mirror/thumbnail pipeline).
  thumbnailPath?: string;
  // True for a video file scanned into the library (see docs/FEATURE_VIDEO_LIBRARY_SUPPORT.md).
  // Everything else about a Photo applies unchanged — albums, faces (skipped), favorites, location —
  // only the handful of places that actually decode pixels need to branch on this.
  isVideo?: boolean;
  // Probed once via ffmpeg at scan time (videoExportService.probeMedia) — undefined for a photo,
  // or a video whose duration couldn't be read.
  videoDurationSec?: number;
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
  newPhotos?: Photo[];
  storageName?: string;
  mirrorRoot?: string;
  percent?: number;
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
  // Non-fatal problems (e.g. a stale mirror file that could not be cleaned up). The photos were
  // mirrored fine, so `success` is not affected.
  warnings?: string[];
  // True when the run was stopped early because the source storage became unreachable mid-sync.
  // Nothing was pruned; the next pass starts fresh and re-verifies cheaply.
  sourceUnavailable?: boolean;
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
  // Cumulative count of photos (from the start of THIS run) that now have a
  // completed face scan, whether that was already true before this run or
  // just finished this pass — NOT the same as `current`, which is only the
  // loop's walk position through the full file list. A file the loop has
  // walked past is not necessarily one whose face scan is done; conflating
  // the two is what made "Recognizing Faces (2600/23887)" claim 2600 faces
  // were scanned when only a handful of those 2600 actually needed (or got)
  // real detection this pass.
  facesCompletedCount?: number;
}

export interface NetworkStorageProgress {
  storageName: string;
  phase: 'idle' | 'scanning' | 'thumbnails' | 'faces' | 'completed' | 'paused' | 'interrupted' | 'error';
  thumbnailCurrent: number;
  thumbnailTotal: number;
  // The verification loop's walk position through the file list — accurate
  // for thumbnails (every walked file has been checked/cached), but NOT a
  // count of photos with completed face scans. Kept for the progress
  // bar/percent; use facesCompletedCount (or the polled StorageDetails'
  // faceScannedCount) for anything claiming to show "how many faces are
  // actually done".
  faceCurrent: number;
  faceTotal: number;
  // AI Description progress — see the matching fields on StorageDetails. Optional: only known
  // wherever a StorageDetails poll result is the source; an in-progress live sync update (from the
  // MirrorProgress push stream, which never carries caption data) just doesn't set these.
  captionCurrent?: number;
  captionTotal?: number;
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

// Smart Flows' shared per-photo content cache / RAG index (see photoContentCache.ts)
export interface PhotoContentEntry {
  caption: string;
  tags: string[];
  embedding: number[] | null;
  verdicts: Record<string, { match: boolean; confidence: number }>;
  updatedAt: string;
}

// A named sub-section of an album ("Day 1 — Ceremony", "Day 2 — Reception"). `photoIds` is a
// subset of the parent Album's own `photoIds` (a photo belongs to at most one chapter at a time,
// like a folder); a photo in the album but in no chapter is shown in the album's default bucket.
export interface AlbumChapter {
  id: string;
  title: string;
  photoIds: string[];
  coverPhotoId?: string;
  createdAt: string;
  updatedAt: string;
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
  /** Undefined/empty means "no chapters" — the album behaves exactly as it did before chapters existed. */
  chapters?: AlbumChapter[];
  /** The chapter last added to, so a one-click "add to this album" can default to it instead of asking every time. */
  lastUsedChapterId?: string;
}

// ---- Moving photos to another folder (photoRelocation.ts in the main process) ----
export interface RelocationPhotoInput {
  id: string;
  filePath: string;
  fileName: string;
  originalRemotePath?: string;
  isVirtual?: boolean;
  storageName?: string;
}
export interface RelocationRoot {
  kind: 'storage' | 'library';
  label: string;
  /** The folder the user may pick inside (a storage's network source folder, or the library folder). */
  path: string;
}
export interface RelocationPlan {
  root: RelocationRoot | null;
  movableIds: string[];
  skipped: Array<{ id: string; fileName: string; reason: string }>;
}
export interface RelocationItemResult {
  oldId: string;
  status: 'moved' | 'skipped' | 'failed';
  reason?: string;
  newId?: string;
  newFilePath?: string;
  newOriginalRemotePath?: string;
  newFileName?: string;
}

// ---- Video export (videoExportService.ts in the main process): the "Create Video" wizard ----
export type VideoAspectRatio = '16:9' | '9:16' | '1:1' | '4:3';
export type VideoResolutionTier = '720p' | '1080p';
export type VideoQuality = 'draft' | 'good' | 'best';
export type VideoTransition = 'none' | 'fade' | 'wipeleft' | 'wiperight' | 'slideup' | 'slidedown' | 'circleopen' | 'dissolve';
export type VideoCollageStyle = 'grid' | 'sideBySide' | 'stacked' | 'featured';

export interface VideoSlideInput {
  kind: 'photo' | 'collage' | 'title' | 'card';
  /** Readable local file paths — 1 for 'photo', up to 4 for 'collage' (extra ones are ignored), unused for 'title'. */
  photoPaths?: string[];
  /** Layout for a 'collage' slide (default 'grid'). */
  collageStyle?: VideoCollageStyle;
  /** For 'card': the finished title / end-credits picture from the wizard's designer, as a data: URL. */
  imageDataUrl?: string;
  /** How long this slide stays up; overrides the request's seconds-per-slide (used for cards). */
  seconds?: number;
  title?: string;
  subtitle?: string;
}

/** Music under the video: a file (picked or downloaded), the part of it to use, and whether to repeat it. */
export interface VideoAudioInput {
  filePath: string;
  startSec: number;
  /** null = to the end of the file. */
  endSec: number | null;
  /** Repeat the clip until the video ends. */
  loop: boolean;
  fadeOutSec: number;
  /** 0..1.5 (default 1). */
  volume?: number;
}

export interface VideoExportRequest {
  slides: VideoSlideInput[];
  audio?: VideoAudioInput;
  aspectRatio: VideoAspectRatio;
  resolution: VideoResolutionTier;
  quality: VideoQuality;
  /** One transition for every cut, or one entry per cut (slides - 1) for the random / multiple-effects modes. */
  transition: VideoTransition | VideoTransition[];
  transitionDurationSec: number;
  secondsPerItem: number;
  outputPath: string;
}

/** A music file the wizard can use: picked from disk or downloaded from YouTube. */
export interface AudioFileInfo {
  filePath: string;
  name: string;
  durationSec: number | null;
}

export interface YtDlpStatusInfo {
  installed: boolean;
  source?: 'managed' | 'system';
  version?: string;
}

export interface VideoExportProgressEvent {
  stage: 'preparing' | 'encoding';
  done: number;
  total: number;
}

export interface VideoExportResponse {
  success: boolean;
  error?: string;
  skippedSlides: number;
  outputPath?: string;
  durationSec?: number;
}
export interface RelocationOutcome {
  results: RelocationItemResult[];
  root: RelocationRoot | null;
  error?: string;
}

// ---- Automatic "make it upright" (orientationService.ts in the main process) ----
export interface OrientationInput {
  id: string;
  filePath: string;
  fileName?: string;
  originalRemotePath?: string;
  isVirtual?: boolean;
}
export interface OrientationResult {
  id: string;
  status: 'upright' | 'rotate' | 'unknown' | 'failed';
  /** Degrees CLOCKWISE to apply to the photo as displayed so faces are upright. */
  rotation: 0 | 90 | 180 | 270;
  confidence: number;
  faces: number;
  reason?: string;
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
  readFileAsBase64?: (filePath: string) => Promise<string>;
  planPhotoRelocation?: (photos: RelocationPhotoInput[]) => Promise<RelocationPlan>;
  relocatePhotos?: (params: { photos: RelocationPhotoInput[]; targetDir: string }) => Promise<RelocationOutcome>;
  onPhotoRelocationProgress?: (callback: (progress: { done: number; total: number }) => void) => () => void;
  detectPhotoOrientation?: (photos: OrientationInput[]) => Promise<OrientationResult[]>;
  onOrientationProgress?: (callback: (progress: { done: number; total: number }) => void) => () => void;
  saveLibraryData: (key: string, data: any) => Promise<boolean>;
  loadLibraryData: (key: string, libraryDir?: string, options?: { includePhotos?: boolean; compactDescriptors?: boolean }) => Promise<any>;
  syncVirtualStorage: (config: VirtualStorageConfig) => Promise<SyncVirtualStorageResult>;
  scanVirtualMirror: (mirrorDirPath: string) => Promise<Photo[]>;
  discoverMirrors: (rootPath?: string) => Promise<VirtualStorageConfig[]>;
  getDefaultMirrorRoot?: () => Promise<string>;
  // Lists a directory's subfolders for an in-app "browse for a folder"
  // dialog — used on both Electron (native filesystem access) and the
  // mobile/LAN web client (no native folder picker exists in a browser).
  browseDirectory?: (targetPath?: string) => Promise<{
    path: string | null;
    parent: string | null;
    entries: Array<{ name: string; path: string }>;
    error?: string;
  }>;
  openOriginalFile: (filePath: string) => Promise<boolean>;
  checkFileExists: (filePath: string) => Promise<boolean>;
  onMirrorProgress: (callback: (progress: MirrorProgress) => void) => () => void;
  onPhotoRotationFailed: (callback: (info: { originalRemotePath: string; localFilePath?: string; rotationDegrees: number; reason: string }) => void) => () => void;

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
  writePhotoMetadata?: (
    filePath: string,
    update: { dateIso?: string; latitude?: number; longitude?: number },
    originalRemotePath?: string
  ) => Promise<{ success: boolean; wroteExif: boolean; wroteOriginal: boolean; isQueued: boolean; error?: string }>;
  processPendingMetadata?: () => Promise<{ processed: number; remaining: number; error?: string }>;
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
  switchLibrary: (targetPath: string) => Promise<{ meta: CatalogMeta; firstPage: Photo[]; albums: Album[] }>;
  // Re-walks an already-indexed local library's folder (see catalogService.rescanLocalLibrary) —
  // the local-library counterpart of a virtual/network mirror's "Rescan".
  rescanLibrary?: (targetPath: string) => Promise<{ meta: CatalogMeta; firstPage: Photo[]; albums: Album[] } | null>;
  getSpriteCoordinate?: (photoPath: string) => Promise<SpriteCoordinate | null>;
  getSpriteCoordinatesBatch?: (photoPaths: string[]) => Promise<Record<string, SpriteCoordinate | null>>;
  invalidateSpriteCoordinate?: (photoPath: string) => Promise<boolean>;
  getPersonAvatarSprites?: (items: Array<{ personId: string; cacheKey: string }>) => Promise<Record<string, AvatarSpriteCoord | null>>;
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
   pauseThumbnailPreCacheForActivity?: () => Promise<{ paused: boolean }>;
   resumeThumbnailPreCacheForActivity?: () => Promise<{ paused: boolean }>;
  getStorageCheckpoints?: () => Promise<Record<string, StorageSyncCheckpoint>>;
  getLibraryStatus?: (libraryPath: string) => Promise<LibraryScanStatus | null>;
  saveLibraryStatus?: (status: Partial<LibraryScanStatus> & { libraryPath: string }) => Promise<LibraryScanStatus>;
  getAllLibraryStatuses?: () => Promise<Record<string, LibraryScanStatus>>;
  refreshThumbnailsFromSource?: (
    items: Array<{ filePath: string; originalRemotePath?: string }>
  ) => Promise<{ refreshedCount: number; errors: string[] }>;
  getStorageDetails?: (storageName: string, mirrorRoot?: string) => Promise<StorageDetails | null>;
  getAllStorageDetails?: (mirrorRoot?: string) => Promise<Record<string, StorageDetails>>;
  getAllStorageDetailsFast?: (mirrorRoot?: string) => Promise<Record<string, StorageDetails>>;
  confirmAllStorageDetailsPhysical?: (mirrorRoot?: string) => Promise<Record<string, StorageDetails>>;

  // Person profile-photo local cache (independent of network storage reachability)
  getPersonAvatarPath?: (personId: string, cacheKey: string) => Promise<string | null>;
  savePersonAvatar?: (personId: string, cacheKey: string, dataUrl: string) => Promise<{ success: boolean; filePath?: string; error?: string }>;
  deletePersonAvatar?: (personId: string) => Promise<boolean>;

  // Video library items (see docs/FEATURE_VIDEO_LIBRARY_SUPPORT.md) — on-demand hover-preview clip.
  getVideoPreview?: (filePath: string, originalRemotePath?: string) => Promise<{ path?: string; error?: string }>;

  // Smart Flows' shared per-photo content cache / RAG index (see photoContentCache.ts)
  getPhotoContentEntry?: (photoId: string) => Promise<PhotoContentEntry | null>;
  getAllPhotoContentEntries?: () => Promise<Record<string, PhotoContentEntry>>;
  upsertPhotoContentEntry?: (photoId: string, entry: PhotoContentEntry) => Promise<boolean>;

  // Video export wizard (videoExportService.ts, main process)
  chooseVideoOutputPath?: (suggestedName: string) => Promise<string | null>;
  exportVideo?: (request: VideoExportRequest) => Promise<VideoExportResponse>;
  cancelVideoExport?: () => Promise<boolean>;
  openVideoFile?: (filePath: string) => Promise<boolean>;

  // Video wizard music: local file, short preview clip, and YouTube audio via yt-dlp (ytDlpService.ts)
  chooseAudioFile?: () => Promise<AudioFileInfo | null>;
  getAudioPreview?: (filePath: string, startSec: number, endSec: number | null) => Promise<string | null>;
  getYtDlpStatus?: () => Promise<YtDlpStatusInfo>;
  installYtDlp?: () => Promise<{ ok: boolean; error?: string; version?: string }>;
  downloadYouTubeAudio?: (url: string) => Promise<{ ok: boolean; error?: string; file?: AudioFileInfo }>;
  cancelYouTubeDownload?: () => Promise<boolean>;
  /** Follows a shortened Google Maps link (maps.app.goo.gl, goo.gl/maps/…) to its real, coordinate-bearing URL. */
  resolveMapsUrl?: (url: string) => Promise<{ ok: boolean; resolvedUrl?: string; error?: string }>;
  // Built-in royalty-free tracks (musicCatalog.ts): which are already downloaded, and download-if-needed by id
  getMusicLibraryCached?: () => Promise<string[]>;
  fetchMusicTrack?: (trackId: string) => Promise<{ ok: boolean; error?: string; file?: AudioFileInfo }>;
  onAudioFetchProgress?: (callback: (p: { kind: 'install' | 'download'; pct: number }) => void) => () => void;

  // Local Ollama, called from the main process (a file:// renderer's "Origin: null" gets a 403 from Ollama)
  ollamaRequest?: (req: { baseUrl: string; path: string; method?: 'GET' | 'POST'; body?: unknown; timeoutMs?: number }) => Promise<{ ok: boolean; status: number; data?: any; error?: string }>;
  ollamaPull?: (baseUrl: string, model: string) => Promise<{ result: 'success' | 'failed' | 'cancelled'; error?: string }>;
  ollamaCancelPull?: (model: string) => Promise<boolean>;
  onOllamaPullProgress?: (callback: (p: { model: string; status: string; completed?: number; total?: number }) => void) => () => void;
  onVideoExportProgress?: (callback: (p: VideoExportProgressEvent) => void) => () => void;

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
  // AI Description progress (docs/FEATURE_AI_AUTO_TAGGING.md) — how many of this storage's
  // (non-video) photos have an AI caption/tag recorded, from the background auto-tagging pass or
  // any Smart Flow run. Purely informational: unlike thumbnails/faces, this never affects `phase`/
  // `percent`/`canResume` below, since auto-tagging is an opt-in, off-by-default feature — a
  // storage with it still off would otherwise permanently look "incomplete".
  captionedCount: number;
  captionTotalCount: number;
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

/** One person's cover avatar inside a baked WebP sprite sheet (10 columns of `tile`px tiles, `rows` rows). */
export interface AvatarSpriteCoord {
  spriteId: string;
  col: number;
  row: number;
  rows: number;
  tile: number;
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
  performanceMode?: 'background' | 'turbo';
  turboWorkers?: number;
  turboMaxCpuPercent?: number;
  turboMaxRamMb?: number;
  idleResumeSeconds?: number;
  logicalCpuCount?: number; // read-only, informational — for sizing the Parallel Workers slider in the UI
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
  maxCpuPercent?: number; // Background mode: cap background CPU usage (default: 40%)
  maxRamMb?: number; // Background mode: cap background RAM usage in MB (default: 1024 MB / 1 GB)
  enableThumbnailPreCache?: boolean; // Pre-cache thumbnails in background (default: true)
  performanceMode?: 'background' | 'turbo'; // 'background': throttled, low-priority (default). 'turbo': overnight/exclusive-use, uses turboWorkers/turboMaxCpuPercent/turboMaxRamMb below instead of the maxCpuPercent/maxRamMb sliders.
  turboWorkers?: number; // Turbo mode: photos processed in parallel (default: cpu cores - 1)
  turboMaxCpuPercent?: number; // Turbo mode: CPU cap (default: 100%)
  turboMaxRamMb?: number; // Turbo mode: RAM ceiling in MB (default: 4096 MB / 4 GB)
  idleResumeSeconds?: number; // Seconds of no mousedown/keydown/wheel/touchstart/scroll before auto-resuming background caching/face detection (default: 15)
}

declare global {
  interface Window {
    electronAPI?: IElectronAPI;
  }
}
