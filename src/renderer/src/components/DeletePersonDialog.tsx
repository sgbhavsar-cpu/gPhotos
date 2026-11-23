import React, { useState } from 'react';
import { useEscapeLayer } from '../services/escapeStack';

interface DeletePersonDialogProps {
  personName: string;
  faceCount: number;
  onConfirm: (rematch: boolean) => void;
  onCancel: () => void;
}

/** Delete-person confirmation, with the choice of looking for the person's faces again (matching them to the remaining people). */
export const DeletePersonDialog: React.FC<DeletePersonDialogProps> = ({ personName, faceCount, onConfirm, onCancel }) => {
  const [rematch, setRematch] = useState(true);
  useEscapeLayer(true, onCancel);
  return (
    <div
      data-testid="delete-person-dialog"
      onClick={onCancel}
      style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(5, 8, 15, 0.85)', backdropFilter: 'blur(8px)', zIndex: 3000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' }}
    >
      <div
        role="dialog"
        aria-label={`Delete ${personName}`}
        onClick={(e) => e.stopPropagation()}
        style={{ width: '100%', maxWidth: '440px', backgroundColor: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-lg)', padding: '22px', display: 'flex', flexDirection: 'column', gap: '14px' }}
      >
        <h3 style={{ margin: 0, fontSize: '1.05rem' }}>Delete &ldquo;{personName}&rdquo; from People?</h3>
        <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
          {faceCount > 0 ? `${faceCount.toLocaleString()} face${faceCount === 1 ? '' : 's'} assigned to this person will be set back to unknown. ` : ''}Your photos are not touched.
        </p>
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', fontSize: '0.85rem', cursor: 'pointer' }}>
          <input type="checkbox" data-testid="delete-person-rematch" checked={rematch} onChange={(e) => setRematch(e.target.checked)} style={{ marginTop: '3px' }} />
          <span>
            Look for these faces again when idle
            <span style={{ display: 'block', fontSize: '0.78rem', color: 'var(--text-muted)' }}>
              The faces are matched to the people you have already confirmed. A face that matches nobody stays unknown. No photos are re-read.
            </span>
          </span>
        </label>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
          <button className="btn btn-secondary" onClick={onCancel}>Cancel</button>
          <button className="btn btn-primary" data-testid="delete-person-confirm" onClick={() => onConfirm(rematch)} style={{ backgroundColor: '#e11d48' }}>Delete</button>
        </div>
      </div>
    </div>
  );
};
