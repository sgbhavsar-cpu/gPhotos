import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Folder,
  RefreshCw,
  Image as ImageIcon,
  ArrowRight,
  ArrowLeft,
  ChevronsRight,
  ChevronsLeft,
  ArrowUp,
  CheckSquare,
  Square,
  Clock,
  Save,
  BookImage,
  HardDrive,
  Search,
  Trash2,
  Edit2,
  Edit3,
  ExternalLink,
  FolderOpen,
  Copy,
} from 'lucide-react';
import { Photo, FolderTreeNode, VirtualStorageConfig, RelocationPhotoInput, RelocationItemResult, Album } from '../../../types';
import { getLocalPhotoUrl, libraryStore } from '../services/libraryStore';
import { useIsMobile } from '../hooks/useIsMobile';
import { notify, notifyError } from '../services/notifications';
import { summariseReasons } from '../services/photoRelocationFlow';
import { getExternalEditorPath } from '../services/externalEditorConfig';
import { VirtualCardGrid } from '../components/VirtualCardGrid';

type CardSize = 'xs' | 's' | 'm' | 'l';
const SIZE_MAP: Record<CardSize, { rowHeight: number; minColWidth: number }> = {
  xs: { rowHeight: 120, minColWidth: 90 },
  s: { rowHeight: 160, minColWidth: 120 },
  m: { rowHeight: 196, minColWidth: 150 },
  l: { rowHeight: 260, minColWidth: 200 },
};

/** Lexical parent folder of a path, Windows + POSIX separators. '' once there's no more to strip. */
function parentDir(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '');
  const cut = trimmed.replace(/[\\/][^\\/]*$/, '');
  return cut === trimmed ? '' : cut;
}

/** Where a photo actually, physically lives right now — not which pane/album happens to list it. */
function photoDir(p: Photo): string {
  const src = p.isVirtual ? p.originalRemotePath || p.filePath : p.filePath;
  return parentDir(src) || src;
}

/** The real on-disk path a context-menu action should act on (the original, not a mirror thumbnail). */
function realPath(p: Photo): string {
  return p.originalRemotePath || p.filePath;
}

const toInput = (p: Photo): RelocationPhotoInput => ({
  id: p.id,
  filePath: p.filePath,
  fileName: p.fileName,
  originalRemotePath: p.originalRemotePath,
  isVirtual: p.isVirtual,
  storageName: p.storageName,
});

interface PendingMove {
  photo: Photo;
  homeDir: string;
  targetDir: string;
  queued?: boolean;
}

type PaneMode = 'folder' | 'album';

interface PaneState {
  mode: PaneMode;
  path: string;
  albumId: string | null;
  photos: Photo[];
  subfolders: FolderTreeNode[];
  loading: boolean;
  error: string | null;
  selected: Set<string>;
  search: string;
}

const emptyPane = (path: string): PaneState => ({
  mode: 'folder', path, albumId: null, photos: [], subfolders: [], loading: false, error: null, selected: new Set(), search: '',
});

interface ContextMenuState {
  x: number;
  y: number;
  which: 'left' | 'right';
  photo: Photo;
}

interface ExplorerViewProps {
  onSelectPhoto: (photo: Photo) => void;
  onEditPhoto: (photo: Photo) => void;
  storages?: VirtualStorageConfig[];
  albums?: Album[];
  photos?: Photo[];
  initialPath?: string | null;
  resetTrigger?: number;
}

export const ExplorerView: React.FC<ExplorerViewProps> = ({ onSelectPhoto, onEditPhoto, storages = [], albums = [], photos = [], initialPath = null, resetTrigger }) => {
  const isMobile = useIsMobile();
  const [left, setLeft] = useState<PaneState>(emptyPane(initialPath || ''));
  const [right, setRight] = useState<PaneState>(emptyPane(initialPath || ''));
  const [pending, setPending] = useState<PendingMove[]>([]);
  const [isCommitting, setIsCommitting] = useState(false);
  const [queuedCount, setQueuedCount] = useState(0);
  const [cardSize, setCardSize] = useState<CardSize>('m');
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const loadSeq = useRef(0);
  const libraryRoot = libraryStore.getState().selectedFolder || libraryStore.getState().currentDirectory || '';

  const loadPane = useCallback(async (folderPath: string, set: React.Dispatch<React.SetStateAction<PaneState>>) => {
    if (!folderPath) return;
    const seq = ++loadSeq.current;
    set((s) => ({ ...s, mode: 'folder', albumId: null, path: folderPath, loading: true, error: null, selected: new Set() }));
    const api = window.electronAPI;
    try {
      const [photos, children] = await Promise.all([
        api?.readFolderPhotos ? api.readFolderPhotos(folderPath) : Promise.resolve([]),
        api?.readDirectoryTree ? api.readDirectoryTree(folderPath) : Promise.resolve([]),
      ]);
      if (seq !== loadSeq.current) return;
      set((s) => (s.mode === 'folder' && s.path === folderPath ? { ...s, photos: photos || [], subfolders: children || [], loading: false } : s));
    } catch (err) {
      if (seq !== loadSeq.current) return;
      set((s) => (s.mode === 'folder' && s.path === folderPath ? { ...s, photos: [], subfolders: [], loading: false, error: 'This folder could not be read — the drive or share may be offline, or access was denied.' } : s));
      notifyError('Read folder', err);
    }
  }, []);

  const loadAlbum = useCallback((which: 'left' | 'right', albumId: string) => {
    const set = which === 'left' ? setLeft : setRight;
    const album = albums.find((a) => a.id === albumId);
    const idSet = new Set(album?.photoIds || []);
    set((s) => ({ ...s, mode: 'album', albumId: albumId || null, photos: photos.filter((p) => idSet.has(p.id)), subfolders: [], loading: false, error: null, selected: new Set() }));
  }, [albums, photos]);

  const switchMode = (which: 'left' | 'right', mode: PaneMode) => {
    const pane = which === 'left' ? left : right;
    if (mode === pane.mode) return;
    if (mode === 'folder') {
      loadPane(pane.path || libraryRoot, which === 'left' ? setLeft : setRight);
    } else {
      (which === 'left' ? setLeft : setRight)((s) => ({ ...s, mode: 'album', albumId: null, photos: [], subfolders: [], loading: false, error: null, selected: new Set() }));
    }
  };

  // Default both panes to the active library root so there's something to see immediately.
  useEffect(() => {
    const root = initialPath || libraryStore.getState().selectedFolder || libraryStore.getState().currentDirectory || null;
    if (root) {
      loadPane(root, setLeft);
      loadPane(root, setRight);
    }
  }, [initialPath, loadPane]);

  useEffect(() => {
    if (resetTrigger) setPending([]);
  }, [resetTrigger]);

  const refreshQueuedCount = useCallback(async () => {
    try {
      const n = await window.electronAPI?.getPendingMovesCount?.();
      if (typeof n === 'number') setQueuedCount(n);
    } catch {}
  }, []);

  useEffect(() => {
    refreshQueuedCount();
    const t = setInterval(refreshQueuedCount, 30000);
    return () => clearInterval(t);
  }, [refreshQueuedCount]);

  // A commit that was queued (storage offline) finishes later in the main process, not in response
  // to anything this view calls — this is how it learns the virtual move can finally be dropped.
  useEffect(() => {
    const unsubscribe = window.electronAPI?.onPendingMoveApplied?.((info) => {
      const movedIds = new Set(info.results.filter((r) => r.status === 'moved').map((r) => r.oldId));
      if (movedIds.size === 0) return;
      applyMovedResults(info.results);
      setPending((prev) => prev.filter((m) => !movedIds.has(m.photo.id)));
      notify('success', `${movedIds.size} queued photo${movedIds.size === 1 ? '' : 's'} moved to "${info.targetDir}" now that storage is back online.`);
      loadPane(left.path, setLeft);
      loadPane(right.path, setRight);
      refreshQueuedCount();
    });
    return () => { try { unsubscribe?.(); } catch {} };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- left.path/right.path read fresh via refs would overcomplicate this; re-subscribing on path change is cheap and correct.
  }, [left.path, right.path]);

  // Context menu: any click elsewhere, or Escape, closes it. Only registered while one is open.
  useEffect(() => {
    if (!contextMenu) return;
    const handleClick = () => setContextMenu(null);
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setContextMenu(null); };
    window.addEventListener('click', handleClick);
    window.addEventListener('keydown', handleKey);
    return () => {
      window.removeEventListener('click', handleClick);
      window.removeEventListener('keydown', handleKey);
    };
  }, [contextMenu]);

  const applyMovedResults = (results: RelocationItemResult[]) => {
    const moved = results.filter((r) => r.status === 'moved' && r.newId && r.newFilePath);
    if (moved.length === 0) return;
    libraryStore.applyPhotoRelocations(
      moved.map((r) => ({ oldId: r.oldId, newId: r.newId!, newFilePath: r.newFilePath!, newOriginalRemotePath: r.newOriginalRemotePath, newFileName: r.newFileName }))
    );
    libraryStore.flushSaveImmediately();
  };

  /**
   * What a pane actually shows. A folder pane is physical: its own folder's files, minus anything
   * staged out, plus anything staged in from the other pane. An album pane is logical: staging a
   * move out of it doesn't remove the photo from the album (or from view) — only Commit touches
   * disk — and nothing can be staged INTO an album pane this way (that's membership, not location).
   * The search box filters whatever that produces, by filename.
   */
  const visiblePhotos = (pane: PaneState, otherPath: string): Photo[] => {
    let list: Photo[];
    if (pane.mode === 'album') {
      list = pane.photos;
    } else {
      const movedOutIds = new Set(pending.filter((m) => m.homeDir === pane.path && m.targetDir !== pane.path).map((m) => m.photo.id));
      const movedIn = pending.filter((m) => m.targetDir === pane.path && m.homeDir !== pane.path).map((m) => m.photo);
      list = pane.photos.filter((p) => !movedOutIds.has(p.id)).concat(movedIn);
    }
    const q = pane.search.trim().toLowerCase();
    return q ? list.filter((p) => p.fileName.toLowerCase().includes(q)) : list;
  };

  /** The search box also filters the subfolder list box, by folder name. */
  const visibleSubfolders = (pane: PaneState): FolderTreeNode[] => {
    const q = pane.search.trim().toLowerCase();
    return q ? pane.subfolders.filter((f) => f.name.toLowerCase().includes(q)) : pane.subfolders;
  };

  const isStaged = (photoId: string): PendingMove | undefined => pending.find((m) => m.photo.id === photoId);

  /** Stage (or un-stage, if it cancels an existing move back to where it physically lives) a move. */
  const stageMove = (photosToMove: Photo[], toDir: string) => {
    if (photosToMove.length === 0 || !toDir) return;
    setPending((prev) => {
      const next = [...prev];
      for (const photo of photosToMove) {
        const idx = next.findIndex((m) => m.photo.id === photo.id);
        const homeDir = idx !== -1 ? next[idx].homeDir : photoDir(photo);
        if (homeDir === toDir) {
          if (idx !== -1) next.splice(idx, 1); // moving it right back to where it already lives cancels the stage
          continue; // already there — nothing to stage
        }
        const entry: PendingMove = { photo, homeDir, targetDir: toDir };
        if (idx !== -1) next[idx] = entry;
        else next.push(entry);
      }
      return next;
    });
  };

  const toggleSelect = (pane: 'left' | 'right', id: string) => {
    const set = pane === 'left' ? setLeft : setRight;
    set((s) => {
      const selected = new Set(s.selected);
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
      return { ...s, selected };
    });
  };

  const moveSelected = (from: 'left' | 'right') => {
    const src = from === 'left' ? left : right;
    const dst = from === 'left' ? right : left;
    if (dst.mode === 'album' || !dst.path) return; // an album isn't a physical destination
    const visible = visiblePhotos(src, dst.path);
    const selected = visible.filter((p) => src.selected.has(p.id));
    stageMove(selected, dst.path);
    (from === 'left' ? setLeft : setRight)((s) => ({ ...s, selected: new Set() }));
  };

  const moveAll = (from: 'left' | 'right') => {
    const src = from === 'left' ? left : right;
    const dst = from === 'left' ? right : left;
    if (dst.mode === 'album' || !dst.path) return;
    stageMove(visiblePhotos(src, dst.path), dst.path);
  };

  const unstage = (photoId: string) => setPending((prev) => prev.filter((m) => m.photo.id !== photoId));

  const browse = async (which: 'left' | 'right') => {
    const api = window.electronAPI;
    if (!api?.selectDirectory) return;
    const picked = await api.selectDirectory();
    if (picked) loadPane(picked, which === 'left' ? setLeft : setRight);
  };

  const goUp = (which: 'left' | 'right') => {
    const pane = which === 'left' ? left : right;
    const up = parentDir(pane.path);
    if (up) loadPane(up, which === 'left' ? setLeft : setRight);
  };

  const commit = async () => {
    const api = window.electronAPI;
    if (!api?.commitRelocation) {
      notify('error', 'Committing moves is only available in the desktop app.');
      return;
    }
    const groups = new Map<string, PendingMove[]>();
    for (const m of pending) {
      if (m.queued) continue; // already committed and waiting on the offline queue
      const key = `${m.homeDir}=>${m.targetDir}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(m);
    }
    if (groups.size === 0) {
      notify('info', 'Nothing to commit.');
      return;
    }
    setIsCommitting(true);
    try {
      for (const [key, moves] of groups) {
        const targetDir = moves[0].targetDir;
        try {
          const outcome = await api.commitRelocation({ photos: moves.map((m) => toInput(m.photo)), targetDir, label: key });
          if (outcome.error && outcome.queued) {
            setPending((prev) => prev.map((m) => (moves.some((mv) => mv.photo.id === m.photo.id) ? { ...m, queued: true } : m)));
            notify('info', `Storage for "${targetDir}" is offline — ${moves.length} move${moves.length === 1 ? '' : 's'} queued and will complete automatically once it reconnects.`);
            refreshQueuedCount();
            continue;
          }
          applyMovedResults(outcome.results);
          const movedIds = new Set(outcome.results.filter((r) => r.status === 'moved').map((r) => r.oldId));
          setPending((prev) => prev.filter((m) => !moves.some((mv) => mv.photo.id === m.photo.id)));
          const failed = outcome.results.filter((r) => r.status === 'failed');
          const skipped = outcome.results.filter((r) => r.status === 'skipped');
          if (movedIds.size > 0) notify('success', `Moved ${movedIds.size} photo${movedIds.size === 1 ? '' : 's'} to "${targetDir}".`);
          if (failed.length > 0) notify('error', `${failed.length} photo${failed.length === 1 ? '' : 's'} could not be moved: ${summariseReasons(failed)}.`);
          if (movedIds.size === 0 && failed.length === 0) notify('info', `Nothing moved to "${targetDir}"${skipped.length ? `: ${summariseReasons(skipped)}` : ''}.`);
        } catch (err) {
          notifyError(`Commit move to "${targetDir}"`, err);
        }
      }
      loadPane(left.path, setLeft);
      loadPane(right.path, setRight);
    } finally {
      setIsCommitting(false);
    }
  };

  /** Removes photos from both panes' lists, any pending stage, and the library — after the files are actually gone. */
  const dropDeletedFromPanes = (deletedIds: string[]) => {
    if (deletedIds.length === 0) return;
    const idSet = new Set(deletedIds);
    const strip = (s: PaneState): PaneState => ({
      ...s,
      photos: s.photos.filter((p) => !idSet.has(p.id)),
      selected: new Set(Array.from(s.selected).filter((id) => !idSet.has(id))),
    });
    setLeft(strip);
    setRight(strip);
    setPending((prev) => prev.filter((m) => !idSet.has(m.photo.id)));
    libraryStore.removePhotos(deletedIds);
    libraryStore.flushSaveImmediately();
  };

  const performDelete = async (targets: Photo[]) => {
    const api = window.electronAPI;
    if (!api?.deleteFilesPermanently) {
      notify('error', 'Deleting photos is only available in the desktop app.');
      return;
    }
    if (targets.length === 0) return;
    try {
      const filePaths = targets.map(realPath);
      const result = await api.deleteFilesPermanently(filePaths);
      const deletedPathSet = new Set(result.deletedPaths);
      const deletedIds = targets.filter((p) => deletedPathSet.has(realPath(p))).map((p) => p.id);
      dropDeletedFromPanes(deletedIds);
      if (deletedIds.length > 0) notify('success', `Deleted ${deletedIds.length} photo${deletedIds.length === 1 ? '' : 's'}.`);
      if (result.errors.length > 0) {
        notify('error', `${result.errors.length} of ${targets.length} photo(s) could not be deleted: ${summariseReasons(result.errors.map((e) => ({ reason: e })))}.`);
      }
    } catch (err) {
      notifyError('Delete photos', err);
    }
  };

  /** The middle toolbar's Delete button acts on whichever pane(s) have a selection. */
  const deleteSelected = () => {
    const leftSel = visiblePhotos(left, right.path).filter((p) => left.selected.has(p.id));
    const rightSel = visiblePhotos(right, left.path).filter((p) => right.selected.has(p.id));
    const byId = new Map([...leftSel, ...rightSel].map((p) => [p.id, p] as const));
    const targets = Array.from(byId.values());
    if (targets.length === 0) {
      notify('info', 'No photos selected.');
      return;
    }
    if (!window.confirm(`Permanently delete ${targets.length} photo${targets.length === 1 ? '' : 's'} from disk? This cannot be undone.`)) return;
    void performDelete(targets);
  };

  const deleteOne = (photo: Photo) => {
    if (!window.confirm(`Permanently delete "${photo.fileName}" from disk? This cannot be undone.`)) return;
    void performDelete([photo]);
  };

  const openContextMenu = (e: React.MouseEvent, which: 'left' | 'right', photo: Photo) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, which, photo });
  };

  const handleOpenExternally = async (photo: Photo) => {
    const ok = await window.electronAPI?.openFile?.(realPath(photo));
    if (!ok) notify('error', 'Could not open the photo externally — the file may be offline or missing.');
  };

  const handleOpenContainingFolder = async (photo: Photo) => {
    const ok = await window.electronAPI?.openItemInFolder?.(realPath(photo));
    if (!ok) notify('error', 'Could not show the file — it may be offline or missing.');
  };

  const handleCopyPath = async (photo: Photo) => {
    try {
      if (!navigator.clipboard) throw new Error('Clipboard access is not available here.');
      await navigator.clipboard.writeText(realPath(photo));
      notify('success', 'Full path copied to clipboard.');
    } catch {
      notify('error', 'Could not copy the path to the clipboard.');
    }
  };

  const handleEditExternal = async (photo: Photo) => {
    const editorPath = getExternalEditorPath();
    if (!editorPath) {
      notify('info', 'No external editor configured yet — set one in Settings > General > External Photo Editor. Opening with the system default for now.');
    }
    const ok = await window.electronAPI?.openFile?.(realPath(photo), editorPath || undefined);
    if (!ok) notify('error', 'Could not open the photo in the external editor.');
  };

  const pendingCount = pending.filter((m) => !m.queued).length;
  const queuedPendingCount = pending.filter((m) => m.queued).length;
  const { rowHeight, minColWidth } = SIZE_MAP[cardSize];

  const leftGridRef = useRef<HTMLDivElement>(null);
  const rightGridRef = useRef<HTMLDivElement>(null);

  const renderPane = (which: 'left' | 'right', pane: PaneState, otherPath: string) => {
    const visible = visiblePhotos(pane, otherPath);
    const gridRef = which === 'left' ? leftGridRef : rightGridRef;
    const allSelected = visible.length > 0 && visible.every((p) => pane.selected.has(p.id));
    const setPane = which === 'left' ? setLeft : setRight;

    return (
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', backgroundColor: 'var(--bg-surface)' }}>
        <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: '2px' }}>
            <button className={`btn btn-icon ${pane.mode === 'folder' ? 'btn-primary' : 'btn-secondary'}`} style={{ width: '30px', height: '30px' }} title="Browse a folder" onClick={() => switchMode(which, 'folder')}>
              <Folder size={14} />
            </button>
            <button className={`btn btn-icon ${pane.mode === 'album' ? 'btn-primary' : 'btn-secondary'}`} style={{ width: '30px', height: '30px' }} title="Browse an album" onClick={() => switchMode(which, 'album')}>
              <BookImage size={14} />
            </button>
          </div>

          {pane.mode === 'folder' && (
            <button className="btn btn-icon btn-secondary" style={{ width: '30px', height: '30px' }} title="Up one folder" disabled={!parentDir(pane.path)} onClick={() => goUp(which)}>
              <ArrowUp size={14} />
            </button>
          )}
          <button
            className="btn btn-icon btn-secondary"
            style={{ width: '30px', height: '30px' }}
            title={allSelected ? 'Clear selection' : 'Select all'}
            onClick={() => setPane((s) => ({ ...s, selected: allSelected ? new Set() : new Set(visible.map((p) => p.id)) }))}
          >
            {allSelected ? <CheckSquare size={14} /> : <Square size={14} />}
          </button>

          {pane.mode === 'folder' ? (
            <>
              <div style={{ flex: 1, minWidth: 0, fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={pane.path}>
                {pane.path || 'No folder selected'}
              </div>
              <button className="btn btn-secondary" style={{ fontSize: '0.78rem', padding: '5px 10px' }} onClick={() => browse(which)}>
                Browse…
              </button>
            </>
          ) : (
            <select
              className="input"
              style={{ flex: 1, minWidth: 0, fontSize: '0.82rem', padding: '5px 8px' }}
              value={pane.albumId || ''}
              onChange={(e) => loadAlbum(which, e.target.value)}
            >
              <option value="">Select an album…</option>
              {albums.map((a) => (
                <option key={a.id} value={a.id}>{a.title} ({a.photoIds.length})</option>
              ))}
            </select>
          )}
        </div>

        <div style={{ padding: '6px 14px', borderBottom: '1px solid var(--border-subtle)', position: 'relative' }}>
          <Search size={13} style={{ position: 'absolute', left: '24px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', pointerEvents: 'none' }} />
          <input
            type="text"
            value={pane.search}
            onChange={(e) => setPane((s) => ({ ...s, search: e.target.value }))}
            placeholder="Search by filename…"
            className="input"
            style={{ width: '100%', fontSize: '0.8rem', padding: '5px 10px 5px 30px' }}
          />
        </div>

        {pane.mode === 'folder' && (libraryRoot || storages.length > 0) && (
          <div style={{ display: 'flex', gap: '6px', padding: '6px 14px', overflowX: 'auto', borderBottom: '1px solid var(--border-subtle)' }}>
            {libraryRoot && (
              <button className="btn btn-ghost" style={{ fontSize: '0.72rem', padding: '3px 9px', whiteSpace: 'nowrap', gap: '5px', display: 'inline-flex', alignItems: 'center' }} onClick={() => loadPane(libraryRoot, setPane)} title={libraryRoot}>
                <HardDrive size={11} /> Library
              </button>
            )}
            {storages.map((s) => (
              <button key={s.name} className="btn btn-ghost" style={{ fontSize: '0.72rem', padding: '3px 9px', whiteSpace: 'nowrap', gap: '5px', display: 'inline-flex', alignItems: 'center' }} onClick={() => loadPane(s.networkSourcePath, setPane)} title={s.networkSourcePath}>
                <HardDrive size={11} /> {s.name}
              </button>
            ))}
          </div>
        )}

        {pane.mode === 'folder' && visibleSubfolders(pane).length > 0 && (
          <div style={{ maxHeight: '130px', overflowY: 'auto', borderBottom: '1px solid var(--border-subtle)', padding: '4px' }}>
            {visibleSubfolders(pane).map((f) => (
              <button
                key={f.path}
                className="btn btn-ghost"
                style={{ width: '100%', justifyContent: 'flex-start', fontSize: '0.78rem', padding: '6px 10px', gap: '8px' }}
                onClick={() => loadPane(f.path, setPane)}
                title={f.path}
              >
                <Folder size={13} color="var(--accent-amber)" />
                <span style={{ flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                {typeof f.photoCount === 'number' && f.photoCount > 0 && (
                  <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{f.photoCount}</span>
                )}
              </button>
            ))}
          </div>
        )}

        <div style={{ padding: '4px 14px', fontSize: '0.74rem', color: 'var(--text-muted)' }}>
          {pane.loading ? 'Loading…' : `${visible.length} item${visible.length === 1 ? '' : 's'}${pane.selected.size ? ` • ${pane.selected.size} selected` : ''}`}
        </div>

        <div ref={gridRef} style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '10px 14px' }}>
          {pane.loading ? (
            <div style={{ textAlign: 'center', padding: '48px', color: 'var(--text-muted)' }}>
              <RefreshCw className="animate-spin" size={24} />
            </div>
          ) : pane.error ? (
            <div style={{ textAlign: 'center', padding: '48px', color: 'var(--accent-rose)' }}>{pane.error}</div>
          ) : visible.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '48px', color: 'var(--text-muted)' }}>
              <ImageIcon size={36} style={{ opacity: 0.4, marginBottom: '8px' }} />
              <p>
                {pane.search.trim()
                  ? 'No photos match this search.'
                  : pane.mode === 'album'
                    ? (pane.albumId ? 'This album has no photos.' : 'Select an album above.')
                    : 'No photos in this folder.'}
              </p>
            </div>
          ) : (
            <VirtualCardGrid
              items={visible}
              getKey={(p) => p.id}
              scrollRef={gridRef}
              rowHeight={rowHeight}
              minColWidth={minColWidth}
              gap={10}
              renderItem={(photo) => {
                const staged = isStaged(photo.id);
                const selected = pane.selected.has(photo.id);
                return (
                  <div
                    onClick={(e) => {
                      if (e.shiftKey || e.ctrlKey || e.metaKey) toggleSelect(which, photo.id);
                      else onSelectPhoto(photo);
                    }}
                    onContextMenu={(e) => openContextMenu(e, which, photo)}
                    style={{
                      height: '100%',
                      boxSizing: 'border-box',
                      borderRadius: 'var(--radius-md)',
                      overflow: 'hidden',
                      border: selected ? '2px solid var(--accent-primary)' : '1px solid var(--border-subtle)',
                      cursor: 'pointer',
                      position: 'relative',
                      opacity: staged ? 0.6 : 1,
                    }}
                    title={staged ? `Staged move to ${staged.targetDir}${staged.queued ? ' (queued — storage offline)' : ''} — click the checkbox to select, Commit to apply.` : photo.fileName}
                  >
                    <div
                      onClick={(e) => { e.stopPropagation(); toggleSelect(which, photo.id); }}
                      style={{ position: 'absolute', top: '4px', left: '4px', zIndex: 2, background: 'rgba(0,0,0,0.5)', borderRadius: '4px', padding: '2px', color: '#fff' }}
                    >
                      {selected ? <CheckSquare size={14} /> : <Square size={14} />}
                    </div>
                    <button
                      onClick={(e) => { e.stopPropagation(); onEditPhoto(photo); }}
                      title="Edit photo"
                      style={{ position: 'absolute', bottom: '36px', right: '4px', zIndex: 2, background: 'rgba(0,0,0,0.55)', border: 'none', borderRadius: '4px', padding: '4px', color: '#fff', cursor: 'pointer', display: 'flex' }}
                    >
                      <Edit2 size={13} />
                    </button>
                    {staged && (
                      <div
                        onClick={(e) => { e.stopPropagation(); unstage(photo.id); }}
                        title={staged.queued ? 'Queued — waiting for storage to reconnect' : 'Staged — not yet committed. Click to cancel.'}
                        style={{ position: 'absolute', top: '4px', right: '4px', zIndex: 2, background: staged.queued ? 'var(--accent-amber)' : 'rgba(0,0,0,0.6)', borderRadius: '4px', padding: '3px', color: '#fff', display: 'flex' }}
                      >
                        <Clock size={13} />
                      </div>
                    )}
                    <div style={{ height: 'calc(100% - 38px)', backgroundColor: '#0f172a' }}>
                      <img src={getLocalPhotoUrl(photo.filePath, photo.originalRemotePath)} alt={photo.fileName} style={{ width: '100%', height: '100%', objectFit: 'cover' }} loading="lazy" />
                    </div>
                    <div style={{ padding: '4px 6px', fontSize: '0.7rem', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {photo.fileName}
                    </div>
                  </div>
                );
              }}
            />
          )}
        </div>
      </div>
    );
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: isMobile ? 'column' : 'row', overflow: 'hidden', position: 'relative' }}>
      {renderPane('left', left, right.path)}

      {/* Middle vertical toolbar: move selected/all between panes, delete, resize, then Commit. */}
      <div
        style={{
          width: isMobile ? '100%' : '72px',
          flexShrink: 0,
          display: 'flex',
          flexDirection: isMobile ? 'row' : 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '10px',
          padding: '12px 6px',
          borderLeft: isMobile ? 'none' : '1px solid var(--border-subtle)',
          borderRight: isMobile ? 'none' : '1px solid var(--border-subtle)',
          backgroundColor: 'var(--bg-surface)',
        }}
      >
        <button className="btn btn-icon btn-secondary" style={{ width: '40px', height: '40px' }} title={right.mode === 'album' ? 'Switch the right pane to a folder first' : 'Move selected to right'} disabled={left.selected.size === 0 || right.mode === 'album' || !right.path} onClick={() => moveSelected('left')}>
          <ArrowRight size={18} />
        </button>
        <button className="btn btn-icon btn-secondary" style={{ width: '40px', height: '40px' }} title={right.mode === 'album' ? 'Switch the right pane to a folder first' : 'Move all to right'} disabled={visiblePhotos(left, right.path).length === 0 || right.mode === 'album' || !right.path} onClick={() => moveAll('left')}>
          <ChevronsRight size={18} />
        </button>
        <button className="btn btn-icon btn-secondary" style={{ width: '40px', height: '40px' }} title={left.mode === 'album' ? 'Switch the left pane to a folder first' : 'Move all to left'} disabled={visiblePhotos(right, left.path).length === 0 || left.mode === 'album' || !left.path} onClick={() => moveAll('right')}>
          <ChevronsLeft size={18} />
        </button>
        <button className="btn btn-icon btn-secondary" style={{ width: '40px', height: '40px' }} title={left.mode === 'album' ? 'Switch the left pane to a folder first' : 'Move selected to left'} disabled={right.selected.size === 0 || left.mode === 'album' || !left.path} onClick={() => moveSelected('right')}>
          <ArrowLeft size={18} />
        </button>

        <div style={{ height: '1px', width: '100%', background: 'var(--border-subtle)', margin: isMobile ? '0 10px' : '8px 0' }} />

        <button
          className="btn btn-icon btn-secondary"
          style={{ width: '40px', height: '40px', color: 'var(--accent-rose)' }}
          title="Delete selected photos (left + right) from disk"
          disabled={left.selected.size === 0 && right.selected.size === 0}
          onClick={deleteSelected}
        >
          <Trash2 size={18} />
        </button>

        <div style={{ height: '1px', width: '100%', background: 'var(--border-subtle)', margin: isMobile ? '0 10px' : '8px 0' }} />

        {/* Thumbnail size */}
        <div style={{ display: 'flex', flexDirection: isMobile ? 'row' : 'column', gap: '2px' }}>
          {(['xs', 's', 'm', 'l'] as CardSize[]).map((size) => (
            <button
              key={size}
              className={`btn btn-icon ${cardSize === size ? 'btn-primary' : 'btn-secondary'}`}
              style={{ width: '32px', height: '24px', fontSize: '0.65rem', fontWeight: 700, textTransform: 'uppercase' }}
              title={`Thumbnail size: ${size.toUpperCase()}`}
              onClick={() => setCardSize(size)}
            >
              {size}
            </button>
          ))}
        </div>

        <div style={{ height: '1px', width: '100%', background: 'var(--border-subtle)', margin: isMobile ? '0 10px' : '8px 0' }} />

        <button
          className="btn btn-primary btn-icon"
          style={{ width: '44px', height: '44px', position: 'relative' }}
          title={pendingCount > 0 ? `Commit ${pendingCount} staged move${pendingCount === 1 ? '' : 's'}` : 'No staged moves to commit'}
          disabled={pendingCount === 0 || isCommitting}
          onClick={commit}
        >
          {isCommitting ? <RefreshCw size={18} className="animate-spin" /> : <Save size={18} />}
          {pendingCount > 0 && (
            <span style={{ position: 'absolute', top: '-6px', right: '-6px', background: 'var(--accent-rose)', color: '#fff', borderRadius: '10px', fontSize: '0.65rem', padding: '1px 5px', lineHeight: 1.4 }}>
              {pendingCount}
            </span>
          )}
        </button>
        {(queuedPendingCount > 0 || queuedCount > 0) && (
          <div style={{ fontSize: '0.65rem', color: 'var(--accent-amber)', textAlign: 'center', display: 'flex', alignItems: 'center', gap: '4px' }} title="Commits waiting for an offline storage to reconnect">
            <Clock size={11} />
            {queuedCount}
          </div>
        )}
      </div>

      {renderPane('right', right, left.path)}

      {contextMenu && (
        <div
          style={{
            position: 'fixed',
            top: contextMenu.y,
            left: contextMenu.x,
            zIndex: 2001,
            background: 'var(--bg-surface-elevated)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-md)',
            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.5)',
            minWidth: '230px',
            padding: '4px',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {[
            { label: 'Open Image Externally', icon: ExternalLink, action: () => handleOpenExternally(contextMenu.photo) },
            { label: 'Open Containing Folder', icon: FolderOpen, action: () => handleOpenContainingFolder(contextMenu.photo) },
            { label: 'Copy Full Path', icon: Copy, action: () => handleCopyPath(contextMenu.photo) },
            { label: 'Edit with Internal Editor', icon: Edit2, action: () => onEditPhoto(contextMenu.photo) },
            { label: 'Edit with External Editor', icon: Edit3, action: () => handleEditExternal(contextMenu.photo) },
            { label: 'Delete', icon: Trash2, danger: true, action: () => deleteOne(contextMenu.photo) },
          ].map((item) => (
            <button
              key={item.label}
              className="btn btn-ghost"
              style={{ width: '100%', justifyContent: 'flex-start', gap: '10px', padding: '8px 10px', fontSize: '0.8rem', color: item.danger ? 'var(--accent-rose)' : 'var(--text-primary)' }}
              onClick={() => { item.action(); setContextMenu(null); }}
            >
              <item.icon size={14} />
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
