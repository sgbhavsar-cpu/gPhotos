import React, { useEffect, useState } from 'react';
import { useEscapeLayer } from '../services/escapeStack';

export interface ResetFacesChoice {
  deleteConfirmed: boolean;
  startScanning: boolean;
}

interface ResetFacesDialogProps {
  storageName: string;
  localMirrorRoot?: string;
  /** OneDrive-backed storages default to NOT starting a scan (it downloads the originals again). */
  isOneDrive: boolean;
  onConfirm: (choice: ResetFacesChoice) => void;
  onCancel: () => void;
}

/** Confirmation for deleting a mirror's face recognition, with the numbers it would affect and the two choices. */
export const ResetFacesDialog: React.FC<ResetFacesDialogProps> = ({ storageName, localMirrorRoot, isOneDrive, onConfirm, onCancel }) => {
  const [counts, setCounts] = useState<{ total: number; confirmed: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleteConfirmed, setDeleteConfirmed] = useState(false);
  const [startScanning, setStartScanning] = useState(!isOneDrive);
  useEscapeLayer(true, onCancel);

  useEffect(() => {
    let alive = true;
    window.electronAPI?.previewFaceReset?.({ storageName, localMirrorRoot })
      .then((r) => { if (!alive) return; if (r.success) setCounts({ total: r.total ?? 0, confirmed: r.confirmed ?? 0 }); else setError(r.error || 'Could not read the face data.'); })
      .catch((e) => { if (alive) setError(String(e?.message || e)); });
    return () => { alive = false; };
  }, [storageName, localMirrorRoot]);

  const n = (v: number) => v.toLocaleString();
  const deleting = counts ? (deleteConfirmed ? counts.total : counts.total - counts.confirmed) : 0;
  const keeping = counts ? (deleteConfirmed ? 0 : counts.confirmed) : 0;

  return (
    <div
      data-testid="reset-faces-dialog"
      onClick={onCancel}
      style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(5, 8, 15, 0.85)', backdropFilter: 'blur(8px)', zIndex: 3000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' }}
    >
      <div
        role="dialog"
        aria-label={`Delete face recognition in ${storageName}`}
        onClick={(e) => e.stopPropagation()}
        style={{ width: '100%', maxWidth: '480px', backgroundColor: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-lg)', padding: '22px', display: 'flex', flexDirection: 'column', gap: '14px' }}
      >
        <h3 style={{ margin: 0, fontSize: '1.05rem' }}>Delete face recognition in &ldquo;{storageName}&rdquo;?</h3>

        {error ? (
          <div style={{ fontSize: '0.85rem', color: '#f87171' }}>{error}</div>
        ) : counts === null ? (
          <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>Counting faces…</div>
        ) : (
          <div data-testid="reset-faces-counts" style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <div><strong>{n(deleting)}</strong> detected face{deleting === 1 ? '' : 's'} will be deleted{deleting > 0 ? ' and every photo here marked as not yet scanned' : ''}.</div>
            <div><strong>{n(keeping)}</strong> face{keeping === 1 ? '' : 's'} you confirmed or marked by hand {deleteConfirmed ? 'will be deleted too' : 'will be kept'}.</div>
            <div style={{ color: 'var(--text-muted)' }}>The names in People are never deleted, and your photos are not touched.</div>
          </div>
        )}

        <label style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', fontSize: '0.85rem', cursor: 'pointer' }}>
          <input type="checkbox" data-testid="reset-delete-confirmed" checked={deleteConfirmed} onChange={(e) => setDeleteConfirmed(e.target.checked)} style={{ marginTop: '3px' }} />
          <span>Also delete the faces I confirmed by hand<span style={{ display: 'block', fontSize: '0.78rem', color: 'var(--text-muted)' }}>A full restart for this storage. You will have to confirm those faces again.</span></span>
        </label>
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', fontSize: '0.85rem', cursor: 'pointer' }}>
          <input type="checkbox" data-testid="reset-start-scanning" checked={startScanning} onChange={(e) => setStartScanning(e.target.checked)} style={{ marginTop: '3px' }} />
          <span>Start scanning again when the app is idle
            <span style={{ display: 'block', fontSize: '0.78rem', color: 'var(--text-muted)' }}>
              {isOneDrive ? 'This storage is on OneDrive: scanning downloads the original photos again, so it is off by default. You can press "Scan now" later.' : 'If you leave this off, nothing is scanned until you press "Scan now".'}
            </span>
          </span>
        </label>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
          <button className="btn btn-secondary" onClick={onCancel}>Cancel</button>
          <button className="btn btn-primary" data-testid="reset-faces-confirm" disabled={counts === null || !!error} onClick={() => onConfirm({ deleteConfirmed, startScanning })} style={{ backgroundColor: '#e11d48' }}>
            Delete face recognition
          </button>
        </div>
      </div>
    </div>
  );
};
