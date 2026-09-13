import React, { useState, useMemo, useEffect } from 'react';
import { X, Merge, AlertCircle, Check, Users, ExternalLink } from 'lucide-react';
import { Person, Photo } from '../../types';
import { FaceAvatar } from './FaceAvatar';
import { libraryStore, getLocalPhotoUrl } from '../services/libraryStore';

interface MergePeopleModalProps {
  personA: Person;
  personB?: Person;
  allPeople: Person[];
  photos: Photo[];
  onClose: () => void;
  onSuccess?: () => void;
  onOpenConflictPhoto?: (photo: Photo) => void;
}

export const MergePeopleModal: React.FC<MergePeopleModalProps> = ({
  personA,
  personB: initialPersonB,
  allPeople = [],
  photos = [],
  onClose,
  onSuccess,
  onOpenConflictPhoto,
}) => {
  const candidatePeople = useMemo(
    () => (allPeople || []).filter((p) => p.id !== personA.id),
    [allPeople, personA]
  );

  const [selectedPersonBId, setSelectedPersonBId] = useState<string>(
    initialPersonB?.id || (candidatePeople.length > 0 ? candidatePeople[0].id : '')
  );

  const personB = useMemo(
    () => candidatePeople.find((p) => p.id === selectedPersonBId),
    [candidatePeople, selectedPersonBId]
  );

  const [nameChoice, setNameChoice] = useState<'A' | 'B' | 'custom'>('A');
  const [customName, setCustomName] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Check if they can merge (single photo constraint)
  const mergeCheck = useMemo(() => {
    if (!personB) return { canMerge: false, conflictPhotoName: undefined };
    return libraryStore.canMergePeople(personA.id, personB.id);
  }, [personA, personB]);

  // Find cover photos and faces
  const getCoverPhotoAndBox = (person: Person) => {
    const photo = photos.find(
      (p) => p.id === person.coverPhotoId || p.faces?.some((f) => f.personId === person.id)
    );
    const face = photo?.faces?.find(
      (f) => f.id === person.coverFaceId || f.personId === person.id
    );
    return { photo, face, box: face?.box };
  };

  const coverA = getCoverPhotoAndBox(personA);
  const coverB = personB ? getCoverPhotoAndBox(personB) : { photo: undefined, face: undefined, box: undefined };

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

  const handleMerge = (e: React.FormEvent) => {
    e.preventDefault();
    if (!personB) return;

    if (!mergeCheck.canMerge) {
      setErrorMessage(
        `Cannot merge: both people appear together in the same photo (${mergeCheck.conflictPhotoName || 'photo'}). They cannot physically be the same person.`
      );
      return;
    }

    let finalName = personA.name;
    if (nameChoice === 'B') finalName = personB.name;
    else if (nameChoice === 'custom') {
      if (!customName.trim()) {
        setErrorMessage('Please provide a name.');
        return;
      }
      finalName = customName.trim();
    }

    const success = libraryStore.mergePeople(personA.id, personB.id, finalName);
    if (!success) {
      setErrorMessage('Merge operation could not be completed.');
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
          width: '100%',
          maxWidth: '520px',
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
                backgroundColor: 'rgba(236, 72, 153, 0.15)',
                color: '#ec4899',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Merge size={18} />
            </div>
            <h3 style={{ fontSize: '1.05rem', fontWeight: 700, color: 'var(--text-primary)' }}>
              Merge People Virtual Albums
            </h3>
          </div>
          <button className="btn btn-ghost btn-icon" onClick={onClose} title="Close">
            <X size={18} />
          </button>
        </div>

        {/* Content */}
        <form onSubmit={handleMerge} style={{ padding: '24px 20px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
          {/* Select Person B if not fixed */}
          {!initialPersonB && candidatePeople.length > 0 && (
            <div>
              <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, marginBottom: '6px', color: 'var(--text-secondary)' }}>
                Select Person to Merge With {personA.name}:
              </label>
              <select
                value={selectedPersonBId}
                onChange={(e) => setSelectedPersonBId(e.target.value)}
                className="input"
                style={{ width: '100%', fontSize: '0.9rem' }}
              >
                {candidatePeople.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.photoCount} {p.photoCount === 1 ? 'photo' : 'photos'})
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Side-by-side People Comparison */}
          {personB && (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr auto 1fr',
                gap: '12px',
                alignItems: 'center',
                padding: '16px',
                backgroundColor: 'var(--bg-surface-elevated)',
                borderRadius: 'var(--radius-md)',
                border: '1px solid var(--border-subtle)',
              }}
            >
              {/* Person A */}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: '8px' }}>
                <div style={{ borderRadius: 'var(--radius-full)', overflow: 'hidden' }}>
                  <FaceAvatar photo={coverA.photo} face={coverA.face} box={coverA.box} size={68} alt={personA.name} />
                </div>
                <div>
                  <div style={{ fontWeight: 700, fontSize: '0.9rem', color: 'var(--text-primary)' }}>{personA.name}</div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{personA.photoCount} photos</div>
                </div>
              </div>

              {/* Merge Arrow */}
              <div
                style={{
                  width: '36px',
                  height: '36px',
                  borderRadius: 'var(--radius-full)',
                  backgroundColor: 'rgba(236, 72, 153, 0.1)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#ec4899',
                }}
              >
                <Merge size={18} />
              </div>

              {/* Person B */}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: '8px' }}>
                <div style={{ borderRadius: 'var(--radius-full)', overflow: 'hidden' }}>
                  <FaceAvatar photo={coverB.photo} face={coverB.face} box={coverB.box} size={68} alt={personB.name} />
                </div>
                <div>
                  <div style={{ fontWeight: 700, fontSize: '0.9rem', color: 'var(--text-primary)' }}>{personB.name}</div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{personB.photoCount} photos</div>
                </div>
              </div>
            </div>
          )}

          {/* Name Choice */}
          {personB && (
            <div>
              <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, marginBottom: '8px', color: 'var(--text-secondary)' }}>
                Choose Final Name for Merged Person:
              </label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '10px',
                    padding: '8px 12px',
                    borderRadius: 'var(--radius-sm)',
                    backgroundColor: nameChoice === 'A' ? 'rgba(59, 130, 246, 0.15)' : 'var(--bg-surface-elevated)',
                    border: nameChoice === 'A' ? '1px solid var(--accent-primary)' : '1px solid var(--border-subtle)',
                    cursor: 'pointer',
                    fontSize: '0.85rem',
                  }}
                >
                  <input
                    type="radio"
                    name="nameChoice"
                    checked={nameChoice === 'A'}
                    onChange={() => setNameChoice('A')}
                  />
                  <span>Keep: <strong>{personA.name}</strong></span>
                </label>

                <label
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '10px',
                    padding: '8px 12px',
                    borderRadius: 'var(--radius-sm)',
                    backgroundColor: nameChoice === 'B' ? 'rgba(59, 130, 246, 0.15)' : 'var(--bg-surface-elevated)',
                    border: nameChoice === 'B' ? '1px solid var(--accent-primary)' : '1px solid var(--border-subtle)',
                    cursor: 'pointer',
                    fontSize: '0.85rem',
                  }}
                >
                  <input
                    type="radio"
                    name="nameChoice"
                    checked={nameChoice === 'B'}
                    onChange={() => setNameChoice('B')}
                  />
                  <span>Keep: <strong>{personB.name}</strong></span>
                </label>

                <label
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '10px',
                    padding: '8px 12px',
                    borderRadius: 'var(--radius-sm)',
                    backgroundColor: nameChoice === 'custom' ? 'rgba(59, 130, 246, 0.15)' : 'var(--bg-surface-elevated)',
                    border: nameChoice === 'custom' ? '1px solid var(--accent-primary)' : '1px solid var(--border-subtle)',
                    cursor: 'pointer',
                    fontSize: '0.85rem',
                  }}
                >
                  <input
                    type="radio"
                    name="nameChoice"
                    checked={nameChoice === 'custom'}
                    onChange={() => setNameChoice('custom')}
                  />
                  <span>Use new custom name:</span>
                </label>

                {nameChoice === 'custom' && (
                  <input
                    type="text"
                    value={customName}
                    onChange={(e) => setCustomName(e.target.value)}
                    onKeyDown={(e) => e.stopPropagation()}
                    placeholder="Enter merged name..."
                    className="input"
                    style={{ marginLeft: '26px', fontSize: '0.85rem' }}
                    autoFocus
                  />
                )}
              </div>
            </div>
          )}

          {/* Validation Info or Conflict Alert */}
          {personB && (
            <div>
              {mergeCheck.canMerge ? (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    fontSize: '0.8rem',
                    color: 'var(--accent-emerald)',
                    padding: '8px 12px',
                    backgroundColor: 'rgba(16, 185, 129, 0.1)',
                    borderRadius: 'var(--radius-sm)',
                  }}
                >
                  <Check size={16} />
                  <span>
                    Valid merge! All photos from both people will be unified into one virtual album.
                  </span>
                </div>
              ) : (
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '10px',
                    padding: '12px 14px',
                    backgroundColor: 'rgba(244, 63, 94, 0.08)',
                    borderRadius: 'var(--radius-md)',
                    border: '1px solid rgba(244, 63, 94, 0.3)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', fontSize: '0.8rem', color: 'var(--accent-rose)' }}>
                    <AlertCircle size={16} style={{ flexShrink: 0, marginTop: '2px' }} />
                    <div>
                      Cannot merge: both <strong>{personA.name}</strong> and <strong>{personB.name}</strong> appear in photo <strong>{mergeCheck.conflictPhotoName}</strong>. A single photo cannot contain two faces of the same person.
                    </div>
                  </div>

                  {mergeCheck.conflictPhoto && (
                    <div
                      onClick={() => {
                        if (onOpenConflictPhoto && mergeCheck.conflictPhoto) {
                          onOpenConflictPhoto(mergeCheck.conflictPhoto);
                          onClose();
                        }
                      }}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '12px',
                        padding: '8px 12px',
                        borderRadius: 'var(--radius-sm)',
                        backgroundColor: 'rgba(15, 23, 42, 0.85)',
                        border: '1px solid rgba(244, 63, 94, 0.25)',
                        cursor: onOpenConflictPhoto ? 'pointer' : 'default',
                        transition: 'all 0.15s ease-in-out',
                      }}
                      className="conflict-photo-card"
                      title="Click to open this photo in Lightbox to change or reassign one of the faces and resolve conflict"
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0, flex: 1 }}>
                        <img
                          src={getLocalPhotoUrl(mergeCheck.conflictPhoto.filePath, mergeCheck.conflictPhoto.originalRemotePath, false)}
                          alt={mergeCheck.conflictPhoto.fileName}
                          style={{
                            width: '44px',
                            height: '44px',
                            objectFit: 'cover',
                            borderRadius: '4px',
                            flexShrink: 0,
                            border: '1px solid rgba(255,255,255,0.1)',
                          }}
                        />
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {mergeCheck.conflictPhoto.fileName}
                          </div>
                          <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                            Click to open in Lightbox & fix face assignment
                          </div>
                        </div>
                      </div>

                      {onOpenConflictPhoto && (
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '5px',
                            fontSize: '0.75rem',
                            fontWeight: 600,
                            color: 'var(--accent-primary)',
                            padding: '4px 8px',
                            borderRadius: '4px',
                            backgroundColor: 'rgba(59, 130, 246, 0.12)',
                            flexShrink: 0,
                          }}
                        >
                          <span>Fix Face</span>
                          <ExternalLink size={13} />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {errorMessage && (
            <div
              style={{
                fontSize: '0.8rem',
                color: 'var(--accent-rose)',
                padding: '8px 12px',
                backgroundColor: 'rgba(244, 63, 94, 0.12)',
                borderRadius: 'var(--radius-sm)',
              }}
            >
              {errorMessage}
            </div>
          )}

          {/* Footer Buttons */}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '8px' }}>
            <button type="button" className="btn btn-secondary" onClick={onClose} style={{ fontSize: '0.85rem' }}>
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={!mergeCheck.canMerge || !personB}
              style={{ fontSize: '0.85rem', padding: '8px 20px' }}
            >
              <Merge size={16} />
              <span>Confirm & Merge</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
