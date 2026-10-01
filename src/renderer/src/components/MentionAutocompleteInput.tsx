import React, { useMemo, useRef, useState } from 'react';

export interface MentionItem {
  id: string;
  label: string;
}

export interface MentionSource {
  trigger: '@' | '#' | '&';
  items: MentionItem[];
  emptyLabel: string;
}

interface MentionAutocompleteInputProps {
  value: string;
  onChange: (value: string) => void;
  /** Enter pressed while no suggestion list is open — the input's normal "submit" behaviour. */
  onSubmit: () => void;
  /** One entry per trigger character (e.g. '@' for people, '#' for places). */
  sources: MentionSource[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  style?: React.CSSProperties;
  autoFocus?: boolean;
}

const MAX_SUGGESTIONS = 8;

/** Deduplicates by label (case-insensitive) and sorts alphabetically, so a messy source list still reads cleanly. */
function dedupeSorted(items: MentionItem[]): MentionItem[] {
  const byLabel = new Map<string, MentionItem>();
  for (const item of items) {
    const key = item.label.trim().toLowerCase();
    if (key && !byLabel.has(key)) byLabel.set(key, item);
  }
  return Array.from(byLabel.values()).sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * A plain text input with Slack/GitHub-style "@mention" autocomplete — one trigger character per
 * source (here: '@' for people, '#' for places, '&' for Smart Flow content tags). Typing a trigger
 * opens a "contains" filtered list (typing "bhavsar" matches "Sachin Bhavsar" AND "Bhavsar Tarun");
 * picking an entry (click, or Enter/Tab while highlighted) replaces the trigger + partial text with
 * the plain name, so the final text sent to search is ordinary natural language with no leftover
 * @/#/& — e.g. "Photo of Sachin Bhavsar in Udaipur", exactly like typing the name out by hand.
 */
export const MentionAutocompleteInput: React.FC<MentionAutocompleteInputProps> = ({
  value, onChange, onSubmit, sources, placeholder, disabled, className, style, autoFocus,
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [highlight, setHighlight] = useState(0);
  // Where the active mention starts (index of its trigger char) and which trigger it is — null
  // when the caret isn't currently inside a "@word" / "#word" token.
  const [active, setActive] = useState<{ trigger: string; start: number; query: string } | null>(null);

  const sourceByTrigger = useMemo(() => new Map<string, MentionSource>(sources.map((s) => [s.trigger, s])), [sources]);
  const activeSource = active ? sourceByTrigger.get(active.trigger) : undefined;
  const matches = useMemo(() => {
    if (!active || !activeSource) return [];
    const q = active.query.toLowerCase();
    const pool = dedupeSorted(activeSource.items);
    return (q ? pool.filter((it) => it.label.toLowerCase().includes(q)) : pool).slice(0, MAX_SUGGESTIONS);
  }, [active, activeSource]);

  /** Re-scans the text around the caret for an in-progress "@word"/"#word" token. */
  const detectMention = (text: string, caret: number) => {
    const before = text.slice(0, caret);
    // A trigger character starts a token only at the very start of the text or after whitespace —
    // so "user@host" mid-word never opens the list, only a deliberate "@name" does.
    const m = /(?:^|\s)([@#&])(\S*)$/.exec(before);
    if (!m || !sourceByTrigger.has(m[1])) {
      setActive(null);
      return;
    }
    setActive({ trigger: m[1], start: caret - m[2].length - 1, query: m[2] });
    setHighlight(0);
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onChange(e.target.value);
    detectMention(e.target.value, e.target.selectionStart ?? e.target.value.length);
  };

  const pick = (item: MentionItem) => {
    if (!active) return;
    const caret = inputRef.current?.selectionStart ?? value.length;
    const next = `${value.slice(0, active.start)}${item.label} ${value.slice(caret)}`;
    onChange(next);
    setActive(null);
    const newCaret = active.start + item.label.length + 1;
    requestAnimationFrame(() => inputRef.current?.setSelectionRange(newCaret, newCaret));
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (active) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        e.nativeEvent.stopPropagation(); // also swallow the underlying native event, so it never reaches a plain window-level Escape handler (e.g. one that would close the whole modal)
        setActive(null);
        return;
      }
      if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight((i) => Math.min(i + 1, Math.max(0, matches.length - 1))); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight((i) => Math.max(i - 1, 0)); return; }
      if ((e.key === 'Enter' || e.key === 'Tab') && matches.length > 0) { e.preventDefault(); pick(matches[highlight]); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSubmit(); }
  };

  return (
    <div style={{ position: 'relative', flex: 1 }}>
      <input
        ref={inputRef}
        type="text"
        className={className}
        placeholder={placeholder}
        value={value}
        disabled={disabled}
        autoFocus={autoFocus}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onClick={(e) => detectMention(value, (e.target as HTMLInputElement).selectionStart ?? value.length)}
        onKeyUp={(e) => {
          // Arrow-key / Home / End navigation moves the caret without changing the text, so it needs
          // its own re-check — onChange alone would miss "arrowed back into an existing @mention".
          // Skipped while a list is already open: those same arrow keys move the highlighted
          // suggestion instead (handled in onKeyDown, which also keeps the caret from moving at all).
          if (!active && (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End')) {
            detectMention(value, (e.target as HTMLInputElement).selectionStart ?? value.length);
          }
        }}
        onBlur={() => setTimeout(() => setActive(null), 120)} // delay so a click on a suggestion registers first
        style={{ width: '100%', ...style }}
      />
      {active && (
        <div
          data-testid="mention-suggestions"
          style={{
            position: 'absolute', bottom: 'calc(100% + 6px)', left: 0, minWidth: '220px', maxWidth: '320px', maxHeight: '220px',
            overflowY: 'auto', backgroundColor: 'var(--bg-surface-elevated)', border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-lg)', boxShadow: '0 12px 32px rgba(0,0,0,0.5)', padding: '4px', zIndex: 40,
          }}
        >
          {matches.length === 0 ? (
            <div style={{ padding: '8px 12px', fontSize: '0.82rem', color: 'var(--text-muted)' }}>{activeSource?.emptyLabel}</div>
          ) : (
            matches.map((item, i) => (
              <button
                key={item.id}
                type="button"
                data-testid="mention-option"
                onMouseDown={(e) => e.preventDefault()} // keep focus on the input so onBlur doesn't beat the click
                onClick={() => pick(item)}
                onMouseEnter={() => setHighlight(i)}
                style={{
                  display: 'block', width: '100%', textAlign: 'left', padding: '7px 12px', border: 'none', borderRadius: 'var(--radius-md)',
                  background: i === highlight ? 'rgba(59, 130, 246, 0.15)' : 'transparent', color: 'var(--text-primary)', fontSize: '0.85rem', cursor: 'pointer',
                }}
              >
                {item.label}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
};
