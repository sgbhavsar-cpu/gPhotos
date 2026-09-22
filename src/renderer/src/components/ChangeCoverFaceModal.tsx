import React, { useState, useEffect } from 'react';
import { X, Star, Sparkles, Check, Image as ImageIcon, CheckCircle2, User } from 'lucide-react';
import { Person, Photo, DetectedFace } from '../../types';
import { FaceAvatar } from './FaceAvatar';
import { libraryStore } from '../services/libraryStore';

interface ChangeCoverFaceModalProps {
  person: Person;
  photos: Photo[];
  onClose: () => void;
  onCoverChanged?: (photoId: string, faceId: string) => void;
}

export const ChangeCoverFaceModal: React.FC<ChangeCoverFaceModalProps> = ({
  person,
  photos,
  onClose,
  onCoverChanged,
}) => {
  const [selectedFaceId, setSelectedFaceId] = useState<string>(person.coverFaceId || '');
  const [selectedPhotoId, setSelectedPhotoId] = useState<string>(person.coverPhotoId || '');
  const [notification, setNotification] = useState<string | null>(null);

  // Gather all photo/face candidate pairs for this person
  const faceItems: Array<{
    photo: Photo;
    face: DetectedFace;
    isCurrent: boolean;
    score: number;
  }> = [];

  for (const photo of photos) {
    if (!photo.faces) continue;
    for (const face of photo.faces) {
      if (face.personId === person.id) {
        const area = (face.box.width || 50) * (face.box.height || 50);
        const sizeFactor = Math.min(2.0, Math.max(0.5, Math.sqrt(area) / 100));
        const conf = face.confidence || 0.8;
        const confirmedBonus = face.isConfirmed ? 1.4 : 1.0;
        const happyBonus = (face.dominantExpression === 'happy' || (face.expressions?.happy || 0) > 0.4) ? 1.3 : 1.0;
        const sharpness = photo.sharpnessScore ? (photo.sharpnessScore / 50) : 1.0;
        const score = Math.round(conf * sizeFactor * confirmedBonus * happyBonus * sharpness * 50);

        const isCurrent = (person.coverFaceId ? face.id === person.coverFaceId : photo.id === person.coverPhotoId);

        faceItems.push({
          photo,
          face,
          isCurrent,
          score,
        });
      }
    }
  }

  // Sort: current cover first, then highest quality score
  faceItems.sort((a, b) => {
    if (a.isCurrent) return -1;
    if (b.isCurrent) return 1;
    return b.score - a.score;
  });

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

  const handleSelectCover = (photoId: string, faceId: string) => {
    setSelectedPhotoId(photoId);
    setSelectedFaceId(faceId);
    libraryStore.setPersonCover(person.id, photoId, faceId);
    setNotification('✓ Cover face updated successfully!');
    if (onCoverChanged) onCoverChanged(photoId, faceId);
    setTimeout(() => setNotification(null), 3000);
  };

  const handleAutoPickBest = () => {
    const best = libraryStore.autoSelectBestFaceCover(person.id);
    if (best) {
      setSelectedPhotoId(best.photoId);
      setSelectedFaceId(best.faceId);
      setNotification(`✓ AI picked top-scoring face (Quality Score: ${best.score}/100)!`);
      if (onCoverChanged) onCoverChanged(best.photoId, best.faceId);
      setTimeout(() => setNotification(null), 3500);
    }
  };

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.78)',
        backdropFilter: 'blur(8px)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="animate-in"
        style={{
          backgroundColor: 'var(--bg-surface)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-xl)',
          width: '100%',
          maxWidth: '780px',
          maxHeight: '85vh',
          boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.7)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* Modal Header */}
        <div
          style={{
            padding: '20px 28px',
            borderBottom: '1px solid var(--border-subtle)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            backgroundColor: 'var(--bg-surface-elevated)',
          }}
        >
          <div>
            <h3 style={{ fontSize: '1.2rem', fontWeight: 700, margin: 0, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Star size={20} color="var(--accent-amber)" />
              <span>Select Best Face for {person.name}</span>
            </h3>
            <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', margin: '4px 0 0' }}>
              Choose which face or photo is displayed in the People list and album avatar
            </p>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <button
              className="btn btn-primary"
              onClick={handleAutoPickBest}
              style={{ fontSize: '0.8rem', padding: '6px 14px', gap: '6px' }}
              title="Automatically select highest sharpness and smiling portrait"
            >
              <Sparkles size={14} />
              <span>AI Auto-Pick Best</span>
            </button>

            <button
              className="btn btn-ghost"
              onClick={onClose}
              style={{ padding: '6px', borderRadius: 'var(--radius-full)' }}
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Feedback Banner */}
        {notification && (
          <div
            style={{
              padding: '10px 28px',
              backgroundColor: 'rgba(16, 185, 129, 0.15)',
              borderBottom: '1px solid rgba(16, 185, 129, 0.3)',
              fontSize: '0.85rem',
              fontWeight: 600,
              color: 'var(--accent-emerald)',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
            }}
          >
            <CheckCircle2 size={16} />
            <span>{notification}</span>
          </div>
        )}

        {/* Candidates Grid */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '24px 28px' }}>
          {faceItems.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-muted)' }}>
              <User size={48} style={{ margin: '0 auto 12px', opacity: 0.4 }} />
              <p>No detected face instances found for {person.name}.</p>
            </div>
          ) : (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
                gap: '16px',
              }}
            >
              {faceItems.map(({ photo, face, score }) => {
                const isSelected = selectedFaceId === face.id || (!selectedFaceId && selectedPhotoId === photo.id);

                return (
                  <div
                    key={face.id}
                    onClick={() => handleSelectCover(photo.id, face.id)}
                    style={{
                      position: 'relative',
                      backgroundColor: 'var(--bg-surface-elevated)',
                      borderRadius: 'var(--radius-lg)',
                      border: isSelected
                        ? '3px solid var(--accent-amber)'
                        : '1px solid var(--border-subtle)',
                      boxShadow: isSelected
                        ? '0 0 16px rgba(245, 158, 11, 0.4)'
                        : 'var(--shadow-sm)',
                      padding: '14px',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      cursor: 'pointer',
                      transition: 'all var(--transition-fast)',
                    }}
                  >
                    {/* Active Selected Badge */}
                    {isSelected && (
                      <div
                        style={{
                          position: 'absolute',
                          top: '8px',
                          right: '8px',
                          backgroundColor: 'var(--accent-amber)',
                          color: '#000',
                          borderRadius: 'var(--radius-full)',
                          padding: '2px 8px',
                          fontSize: '0.68rem',
                          fontWeight: 700,
                          display: 'flex',
                          alignItems: 'center',
                          gap: '3px',
                          boxShadow: '0 2px 6px rgba(0,0,0,0.3)',
                          zIndex: 2,
                        }}
                      >
                        <Star size={10} fill="#000" />
                        <span>Cover</span>
                      </div>
                    )}

                    {/* Face Avatar Crop */}
                    <div style={{ marginBottom: '10px' }}>
                      <FaceAvatar
                        photo={photo}
                        face={face}
                        box={face.box}
                        size={100}
                        alt={person.name}
                        borderRadius="var(--radius-md)"
                        preferOriginal
                      />
                    </div>

                    {/* Score & Attributes */}
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '3px', width: '100%' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                        <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                          {score} pts
                        </span>
                        {face.dominantExpression === 'happy' && (
                          <span title="Smiling / Happy expression" style={{ fontSize: '0.8rem' }}>😊</span>
                        )}
                        {face.isConfirmed && (
                          <span title="Verified ground truth" style={{ fontSize: '0.72rem', color: 'var(--accent-emerald)' }}>✓</span>
                        )}
                      </div>

                      <span
                        style={{
                          fontSize: '0.7rem',
                          color: 'var(--text-muted)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          maxWidth: '120px',
                        }}
                        title={photo.fileName}
                      >
                        {photo.fileName}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div
          style={{
            padding: '16px 28px',
            borderTop: '1px solid var(--border-subtle)',
            backgroundColor: 'var(--bg-surface-elevated)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
            {faceItems.length} face {faceItems.length === 1 ? 'instance' : 'instances'} available
          </span>

          <button
            className="btn btn-primary"
            onClick={onClose}
            style={{ fontSize: '0.86rem', padding: '8px 24px' }}
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
