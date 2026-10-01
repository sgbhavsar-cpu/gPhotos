import React, { useEffect, useRef, useState } from 'react';
import { X, Wand2, Image as ImageIcon } from 'lucide-react';
import type { Photo } from '../../../types';
import { SmartFlow, RunFlowResult, FlowRunLogLine, runFlow } from '../services/smartFlowsService';

interface SmartFlowRunModalProps {
  flow: SmartFlow;
  /** The photos this run checks against (already scoped to "whole library" or one album) and how many of them to send this pass. */
  photos: Photo[];
  cap: number;
  /** "Whole library" or an album's name, for the source line. */
  scopeLabel: string;
  onClose: () => void;
  /** Called once the run settles, so the flow list behind this modal can refresh its counts even if the modal stays open. */
  onFinished?: () => void;
}

const LEVEL_COLOR: Record<FlowRunLogLine['level'], string> = { info: '#cbd5e1', warn: '#fbbf24', error: '#f87171' };

/**
 * Opened the moment a Smart Flow's run is confirmed (after the "how many photos" prompt): shows
 * what is running and against what, a progress bar, and a live line-by-line log of what happened to
 * each photo — which of the three passes (shared cache / local Ollama / cloud) it was decided by, or
 * why it wasn't. Closing it does not stop the run (runFlow has no cancel); it keeps going in the
 * background and `onFinished` still fires so the flow list behind it picks up the new counts.
 */
export const SmartFlowRunModal: React.FC<SmartFlowRunModalProps> = ({ flow, photos, cap, scopeLabel, onClose, onFinished }) => {
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [logs, setLogs] = useState<FlowRunLogLine[]>([]);
  const [result, setResult] = useState<RunFlowResult | null>(null);
  const [running, setRunning] = useState(true);
  const logRef = useRef<HTMLDivElement>(null);
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return; // StrictMode/re-render guard — a run must fire exactly once
    startedRef.current = true;
    let live = true;
    runFlow(
      flow, photos, cap,
      (done, total) => { if (live) setProgress({ done, total }); },
      (line) => { if (live) setLogs((prev) => [...prev, line]); }
    ).then((r) => {
      if (!live) return;
      setResult(r);
      setRunning(false);
      onFinished?.();
    });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs exactly once for this modal's lifetime, keyed by the flow it opened with
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <div
      style={{
        position: 'fixed', inset: 0, backgroundColor: 'rgba(0, 0, 0, 0.78)', backdropFilter: 'blur(8px)', zIndex: 1100,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="animate-in"
        style={{
          backgroundColor: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-xl)',
          width: '100%', maxWidth: '640px', maxHeight: '85vh', boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.7)',
          overflow: 'hidden', display: 'flex', flexDirection: 'column',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 22px', borderBottom: '1px solid var(--border-subtle)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
            <Wand2 size={18} color="#c084fc" style={{ flexShrink: 0 }} />
            <div style={{ minWidth: 0 }}>
              <h2 style={{ margin: 0, fontSize: '1rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{flow.name}</h2>
              <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                "{flow.description}" → {flow.action.type === 'album' ? `Album "${flow.action.albumName}"` : 'Move to folder'}
              </div>
            </div>
          </div>
          <button className="btn btn-ghost btn-icon" onClick={onClose} title="Close (the run keeps going in the background)"><X size={18} /></button>
        </div>

        <div style={{ padding: '16px 22px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
            <ImageIcon size={14} />
            <span>Source: <strong style={{ color: 'var(--text-primary)' }}>{scopeLabel}</strong> — checking up to {Math.min(cap, photos.length)} of {photos.length} photo{photos.length === 1 ? '' : 's'}</span>
          </div>

          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.78rem', color: 'var(--text-muted)', marginBottom: '4px' }}>
              <span>{running ? 'Checking...' : result ? 'Finished' : 'Cancelled'}</span>
              <span>{progress.done} / {progress.total || '?'}</span>
            </div>
            <div style={{ height: '8px', borderRadius: '4px', backgroundColor: 'var(--bg-surface-elevated)', overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${pct}%`, backgroundColor: '#c084fc', transition: 'width 0.2s' }} />
            </div>
          </div>

          <div
            ref={logRef}
            data-testid="flow-run-log"
            style={{
              backgroundColor: '#0a0f1d', border: '1px solid rgba(255, 255, 255, 0.08)', borderRadius: 'var(--radius-md)',
              padding: '12px 14px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace', fontSize: '0.76rem',
              lineHeight: 1.7, minHeight: '160px', maxHeight: '320px', overflowY: 'auto',
            }}
          >
            {logs.length === 0 && <div style={{ color: 'var(--text-muted)' }}>Starting...</div>}
            {logs.map((l, i) => (
              <div key={i} style={{ color: LEVEL_COLOR[l.level], wordBreak: 'break-word' }}>
                {l.index > 0 ? `Photo ${l.index} of ${l.total} (${l.fileName}): ` : ''}{l.message}
              </div>
            ))}
          </div>

          {result && (
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px' }}>
              <span style={{ fontSize: '0.82rem', color: 'var(--text-secondary)' }}>
                {result.classified} checked, {result.matched} matched{result.failed ? `, ${result.failed} failed` : ''}
                {result.actionSummary ? ` — ${result.actionSummary}` : ''}
              </span>
              <button className="btn btn-primary" onClick={onClose} style={{ fontSize: '0.82rem', padding: '6px 16px' }}>Close</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
