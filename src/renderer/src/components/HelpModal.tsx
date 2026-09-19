import React, { useEffect } from 'react';
import { X, ExternalLink, HelpCircle, BookOpen } from 'lucide-react';

interface HelpModalProps {
  onClose: () => void;
}

export const HelpModal: React.FC<HelpModalProps> = ({ onClose }) => {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const handleOpenExternal = async () => {
    if (window.electronAPI?.openHelpInBrowser) {
      const opened = await window.electronAPI.openHelpInBrowser();
      if (opened) return;
    }
    window.open('/help.html', '_blank');
  };

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.8)',
        backdropFilter: 'blur(10px)',
        zIndex: 1100,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="animate-in"
        style={{
          backgroundColor: 'var(--bg-surface)',
          border: '1px solid var(--border-accent)',
          borderRadius: 'var(--radius-xl)',
          width: '100%',
          maxWidth: '1050px',
          height: '90vh',
          boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.8), 0 0 35px rgba(59, 130, 246, 0.15)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* Modal Header */}
        <div
          style={{
            padding: '16px 24px',
            borderBottom: '1px solid var(--border-subtle)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            backgroundColor: 'var(--bg-surface-elevated)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div
              style={{
                width: '36px',
                height: '36px',
                borderRadius: 'var(--radius-md)',
                backgroundColor: 'rgba(59, 130, 246, 0.15)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--accent-primary)',
              }}
            >
              <BookOpen size={20} />
            </div>
            <div>
              <h3 style={{ fontSize: '1.1rem', fontWeight: 700, margin: 0, color: 'var(--text-primary)' }}>
                User Guide & Architecture Manual
              </h3>
              <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', margin: '2px 0 0' }}>
                De-duplication, Background Daemon, Face Recognition & Virtual Mirrors
              </p>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <button
              className="btn btn-secondary"
              onClick={handleOpenExternal}
              style={{ fontSize: '0.8rem', padding: '6px 14px', gap: '6px' }}
              title="Open full manual in default browser"
            >
              <ExternalLink size={14} />
              <span>Open in Browser</span>
            </button>
            <button
              className="btn btn-ghost btn-icon"
              onClick={onClose}
              style={{ width: '32px', height: '32px', borderRadius: 'var(--radius-full)' }}
              title="Close Guide"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Embedded Interactive Help Viewer */}
        <div style={{ flex: 1, backgroundColor: '#090d16', position: 'relative' }}>
          <iframe
            src={window.electronAPI ? "gphoto://help" : "/help.html"}
            title="gPhotos Desktop User Guide"
            style={{
              width: '100%',
              height: '100%',
              border: 'none',
              display: 'block',
            }}
          />
        </div>
      </div>
    </div>
  );
};
