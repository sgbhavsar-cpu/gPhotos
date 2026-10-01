import React, { useState } from 'react';
import { Sparkles, Wand2, Check, X as XIcon } from 'lucide-react';
import type { PhotoContentEntry } from '../../../types';
import { listFlows } from '../services/smartFlowsService';
import { normalizeDescription } from '../services/photoContentCache';
import { TopTabs, type TopTabItem } from './TopTabs';

const rowIcon = (bg: string, Icon: React.ComponentType<{ size?: number; color?: string }>, color: string) => (
  <div style={{ width: '32px', height: '32px', borderRadius: 'var(--radius-full)', backgroundColor: bg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
    <Icon size={16} color={color} />
  </div>
);

/**
 * The "what the AI found" card in Photo Details: what a Smart Flow (local Ollama first, then the
 * configured cloud provider) has extracted about this photo — its caption/tags, and, on a second
 * tab, whether each of the user's own Smart Flows matched it. Both come from the one shared
 * per-photo cache (photoContentCache.ts) that every flow reads and writes.
 */
export const PhotoAiInfoPanel: React.FC<{ entry: PhotoContentEntry }> = ({ entry }) => {
  const flows = listFlows();
  const flowVerdicts = flows
    .map((flow) => ({ flow, verdict: entry.verdicts[normalizeDescription(flow.description)] }))
    .filter((v): v is { flow: typeof flows[number]; verdict: NonNullable<typeof v.verdict> } => !!v.verdict);

  const tabs: TopTabItem[] = [
    { id: 'overview', label: 'Overview' },
    ...(flowVerdicts.length > 0 ? [{ id: 'flows', label: `Smart Flows (${flowVerdicts.length})` }] : []),
  ];
  const [tab, setTab] = useState<'overview' | 'flows'>('overview');
  const activeTab = tabs.some((t) => t.id === tab) ? tab : 'overview';

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
        <span style={{ fontSize: '0.85rem', fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-muted)' }}>
          AI Info
        </span>
        {rowIcon('rgba(192, 132, 252, 0.1)', Sparkles, '#c084fc')}
      </div>

      {tabs.length > 1 && (
        <div style={{ marginBottom: '12px' }}>
          <TopTabs tabs={tabs} activeId={activeTab} onChange={(id) => setTab(id as 'overview' | 'flows')} size="sm" />
        </div>
      )}

      {activeTab === 'overview' && (
        <>
          {entry.caption && (
            <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '10px' }}>
              {entry.caption}
            </div>
          )}
          {entry.tags.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
              {entry.tags.map((tag) => (
                <span key={tag} style={{
                  fontSize: '0.75rem', padding: '3px 10px', borderRadius: 'var(--radius-full)',
                  background: 'rgba(192, 132, 252, 0.12)', border: '1px solid rgba(192, 132, 252, 0.3)', color: '#c084fc',
                }}>
                  {tag}
                </span>
              ))}
            </div>
          )}
          {!entry.caption && entry.tags.length === 0 && (
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>No caption or tags recorded yet.</div>
          )}
        </>
      )}

      {activeTab === 'flows' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {flowVerdicts.map(({ flow, verdict }) => (
            <div key={flow.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.82rem' }}>
              {verdict.match
                ? <Check size={14} color="#10b981" style={{ flexShrink: 0 }} />
                : <XIcon size={14} color="var(--text-muted)" style={{ flexShrink: 0 }} />}
              <Wand2 size={12} color="var(--text-muted)" style={{ flexShrink: 0 }} />
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: verdict.match ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                {flow.name}
              </span>
              <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: '0.74rem' }}>
                {Math.round(verdict.confidence * 100)}%
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
