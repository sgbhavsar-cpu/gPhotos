import React, { useState, useEffect, useMemo } from 'react';
import {
  FolderSync,
  FolderOpen,
  ArrowRight,
  ShieldCheck,
  FileCheck,
  AlertTriangle,
  Play,
  Copy,
  Move,
  CheckCircle2,
  Calendar,
  Layers,
  ChevronRight,
  ChevronDown,
  Folder,
  Image as ImageIcon,
  Search,
  Grid,
  List,
  Eye,
  X,
  Sparkles,
  MoreVertical
} from 'lucide-react';
import {
  FolderStructure,
  OrganizeOptions,
  DryRunSummary,
  DryRunItem,
  OrganizeProgress
} from '../../types';
import { getLocalPhotoUrl } from '../services/libraryStore';
import { useIsMobile } from '../hooks/useIsMobile';

interface OrganizerViewProps {
  onOrganizeComplete?: (targetDir: string) => void;
}

interface FolderNode {
  name: string;
  relativePath: string;
  count: number;
  sizeBytes: number;
  children: Map<string, FolderNode>;
}

export const OrganizerView: React.FC<OrganizerViewProps> = ({ onOrganizeComplete }) => {
  const isMobile = useIsMobile();
  const [showMobileMetrics, setShowMobileMetrics] = useState(false);
  const [sourceDir, setSourceDir] = useState<string>('');
  const [targetDir, setTargetDir] = useState<string>('');
  const [structure, setStructure] = useState<FolderStructure>('YYYY/YYYY-MM');
  const [mode, setMode] = useState<'copy' | 'move'>('copy');
  const [conflictResolution, setConflictResolution] = useState<'skip' | 'rename'>('skip');

  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [dryRunResult, setDryRunResult] = useState<DryRunSummary | null>(null);
  const [progress, setProgress] = useState<OrganizeProgress | null>(null);
  const [isOrganizing, setIsOrganizing] = useState(false);
  const [completedSummary, setCompletedSummary] = useState<{ movedCount: number; errors: string[] } | null>(null);

  // Split-pane Tree & Photo Review State
  const [selectedFolderPath, setSelectedFolderPath] = useState<string>('__ALL__');
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set(['__ALL__']));
  const [searchTerm, setSearchTerm] = useState<string>('');
  const [viewMode, setViewMode] = useState<'grid' | 'table'>('grid');
  const [previewPhoto, setPreviewPhoto] = useState<DryRunItem | null>(null);

  // Subscribe to organization progress events
  useEffect(() => {
    if (!window.electronAPI?.onOrganizeProgress) return;
    const unsubscribe = window.electronAPI.onOrganizeProgress((p) => {
      setProgress(p);
      if (p.status === 'completed' || p.status === 'error') {
        setIsOrganizing(false);
      }
    });
    return () => unsubscribe();
  }, []);

  const handleSelectSource = async () => {
    if (window.electronAPI) {
      const dir = await window.electronAPI.selectDirectory();
      if (dir) {
        setSourceDir(dir);
        setDryRunResult(null);
      }
    }
  };

  const handleSelectTarget = async () => {
    if (window.electronAPI) {
      const dir = await window.electronAPI.selectDirectory();
      if (dir) {
        setTargetDir(dir);
        setDryRunResult(null);
      }
    }
  };

  const handleRunDryRun = async () => {
    if (!sourceDir || !targetDir) return;
    setIsAnalyzing(true);
    setDryRunResult(null);
    setCompletedSummary(null);
    setSelectedFolderPath('__ALL__');

    try {
      const options: OrganizeOptions = {
        sourceDir,
        targetDir,
        structure,
        mode,
        conflictResolution,
      };

      if (window.electronAPI) {
        const result = await window.electronAPI.analyzeDryRun(options);
        setDryRunResult(result);
        // Automatically expand top-level folders
        if (result && result.targetFolders) {
          const topLevels = new Set<string>(['__ALL__']);
          for (const folder of result.targetFolders) {
            const parts = folder.replace(/\\/g, '/').split('/');
            if (parts.length > 0) topLevels.add(parts[0]);
          }
          setExpandedFolders(topLevels);
        }
      }
    } catch (err) {
      console.error('Dry-run failed:', err);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleStartOrganizing = async () => {
    if (!sourceDir || !targetDir || !window.electronAPI) return;
    const count = dryRunResult?.totalFiles || 0;
    const confirmMsg = `Proceed with physical organization of ${count} photos?\n\nMode: ${mode.toUpperCase()}\nTarget: ${targetDir}`;
    if (!window.confirm(confirmMsg)) return;

    setIsOrganizing(true);
    setProgress({
      current: 0,
      total: count,
      currentFile: 'Starting organization...',
      status: 'organizing',
    });

    try {
      const options: OrganizeOptions = {
        sourceDir,
        targetDir,
        structure,
        mode,
        conflictResolution,
      };

      const res = await window.electronAPI.executeOrganize(options);
      setCompletedSummary(res);
      if (res.success && onOrganizeComplete) {
        onOrganizeComplete(targetDir);
      }
    } catch (err: any) {
      console.error('Organization execution error:', err);
    } finally {
      setIsOrganizing(false);
    }
  };

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  // Helper to extract relative folder path from targetFile relative to targetDir
  const getRelativeFolder = (targetFile: string, targetRoot: string): string => {
    const normRoot = targetRoot.replace(/\\/g, '/').replace(/\/+$/, '');
    const normTarget = targetFile.replace(/\\/g, '/');
    let rel = normTarget;
    if (normTarget.toLowerCase().startsWith(normRoot.toLowerCase())) {
      rel = normTarget.slice(normRoot.length).replace(/^\/+/, '');
    }
    const parts = rel.split('/');
    parts.pop(); // remove file name
    return parts.join('/') || 'Root';
  };

  // Build hierarchical folder tree from dry run items
  const folderTree = useMemo(() => {
    if (!dryRunResult || !targetDir) return null;

    const root: FolderNode = {
      name: 'All Folders',
      relativePath: '__ALL__',
      count: dryRunResult.totalFiles,
      sizeBytes: dryRunResult.totalSize,
      children: new Map(),
    };

    for (const item of dryRunResult.items) {
      const relFolder = getRelativeFolder(item.targetFile, targetDir);
      const parts = relFolder.split('/').filter(Boolean);

      let current = root;
      let pathAccum = '';
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        pathAccum = pathAccum ? `${pathAccum}/${part}` : part;

        if (!current.children.has(part)) {
          current.children.set(part, {
            name: part,
            relativePath: pathAccum,
            count: 0,
            sizeBytes: 0,
            children: new Map(),
          });
        }
        const child = current.children.get(part)!;
        child.count += 1;
        child.sizeBytes += item.fileSize || 0;
        current = child;
      }
    }

    return root;
  }, [dryRunResult, targetDir]);

  // Filter items based on selected folder & search
  const displayedPhotos = useMemo(() => {
    if (!dryRunResult) return [];

    let filtered = dryRunResult.items;
    if (selectedFolderPath !== '__ALL__') {
      filtered = filtered.filter((item) => {
        const rel = getRelativeFolder(item.targetFile, targetDir);
        return rel === selectedFolderPath || rel.startsWith(`${selectedFolderPath}/`);
      });
    }

    if (searchTerm.trim()) {
      const term = searchTerm.toLowerCase();
      filtered = filtered.filter(
        (item) =>
          item.sourceFile.toLowerCase().includes(term) ||
          item.targetFile.toLowerCase().includes(term)
      );
    }

    return filtered;
  }, [dryRunResult, selectedFolderPath, searchTerm, targetDir]);

  const toggleFolderExpanded = (path: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  // Render tree node recursive component
  const renderTreeNode = (node: FolderNode, level: number = 0) => {
    const isExpanded = expandedFolders.has(node.relativePath);
    const isSelected = selectedFolderPath === node.relativePath;
    const hasChildren = node.children.size > 0;

    return (
      <div key={node.relativePath} style={{ marginLeft: level > 0 ? '12px' : '0' }}>
        <div
          onClick={() => setSelectedFolderPath(node.relativePath)}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '6px 10px',
            borderRadius: 'var(--radius-sm)',
            backgroundColor: isSelected ? 'rgba(59, 130, 246, 0.18)' : 'transparent',
            color: isSelected ? 'var(--accent-primary)' : 'var(--text-primary)',
            fontWeight: isSelected ? 700 : 500,
            fontSize: '0.82rem',
            cursor: 'pointer',
            transition: 'all 0.15s ease',
            borderLeft: isSelected ? '3px solid var(--accent-primary)' : '3px solid transparent',
          }}
          title={node.relativePath === '__ALL__' ? 'All organized destination photos' : node.relativePath}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0, overflow: 'hidden' }}>
            {hasChildren ? (
              <button
                onClick={(e) => toggleFolderExpanded(node.relativePath, e)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'inherit',
                  padding: '2px',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                }}
              >
                {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </button>
            ) : (
              <div style={{ width: '18px' }} />
            )}
            <Folder size={15} color={isSelected ? 'var(--accent-primary)' : '#f59e0b'} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {node.name}
            </span>
          </div>

          <span
            style={{
              fontSize: '0.72rem',
              backgroundColor: isSelected ? 'var(--accent-primary)' : 'rgba(255, 255, 255, 0.08)',
              color: isSelected ? 'white' : 'var(--text-muted)',
              padding: '1px 6px',
              borderRadius: 'var(--radius-full)',
              fontWeight: 600,
              marginLeft: '6px',
            }}
          >
            {node.count}
          </span>
        </div>

        {hasChildren && isExpanded && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', marginTop: '2px' }}>
            {Array.from(node.children.values()).map((child) => renderTreeNode(child, level + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflowY: 'auto', padding: '24px 32px' }}>
      {/* Title & Description */}
      <div style={{ marginBottom: '20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '6px' }}>
          <div style={{
            width: '38px',
            height: '38px',
            borderRadius: 'var(--radius-md)',
            backgroundColor: 'rgba(59, 130, 246, 0.15)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--accent-primary)',
          }}>
            <FolderSync size={20} />
          </div>
          <div>
            <h2 style={{ fontSize: '1.35rem', fontWeight: 800, color: 'var(--text-primary)', margin: 0 }}>
              Physical Date-Based Photo Organizer
            </h2>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', margin: '2px 0 0' }}>
              Scans your source folders, extracts EXIF dates, and previews organized destination folders in an interactive tree view.
            </p>
          </div>
        </div>
      </div>

      {/* Configuration Form Card */}
      <div style={{
        backgroundColor: 'var(--bg-surface)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-lg)',
        padding: '20px 24px',
        boxShadow: 'var(--shadow-sm)',
        display: 'flex',
        flexDirection: 'column',
        gap: '16px',
        marginBottom: '20px',
      }}>
        {/* Step 1: Directory Selection */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
          {/* Source Folder */}
          <div>
            <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '6px', color: 'var(--text-secondary)' }}>
              1. Source Folder (Unorganized Photos)
            </label>
            <div style={{ display: 'flex', gap: '8px' }}>
              <input
                type="text"
                readOnly
                placeholder="Select unorganized photos folder..."
                value={sourceDir}
                className="input"
                style={{ fontSize: '0.8rem', cursor: 'default' }}
              />
              <button className="btn btn-secondary" onClick={handleSelectSource} title="Browse Source">
                <FolderOpen size={16} />
              </button>
            </div>
          </div>

          {/* Target Folder */}
          <div>
            <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '6px', color: 'var(--text-secondary)' }}>
              2. Destination Folder (Organized Library)
            </label>
            <div style={{ display: 'flex', gap: '8px' }}>
              <input
                type="text"
                readOnly
                placeholder="Select organized destination folder..."
                value={targetDir}
                className="input"
                style={{ fontSize: '0.8rem', cursor: 'default' }}
              />
              <button className="btn btn-secondary" onClick={handleSelectTarget} title="Browse Destination">
                <FolderOpen size={16} />
              </button>
            </div>
          </div>
        </div>

        {/* Step 2: Folder Scheme & Mode */}
        <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr', gap: '20px' }}>
          {/* Structure Selector */}
          <div>
            <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '6px', color: 'var(--text-secondary)' }}>
              3. Date Folder Scheme
            </label>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
              {[
                { id: 'YYYY/YYYY-MM' as FolderStructure, label: '2024 / 2024-08 (Recommended)' },
                { id: 'YYYY/MM - Month' as FolderStructure, label: '2024 / 08 - August' },
                { id: 'YYYY/YYYY-MM-DD' as FolderStructure, label: '2024 / 2024-08-25' },
                { id: 'YYYY/MM/DD' as FolderStructure, label: '2024 / 08 / 25' },
              ].map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => { setStructure(item.id); setDryRunResult(null); }}
                  className={`btn ${structure === item.id ? 'btn-primary' : 'btn-secondary'}`}
                  style={{
                    fontSize: '0.75rem',
                    justifyContent: 'flex-start',
                    padding: '8px 12px',
                    fontFamily: 'var(--font-mono)',
                  }}
                >
                  <Calendar size={14} />
                  <span>{item.label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Operation Mode */}
          <div>
            <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '6px', color: 'var(--text-secondary)' }}>
              4. Operation Mode
            </label>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                type="button"
                onClick={() => { setMode('copy'); setDryRunResult(null); }}
                className={`btn ${mode === 'copy' ? 'btn-primary' : 'btn-secondary'}`}
                style={{ flex: 1, fontSize: '0.8rem' }}
              >
                <Copy size={15} />
                <span>Copy (Safe)</span>
              </button>
              <button
                type="button"
                onClick={() => { setMode('move'); setDryRunResult(null); }}
                className={`btn ${mode === 'move' ? 'btn-primary' : 'btn-secondary'}`}
                style={{ flex: 1, fontSize: '0.8rem' }}
              >
                <Move size={15} />
                <span>Move</span>
              </button>
            </div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '6px' }}>
              {mode === 'copy'
                ? '✓ Non-destructive: Leaves original photos untouched in the source folder.'
                : '⚠ Relocates files from source to destination to save disk space.'}
            </div>
          </div>
        </div>

        {/* Action Button: Dry-run */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px', borderTop: '1px solid var(--border-subtle)', paddingTop: '14px' }}>
          <button
            className="btn btn-primary"
            onClick={handleRunDryRun}
            disabled={!sourceDir || !targetDir || isAnalyzing || isOrganizing}
            style={{ padding: '10px 24px', fontSize: '0.88rem' }}
          >
            <ShieldCheck size={18} />
            <span>{isAnalyzing ? 'Analyzing Dates & EXIF...' : 'Preview Dry-Run in Split View'}</span>
          </button>
        </div>
      </div>

      {/* Split-Pane Tree View & Photos Review Pane */}
      {dryRunResult && folderTree && (
        <div style={{
          backgroundColor: 'var(--bg-surface)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-lg)',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: 'var(--shadow-md)',
          overflow: 'hidden',
          marginBottom: '24px',
        }}>
          {/* Top Summary Bar */}
          {isMobile ? (
            // Mobile: title + a single "more options" toggle for the metrics,
            // so the persistent bar never grows past one compact row. The
            // Execute button stays outside the collapsed panel since it's
            // the primary action for this section.
            <div style={{ borderBottom: '1px solid var(--border-subtle)', backgroundColor: 'var(--bg-surface-elevated)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', padding: '12px 14px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0, overflow: 'hidden' }}>
                  <FileCheck size={18} color="var(--accent-emerald)" style={{ flexShrink: 0 }} />
                  <h3 style={{ fontSize: '0.92rem', fontWeight: 700, margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    Dry-Run Review
                  </h3>
                </div>
                <button
                  className={`btn ${showMobileMetrics ? 'btn-primary' : 'btn-ghost'} btn-icon`}
                  onClick={() => setShowMobileMetrics((v) => !v)}
                  style={{ width: '32px', height: '32px', flexShrink: 0 }}
                  title="Show metrics"
                  aria-expanded={showMobileMetrics}
                >
                  <MoreVertical size={16} />
                </button>
              </div>

              {showMobileMetrics && (
                <div style={{ padding: '0 14px 12px', display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '0.8rem' }}>
                  <span style={{ color: 'var(--text-muted)' }}>
                    Inspect how photos will be categorized into folders before executing
                  </span>
                  <span>Total: <strong>{dryRunResult.totalFiles}</strong> photos</span>
                  <span>Size: <strong>{formatBytes(dryRunResult.totalSize)}</strong></span>
                  <span>Target Folders: <strong>{dryRunResult.targetFolders.length}</strong></span>
                  {dryRunResult.duplicateCount > 0 && (
                    <span style={{ color: 'var(--accent-amber)' }}>
                      Duplicates: <strong>{dryRunResult.duplicateCount}</strong>
                    </span>
                  )}
                </div>
              )}

              <div style={{ padding: '0 14px 14px' }}>
                <button
                  className="btn btn-primary"
                  onClick={handleStartOrganizing}
                  disabled={isOrganizing || dryRunResult.totalFiles === 0}
                  style={{
                    backgroundColor: 'var(--accent-emerald)',
                    padding: '10px 22px',
                    fontSize: '0.88rem',
                    fontWeight: 700,
                    gap: '8px',
                    width: '100%',
                    justifyContent: 'center',
                  }}
                >
                  <Play size={16} />
                  <span>{isOrganizing ? 'Organizing...' : `Execute ${mode === 'copy' ? 'Copy' : 'Move'}`}</span>
                </button>
              </div>
            </div>
          ) : (
            <div style={{
              padding: '16px 20px',
              borderBottom: '1px solid var(--border-subtle)',
              backgroundColor: 'var(--bg-surface-elevated)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
              gap: '12px',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <FileCheck size={20} color="var(--accent-emerald)" />
                <div>
                  <h3 style={{ fontSize: '1.05rem', fontWeight: 700, margin: 0 }}>
                    Dry-Run Review & Tree Organization
                  </h3>
                  <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                    Inspect how photos will be categorized into folders before executing
                  </span>
                </div>
              </div>

              {/* Metrics & Execute Button */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                <div style={{ display: 'flex', gap: '12px', fontSize: '0.82rem' }}>
                  <span>Total: <strong>{dryRunResult.totalFiles}</strong> photos</span>
                  <span>Size: <strong>{formatBytes(dryRunResult.totalSize)}</strong></span>
                  <span>Target Folders: <strong>{dryRunResult.targetFolders.length}</strong></span>
                  {dryRunResult.duplicateCount > 0 && (
                    <span style={{ color: 'var(--accent-amber)' }}>
                      Duplicates: <strong>{dryRunResult.duplicateCount}</strong>
                    </span>
                  )}
                </div>

                <button
                  className="btn btn-primary"
                  onClick={handleStartOrganizing}
                  disabled={isOrganizing || dryRunResult.totalFiles === 0}
                  style={{
                    backgroundColor: 'var(--accent-emerald)',
                    padding: '9px 22px',
                    fontSize: '0.88rem',
                    fontWeight: 700,
                    gap: '8px',
                  }}
                >
                  <Play size={16} />
                  <span>{isOrganizing ? 'Organizing...' : `Execute ${mode === 'copy' ? 'Copy' : 'Move'}`}</span>
                </button>
              </div>
            </div>
          )}

          {/* Split Pane Body — desktop keeps the fixed 520px side-by-side
              layout; mobile stacks the tree pane above the content pane
              (each full width) and swaps the fixed height for a flexible,
              scrollable one so it fits 375-600px viewports instead of
              overflowing horizontally or wasting/constraining vertical space. */}
          <div style={{
            display: 'flex',
            flexDirection: isMobile ? 'column' : 'row',
            height: isMobile ? 'auto' : '520px',
            maxHeight: isMobile ? '75vh' : undefined,
            overflow: isMobile ? 'auto' : 'hidden',
          }}>
            {/* Left Pane: Hierarchical Tree View */}
            <div style={{
              width: isMobile ? '100%' : '290px',
              minWidth: isMobile ? '0' : '290px',
              borderRight: isMobile ? 'none' : '1px solid var(--border-subtle)',
              borderBottom: isMobile ? '1px solid var(--border-subtle)' : 'none',
              backgroundColor: 'var(--bg-app)',
              display: 'flex',
              flexDirection: 'column',
              padding: '14px',
              flexShrink: 0,
            }}>
              <div style={{
                fontSize: '0.75rem',
                textTransform: 'uppercase',
                color: 'var(--text-muted)',
                fontWeight: 700,
                letterSpacing: '0.05em',
                marginBottom: '10px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}>
                <span>Target Folder Tree</span>
                <span style={{ fontSize: '0.7rem', color: 'var(--accent-cyan)' }}>
                  {dryRunResult.targetFolders.length} folders
                </span>
              </div>

              <div style={{
                flex: isMobile ? undefined : 1,
                maxHeight: isMobile ? '220px' : undefined,
                overflowY: 'auto',
                display: 'flex',
                flexDirection: 'column',
                gap: '4px',
              }}>
                {/* Root All Folders Node */}
                {renderTreeNode(folderTree)}
              </div>
            </div>

            {/* Right Pane: Photo Review Grid & Inspector */}
            <div style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              backgroundColor: 'var(--bg-surface)',
              overflow: isMobile ? 'visible' : 'hidden',
              minWidth: isMobile ? 0 : undefined,
            }}>
              {/* Review Filter Bar — wraps to a second row on mobile instead
                  of squeezing the folder label, search box and view toggle
                  into one row that doesn't fit a phone width. */}
              <div style={{
                padding: '10px 18px',
                borderBottom: '1px solid var(--border-subtle)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                flexWrap: isMobile ? 'wrap' : 'nowrap',
                gap: '12px',
                backgroundColor: 'var(--bg-surface)',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0, width: isMobile ? '100%' : undefined }}>
                  <Folder size={16} color="var(--accent-cyan)" />
                  <span style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {selectedFolderPath === '__ALL__' ? 'All Folders' : selectedFolderPath}
                  </span>
                  <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                    ({displayedPhotos.length} photos)
                  </span>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', width: isMobile ? '100%' : undefined }}>
                  {/* Search Input */}
                  <div style={{ position: 'relative', width: isMobile ? '100%' : '200px', flex: isMobile ? 1 : undefined }}>
                    <Search size={14} style={{ position: 'absolute', left: '10px', top: '10px', color: 'var(--text-muted)' }} />
                    <input
                      type="text"
                      className="input"
                      placeholder="Search photo name..."
                      value={searchTerm}
                      onChange={(e) => setSearchTerm(e.target.value)}
                      style={{ paddingLeft: '30px', height: '32px', fontSize: '0.78rem' }}
                    />
                    {searchTerm && (
                      <button
                        onClick={() => setSearchTerm('')}
                        style={{ position: 'absolute', right: '8px', top: '8px', background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}
                      >
                        <X size={14} />
                      </button>
                    )}
                  </div>

                  {/* Grid / Table Toggle */}
                  <div style={{ display: 'flex', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' }}>
                    <button
                      onClick={() => setViewMode('grid')}
                      style={{
                        padding: '6px 10px',
                        background: viewMode === 'grid' ? 'var(--bg-surface-elevated)' : 'transparent',
                        border: 'none',
                        color: viewMode === 'grid' ? 'var(--accent-primary)' : 'var(--text-muted)',
                        cursor: 'pointer',
                      }}
                      title="Grid View with Thumbnails"
                    >
                      <Grid size={15} />
                    </button>
                    <button
                      onClick={() => setViewMode('table')}
                      style={{
                        padding: '6px 10px',
                        background: viewMode === 'table' ? 'var(--bg-surface-elevated)' : 'transparent',
                        border: 'none',
                        color: viewMode === 'table' ? 'var(--accent-primary)' : 'var(--text-muted)',
                        cursor: 'pointer',
                      }}
                      title="Table View"
                    >
                      <List size={15} />
                    </button>
                  </div>
                </div>
              </div>

              {/* Photos Content Area — on mobile this relies on the outer
                  split-pane body's single scroll region instead of its own
                  nested scrollbar, since that outer region is now the
                  flexible/scrollable container replacing the fixed 520px pane. */}
              <div style={{ flex: isMobile ? undefined : 1, overflowY: isMobile ? 'visible' : 'auto', padding: '16px' }}>
                {displayedPhotos.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--text-muted)' }}>
                    <ImageIcon size={42} style={{ margin: '0 auto 12px', opacity: 0.5 }} />
                    <div style={{ fontSize: '0.9rem', fontWeight: 600 }}>No photos match this folder or search</div>
                  </div>
                ) : viewMode === 'grid' ? (
                  <div style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
                    gap: '14px',
                  }}>
                    {displayedPhotos.map((item, idx) => {
                      const fileName = item.sourceFile.split(/[\\/]/).pop() || item.sourceFile;
                      const relTarget = getRelativeFolder(item.targetFile, targetDir);

                      return (
                        <div
                          key={idx}
                          onClick={() => setPreviewPhoto(item)}
                          style={{
                            backgroundColor: 'var(--bg-surface-elevated)',
                            borderRadius: 'var(--radius-md)',
                            border: '1px solid var(--border-subtle)',
                            overflow: 'hidden',
                            cursor: 'pointer',
                            transition: 'all 0.15s ease',
                            display: 'flex',
                            flexDirection: 'column',
                          }}
                        >
                          {/* Thumbnail Image */}
                          <div style={{ height: '130px', backgroundColor: '#0f172a', position: 'relative' }}>
                            <img
                              src={getLocalPhotoUrl(item.sourceFile)}
                              alt={fileName}
                              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                              loading="lazy"
                            />
                            {/* Action Badge */}
                            <span
                              style={{
                                position: 'absolute',
                                top: '6px',
                                right: '6px',
                                padding: '2px 6px',
                                borderRadius: '4px',
                                fontSize: '0.68rem',
                                fontWeight: 700,
                                backgroundColor: item.isDuplicate ? 'rgba(245, 158, 11, 0.9)' : 'rgba(16, 185, 129, 0.9)',
                                color: 'white',
                                boxShadow: '0 2px 4px rgba(0,0,0,0.5)',
                              }}
                            >
                              {item.conflictAction.toUpperCase()}
                            </span>
                          </div>

                          {/* Details */}
                          <div style={{ padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: '3px' }}>
                            <div
                              style={{
                                fontSize: '0.78rem',
                                fontWeight: 600,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                              title={fileName}
                            >
                              {fileName}
                            </div>
                            <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                              {new Date(item.date).toLocaleDateString()} • {formatBytes(item.fileSize)}
                            </div>
                            <div
                              style={{
                                fontSize: '0.68rem',
                                color: 'var(--accent-cyan)',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                                marginTop: '2px',
                              }}
                              title={item.targetFile}
                            >
                              📁 {relTarget}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  /* Table View — wrapped so its multiple columns scroll
                     horizontally on mobile instead of overflowing the
                     viewport or squeezing illegibly narrow. */
                  <div style={{ overflowX: isMobile ? 'auto' : 'visible' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.78rem', fontFamily: 'var(--font-mono)' }}>
                    <thead>
                      <tr style={{ borderBottom: '1px solid var(--border-subtle)', backgroundColor: 'var(--bg-surface-elevated)', color: 'var(--text-muted)' }}>
                        <th style={{ padding: '8px 12px' }}>Photo</th>
                        <th style={{ padding: '8px 12px' }}>Capture Date</th>
                        <th style={{ padding: '8px 12px' }}>Target Folder</th>
                        <th style={{ padding: '8px 12px' }}>Size</th>
                        <th style={{ padding: '8px 12px' }}>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {displayedPhotos.map((item, idx) => {
                        const fileName = item.sourceFile.split(/[\\/]/).pop() || item.sourceFile;
                        const relTarget = getRelativeFolder(item.targetFile, targetDir);

                        return (
                          <tr
                            key={idx}
                            onClick={() => setPreviewPhoto(item)}
                            style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.04)', cursor: 'pointer' }}
                          >
                            <td style={{ padding: '6px 12px', display: 'flex', alignItems: 'center', gap: '8px', maxWidth: '240px' }}>
                              <img
                                src={getLocalPhotoUrl(item.sourceFile)}
                                alt=""
                                style={{ width: '28px', height: '28px', borderRadius: '4px', objectFit: 'cover' }}
                              />
                              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={fileName}>
                                {fileName}
                              </span>
                            </td>
                            <td style={{ padding: '6px 12px', color: 'var(--text-secondary)' }}>
                              {new Date(item.date).toLocaleDateString()}
                            </td>
                            <td style={{ padding: '6px 12px', color: 'var(--accent-cyan)', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '220px' }} title={item.targetFile}>
                              📁 {relTarget}
                            </td>
                            <td style={{ padding: '6px 12px', color: 'var(--text-muted)' }}>
                              {formatBytes(item.fileSize)}
                            </td>
                            <td style={{ padding: '6px 12px' }}>
                              <span style={{
                                padding: '2px 6px',
                                borderRadius: '4px',
                                fontSize: '0.72rem',
                                fontWeight: 700,
                                backgroundColor: item.isDuplicate ? 'rgba(245, 158, 11, 0.15)' : 'rgba(16, 185, 129, 0.15)',
                                color: item.isDuplicate ? 'var(--accent-amber)' : 'var(--accent-emerald)',
                              }}>
                                {item.conflictAction.toUpperCase()}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Active Progress Bar */}
      {isOrganizing && progress && (
        <div style={{
          marginTop: '16px',
          backgroundColor: 'var(--bg-surface)',
          borderRadius: 'var(--radius-md)',
          padding: '20px',
          border: '1px solid var(--border-subtle)',
          marginBottom: '20px',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', marginBottom: '8px' }}>
            <span>Processing: <strong>{progress.currentFile}</strong></span>
            <span>{progress.current} / {progress.total}</span>
          </div>
          <div style={{
            height: '8px',
            borderRadius: 'var(--radius-full)',
            backgroundColor: 'var(--bg-surface-elevated)',
            overflow: 'hidden',
          }}>
            <div style={{
              height: '100%',
              width: `${(progress.current / (progress.total || 1)) * 100}%`,
              backgroundColor: 'var(--accent-primary)',
              transition: 'width 0.2s ease',
            }} />
          </div>
        </div>
      )}

      {/* Completion Summary */}
      {completedSummary && (
        <div style={{
          marginTop: '16px',
          backgroundColor: 'rgba(16, 185, 129, 0.12)',
          border: '1px solid rgba(16, 185, 129, 0.3)',
          borderRadius: 'var(--radius-lg)',
          padding: '24px',
          display: 'flex',
          alignItems: 'center',
          gap: '16px',
          marginBottom: '20px',
        }}>
          <CheckCircle2 size={32} color="var(--accent-emerald)" />
          <div>
            <h3 style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--accent-emerald)', marginBottom: '4px' }}>
              Organization Completed Successfully!
            </h3>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
              Successfully organized {completedSummary.movedCount} photos into date folders in {targetDir}.
            </p>
          </div>
        </div>
      )}

      {/* Fullscreen Photo Preview Modal */}
      {previewPhoto && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(2, 6, 23, 0.92)',
            backdropFilter: 'blur(12px)',
            zIndex: 4500,
            display: 'flex',
            flexDirection: 'column',
          }}
          onClick={() => setPreviewPhoto(null)}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '16px 24px',
              borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div>
              <div style={{ fontSize: '1rem', fontWeight: 700, color: 'white' }}>
                {previewPhoto.sourceFile.split(/[\\/]/).pop()}
              </div>
              <div style={{ fontSize: '0.8rem', color: 'var(--accent-cyan)', marginTop: '2px' }}>
                Target: {previewPhoto.targetFile}
              </div>
            </div>

            <button
              className="btn btn-ghost btn-icon"
              onClick={() => setPreviewPhoto(null)}
              style={{ color: 'white', width: '38px', height: '38px' }}
            >
              <X size={24} />
            </button>
          </div>

          <div
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '24px',
              overflow: 'hidden',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <img
              src={getLocalPhotoUrl(previewPhoto.sourceFile)}
              alt=""
              style={{
                maxWidth: '100%',
                maxHeight: '100%',
                objectFit: 'contain',
                borderRadius: 'var(--radius-md)',
                boxShadow: '0 20px 40px rgba(0,0,0,0.8)',
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
};
