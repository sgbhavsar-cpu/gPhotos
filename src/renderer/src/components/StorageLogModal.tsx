import React, { useEffect, useMemo, useState } from 'react';
import { X, Wifi, WifiOff } from 'lucide-react';
import { VirtualStorageConfig, StorageDetails } from '../../../types';
import { storageTaskKey, type StorageTask } from '../services/storageTasks';

export interface StorageTaskInfo { paused: string[]; faults: Record<string, string>; online: boolean }

/** Polls main for each storage's online status and task faults (every 3s while mounted). */
export function useStorageTaskInfo(storages: VirtualStorageConfig[]): Record<string, StorageTaskInfo> {
  const [info, setInfo] = useState<Record<string, StorageTaskInfo>>({});
  const sig = storages.map((s) => `${s.localMirrorRoot}|${s.name}|${s.networkSourcePath}`).join('\n');
  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.getStorageTaskInfo) return;
    let alive = true;
    const tick = async () => {
      const next: Record<string, StorageTaskInfo> = {};
      await Promise.all(storages.map(async (s) => {
        const key = storageTaskKey(s.localMirrorRoot, s.name);
        try { next[key] = await api.getStorageTaskInfo!(key, s.networkSourcePath); } catch {}
      }));
      if (alive) setInfo(next);
    };
    void tick();
    const t = setInterval(tick, 3000);
    return () => { alive = false; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);
  return info;
}

const TASKS: Array<{ id: StorageTask | 'all'; label: string }> = [
  { id: 'all', label: 'All' }, { id: 'caching', label: 'Caching' }, { id: 'faces', label: 'Face Recognition' }, { id: 'ai', label: 'AI Description' },
];
const levelColor = { info: 'var(--text-secondary)', warn: '#f59e0b', error: '#ef4444' } as const;

export const StorageLogModal: React.FC<{ storage: VirtualStorageConfig; details?: StorageDetails; onClose: () => void }> = ({ storage, details, onClose }) => {
  const key = storageTaskKey(storage.localMirrorRoot, storage.name);
  const [filter, setFilter] = useState<StorageTask | 'all'>('all');
  const [online, setOnline] = useState<boolean | null>(null);
  const [logs, setLogs] = useState<Array<{ ts: number; task: string; level: string; message: string }>>([]);

  useEffect(() => {
    const api = window.electronAPI;
    let alive = true;
    const tick = async () => {
      try {
        const [i, l] = await Promise.all([api?.getStorageTaskInfo?.(key, storage.networkSourcePath), api?.getStorageTaskLogs?.(key, filter === 'all' ? undefined : filter)]);
        if (!alive) return;
        if (i) setOnline(i.online);
        if (l) setLogs(l);
      } catch {}
    };
    void tick();
    const t = setInterval(tick, 2000);
    return () => { alive = false; clearInterval(t); };
  }, [key, storage.networkSourcePath, filter]);

  // Counted from the mirror folder on disk (thumbnails cached on this PC), against the storage's own
  // inventory total — the same numbers the storage card shows — not from whatever the library has loaded.
  const [media, setMedia] = useState<{ images: number; videos: number } | null>(null);
  useEffect(() => {
    let alive = true;
    const run = async () => {
      const m = await window.electronAPI?.countStorageMirrorMedia?.(`${storage.localMirrorRoot.replace(/[\\/]+$/, '')}\\${storage.name}`);
      if (alive && m) setMedia(m);
    };
    void run();
    const t = setInterval(run, 15000);
    return () => { alive = false; clearInterval(t); };
  }, [storage.localMirrorRoot, storage.name]);

  const counts = useMemo(() => {
    const offlineAvail = media ? media.images + media.videos : (details?.thumbnailCachedCount ?? 0);
    const total = Math.max(storage.inventoryStatus === 'completed' ? (storage.inventoryTotalFiles || 0) : (details?.totalPhotos || storage.totalItems || 0), offlineAvail);
    return { images: media?.images ?? 0, videos: media?.videos ?? 0, total, offlineAvail, cloudOnly: Math.max(0, total - offlineAvail) };
  }, [media, details, storage]);

  const stat = (label: string, v: number) => (
    <div style={{ flex: 1, minWidth: 90, background: 'var(--bg-surface-elevated)', borderRadius: 8, padding: '8px 12px' }}>
      <div style={{ fontSize: '1.1rem', fontWeight: 700 }}>{v.toLocaleString()}</div>
      <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{label}</div>
    </div>
  );

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(5,8,15,0.88)', zIndex: 4000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: '100%', maxWidth: 760, maxHeight: '85vh', background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-lg)', padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0 }}>{storage.name} — logs</h3>
          <button className="btn btn-ghost btn-icon" onClick={onClose}><X size={20} /></button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: online ? '#22c55e' : online === false ? '#ef4444' : 'var(--text-muted)', fontWeight: 600 }}>
          {online === false ? <WifiOff size={16} /> : <Wifi size={16} />}
          {online === null ? 'Checking…' : online ? 'Online' : 'Offline'}
          <span style={{ fontWeight: 400, fontSize: '0.75rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{storage.networkSourcePath}</span>
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {stat('Total on storage', counts.total)}
          {stat('Images (cached)', counts.images)}
          {stat('Videos (cached)', counts.videos)}
          {stat('Offline available', counts.offlineAvail)}
          {stat('Cloud only', counts.cloudOnly)}
        </div>
        <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Offline available = thumbnails cached on this PC; Cloud only = items that exist only on the network storage so far.</div>

        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {TASKS.map((t) => (
            <button key={t.id} className={`btn ${filter === t.id ? 'btn-primary' : 'btn-secondary'}`} style={{ padding: '4px 12px', fontSize: '0.8rem' }} onClick={() => setFilter(t.id)}>{t.label}</button>
          ))}
        </div>

        <div style={{ flex: 1, minHeight: 200, overflow: 'auto', fontFamily: 'monospace', fontSize: '0.75rem', background: 'rgba(0,0,0,0.25)', borderRadius: 6, padding: 8 }}>
          {logs.length === 0 && <div style={{ color: 'var(--text-muted)' }}>No log entries yet this session.</div>}
          {[...logs].reverse().map((l, i) => (
            <div key={i} style={{ color: levelColor[l.level as keyof typeof levelColor] || 'inherit', wordBreak: 'break-all' }}>
              {new Date(l.ts).toLocaleTimeString()} [{l.task}] {l.message}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
