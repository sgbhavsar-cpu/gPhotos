import React, { useState, useEffect, useRef } from 'react';
import {
  HardDrive,
  FolderOpen,
  RefreshCw,
  Sparkles,
  CheckCircle2,
  AlertCircle,
  Layers,
  ArrowRight,
  Database,
  ExternalLink,
  Zap,
  Trash2,
  FolderTree,
  Activity,
  Cpu,
  Clock,
  Settings2,
  Check,
  Play,
  Pause,
  Radio,
  Users,
  Image,
  X,
} from 'lucide-react';
import { VirtualStorageConfig, MirrorProgress, BackgroundServiceStatus, NetworkStorageProgress, StorageDetails } from '../../types';
import { DeleteStorageModal } from '../components/DeleteStorageModal';
import { libraryStore } from '../services/libraryStore';
import { splitStoragesByExistence } from '../services/storageValidation';
import { useIsMobile } from '../hooks/useIsMobile';

interface VirtualStorageViewProps {
  onLoadMirroredPhotos: (mirrorRootPath: string) => void;
  onStoragesUpdated?: (storages: VirtualStorageConfig[]) => void;
  onBrowseFolderTree?: (folderPath: string) => void;
  storageProgressMap?: Record<string, NetworkStorageProgress>;
}

const STORAGE_CONFIGS_KEY = 'gphotos_virtual_storages_v1';
const UNLINKED_STORAGES_KEY = 'gphotos_unlinked_storages_v1';

export const VirtualStorageView: React.FC<VirtualStorageViewProps> = ({
  onLoadMirroredPhotos,
  onStoragesUpdated,
  onBrowseFolderTree,
  storageProgressMap = {},
}) => {
  const isMobile = useIsMobile();
  const [storages, setStorages] = useState<VirtualStorageConfig[]>([]);
  const [isLoadingStorages, setIsLoadingStorages] = useState(true);
  const storagesRef = useRef<VirtualStorageConfig[]>([]);
  storagesRef.current = storages;

  const [storageDetailsMap, setStorageDetailsMap] = useState<Record<string, StorageDetails>>({});
  // Cards would otherwise briefly render with 0/empty stats before the first
  // getAllStorageDetails() round-trip (a live disk + SQLite read per storage)
  // resolves, which reads as the screen being stuck rather than loading.
  const [isLoadingStorageDetails, setIsLoadingStorageDetails] = useState(true);
  const [prunedStoragesNotice, setPrunedStoragesNotice] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [networkSourcePath, setNetworkSourcePath] = useState('');
  const [localMirrorRoot, setLocalMirrorRoot] = useState('C:\\GPhotos_VirtualMirrors');
  const [delaySec, setDelaySec] = useState<number>(0.5);
  const [bandwidthLimit, setBandwidthLimit] = useState<number>(0);
  const [isSyncing, setIsSyncing] = useState(false);
  const [activeSyncStorageId, setActiveSyncStorageId] = useState<string | null>(null);
  const [progress, setProgress] = useState<MirrorProgress | null>(null);
  const [syncSummary, setSyncSummary] = useState<{
    storageName: string;
    totalSynced: number;
    newlyAdded: number;
    totalSizeSaved: number;
    localPath: string;
  } | null>(null);

  const [storageToDelete, setStorageToDelete] = useState<VirtualStorageConfig | null>(null);
  const [serviceStatus, setServiceStatus] = useState<BackgroundServiceStatus | null>(null);
  const [isUpdatingService, setIsUpdatingService] = useState(false);
  const [isPreCachingActionBusy, setIsPreCachingActionBusy] = useState(false);

  const saveStorages = async (updater: VirtualStorageConfig[] | ((prev: VirtualStorageConfig[]) => VirtualStorageConfig[])) => {
    const updated = typeof updater === 'function' ? updater(storagesRef.current) : updater;
    storagesRef.current = updated;
    setStorages(updated);
    if (onStoragesUpdated) onStoragesUpdated(updated);
    if (window.electronAPI) {
      await window.electronAPI.saveLibraryData(STORAGE_CONFIGS_KEY, updated);
    } else if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_CONFIGS_KEY, JSON.stringify(updated));
    }
    return updated;
  };

  /**
   * Inventory gate (see docs/PIPELINE_REDESIGN_DEV_DOC.md §3.2): counts every
   * eligible file under the storage's source folder (incl. subfolders) and
   * persists the fixed total before any thumbnail/face processing is allowed
   * to start. Returns the updated config so callers can check the result
   * (and its inventoryTotalFiles) without racing a separate re-read.
   */
  const ensureInventoryCompleted = async (config: VirtualStorageConfig): Promise<VirtualStorageConfig> => {
    if (config.inventoryStatus === 'completed' || !window.electronAPI?.scanStorageInventory) {
      return config;
    }

    await saveStorages((prev) =>
      prev.map((s) => (s.id === config.id ? { ...s, inventoryStatus: 'scanning' } : s))
    );

    const result = await window.electronAPI.scanStorageInventory(config.networkSourcePath);

    const updatedConfig: VirtualStorageConfig = {
      ...config,
      inventoryStatus: result.status,
      inventoryTotalFiles: result.totalFiles,
      inventoryCompletedAt: result.completedAt,
      inventoryError: result.error,
    };
    await saveStorages((prev) => prev.map((s) => (s.id === config.id ? updatedConfig : s)));
    return updatedConfig;
  };

  // The mirror folder is the source of truth for whether a storage still
  // "exists" — the settings entry is just a config record that has to live
  // somewhere before the first sync ever creates that folder. Whenever a
  // configured storage's folder is gone, drop it from the list (and
  // blacklist it so auto-discovery can't resurrect it) rather than letting
  // a stale settings entry outlive the folder it describes.
  const pruneMissingStorageFolders = async (list: VirtualStorageConfig[]): Promise<VirtualStorageConfig[]> => {
    if (!window.electronAPI?.checkFileExists || list.length === 0) return list;
    const { valid: stillValid, removed: missing } = await splitStoragesByExistence(list, window.electronAPI.checkFileExists);
    if (missing.length === 0) return list;

    if (window.electronAPI) {
      const unlinked: string[] = (await window.electronAPI.loadLibraryData(UNLINKED_STORAGES_KEY)) || [];
      const missingNames = missing.map((s) => s.name.toLowerCase());
      const nextUnlinked = Array.from(new Set([...unlinked, ...missingNames]));
      await window.electronAPI.saveLibraryData(UNLINKED_STORAGES_KEY, nextUnlinked);
    }
    // Also clears "Active Library" in the sidebar and any of this storage's
    // photos still held in memory, if either currently points at it — those
    // are a separate persisted record (selectedFolder / gphotos_library_v1)
    // from the storages list above, and were left stale otherwise.
    for (const s of missing) {
      libraryStore.removePhotosByStorage(s.name);
    }
    const names = missing.map((s) => s.name).join(', ');
    setPrunedStoragesNotice(
      `Removed ${missing.length === 1 ? 'storage' : `${missing.length} storages`} whose local mirror folder no longer exists: ${names}. Its network source and photos are unaffected — re-add it to sync again.`
    );
    return stillValid;
  };

  // Load configured storages & auto-discover on-disk mirrors
  useEffect(() => {
    let isMounted = true;
    const load = async () => {
      setIsLoadingStorages(true);
      try {
        let unlinked: string[] = [];
        if (window.electronAPI) {
          unlinked = (await window.electronAPI.loadLibraryData(UNLINKED_STORAGES_KEY)) || [];
        } else if (typeof localStorage !== 'undefined') {
          const raw = localStorage.getItem(UNLINKED_STORAGES_KEY);
          if (raw) unlinked = JSON.parse(raw);
        }
        const unlinkedSet = new Set(unlinked.map((n) => n.toLowerCase()));

        let saved: VirtualStorageConfig[] | null = null;
        if (window.electronAPI) {
          saved = await window.electronAPI.loadLibraryData(STORAGE_CONFIGS_KEY);
        }
        if (!saved && typeof localStorage !== 'undefined') {
          const raw = localStorage.getItem(STORAGE_CONFIGS_KEY);
          if (raw) saved = JSON.parse(raw);
        }
        let combined: VirtualStorageConfig[] = saved
          ? [...saved].filter((s) => !unlinkedSet.has(s.name.toLowerCase()))
          : [];

        // Auto-discover mirrors on disk (e.g. C:\GPhotos_VirtualMirrors or existing localMirrorRoot)
        if (window.electronAPI?.discoverMirrors) {
          try {
            const discovered = await window.electronAPI.discoverMirrors(localMirrorRoot);
            if (discovered && discovered.length > 0) {
              for (const disc of discovered) {
                if (unlinkedSet.has(disc.name.toLowerCase())) continue; // Skip unlinked/deleted mirrors!

                const existingIdx = combined.findIndex(
                  (s) => s.name.toLowerCase() === disc.name.toLowerCase() || s.id === disc.id
                );
                if (existingIdx === -1) {
                  combined.push(disc);
                } else {
                  combined[existingIdx] = {
                    ...combined[existingIdx],
                    totalItems: disc.totalItems || combined[existingIdx].totalItems,
                    totalSizeSaved: disc.totalSizeSaved || combined[existingIdx].totalSizeSaved,
                    lastSynced: combined[existingIdx].lastSynced || disc.lastSynced,
                  };
                }
              }
            }
          } catch (discErr) {
            console.warn('Failed to auto-discover mirrors:', discErr);
          }
        }

        // Prune entries whose local mirror folder no longer exists on disk —
        // e.g. deleted manually outside the app rather than via "Delete
        // Storage" here.
        combined = await pruneMissingStorageFolders(combined);

        if (isMounted) {
          storagesRef.current = combined;
          setStorages(combined);
          if (onStoragesUpdated) onStoragesUpdated(combined);
        }
        if (window.electronAPI) {
          await window.electronAPI.saveLibraryData(STORAGE_CONFIGS_KEY, combined);
          if (window.electronAPI.getBackgroundServiceStatus) {
            const status = await window.electronAPI.getBackgroundServiceStatus();
            if (isMounted) setServiceStatus(status);
          }
        }
      } catch (err) {
        console.error('Failed to load virtual storages:', err);
      } finally {
        if (isMounted) {
          setIsLoadingStorages(false);
        }
      }
    };
    load();
    return () => {
      isMounted = false;
    };
  }, []);

  // Listen to mirror sync progress
  useEffect(() => {
    if (!window.electronAPI?.onMirrorProgress) return;
    const unsub = window.electronAPI.onMirrorProgress((p) => {
      setProgress(p);
      if (p.status === 'completed' || p.status === 'error') {
        setIsSyncing(false);
      }
    });
    return () => unsub();
  }, []);

  // Periodic polling of background service, thumbnail caching, and per-storage details
  useEffect(() => {
    const fetchStatus = async () => {
      try {
        if (window.electronAPI?.getBackgroundServiceStatus) {
          const status = await window.electronAPI.getBackgroundServiceStatus();
          setServiceStatus(status);
        }
      } catch {}
    };

    const fetchStorageDetails = async () => {
      try {
        if (window.electronAPI?.getAllStorageDetails) {
          const details = await window.electronAPI.getAllStorageDetails();
          setStorageDetailsMap(details || {});
        }
      } catch {
      } finally {
        setIsLoadingStorageDetails(false);
      }
    };

    // Catches a mirror folder deleted (or a drive unplugged) while this
    // screen is open, live — not just on next app launch — since the folder
    // is the source of truth for whether the storage still exists at all.
    const checkForRemovedStorages = async () => {
      if (storagesRef.current.length === 0 || isSyncing) return;
      const pruned = await pruneMissingStorageFolders(storagesRef.current);
      if (pruned.length !== storagesRef.current.length) {
        storagesRef.current = pruned;
        setStorages(pruned);
        if (onStoragesUpdated) onStoragesUpdated(pruned);
        if (window.electronAPI) {
          await window.electronAPI.saveLibraryData(STORAGE_CONFIGS_KEY, pruned);
        }
      }
    };

    // The background sync daemon updates totalItems/lastSynced/
    // totalSizeSaved in the persisted setting continuously while it runs,
    // independent of this screen — without re-reading it, "Mirrored: X
    // photos" stays frozen at whatever it was when this screen last loaded
    // the list, even while a sync is visibly progressing (the % bars above
    // it are fine since those come from the always-live getAllStorageDetails
    // call, just not this specific line).
    const refreshStorageTotals = async () => {
      if (!window.electronAPI?.loadLibraryData || storagesRef.current.length === 0 || isSyncing) return;
      try {
        const saved: VirtualStorageConfig[] | null = await window.electronAPI.loadLibraryData(STORAGE_CONFIGS_KEY);
        if (!saved || saved.length === 0) return;
        const byName = new Map(saved.map((s) => [s.name.toLowerCase(), s]));
        let changed = false;
        const merged = storagesRef.current.map((s) => {
          const fresh = byName.get(s.name.toLowerCase());
          if (
            fresh &&
            (fresh.totalItems !== s.totalItems ||
              fresh.lastSynced !== s.lastSynced ||
              fresh.totalSizeSaved !== s.totalSizeSaved)
          ) {
            changed = true;
            return { ...s, totalItems: fresh.totalItems, lastSynced: fresh.lastSynced, totalSizeSaved: fresh.totalSizeSaved };
          }
          return s;
        });
        if (changed) {
          storagesRef.current = merged;
          setStorages(merged);
          if (onStoragesUpdated) onStoragesUpdated(merged);
        }
      } catch {}
    };

    fetchStatus();
    fetchStorageDetails();
    const intervalId = setInterval(() => {
      fetchStatus();
      fetchStorageDetails();
      checkForRemovedStorages();
      refreshStorageTotals();
    }, 2000);
    return () => clearInterval(intervalId);
  }, [storages]);

  const handleTogglePreCachePause = async () => {
    setIsPreCachingActionBusy(true);
    try {
      if (serviceStatus?.isPreCachingActive) {
        if (window.electronAPI?.pauseThumbnailPreCache) {
          await window.electronAPI.pauseThumbnailPreCache();
        }
      } else {
        if (window.electronAPI?.startThumbnailPreCache) {
          await window.electronAPI.startThumbnailPreCache();
        }
      }
      if (window.electronAPI?.getBackgroundServiceStatus) {
        const updated = await window.electronAPI.getBackgroundServiceStatus();
        setServiceStatus(updated);
      }
    } finally {
      setIsPreCachingActionBusy(false);
    }
  };

  const handleCacheAllNetworkPhotos = async () => {
    setIsPreCachingActionBusy(true);
    try {
      if (window.electronAPI?.startThumbnailPreCache) {
        await window.electronAPI.startThumbnailPreCache();
      }
      if (window.electronAPI?.getBackgroundServiceStatus) {
        const updated = await window.electronAPI.getBackgroundServiceStatus();
        setServiceStatus(updated);
      }
    } finally {
      setIsPreCachingActionBusy(false);
    }
  };

  const handleSelectNetworkSource = async () => {
    if (window.electronAPI) {
      const dir = await window.electronAPI.selectDirectory();
      if (dir) {
        setNetworkSourcePath(dir);
        if (!name) {
          const folderName = dir.split('\\').pop() || 'NetworkStorage';
          setName(folderName);
        }
      }
    }
  };

  const handleSelectLocalMirror = async () => {
    if (window.electronAPI) {
      const dir = await window.electronAPI.selectDirectory();
      if (dir) setLocalMirrorRoot(dir);
    }
  };

  const handleAddStorage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !networkSourcePath.trim() || !localMirrorRoot.trim()) return;

    let newConfig: VirtualStorageConfig = {
      id: `storage_${Date.now()}`,
      name: name.trim(),
      networkSourcePath: networkSourcePath.trim(),
      localMirrorRoot: localMirrorRoot.trim(),
      lastSynced: undefined,
      totalItems: 0,
      totalSizeSaved: 0,
      delayBetweenPhotosSec: delaySec,
      bandwidthLimitMbps: bandwidthLimit,
      inventoryStatus: 'not_started',
    };

    await saveStorages((prev) => {
      const filtered = prev.filter((s) => s.name.toLowerCase() !== newConfig.name.toLowerCase());
      return [...filtered, newConfig];
    });

    // Remove from unlinked blacklist if previously unlinked
    if (window.electronAPI) {
      const unlinked = (await window.electronAPI.loadLibraryData(UNLINKED_STORAGES_KEY)) || [];
      const updatedUnlinked = unlinked.filter((u: string) => u.toLowerCase() !== newConfig.name.toLowerCase());
      await window.electronAPI.saveLibraryData(UNLINKED_STORAGES_KEY, updatedUnlinked);
    }

    setName('');
    setNetworkSourcePath('');

    // Inventory gate: count everything under the source folder and fix that
    // number before any thumbnail/face processing is allowed to start.
    newConfig = await ensureInventoryCompleted(newConfig);
    if (newConfig.inventoryStatus !== 'completed') {
      setSyncSummary(null);
      return;
    }

    // One unified per-photo pipeline (thumbnail -> face detection -> OneDrive
    // reclaim if applicable) for every storage, added or rescanned alike —
    // see docs/PIPELINE_REDESIGN_DEV_DOC.md §3.3. This used to branch into a
    // separate "non-blocking background scan" IPC call for a freshly-added
    // plain storage, which was thumbnail-only, used a different photo-id
    // scheme than everything else, and never ran face detection at all.
    handleSyncStorage(newConfig);
  };

  const handleSyncStorage = async (config: VirtualStorageConfig, forceRecount = false) => {
    if (!window.electronAPI || isSyncing) return;

    setIsSyncing(true);
    setActiveSyncStorageId(config.id);
    setProgress({
      current: 0,
      total: 0,
      currentFile: 'Starting...',
      status: 'scanning',
    });
    setSyncSummary(null);

    // Inventory gate: only an explicit "Rescan / Refresh" (forceRecount)
    // re-counts the source folder to pick up newly added files. Resuming an
    // interrupted sync, retrying after a OneDrive health check, or the
    // auto-sync that fires right after adding a storage all already have a
    // valid, just-computed inventory count — forcing a second full recursive
    // recount here (as this used to do unconditionally) meant every one of
    // those wasted a full extra directory walk before any real work started,
    // which on a large NAS share could look like nothing was happening.
    if (forceRecount) {
      config = { ...config, inventoryStatus: 'not_started' };
    }
    config = await ensureInventoryCompleted(config);
    if (config.inventoryStatus !== 'completed') {
      setIsSyncing(false);
      setActiveSyncStorageId(null);
      return;
    }

    try {
      // syncVirtualStorage now runs the full unified pipeline itself —
      // thumbnail, then face detection, then OneDrive reclaim if applicable
      // — for plain and OneDrive-backed sources alike (see
      // docs/PIPELINE_REDESIGN_DEV_DOC.md §3.3).
      const result = await window.electronAPI.syncVirtualStorage(config);
      if (result.success) {
        const fullLocalPath = `${config.localMirrorRoot}\\${config.name}`;
        setSyncSummary({
          storageName: config.name,
          totalSynced: result.totalSynced,
          newlyAdded: result.newlyAdded,
          totalSizeSaved: result.totalSizeSaved,
          localPath: fullLocalPath,
        });

        // Update stored config stats via functional updater on latest state
        await saveStorages((prev) =>
          prev.map((s) =>
            s.id === config.id || s.name === config.name
              ? {
                  ...s,
                  id: config.id,
                  lastSynced: new Date().toISOString(),
                  totalItems: result.totalSynced,
                  totalSizeSaved: result.totalSizeSaved,
                  newlyAdded: result.newlyAdded,
                }
              : s
          )
        );

        // syncVirtualStorage above already ran the full unified pipeline
        // (thumbnail -> face detection -> OneDrive reclaim) for every photo
        // — there's nothing left for a second pass to do. This used to also
        // call onScanStorageFaces(config), which round-tripped into App.tsx
        // and triggered a SECOND, redundant syncVirtualStorage run there —
        // driven by App.tsx's own separate copy of the virtualStorages
        // array (it and this component each hold their own React state,
        // kept in sync only via the onStoragesUpdated callback above, which
        // isn't necessarily caught up with what saveStorages just persisted
        // a moment ago). That second run's save-back would then overwrite
        // the inventoryStatus/inventoryTotalFiles just set above with stale
        // values from App.tsx's lagging copy — exactly the "storage view
        // shows a different, wrong number" bug this rewrite was meant to
        // eliminate, just reintroduced through a different door. If the
        // user is actively browsing this storage's photos, re-selecting it
        // (or the next "Browse in Library" click) picks up the fresh data —
        // no need to force that refresh from here.
      }
    } catch (err) {
      console.error('Failed to sync virtual storage:', err);
    } finally {
      setIsSyncing(false);
      setActiveSyncStorageId(null);
    }
  };

  const confirmDeleteStorage = async (deleteDiskFiles: boolean) => {
    if (!storageToDelete) return;
    const target = storageToDelete;

    // 1. If deleting disk files, invoke native IPC to trash folder in C:\GPhotos_VirtualMirrors
    if (deleteDiskFiles && window.electronAPI?.deleteVirtualStorage) {
      await window.electronAPI.deleteVirtualStorage({
        storageName: target.name,
        localMirrorRoot: target.localMirrorRoot,
        deleteDiskFiles: true,
      });
    }

    // 2. Persist to unlinked list so auto-discover mirrors will never resurrect it
    let unlinked: string[] = [];
    if (window.electronAPI) {
      unlinked = (await window.electronAPI.loadLibraryData(UNLINKED_STORAGES_KEY)) || [];
    } else if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(UNLINKED_STORAGES_KEY);
      if (raw) unlinked = JSON.parse(raw);
    }
    if (!unlinked.map((n) => n.toLowerCase()).includes(target.name.toLowerCase())) {
      unlinked.push(target.name);
      if (window.electronAPI) {
        await window.electronAPI.saveLibraryData(UNLINKED_STORAGES_KEY, unlinked);
      } else if (typeof localStorage !== 'undefined') {
        localStorage.setItem(UNLINKED_STORAGES_KEY, JSON.stringify(unlinked));
      }
    }

    // 3. Remove from active storages list
    await saveStorages((prev) =>
      prev.filter(
        (s) =>
          s.id !== target.id &&
          s.name.toLowerCase() !== target.name.toLowerCase()
      )
    );

    // 4. Clean up any photos from this storage that might be loaded in libraryStore
    libraryStore.removePhotosByStorage(target.name);
    setStorageToDelete(null);
  };

  const handleUpdateServiceSetting = async (key: string, val: any) => {
    if (!window.electronAPI?.setBackgroundServiceSettings) return;
    setIsUpdatingService(true);
    await window.electronAPI.setBackgroundServiceSettings({ [key]: val });
    const updated = await window.electronAPI.getBackgroundServiceStatus();
    setServiceStatus(updated);
    setIsUpdatingService(false);
  };

  const handleTriggerServiceSyncNow = async () => {
    if (!window.electronAPI?.triggerBackgroundServiceSync) return;
    await window.electronAPI.triggerBackgroundServiceSync();
    if (window.electronAPI.getBackgroundServiceStatus) {
      const updated = await window.electronAPI.getBackgroundServiceStatus();
      setServiceStatus(updated);
    }
  };

  const handleSyncAllStorages = async () => {
    if (!window.electronAPI || isSyncing || storagesRef.current.length === 0) return;
    for (const storage of storagesRef.current) {
      await handleSyncStorage(storage, true);
    }
  };

  const formatBytes = (bytes: number) => {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflowY: 'auto', padding: isMobile ? '16px' : '32px 40px' }}>
      {/* Header */}
      <div style={{
        marginBottom: isMobile ? '18px' : '28px',
        display: 'flex',
        flexWrap: isMobile ? 'wrap' : 'nowrap',
        justifyContent: 'space-between',
        alignItems: isMobile ? 'stretch' : 'flex-start',
        gap: isMobile ? '12px' : undefined,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0 }}>
          <div style={{
            width: isMobile ? '34px' : '42px',
            height: isMobile ? '34px' : '42px',
            flexShrink: 0,
            borderRadius: 'var(--radius-md)',
            backgroundColor: 'rgba(6, 182, 212, 0.15)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--accent-cyan)',
          }}>
            <HardDrive size={isMobile ? 18 : 24} />
          </div>
          <div style={{ minWidth: 0 }}>
            <h2 style={{ fontSize: isMobile ? '1.05rem' : '1.4rem', fontWeight: 800, color: 'var(--text-primary)' }}>
              Virtual Network Storage Mirrors
            </h2>
            {!isMobile && (
              <p style={{ fontSize: '0.875rem', color: 'var(--text-muted)' }}>
                Replicate network folders locally with lightweight 500px thumbnails and EXIF metadata without copying original photos.
              </p>
            )}
          </div>
        </div>

        {storages.length > 0 && (
          <button
            className="btn btn-secondary"
            onClick={handleSyncAllStorages}
            disabled={isSyncing}
            style={{ fontSize: '0.85rem', gap: '8px', width: isMobile ? '100%' : undefined, justifyContent: isMobile ? 'center' : undefined }}
            title="Rescan all network folders to check if photos were added"
          >
            <RefreshCw size={15} className={isSyncing ? 'animate-spin' : ''} />
            <span>{isSyncing ? 'Rescanning...' : 'Rescan All Network Mirrors'}</span>
          </button>
        )}
      </div>

      {/* Add New Network Storage Card */}
      <div style={{
        backgroundColor: 'var(--bg-surface)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-lg)',
        padding: isMobile ? '16px' : '24px',
        boxShadow: 'var(--shadow-sm)',
        maxWidth: '860px',
        marginBottom: isMobile ? '20px' : '32px',
      }}>
        <div style={{
          display: 'flex',
          flexDirection: isMobile ? 'column' : 'row',
          justifyContent: 'space-between',
          alignItems: isMobile ? 'stretch' : 'center',
          gap: isMobile ? '10px' : undefined,
          marginBottom: '16px',
        }}>
          <h3 style={{ fontSize: '1.05rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Zap size={18} color="var(--accent-cyan)" />
            Connect Remote / Cloud Storage Mirror
          </h3>
          <div className={isMobile ? 'filter-pills-row' : undefined} style={{ display: 'flex', gap: '6px' }}>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                setName('Google_Drive_Photos');
                setNetworkSourcePath('G:\\My Drive\\Photos');
              }}
              style={{ fontSize: '0.72rem', padding: '4px 8px' }}
              title="Quick fill Google Drive Desktop path"
            >
              ☁️ Google Drive
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                setName('OneDrive_Photos');
                setNetworkSourcePath('C:\\Users\\' + (navigator.userAgent.includes('Windows') ? 'Photos' : '') + '\\OneDrive\\Pictures');
              }}
              style={{ fontSize: '0.72rem', padding: '4px 8px' }}
              title="Quick fill OneDrive path"
            >
              📁 OneDrive
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                setName('Home_NAS');
                setNetworkSourcePath('\\\\NAS\\Photos');
              }}
              style={{ fontSize: '0.72rem', padding: '4px 8px' }}
              title="Quick fill Home NAS path"
            >
              🌐 Network NAS
            </button>
          </div>
        </div>

        {/* Tip Box explaining zero local duplicate space & offline support */}
        <div style={{
          backgroundColor: 'rgba(6, 182, 212, 0.08)',
          border: '1px solid rgba(6, 182, 212, 0.25)',
          borderRadius: 'var(--radius-md)',
          padding: '12px 16px',
          marginBottom: '16px',
          fontSize: '0.8rem',
          color: 'var(--text-secondary)',
          lineHeight: '1.4',
        }}>
          <strong style={{ color: 'var(--accent-cyan)' }}>Zero-Download Virtual Mirroring:</strong> Connect folders from Google Drive, OneDrive, or a home NAS. The application generates lightweight <strong>500px local thumbnails (~50 KB)</strong> and stores EXIF metadata locally. Face recognition, People albums, and Map locations work seamlessly <strong>100% offline</strong> without downloading or duplicating full GB-sized originals.
        </div>

        <form onSubmit={handleAddStorage} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 2fr', gap: '16px' }}>
            <div>
              <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, marginBottom: '6px', color: 'var(--text-secondary)' }}>
                Storage Location Name
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Google_Drive, OneDrive, or Home_NAS"
                className="input"
                required
              />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, marginBottom: '6px', color: 'var(--text-secondary)' }}>
                Network / Remote Source Folder
              </label>
              <div style={{ display: 'flex', gap: '8px' }}>
                <input
                  type="text"
                  value={networkSourcePath}
                  onChange={(e) => setNetworkSourcePath(e.target.value)}
                  placeholder="Select or paste network path e.g. \\NAS\FamilyPhotos"
                  className="input"
                  required
                />
                <button type="button" className="btn btn-secondary" onClick={handleSelectNetworkSource} title="Browse Network Folder">
                  <FolderOpen size={16} />
                </button>
              </div>
            </div>
          </div>

          <div>
            <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, marginBottom: '6px', color: 'var(--text-secondary)' }}>
              Local Mirror Cache Root
            </label>
            <div style={{ display: 'flex', gap: '8px' }}>
              <input
                type="text"
                value={localMirrorRoot}
                onChange={(e) => setLocalMirrorRoot(e.target.value)}
                placeholder="Where to store local replicated folders & 500px thumbnails"
                className="input"
                required
              />
              <button type="button" className="btn btn-secondary" onClick={handleSelectLocalMirror} title="Change Cache Root">
                <FolderOpen size={16} />
              </button>
            </div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '4px' }}>
              Folder structure will be mirrored at: <code style={{ color: 'var(--accent-cyan)' }}>{localMirrorRoot}\{name || '[StorageName]'}\...</code>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: '16px' }}>
            <div>
              <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '6px', color: 'var(--text-secondary)' }}>
                Scan Delay Per Photo (seconds)
              </label>
              <input
                type="number"
                min="0"
                max="10"
                step="0.5"
                value={delaySec}
                onChange={(e) => setDelaySec(parseFloat(e.target.value) || 0)}
                placeholder="0 = fastest, 0.5 - 1.0 = gentle"
                className="input"
              />
              <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '4px' }}>
                Pause between files so background scanning never saturates network bandwidth or freezes work.
              </div>
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '6px', color: 'var(--text-secondary)' }}>
                Bandwidth Limit (Mbps)
              </label>
              <input
                type="number"
                min="0"
                max="1000"
                step="5"
                value={bandwidthLimit}
                onChange={(e) => setBandwidthLimit(parseInt(e.target.value, 10) || 0)}
                placeholder="0 = unlimited"
                className="input"
              />
              <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '4px' }}>
                Optional bandwidth limit per network connection.
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '8px' }}>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={isSyncing || !name.trim() || !networkSourcePath.trim()}
              style={{ padding: '10px 24px' }}
            >
              <HardDrive size={16} />
              <span>Add & Start Virtual Mirror</span>
            </button>
          </div>
        </form>
      </div>

      {/* Sync Progress Bar */}
      {isSyncing && progress && (
        <div style={{
          backgroundColor: 'var(--bg-surface)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-md)',
          padding: '20px',
          maxWidth: '860px',
          marginBottom: '24px',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', marginBottom: '8px', gap: '8px' }}>
            <span style={{
              color: 'var(--accent-cyan)',
              fontWeight: 600,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}>
              Generating 500px Thumbnails: {progress.currentFile}
            </span>
            <span style={{ flexShrink: 0 }}>{progress.current} / {progress.total}</span>
          </div>
          <div style={{
            height: '8px',
            borderRadius: 'var(--radius-full)',
            backgroundColor: 'var(--bg-surface-elevated)',
            overflow: 'hidden',
          }}>
            <div style={{
              height: '100%',
              width: `${(progress.current / (progress.total || 1)) * 100}%`,
              backgroundColor: 'var(--accent-cyan)',
              transition: 'width 0.2s ease',
            }} />
          </div>
        </div>
      )}

      {/* Notice: storages auto-removed because their local mirror folder is gone */}
      {prunedStoragesNotice && (
        <div style={{
          backgroundColor: 'rgba(245, 158, 11, 0.12)',
          border: '1px solid rgba(245, 158, 11, 0.35)',
          borderRadius: 'var(--radius-lg)',
          padding: '14px 18px',
          maxWidth: '860px',
          display: 'flex',
          flexWrap: isMobile ? 'wrap' : 'nowrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '12px',
        }}>
          <span style={{ fontSize: '0.85rem', color: '#f59e0b' }}>{prunedStoragesNotice}</span>
          <button
            className="btn btn-ghost btn-icon"
            onClick={() => setPrunedStoragesNotice(null)}
            title="Dismiss"
            style={{ flexShrink: 0 }}
          >
            <X size={14} />
          </button>
        </div>
      )}

      {/* Sync Success Summary */}
      {syncSummary && (
        <div style={{
          backgroundColor: syncSummary.newlyAdded > 0 ? 'rgba(59, 130, 246, 0.12)' : 'rgba(16, 185, 129, 0.12)',
          border: syncSummary.newlyAdded > 0 ? '1px solid rgba(59, 130, 246, 0.35)' : '1px solid rgba(16, 185, 129, 0.35)',
          borderRadius: 'var(--radius-lg)',
          padding: isMobile ? '16px' : '20px',
          maxWidth: '860px',
          display: 'flex',
          flexWrap: isMobile ? 'wrap' : 'nowrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '16px',
          marginBottom: '24px',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            {syncSummary.newlyAdded > 0 ? (
              <Sparkles size={isMobile ? 24 : 32} color="var(--accent-primary)" />
            ) : (
              <CheckCircle2 size={isMobile ? 24 : 32} color="var(--accent-emerald)" />
            )}
            <div>
              <h4 style={{
                fontSize: '1.05rem',
                fontWeight: 700,
                color: syncSummary.newlyAdded > 0 ? 'var(--accent-primary)' : 'var(--accent-emerald)'
              }}>
                {syncSummary.newlyAdded > 0
                  ? `Rescan Complete: ${syncSummary.newlyAdded} New Photos Added!`
                  : `Network Storage Up-to-Date`}
              </h4>
              <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                {syncSummary.newlyAdded > 0 ? (
                  <>
                    Mirrored <strong>{syncSummary.newlyAdded}</strong> new photos from <strong>{syncSummary.storageName}</strong> (total {syncSummary.totalSynced} items). Saved ~<strong>{formatBytes(syncSummary.totalSizeSaved)}</strong> local disk space!
                  </>
                ) : (
                  <>
                    Checked <strong>{syncSummary.storageName}</strong>: All <strong>{syncSummary.totalSynced}</strong> photos are already indexed locally. No new photos detected.
                  </>
                )}
              </p>
            </div>
          </div>

          <button
            className="btn btn-primary"
            onClick={() => onLoadMirroredPhotos(syncSummary.localPath)}
            style={{ fontSize: '0.85rem', padding: '8px 16px', whiteSpace: 'nowrap', width: isMobile ? '100%' : undefined, justifyContent: isMobile ? 'center' : undefined }}
          >
            <Layers size={15} />
            <span>Browse in Library Now</span>
          </button>
        </div>
      )}

      {/* Configured Storages List */}
      <div style={{ maxWidth: '860px' }}>
        <h3 style={{ fontSize: '1.1rem', fontWeight: 700, marginBottom: '16px' }}>
          Configured Storages {isLoadingStorages ? '' : `(${storages.length})`}
        </h3>

        {isLoadingStorages || (storages.length > 0 && isLoadingStorageDetails) ? (
          <div style={{
            padding: '48px 32px',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '12px',
            backgroundColor: 'var(--bg-surface)',
            borderRadius: 'var(--radius-md)',
            border: '1px solid var(--border-subtle)',
            color: 'var(--text-secondary)',
          }}>
            <RefreshCw size={26} className="animate-spin" color="var(--accent-primary)" />
            <div style={{ fontSize: '0.95rem', fontWeight: 600, color: 'var(--text-primary)' }}>
              Loading storage configurations...
            </div>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
              Checking connected network drives and virtual mirror directories
            </div>
          </div>
        ) : storages.length === 0 ? (
          <div style={{
            padding: '32px',
            textAlign: 'center',
            backgroundColor: 'var(--bg-surface)',
            borderRadius: 'var(--radius-md)',
            border: '1px solid var(--border-subtle)',
            color: 'var(--text-muted)',
            fontSize: '0.9rem',
          }}>
            No virtual network storages added yet. Connect your NAS or remote folders above.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {storages.map((s) => {
              const fullLocalPath = `${s.localMirrorRoot}\\${s.name}`;
              const isThisSyncing = isSyncing && activeSyncStorageId === s.id;

              return (
                <div
                  key={s.id}
                  style={{
                    backgroundColor: 'var(--bg-surface)',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 'var(--radius-lg)',
                    padding: isMobile ? '14px 16px' : '20px 24px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '12px',
                  }}
                >
                  <div style={{ display: 'flex', flexWrap: isMobile ? 'wrap' : 'nowrap', justifyContent: 'space-between', alignItems: 'flex-start', gap: '10px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0 }}>
                      <div style={{
                        width: '36px',
                        height: '36px',
                        flexShrink: 0,
                        borderRadius: 'var(--radius-md)',
                        backgroundColor: 'var(--bg-surface-elevated)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: 'var(--accent-cyan)',
                      }}>
                        <HardDrive size={18} />
                      </div>
                      <div style={{ minWidth: 0 }}>
                        <h4 style={{ fontSize: '1.05rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                          {s.name}
                        </h4>
                        <div style={{
                          fontSize: '0.75rem',
                          color: 'var(--text-muted)',
                          fontFamily: 'var(--font-mono)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: isMobile ? 'nowrap' : 'normal',
                        }}>
                          Remote: {s.networkSourcePath}
                        </div>
                        {s.inventoryStatus === 'scanning' && (
                          <div style={{ fontSize: '0.75rem', color: 'var(--accent-cyan)', marginTop: '4px', fontWeight: 600 }}>
                            Inventorying… counting files before processing starts
                          </div>
                        )}
                        {s.inventoryStatus === 'failed' && (
                          <div style={{ fontSize: '0.75rem', color: '#fb7185', marginTop: '4px', fontWeight: 600 }}>
                            Inventory failed{s.inventoryError ? `: ${s.inventoryError}` : ''} — processing paused until this succeeds
                          </div>
                        )}
                      </div>
                    </div>

                    <div style={{ display: 'flex', gap: isMobile ? '6px' : '8px', flexWrap: 'wrap' }}>
                      {onBrowseFolderTree && (
                        <button
                          className="btn btn-secondary"
                          onClick={() => onBrowseFolderTree(s.networkSourcePath)}
                          style={{ fontSize: '0.8rem', padding: isMobile ? '6px 8px' : '6px 12px', gap: '6px' }}
                          title="Browse remote directory tree immediately (even before scanning completes)"
                        >
                          <FolderTree size={14} color="var(--accent-cyan)" />
                          {!isMobile && <span>Folder Tree</span>}
                        </button>
                      )}

                      {(() => {
                        const prog = storageProgressMap[s.name] || storageProgressMap[s.id];
                        const canResume = prog?.canResume || prog?.phase === 'interrupted';

                        return canResume ? (
                          <button
                            className="btn btn-primary"
                            onClick={() => handleSyncStorage(s)}
                            disabled={isSyncing}
                            style={{
                              fontSize: '0.8rem',
                              padding: isMobile ? '6px 8px' : '6px 14px',
                              gap: '6px',
                              backgroundColor: '#f59e0b',
                              borderColor: '#d97706',
                              color: '#000',
                              fontWeight: 700,
                            }}
                            title={`Resume sync from photo ${(prog?.thumbnailCurrent || 0) + 1} of ${prog?.thumbnailTotal || '?'}`}
                          >
                            <Play size={14} />
                            {!isMobile && <span>Resume Sync ({prog?.percent || 0}%)</span>}
                          </button>
                        ) : (
                          <button
                            className="btn btn-secondary"
                            onClick={() => handleSyncStorage(s, true)}
                            disabled={isSyncing}
                            style={{ fontSize: '0.8rem', padding: isMobile ? '6px 8px' : '6px 12px', gap: '6px' }}
                            title="Check for new photos, cache thumbnails, and run face recognition — all in one pass"
                          >
                            <RefreshCw size={14} className={isThisSyncing ? 'animate-spin' : ''} />
                            {!isMobile && <span>{isThisSyncing ? 'Rescanning...' : 'Rescan / Refresh'}</span>}
                          </button>
                        );
                      })()}

                      <button
                        className="btn btn-primary"
                        onClick={() => onLoadMirroredPhotos(fullLocalPath)}
                        style={{ fontSize: '0.8rem', padding: isMobile ? '6px 8px' : '6px 14px', gap: '6px' }}
                        title="Browse in Library"
                      >
                        <Layers size={14} />
                        {!isMobile && <span>Browse in Library</span>}
                      </button>

                      <button
                        className="btn btn-ghost"
                        onClick={() => setStorageToDelete(s)}
                        disabled={isSyncing}
                        style={{ fontSize: '0.8rem', padding: '6px 10px', color: 'var(--accent-rose)' }}
                        title="Delete or unlink this network storage"
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </div>

                  {/* Dual Status: Thumbnail Caching & Face Detection */}
                  {(() => {
                    const details = storageDetailsMap[s.name] || storageDetailsMap[s.id];
                    const prog = storageProgressMap[s.name] || storageProgressMap[s.id];

                    // Once inventory has completed, its fixed count is the
                    // single source of truth (see docs/PIPELINE_REDESIGN_DEV_DOC.md
                    // §3.2) — no more live disk-scan vs persisted-config
                    // numbers that can disagree with each other or with the
                    // sidebar. Before inventory completes, fall back to the
                    // live per-storage scan / persisted totalItems so the
                    // card still shows a reasonable number mid-scan.
                    const rawTotal = s.inventoryStatus === 'completed'
                      ? (s.inventoryTotalFiles || 0)
                      : (details?.totalPhotos || s.totalItems || 0);
                    const totalPhotos = rawTotal > 0
                      ? rawTotal
                      : Math.max(prog?.thumbnailTotal || 0, prog?.faceTotal || 0);

                    // Thumbnail stats
                    const rawCached = prog?.thumbnailCurrent !== undefined && (prog.phase === 'thumbnails' || prog.phase === 'interrupted' || prog.phase === 'completed')
                      ? prog.thumbnailCurrent
                      : (details?.cachedThumbnails !== undefined ? details.cachedThumbnails : (s.totalItems || 0));
                    const cachedThumbnails = totalPhotos > 0 ? Math.min(rawCached, totalPhotos) : rawCached;
                    const isThumbActive = prog?.phase === 'thumbnails' || (isSyncing && activeSyncStorageId === s.id);

                    // Face stats
                    const facesDetected = details?.facesDetectedCount ?? 0;
                    const isFaceActive = prog?.phase === 'faces';

                    return (
                      <div style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '10px',
                        backgroundColor: 'rgba(15, 23, 42, 0.45)',
                        border: '1px solid rgba(255, 255, 255, 0.06)',
                        borderRadius: 'var(--radius-md)',
                        padding: '14px 16px',
                      }}>
                        {/* Active Phase Banner (if active) */}
                        {prog && prog.phase && prog.phase !== 'idle' && (
                          <div style={{
                            display: 'flex',
                            flexWrap: isMobile ? 'wrap' : 'nowrap',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: '8px',
                            padding: '6px 12px',
                            borderRadius: 'var(--radius-sm)',
                            fontSize: '0.78rem',
                            backgroundColor: prog.phase === 'paused' || prog.phase === 'error'
                              ? 'rgba(244, 63, 94, 0.14)'
                              : prog.phase === 'faces'
                              ? 'rgba(236, 72, 153, 0.12)'
                              : prog.phase === 'completed'
                              ? 'rgba(16, 185, 129, 0.12)'
                              : prog.phase === 'interrupted'
                              ? 'rgba(245, 158, 11, 0.12)'
                              : 'rgba(56, 189, 248, 0.12)',
                            color: prog.phase === 'paused' || prog.phase === 'error'
                              ? '#fb7185'
                              : prog.phase === 'faces'
                              ? '#f472b6'
                              : prog.phase === 'completed'
                              ? '#10b981'
                              : prog.phase === 'interrupted'
                              ? '#f59e0b'
                              : 'var(--accent-cyan)',
                            border: '1px solid currentColor',
                          }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
                              {(isThumbActive || isFaceActive) && <RefreshCw size={12} className="animate-spin" style={{ flexShrink: 0 }} />}
                              <span style={{
                                fontWeight: 700,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: isMobile ? 'nowrap' : 'normal',
                              }}>
                                {prog.phase === 'paused' && (prog.message || '⚠ Paused — OneDrive is not freeing up disk space as expected.')}
                                {prog.phase === 'scanning' && 'Scanning remote directory...'}
                                {prog.phase === 'thumbnails' && `Caching Thumbnails (${prog.thumbnailCurrent}/${prog.thumbnailTotal || '?'})`}
                                {prog.phase === 'faces' && `Recognizing Faces (${prog.faceCurrent}/${prog.faceTotal || '?'})`}
                                {prog.phase === 'interrupted' && `Sync Interrupted / Checkpoint Saved at photo ${prog.thumbnailCurrent}`}
                                {prog.phase === 'completed' && '✓ Sync and Processing Completed'}
                                {prog.phase !== 'paused' && prog.currentFile && ` • ${prog.currentFile}`}
                              </span>
                            </div>
                            {prog.phase === 'paused' ? (
                              <button
                                className="btn btn-secondary"
                                style={{ fontSize: '0.72rem', padding: '4px 10px', flexShrink: 0 }}
                                onClick={async (e) => {
                                  e.stopPropagation();
                                  await window.electronAPI?.resetOneDriveReclaimHealth?.();
                                  handleSyncStorage(s);
                                }}
                              >
                                Retry
                              </button>
                            ) : (
                              <span style={{ fontWeight: 700, fontFamily: 'var(--font-mono)' }}>{prog.percent}%</span>
                            )}
                          </div>
                        )}

                        {/* Single simple status row: total images, cached, faces detected */}
                        <div style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-around',
                          backgroundColor: 'var(--bg-surface-elevated)',
                          borderRadius: 'var(--radius-sm)',
                          padding: '12px 8px',
                          border: '1px solid rgba(255, 255, 255, 0.04)',
                        }}>
                          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--text-secondary)' }}>
                              <Layers size={14} />
                              <span style={{ fontSize: '0.72rem', fontWeight: 600, textTransform: 'uppercase' }}>Total Images</span>
                            </div>
                            <span style={{ fontFamily: 'var(--font-mono)', fontSize: '1.1rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                              {totalPhotos.toLocaleString()}
                            </span>
                          </div>

                          <div style={{ width: '1px', alignSelf: 'stretch', backgroundColor: 'rgba(255, 255, 255, 0.08)' }} />

                          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--accent-cyan)' }}>
                              <Image size={14} />
                              <span style={{ fontSize: '0.72rem', fontWeight: 600, textTransform: 'uppercase' }}>Cached</span>
                            </div>
                            <span style={{ fontFamily: 'var(--font-mono)', fontSize: '1.1rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                              {cachedThumbnails.toLocaleString()}
                              {isThumbActive && <RefreshCw size={12} className="animate-spin" style={{ marginLeft: '6px', verticalAlign: 'middle' }} />}
                            </span>
                          </div>

                          <div style={{ width: '1px', alignSelf: 'stretch', backgroundColor: 'rgba(255, 255, 255, 0.08)' }} />

                          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#ec4899' }}>
                              <Users size={14} />
                              <span style={{ fontSize: '0.72rem', fontWeight: 600, textTransform: 'uppercase' }}>Faces Detected</span>
                            </div>
                            <span style={{ fontFamily: 'var(--font-mono)', fontSize: '1.1rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                              {facesDetected.toLocaleString()}
                              {isFaceActive && <RefreshCw size={12} className="animate-spin" style={{ marginLeft: '6px', verticalAlign: 'middle' }} />}
                            </span>
                          </div>
                        </div>
                      </div>
                    );
                  })()}

                  {/* Mirror Location & Space Saved Pill */}
                  <div style={{
                    display: 'flex',
                    flexDirection: isMobile ? 'column' : 'row',
                    alignItems: isMobile ? 'flex-start' : 'center',
                    justifyContent: 'space-between',
                    padding: '10px 14px',
                    backgroundColor: 'var(--bg-surface-elevated)',
                    borderRadius: 'var(--radius-md)',
                    fontSize: '0.78rem',
                    gap: isMobile ? '8px' : undefined,
                  }}>
                    <div style={{ color: 'var(--text-secondary)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%' }}>
                      Local Mirror: <code style={{ color: 'var(--text-primary)' }}>{fullLocalPath}</code>
                    </div>

                    <div style={{ display: 'flex', flexWrap: isMobile ? 'wrap' : 'nowrap', alignItems: 'center', gap: '12px' }}>
                      {s.newlyAdded !== undefined && (
                        <span style={{
                          fontSize: '0.72rem',
                          fontWeight: 700,
                          padding: '2px 8px',
                          borderRadius: 'var(--radius-full)',
                          backgroundColor: s.newlyAdded > 0 ? 'rgba(59, 130, 246, 0.2)' : 'rgba(16, 185, 129, 0.15)',
                          color: s.newlyAdded > 0 ? 'var(--accent-primary)' : 'var(--accent-emerald)',
                          border: s.newlyAdded > 0 ? '1px solid rgba(59, 130, 246, 0.4)' : '1px solid rgba(16, 185, 129, 0.3)',
                        }}>
                          {s.newlyAdded > 0 ? `+${s.newlyAdded} new photos` : 'Up-to-date'}
                        </span>
                      )}
                      <span>Mirrored: <strong>{s.totalItems || 0}</strong> photos</span>
                      {s.lastSynced && (
                        <span style={{ color: 'var(--text-muted)' }}>
                          Last scanned: {new Date(s.lastSynced).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </span>
                      )}
                      {s.totalSizeSaved ? (
                        <span style={{ color: 'var(--accent-emerald)', fontWeight: 600 }}>
                          Saved: {formatBytes(s.totalSizeSaved)}
                        </span>
                      ) : null}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Background Service & System Tray Control Card */}
      <div
        style={{
          maxWidth: '860px',
          marginTop: isMobile ? '20px' : '32px',
          backgroundColor: 'var(--bg-surface)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-lg)',
          padding: isMobile ? '16px' : '24px',
          display: 'flex',
          flexDirection: 'column',
          gap: '16px',
        }}
      >
        <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', flexWrap: isMobile ? 'wrap' : 'nowrap', justifyContent: 'space-between', alignItems: isMobile ? 'stretch' : 'center', gap: isMobile ? '12px' : undefined }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0 }}>
            <div
              style={{
                width: '38px',
                height: '38px',
                flexShrink: 0,
                borderRadius: 'var(--radius-md)',
                backgroundColor: 'rgba(59, 130, 246, 0.15)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--accent-primary)',
              }}
            >
              <Cpu size={20} />
            </div>
            <div style={{ minWidth: 0 }}>
              <h3 style={{ fontSize: '1.05rem', fontWeight: 700, margin: 0, color: 'var(--text-primary)' }}>
                Background Service & System Tray Daemon
              </h3>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', margin: '2px 0 0' }}>
                Continues scanning network folders and generating thumbnails in the background when app is closed
              </p>
            </div>
          </div>

          <div style={{ display: 'flex', flexWrap: isMobile ? 'wrap' : 'nowrap', alignItems: 'center', gap: '10px' }}>
            <span
              style={{
                fontSize: '0.75rem',
                fontWeight: 700,
                padding: '4px 10px',
                borderRadius: 'var(--radius-full)',
                backgroundColor: serviceStatus?.isScanningNow
                  ? 'rgba(59, 130, 246, 0.2)'
                  : serviceStatus?.isPaused
                  ? 'rgba(239, 68, 68, 0.15)'
                  : 'rgba(16, 185, 129, 0.15)',
                color: serviceStatus?.isScanningNow
                  ? 'var(--accent-primary)'
                  : serviceStatus?.isPaused
                  ? 'var(--accent-rose)'
                  : 'var(--accent-emerald)',
                border: '1px solid currentColor',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
              }}
            >
              <span
                style={{
                  width: '6px',
                  height: '6px',
                  borderRadius: 'var(--radius-full)',
                  backgroundColor: 'currentColor',
                }}
              />
              {serviceStatus?.isScanningNow
                ? 'Syncing Now...'
                : serviceStatus?.isPaused
                ? 'Service Paused'
                : 'Service Active'}
            </span>

            <button
              className="btn btn-secondary"
              onClick={handleTriggerServiceSyncNow}
              disabled={serviceStatus?.isScanningNow}
              style={{ fontSize: '0.8rem', padding: '6px 14px', gap: '6px' }}
              title="Run a background sync pass right now"
            >
              <RefreshCw size={14} className={serviceStatus?.isScanningNow ? 'animate-spin' : ''} />
              <span>Sync Now</span>
            </button>
          </div>
        </div>

        {/* Settings Grid */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
            gap: '14px',
            paddingTop: '8px',
          }}
        >
          {/* Setting 1: Minimize to Tray */}
          <label
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: '10px',
              padding: '12px 14px',
              backgroundColor: 'var(--bg-surface-elevated)',
              borderRadius: 'var(--radius-md)',
              cursor: 'pointer',
              fontSize: '0.85rem',
            }}
          >
            <input
              type="checkbox"
              checked={serviceStatus?.minimizeToTray ?? true}
              onChange={(e) => handleUpdateServiceSetting('minimizeToTray', e.target.checked)}
              disabled={isUpdatingService}
              style={{ marginTop: '2px' }}
            />
            <div>
              <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
                Keep Running in Windows Tray
              </div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                Closing window hides to tray instead of quitting, so background sync continues
              </div>
            </div>
          </label>

          {/* Setting 2: Run at Startup */}
          <label
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: '10px',
              padding: '12px 14px',
              backgroundColor: 'var(--bg-surface-elevated)',
              borderRadius: 'var(--radius-md)',
              cursor: 'pointer',
              fontSize: '0.85rem',
            }}
          >
            <input
              type="checkbox"
              checked={serviceStatus?.runAtStartup ?? false}
              onChange={(e) => handleUpdateServiceSetting('runAtStartup', e.target.checked)}
              disabled={isUpdatingService}
              style={{ marginTop: '2px' }}
            />
            <div>
              <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
                Start with Windows
              </div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                Automatically launches background tray daemon on computer login
              </div>
            </div>
          </label>

          {/* Setting 3: Sync Interval */}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '6px',
              padding: '12px 14px',
              backgroundColor: 'var(--bg-surface-elevated)',
              borderRadius: 'var(--radius-md)',
              fontSize: '0.85rem',
            }}
          >
            <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
              Sync Frequency
            </div>
            <select
              value={serviceStatus?.syncIntervalMinutes ?? 15}
              onChange={(e) => handleUpdateServiceSetting('syncIntervalMinutes', parseInt(e.target.value, 10))}
              disabled={isUpdatingService}
              className="input"
              style={{ padding: '4px 8px', fontSize: '0.8rem' }}
            >
              <option value={15}>Every 15 minutes</option>
              <option value={30}>Every 30 minutes</option>
              <option value={60}>Every 1 hour</option>
              <option value={120}>Every 2 hours</option>
            </select>
          </div>
        </div>

        {serviceStatus?.lastSyncTime && (
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Clock size={12} />
            <span>Last automatic background sync: {new Date(serviceStatus.lastSyncTime).toLocaleString()}</span>
          </div>
        )}
      </div>

      {/* Delete / Unlink Storage Modal */}
      {storageToDelete && (
        <DeleteStorageModal
          storage={storageToDelete}
          onClose={() => setStorageToDelete(null)}
          onConfirmDelete={confirmDeleteStorage}
        />
      )}
    </div>
  );
};
