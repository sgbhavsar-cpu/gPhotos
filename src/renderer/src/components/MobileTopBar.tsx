import React from 'react';
import {
  Image as ImageIcon,
  FolderOpen,
  Sparkles,
  Layers,
  Menu as MenuIcon,
  Search,
  ArrowRightLeft
} from 'lucide-react';

interface MobileTopBarProps {
  selectedFolder: string | null;
  onOpenLibrarySwitcher: () => void;
  onOpenAiAssistant: () => void;
  onOpenDuplicateCleaner: () => void;
  onToggleDrawer: () => void;
}

export const MobileTopBar: React.FC<MobileTopBarProps> = ({
  selectedFolder,
  onOpenLibrarySwitcher,
  onOpenAiAssistant,
  onOpenDuplicateCleaner,
  onToggleDrawer,
}) => {
  const folderName = selectedFolder
    ? selectedFolder.split(/[/\\]/).filter(Boolean).pop() || 'Library'
    : 'Select Library';

  return (
    <header
      style={{
        position: 'sticky',
        top: 0,
        left: 0,
        right: 0,
        height: '56px',
        backgroundColor: 'rgba(15, 23, 42, 0.88)',
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
        borderBottom: '1px solid var(--border-subtle)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 12px',
        zIndex: 100,
        gap: '8px',
      }}
    >
      {/* Brand & Active Library Button */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0, flex: 1 }}>
        <div
          style={{
            width: '32px',
            height: '32px',
            borderRadius: 'var(--radius-md)',
            background: 'var(--accent-gradient)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0 2px 8px rgba(59, 130, 246, 0.4)',
            flexShrink: 0,
          }}
        >
          <ImageIcon size={18} color="white" />
        </div>

        <button
          onClick={onOpenLibrarySwitcher}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            backgroundColor: 'rgba(255, 255, 255, 0.06)',
            border: '1px solid rgba(255, 255, 255, 0.1)',
            borderRadius: '9999px',
            padding: '4px 10px',
            color: 'var(--text-primary)',
            fontSize: '0.8rem',
            fontWeight: 600,
            cursor: 'pointer',
            minWidth: 0,
            maxWidth: '180px',
          }}
          title="Switch Library Folder"
        >
          <FolderOpen size={13} color="var(--accent-cyan)" style={{ flexShrink: 0 }} />
          <span
            style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {folderName}
          </span>
          <ArrowRightLeft size={11} color="var(--text-muted)" style={{ flexShrink: 0 }} />
        </button>
      </div>

      {/* Action Buttons */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}>
        <button
          className="btn btn-ghost btn-icon"
          onClick={onOpenAiAssistant}
          style={{ width: '36px', height: '36px', borderRadius: '50%' }}
          title="AI Smart Search"
        >
          <Sparkles size={18} color="#c084fc" />
        </button>

        <button
          className="btn btn-ghost btn-icon"
          onClick={onOpenDuplicateCleaner}
          style={{ width: '36px', height: '36px', borderRadius: '50%' }}
          title="Duplicate & Burst Cleaner"
        >
          <Layers size={18} color="var(--accent-cyan)" />
        </button>

        <button
          className="btn btn-ghost btn-icon"
          onClick={onToggleDrawer}
          style={{ width: '36px', height: '36px', borderRadius: '50%' }}
          title="Menu & Features"
        >
          <MenuIcon size={20} color="var(--text-primary)" />
        </button>
      </div>
    </header>
  );
};
