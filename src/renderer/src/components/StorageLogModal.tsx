import React, { useEffect, useMemo, useRef, useState } from 'react';
import { X, Wifi, WifiOff } from 'lucide-react';
import { VirtualStorageConfig, StorageDetails } from '../../../types';
import { storageTaskKey, type StorageTask } from '../services/storageTasks';

export interface StorageTaskInfo { paused: string[]; faults: Record<string, string>; online: boolean; done?: Record<string, string | undefined> }

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
  const [ctl, setCtl] = useState<{ paused: string[]; faults: Record<string, string> }>({ paused: [], faults: {} });
  const [allLogs, setAllLogs] = useState<Array<{ ts: number; task: string; level: string; message: string }>>([]);
  const [lastPoll, setLastPoll] = useState(0);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const logs = useMemo(() => (filter === 'all' ? allLogs : allLogs.filter((l) => l.task === filter)), [allLogs, filter]);

  useEffect(() => {
    const api = window.electronAPI;
    let alive = true;
    const tick = async () => {
      try {
        const [i, l] = await Promise.all([api?.getStorageTaskInfo?.(key, storage.networkSourcePath), api?.getStorageTaskLogs?.(key)]);
        if (!alive) return;
        if (i) { setOnline(i.online); setCtl({ paused: i.paused || [], faults: i.faults || {} }); }
        if (l) setAllLogs(l);
        setLastPoll(Date.now());
      } catch {}
    };
    void tick();
    const t = setInterval(tick, 2000);
    return () => { alive = false; clearInterval(t); };
  }, [key, storage.networkSourcePath]);

  // Counted from the mirror folder on disk (thumbnails cached on this PC), against the storage's own
  // inventory total — the same numbers the storage card shows — not from whatever the library has loaded.
  const [media, setMedia] = useState<{ images: number; videos: number } | null>(null);
  const history = useRef<Array<{ t: number; n: number }>>([]);
  useEffect(() => {
    let alive = true;
    const run = async () => {
      const m = await window.electronAPI?.countStorageMirrorMedia?.(`${storage.localMirrorRoot.replace(/[\\/]+$/, '')}\\${storage.name}`);
      if (alive && m) {
        setMedia(m);
        history.current = [...history.current, { t: Date.now(), n: m.images + m.videos }].filter((h) => Date.now() - h.t < 10 * 60_000);
      }
    };
    void run();
    const t = setInterval(run, 5000);
    return () => { alive = false; clearInterval(t); };
  }, [storage.localMirrorRoot, storage.name]);

  const counts = useMemo(() => {
    const offlineAvail = media ? media.images + media.videos : (details?.thumbnailCachedCount ?? 0);
    const total = Math.max(storage.inventoryStatus === 'completed' ? (storage.inventoryTotalFiles || 0) : (details?.totalPhotos || storage.totalItems || 0), offlineAvail);
    return { images: media?.images ?? 0, videos: media?.videos ?? 0, total, offlineAvail, cloudOnly: Math.max(0, total - offlineAvail) };
  }, [media, details, storage]);

  const ago = (ts: number) => { const s = Math.max(0, Math.round((now - ts) / 1000)); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`; };
  const ACTIVE_MS = 30_000;
  const taskStatus = (task: StorageTask) => {
    const mine = allLogs.filter((l) => l.task === task);
    const last = mine[mine.length - 1];
    const recent = mine.filter((l) => now - l.ts < 60_000).length;
    if (ctl.faults[task]) return { label: 'Fault', color: '#ef4444', detail: ctl.faults[task], last, recent };
    if (ctl.paused.includes(task)) return { label: 'Paused', color: '#f59e0b', detail: 'Paused by you — press Run on the storage card to resume', last, recent };
    if (online === false) return { label: 'Waiting', color: '#f59e0b', detail: 'Storage is offline', last, recent };
    if (last && now - last.ts < ACTIVE_MS) return { label: 'Working', color: '#22c55e', detail: last.message, last, recent };
    if (last) return { label: 'Idle', color: 'var(--text-muted)', detail: `Nothing happening — last activity ${ago(last.ts)}`, last, recent };
    return { label: 'No activity', color: 'var(--text-muted)', detail: 'Nothing has run for this storage since the app started', last, recent };
  };
  const rate = (() => {
    const h = history.current; if (h.length < 2) return null;
    const newest = h[h.length - 1]; const base = h.find((x) => newest.t - x.t >= 55_000) ?? h[0];
    const mins = (newest.t - base.t) / 60_000; if (mins < 0.2) return null;
    return { delta: newest.n - base.n, mins };
  })();

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
        {counts.total > 0 && (() => {
          const pct = Math.floor((counts.offlineAvail / counts.total) * 100);
          const idle = taskStatus('caching').label === 'Idle';
          return (
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.78rem', fontWeight: 600 }}>
                <span>{counts.cloudOnly === 0 ? 'Caching complete' : `${pct}% cached`}</span>
                <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>{counts.offlineAvail.toLocaleString()} / {counts.total.toLocaleString()}</span>
              </div>
              <div style={{ height: 6, borderRadius: 3, background: 'var(--bg-surface-elevated)', marginTop: 4, overflow: 'hidden' }}>
                <div style={{ width: `${(counts.offlineAvail / counts.total) * 100}%`, height: '100%', background: counts.cloudOnly === 0 ? '#22c55e' : 'var(--accent-primary)' }} />
              </div>
              {idle && counts.cloudOnly > 0 && (
                <div style={{ fontSize: '0.72rem', color: '#f59e0b', marginTop: 4 }}>
                  Caching has finished, but {counts.cloudOnly.toLocaleString()} item{counts.cloudOnly === 1 ? '' : 's'} could not get a thumbnail (e.g. unsupported formats such as .dng). Filter to "Caching" to see "Thumbnail failed" entries.
                </div>
              )}
            </div>
          );
        })()}
        {rate && (
          <div style={{ fontSize: '0.78rem', color: rate.delta > 0 ? '#22c55e' : 'var(--text-muted)' }}>
            {rate.delta > 0 ? `▲ ${rate.delta.toLocaleString()} more photos cached in the last ${Math.max(1, Math.round(rate.mins))} min` : `No new photos cached in the last ${Math.max(1, Math.round(rate.mins))} min`}
          </div>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 8 }}>
          {(['caching', 'faces', 'ai'] as StorageTask[]).map((t) => {
            const st = taskStatus(t);
            return (
              <div key={t} style={{ background: 'var(--bg-surface-elevated)', borderRadius: 8, padding: '8px 12px', minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, fontSize: '0.82rem' }}>
                  <span className={st.label === 'Working' ? 'gp-pulse' : undefined} style={{ width: 8, height: 8, borderRadius: '50%', background: st.color, flexShrink: 0 }} />
                  {TASKS.find((x) => x.id === t)!.label}
                  <span style={{ marginLeft: 'auto', color: st.color, fontWeight: 700, fontSize: '0.75rem' }}>{st.label}</span>
                </div>
                <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={st.detail}>{st.detail}</div>
                <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 2 }}>{st.recent} event{st.recent === 1 ? '' : 's'} in the last minute</div>
              </div>
            );
          })}
        </div>
        <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Offline available = thumbnails cached on this PC; Cloud only = items that exist only on the network storage so far.</div>

        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {TASKS.map((t) => (
            <button key={t.id} className={`btn ${filter === t.id ? 'btn-primary' : 'btn-secondary'}`} style={{ padding: '4px 12px', fontSize: '0.8rem' }} onClick={() => setFilter(t.id)}>{t.label}</button>
          ))}
        </div>

        <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
          <span className="gp-pulse" style={{ width: 6, height: 6, borderRadius: '50%', background: '#22c55e' }} />
          Live — refreshed {lastPoll ? ago(lastPoll) : 'just now'} · newest first · {logs.length} entr{logs.length === 1 ? 'y' : 'ies'}
        </div>
        <div style={{ flex: 1, minHeight: 200, overflow: 'auto', fontFamily: 'monospace', fontSize: '0.75rem', background: 'rgba(0,0,0,0.25)', borderRadius: 6, padding: 8 }}>
          {logs.length === 0 && <div style={{ color: 'var(--text-muted)' }}>No log entries for this task yet. Logs are kept in memory only and start empty each time the app starts.</div>}
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
