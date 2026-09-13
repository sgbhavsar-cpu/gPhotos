import React from 'react';
import { useResponseTracker, responseTracker } from '../services/responseTracker';
import { RefreshCw, X } from 'lucide-react';

export const ResponseActivityIndicator: React.FC = () => {
  const { isWaitingBackend, label } = useResponseTracker();

  // If backend responds within 20 to 50 milliseconds (threshold 35ms), or all requests complete/cancelled, hide
  if (!isWaitingBackend) {
    return null;
  }

  const handleCancel = (e?: React.MouseEvent) => {
    if (e) {
      e.stopPropagation();
      e.preventDefault();
    }
    // Instantly cancel all pending operations and hide the wait icon
    responseTracker.clearAll();
  };

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Waiting for backend response"
      style={{
        position: 'fixed',
        top: '12px',
        right: '20px',
        zIndex: 9999,
        backgroundColor: 'rgba(15, 23, 42, 0.90)',
        border: '1px solid rgba(56, 189, 248, 0.45)',
        borderRadius: '9999px',
        padding: '4px 10px',
        boxShadow: '0 4px 16px rgba(0, 0, 0, 0.5), 0 0 12px rgba(6, 182, 212, 0.25)',
        backdropFilter: 'blur(14px)',
        display: 'flex',
        alignItems: 'center',
        gap: '7px',
        fontSize: '0.78rem',
        color: 'var(--text-primary)',
        cursor: 'pointer',
        userSelect: 'none',
        animation: 'responseIndicatorFadeIn 0.15s ease-out',
        transition: 'all 0.2s ease',
      }}
      onClick={handleCancel}
      title={label ? `${label} (Click to cancel)` : 'Waiting for backend response... Click to cancel'}
    >
      {/* Small wait icon with smooth spin animation */}
      <RefreshCw
        size={13}
        color="var(--accent-cyan)"
        className="animate-spin"
        style={{ animationDuration: '0.85s', flexShrink: 0 }}
      />

      <span style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: '0.76rem', whiteSpace: 'nowrap' }}>
        {label || 'Waiting for backend...'}
      </span>

      {/* Small cancel 'X' button to cancel request and hide wait icon */}
      <button
        type="button"
        aria-label="Cancel wait"
        onClick={handleCancel}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '16px',
          height: '16px',
          borderRadius: '50%',
          backgroundColor: 'rgba(255, 255, 255, 0.1)',
          border: 'none',
          color: 'var(--text-muted)',
          cursor: 'pointer',
          padding: 0,
          marginLeft: '2px',
          flexShrink: 0,
          transition: 'background-color 0.15s, color 0.15s',
        }}
        title="Cancel request"
        onMouseEnter={(e) => {
          e.currentTarget.style.backgroundColor = 'rgba(239, 68, 68, 0.3)';
          e.currentTarget.style.color = '#f87171';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.1)';
          e.currentTarget.style.color = 'var(--text-muted)';
        }}
      >
        <X size={10} />
      </button>

      <style>{`
        @keyframes responseIndicatorFadeIn {
          0% { opacity: 0; transform: translateY(-4px) scale(0.96); }
          100% { opacity: 1; transform: translateY(0) scale(1); }
        }
      `}</style>
    </div>
  );
};

export default ResponseActivityIndicator;
