import { useSyncExternalStore } from 'react';
import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';
import { useIsMobile } from '../hooks/useIsMobile';
import { dismissNotice, getNotices, subscribeNotices, NoticeKind } from '../services/notifications';

const COLORS: Record<NoticeKind, { bg: string; border: string }> = {
  error: { bg: 'rgba(127, 29, 29, 0.96)', border: '#ef4444' },
  warning: { bg: 'rgba(120, 53, 15, 0.96)', border: '#f59e0b' },
  success: { bg: 'rgba(6, 78, 59, 0.96)', border: '#10b981' },
  info: { bg: 'rgba(15, 23, 42, 0.96)', border: 'var(--accent-primary)' },
};

const copy = (text: string) => {
  try {
    // navigator.clipboard is undefined on insecure (plain-http LAN) origins.
    navigator.clipboard?.writeText(text).catch(() => {});
  } catch {}
};

/** Renders app-wide notices. Mounted outside the ErrorBoundary so errors are visible even when the UI crashed. */
export const NoticeHost = () => {
  const all = useSyncExternalStore(subscribeNotices, getNotices);
  const isMobile = useIsMobile();
  // On a phone: newest two only, above the bottom tab bar (top-right stacked over the header and hid the page title).
  const list = isMobile ? all.slice(-2) : all;
  if (list.length === 0) return null;
  return (
    <div
      style={{
        position: 'fixed',
        ...(isMobile ? { bottom: 'calc(76px + env(safe-area-inset-bottom, 0px))', left: '12px', right: '12px' } : { top: '20px', right: '24px' }),
        zIndex: 20000,
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        maxWidth: isMobile ? undefined : 'min(440px, calc(100vw - 32px))',
      }}
    >
      {list.map((n) => {
        const c = COLORS[n.kind];
        const Icon = n.kind === 'error' || n.kind === 'warning' ? AlertTriangle : n.kind === 'success' ? CheckCircle2 : Info;
        return (
          <div
            key={n.id}
            role={n.kind === 'error' ? 'alert' : 'status'}
            style={{
              backgroundColor: c.bg,
              border: `1px solid ${c.border}`,
              borderRadius: 'var(--radius-md, 10px)',
              padding: '10px 14px',
              boxShadow: '0 8px 30px rgba(0,0,0,0.5)',
              display: 'flex',
              alignItems: 'flex-start',
              gap: '10px',
              fontSize: '0.85rem',
              color: 'white',
            }}
          >
            <Icon size={18} style={{ flexShrink: 0, marginTop: 1 }} />
            <span style={{ flex: 1, wordBreak: 'break-word' }}>
              {n.message}
              {n.count > 1 && ` (x${n.count})`}
            </span>
            {n.detail && (
              <button
                onClick={() => copy(`${n.message}\n${n.detail}`)}
                style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.75)', cursor: 'pointer', fontSize: '0.75rem', padding: isMobile ? '8px 6px' : 0 }}
              >
                Copy
              </button>
            )}
            <button
              onClick={() => dismissNotice(n.id)}
              aria-label="Dismiss"
              style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.75)', cursor: 'pointer', padding: isMobile ? '8px' : 0, margin: isMobile ? '-8px -6px -8px 0' : 0, display: 'flex' }}
            >
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
};
