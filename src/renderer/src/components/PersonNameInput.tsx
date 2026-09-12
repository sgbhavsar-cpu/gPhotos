import React, { useState, useRef, useEffect } from 'react';
import { Check, X } from 'lucide-react';

export interface PersonNameInputProps {
  initialValue: string;
  onSave: (newName: string) => void;
  onCancel: () => void;
  placeholder?: string;
  isLarge?: boolean;
  className?: string;
  style?: React.CSSProperties;
}

export const PersonNameInput: React.FC<PersonNameInputProps> = ({
  initialValue,
  onSave,
  onCancel,
  placeholder = 'Enter person name...',
  isLarge = false,
  className,
  style,
}) => {
  const [val, setVal] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const focusInput = () => {
      if (inputRef.current) {
        inputRef.current.focus();
        const length = inputRef.current.value.length;
        inputRef.current.setSelectionRange(length, length);
      }
    };

    // Phase 1: Immediate focus
    focusInput();
    // Phase 2: Next animation frame (after DOM paint)
    const rAF = requestAnimationFrame(focusInput);
    // Phase 3: Short timeout (after any bubbling mouse event completes)
    const timer = setTimeout(focusInput, 50);

    return () => {
      cancelAnimationFrame(rAF);
      clearTimeout(timer);
    };
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      const clean = val.trim();
      if (clean) onSave(clean);
      else onCancel();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  };

  const handleClear = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setVal('');
    inputRef.current?.focus();
  };

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        maxWidth: '100%',
        userSelect: 'text',
        WebkitUserSelect: 'text',
        ...style,
      }}
      className={`person-name-input-container ${className || ''}`}
    >
      <div style={{ position: 'relative', display: 'flex', alignItems: 'center', flex: 1, userSelect: 'text', WebkitUserSelect: 'text' }}>
        <input
          ref={inputRef}
          type="text"
          autoFocus
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={handleKeyDown}
          onClick={(e) => {
            e.stopPropagation();
            inputRef.current?.focus();
          }}
          placeholder={placeholder}
          className="input"
          style={{
            width: isLarge ? '260px' : '160px',
            fontSize: isLarge ? '1.2rem' : '0.9rem',
            fontWeight: 600,
            padding: isLarge ? '6px 32px 6px 12px' : '5px 28px 5px 8px',
            borderRadius: 'var(--radius-md)',
            border: '2px solid var(--accent-primary)',
            backgroundColor: 'var(--bg-surface)',
            color: 'var(--text-primary)',
            outline: 'none',
            userSelect: 'text',
            WebkitUserSelect: 'text',
            cursor: 'text',
            pointerEvents: 'auto',
          }}
        />
        {val.length > 0 && (
          <button
            type="button"
            onClick={handleClear}
            tabIndex={-1}
            style={{
              position: 'absolute',
              right: '6px',
              width: isLarge ? '20px' : '18px',
              height: isLarge ? '20px' : '18px',
              borderRadius: '50%',
              backgroundColor: 'rgba(255, 255, 255, 0.15)',
              border: 'none',
              color: 'var(--text-secondary)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 0,
            }}
            title="Clear text"
          >
            <X size={isLarge ? 13 : 11} />
          </button>
        )}
      </div>

      <button
        type="button"
        className="btn btn-primary"
        onClick={() => {
          const clean = val.trim();
          if (clean) onSave(clean);
          else onCancel();
        }}
        style={{
          width: isLarge ? '36px' : '30px',
          height: isLarge ? '36px' : '30px',
          padding: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
        title="Save Name (Enter)"
      >
        <Check size={isLarge ? 18 : 14} strokeWidth={2.5} />
      </button>

      <button
        type="button"
        className="btn btn-ghost"
        onClick={onCancel}
        style={{
          width: isLarge ? '36px' : '30px',
          height: isLarge ? '36px' : '30px',
          padding: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--text-muted)',
          flexShrink: 0,
        }}
        title="Cancel (Esc)"
      >
        <X size={isLarge ? 18 : 14} />
      </button>
    </div>
  );
};
