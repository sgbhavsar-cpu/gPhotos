import React, { useEffect, useMemo, useState } from 'react';
import { X, Check, FolderTree, RefreshCw } from 'lucide-react';
import { Photo } from '../../../types';
import { libraryStore } from '../services/libraryStore';
import { notify, notifyError } from '../services/notifications';

interface Props {
  folderPath: string;
  onClose: () => void;
  onCreated?: (albumId: string) => void;
}

const norm = (p: string) => p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
const DATE_PREFIX = /^\s*((?:19|20)\d{2})[-_. ]?(0[1-9]|1[0-2])[-_. ]?(0[1-9]|[12]\d|3[01])[\s_.-]*/;
/** "20240713 Day0 Delhi" -> "Day0 Delhi" (a name that is only a date is kept as is). */
const cleanName = (s: string) => { const c = s.replace(DATE_PREFIX, '').trim(); return c || s.trim(); };

interface Group { key: string; name: string; photos: Photo[] }

/**
 * "Create album from folder": the folder becomes an album, and every sub-folder (at any depth) that holds
 * photos becomes a chapter named by joining its folder path below the album folder with " - "
 * (e.g. "Day0 Delhi - Dharmesh Patel"). Photos directly in the folder stay in the album without a chapter.
 * Only photos already in the library are included.
 */
export const AlbumFromFolderModal: React.FC<Props> = ({ folderPath, onClose, onCreated }) => {
  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState('');
  const [rootGroup, setRootGroup] = useState<Photo[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const folderMarker = `Created from folder ${folderPath}`;
  const albums = libraryStore.getState().albums;
  const linkedAlbum = albums.find((a) => a.description === folderMarker);
  // Update mode: sync an existing album with what is in the folder now (new/changed files added, removed ones dropped).
  const [mode, setMode] = useState<'create' | 'update'>(linkedAlbum ? 'update' : 'create');
  const [albumId, setAlbumId] = useState(linkedAlbum?.id ?? albums[0]?.id ?? '');

  const rootName = folderPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || folderPath;
  const eventDate = useMemo(() => {
    const m = rootName.match(DATE_PREFIX);
    return m ? new Date(+m[1], +m[2] - 1, +m[3], 12).toISOString() : undefined;
  }, [rootName]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // The store pages photos in lazily; a folder can span pages that aren't loaded yet.
        await libraryStore.loadAllCatalogPages();
        if (cancelled) return;
        const root = norm(folderPath);
        const direct: Photo[] = [];
        const byDir = new Map<string, Photo[]>();
        for (const p of libraryStore.getState().photos) {
          if (p.isExcluded) continue;
          const candidates = [p.originalRemotePath, p.filePath].filter(Boolean) as string[];
          const full = candidates.find((c) => norm(c).startsWith(root + '\\'));
          if (!full) continue;
          const rel = full.replace(/\//g, '\\').slice(root.length + 1).split('\\');
          rel.pop(); // file name
          if (rel.length === 0) { direct.push(p); continue; }
          const key = rel.join('\\');
          const arr = byDir.get(key);
          if (arr) arr.push(p); else byDir.set(key, [p]);
        }
        const gs: Group[] = [...byDir.entries()]
          .sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true, sensitivity: 'base' }))
          .map(([key, photos]) => ({ key, name: key.split('\\').map(cleanName).join(' - '), photos }));
        setTitle(cleanName(rootName));
        setRootGroup(direct);
        setGroups(gs);
        setNames(Object.fromEntries(gs.map((g) => [g.key, g.name])));
        setSelected(new Set(['', ...gs.map((g) => g.key)]));
      } catch (err) {
        setError('Could not read the photos in this folder.');
        notifyError('Album from folder', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [folderPath, rootName]);

  const toggle = (key: string) => setSelected((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const chosenGroups = groups.filter((g) => selected.has(g.key));
  const rootChosen = selected.has('') && rootGroup.length > 0;
  const photoTotal = chosenGroups.reduce((n, g) => n + g.photos.length, 0) + (rootChosen ? rootGroup.length : 0);
  const existing = libraryStore.getState().albums.some((a) => a.title.trim().toLowerCase() === title.trim().toLowerCase());

  const create = () => {
    if (photoTotal === 0) return;
    const album = libraryStore.createAlbum(title, `Created from folder ${folderPath}`, eventDate, rootChosen ? rootGroup.map((p) => p.id) : []);
    for (const g of chosenGroups) libraryStore.createChapter(album.id, names[g.key] || g.name, g.photos.map((p) => p.id));
    notify('success', `Created album "${album.title}" with ${chosenGroups.length} chapter${chosenGroups.length === 1 ? '' : 's'} and ${photoTotal.toLocaleString()} photos.`);
    onCreated?.(album.id);
    onClose();
  };

  const update = () => {
    const album = libraryStore.getState().albums.find((a) => a.id === albumId);
    if (!album) return;
    const inFolder = new Set([...rootGroup, ...groups.flatMap((g) => g.photos)].map((p) => p.id));
    let added = 0;
    const fresh = (have: Set<string>, ids: string[]) => ids.filter((id) => !have.has(id));
    if (rootChosen) {
      const ids = fresh(new Set(album.photoIds), rootGroup.map((p) => p.id));
      added += ids.length;
      if (ids.length) libraryStore.addPhotosToAlbum(album.id, ids);
    }
    for (const g of chosenGroups) {
      const name = (names[g.key] || g.name).trim();
      let ch = libraryStore.getState().albums.find((a) => a.id === album.id)?.chapters?.find((c) => c.title.trim().toLowerCase() === name.toLowerCase());
      const ids = fresh(new Set(ch?.photoIds ?? []), g.photos.map((p) => p.id));
      if (!ch) { libraryStore.createChapter(album.id, name, ids); added += ids.length; continue; }
      if (ids.length) { libraryStore.addPhotosToChapter(album.id, ch.id, ids); added += ids.length; }
    }
    // Anything in the album that is no longer in the folder (deleted or moved away) is dropped.
    const stale = (libraryStore.getState().albums.find((a) => a.id === album.id)?.photoIds ?? []).filter((id) => !inFolder.has(id));
    if (stale.length) libraryStore.removePhotosFromAlbum(album.id, stale);
    notify('success', `Updated "${album.title}": ${added.toLocaleString()} added, ${stale.length.toLocaleString()} removed.`);
    onCreated?.(album.id);
    onClose();
  };

  const cell: React.CSSProperties = { padding: '6px 10px', fontSize: '0.8rem', borderBottom: '1px solid var(--border-subtle)' };

  return (
    <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(5, 8, 15, 0.88)', backdropFilter: 'blur(10px)', zIndex: 3600, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: '100%', maxWidth: '780px', maxHeight: '88vh', display: 'flex', flexDirection: 'column', backgroundColor: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-lg)', boxShadow: '0 24px 64px rgba(0, 0, 0, 0.7)', overflow: 'hidden' }}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            <h3 style={{ fontSize: '1.1rem', fontWeight: 700, margin: 0, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 8 }}><FolderTree size={18} /> {mode === 'update' ? 'Update album from folder' : 'Create album from folder'}</h3>
            <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={folderPath}>{folderPath}</div>
          </div>
          <button className="btn btn-ghost btn-icon" onClick={onClose} style={{ width: 32, height: 32 }}><X size={18} /></button>
        </div>

        {loading ? (
          <div style={{ padding: '48px', textAlign: 'center', color: 'var(--text-muted)' }}>
            <RefreshCw className="animate-spin" size={24} style={{ margin: '0 auto 10px' }} />
            <div>Reading the photos in this folder…</div>
          </div>
        ) : error ? (
          <div style={{ padding: 24, color: 'var(--accent-rose)' }}>{error}</div>
        ) : groups.length === 0 && rootGroup.length === 0 ? (
          <div style={{ padding: 24, color: 'var(--text-muted)', fontSize: '0.85rem' }}>
            None of the photos or videos in this folder are in your library yet. Scan or sync the storage first, then try again.
          </div>
        ) : (
          <>
            <div style={{ padding: '14px 20px', display: 'flex', flexDirection: 'column', gap: 6 }}>
              {albums.length > 0 && (
                <div style={{ display: 'flex', gap: 14, fontSize: '0.8rem', marginBottom: 4 }}>
                  <label><input type="radio" checked={mode === 'create'} onChange={() => setMode('create')} /> Create new album</label>
                  <label><input type="radio" checked={mode === 'update'} onChange={() => setMode('update')} /> Update existing album</label>
                </div>
              )}
              {mode === 'update' ? (
                <>
                  <select className="input" value={albumId} onChange={(e) => setAlbumId(e.target.value)} style={{ fontSize: '0.9rem' }}>
                    {albums.map((a) => <option key={a.id} value={a.id}>{a.title}{a.id === linkedAlbum?.id ? ' (created from this folder)' : ''}</option>)}
                  </select>
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>Photos and videos added to the folder are added to the matching chapter; ones deleted or moved out of the folder are removed from the album.</div>
                </>
              ) : (<>
              <label style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)' }}>Album name</label>
              <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} style={{ fontSize: '0.9rem' }} />
              <div style={{ fontSize: '0.72rem', color: existing ? 'var(--accent-amber, #f59e0b)' : 'var(--text-muted)' }}>
                {existing ? 'An album with this name already exists — this will create another one.' : eventDate ? `Event date ${new Date(eventDate).toLocaleDateString()} (from the folder name).` : 'Chapter names join the sub-folder names, e.g. "Day0 Delhi - Dharmesh Patel". Edit any name below.'}
              </div></>)}
            </div>
            <div style={{ overflow: 'auto', flex: 1, borderTop: '1px solid var(--border-subtle)' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
                <thead>
                  <tr style={{ position: 'sticky', top: 0, background: 'var(--bg-surface)', zIndex: 1 }}>
                    <th style={{ ...cell, width: 40 }} />
                    <th style={{ ...cell, textAlign: 'left', fontWeight: 700 }}>Chapter name</th>
                    <th style={{ ...cell, width: 90, textAlign: 'right', fontWeight: 700 }}>Photos / videos</th>
                  </tr>
                </thead>
                <tbody>
                  {rootGroup.length > 0 && (
                    <tr>
                      <td style={{ ...cell, textAlign: 'center' }}><input type="checkbox" checked={selected.has('')} onChange={() => toggle('')} /></td>
                      <td style={{ ...cell, color: 'var(--text-muted)', fontStyle: 'italic' }}>Photos and videos directly in this folder (no chapter)</td>
                      <td style={{ ...cell, textAlign: 'right' }}>{rootGroup.length.toLocaleString()}</td>
                    </tr>
                  )}
                  {groups.map((g) => (
                    <tr key={g.key} style={{ opacity: selected.has(g.key) ? 1 : 0.5 }}>
                      <td style={{ ...cell, textAlign: 'center' }}><input type="checkbox" checked={selected.has(g.key)} onChange={() => toggle(g.key)} /></td>
                      <td style={cell} title={g.key}>
                        <input className="input" value={names[g.key] ?? g.name} onChange={(e) => setNames((n) => ({ ...n, [g.key]: e.target.value }))} style={{ width: '100%', fontSize: '0.8rem', padding: '3px 8px' }} />
                      </td>
                      <td style={{ ...cell, textAlign: 'right' }}>{g.photos.length.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        <div style={{ padding: '14px 20px', borderTop: '1px solid var(--border-subtle)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>Only photos and videos already in your library are included.</span>
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" onClick={mode === 'update' ? update : create} disabled={loading || (mode === 'update' ? !albumId : photoTotal === 0 || !title.trim())} style={{ gap: 6 }}>
              <Check size={15} />
              <span>{mode === 'update' ? `Update album · ${chosenGroups.length} chapter${chosenGroups.length === 1 ? '' : 's'} · ${photoTotal.toLocaleString()} items` : `Create album · ${chosenGroups.length} chapter${chosenGroups.length === 1 ? '' : 's'} · ${photoTotal.toLocaleString()} photos`}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
