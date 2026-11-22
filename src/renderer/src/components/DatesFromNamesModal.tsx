import React, { useMemo, useState } from 'react';
import { X, Check, Sparkles } from 'lucide-react';
import { Photo } from '../../../types';
import { parseDateFromFileName } from '../../../types/dateFromFileName';
import { libraryStore } from '../services/libraryStore';
import { notify, notifyError } from '../services/notifications';

interface Props {
  photos: Photo[];
  onClose: () => void;
  /** Called after a successful apply (closes the parent Edit Info modal too). */
  onDone: () => void;
}

const fmt = (d: Date | string | undefined) => {
  if (!d) return '—';
  const x = new Date(d);
  return isNaN(x.getTime()) ? '—' : x.toLocaleString(undefined, { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
};

/**
 * Review list for "Set Date & Time from file names": every selected photo with its current date and the
 * date read from its name. Rows with a parsed date start ticked, rows without start unticked (and can't
 * be ticked); the user can untick any row before applying.
 */
export const DatesFromNamesModal: React.FC<Props> = ({ photos, onClose, onDone }) => {
  const rows = useMemo(
    () => photos.map((p) => {
      const parsed = parseDateFromFileName(p.fileName || p.filePath);
      return { photo: p, name: p.fileName || p.filePath.split(/[\\/]/).pop() || p.id, parsed };
    }),
    [photos],
  );
  const [selected, setSelected] = useState<Set<string>>(() => new Set(rows.filter((r) => r.parsed).map((r) => r.photo.id)));
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsedCount = rows.filter((r) => r.parsed).length;
  const chosen = rows.filter((r) => r.parsed && selected.has(r.photo.id));
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allChecked = parsedCount > 0 && chosen.length === parsedCount;
  const toggleAll = () => setSelected(allChecked ? new Set() : new Set(rows.filter((r) => r.parsed).map((r) => r.photo.id)));

  const apply = async () => {
    if (chosen.length === 0 || isSaving) return;
    setIsSaving(true);
    setError(null);
    try {
      let failures = 0;
      if (window.electronAPI?.writePhotoMetadata) {
        let next = 0;
        const worker = async () => {
          while (next < chosen.length) {
            const r = chosen[next++];
            try {
              const res = await window.electronAPI!.writePhotoMetadata!(r.photo.filePath, { dateIso: r.parsed!.date.toISOString() }, r.photo.originalRemotePath);
              if (res && res.success === false) failures++;
            } catch { failures++; }
          }
        };
        await Promise.all(Array.from({ length: Math.min(8, chosen.length) }, worker));
      }
      libraryStore.updatePhotos(chosen.map((r) => ({ id: r.photo.id, dateTaken: r.parsed!.date.toISOString() })), false);
      notify(failures > 0 ? 'warning' : 'success',
        `Re-dated ${chosen.length} photo${chosen.length === 1 ? '' : 's'} from file names${failures > 0 ? ` (${failures} file write${failures === 1 ? '' : 's'} failed — dates still changed in the app)` : ''}.`);
      onDone();
    } catch (err) {
      setError('Could not apply the dates.');
      notifyError('Set dates from file names', err);
    } finally {
      setIsSaving(false);
    }
  };

  const cell: React.CSSProperties = { padding: '7px 10px', fontSize: '0.8rem', borderBottom: '1px solid var(--border-subtle)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };

  return (
    <div
      style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(5, 8, 15, 0.88)', backdropFilter: 'blur(10px)', zIndex: 3600, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: '100%', maxWidth: '820px', maxHeight: '85vh', display: 'flex', flexDirection: 'column', backgroundColor: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-lg)', boxShadow: '0 24px 64px rgba(0, 0, 0, 0.7)', overflow: 'hidden' }}
      >
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <h3 style={{ fontSize: '1.1rem', fontWeight: 700, margin: 0, color: 'var(--text-primary)' }}>Set date &amp; time from file names</h3>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 2 }}>
              {parsedCount} of {rows.length} file names contain a date. Untick any you want to leave unchanged.
            </div>
          </div>
          <button className="btn btn-ghost btn-icon" onClick={onClose} style={{ width: '32px', height: '32px' }}><X size={18} /></button>
        </div>

        <div style={{ overflow: 'auto', flex: 1 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
            <thead>
              <tr style={{ position: 'sticky', top: 0, background: 'var(--bg-surface)', zIndex: 1 }}>
                <th style={{ ...cell, width: 40, textAlign: 'center' }}>
                  <input type="checkbox" checked={allChecked} onChange={toggleAll} disabled={parsedCount === 0} title="Select / clear all rows with a date" />
                </th>
                <th style={{ ...cell, textAlign: 'left', fontWeight: 700 }}>File name</th>
                <th style={{ ...cell, width: 170, textAlign: 'left', fontWeight: 700 }}>Current date</th>
                <th style={{ ...cell, width: 190, textAlign: 'left', fontWeight: 700 }}>New date (from name)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.photo.id} onClick={() => r.parsed && toggle(r.photo.id)} style={{ cursor: r.parsed ? 'pointer' : 'default', opacity: r.parsed ? 1 : 0.55 }}>
                  <td style={{ ...cell, textAlign: 'center' }}>
                    <input type="checkbox" checked={!!r.parsed && selected.has(r.photo.id)} disabled={!r.parsed} onChange={() => toggle(r.photo.id)} onClick={(e) => e.stopPropagation()} />
                  </td>
                  <td style={cell} title={r.name}>{r.name}</td>
                  <td style={{ ...cell, color: 'var(--text-muted)' }}>{fmt(r.photo.dateTaken)}</td>
                  <td style={{ ...cell, color: r.parsed ? 'var(--accent-emerald)' : 'var(--text-muted)', fontWeight: r.parsed ? 600 : 400 }}>
                    {r.parsed ? `${fmt(r.parsed.date)}${r.parsed.hasTime ? '' : ' (date only)'}` : 'No date in name'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {error && <div style={{ padding: '8px 20px', fontSize: '0.8rem', color: 'var(--accent-rose)', fontWeight: 600 }}>{error}</div>}
        <div style={{ padding: '14px 20px', borderTop: '1px solid var(--border-subtle)', display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
          <button className="btn btn-ghost" onClick={onClose} disabled={isSaving}>Cancel</button>
          <button className="btn btn-primary" onClick={apply} disabled={chosen.length === 0 || isSaving} style={{ gap: '6px' }}>
            {isSaving ? <Sparkles size={15} className="animate-spin" /> : <Check size={15} />}
            <span>{isSaving ? 'Applying...' : `Apply to ${chosen.length} of ${rows.length}`}</span>
          </button>
        </div>
      </div>
    </div>
  );
};
