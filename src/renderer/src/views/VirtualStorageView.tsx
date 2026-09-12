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
  Radio,
} from 'lucide-react';
import { VirtualStorageConfig, MirrorProgress, BackgroundServiceStatus, NetworkStorageProgress } from '../../types';
import { DeleteStorageModal } from '../components/DeleteStorageModal';
import { libraryStore } from '../services/libraryStore';

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
  const [storages, setStorages] = useState<VirtualStorageConfig[]>([]);
  const storagesRef = useRef<VirtualStorageConfig[]>([]);
  storagesRef.current = storages;

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

  // Load configured storages & auto-discover on-disk mirrors
  useEffect(() => {
    const load = async () => {
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

      storagesRef.current = combined;
      setStorages(combined);
      if (onStoragesUpdated) onStoragesUpdated(combined);
      if (window.electronAPI) {
        await window.electronAPI.saveLibraryData(STORAGE_CONFIGS_KEY, combined);
        if (window.electronAPI.getBackgroundServiceStatus) {
          const status = await window.electronAPI.getBackgroundServiceStatus();
          setServiceStatus(status);
        }
      }
    };
    load();
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

    const newConfig: VirtualStorageConfig = {
      id: `storage_${Date.now()}`,
      name: name.trim(),
      networkSourcePath: networkSourcePath.trim(),
      localMirrorRoot: localMirrorRoot.trim(),
      lastSynced: undefined,
      totalItems: 0,
      totalSizeSaved: 0,
      delayBetweenPhotosSec: delaySec,
      bandwidthLimitMbps: bandwidthLimit,
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

    // Trigger non-blocking background scan (Requirement 1)
    if (window.electronAPI?.startBackgroundScan) {
      const fullLocalPath = `${newConfig.localMirrorRoot}\\${newConfig.name}`;
      await window.electronAPI.startBackgroundScan(newConfig.networkSourcePath, fullLocalPath);
      setSyncSummary({
        storageName: newConfig.name,
        totalSynced: 0,
        newlyAdded: 0,
        totalSizeSaved: 0,
        localPath: fullLocalPath,
      });
    } else {
      handleSyncStorage(newConfig);
    }
  };

  const handleSyncStorage = async (config: VirtualStorageConfig) => {
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

    try {
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
      await handleSyncStorage(storage);
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
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflowY: 'auto', padding: '32px 40px' }}>
      {/* Header */}
      <div style={{ marginBottom: '28px', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{
            width: '42px',
            height: '42px',
            borderRadius: 'var(--radius-md)',
            backgroundColor: 'rgba(6, 182, 212, 0.15)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--accent-cyan)',
          }}>
            <HardDrive size={24} />
          </div>
          <div>
            <h2 style={{ fontSize: '1.4rem', fontWeight: 800, color: 'var(--text-primary)' }}>
              Virtual Network Storage Mirrors
            </h2>
            <p style={{ fontSize: '0.875rem', color: 'var(--text-muted)' }}>
              Replicate network folders locally with lightweight 500px thumbnails and EXIF metadata without copying original photos.
            </p>
          </div>
        </div>

        {storages.length > 0 && (
          <button
            className="btn btn-secondary"
            onClick={handleSyncAllStorages}
            disabled={isSyncing}
            style={{ fontSize: '0.85rem', gap: '8px' }}
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
        padding: '24px',
        boxShadow: 'var(--shadow-sm)',
        maxWidth: '860px',
        marginBottom: '32px',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <h3 style={{ fontSize: '1.05rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Zap size={18} color="var(--accent-cyan)" />
            Connect Remote / Cloud Storage Mirror
          </h3>
          <div style={{ display: 'flex', gap: '6px' }}>
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
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '16px' }}>
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

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
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
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', marginBottom: '8px' }}>
            <span style={{ color: 'var(--accent-cyan)', fontWeight: 600 }}>
              Generating 500px Thumbnails: {progress.currentFile}
            </span>
            <span>{progress.current} / {progress.total}</span>
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

      {/* Sync Success Summary */}
      {syncSummary && (
        <div style={{
          backgroundColor: syncSummary.newlyAdded > 0 ? 'rgba(59, 130, 246, 0.12)' : 'rgba(16, 185, 129, 0.12)',
          border: syncSummary.newlyAdded > 0 ? '1px solid rgba(59, 130, 246, 0.35)' : '1px solid rgba(16, 185, 129, 0.35)',
          borderRadius: 'var(--radius-lg)',
          padding: '20px',
          maxWidth: '860px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '16px',
          marginBottom: '24px',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            {syncSummary.newlyAdded > 0 ? (
              <Sparkles size={32} color="var(--accent-primary)" />
            ) : (
              <CheckCircle2 size={32} color="var(--accent-emerald)" />
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
            style={{ fontSize: '0.85rem', padding: '8px 16px', whiteSpace: 'nowrap' }}
          >
            <Layers size={15} />
            <span>Browse in Library Now</span>
          </button>
        </div>
      )}

      {/* Configured Storages List */}
      <div style={{ maxWidth: '860px' }}>
        <h3 style={{ fontSize: '1.1rem', fontWeight: 700, marginBottom: '16px' }}>
          Configured Storages ({storages.length})
        </h3>

        {storages.length === 0 ? (
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
                    padding: '20px 24px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '12px',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                      <div style={{
                        width: '36px',
                        height: '36px',
                        borderRadius: 'var(--radius-md)',
                        backgroundColor: 'var(--bg-surface-elevated)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: 'var(--accent-cyan)',
                      }}>
                        <HardDrive size={18} />
                      </div>
                      <div>
                        <h4 style={{ fontSize: '1.05rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                          {s.name}
                        </h4>
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                          Remote: {s.networkSourcePath}
                        </div>
                      </div>
                    </div>

                    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                      {onBrowseFolderTree && (
                        <button
                          className="btn btn-secondary"
                          onClick={() => onBrowseFolderTree(s.networkSourcePath)}
                          style={{ fontSize: '0.8rem', padding: '6px 12px', gap: '6px' }}
                          title="Browse remote directory tree immediately (even before scanning completes)"
                        >
                          <FolderTree size={14} color="var(--accent-cyan)" />
                          <span>Folder Tree</span>
                        </button>
                      )}

                      <button
                        className="btn btn-secondary"
                        onClick={() => handleSyncStorage(s)}
                        disabled={isSyncing}
                        style={{ fontSize: '0.8rem', padding: '6px 12px' }}
                        title="Rescan network location to check if new photos were added"
                      >
                        <RefreshCw size={14} className={isThisSyncing ? 'animate-spin' : ''} />
                        <span>{isThisSyncing ? 'Rescanning...' : 'Rescan / Refresh'}</span>
                      </button>

                      <button
                        className="btn btn-primary"
                        onClick={() => onLoadMirroredPhotos(fullLocalPath)}
                        style={{ fontSize: '0.8rem', padding: '6px 14px' }}
                      >
                        <Layers size={14} />
                        <span>Browse in Library</span>
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

                  {/* Live Progress for Thumbnails and Face Recognition */}
                  {(() => {
                    const prog = storageProgressMap[s.name] || storageProgressMap[s.id];
                    if (!prog || !prog.phase || prog.phase === 'idle') return null;
                    return (
                      <div style={{
                        backgroundColor: 'rgba(15, 23, 42, 0.6)',
                        border: '1px solid rgba(255, 255, 255, 0.08)',
                        borderRadius: 'var(--radius-md)',
                        padding: '10px 14px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '6px',
                      }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem' }}>
                          <span style={{
                            color: prog.phase === 'faces' ? '#f472b6' : prog.phase === 'completed' ? '#10b981' : 'var(--accent-cyan)',
                            fontWeight: 600,
                          }}>
                            {prog.phase === 'scanning' && 'Scanning remote folder...'}
                            {prog.phase === 'thumbnails' && `Generating Thumbnails: ${prog.thumbnailCurrent}/${prog.thumbnailTotal || '?'}`}
                            {prog.phase === 'faces' && `Recognizing Faces: ${prog.faceCurrent}/${prog.faceTotal || '?'}`}
                            {prog.phase === 'completed' && '✓ Up to date'}
                            {prog.currentFile && ` (${prog.currentFile})`}
                          </span>
                          <span style={{ fontWeight: 600, color: 'var(--text-muted)' }}>{prog.percent}%</span>
                        </div>
                        <div style={{ height: '6px', borderRadius: '3px', backgroundColor: 'rgba(255, 255, 255, 0.1)', overflow: 'hidden' }}>
                          <div style={{
                            height: '100%',
                            width: `${Math.min(100, Math.max(prog.phase === 'scanning' ? 12 : 0, prog.percent))}%`,
                            background: prog.phase === 'faces'
                              ? 'linear-gradient(90deg, #ec4899, #a855f7)'
                              : prog.phase === 'completed'
                              ? '#10b981'
                              : prog.phase === 'error'
                              ? '#ef4444'
                              : 'var(--accent-cyan)',
                            transition: 'width 0.2s ease',
                          }} />
                        </div>
                      </div>
                    );
                  })()}

                  {/* Mirror Location & Space Saved Pill */}
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '10px 14px',
                    backgroundColor: 'var(--bg-surface-elevated)',
                    borderRadius: 'var(--radius-md)',
                    fontSize: '0.78rem',
                  }}>
                    <div style={{ color: 'var(--text-secondary)' }}>
                      Local Mirror: <code style={{ color: 'var(--text-primary)' }}>{fullLocalPath}</code>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
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
          marginTop: '32px',
          backgroundColor: 'var(--bg-surface)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-lg)',
          padding: '24px',
          display: 'flex',
          flexDirection: 'column',
          gap: '16px',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div
              style={{
                width: '38px',
                height: '38px',
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
            <div>
              <h3 style={{ fontSize: '1.05rem', fontWeight: 700, margin: 0, color: 'var(--text-primary)' }}>
                Background Service & System Tray Daemon
              </h3>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', margin: '2px 0 0' }}>
                Continues scanning network folders and generating thumbnails in the background when app is closed
              </p>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
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
