import React from 'react';

interface TrimRangeProps {
  duration: number;
  start: number;
  end: number;
  onChange: (start: number, end: number) => void;
}

const MIN_GAP = 0.5;

/** Two-handle scrubber for choosing the part of a clip to keep: two stacked native sliders over one track. */
export const TrimRange: React.FC<TrimRangeProps> = ({ duration, start, end, onChange }) => {
  const pct = (v: number) => `${(v / duration) * 100}%`;
  const step = duration > 60 ? 0.5 : 0.1;
  const thumb: React.CSSProperties = { position: 'absolute', left: 0, width: '100%', top: 0, margin: 0, background: 'none', pointerEvents: 'none', accentColor: '#f5b942' };
  return (
    <span data-testid="trim-range" style={{ position: 'relative', display: 'inline-block', width: '100%', minWidth: '180px', height: '22px' }}>
      <span style={{ position: 'absolute', left: 0, right: 0, top: '9px', height: '4px', borderRadius: '2px', background: 'var(--border-subtle)' }} />
      <span style={{ position: 'absolute', left: pct(start), width: `${((end - start) / duration) * 100}%`, top: '9px', height: '4px', borderRadius: '2px', background: '#f5b942' }} />
      <input type="range" aria-label="Clip start" min={0} max={duration} step={step} value={start} style={thumb}
        onChange={(e) => onChange(Math.min(Number(e.target.value), end - MIN_GAP), end)} />
      <input type="range" aria-label="Clip end" min={0} max={duration} step={step} value={end} style={thumb}
        onChange={(e) => onChange(start, Math.max(Number(e.target.value), start + MIN_GAP))} />
    </span>
  );
};
