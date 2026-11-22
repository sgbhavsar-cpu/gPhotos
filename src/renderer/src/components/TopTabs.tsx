import React, { useEffect, useRef, useState } from 'react';

export interface TopTabItem {
  id: string;
  label: string;
  icon?: React.ComponentType<{ size?: number; color?: string }>;
}

interface TopTabsProps {
  tabs: TopTabItem[];
  activeId: string;
  onChange: (id: string) => void;
  /** 'md' for a page-level tab bar (Settings), 'sm' for a compact one inside a panel (Photo Details). */
  size?: 'md' | 'sm';
}

/**
 * A horizontal row of tabs anchored to the top of whatever they head (a page, a panel) — an
 * underline on the active tab, no boxed/pill look. Shared by SettingsView (page tabs) and
 * PhotoAiInfoPanel (a smaller variant), so both change together and stay visually consistent.
 */
export const TopTabs: React.FC<TopTabsProps> = ({ tabs, activeId, onChange, size = 'md' }) => {
  const fontSize = size === 'md' ? '0.9rem' : '0.78rem';
  const padding = size === 'md' ? '10px 4px' : '6px 2px';
  const gap = size === 'md' ? '28px' : '18px';
  const iconSize = size === 'md' ? 16 : 13;

  // More tabs than fit (a phone): fade the right edge while there is more to scroll to, so the cut-off tabs are discoverable.
  const listRef = useRef<HTMLDivElement>(null);
  const [moreToRight, setMoreToRight] = useState(false);
  const measure = () => { const el = listRef.current; if (el) setMoreToRight(el.scrollWidth - el.clientWidth - el.scrollLeft > 4); };
  useEffect(() => {
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [tabs.length]);

  return (
    <div ref={listRef} onScroll={measure} role="tablist" style={{ display: 'flex', gap, borderBottom: '1px solid var(--border-subtle)', overflowX: 'auto', ...(moreToRight ? { WebkitMaskImage: 'linear-gradient(to right, #000 calc(100% - 36px), transparent)', maskImage: 'linear-gradient(to right, #000 calc(100% - 36px), transparent)' } : {}) }}>
      {tabs.map((t) => {
        const active = t.id === activeId;
        const Icon = t.icon;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(t.id)}
            style={{
              display: 'flex', alignItems: 'center', gap: '6px', padding, fontSize, fontWeight: active ? 700 : 500,
              background: 'none', border: 'none', borderBottom: active ? '2px solid var(--accent-cyan)' : '2px solid transparent',
              marginBottom: '-1px', color: active ? 'var(--text-primary)' : 'var(--text-muted)', cursor: 'pointer',
              whiteSpace: 'nowrap', flexShrink: 0,
            }}
          >
            {Icon && <Icon size={iconSize} color={active ? 'var(--accent-cyan)' : 'var(--text-muted)'} />}
            {t.label}
          </button>
        );
      })}
    </div>
  );
};
