import React, { useState } from 'react';
import { X, Trash2, AlertTriangle, HardDrive, FolderX, ShieldAlert, RefreshCw } from 'lucide-react';
import { VirtualStorageConfig } from '../../types';

interface DeleteStorageModalProps {
  storage: VirtualStorageConfig;
  onClose: () => void;
  onConfirmDelete: (deleteDiskFiles: boolean) => Promise<void>;
}

export const DeleteStorageModal: React.FC<DeleteStorageModalProps> = ({
  storage,
  onClose,
  onConfirmDelete,
}) => {
  const [isDeleting, setIsDeleting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const fullLocalPath = `${storage.localMirrorRoot}\\${storage.name}`;

  const handleDelete = async (deleteDiskFiles: boolean) => {
    setIsDeleting(true);
    setErrorMessage(null);
    try {
      await onConfirmDelete(deleteDiskFiles);
      onClose();
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to delete storage.');
      setIsDeleting(false);
    }
  };

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.75)',
        backdropFilter: 'blur(8px)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '20px',
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !isDeleting) onClose();
      }}
    >
      <div
        className="animate-in"
        style={{
          backgroundColor: 'var(--bg-surface)',
          border: '1px solid rgba(239, 68, 68, 0.3)',
          borderRadius: 'var(--radius-xl)',
          width: '100%',
          maxWidth: '540px',
          boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.7), 0 0 25px rgba(239, 68, 68, 0.1)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: '20px 24px',
            borderBottom: '1px solid var(--border-subtle)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            backgroundColor: 'rgba(239, 68, 68, 0.06)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div
              style={{
                width: '40px',
                height: '40px',
                borderRadius: 'var(--radius-full)',
                backgroundColor: 'rgba(239, 68, 68, 0.15)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--accent-rose)',
              }}
            >
              <AlertTriangle size={22} />
            </div>
            <div>
              <h3 style={{ fontSize: '1.15rem', fontWeight: 700, margin: 0, color: 'var(--text-primary)' }}>
                Delete Configured Storage
              </h3>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', margin: '2px 0 0' }}>
                Manage or remove <strong>{storage.name}</strong> from your library
              </p>
            </div>
          </div>

          <button
            className="btn btn-ghost"
            onClick={onClose}
            disabled={isDeleting}
            style={{ padding: '6px', borderRadius: 'var(--radius-full)' }}
          >
            <X size={18} />
          </button>
        </div>

        {/* Content Body */}
        <div style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {errorMessage && (
            <div
              style={{
                padding: '12px 16px',
                borderRadius: 'var(--radius-md)',
                backgroundColor: 'rgba(239, 68, 68, 0.15)',
                border: '1px solid var(--accent-rose)',
                color: 'var(--accent-rose)',
                fontSize: '0.85rem',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
              }}
            >
              <ShieldAlert size={16} />
              <span>{errorMessage}</span>
            </div>
          )}

          {/* Storage Details Summary Card */}
          <div
            style={{
              backgroundColor: 'var(--bg-surface-elevated)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-lg)',
              padding: '16px',
              display: 'flex',
              flexDirection: 'column',
              gap: '10px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <HardDrive size={16} color="var(--accent-cyan)" />
              <span style={{ fontSize: '0.95rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                {storage.name}
              </span>
              <span
                style={{
                  fontSize: '0.72rem',
                  padding: '2px 8px',
                  borderRadius: 'var(--radius-full)',
                  backgroundColor: 'rgba(59, 130, 246, 0.15)',
                  color: 'var(--accent-primary)',
                  fontWeight: 600,
                  marginLeft: 'auto',
                }}
              >
                {storage.totalItems || 0} photos indexed
              </span>
            </div>

            <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <div>
                <span style={{ color: 'var(--text-muted)' }}>Network Source: </span>
                <code style={{ color: 'var(--text-primary)', wordBreak: 'break-all' }}>{storage.networkSourcePath}</code>
              </div>
              <div>
                <span style={{ color: 'var(--text-muted)' }}>Local Mirror: </span>
                <code style={{ color: 'var(--text-primary)', wordBreak: 'break-all' }}>{fullLocalPath}</code>
              </div>
            </div>
          </div>

          <div
            style={{
              padding: '12px 14px',
              borderRadius: 'var(--radius-md)',
              backgroundColor: 'rgba(16, 185, 129, 0.08)',
              border: '1px solid rgba(16, 185, 129, 0.25)',
              fontSize: '0.8rem',
              color: 'var(--accent-emerald)',
              lineHeight: 1.4,
            }}
          >
            🛡️ <strong>Safety Guarantee:</strong> Your original photos on the network source or external drive are <strong>never modified or deleted</strong>.
          </div>

          <p style={{ fontSize: '0.86rem', color: 'var(--text-secondary)', margin: '0' }}>
            Choose how you would like to remove this storage:
          </p>

          {/* Action Choice Buttons */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {/* Option 1: Delete completely including disk cache */}
            <button
              className="btn btn-danger"
              disabled={isDeleting}
              onClick={() => handleDelete(true)}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '14px 18px',
                textAlign: 'left',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <Trash2 size={20} />
                <div>
                  <div style={{ fontWeight: 700, fontSize: '0.9rem' }}>
                    Delete Storage & Free Disk Space
                  </div>
                  <div style={{ fontSize: '0.75rem', opacity: 0.85, fontWeight: 400 }}>
                    Deletes local 500px thumbnails in <code>{storage.name}</code> to Windows Recycle Bin
                  </div>
                </div>
              </div>
              {isDeleting && <RefreshCw size={16} className="animate-spin" />}
            </button>

            {/* Option 2: Remove from list only, keep thumbnails on disk */}
            <button
              className="btn btn-secondary"
              disabled={isDeleting}
              onClick={() => handleDelete(false)}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '14px 18px',
                textAlign: 'left',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <FolderX size={20} color="var(--accent-amber)" />
                <div>
                  <div style={{ fontWeight: 700, fontSize: '0.9rem', color: 'var(--text-primary)' }}>
                    Remove from List Only
                  </div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: 400 }}>
                    Unlinks from library list but preserves cached thumbnails on disk
                  </div>
                </div>
              </div>
            </button>
          </div>
        </div>

        {/* Footer */}
        <div
          style={{
            padding: '16px 24px',
            borderTop: '1px solid var(--border-subtle)',
            backgroundColor: 'var(--bg-surface-elevated)',
            display: 'flex',
            justifyContent: 'flex-end',
          }}
        >
          <button
            className="btn btn-ghost"
            onClick={onClose}
            disabled={isDeleting}
            style={{ fontSize: '0.86rem', padding: '8px 18px' }}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
};
