import React from 'react';
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
  ArrowRightLeft
} from 'lucide-react';
import { LibraryState } from '../services/libraryStore';
import { VirtualStorageConfig } from '../../types';

export type ActiveTab = 'photos' | 'albums' | 'people' | 'places' | 'organize' | 'virtual_storage' | 'favorites' | 'folders' | 'settings';

interface SidebarProps {
  activeTab: ActiveTab;
  onSelectTab: (tab: ActiveTab) => void;
  state: LibraryState;
  onOpenFolder: () => void;
  onTriggerFaceDetection: () => void;
  virtualStorages?: VirtualStorageConfig[];
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
  onSelectStorage,
  onRefreshStorage,
  onOpenDuplicateCleaner,
  onOpenHelp,
  onOpenAiAssistant,
  onOpenLibrarySwitcher,
}) => {
  const navItems = [
    { id: 'photos' as ActiveTab, label: 'Photos', icon: ImageIcon, count: state.photos.length },
    { id: 'albums' as ActiveTab, label: 'Albums', icon: BookImage, count: (state.albums || []).length },
    { id: 'people' as ActiveTab, label: 'People', icon: Users, count: state.people.length },
    { id: 'places' as ActiveTab, label: 'Places', icon: MapPin, count: state.places.length },
    { id: 'favorites' as ActiveTab, label: 'Favorites', icon: Heart, count: state.photos.filter((p) => p.isFavorite).length },
    { id: 'virtual_storage' as ActiveTab, label: 'Network Mirrors', icon: HardDrive },
    { id: 'folders' as ActiveTab, label: 'Folder Tree', icon: FolderTree },
    { id: 'organize' as ActiveTab, label: 'Organize by Date', icon: FolderSync },
    { id: 'settings' as ActiveTab, label: 'Settings & Service', icon: Settings },
  ];

  return (
    <aside style={{
      width: '260px',
      minWidth: '260px',
      height: '100%',
      backgroundColor: 'var(--bg-surface)',
      borderRight: '1px solid var(--border-subtle)',
      display: 'flex',
      flexDirection: 'column',
      padding: '20px 16px',
      gap: '24px',
    }}>
      {/* Brand Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{
            width: '42px',
            height: '42px',
            borderRadius: 'var(--radius-md)',
            background: 'var(--accent-gradient)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: 'var(--shadow-glow)',
          }}>
            <Sparkles size={22} color="white" />
          </div>
          <div>
            <h1 style={{ fontSize: '1.18rem', fontWeight: 700, letterSpacing: '-0.02em', color: 'var(--text-primary)', margin: 0 }}>
              gPhotos
            </h1>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: 500 }}>
              Desktop Edition
            </span>
          </div>
        </div>

        {onOpenHelp && (
          <button
            className="btn btn-ghost btn-icon"
            onClick={onOpenHelp}
            style={{
              width: '36px',
              height: '36px',
              borderRadius: 'var(--radius-full)',
              color: 'var(--accent-primary)',
              backgroundColor: 'rgba(59, 130, 246, 0.1)',
            }}
            title="User Guide & Feature Help"
          >
            <HelpCircle size={20} />
          </button>
        )}
      </div>

      {/* Action Buttons */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <button
          className="btn btn-primary"
          onClick={onOpenFolder}
          disabled={state.isScanning}
          style={{ width: '100%', justifyContent: 'flex-start', height: '40px', gap: '10px' }}
        >
          <FolderOpen size={20} />
          <span>{state.isScanning ? 'Scanning...' : 'Scan Photo Folder'}</span>
        </button>

        {state.photos.length > 0 && (
          <button
            className="btn btn-secondary"
            onClick={onTriggerFaceDetection}
            disabled={state.isDetectingFaces}
            style={{ width: '100%', justifyContent: 'flex-start', fontSize: '0.82rem', height: '38px', gap: '10px' }}
          >
            <Sparkles size={18} color="#ec4899" />
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
            <Layers size={18} color="#818cf8" />
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
            <Sparkles size={18} color="#c084fc" />
            <span>Search with AI</span>
          </button>
        )}
      </div>

      {/* Navigation List */}
      <nav style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: 1 }}>
        <div style={{ fontSize: '0.72rem', textTransform: 'uppercase', color: 'var(--text-muted)', fontWeight: 700, padding: '8px 12px 4px', letterSpacing: '0.05em' }}>
          Library
        </div>
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
                padding: '11px 14px',
                borderRadius: 'var(--radius-md)',
                backgroundColor: isActive ? 'var(--bg-surface-elevated)' : 'transparent',
                color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
                border: 'none',
                cursor: 'pointer',
                fontFamily: 'var(--font-sans)',
                fontSize: '0.9rem',
                fontWeight: isActive ? 600 : 500,
                transition: 'all var(--transition-fast)',
                borderLeft: isActive ? '3px solid var(--accent-primary)' : '3px solid transparent',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <Icon size={20} color={isActive ? '#60a5fa' : 'currentColor'} />
                <span>{item.label}</span>
              </div>
              {item.count !== undefined && (
                <span style={{
                  fontSize: '0.75rem',
                  padding: '2px 8px',
                  borderRadius: 'var(--radius-full)',
                  backgroundColor: isActive ? 'rgba(59, 130, 246, 0.2)' : 'rgba(255, 255, 255, 0.05)',
                  color: isActive ? '#93c5fd' : 'var(--text-muted)',
                  fontWeight: 600,
                }}>
                  {item.count}
                </span>
              )}
            </button>
          );
        })}

        {/* Network Storages Quick List */}
        {virtualStorages && virtualStorages.length > 0 && (
          <div style={{ marginTop: '16px', display: 'flex', flexDirection: 'column', gap: '3px' }}>
            <div style={{
              fontSize: '0.7rem',
              textTransform: 'uppercase',
              color: 'var(--text-muted)',
              fontWeight: 700,
              padding: '6px 12px 2px',
              letterSpacing: '0.05em',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}>
              <span>Network Mirrors</span>
              <span style={{ fontSize: '0.68rem', color: 'var(--accent-cyan)' }}>{virtualStorages.length}</span>
            </div>

            {virtualStorages.map((storage) => {
              const isStorageActive =
                state.selectedFolder &&
                (state.selectedFolder.toLowerCase().includes(storage.name.toLowerCase()) ||
                  state.photos.some((p) => p.isVirtual && p.storageName === storage.name));

              return (
                <div
                  key={storage.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '7px 12px',
                    borderRadius: 'var(--radius-md)',
                    backgroundColor: isStorageActive ? 'rgba(6, 182, 212, 0.12)' : 'transparent',
                    border: isStorageActive ? '1px solid rgba(6, 182, 212, 0.3)' : '1px solid transparent',
                    cursor: 'pointer',
                    transition: 'all var(--transition-fast)',
                  }}
                  onClick={() => onSelectStorage && onSelectStorage(storage)}
                  title={`Source: ${storage.networkSourcePath}\nClick to browse photos`}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
                    <HardDrive size={15} color={isStorageActive ? 'var(--accent-cyan)' : 'var(--text-muted)'} />
                    <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      <div style={{
                        fontSize: '0.8rem',
                        fontWeight: isStorageActive ? 600 : 500,
                        color: isStorageActive ? 'var(--text-primary)' : 'var(--text-secondary)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}>
                        {storage.name}
                      </div>
                      <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>
                        {storage.totalItems || 0} photos
                      </div>
                    </div>
                  </div>

                  <button
                    className="btn btn-ghost btn-icon"
                    style={{ width: '24px', height: '24px', padding: 0, color: 'var(--accent-cyan)', flexShrink: 0 }}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (onRefreshStorage) onRefreshStorage(storage);
                    }}
                    title="Rescan remote folder for new photos & detect faces"
                  >
                    <RefreshCw size={12} />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </nav>

      {/* Current Folder / Library Switcher Widget */}
      <div style={{
        padding: '12px',
        borderRadius: 'var(--radius-md)',
        backgroundColor: 'rgba(255, 255, 255, 0.04)',
        border: '1px solid var(--border-subtle)',
        fontSize: '0.75rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
      }}>
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
            marginTop: 'auto',
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
