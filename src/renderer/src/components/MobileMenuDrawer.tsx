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
  FolderTree,
  HelpCircle,
  Settings,
  BookImage,
  ArrowRightLeft,
  X
} from 'lucide-react';
import { ActiveTab } from './Sidebar';
import { LibraryState } from '../services/libraryStore';

interface MobileMenuDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  activeTab: ActiveTab;
  onSelectTab: (tab: ActiveTab) => void;
  state: LibraryState;
  onOpenLibrarySwitcher: () => void;
  onOpenDuplicateCleaner: () => void;
  onOpenHelp: () => void;
  onOpenAiAssistant: () => void;
}

export const MobileMenuDrawer: React.FC<MobileMenuDrawerProps> = ({
  isOpen,
  onClose,
  activeTab,
  onSelectTab,
  state,
  onOpenLibrarySwitcher,
  onOpenDuplicateCleaner,
  onOpenHelp,
  onOpenAiAssistant,
}) => {
  if (!isOpen) return null;

  const navItems = [
    { id: 'photos' as ActiveTab, label: 'Photos Gallery', icon: ImageIcon, count: state.totalCount || state.photos.length },
    { id: 'favorites' as ActiveTab, label: 'Favorites', icon: Heart, count: state.photos.filter((p) => p.isFavorite).length },
    { id: 'albums' as ActiveTab, label: 'Albums', icon: BookImage, count: (state.albums || []).length },
    { id: 'people' as ActiveTab, label: 'People & Faces', icon: Users, count: state.people.length },
    { id: 'places' as ActiveTab, label: 'Places Map', icon: MapPin, count: state.places.length },
    { id: 'folders' as ActiveTab, label: 'Folder Tree View', icon: FolderTree },
    { id: 'virtual_storage' as ActiveTab, label: 'Network Mirrors (NAS/SMB)', icon: HardDrive },
    { id: 'organize' as ActiveTab, label: 'Organize by Date', icon: FolderSync },
    { id: 'settings' as ActiveTab, label: 'Settings & Mobile Server', icon: Settings },
  ];

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 999,
        display: 'flex',
        justifyContent: 'flex-end',
      }}
    >
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: 'absolute',
          inset: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.65)',
          backdropFilter: 'blur(4px)',
          animation: 'fadeIn 0.2s ease-out',
        }}
      />

      {/* Slide Drawer Panel */}
      <div
        style={{
          position: 'relative',
          width: '82vw',
          maxWidth: '320px',
          height: '100%',
          backgroundColor: 'var(--bg-surface)',
          borderLeft: '1px solid var(--border-subtle)',
          boxShadow: '-8px 0 32px rgba(0, 0, 0, 0.6)',
          display: 'flex',
          flexDirection: 'column',
          zIndex: 1000,
          animation: 'slideInRight 0.25s cubic-bezier(0.16, 1, 0.3, 1)',
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: '16px 20px',
            borderBottom: '1px solid var(--border-subtle)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div
              style={{
                width: '32px',
                height: '32px',
                borderRadius: 'var(--radius-md)',
                background: 'var(--accent-gradient)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <ImageIcon size={18} color="white" />
            </div>
            <span style={{ fontWeight: 700, fontSize: '1.05rem', color: 'var(--text-primary)' }}>
              gPhotos Menu
            </span>
          </div>

          <button
            className="btn btn-ghost btn-icon"
            onClick={onClose}
            style={{ width: '32px', height: '32px' }}
          >
            <X size={18} />
          </button>
        </div>

        {/* Active Library Box */}
        <div style={{ padding: '16px 16px 8px 16px' }}>
          <div
            style={{
              backgroundColor: 'var(--bg-surface-elevated)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-md)',
              padding: '12px',
              display: 'flex',
              flexDirection: 'column',
              gap: '8px',
            }}
          >
            <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Active Collection
            </div>
            <div
              style={{
                fontSize: '0.85rem',
                fontWeight: 600,
                color: 'var(--text-primary)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {state.selectedFolder
                ? state.selectedFolder.split(/[/\\]/).filter(Boolean).pop()
                : 'No Folder Selected'}
            </div>
            <button
              className="btn btn-secondary"
              onClick={() => {
                onClose();
                onOpenLibrarySwitcher();
              }}
              style={{ width: '100%', height: '32px', fontSize: '0.8rem', gap: '6px' }}
            >
              <ArrowRightLeft size={13} />
              Switch Library
            </button>
          </div>
        </div>

        {/* Nav Items List */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 12px' }}>
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;

            return (
              <button
                key={item.id}
                onClick={() => {
                  onSelectTab(item.id);
                  onClose();
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '12px',
                  width: '100%',
                  padding: '10px 14px',
                  borderRadius: 'var(--radius-md)',
                  backgroundColor: isActive ? 'var(--accent-gradient)' : 'transparent',
                  color: isActive ? 'white' : 'var(--text-secondary)',
                  border: 'none',
                  cursor: 'pointer',
                  textAlign: 'left',
                  fontSize: '0.88rem',
                  fontWeight: isActive ? 600 : 500,
                  marginBottom: '2px',
                  transition: 'all 0.15s ease',
                }}
              >
                <Icon size={18} />
                <span style={{ flex: 1 }}>{item.label}</span>
                {item.count !== undefined && (
                  <span
                    style={{
                      fontSize: '0.72rem',
                      opacity: isActive ? 0.9 : 0.6,
                      backgroundColor: isActive ? 'rgba(255, 255, 255, 0.2)' : 'rgba(255, 255, 255, 0.05)',
                      padding: '2px 7px',
                      borderRadius: '10px',
                    }}
                  >
                    {item.count}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Quick Tools Footer */}
        <div
          style={{
            padding: '12px 16px 20px 16px',
            borderTop: '1px solid var(--border-subtle)',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
          }}
        >
          <button
            className="btn btn-ghost"
            onClick={() => {
              onClose();
              onOpenAiAssistant();
            }}
            style={{ width: '100%', justifyContent: 'flex-start', gap: '10px', fontSize: '0.82rem' }}
          >
            <Sparkles size={16} color="#c084fc" />
            AI Search Assistant
          </button>
          <button
            className="btn btn-ghost"
            onClick={() => {
              onClose();
              onOpenDuplicateCleaner();
            }}
            style={{ width: '100%', justifyContent: 'flex-start', gap: '10px', fontSize: '0.82rem' }}
          >
            <Layers size={16} color="var(--accent-cyan)" />
            AI Duplicate Cleaner
          </button>
          <button
            className="btn btn-ghost"
            onClick={() => {
              onClose();
              onOpenHelp();
            }}
            style={{ width: '100%', justifyContent: 'flex-start', gap: '10px', fontSize: '0.82rem' }}
          >
            <HelpCircle size={16} color="var(--text-muted)" />
            User Guide & Shortcuts
          </button>
        </div>
      </div>
    </div>
  );
};
