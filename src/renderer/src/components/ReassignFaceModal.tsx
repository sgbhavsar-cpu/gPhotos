import React, { useState, useEffect } from 'react';
import { X, UserCheck, Plus, AlertCircle, Check } from 'lucide-react';
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

  const [mode, setMode] = useState<'existing' | 'new'>(
    availablePeople.length > 0 ? 'existing' : 'new'
  );
  const [selectedPersonId, setSelectedPersonId] = useState<string>(
    availablePeople.length > 0 ? availablePeople[0].id : ''
  );
  const [newPersonName, setNewPersonName] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [searchFilter, setSearchFilter] = useState('');
  const storePhotos = libraryStore.getState().photos;

  const filteredAvailablePeople = availablePeople.filter((p) =>
    p.name.toLowerCase().includes(searchFilter.toLowerCase().trim())
  );

  // Handle Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const handleReassign = (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);

    const target = mode === 'existing' ? selectedPersonId : newPersonName.trim();
    if (!target) {
      setErrorMessage('Please specify or select a person name.');
      return;
    }

    const result = libraryStore.reassignFaceToPerson(face.id, target);
    if (!result.success) {
      setErrorMessage(result.error || 'Failed to reassign face.');
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
          maxWidth: '1400px',
          height: '92vh',
          maxHeight: '92vh',
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
            gap: '16px',
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

          {/* Mode Switcher Tabs */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
            <button
              type="button"
              className={`btn ${mode === 'existing' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => {
                setMode('existing');
                setErrorMessage(null);
              }}
              disabled={availablePeople.length === 0}
              style={{ fontSize: '0.82rem', padding: '8px' }}
            >
              <UserCheck size={15} />
              <span>Choose Existing Person</span>
            </button>

            <button
              type="button"
              className={`btn ${mode === 'new' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => {
                setMode('new');
                setErrorMessage(null);
              }}
              style={{ fontSize: '0.82rem', padding: '8px' }}
            >
              <Plus size={15} />
              <span>Name as New Person</span>
            </button>
          </div>

          {/* Form Fields */}
          {mode === 'existing' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', flex: 1, minHeight: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <label style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-secondary)' }}>
                  Select Person from Profile Cards ({filteredAvailablePeople.length}):
                </label>
                {availablePeople.length > 4 && (
                  <input
                    type="text"
                    placeholder="Search people..."
                    value={searchFilter}
                    onChange={(e) => setSearchFilter(e.target.value)}
                    onKeyDown={(e) => e.stopPropagation()}
                    className="input"
                    style={{ fontSize: '0.75rem', padding: '3px 8px', width: '150px' }}
                  />
                )}
              </div>

              {/* Big Profile Photo Cards Grid — fills the full-screen dialog so as many
                  names as possible are visible at once without needing to search */}
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
                {filteredAvailablePeople.length === 0 ? (
                  <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.85rem', gridColumn: '1 / -1' }}>
                    No matching people found.
                  </div>
                ) : (
                  filteredAvailablePeople.map((p) => {
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
                        onClick={() => setSelectedPersonId(p.id)}
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
                        <div style={{ position: 'relative', width: '64px', height: '64px', flexShrink: 0, borderRadius: '50%', overflow: 'hidden' }}>
                          {personPhoto ? (
                            <FaceAvatar photo={personPhoto} face={personFace} box={personFace?.box} size={64} alt={p.name} personId={p.id} />
                          ) : (
                            <div
                              style={{
                                width: '64px',
                                height: '64px',
                                borderRadius: '50%',
                                backgroundColor: 'rgba(255, 255, 255, 0.08)',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                              }}
                            >
                              <UserCheck size={28} color="var(--text-muted)" />
                            </div>
                          )}
                          {isSelected && (
                            <div
                              style={{
                                position: 'absolute',
                                bottom: '0',
                                right: '0',
                                width: '20px',
                                height: '20px',
                                borderRadius: '50%',
                                backgroundColor: 'var(--accent-primary)',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                boxShadow: '0 2px 6px rgba(0,0,0,0.6)',
                              }}
                            >
                              <Check size={12} color="#fff" strokeWidth={3} />
                            </div>
                          )}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div
                            style={{
                              fontSize: '0.92rem',
                              fontWeight: 700,
                              color: isSelected ? 'var(--accent-primary)' : 'var(--text-primary)',
                              whiteSpace: 'nowrap',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                            }}
                          >
                            {p.name}
                          </div>
                          <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '2px' }}>
                            {p.photoCount} {p.photoCount === 1 ? 'photo' : 'photos'}
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          ) : (
            <div>
              <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, marginBottom: '6px', color: 'var(--text-secondary)' }}>
                Enter Correct Person's Name:
              </label>
              <input
                type="text"
                value={newPersonName}
                onChange={(e) => setNewPersonName(e.target.value)}
                onKeyDown={(e) => e.stopPropagation()}
                placeholder="e.g. Monika, Uncle Bob"
                className="input"
                style={{ width: '100%', fontSize: '0.9rem' }}
                autoFocus
                required
              />
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '6px' }}>
                A new virtual album will be created for this person and this face will be assigned as verified.
              </div>
            </div>
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
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '8px' }}>
            <button type="button" className="btn btn-secondary" onClick={onClose} style={{ fontSize: '0.85rem' }}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" style={{ fontSize: '0.85rem', padding: '8px 20px' }}>
              <Check size={16} />
              <span>Confirm Reassignment</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
