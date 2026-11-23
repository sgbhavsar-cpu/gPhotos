import React, { useEffect, useState } from 'react';
import { Database, FolderDown, RefreshCw, CheckCircle2, AlertCircle } from 'lucide-react';
import { notifyError } from '../services/notifications';

type Source = { id: string; kind: 'global' | 'library'; label: string; detail?: string; sizeBytes: number };
type Result = { id: string; label: string; success: boolean; zipPath?: string; zipBytes?: number; error?: string };

const fmtBytes = (n: number) => (n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(1)} GB` : n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Settings → Backup: back up the SQLite databases (people, faces, photos, albums) — one zip per library / network drive. */
export const DatabaseBackupPanel: React.FC = () => {
  const [sources, setSources] = useState<Source[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Result[] | null>(null);
  const [folder, setFolder] = useState<string | null>(null);

  const load = async () => {
    const list = (await window.electronAPI?.listDbBackupSources?.()) ?? [];
    setSources(list);
    setSelected(new Set(list.map((s) => s.id)));
  };
  useEffect(() => { load(); }, []);

  const toggle = (id: string) => setSelected((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const run = async () => {
    if (!window.electronAPI?.runDbBackup || selected.size === 0) return;
    setBusy(true);
    setResults(null);
    try {
      const res = await window.electronAPI.runDbBackup([...selected]);
      if (res.canceled) return;
      if (res.error && !res.results) { notifyError('Database backup', res.error); return; }
      setResults(res.results ?? []);
      setFolder(res.folder ?? null);
    } catch (err) {
      notifyError('Database backup', err);
    } finally {
      setBusy(false);
    }
  };

  const total = (sources ?? []).filter((s) => selected.has(s.id)).reduce((a, s) => a + s.sizeBytes, 0);

  return (
    <div data-testid="db-backup-panel" style={{ backgroundColor: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-lg)', padding: '24px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
      <div>
        <h2 style={{ fontSize: '1.15rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '10px', margin: '0 0 4px 0' }}>
          <Database size={20} color="var(--accent-primary)" /> Database backup (people &amp; face detection)
        </h2>
        <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', margin: 0, maxWidth: '680px' }}>
          Saves a copy of each database as its own .zip: one per library or network drive (photos, detected faces, albums) and one for the shared people names and settings. Pick the ones you want; the zips go into a folder you choose.
        </p>
      </div>

      {sources === null ? (
        <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>Looking for databases…</div>
      ) : sources.length === 0 ? (
        <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>No databases found to back up.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {sources.map((s) => (
            <label key={s.id} data-testid="db-backup-source" style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 10px', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', cursor: 'pointer', fontSize: '0.85rem' }}>
              <input type="checkbox" checked={selected.has(s.id)} onChange={() => toggle(s.id)} disabled={busy} />
              <span style={{ flex: 1, minWidth: 0 }}>
                <strong>{s.label}</strong>
                {s.detail && <span style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.detail}</span>}
              </span>
              <span style={{ color: 'var(--text-muted)', fontSize: '0.78rem', flexShrink: 0 }}>{fmtBytes(s.sizeBytes)}</span>
            </label>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
        <button className="btn btn-primary" data-testid="db-backup-run" onClick={run} disabled={busy || selected.size === 0} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {busy ? <><RefreshCw size={16} className="animate-spin" /> Backing up…</> : <><FolderDown size={16} /> Back up {selected.size} selected…</>}
        </button>
        {selected.size > 0 && <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>About {fmtBytes(total)} before compression. Large libraries can take a minute or two.</span>}
      </div>

      {results && (
        <div data-testid="db-backup-results" style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '0.82rem' }}>
          {results.map((r) => (
            <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', color: r.success ? 'var(--accent-emerald)' : '#f87171' }}>
              {r.success ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
              <span style={{ flex: 1, minWidth: 0 }}>{r.success ? `${r.label} — ${fmtBytes(r.zipBytes ?? 0)}` : `${r.label} — ${r.error}`}</span>
            </div>
          ))}
          {folder && window.electronAPI?.openItemInFolder && results.some((r) => r.success) && (
            <button className="btn btn-secondary" style={{ alignSelf: 'flex-start', fontSize: '0.78rem', padding: '4px 10px', height: 'auto' }}
              onClick={async () => { try { const first = results.find((r) => r.success && r.zipPath)?.zipPath; await window.electronAPI!.openItemInFolder(first || folder); } catch (err) { notifyError('Show backup in Explorer', err); } }}>
              Show in Explorer
            </button>
          )}
        </div>
      )}
    </div>
  );
};
