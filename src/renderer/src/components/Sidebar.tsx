import React, { useState } from 'react';
import {
  Image as ImageIcon,
  Users,
  MapPin,
  FolderSync,
  Heart,
  FolderOpen,
  Sparkles,
  Layers,
  HardDrive,
  RefreshCw,
  FolderTree,
  HelpCircle,
  Settings,
  BookImage,
  ArrowRightLeft,
  ChevronDown,
  ChevronRight,
  PauseCircle,
} from 'lucide-react';
import { LibraryState } from '../services/libraryStore';
import { VirtualStorageConfig, NetworkStorageProgress } from '../../types';
import { useBackgroundActivityStatus } from '../hooks/useBackgroundActivityStatus';

export type ActiveTab =
  | 'photos'
  | 'albums'
  | 'people'
  | 'places'
  | 'organize'
  | 'virtual_storage'
  | 'favorites'
  | 'folders'
  | 'settings';

interface SidebarProps {
  activeTab: ActiveTab;
  onSelectTab: (tab: ActiveTab) => void;
  state: LibraryState;
  onOpenFolder: () => void;
  onTriggerFaceDetection: () => void;
  virtualStorages?: VirtualStorageConfig[];
  storageProgressMap?: Record<string, NetworkStorageProgress>;
  onSelectStorage?: (storage: VirtualStorageConfig) => void;
  onRefreshStorage?: (storage: VirtualStorageConfig) => void;
  onOpenDuplicateCleaner?: () => void;
  onOpenHelp?: () => void;
  onOpenAiAssistant?: () => void;
  onOpenLibrarySwitcher?: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  activeTab,
  onSelectTab,
  state,
  onOpenFolder,
  onTriggerFaceDetection,
  virtualStorages = [],
  storageProgressMap = {},
  onSelectStorage,
  onRefreshStorage,
  onOpenDuplicateCleaner,
  onOpenHelp,
  onOpenAiAssistant,
  onOpenLibrarySwitcher,
}) => {
  const [isLibraryCollapsed, setIsLibraryCollapsed] = useState(false);
  const [isNetworkStorageCollapsed, setIsNetworkStorageCollapsed] = useState(false);
  const backgroundActivity = useBackgroundActivityStatus(state.isDetectingFaces, state.faceDetectionProgress ?? null, storageProgressMap);

  const navItems = [
    { id: 'photos' as ActiveTab, label: 'Photos', icon: ImageIcon, count: state.totalCount || state.photos.length },
    { id: 'albums' as ActiveTab, label: 'Albums', icon: BookImage, count: (state.albums || []).length },
    { id: 'people' as ActiveTab, label: 'People', icon: Users, count: state.people.length },
    { id: 'places' as ActiveTab, label: 'Places', icon: MapPin, count: state.places.length },
    { id: 'favorites' as ActiveTab, label: 'Favorites', icon: Heart, count: state.photos.filter((p) => p.isFavorite).length },
    { id: 'virtual_storage' as ActiveTab, label: 'Network Mirrors', icon: HardDrive },
    { id: 'folders' as ActiveTab, label: 'Folder Tree', icon: FolderTree },
    { id: 'organize' as ActiveTab, label: 'Organize by Date', icon: FolderSync },
    { id: 'settings' as ActiveTab, label: 'Settings & Mobile', icon: Settings },
  ];

  return (
    <aside
      className="sidebar-scrollable"
      style={{
        width: '260px',
        minWidth: '260px',
        height: '100%',
        maxHeight: '100vh',
        backgroundColor: 'var(--bg-surface)',
        borderRight: '1px solid var(--border-subtle)',
        display: 'flex',
        flexDirection: 'column',
        padding: '20px 14px',
        gap: '16px',
        overflowY: 'auto',
        overflowX: 'hidden',
        boxSizing: 'border-box',
      }}
    >
      {/* Brand Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 6px', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div
            style={{
              width: '40px',
              height: '40px',
              borderRadius: 'var(--radius-md)',
              background: 'var(--accent-gradient)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: 'var(--shadow-glow)',
            }}
          >
            <Sparkles size={20} color="white" />
          </div>
          <div>
            <h1 style={{ fontSize: '1.15rem', fontWeight: 700, letterSpacing: '-0.02em', color: 'var(--text-primary)', margin: 0 }}>
              gPhotos
            </h1>
            <span style={{ fontSize: '0.73rem', color: 'var(--text-muted)', fontWeight: 500 }}>
              Desktop Edition
            </span>
          </div>
        </div>

        {onOpenHelp && (
          <button
            className="btn btn-ghost btn-icon"
            onClick={onOpenHelp}
            style={{
              width: '34px',
              height: '34px',
              borderRadius: 'var(--radius-full)',
              color: 'var(--accent-primary)',
              backgroundColor: 'rgba(59, 130, 246, 0.1)',
            }}
            title="User Guide & Feature Help"
          >
            <HelpCircle size={18} />
          </button>
        )}
      </div>

      {/* Action Buttons */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', flexShrink: 0 }}>
        <button
          className="btn btn-primary"
          onClick={onOpenFolder}
          disabled={state.isScanning}
          style={{ width: '100%', justifyContent: 'flex-start', height: '40px', gap: '10px' }}
        >
          <FolderOpen size={18} />
          <span>{state.isScanning ? 'Scanning...' : 'Scan Photo Folder'}</span>
        </button>

        {state.photos.length > 0 && (
          <button
            className="btn btn-secondary"
            onClick={onTriggerFaceDetection}
            disabled={state.isDetectingFaces}
            style={{ width: '100%', justifyContent: 'flex-start', fontSize: '0.82rem', height: '38px', gap: '10px' }}
          >
            <Sparkles size={17} color="#ec4899" />
            <span>
              {state.isDetectingFaces
                ? `Scanning Faces (${state.faceDetectionProgress?.current || 0}/${state.faceDetectionProgress?.total || 0})`
                : 'Detect & Cluster Faces'}
            </span>
          </button>
        )}

        {state.photos.length > 1 && onOpenDuplicateCleaner && (
          <button
            className="btn btn-secondary"
            onClick={onOpenDuplicateCleaner}
            style={{ width: '100%', justifyContent: 'flex-start', fontSize: '0.82rem', height: '38px', gap: '10px' }}
            title="Cluster similar photos and suggest best shots to keep"
          >
            <Layers size={17} color="#818cf8" />
            <span>Clean Duplicates</span>
          </button>
        )}

        {onOpenAiAssistant && (
          <button
            className="btn btn-secondary"
            onClick={onOpenAiAssistant}
            style={{
              width: '100%',
              justifyContent: 'flex-start',
              fontSize: '0.82rem',
              height: '38px',
              gap: '10px',
              background: 'linear-gradient(135deg, rgba(99, 102, 241, 0.15) 0%, rgba(168, 85, 247, 0.15) 100%)',
              borderColor: 'rgba(168, 85, 247, 0.35)',
            }}
            title="Chat with AI assistant to search photos, people combinations, places and memories"
          >
            <Sparkles size={17} color="#c084fc" />
            <span>Search with AI</span>
          </button>
        )}
      </div>

      {/* Navigation Sections */}
      <nav style={{ display: 'flex', flexDirection: 'column', gap: '12px', flexShrink: 0 }}>
        {/* Section 1: Collapsible Library */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
          <button
            type="button"
            onClick={() => setIsLibraryCollapsed(!isLibraryCollapsed)}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '6px 10px',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: 'var(--text-muted)',
              fontSize: '0.72rem',
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              borderRadius: 'var(--radius-sm)',
              transition: 'background 0.15s ease',
            }}
            title={isLibraryCollapsed ? 'Expand Library items' : 'Collapse Library items'}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              {isLibraryCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
              <span>Library</span>
            </div>
            <span
              style={{
                fontSize: '0.68rem',
                padding: '1px 6px',
                borderRadius: '9999px',
                backgroundColor: 'rgba(255, 255, 255, 0.07)',
                color: 'var(--text-muted)',
                fontWeight: 600,
              }}
            >
              {state.totalCount || state.photos.length}
            </span>
          </button>

          {!isLibraryCollapsed && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', marginTop: '2px' }}>
              {navItems.map((item) => {
                const Icon = item.icon;
                const isActive = activeTab === item.id;
                return (
                  <button
                    key={item.id}
                    onClick={() => onSelectTab(item.id)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '9px 12px',
                      borderRadius: 'var(--radius-md)',
                      backgroundColor: isActive ? 'var(--bg-surface-elevated)' : 'transparent',
                      color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
                      border: 'none',
                      cursor: 'pointer',
                      fontFamily: 'var(--font-sans)',
                      fontSize: '0.88rem',
                      fontWeight: isActive ? 600 : 500,
                      transition: 'all var(--transition-fast)',
                      borderLeft: isActive ? '3px solid var(--accent-primary)' : '3px solid transparent',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <Icon size={18} color={isActive ? '#60a5fa' : 'currentColor'} />
                      <span>{item.label}</span>
                    </div>
                    {item.count !== undefined && (
                      <span
                        style={{
                          fontSize: '0.72rem',
                          padding: '2px 7px',
                          borderRadius: 'var(--radius-full)',
                          backgroundColor: isActive ? 'rgba(59, 130, 246, 0.2)' : 'rgba(255, 255, 255, 0.05)',
                          color: isActive ? '#93c5fd' : 'var(--text-muted)',
                          fontWeight: 600,
                        }}
                      >
                        {item.count}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Section 2: Collapsible Network Storage / Mirrors */}
        {virtualStorages && virtualStorages.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', marginTop: '6px' }}>
            <button
              type="button"
              onClick={() => setIsNetworkStorageCollapsed(!isNetworkStorageCollapsed)}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '6px 10px',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                color: 'var(--text-muted)',
                fontSize: '0.72rem',
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                borderRadius: 'var(--radius-sm)',
                transition: 'background 0.15s ease',
              }}
              title={isNetworkStorageCollapsed ? 'Expand Network Storages' : 'Collapse Network Storages'}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                {isNetworkStorageCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                <span>Network Storage</span>
              </div>
              <span
                style={{
                  fontSize: '0.68rem',
                  padding: '1px 6px',
                  borderRadius: '9999px',
                  backgroundColor: 'rgba(6, 182, 212, 0.15)',
                  color: 'var(--accent-cyan)',
                  fontWeight: 600,
                }}
              >
                {virtualStorages.length}
              </span>
            </button>

            {!isNetworkStorageCollapsed && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', marginTop: '2px' }}>
                {virtualStorages.map((storage) => {
                  const isStorageActive =
                    state.selectedFolder &&
                    (state.selectedFolder.toLowerCase().includes(storage.name.toLowerCase()) ||
                      state.photos.some((p) => p.isVirtual && p.storageName === storage.name));
                  const prog = storageProgressMap[storage.name] || storageProgressMap[storage.id];
                  const isProgressActive = prog && prog.phase && prog.phase !== 'idle';

                  return (
                    <div
                      key={storage.id}
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        padding: '7px 10px',
                        borderRadius: 'var(--radius-md)',
                        backgroundColor: isStorageActive ? 'rgba(6, 182, 212, 0.12)' : 'transparent',
                        border: isStorageActive ? '1px solid rgba(6, 182, 212, 0.3)' : '1px solid transparent',
                        cursor: 'pointer',
                        transition: 'all var(--transition-fast)',
                        gap: isProgressActive ? '6px' : '0px',
                      }}
                      onClick={() => onSelectStorage && onSelectStorage(storage)}
                      title={`Source: ${storage.networkSourcePath}\nClick to browse photos`}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0, flex: 1 }}>
                          <HardDrive size={15} color={isStorageActive ? 'var(--accent-cyan)' : 'var(--text-muted)'} style={{ flexShrink: 0 }} />
                          <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
                            <div
                              style={{
                                fontSize: '0.8rem',
                                fontWeight: isStorageActive ? 600 : 500,
                                color: isStorageActive ? 'var(--text-primary)' : 'var(--text-secondary)',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                              }}
                            >
                              {storage.name}
                            </div>
                            <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>
                              {/* inventoryTotalFiles is the single fixed count
                                  every UI surface is meant to show once
                                  inventory completes (see VirtualStorageConfig's
                                  doc comment) — totalItems instead reflects
                                  whatever the last FULLY COMPLETED sync pass
                                  processed, which for a large library whose
                                  first pass is still catching up on face
                                  detection (thumbnails done, faces lagging)
                                  stays far below the real total until that
                                  entire pass finishes end to end. */}
                              {(storage.inventoryStatus === 'completed' ? storage.inventoryTotalFiles : undefined) ?? storage.totalItems ?? 0} photos
                            </div>
                          </div>
                        </div>

                        <button
                          className="btn btn-ghost btn-icon"
                          style={{
                            width: '24px',
                            height: '24px',
                            padding: 0,
                            color: isProgressActive ? '#f472b6' : 'var(--accent-cyan)',
                            flexShrink: 0,
                          }}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (onRefreshStorage) onRefreshStorage(storage);
                          }}
                          title="Rescan remote folder for new photos & detect faces"
                        >
                          <RefreshCw
                            size={12}
                            style={{
                              animation: isProgressActive && prog.phase !== 'completed' ? 'spin 1.5s linear infinite' : 'none',
                            }}
                          />
                        </button>
                      </div>

                      {/* Live progress: a stable "Cached X/Y · Faces X/Y" stat
                          row that only ever updates its numbers in place —
                          the previous version swapped between entirely
                          different single-line messages ("Scanning...",
                          "Thumbnails: X/Y", "Faces: X/Y", "✓ Up to date")
                          with a different text color and progress-bar color
                          at each phase change. That was fine when a sync
                          took minutes, but now that an already-cached
                          storage's refresh finishes in a couple of seconds
                          (see the clustering/thumbnail fixes), those phases
                          fly by fast enough to read as a flicker/blink
                          rather than a smooth fill — and made a refresh of
                          an up-to-date storage look like it was "re-caching
                          everything" even though every file was just a fast
                          skip-check. One stable layout, one color, numbers
                          only, fixes both. */}
                      {isProgressActive && (
                        <div
                          style={{
                            width: '100%',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '3px',
                            paddingTop: '2px',
                          }}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.65rem' }}>
                            <span
                              style={{
                                color:
                                  prog.phase === 'completed'
                                    ? '#10b981'
                                    : prog.phase === 'error'
                                    ? '#ef4444'
                                    : 'var(--text-muted)',
                                fontWeight: 600,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                                maxWidth: '140px',
                              }}
                            >
                              {prog.phase === 'error'
                                ? 'Sync error'
                                : prog.phase === 'completed'
                                ? '✓ Up to date'
                                : prog.phase === 'scanning' && !prog.thumbnailTotal
                                ? 'Scanning remote folder...'
                                : `Cached ${prog.thumbnailCurrent}/${prog.thumbnailTotal || '?'} · Faces ${prog.faceCurrent}/${prog.faceTotal || '?'}`}
                            </span>
                            <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)', fontWeight: 600 }}>
                              {prog.percent}%
                            </span>
                          </div>

                          <div
                            style={{
                              width: '100%',
                              height: '4px',
                              borderRadius: '2px',
                              backgroundColor: 'rgba(255, 255, 255, 0.08)',
                              overflow: 'hidden',
                            }}
                          >
                            <div
                              style={{
                                height: '100%',
                                width: `${Math.min(100, Math.max(prog.phase === 'scanning' ? 12 : 0, prog.percent))}%`,
                                background:
                                  prog.phase === 'completed'
                                    ? '#10b981'
                                    : prog.phase === 'error'
                                    ? '#ef4444'
                                    : 'var(--accent-cyan)',
                                transition: 'width 0.25s ease',
                              }}
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </nav>

      {/* Current Folder / Library Switcher Widget */}
      <div
        style={{
          padding: '12px',
          borderRadius: 'var(--radius-md)',
          backgroundColor: 'rgba(255, 255, 255, 0.04)',
          border: '1px solid var(--border-subtle)',
          fontSize: '0.75rem',
          display: 'flex',
          flexDirection: 'column',
          gap: '6px',
          flexShrink: 0,
          marginTop: 'auto',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>Active Library:</span>
          {onOpenLibrarySwitcher && (
            <button
              className="btn btn-ghost"
              onClick={onOpenLibrarySwitcher}
              style={{
                fontSize: '0.72rem',
                padding: '2px 8px',
                height: 'auto',
                color: 'var(--accent-primary)',
                fontWeight: 600,
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
              }}
              title="Change or switch to another photo library"
            >
              <ArrowRightLeft size={11} />
              <span>Switch</span>
            </button>
          )}
        </div>
        <div
          onClick={onOpenLibrarySwitcher}
          style={{
            color: state.selectedFolder ? 'var(--text-secondary)' : 'var(--text-muted)',
            fontWeight: 500,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            cursor: onOpenLibrarySwitcher ? 'pointer' : 'default',
          }}
          title={state.selectedFolder || 'No folder selected. Click to switch or open library.'}
        >
          {state.selectedFolder ? state.selectedFolder : 'Click to select library...'}
        </div>
        {backgroundActivity.label && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              fontSize: '0.7rem',
              color: backgroundActivity.isPaused ? 'var(--text-muted)' : 'var(--accent-cyan)',
              fontWeight: 500,
            }}
            title={backgroundActivity.isPaused ? 'Background caching/face detection is paused while you use the app' : undefined}
          >
            {backgroundActivity.isPaused ? (
              <PauseCircle size={11} style={{ flexShrink: 0 }} />
            ) : (
              <RefreshCw size={11} className="animate-spin" style={{ animationDuration: '1.1s', flexShrink: 0 }} />
            )}
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{backgroundActivity.label}</span>
          </div>
        )}
      </div>

      {/* User Guide & Manual Link */}
      {onOpenHelp && (
        <button
          className="btn btn-ghost"
          onClick={onOpenHelp}
          style={{
            width: '100%',
            justifyContent: 'flex-start',
            gap: '10px',
            fontSize: '0.82rem',
            color: 'var(--text-secondary)',
            padding: '8px 12px',
            flexShrink: 0,
          }}
          title="Open User Guide & Feature Manual"
        >
          <HelpCircle size={16} color="var(--accent-primary)" />
          <span>User Guide & Help</span>
        </button>
      )}
    </aside>
  );
};
