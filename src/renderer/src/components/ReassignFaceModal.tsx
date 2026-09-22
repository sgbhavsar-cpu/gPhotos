import React, { useState, useEffect } from 'react';
import { X, UserCheck, AlertCircle, Check, Search, Sparkles } from 'lucide-react';
import { DetectedFace, Person, Photo } from '../../types';
import { FaceAvatar } from './FaceAvatar';
import { libraryStore } from '../services/libraryStore';

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

  const [searchText, setSearchText] = useState('');
  const [selectedPersonId, setSelectedPersonId] = useState<string | null>(null);
  const [mergeEntirePerson, setMergeEntirePerson] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const storePhotos = libraryStore.getState().photos;

  const filteredPeople = availablePeople.filter((p) =>
    p.name.toLowerCase().includes(searchText.toLowerCase().trim())
  );
  const selectedPerson = selectedPersonId ? availablePeople.find((p) => p.id === selectedPersonId) : undefined;
  const willCreateNew = !selectedPersonId && searchText.trim().length > 0 && filteredPeople.length === 0;

  const canOfferMerge = Boolean(selectedPerson && currentPerson);

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

  const handleSelectPerson = (p: Person) => {
    setSelectedPersonId(p.id);
    setSearchText(p.name);
    setErrorMessage(null);
  };

  const handleSearchChange = (value: string) => {
    setSearchText(value);
    // Typing again after a click invalidates that selection — either they
    // pick a (possibly different) match from the refreshed list below, or
    // keep typing to create a new person from whatever they land on.
    if (selectedPersonId) setSelectedPersonId(null);
    setMergeEntirePerson(false);
    setErrorMessage(null);
  };

  const handleReassign = (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);

    const target = selectedPersonId || searchText.trim();
    if (!target) {
      setErrorMessage('Type a name or select a person below.');
      return;
    }

    if (mergeEntirePerson && selectedPersonId && face.personId) {
      const check = libraryStore.canMergePeople(selectedPersonId, face.personId);
      if (!check.canMerge) {
        setErrorMessage(
          `Can't merge: "${currentPersonName}" and "${selectedPerson?.name}" both appear in photo "${check.conflictPhotoName}" — one photo can't have two faces of the same person.`
        );
        return;
      }
      if (!libraryStore.mergePeople(selectedPersonId, face.personId)) {
        setErrorMessage('Merge failed.');
        return;
      }
    } else {
      const result = libraryStore.reassignFaceToPerson(face.id, target);
      if (!result.success) {
        setErrorMessage(result.error || 'Failed to reassign face.');
        return;
      }
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
              Reassign Face Detection
            </h3>
          </div>
          <button className="btn btn-ghost btn-icon" onClick={onClose} title="Close">
            <X size={18} />
          </button>
        </div>

        {/* Content */}
        <form
          onSubmit={handleReassign}
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

          {/* Single search box */}
          <div style={{ position: 'relative' }}>
            <Search
              size={15}
              color="var(--text-muted)"
              style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)' }}
            />
            <input
              type="text"
              value={searchText}
              onChange={(e) => handleSearchChange(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              placeholder="Type a name — pick from the list, or keep typing to create a new person"
              className="input"
              style={{ width: '100%', fontSize: '0.9rem', paddingLeft: '36px' }}
              autoFocus
            />
          </div>

          {willCreateNew ? (
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', padding: '0 2px' }}>
              No match — this will create a new person named <strong style={{ color: 'var(--text-primary)' }}>"{searchText.trim()}"</strong>.
            </div>
          ) : selectedPerson ? (
            <div style={{ fontSize: '0.8rem', color: 'var(--accent-emerald)', padding: '0 2px', fontWeight: 600 }}>
              ✓ Will reassign to "{selectedPerson.name}"
            </div>
          ) : null}

          {/* People list */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
              gap: '10px',
              flex: 1,
              minHeight: 0,
              overflowY: 'auto',
              padding: '4px',
              alignContent: 'start',
            }}
          >
            {filteredPeople.length === 0 ? (
              !willCreateNew && (
                <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.85rem', gridColumn: '1 / -1' }}>
                  No people yet — type a name above to create one.
                </div>
              )
            ) : (
              filteredPeople.map((p) => {
                const isSelected = selectedPersonId === p.id;
                const personPhoto =
                  storePhotos.find((ph) => ph.id === p.coverPhotoId) ||
                  storePhotos.find((ph) => ph.faces?.some((f) => f.personId === p.id));
                const personFace = personPhoto?.faces?.find((f) => f.personId === p.id);

                return (
                  <div
                    key={p.id}
                    title={`Select ${p.name}`}
                    data-testid="reassign-person-card"
                    onClick={() => handleSelectPerson(p)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '12px',
                      padding: '10px 12px',
                      borderRadius: 'var(--radius-md)',
                      backgroundColor: isSelected ? 'rgba(59, 130, 246, 0.15)' : 'var(--bg-surface-elevated)',
                      border: isSelected ? '2px solid var(--accent-primary)' : '1px solid var(--border-subtle)',
                      cursor: 'pointer',
                      boxShadow: isSelected ? '0 0 14px rgba(59, 130, 246, 0.4)' : 'none',
                      transition: 'all 0.15s ease',
                    }}
                  >
                    <div style={{ position: 'relative', width: '52px', height: '52px', flexShrink: 0, borderRadius: '50%', overflow: 'hidden' }}>
                      {personPhoto ? (
                        <FaceAvatar photo={personPhoto} face={personFace} box={personFace?.box} size={52} alt={p.name} personId={p.id} />
                      ) : (
                        <div
                          style={{
                            width: '52px',
                            height: '52px',
                            borderRadius: '50%',
                            backgroundColor: 'rgba(255, 255, 255, 0.08)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}
                        >
                          <UserCheck size={24} color="var(--text-muted)" />
                        </div>
                      )}
                      {isSelected && (
                        <div
                          style={{
                            position: 'absolute',
                            bottom: '0',
                            right: '0',
                            width: '18px',
                            height: '18px',
                            borderRadius: '50%',
                            backgroundColor: 'var(--accent-primary)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            boxShadow: '0 2px 6px rgba(0,0,0,0.6)',
                          }}
                        >
                          <Check size={11} color="#fff" strokeWidth={3} />
                        </div>
                      )}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: '0.88rem',
                          fontWeight: 700,
                          color: isSelected ? 'var(--accent-primary)' : 'var(--text-primary)',
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {p.name}
                      </div>
                      <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '2px' }}>
                        {p.photoCount} {p.photoCount === 1 ? 'photo' : 'photos'}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* Merge-entire-person checkbox */}
          {canOfferMerge && (
            <label
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: '10px',
                padding: '10px 12px',
                borderRadius: 'var(--radius-md)',
                backgroundColor: 'rgba(245, 158, 11, 0.08)',
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
              />
              <span>
                <strong>Merge this person with selected</strong> — moves ALL of{' '}
                {currentPerson!.photoCount} photo{currentPerson!.photoCount === 1 ? '' : 's'} currently assigned to{' '}
                "{currentPersonName}" into "{selectedPerson!.name}", then removes "{currentPersonName}" (it will have 0
                photos left). Otherwise, only this one face gets reassigned.
              </span>
            </label>
          )}

          {/* Error message */}
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

          {/* Action Buttons */}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '4px' }}>
            <button type="button" className="btn btn-secondary" onClick={onClose} style={{ fontSize: '0.85rem' }}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" style={{ fontSize: '0.85rem', padding: '8px 20px' }} disabled={!searchText.trim() && !selectedPersonId}>
              {mergeEntirePerson ? <Sparkles size={16} /> : <Check size={16} />}
              <span>{mergeEntirePerson ? 'Merge & Reassign' : 'Confirm Reassignment'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
