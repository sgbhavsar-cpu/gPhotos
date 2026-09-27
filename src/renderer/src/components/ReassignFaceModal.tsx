import React, { useState, useEffect } from 'react';
import { X, UserCheck, AlertCircle, Sparkles } from 'lucide-react';
import { DetectedFace, Person, Photo } from '../../../types';
import { FaceAvatar } from './FaceAvatar';
import { PersonPicker } from './PersonPicker';
import { libraryStore } from '../services/libraryStore';
import { notifyError } from '../services/notifications';

interface ReassignFaceModalProps {
  face: DetectedFace;
  photo: Photo;
  currentPersonName?: string;
  people?: Person[];
  onClose: () => void;
  onSuccess?: () => void;
}

export const ReassignFaceModal: React.FC<ReassignFaceModalProps> = ({
  face,
  photo,
  currentPersonName = 'Unknown Person',
  people,
  onClose,
  onSuccess,
}) => {
  const personList = people || libraryStore.getState().people || [];
  // Available existing people: excludes the person already assigned, and excludes
  // generic auto-generated placeholders ("Person 3") — those aren't a real person
  // the user recognizes, so reassigning a face TO one would just swap one unknown
  // label for another instead of actually correcting the identification.
  const isGenericPersonName = (name: string): boolean => /^Person(\s+\d+)?$/i.test(name);
  const availablePeople = personList.filter((p) => p.id !== face.personId && !isGenericPersonName(p.name));
  const currentPerson = personList.find((p) => p.id === face.personId);

  const [mergeEntirePerson, setMergeEntirePerson] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const storePhotos = libraryStore.getState().photos;

  // Handle Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        onClose();
      }
    };
    // capture: true — see PeopleView's matching Escape handler for why.
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, [onClose]);

  /**
   * Applies the choice immediately — a click on a person, or Enter in the search box, is the whole gesture
   * (no separate confirm button). Pass an existing `person`, or a `newName` to create one.
   */
  const assign = (target: { person: Person } | { newName: string }) => {
    setErrorMessage(null);
    try {
      if ('person' in target && mergeEntirePerson && face.personId) {
        const check = libraryStore.canMergePeople(target.person.id, face.personId);
        if (!check.canMerge) {
          setErrorMessage(
            `Can't merge: "${currentPersonName}" and "${target.person.name}" both appear in photo "${check.conflictPhotoName}" — one photo can't have two faces of the same person.`
          );
          return;
        }
        if (!libraryStore.mergePeople(target.person.id, face.personId)) {
          setErrorMessage('Merge failed.');
          return;
        }
      } else {
        const result = libraryStore.reassignFaceToPerson(face.id, 'person' in target ? target.person.id : target.newName);
        if (!result.success) {
          setErrorMessage(result.error || 'Failed to reassign face.');
          return;
        }
      }
    } catch (err) {
      setErrorMessage('Could not complete the change — see the error notice.');
      notifyError('Reassign face', err);
      return;
    }

    if (onSuccess) onSuccess();
    onClose();
  };

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(5, 8, 15, 0.85)',
        backdropFilter: 'blur(8px)',
        zIndex: 2000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '20px',
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: '96vw',
          maxWidth: '900px',
          height: '86vh',
          maxHeight: '86vh',
          backgroundColor: 'var(--bg-surface)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: '0 24px 64px rgba(0, 0, 0, 0.6)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            padding: '16px 20px',
            borderBottom: '1px solid var(--border-subtle)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            backgroundColor: 'var(--bg-surface-elevated)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div
              style={{
                width: '32px',
                height: '32px',
                borderRadius: 'var(--radius-full)',
                backgroundColor: 'rgba(59, 130, 246, 0.15)',
                color: 'var(--accent-primary)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <UserCheck size={18} />
            </div>
            <h3 style={{ fontSize: '1.05rem', fontWeight: 700, color: 'var(--text-primary)' }}>
              Assign Face to Person
            </h3>
          </div>
          <button className="btn btn-ghost btn-icon" onClick={onClose} title="Close">
            <X size={18} />
          </button>
        </div>

        {/* Content */}
        <div
          style={{
            padding: '20px',
            display: 'flex',
            flexDirection: 'column',
            gap: '14px',
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
          }}
        >
          {/* Face Preview Card */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '16px',
              padding: '12px 16px',
              borderRadius: 'var(--radius-md)',
              backgroundColor: 'var(--bg-surface-elevated)',
              border: '1px solid var(--border-subtle)',
            }}
          >
            <div style={{ borderRadius: 'var(--radius-full)', overflow: 'hidden', flexShrink: 0 }}>
              <FaceAvatar photo={photo} face={face} box={face.box} size={70} alt="Detected Face" />
            </div>
            <div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Currently Assigned To:</div>
              <div style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--accent-rose)', marginTop: '2px' }}>
                {currentPersonName}
              </div>
              <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', marginTop: '4px' }}>
                Photo: <span style={{ fontFamily: 'var(--font-mono)' }}>{photo.fileName}</span>
              </div>
            </div>
          </div>

          {/* Optional: move the WHOLE current person into whoever is picked (instead of just this face). Set BEFORE picking. */}
          {currentPerson && (
            <label
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: '10px',
                padding: '10px 12px',
                borderRadius: 'var(--radius-md)',
                backgroundColor: mergeEntirePerson ? 'rgba(245, 158, 11, 0.14)' : 'rgba(245, 158, 11, 0.06)',
                border: '1px solid rgba(245, 158, 11, 0.3)',
                cursor: 'pointer',
                fontSize: '0.82rem',
              }}
            >
              <input
                type="checkbox"
                checked={mergeEntirePerson}
                onChange={(e) => setMergeEntirePerson(e.target.checked)}
                style={{ marginTop: '2px' }}
                data-testid="reassign-merge-toggle"
              />
              <span>
                <Sparkles size={13} style={{ verticalAlign: '-2px', marginRight: '4px' }} />
                <strong>Merge the whole person</strong> — move ALL {currentPerson.photoCount} photo
                {currentPerson.photoCount === 1 ? '' : 's'} of "{currentPersonName}" into the person I pick (and remove "
                {currentPersonName}"). Leave this off to reassign only this one face.
              </span>
            </label>
          )}

          <PersonPicker
            people={availablePeople}
            photos={storePhotos}
            onPick={(person) => assign({ person })}
            onCreateNew={(newName) => assign({ newName })}
            placeholder="Type a name and press Enter — or click a person below. No match creates a new person."
            emptyText="No people yet — type a name above to create one."
          />

          {errorMessage && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '10px 14px',
                backgroundColor: 'rgba(244, 63, 94, 0.12)',
                border: '1px solid rgba(244, 63, 94, 0.3)',
                borderRadius: 'var(--radius-md)',
                color: 'var(--accent-rose)',
                fontSize: '0.8rem',
              }}
            >
              <AlertCircle size={16} style={{ flexShrink: 0 }} />
              <span>{errorMessage}</span>
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '4px' }}>
            <button type="button" className="btn btn-secondary" onClick={onClose} style={{ fontSize: '0.85rem' }}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
