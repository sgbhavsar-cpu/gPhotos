import React from 'react';
import {
  FolderOpen,
  X,
  HardDrive,
  Clock,
  Check,
  FolderTree,
  Trash2,
  Sparkles,
  ArrowRight
} from 'lucide-react';
import { VirtualStorageConfig } from '../../types';

interface LibrarySwitcherModalProps {
  currentLibrary: string | null;
  recentLibraries: string[];
  virtualStorages: VirtualStorageConfig[];
  onSelectLibrary: (folderPath: string) => void;
  onBrowseNewLibrary: () => void;
  onSelectVirtualStorage?: (storage: VirtualStorageConfig) => void;
  onClose: () => void;
}

export const LibrarySwitcherModal: React.FC<LibrarySwitcherModalProps> = ({
  currentLibrary,
  recentLibraries,
  virtualStorages,
  onSelectLibrary,
  onBrowseNewLibrary,
  onSelectVirtualStorage,
  onClose,
}) => {
  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(5, 8, 15, 0.85)',
        backdropFilter: 'blur(8px)',
        zIndex: 3600,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: '100%',
          maxWidth: '640px',
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
            padding: '18px 24px',
            borderBottom: '1px solid var(--border-subtle)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div
              style={{
                width: '38px',
                height: '38px',
                borderRadius: 'var(--radius-md)',
                backgroundColor: 'rgba(59, 130, 246, 0.15)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--accent-primary)',
              }}
            >
              <FolderTree size={20} />
            </div>
            <div>
              <h2 style={{ fontSize: '1.2rem', fontWeight: 700, margin: 0 }}>
                Switch Photo Library
              </h2>
              <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                Select an existing library folder or choose a new directory
              </span>
            </div>
          </div>

          <button
            className="btn btn-ghost btn-icon"
            onClick={onClose}
            style={{ width: '36px', height: '36px', borderRadius: 'var(--radius-md)' }}
          >
            <X size={20} />
          </button>
        </div>

        {/* Content */}
        <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: '20px', maxHeight: '70vh', overflowY: 'auto' }}>
          {/* Action: Open New Folder */}
          <div>
            <button
              className="btn btn-primary"
              onClick={() => {
                onClose();
                onBrowseNewLibrary();
              }}
              style={{
                width: '100%',
                justifyContent: 'center',
                height: '46px',
                gap: '10px',
                fontSize: '0.92rem',
                fontWeight: 600,
              }}
            >
              <FolderOpen size={20} />
              <span>Browse & Open New Photo Folder...</span>
            </button>
          </div>

          {/* Active Library Indicator */}
          {currentLibrary && (
            <div
              style={{
                padding: '14px 16px',
                borderRadius: 'var(--radius-md)',
                backgroundColor: 'rgba(59, 130, 246, 0.1)',
                border: '1px solid rgba(59, 130, 246, 0.3)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: '0.72rem', textTransform: 'uppercase', color: 'var(--accent-primary)', fontWeight: 700 }}>
                  Currently Active Library
                </div>
                <div
                  style={{
                    fontSize: '0.88rem',
                    fontWeight: 600,
                    color: 'var(--text-primary)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    marginTop: '2px',
                  }}
                  title={currentLibrary}
                >
                  {currentLibrary}
                </div>
              </div>

              <div
                style={{
                  backgroundColor: 'var(--accent-primary)',
                  color: 'white',
                  padding: '4px 10px',
                  borderRadius: 'var(--radius-full)',
                  fontSize: '0.75rem',
                  fontWeight: 700,
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                  flexShrink: 0,
                }}
              >
                <Check size={14} strokeWidth={3} />
                <span>Active</span>
              </div>
            </div>
          )}

          {/* Recent Libraries List */}
          {recentLibraries && recentLibraries.length > 0 && (
            <div>
              <div
                style={{
                  fontSize: '0.78rem',
                  textTransform: 'uppercase',
                  color: 'var(--text-muted)',
                  fontWeight: 700,
                  letterSpacing: '0.05em',
                  marginBottom: '10px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                }}
              >
                <Clock size={14} />
                <span>Recent Libraries</span>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {recentLibraries.map((libPath, idx) => {
                  const isActive = currentLibrary?.toLowerCase() === libPath.toLowerCase();
                  const folderName = libPath.split(/[\\/]/).filter(Boolean).pop() || libPath;

                  return (
                    <div
                      key={idx}
                      onClick={() => {
                        if (!isActive) {
                          onSelectLibrary(libPath);
                          onClose();
                        }
                      }}
                      style={{
                        padding: '12px 16px',
                        borderRadius: 'var(--radius-md)',
                        backgroundColor: isActive ? 'rgba(59, 130, 246, 0.08)' : 'var(--bg-surface-elevated)',
                        border: isActive ? '1px solid rgba(59, 130, 246, 0.3)' : '1px solid var(--border-subtle)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        cursor: isActive ? 'default' : 'pointer',
                        transition: 'all 0.15s ease',
                      }}
                    >
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: '0.88rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                          📁 {folderName}
                        </div>
                        <div
                          style={{
                            fontSize: '0.75rem',
                            color: 'var(--text-muted)',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            marginTop: '2px',
                          }}
                          title={libPath}
                        >
                          {libPath}
                        </div>
                      </div>

                      {isActive ? (
                        <span style={{ fontSize: '0.75rem', color: 'var(--accent-primary)', fontWeight: 600 }}>
                          Current
                        </span>
                      ) : (
                        <button
                          className="btn btn-secondary"
                          style={{ fontSize: '0.78rem', padding: '6px 12px', gap: '4px' }}
                          onClick={(e) => {
                            e.stopPropagation();
                            onSelectLibrary(libPath);
                            onClose();
                          }}
                        >
                          <span>Switch</span>
                          <ArrowRight size={13} />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Network Virtual Mirrors */}
          {virtualStorages && virtualStorages.length > 0 && (
            <div>
              <div
                style={{
                  fontSize: '0.78rem',
                  textTransform: 'uppercase',
                  color: 'var(--text-muted)',
                  fontWeight: 700,
                  letterSpacing: '0.05em',
                  marginBottom: '10px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                }}
              >
                <HardDrive size={14} color="var(--accent-cyan)" />
                <span>Configured Network Mirrors</span>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {virtualStorages.map((storage) => (
                  <div
                    key={storage.id}
                    onClick={() => {
                      if (onSelectVirtualStorage) {
                        onSelectVirtualStorage(storage);
                        onClose();
                      }
                    }}
                    style={{
                      padding: '12px 16px',
                      borderRadius: 'var(--radius-md)',
                      backgroundColor: 'var(--bg-surface-elevated)',
                      border: '1px solid var(--border-subtle)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      cursor: 'pointer',
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: '0.88rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                        🌐 {storage.name}
                      </div>
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                        {storage.networkSourcePath} • {storage.totalItems || 0} photos
                      </div>
                    </div>

                    <button
                      className="btn btn-secondary"
                      style={{ fontSize: '0.78rem', padding: '6px 12px', gap: '4px' }}
                    >
                      <span>Open</span>
                      <ArrowRight size={13} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
