import React, { useEffect, useState } from 'react';
import { Folder, ArrowUp, X, Check, HardDrive, AlertCircle, RotateCw } from 'lucide-react';
import { subscribeFolderBrowser, resolveFolderBrowser, FolderBrowserRequest } from '../services/folderBrowserController';
import { notifyError } from '../services/notifications';
import { isPathInsideRoot, isValidFolderName, joinChildPath } from '../services/pathUtils';

interface DirEntry {
  name: string;
  path: string;
}

interface BrowseResult {
  path: string | null;
  parent: string | null;
  entries: DirEntry[];
  error?: string;
}

interface FolderBrowserModalProps {
  title?: string;
  initialPath?: string;
  /** Only this folder and the folders below it can be browsed to and chosen. */
  restrictToRoot?: string;
  confirmLabel?: string;
  hint?: string;
  allowNewFolder?: boolean;
  onSelect: (path: string) => void;
  onCancel: () => void;
}

/**
 * A folder-picker dialog backed by window.electronAPI.browseDirectory —
 * lets the user navigate the host's actual folder structure and pick one,
 * instead of typing an absolute path from memory into a text prompt. Works
 * the same way on Electron (native filesystem access) and the mobile/LAN
 * web client (browseDirectory hits /api/browse-directory on the server).
 */
export const FolderBrowserModal: React.FC<FolderBrowserModalProps> = ({
  title = 'Select a Folder',
  initialPath,
  restrictToRoot,
  confirmLabel = 'Select This Folder',
  hint,
  allowNewFolder = false,
  onSelect,
  onCancel,
}) => {
  const [result, setResult] = useState<BrowseResult | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [pathInput, setPathInput] = useState(initialPath || restrictToRoot || '');
  const [newFolderName, setNewFolderName] = useState('');

  const load = async (targetPath?: string) => {
    setIsLoading(true);
    try {
      // In a restricted browser a typed/pasted path (or "drive list") outside the root is not followed.
      if (restrictToRoot && !isPathInsideRoot(targetPath, restrictToRoot)) {
        if (targetPath) notifyError('Open folder', new Error(`Only folders inside "${restrictToRoot}" can be chosen here.`));
        targetPath = restrictToRoot;
      }
      const res = await window.electronAPI?.browseDirectory?.(targetPath);
      if (res) {
        setResult(res);
        setPathInput(res.path || '');
      }
    } catch (err) {
      notifyError('Open folder', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    load(initialPath || restrictToRoot);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        onCancel();
      }
    };
    // capture: true — see PeopleView's matching Escape handler for why.
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, [onCancel]);

  const currentPath = result?.path ?? null;
  const isAtDriveList = currentPath === null;
  const atRestrictedRoot = !!restrictToRoot && !!currentPath && !isPathInsideRoot(result?.parent, restrictToRoot);
  const canChooseHere = !!currentPath && (!restrictToRoot || isPathInsideRoot(currentPath, restrictToRoot));
  const newName = newFolderName.trim();
  const newNameInvalid = allowNewFolder && newName !== '' && !isValidFolderName(newName);
  const chosenPath = currentPath && allowNewFolder && newName && !newNameInvalid ? joinChildPath(currentPath, newName) : currentPath;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(5, 8, 15, 0.88)',
        backdropFilter: 'blur(10px)',
        zIndex: 4000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '16px',
      }}
      onClick={onCancel}
    >
      <div
        style={{
          width: '100%',
          maxWidth: '560px',
          height: '70vh',
          maxHeight: '620px',
          backgroundColor: 'var(--bg-surface)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: '0 24px 64px rgba(0, 0, 0, 0.7)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            padding: '16px 20px',
            borderBottom: '1px solid var(--border-subtle)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '12px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
            <Folder size={20} color="var(--accent-primary)" />
            <h3 style={{ fontSize: '1.05rem', fontWeight: 700, margin: 0, color: 'var(--text-primary)' }}>
              {title}
            </h3>
          </div>
          <button className="btn btn-ghost btn-icon" onClick={onCancel} style={{ width: '32px', height: '32px', flexShrink: 0 }}>
            <X size={18} />
          </button>
        </div>

        {(hint || restrictToRoot) && (
          <div style={{ padding: '8px 20px', fontSize: '0.78rem', color: 'var(--text-secondary)', backgroundColor: 'var(--bg-surface-elevated)', borderBottom: '1px solid var(--border-subtle)' }}>
            {hint || `Only folders inside ${restrictToRoot} can be chosen.`}
          </div>
        )}

        {/* Path bar: editable text + Go, plus Up */}
        <div style={{ padding: '12px 20px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', gap: '8px' }}>
          <button
            className="btn btn-secondary btn-icon"
            onClick={() => load(result?.parent === null ? undefined : result?.parent)}
            disabled={isAtDriveList || isLoading || atRestrictedRoot}
            title="Go up one level"
            style={{ width: '36px', height: '36px', flexShrink: 0 }}
          >
            <ArrowUp size={16} />
          </button>
          <input
            type="text"
            className="input"
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') load(pathInput);
            }}
            placeholder="Type or paste a path, or browse below..."
            style={{ flex: 1, height: '36px', fontSize: '0.85rem' }}
          />
          <button
            className="btn btn-secondary"
            onClick={() => load(pathInput)}
            style={{ height: '36px', padding: '0 14px', fontSize: '0.82rem', flexShrink: 0 }}
          >
            Go
          </button>
        </div>

        {/* Entries list */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 12px' }}>
          {isLoading ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-muted)', gap: '10px' }}>
              <RotateCw size={18} className="animate-spin" />
              <span>Loading...</span>
            </div>
          ) : result?.error ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--accent-rose)', gap: '10px', padding: '20px', textAlign: 'center' }}>
              <AlertCircle size={28} />
              <span style={{ fontSize: '0.88rem' }}>{result.error}</span>
            </div>
          ) : result && result.entries.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--text-muted)', fontSize: '0.88rem' }}>
              No subfolders here.
            </div>
          ) : (
            result?.entries.map((entry) => (
              <button
                key={entry.path}
                onClick={() => load(entry.path)}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                  padding: '10px 12px',
                  borderRadius: 'var(--radius-md)',
                  backgroundColor: 'transparent',
                  border: 'none',
                  color: 'var(--text-primary)',
                  cursor: 'pointer',
                  textAlign: 'left',
                  fontSize: '0.88rem',
                  marginBottom: '2px',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--bg-surface-elevated)')}
                onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
              >
                {isAtDriveList ? <HardDrive size={16} color="var(--accent-cyan)" /> : <Folder size={16} color="var(--accent-primary)" />}
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.name}</span>
              </button>
            ))
          )}
        </div>

        {allowNewFolder && (
          <div style={{ padding: '10px 20px', borderTop: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', gap: '10px' }}>
            <Folder size={16} color="var(--text-muted)" />
            <input
              type="text"
              className="input"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              placeholder="Optional: name of a NEW folder to create here"
              data-testid="new-folder-name"
              style={{ flex: 1, height: '34px', fontSize: '0.85rem', borderColor: newNameInvalid ? 'var(--accent-rose)' : undefined }}
            />
            {newNameInvalid && <span style={{ fontSize: '0.75rem', color: 'var(--accent-rose)' }}>Not a valid folder name</span>}
          </div>
        )}

        {/* Footer */}
        <div style={{ padding: '14px 20px', borderTop: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
          <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
            {chosenPath || 'Select a drive'}
          </span>
          <div style={{ display: 'flex', gap: '10px', flexShrink: 0 }}>
            <button className="btn btn-ghost" onClick={onCancel} style={{ height: '38px', padding: '0 16px' }}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              onClick={() => chosenPath && canChooseHere && !newNameInvalid && onSelect(chosenPath)}
              disabled={!canChooseHere || newNameInvalid}
              style={{ height: '38px', padding: '0 20px', gap: '8px' }}
            >
              <Check size={16} />
              <span>{confirmLabel}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

/**
 * Mounted once at the app root. Renders FolderBrowserModal whenever
 * selectDirectoryOrPrompt() (called from anywhere) makes a request via
 * folderBrowserController, and resolves that request's promise when the
 * user picks a folder or cancels — so callers just `await
 * selectDirectoryOrPrompt(...)` without knowing or caring that a shared
 * modal instance is involved.
 */
export const FolderBrowserModalHost: React.FC = () => {
  const [request, setRequest] = useState<FolderBrowserRequest | null>(null);

  useEffect(() => subscribeFolderBrowser(setRequest), []);

  if (!request) return null;

  return (
    <FolderBrowserModal
      title={request.title}
      initialPath={request.initialPath}
      restrictToRoot={request.restrictToRoot}
      confirmLabel={request.confirmLabel}
      hint={request.hint}
      allowNewFolder={request.allowNewFolder}
      onSelect={(path) => resolveFolderBrowser(path)}
      onCancel={() => resolveFolderBrowser(null)}
    />
  );
};
