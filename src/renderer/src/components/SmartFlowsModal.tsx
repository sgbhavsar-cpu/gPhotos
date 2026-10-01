import React, { useEffect, useState } from 'react';
import { X, Wand2, Trash2, Play, ShieldAlert, Cpu, Settings, Image as ImageIcon } from 'lucide-react';
import type { Album, Photo } from '../../../types';
import { aiSearchService } from '../services/aiSearchService';
import { isVisionAvailable } from '../services/ollamaVisionService';
import { PromptModal } from './PromptModal';
import { SmartFlowRunModal } from './SmartFlowRunModal';
import {
  SmartFlow,
  SmartFlowAction,
  listFlows,
  createFlow,
  deleteFlow,
  setFlowConsent,
} from '../services/smartFlowsService';

interface SmartFlowsModalProps {
  isOpen: boolean;
  onClose: () => void;
  photos: Photo[];
  /** Offered in the "Run against" scope picker, alongside the whole library. */
  albums: Album[];
  /**
   * A gallery/album selection this modal was opened from (the "Run Smart Flow" button on a
   * selection). When present, "Selected photos (N)" is offered in the scope picker and is the
   * default scope — the user can still switch to the whole library or an album instead.
   */
  preselectedPhotos?: Photo[];
  /** Navigates to Settings (and closes this modal) — where the local Ollama model is configured. */
  onOpenSettings?: () => void;
}

const DEFAULT_CAP = 200;
const WHOLE_LIBRARY = 'all';
const SELECTION = 'selection';

export const SmartFlowsModal: React.FC<SmartFlowsModalProps> = ({ isOpen, onClose, photos, albums, preselectedPhotos, onOpenSettings }) => {
  const [flows, setFlows] = useState<SmartFlow[]>(() => listFlows());
  const hasSelection = !!preselectedPhotos && preselectedPhotos.length > 0;
  // Which photos a "Run now" actually checks: the whole library, one album's photos, or (when
  // opened from a selection) just the photos the user had selected — handy for trying a flow's
  // wording on a small, known set before turning it loose on everything.
  const [scopeAlbumId, setScopeAlbumId] = useState<string>(hasSelection ? SELECTION : WHOLE_LIBRARY);
  // The modal instance is long-lived (App.tsx keeps it mounted and toggles `isOpen`), so the
  // scope is re-defaulted each time it's freshly opened rather than carrying over from last time.
  useEffect(() => {
    if (isOpen) setScopeAlbumId(hasSelection ? SELECTION : WHOLE_LIBRARY);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on the isOpen transition, not every render while open
  }, [isOpen]);
  const scopeAlbum = scopeAlbumId === WHOLE_LIBRARY || scopeAlbumId === SELECTION ? null : albums.find((a) => a.id === scopeAlbumId) || null;
  const scopedPhotos = React.useMemo(() => {
    if (scopeAlbumId === SELECTION && preselectedPhotos) {
      const ids = new Set(preselectedPhotos.map((p) => p.id));
      return photos.filter((p) => ids.has(p.id));
    }
    if (!scopeAlbum) return photos;
    const ids = new Set(scopeAlbum.photoIds);
    return photos.filter((p) => ids.has(p.id));
  }, [photos, scopeAlbum, scopeAlbumId, preselectedPhotos]);
  const scopeLabel = scopeAlbumId === SELECTION ? 'Your selection' : scopeAlbum ? `Album "${scopeAlbum.title}"` : 'Whole library';
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [actionType, setActionType] = useState<'album' | 'move'>('album');
  const [albumName, setAlbumName] = useState('');
  const [runModal, setRunModal] = useState<{ flow: SmartFlow; cap: number } | null>(null);
  const [capPromptFlow, setCapPromptFlow] = useState<SmartFlow | null>(null);
  const [ollamaReady, setOllamaReady] = useState<boolean | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    isVisionAvailable().then((ready) => { if (!cancelled) setOllamaReady(ready); });
    return () => { cancelled = true; };
  }, [isOpen]);

  // This modal is mounted once, at app startup, and only ever toggled via `isOpen` — so the `flows`
  // state's own useState initializer runs before the library (and the per-library storage key
  // listFlows() reads from) has actually loaded, permanently freezing it at "no flows". Re-reading on
  // every real open fixes that, for both the sidebar entry point and the "Run Smart Flow" selection button.
  useEffect(() => {
    if (isOpen) setFlows(listFlows());
  }, [isOpen]);

  if (!isOpen) return null;

  // Smart Flows' own cloud fallback — configured separately from the "Search with AI" chat box
  // (Settings → Search with AI → Smart Flows: Cloud Fallback), since the two features' needs are
  // different enough that a shared setting doesn't fit either one well.
  const smartFlowsConfig = aiSearchService.getSmartFlowsConfig();
  const provider = smartFlowsConfig.provider;
  // Informational only — it no longer gates the Run button. A flow can still fully resolve every
  // photo from the shared free cache, or from a local Ollama model, without a cloud key at all;
  // anything that genuinely needs the cloud and doesn't have it just shows a clear error in that
  // photo's own log line instead of the whole flow being unrunnable.
  const providerReady =
    (provider === 'gemini' && !!smartFlowsConfig.geminiApiKey.trim()) ||
    (provider === 'openai' && !!smartFlowsConfig.openaiApiKey.trim());

  const refresh = () => setFlows(listFlows());

  const handleCreate = () => {
    if (!name.trim() || !description.trim()) return;
    if (actionType === 'album' && !albumName.trim()) return;
    const action: SmartFlowAction = actionType === 'album' ? { type: 'album', albumName: albumName.trim() } : { type: 'move' };
    createFlow(name, description, action);
    setName('');
    setDescription('');
    setAlbumName('');
    refresh();
  };

  const handleDelete = (flow: SmartFlow) => {
    if (!window.confirm(`Delete the flow "${flow.name}"? This does not undo anything it already did.`)) return;
    deleteFlow(flow.id);
    refresh();
  };

  const handleConsent = (flow: SmartFlow, checked: boolean) => {
    setFlowConsent(flow.id, checked);
    refresh();
  };

  const handleRun = (flow: SmartFlow) => setCapPromptFlow(flow);

  const startRun = (flow: SmartFlow, cap: number) => {
    setCapPromptFlow(null);
    setRunModal({ flow, cap });
  };

  return (
    <div
      style={{
        position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.78)', backdropFilter: 'blur(8px)', zIndex: 1000,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="animate-in"
        style={{
          backgroundColor: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-xl)',
          width: '100%', maxWidth: '720px', maxHeight: '85vh', boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.7)',
          overflow: 'hidden', display: 'flex', flexDirection: 'column',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '20px 24px', borderBottom: '1px solid var(--border-subtle)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <Wand2 size={20} color="#c084fc" />
            <h2 style={{ margin: 0, fontSize: '1.1rem' }}>Smart Flows</h2>
          </div>
          <button className="btn btn-ghost btn-icon" onClick={onClose}><X size={20} /></button>
        </div>

        <div style={{ padding: '20px 24px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '20px' }}>
          <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--text-muted)' }}>
            Describe a kind of photo in plain words (e.g. "a screenshot of a Facebook or LinkedIn post", "a photo of a UPI payment",
            "a scanned bill", "a visiting card"). Each photo is checked against a shared local cache first (free, instant), then a{' '}
            local Ollama model if one's available (private, free), and only escalates to{' '}
            <strong>{provider === 'local' ? 'a cloud provider — pick Gemini or OpenAI in Smart Flows\' own cloud settings' : provider}</strong>{' '}
            when neither can decide it confidently. Matches are collected into an album or moved to a folder.
          </p>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', fontSize: '0.78rem', color: 'var(--text-muted)' }}>
            <Cpu size={14} color={ollamaReady ? '#10b981' : 'var(--text-muted)'} />
            <span style={{ flex: 1 }}>
              {ollamaReady === null ? 'Checking for a local Ollama vision model...' : ollamaReady ? 'Local Ollama model detected — used as a free first pass.' : 'No local Ollama vision model detected — every check goes straight to the cloud.'}
            </span>
            {(albums.length > 0 || hasSelection) && (
              <>
                <span style={{ color: 'var(--border-subtle)' }}>|</span>
                <ImageIcon size={14} />
                <label style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  Run against:
                  <select
                    className="input"
                    aria-label="Run flows against"
                    value={scopeAlbumId}
                    disabled={!!runModal}
                    onChange={(e) => setScopeAlbumId(e.target.value)}
                    style={{ height: '28px', fontSize: '0.76rem', padding: '0 6px' }}
                  >
                    {hasSelection && <option value={SELECTION}>Selected photos ({preselectedPhotos!.length})</option>}
                    <option value={WHOLE_LIBRARY}>Whole library ({photos.length})</option>
                    {albums.map((a) => (
                      <option key={a.id} value={a.id}>{a.title} ({a.photoIds.length})</option>
                    ))}
                  </select>
                </label>
              </>
            )}
            {onOpenSettings && (
              <button
                className="btn btn-ghost"
                onClick={onOpenSettings}
                title="Configure the local Ollama engine (host, vision model, embedding model) in Settings"
                style={{ fontSize: '0.75rem', padding: '4px 10px', gap: '6px' }}
              >
                <Settings size={12} />
                <span>Configure</span>
              </button>
            )}
          </div>
          {!providerReady && (
            <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', padding: '10px 12px', borderRadius: 'var(--radius-md)', background: 'rgba(245, 158, 11, 0.12)', border: '1px solid rgba(245, 158, 11, 0.35)', fontSize: '0.82rem' }}>
              <ShieldAlert size={16} color="#f59e0b" style={{ flexShrink: 0, marginTop: '2px' }} />
              <span>No Gemini/OpenAI API key is set in Smart Flows' own cloud settings — flows still run using the shared cache and a local Ollama model if one's available, but any photo that genuinely needs the cloud will show an error in its run log instead of being classified.</span>
            </div>
          )}

          {/* New flow form */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', padding: '16px', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border-subtle)' }}>
            <input
              className="input"
              placeholder="Flow name (e.g. Facebook screenshots)"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <textarea
              className="input"
              placeholder='Description to match, e.g. "a screenshot of a Facebook or LinkedIn post on a phone"'
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              style={{ resize: 'vertical' }}
            />
            <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.85rem' }}>
                <input type="radio" checked={actionType === 'album'} onChange={() => setActionType('album')} />
                Add to album
              </label>
              {actionType === 'album' && (
                <input
                  className="input"
                  placeholder="Album name"
                  value={albumName}
                  onChange={(e) => setAlbumName(e.target.value)}
                  style={{ flex: 1, minWidth: '160px' }}
                />
              )}
              <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.85rem' }}>
                <input type="radio" checked={actionType === 'move'} onChange={() => setActionType('move')} />
                Move to folder (choose folder when run)
              </label>
            </div>
            <button
              className="btn btn-primary"
              disabled={!name.trim() || !description.trim() || (actionType === 'album' && !albumName.trim())}
              onClick={handleCreate}
              style={{ alignSelf: 'flex-start' }}
            >
              Create Flow
            </button>
          </div>

          {/* Existing flows */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {flows.length === 0 && <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>No flows yet.</p>}
            {flows.map((flow) => {
              const matchedCount = Object.keys(flow.matches).length;
              const classifiedCount = Object.keys(flow.classifiedIds).length;
              const isRunning = runModal?.flow.id === flow.id;
              return (
                <div key={flow.id} style={{ padding: '14px', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border-subtle)', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px' }}>
                    <div>
                      <div style={{ fontWeight: 600 }}>{flow.name}</div>
                      <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>"{flow.description}"</div>
                      <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: '2px' }}>
                        {flow.action.type === 'album' ? `→ Album "${flow.action.albumName}"` : '→ Move to folder'}
                        {' · '}{classifiedCount} checked, {matchedCount} matched
                      </div>
                    </div>
                    <button className="btn btn-ghost btn-icon" onClick={() => handleDelete(flow)} title="Delete flow">
                      <Trash2 size={16} color="#f43f5e" />
                    </button>
                  </div>

                  {!flow.consented && (
                    <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.8rem' }}>
                      <input type="checkbox" checked={flow.consented} onChange={(e) => handleConsent(flow, e.target.checked)} />
                      I understand each photo checked by this flow is sent to {provider}.
                    </label>
                  )}

                  <button
                    className="btn btn-secondary"
                    disabled={!flow.consented || !!runModal}
                    onClick={() => handleRun(flow)}
                    style={{ alignSelf: 'flex-start', gap: '8px' }}
                  >
                    <Play size={14} />
                    {isRunning ? 'Running...' : 'Run now'}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {capPromptFlow && (
        <PromptModal
          title={`Run "${capPromptFlow.name}"`}
          message={`How many not-yet-checked photos${scopeAlbumId === SELECTION ? ' in your selection' : scopeAlbum ? ` in "${scopeAlbum.title}"` : ''} should this run check? (${scopedPhotos.filter((p) => !capPromptFlow.classifiedIds[p.id]).length} left)`}
          inputType="number"
          initialValue={String(Math.min(DEFAULT_CAP, scopedPhotos.filter((p) => !capPromptFlow.classifiedIds[p.id]).length) || DEFAULT_CAP)}
          confirmLabel="Run"
          onSubmit={(value) => {
            const cap = Math.max(1, parseInt(value, 10) || 0);
            if (cap) startRun(capPromptFlow, cap);
            else setCapPromptFlow(null);
          }}
          onCancel={() => setCapPromptFlow(null)}
        />
      )}

      {runModal && (
        <SmartFlowRunModal
          flow={runModal.flow}
          photos={scopedPhotos}
          cap={runModal.cap}
          scopeLabel={scopeLabel}
          onFinished={refresh}
          onClose={() => { setRunModal(null); refresh(); }}
        />
      )}
    </div>
  );
};
