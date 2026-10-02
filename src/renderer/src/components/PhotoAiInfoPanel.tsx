import React, { useEffect, useState } from 'react';
import { Sparkles, Wand2, Check, X as XIcon, Pencil, Plus } from 'lucide-react';
import type { PhotoContentEntry } from '../../../types';
import { listFlows } from '../services/smartFlowsService';
import { normalizeDescription, setCaptionAndTags } from '../services/photoContentCache';
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
 *
 * The caption/tags are editable here — a user correcting or deleting what the AI got wrong writes
 * straight back to that same shared cache via setCaptionAndTags (a plain overwrite, unlike the
 * vision pipeline's own accumulate-tags/keep-newer-caption merge in recordFinding).
 */
export const PhotoAiInfoPanel: React.FC<{ photoId: string; entry: PhotoContentEntry }> = ({ photoId, entry }) => {
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

  // Editing state — a local draft, applied to the shared cache only on Save. Resets whenever the
  // displayed photo changes (navigating next/prev in the lightbox), not on every `entry` reference
  // change, so a background Smart Flow finishing mid-edit doesn't clobber an in-progress draft.
  const [isEditing, setIsEditing] = useState(false);
  const [draftCaption, setDraftCaption] = useState(entry.caption);
  const [draftTags, setDraftTags] = useState<string[]>(entry.tags);
  const [newTagInput, setNewTagInput] = useState('');
  // What the read-only view actually shows — mirrors `entry` for a freshly-opened photo, but
  // updated immediately on Save, since mutating the shared cache module doesn't by itself make
  // PhotoLightbox (which computed the `entry` prop once for this render) re-render with the new
  // value. Reset together with the draft whenever the displayed photo changes.
  const [displayCaption, setDisplayCaption] = useState(entry.caption);
  const [displayTags, setDisplayTags] = useState<string[]>(entry.tags);
  useEffect(() => {
    setIsEditing(false);
    setDraftCaption(entry.caption);
    setDraftTags(entry.tags);
    setNewTagInput('');
    setDisplayCaption(entry.caption);
    setDisplayTags(entry.tags);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photoId]);

  const startEditing = () => {
    setDraftCaption(displayCaption);
    setDraftTags(displayTags);
    setNewTagInput('');
    setIsEditing(true);
  };
  const cancelEditing = () => setIsEditing(false);
  const saveEditing = () => {
    const cleanCaption = draftCaption.trim();
    const cleanTags = Array.from(new Set(draftTags.map((t) => t.toLowerCase().trim()).filter(Boolean)));
    setCaptionAndTags(photoId, cleanCaption, cleanTags);
    setDisplayCaption(cleanCaption);
    setDisplayTags(cleanTags);
    setIsEditing(false);
  };
  const addDraftTag = () => {
    const clean = newTagInput.trim().toLowerCase();
    if (clean && !draftTags.includes(clean)) setDraftTags([...draftTags, clean]);
    setNewTagInput('');
  };
  const removeDraftTag = (tag: string) => setDraftTags(draftTags.filter((t) => t !== tag));

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
        <span style={{ fontSize: '0.85rem', fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-muted)' }}>
          AI Info
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          {!isEditing && activeTab === 'overview' && (
            <button
              onClick={startEditing}
              title="Edit caption and tags"
              style={{ width: '28px', height: '28px', borderRadius: 'var(--radius-full)', border: 'none', background: 'rgba(192, 132, 252, 0.1)', color: '#c084fc', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
            >
              <Pencil size={13} />
            </button>
          )}
          {rowIcon('rgba(192, 132, 252, 0.1)', Sparkles, '#c084fc')}
        </div>
      </div>

      {tabs.length > 1 && !isEditing && (
        <div style={{ marginBottom: '12px' }}>
          <TopTabs tabs={tabs} activeId={activeTab} onChange={(id) => setTab(id as 'overview' | 'flows')} size="sm" />
        </div>
      )}

      {activeTab === 'overview' && isEditing && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <textarea
            value={draftCaption}
            onChange={(e) => setDraftCaption(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            placeholder="Caption (leave empty to delete it)"
            rows={3}
            className="input"
            style={{ fontSize: '0.85rem', resize: 'vertical', width: '100%' }}
          />
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
            {draftTags.map((tag) => (
              <span key={tag} style={{
                display: 'inline-flex', alignItems: 'center', gap: '5px',
                fontSize: '0.75rem', padding: '3px 6px 3px 10px', borderRadius: 'var(--radius-full)',
                background: 'rgba(192, 132, 252, 0.12)', border: '1px solid rgba(192, 132, 252, 0.3)', color: '#c084fc',
              }}>
                {tag}
                <span
                  onClick={() => removeDraftTag(tag)}
                  title={`Remove "${tag}"`}
                  style={{ cursor: 'pointer', display: 'flex', alignItems: 'center' }}
                >
                  <XIcon size={11} />
                </span>
              </span>
            ))}
          </div>
          <div style={{ display: 'flex', gap: '6px' }}>
            <input
              type="text"
              value={newTagInput}
              onChange={(e) => setNewTagInput(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addDraftTag();
                }
              }}
              placeholder="Add a tag..."
              className="input"
              style={{ flex: 1, fontSize: '0.8rem' }}
            />
            <button className="btn btn-secondary" onClick={addDraftTag} disabled={!newTagInput.trim()} style={{ fontSize: '0.78rem', padding: '4px 10px', gap: '4px' }}>
              <Plus size={13} />
              <span>Add</span>
            </button>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '2px' }}>
            <button className="btn btn-ghost" onClick={cancelEditing} style={{ fontSize: '0.78rem', padding: '5px 12px' }}>
              Cancel
            </button>
            <button className="btn btn-primary" onClick={saveEditing} style={{ fontSize: '0.78rem', padding: '5px 12px', gap: '5px' }}>
              <Check size={13} />
              <span>Save</span>
            </button>
          </div>
        </div>
      )}

      {activeTab === 'overview' && !isEditing && (
        <>
          {displayCaption && (
            <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '10px' }}>
              {displayCaption}
            </div>
          )}
          {displayTags.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
              {displayTags.map((tag) => (
                <span key={tag} style={{
                  fontSize: '0.75rem', padding: '3px 10px', borderRadius: 'var(--radius-full)',
                  background: 'rgba(192, 132, 252, 0.12)', border: '1px solid rgba(192, 132, 252, 0.3)', color: '#c084fc',
                }}>
                  {tag}
                </span>
              ))}
            </div>
          )}
          {!displayCaption && displayTags.length === 0 && (
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>No caption or tags recorded yet. Click the pencil icon to add some.</div>
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
