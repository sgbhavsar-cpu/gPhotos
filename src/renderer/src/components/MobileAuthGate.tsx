import React, { useEffect, useState, useCallback } from 'react';
import { Lock, Loader2 } from 'lucide-react';
import {
  isBrowserMode,
  hasValidStoredToken,
  checkAuthRequired,
  pairWithPin,
  AUTH_REQUIRED_EVENT,
} from '../services/webAuthClient';

type GateStatus = 'checking' | 'needs-pin' | 'ready';

export const MobileAuthGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [status, setStatus] = useState<GateStatus>(isBrowserMode() ? 'checking' : 'ready');
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const runCheck = useCallback(async () => {
    if (!isBrowserMode()) {
      setStatus('ready');
      return;
    }
    const valid = await hasValidStoredToken();
    if (valid) {
      setStatus('ready');
      return;
    }
    const required = await checkAuthRequired();
    setStatus(required ? 'needs-pin' : 'ready');
  }, []);

  useEffect(() => {
    runCheck();
    const onAuthRequired = () => setStatus('needs-pin');
    window.addEventListener(AUTH_REQUIRED_EVENT, onAuthRequired);
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, onAuthRequired);
  }, [runCheck]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting || pin.trim().length === 0) return;
    setSubmitting(true);
    setError(null);
    const result = await pairWithPin(pin.trim());
    setSubmitting(false);
    if (result.success) {
      setStatus('ready');
    } else {
      setError(result.error || 'Incorrect PIN. Please try again.');
      setPin('');
    }
  };

  if (status === 'ready') return <>{children}</>;

  if (status === 'checking') {
    return (
      <div style={styles.container}>
        <Loader2 size={32} style={{ animation: 'spin 1s linear infinite' }} />
        <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <div style={styles.iconWrap}>
          <Lock size={28} />
        </div>
        <h1 style={styles.title}>Enter PIN to continue</h1>
        <p style={styles.subtitle}>
          This gPhotos library is protected. Enter the PIN shown in the desktop app's
          Settings &rarr; Mobile Access to pair this device.
        </p>
        <form onSubmit={handleSubmit} style={styles.form}>
          <input
            type="text"
            inputMode="numeric"
            autoFocus
            maxLength={12}
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            placeholder="6-digit PIN"
            style={styles.input}
          />
          {error && <div style={styles.error}>{error}</div>}
          <button type="submit" disabled={submitting || pin.trim().length === 0} style={styles.button}>
            {submitting ? 'Verifying…' : 'Continue'}
          </button>
        </form>
      </div>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    position: 'fixed',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#0f172a',
    color: '#e2e8f0',
    zIndex: 9999,
    padding: 16,
  },
  card: {
    width: '100%',
    maxWidth: 360,
    background: '#1e293b',
    borderRadius: 16,
    padding: 28,
    boxSizing: 'border-box',
    textAlign: 'center',
    boxShadow: '0 20px 50px rgba(0,0,0,0.4)',
  },
  iconWrap: {
    width: 56,
    height: 56,
    borderRadius: '50%',
    background: '#334155',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    margin: '0 auto 16px',
  },
  title: { fontSize: 20, fontWeight: 600, margin: '0 0 8px' },
  subtitle: { fontSize: 13.5, color: '#94a3b8', lineHeight: 1.5, margin: '0 0 20px' },
  form: { display: 'flex', flexDirection: 'column', gap: 12 },
  input: {
    fontSize: 22,
    letterSpacing: 4,
    textAlign: 'center',
    padding: '12px 10px',
    borderRadius: 10,
    border: '1px solid #334155',
    background: '#0f172a',
    color: '#e2e8f0',
    outline: 'none',
  },
  error: { color: '#f87171', fontSize: 13 },
  button: {
    padding: '12px 16px',
    borderRadius: 10,
    border: 'none',
    background: '#3b82f6',
    color: '#fff',
    fontSize: 15,
    fontWeight: 600,
    cursor: 'pointer',
  },
};
