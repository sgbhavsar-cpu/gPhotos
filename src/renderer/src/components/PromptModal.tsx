import React, { useEffect, useState } from 'react';

interface PromptModalProps {
  title: string;
  message?: string;
  initialValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  inputType?: 'text' | 'number';
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

/**
 * A styled, in-app replacement for `window.prompt()` — Electron's support for the native prompt
 * dialog is unreliable (it can resolve immediately with null, with nothing ever shown, depending
 * on window/webPreferences settings), which silently turned "type a name and press OK" features
 * into "clicking the button does nothing". This always works, since it's just React state.
 */
export const PromptModal: React.FC<PromptModalProps> = ({ title, message, initialValue = '', placeholder, confirmLabel = 'OK', inputType = 'text', onSubmit, onCancel }) => {
  const [value, setValue] = useState(initialValue);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopImmediatePropagation(); onCancel(); }
    };
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, [onCancel]);

  return (
    <div
      style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.78)', backdropFilter: 'blur(8px)', zIndex: 1300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' }}
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <form
        className="animate-in"
        onSubmit={(e) => { e.preventDefault(); if (value.trim()) onSubmit(value.trim()); }}
        style={{ backgroundColor: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-lg)', width: '100%', maxWidth: '380px', padding: '20px', display: 'flex', flexDirection: 'column', gap: '14px', boxShadow: '0 25px 50px -12px rgba(0,0,0,0.7)' }}
      >
        <h3 style={{ margin: 0, fontSize: '1rem' }}>{title}</h3>
        {message && <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--text-muted)' }}>{message}</p>}
        <input
          autoFocus
          type={inputType}
          className="input"
          placeholder={placeholder}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          style={{ height: '40px', width: '100%' }}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
          <button type="button" className="btn btn-ghost" onClick={onCancel} style={{ padding: '8px 16px', fontSize: '0.85rem' }}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={!value.trim()} style={{ padding: '8px 16px', fontSize: '0.85rem' }}>{confirmLabel}</button>
        </div>
      </form>
    </div>
  );
};
