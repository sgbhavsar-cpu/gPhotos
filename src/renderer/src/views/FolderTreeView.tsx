import React, { useState, useEffect, useRef } from 'react';
import {
  Folder,
  FolderOpen,
  ChevronRight,
  ChevronDown,
  HardDrive,
  RefreshCw,
  Image as ImageIcon,
  Sparkles,
  ArrowRight,
  Play
} from 'lucide-react';
import { Photo, FolderTreeNode, VirtualStorageConfig } from '../../../types';
import { getLocalPhotoUrl, libraryStore } from '../services/libraryStore';
import { useIsMobile } from '../hooks/useIsMobile';
import { notifyError } from '../services/notifications';
import { VirtualCardGrid } from '../components/VirtualCardGrid';

// Fixed card height (160px thumbnail + caption) so the folder grid can be windowed.
const FOLDER_CARD_HEIGHT = 216;

interface FolderTreeViewProps {
  onSelectPhoto: (photo: Photo) => void;
  onStartBackgroundScan?: (path: string, storageName?: string) => void;
  storages?: VirtualStorageConfig[];
  initialFolderPath?: string | null;
  onPhotosDiscovered?: (photos: Photo[]) => void;
  resetTrigger?: number;
}

interface TreeNodeItemProps {
  node: FolderTreeNode;
  selectedPath: string | null;
  onSelectFolder: (path: string) => void;
}

const TreeNodeItem: React.FC<TreeNodeItemProps> = ({ node, selectedPath, onSelectFolder }) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const [children, setChildren] = useState<FolderTreeNode[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const isSelected = selectedPath === node.path;

  const handleToggle = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!isExpanded && node.hasChildren && children.length === 0) {
      setIsLoading(true);
      setLoadError(null);
      try {
        if (window.electronAPI?.readDirectoryTree) {
          const sub = await window.electronAPI.readDirectoryTree(node.path);
          setChildren(sub || []);
        }
      } catch (err) {
        // Offline share / permission denied: show it on the node instead of spinning forever.
        setLoadError('Could not read this folder');
        notifyError(`Open folder "${node.name}"`, err);
      } finally {
        setIsLoading(false);
      }
    }
    setIsExpanded(!isExpanded);
  };

  const handleRowClick = () => {
    onSelectFolder(node.path);
    if (!isExpanded && node.hasChildren) {
      handleToggle({ stopPropagation: () => {} } as any);
    }
  };

  return (
    <div>
      <div
        onClick={handleRowClick}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          padding: '6px 10px',
          borderRadius: 'var(--radius-sm)',
          backgroundColor: isSelected ? 'rgba(59, 130, 246, 0.15)' : 'transparent',
          color: isSelected ? 'var(--accent-primary)' : 'var(--text-primary)',
          cursor: 'pointer',
          userSelect: 'none',
          fontSize: '0.86rem',
        }}
      >
        <span
          onClick={handleToggle}
          style={{ width: '18px', height: '18px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
        >
          {node.hasChildren ? (
            isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />
          ) : (
            <span style={{ width: '14px' }} />
          )}
        </span>

        {isExpanded ? (
          <FolderOpen size={16} color="var(--accent-primary)" />
        ) : (
          <Folder size={16} color="var(--accent-amber)" />
        )}

        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {node.name}
        </span>

        {typeof node.photoCount === 'number' && node.photoCount > 0 && (
          <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
            {node.photoCount}
          </span>
        )}
      </div>

      {isExpanded && (
        <div style={{ paddingLeft: '16px', borderLeft: '1px solid var(--border-subtle)', marginLeft: '14px' }}>
          {isLoading && (
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', padding: '4px 8px' }}>
              Loading subfolders...
            </div>
          )}
          {loadError && (
            <div style={{ fontSize: '0.75rem', color: 'var(--accent-rose)', padding: '4px 8px' }}>{loadError}</div>
          )}
          {children.map((child) => (
            <TreeNodeItem
              key={child.path}
              node={child}
              selectedPath={selectedPath}
              onSelectFolder={onSelectFolder}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export const FolderTreeView: React.FC<FolderTreeViewProps> = ({
  onSelectPhoto,
  onStartBackgroundScan,
  storages = [],
  initialFolderPath = null,
  onPhotosDiscovered,
  resetTrigger,
}) => {
  const [rootNodes, setRootNodes] = useState<FolderTreeNode[]>([]);
  const [selectedFolderPath, setSelectedFolderPath] = useState<string | null>(initialFolderPath);
  useEffect(() => {
    if (resetTrigger) setSelectedFolderPath(null);
  }, [resetTrigger]);
  const isMobile = useIsMobile();
  const [folderPhotos, setFolderPhotos] = useState<Photo[]>([]);
  const [isLoadingPhotos, setIsLoadingPhotos] = useState(false);
  const [folderError, setFolderError] = useState<string | null>(null);
  // Only the most recent folder click may write results (slow shares answer out of order).
  const selectRequestRef = useRef(0);
  const [customPathInput, setCustomPathInput] = useState('');
  const gridScrollRef = useRef<HTMLDivElement>(null);

  // When initialFolderPath changes from external view navigation
  useEffect(() => {
    if (initialFolderPath) {
      setSelectedFolderPath(initialFolderPath);
      handleSelectFolder(initialFolderPath);
    }
  }, [initialFolderPath]);

  // Handle Escape key to clear selected folder drilldown
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (selectedFolderPath) {
          e.stopImmediatePropagation();
          setSelectedFolderPath(null);
          setFolderPhotos([]);
        }
      }
    };
    // capture: true — see PeopleView's matching Escape handler for why.
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, [selectedFolderPath]);

  // Initial roots: Local drives and virtual storage mirror roots
  useEffect(() => {
    let cancelled = false;
    loadRoots(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [storages]);

  const loadRoots = async (isCancelled: () => boolean = () => false) => {
    const candidates = [
      'C:\\GPhotos_VirtualMirrors',
      'D:\\',
      'E:\\',
      'C:\\',
      ...(storages || []).map((s) => s.networkSourcePath),
    ].filter(Boolean);

    // Checked in parallel so one unreachable NAS path can't hold up (or break) the whole list.
    const checks = await Promise.all(
      candidates.map(async (c) => {
        if (!window.electronAPI?.checkFileExists) return true;
        try {
          return !!(await window.electronAPI.checkFileExists(c));
        } catch {
          return false;
        }
      })
    );
    if (isCancelled()) return;
    const validRoots: FolderTreeNode[] = candidates
      .filter((_, i) => checks[i])
      .map((c) => ({ name: c, path: c, hasChildren: true }));
    setRootNodes(validRoots);
    if (validRoots.length > 0 && !selectedFolderPath && !initialFolderPath) {
      handleSelectFolder(validRoots[0].path);
    }
  };

  const handleSelectFolder = async (folderPath: string) => {
    const requestId = ++selectRequestRef.current;
    setSelectedFolderPath(folderPath);
    setIsLoadingPhotos(true);
    setFolderError(null);

    try {
      if (window.electronAPI?.readFolderPhotos) {
        const photos = (await window.electronAPI.readFolderPhotos(folderPath)) || [];
        if (requestId !== selectRequestRef.current) return;
        setFolderPhotos(photos);
        if (onPhotosDiscovered && photos.length > 0) {
          onPhotosDiscovered(photos);
        }
      } else {
        // Fallback in web / node environment
        const matching = libraryStore.getState().photos.filter((p) =>
          p.filePath.startsWith(folderPath) || (p.originalRemotePath && p.originalRemotePath.startsWith(folderPath))
        );
        setFolderPhotos(matching);
      }
    } catch (err) {
      if (requestId !== selectRequestRef.current) return;
      setFolderPhotos([]);
      setFolderError('This folder could not be read — the drive or network share may be offline, or access was denied.');
      notifyError('Read folder', err);
    } finally {
      if (requestId === selectRequestRef.current) setIsLoadingPhotos(false);
    }
  };

  const handleAddCustomPath = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = customPathInput.trim();
    if (!clean) return;

    setRootNodes((prev) => [
      ...prev.filter((n) => n.path !== clean),
      { name: clean, path: clean, hasChildren: true },
    ]);
    handleSelectFolder(clean);
    setCustomPathInput('');
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: isMobile ? 'column' : 'row', overflow: 'hidden' }}>
      {/* Left Sidebar: Folder Tree — a fixed 320px side-by-side pane doesn't
          fit a 375-600px phone screen at all, so on mobile this becomes a
          collapsed-height panel stacked above the photo list instead. */}
      <aside
        style={{
          width: isMobile ? '100%' : '320px',
          maxHeight: isMobile ? '38vh' : undefined,
          borderRight: isMobile ? 'none' : '1px solid var(--border-subtle)',
          borderBottom: isMobile ? '1px solid var(--border-subtle)' : 'none',
          backgroundColor: 'var(--bg-surface)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          flexShrink: 0,
        }}
      >
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border-subtle)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
            <HardDrive size={18} color="var(--accent-primary)" />
            <h2 style={{ fontSize: '1rem', fontWeight: 700, margin: 0 }}>Folder Tree Explorer</h2>
          </div>

          <form onSubmit={handleAddCustomPath} style={{ display: 'flex', gap: '6px' }}>
            <input
              type="text"
              value={customPathInput}
              onChange={(e) => setCustomPathInput(e.target.value)}
              placeholder="e.g. D:\Photos or \\NAS\Share"
              className="input"
              style={{ fontSize: '0.8rem', padding: '6px 10px' }}
            />
            <button type="submit" className="btn btn-primary" style={{ padding: '6px 12px', fontSize: '0.8rem' }}>
              Add
            </button>
          </form>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px' }}>
          {rootNodes.length === 0 ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '16px 8px', color: 'var(--text-muted)', fontSize: '0.82rem' }}>
              <RefreshCw className="animate-spin" size={14} />
              <span>Loading folder structure...</span>
            </div>
          ) : (
            rootNodes.map((root) => (
              <TreeNodeItem
                key={root.path}
                node={root}
                selectedPath={selectedFolderPath}
                onSelectFolder={handleSelectFolder}
              />
            ))
          )}
        </div>
      </aside>

      {/* Right Area: Direct Photos in Selected Folder */}
      <main style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Header */}
        <div
          style={{
            padding: isMobile ? '10px 12px' : '16px 24px',
            borderBottom: '1px solid var(--border-subtle)',
            backgroundColor: 'var(--bg-surface)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: '8px',
          }}
        >
          <div style={{ minWidth: 0, flex: '1 1 auto' }}>
            <h3 style={{
              fontSize: isMobile ? '0.9rem' : '1.1rem',
              fontWeight: 700,
              margin: 0,
              color: 'var(--text-primary)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}>
              {selectedFolderPath ? selectedFolderPath : 'Select a Folder'}
            </h3>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
              {isLoadingPhotos ? 'Scanning folder...' : `${folderPhotos.length} photos in this folder`}
            </span>
          </div>

          {selectedFolderPath && (
            <button
              className="btn btn-primary"
              onClick={() => {
                onStartBackgroundScan?.(selectedFolderPath);
              }}
              style={{ fontSize: '0.82rem', gap: '6px', flexShrink: 0 }}
              title="Start non-blocking background index & thumbnail mirroring for this entire directory"
            >
              <Play size={14} />
              <span>Scan in Background</span>
            </button>
          )}
        </div>

        {/* Photos Grid */}
        <div ref={gridScrollRef} style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '24px' }}>
          {isLoadingPhotos ? (
            <div style={{ textAlign: 'center', padding: '60px', color: 'var(--text-muted)' }}>
              <RefreshCw className="animate-spin" size={28} style={{ margin: '0 auto 12px' }} />
              <p>Reading direct image files on network storage...</p>
            </div>
          ) : (!selectedFolderPath && rootNodes.length === 0) ? (
            <div style={{ textAlign: 'center', padding: '60px', color: 'var(--text-muted)' }}>
              <RefreshCw className="animate-spin" size={28} style={{ margin: '0 auto 12px' }} />
              <p>Loading folder structure...</p>
            </div>
          ) : folderError ? (
            <div style={{ textAlign: 'center', padding: '60px', color: 'var(--accent-rose)' }}>
              <p>{folderError}</p>
            </div>
          ) : folderPhotos.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '60px', color: 'var(--text-muted)' }}>
              <ImageIcon size={48} style={{ margin: '0 auto 12px', opacity: 0.4 }} />
              <p>No photos found directly in this folder level.</p>
              <span style={{ fontSize: '0.8rem' }}>Expand subfolders in the tree on the left to browse nested files.</span>
            </div>
          ) : (
            <VirtualCardGrid
              items={folderPhotos}
              getKey={(photo) => photo.id}
              scrollRef={gridScrollRef}
              rowHeight={FOLDER_CARD_HEIGHT}
              minColWidth={200}
              gap={16}
              renderItem={(photo) => (
                <div
                  onClick={() => onSelectPhoto(photo)}
                  style={{
                    height: '100%',
                    boxSizing: 'border-box',
                    backgroundColor: 'var(--bg-surface)',
                    borderRadius: 'var(--radius-md)',
                    overflow: 'hidden',
                    border: '1px solid var(--border-subtle)',
                    cursor: 'pointer',
                    boxShadow: 'var(--shadow-sm)',
                    transition: 'all var(--transition-fast)',
                  }}
                >
                  <div style={{ height: '160px', backgroundColor: '#0f172a', position: 'relative' }}>
                    <img
                      src={getLocalPhotoUrl(photo.filePath, photo.originalRemotePath)}
                      alt={photo.fileName}
                      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                      loading="lazy"
                    />
                  </div>
                  <div style={{ padding: '8px 10px' }}>
                    <div
                      style={{
                        fontSize: '0.8rem',
                        fontWeight: 600,
                        color: 'var(--text-primary)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {photo.fileName}
                    </div>
                    <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '2px' }}>
                      {(photo.fileSize / (1024 * 1024)).toFixed(1)} MB • {photo.dateTaken ? new Date(photo.dateTaken).toLocaleDateString() : ''}
                    </div>
                  </div>
                </div>
              )}
            />
          )}
        </div>
      </main>
    </div>
  );
};
