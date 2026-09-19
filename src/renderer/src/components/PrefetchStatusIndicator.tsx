import React, { useEffect, useState } from 'react';
import { usePrefetchStatus } from '../services/asyncImageLoader';
import { ImageDown } from 'lucide-react';

/**
 * Small persistent pill showing live thumbnail-prefetch activity (the
 * buffer of thumbnails requested ahead of/behind the current scroll
 * position), so it's visible whether prefetching is actually happening
 * rather than a silent no-op. Lingers briefly after the queue empties so a
 * fast prefetch ("0 pending" almost immediately) is still noticeable.
 */
export const PrefetchStatusIndicator: React.FC = () => {
  const status = usePrefetchStatus();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (status.isActive || status.pendingCount > 0) {
      setVisible(true);
      return;
    }
    const t = setTimeout(() => setVisible(false), 900);
    return () => clearTimeout(t);
  }, [status.isActive, status.pendingCount]);

  if (!visible) return null;

  const isDone = status.pendingCount === 0;

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Thumbnail prefetch activity"
      style={{
        position: 'fixed',
        bottom: '16px',
        left: '20px',
        zIndex: 9999,
        backgroundColor: 'rgba(15, 23, 42, 0.90)',
        border: `1px solid ${isDone ? 'rgba(16, 185, 129, 0.45)' : 'rgba(168, 85, 247, 0.45)'}`,
        borderRadius: '9999px',
        padding: '4px 12px',
        boxShadow: '0 4px 16px rgba(0, 0, 0, 0.5)',
        backdropFilter: 'blur(14px)',
        display: 'flex',
        alignItems: 'center',
        gap: '7px',
        fontSize: '0.76rem',
        color: 'var(--text-primary)',
        userSelect: 'none',
        pointerEvents: 'none',
        transition: 'opacity 0.25s ease',
        opacity: visible ? 1 : 0,
      }}
    >
      <ImageDown
        size={13}
        color={isDone ? '#10b981' : '#c084fc'}
        style={{ flexShrink: 0 }}
      />
      <span style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>
        {isDone
          ? `Pre-fetched ${status.lastFetchedCount} thumbnail${status.lastFetchedCount === 1 ? '' : 's'}`
          : `Pre-fetching ${status.pendingCount} thumbnail${status.pendingCount === 1 ? '' : 's'}...`}
      </span>
    </div>
  );
};

export default PrefetchStatusIndicator;
