import React, { useEffect, useRef } from 'react';
import { useDeleteState, answerDeletePrompt, abortDelete, closeDeleteWindow } from '../services/deleteProgress';

const color = { ok: '#22c55e', failed: '#ef4444', deleting: 'var(--text-secondary)' } as const;

export const DeleteProgressModal: React.FC = () => {
  const s = useDeleteState();
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight }); }, [s?.lines]);
  if (!s) return null;
  const failed = s.lines.filter((l) => l.status === 'failed').length;
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(5,8,15,0.88)', zIndex: 5000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div style={{ width: '100%', maxWidth: 640, background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-lg)', padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <h3 style={{ margin: 0 }}>{s.finished ? 'Delete finished' : 'Deleting photos…'} ({s.done}/{s.total}{failed ? `, ${failed} failed` : ''})</h3>
        <div style={{ height: 10, borderRadius: 5, background: 'rgba(255,255,255,0.12)', overflow: 'hidden' }}>
          <div style={{ height: '100%', width: '100%', transform: `scaleX(${s.total ? s.done / s.total : 0})`, transformOrigin: 'left', background: 'var(--accent-primary, #6366f1)', transition: 'transform 0.2s' }} />
        </div>
        {s.current && (
          <div style={{ fontSize: '0.9rem', wordBreak: 'break-all' }}>
            Deleting {s.current.split(/[\\/]/).pop()} {Math.min(s.done + 1, s.total)}/{s.total}
          </div>
        )}
        <div ref={logRef} style={{ height: 220, overflow: 'auto', fontFamily: 'monospace', fontSize: '0.75rem', background: 'rgba(0,0,0,0.25)', borderRadius: 6, padding: 8 }}>
          {s.lines.map((l, i) => (
            <div key={i} style={{ color: color[l.status], wordBreak: 'break-all' }}>
              {l.status === 'ok' ? '✓' : l.status === 'failed' ? '✗' : '…'} {l.path}{l.message ? ` — ${l.message}` : ''}
            </div>
          ))}
        </div>
        {s.prompt && (
          <div style={{ border: '1px solid rgba(239,68,68,0.5)', borderRadius: 6, padding: 12 }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>A photo could not be deleted</div>
            <div style={{ fontSize: '0.85rem', marginBottom: 10 }}>{s.prompt.message}<br />The network drive may be offline or slow. Abort the rest, or continue with the remaining photos?</div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-secondary" onClick={() => answerDeletePrompt(true)}>Abort</button>
              <button className="btn btn-primary" onClick={() => answerDeletePrompt(false)}>Continue</button>
            </div>
          </div>
        )}
        {!s.finished && !s.prompt && (
          <div style={{ textAlign: 'right' }}><button className="btn btn-secondary" onClick={abortDelete}>Abort</button></div>
        )}
        {s.finished && <div style={{ textAlign: 'right' }}><button className="btn btn-primary" onClick={closeDeleteWindow}>Close</button></div>}
      </div>
    </div>
  );
};
