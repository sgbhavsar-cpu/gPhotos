import React, { useState, useEffect } from 'react';
import {
  Users,
  Edit2,
  Check,
  X,
  ArrowLeft,
  Merge,
  Sparkles,
  CheckCircle2,
  UserX,
  UserCheck,
  Trash2,
  Eye,
  Crop,
  Image as ImageIcon,
  RotateCcw,
  Camera,
  Star,
  ZoomIn,
  ZoomOut
} from 'lucide-react';
import { Person, Photo, DetectedFace } from '../../types';
import { PhotoCard } from '../components/PhotoCard';
import { FaceAvatar } from '../components/FaceAvatar';
import { ChangeCoverFaceModal } from '../components/ChangeCoverFaceModal';
import { PersonNameInput } from '../components/PersonNameInput';
import { libraryStore, getLocalPhotoUrl } from '../services/libraryStore';
import { VirtualizedTimelineGallery, GalleryZoomLevel, ZOOM_LEVELS } from '../components/VirtualizedTimelineGallery';

interface PeopleViewProps {
  people: Person[];
  photos: Photo[];
  onUpdatePersonName: (personId: string, newName: string) => void;
  onMergePeople: (targetPersonId: string, sourcePersonId: string) => void;
  onSelectPhoto: (photo: Photo) => void;
  onToggleFavorite: (photoId: string) => void;
  onTriggerFaceDetection: () => void;
  isDetectingFaces: boolean;
  onResetAndRescan?: () => void;
  initialSelectedPersonId?: string | null;
  onClearSelectedPerson?: () => void;
  resetTrigger?: number;
}

export const PeopleView: React.FC<PeopleViewProps> = ({
  people,
  photos,
  onUpdatePersonName,
  onMergePeople,
  onSelectPhoto,
  onToggleFavorite,
  onTriggerFaceDetection,
  isDetectingFaces,
  onResetAndRescan,
  initialSelectedPersonId,
  onClearSelectedPerson,
  resetTrigger,
}) => {
  const [selectedPersonId, setSelectedPersonId] = useState<string | null>(initialSelectedPersonId || null);
  const [removedFaceIds, setRemovedFaceIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (initialSelectedPersonId) {
      setSelectedPersonId(initialSelectedPersonId);
    }
    setRemovedFaceIds(new Set());
  }, [initialSelectedPersonId]);

  useEffect(() => {
    if (resetTrigger) {
      setSelectedPersonId(null);
      if (onClearSelectedPerson) onClearSelectedPerson();
    }
  }, [resetTrigger]);
  const [editingPersonId, setEditingPersonId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [learningNotification, setLearningNotification] = useState<string | null>(null);
  const [mergeSelection, setMergeSelection] = useState<string[]>([]);
  const [isMergeMode, setIsMergeMode] = useState(false);
  const [viewMode, setViewMode] = useState<'photos' | 'faces'>('photos');
  const [zoomLevel, setZoomLevel] = useState<GalleryZoomLevel>('medium');

  // Modal states
  const [reassignTarget, setReassignTarget] = useState<{
    face: DetectedFace;
    photo: Photo;
    currentPersonName?: string;
  } | null>(null);

  const [mergeModalPair, setMergeModalPair] = useState<{
    personA: Person;
    personB?: Person;
  } | null>(null);

  const [personForCoverModal, setPersonForCoverModal] = useState<Person | null>(null);

  // Handle Escape key navigation inside PeopleView
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;

      if (reassignTarget) {
        e.stopPropagation();
        setReassignTarget(null);
      } else if (personForCoverModal) {
        e.stopPropagation();
        setPersonForCoverModal(null);
      } else if (mergeModalPair) {
        e.stopPropagation();
        setMergeModalPair(null);
      } else if (editingPersonId) {
        e.stopPropagation();
        setEditingPersonId(null);
      } else if (isMergeMode) {
        e.stopPropagation();
        setIsMergeMode(false);
        setMergeSelection([]);
      } else if (selectedPersonId) {
        e.stopPropagation();
        setSelectedPersonId(null);
        if (onClearSelectedPerson) onClearSelectedPerson();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    reassignTarget,
    personForCoverModal,
    mergeModalPair,
    editingPersonId,
    isMergeMode,
    selectedPersonId,
    onClearSelectedPerson,
  ]);

  // If a person is selected, show their virtual album
  const selectedPerson = people.find((p) => p.id === selectedPersonId);

  // Find all photos and corresponding face objects for this person (filtering out immediately removed faces)
  const personPhotoItems = selectedPerson
    ? photos
        .map((photo) => {
          const face = photo.faces?.find((f) => f.personId === selectedPerson.id);
          return { photo, face };
        })
        .filter((item): item is { photo: Photo; face: DetectedFace } =>
          item.face !== undefined && !removedFaceIds.has(item.face.id)
        )
    : [];

  const handleStartRename = (person: Person, e?: React.MouseEvent) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    setEditingPersonId(person.id);
  };

  const handleSaveRename = (personId: string, newName: string) => {
    const clean = newName.trim();
    if (clean) {
      if (onUpdatePersonName) onUpdatePersonName(personId, clean);
      const res = libraryStore.updatePersonName(personId, clean);
      if (res && !res.success && res.error) {
        alert(res.error);
        return;
      }
      if (res && res.merged) {
        if (selectedPersonId === personId) {
          const target = people.find((p) => p.name.toLowerCase() === clean.toLowerCase());
          if (target) setSelectedPersonId(target.id);
        }
      }
    }
    setEditingPersonId(null);
  };

  const handleCancelRename = (e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setEditingPersonId(null);
  };

  const toggleMergeSelect = (personId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setMergeSelection((prev) =>
      prev.includes(personId) ? prev.filter((id) => id !== personId) : [...prev, personId]
    );
  };

  const handleExecuteMerge = () => {
    if (mergeSelection.length === 2) {
      const p1 = people.find((p) => p.id === mergeSelection[0]);
      const p2 = people.find((p) => p.id === mergeSelection[1]);
      if (p1 && p2) {
        setMergeModalPair({ personA: p1, personB: p2 });
      }
    }
  };

  // Find cover photo and corresponding cover face
  const getCoverDetails = (person: Person): { photo?: Photo; face?: DetectedFace } => {
    let photo: Photo | undefined;
    let face: DetectedFace | undefined;

    if (person.coverPhotoId) {
      photo = photos.find((p) => p.id === person.coverPhotoId);
    }
    if (!photo) {
      photo = photos.find((p) => p.faces?.some((f) => f.personId === person.id));
    }

    if (photo && photo.faces) {
      if (person.coverFaceId) {
        face = photo.faces.find((f) => f.id === person.coverFaceId);
      }
      if (!face) {
        face = photo.faces.find((f) => f.personId === person.id);
      }
    }

    return { photo, face };
  };

  // Face curation actions with Active Learning propagation
  const handleConfirmFace = (faceId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const result = libraryStore.confirmFace(faceId);
    if (result && result.newlyAssignedCount > 0) {
      setLearningNotification(
        `✓ Face confirmed! Discovered ${result.newlyAssignedCount} additional photo${result.newlyAssignedCount > 1 ? 's' : ''} of ${selectedPerson?.name || 'this person'} using learned 2.5x weighted centroid.`
      );
    } else {
      setLearningNotification(
        `✓ Face confirmed! Centroid updated with 2.5x ground-truth weight to improve future recognition.`
      );
    }
    setTimeout(() => {
      setLearningNotification((curr) => curr?.startsWith('✓') ? null : curr);
    }, 4500);
  };

  const handleUnassignFace = (faceId: string, personName: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setRemovedFaceIds((prev) => new Set([...prev, faceId]));
    const res = libraryStore.unassignFaceFromPerson(faceId);
    const photoName = res?.photoName || 'Photo';
    setLearningNotification(`✕ ${photoName} removed from ${personName}'s album.`);
    setTimeout(() => {
      setLearningNotification((curr) => curr?.startsWith('✕') ? null : curr);
    }, 3500);
  };

  const handleDeleteDetection = (faceId: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    libraryStore.deleteFaceDetection(faceId);
  };

  const handleDeletePerson = async (personId: string, personName: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    const confirmed = window.confirm(
      `Are you sure you want to delete "${personName}" from People?\n\nAll face detections assigned to this person will be unassigned.`
    );
    if (!confirmed) return;

    if (selectedPersonId === personId) {
      setSelectedPersonId(null);
    }
    await libraryStore.deletePerson(personId);
  };

  // ================= 1. Person Virtual Album Detail View =================
  if (selectedPerson) {
    const { photo: coverPhoto, face: coverFace } = getCoverDetails(selectedPerson);

    return (
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Person Header */}
        <div style={{
          padding: '20px 32px',
          borderBottom: '1px solid var(--border-subtle)',
          backgroundColor: 'var(--bg-surface)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
            <button
              className="btn btn-ghost btn-icon"
              onClick={() => {
                setSelectedPersonId(null);
                if (onClearSelectedPerson) onClearSelectedPerson();
              }}
              title="Back to People"
            >
              <ArrowLeft size={20} />
            </button>

            {/* Zoomed Face Avatar - Click to choose cover face */}
            <div
              style={{
                position: 'relative',
                border: '3px solid var(--accent-primary)',
                borderRadius: 'var(--radius-full)',
                boxShadow: '0 4px 14px rgba(59, 130, 246, 0.35)',
                overflow: 'hidden',
                cursor: 'pointer',
              }}
              onClick={() => setPersonForCoverModal(selectedPerson)}
              title="Click to choose a different face or photo as cover"
            >
              <FaceAvatar
                photo={coverPhoto}
                face={coverFace}
                box={coverFace?.box}
                size={68}
                alt={selectedPerson.name}
              />
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  backgroundColor: 'rgba(0,0,0,0.4)',
                  opacity: 0,
                  transition: 'opacity 0.2s ease',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.opacity = '1')}
                onMouseLeave={(e) => (e.currentTarget.style.opacity = '0')}
              >
                <Camera size={20} color="white" />
              </div>
            </div>

            <div>
              {editingPersonId === selectedPerson.id ? (
                <PersonNameInput
                  initialValue={selectedPerson.name}
                  onSave={(val) => handleSaveRename(selectedPerson.id, val)}
                  onCancel={() => setEditingPersonId(null)}
                  isLarge={true}
                />
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <h2
                    style={{ fontSize: '1.45rem', fontWeight: 700, color: 'var(--text-primary)', cursor: 'pointer' }}
                    onClick={() => handleStartRename(selectedPerson)}
                    title="Click to rename"
                  >
                    {selectedPerson.name}
                  </h2>
                  <button
                    className="btn btn-ghost btn-icon"
                    style={{ width: '36px', height: '36px' }}
                    onClick={(e) => handleStartRename(selectedPerson, e)}
                    title="Rename Person"
                  >
                    <Edit2 size={18} color="var(--text-muted)" />
                  </button>
                  <button
                    className="btn btn-ghost btn-icon"
                    style={{ width: '36px', height: '36px', color: 'var(--accent-rose)' }}
                    onClick={(e) => handleDeletePerson(selectedPerson.id, selectedPerson.name, e)}
                    title={`Delete ${selectedPerson.name}`}
                  >
                    <Trash2 size={18} />
                  </button>
                </div>
              )}

              <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginTop: '2px' }}>
                {personPhotoItems.length} {personPhotoItems.length === 1 ? 'photo' : 'photos'} recognized
              </div>
            </div>
          </div>

          {/* Action Bar: Cover Face, Find More Photos via Learned Centroid & View Switcher */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <button
              className="btn btn-secondary"
              onClick={() => setPersonForCoverModal(selectedPerson)}
              style={{ fontSize: '0.75rem', padding: '6px 12px', gap: '6px' }}
              title="Select which face or photo is displayed as the cover in People"
            >
              <Camera size={14} color="var(--accent-primary)" />
              <span>Change Cover Face</span>
            </button>

            <button
              className="btn btn-secondary"
              onClick={() => {
                const updated = libraryStore.autoSelectBestFaceCover(selectedPerson.id);
                if (updated) {
                  setLearningNotification(
                    `✓ AI auto-selected the clearest, smiling, high-resolution face for ${selectedPerson.name}!`
                  );
                  setTimeout(() => setLearningNotification(null), 4500);
                }
              }}
              style={{ fontSize: '0.75rem', padding: '6px 12px', gap: '6px' }}
              title="Automatically pick the sharpest, largest, and clearest smiling face"
            >
              <Star size={14} color="#f59e0b" fill="#f59e0b" />
              <span>AI Best Face</span>
            </button>

            <button
              className="btn btn-secondary"
              onClick={() => {
                const res = libraryStore.propagateLearnedFaces(selectedPerson.id);
                if (res.newlyAssignedCount > 0) {
                  setLearningNotification(
                    `✓ Added ${res.newlyAssignedCount} newly discovered photo${res.newlyAssignedCount > 1 ? 's' : ''} to ${selectedPerson.name}'s album using quality-weighted centroid!`
                  );
                } else {
                  setLearningNotification(
                    `Scanned library with ${selectedPerson.name}'s 2.5x weighted centroid profile. All eligible faces are up to date.`
                  );
                }
                setTimeout(() => setLearningNotification(null), 5000);
              }}
              style={{ fontSize: '0.75rem', padding: '6px 12px', gap: '6px' }}
              title="Scan library for matching unassigned faces using refined biometric centroid"
            >
              <Sparkles size={14} color="var(--accent-primary)" />
              <span>Find More Photos</span>
            </button>

            {/* View Mode Switcher: Full Photos vs Zoomed Face Headshots */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px', borderLeft: '1px solid var(--border-subtle)', paddingLeft: '8px' }}>
              <button
                className={`btn ${viewMode === 'photos' ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => setViewMode('photos')}
                style={{ fontSize: '0.75rem', padding: '6px 12px' }}
              >
                <ImageIcon size={14} />
                <span>Full Photos</span>
              </button>
              <button
                className={`btn ${viewMode === 'faces' ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => setViewMode('faces')}
                style={{ fontSize: '0.75rem', padding: '6px 12px' }}
              >
                <Crop size={14} />
                <span>Zoomed Faces</span>
              </button>
            </div>

            {/* 6-Level Zoom Controls for Person Photos */}
            {viewMode === 'photos' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '4px', borderLeft: '1px solid var(--border-subtle)', paddingLeft: '8px' }}>
                <button
                  className="btn btn-ghost btn-icon"
                  disabled={zoomLevel === 'years'}
                  onClick={() => {
                    const idx = ZOOM_LEVELS.indexOf(zoomLevel);
                    if (idx > 0) setZoomLevel(ZOOM_LEVELS[idx - 1]);
                  }}
                  style={{ width: '28px', height: '28px' }}
                  title="Zoom Out (Ctrl + Wheel Down)"
                >
                  <ZoomOut size={14} />
                </button>

                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    backgroundColor: 'var(--bg-surface-elevated)',
                    padding: '2px',
                    borderRadius: 'var(--radius-md)',
                    border: '1px solid var(--border-subtle)',
                  }}
                  title="Ctrl + Mouse Wheel to zoom"
                >
                  {([
                    { id: 'years', label: 'Years' },
                    { id: 'months', label: 'Months' },
                    { id: 'very_small', label: 'XS' },
                    { id: 'small', label: 'S' },
                    { id: 'medium', label: 'M' },
                    { id: 'large', label: 'L' },
                  ] as const).map(({ id, label }) => (
                    <button
                      key={id}
                      className={`btn ${zoomLevel === id ? 'btn-primary' : 'btn-ghost'}`}
                      onClick={() => setZoomLevel(id)}
                      style={{ padding: '2px 8px', fontSize: '0.72rem', height: '24px' }}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                <button
                  className="btn btn-ghost btn-icon"
                  disabled={zoomLevel === 'large'}
                  onClick={() => {
                    const idx = ZOOM_LEVELS.indexOf(zoomLevel);
                    if (idx < ZOOM_LEVELS.length - 1) setZoomLevel(ZOOM_LEVELS[idx + 1]);
                  }}
                  style={{ width: '28px', height: '28px' }}
                  title="Zoom In (Ctrl + Wheel Up)"
                >
                  <ZoomIn size={14} />
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Active Learning Guidance & Feedback Banner */}
        {learningNotification ? (
          <div style={{
            padding: '10px 32px',
            backgroundColor: 'rgba(16, 185, 129, 0.15)',
            borderBottom: '1px solid rgba(16, 185, 129, 0.3)',
            fontSize: '0.82rem',
            fontWeight: 600,
            color: 'var(--accent-emerald)',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
          }}>
            <Sparkles size={16} color="var(--accent-emerald)" />
            <span>{learningNotification}</span>
          </div>
        ) : (
          <div style={{
            padding: '8px 32px',
            backgroundColor: 'rgba(59, 130, 246, 0.08)',
            borderBottom: '1px solid var(--border-subtle)',
            fontSize: '0.78rem',
            color: 'var(--text-secondary)',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
          }}>
            <Sparkles size={14} color="var(--accent-primary)" />
            <span>Tip: Confirming photos gives those faces a 2.5x weight multiplier in AI recognition, automatically pulling more matching photos into this album!</span>
          </div>
        )}

        {/* Photos View: Virtualized Timeline Gallery with 6 Zoom Levels (Years, Months, XS, S, M, L) */}
        {viewMode === 'photos' ? (
          <VirtualizedTimelineGallery
            photos={personPhotoItems.map((item) => item.photo)}
            zoomLevel={zoomLevel}
            onZoomChange={setZoomLevel}
            onSelectPhoto={onSelectPhoto}
            onToggleFavorite={onToggleFavorite}
            emptyMessage={`No photos found for ${selectedPerson.name}.`}
          />
        ) : (
          /* Faces Curation View: Zoomed Face Headshots with YES/NO buttons */
          <div style={{ flex: 1, overflowY: 'auto', padding: '24px' }}>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
                gap: '16px',
              }}
            >
              {personPhotoItems.map(({ photo, face }) => (
                <div
                  key={photo.id}
                  style={{
                    position: 'relative',
                    backgroundColor: 'var(--bg-surface)',
                    borderRadius: 'var(--radius-md)',
                    border: face.isConfirmed
                      ? '2px solid var(--accent-emerald)'
                      : '1px solid var(--border-subtle)',
                    overflow: 'hidden',
                    boxShadow: 'var(--shadow-sm)',
                    display: 'flex',
                    flexDirection: 'column',
                  }}
                >
                  {/* Zoomed Face Container */}
                  <div
                    onClick={() => onSelectPhoto(photo)}
                    style={{
                      height: '210px',
                      cursor: 'pointer',
                      position: 'relative',
                      overflow: 'hidden',
                      backgroundColor: '#0f172a',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <FaceAvatar
                      photo={photo}
                      face={face}
                      box={face.box}
                      size={210}
                      borderRadius="0px"
                    />

                    {face.isConfirmed && (
                      <div
                        style={{
                          position: 'absolute',
                          top: '8px',
                          left: '8px',
                          background: 'rgba(16, 185, 129, 0.9)',
                          color: 'white',
                          padding: '2px 8px',
                          borderRadius: 'var(--radius-full)',
                          fontSize: '11px',
                          fontWeight: 700,
                          display: 'flex',
                          alignItems: 'center',
                          gap: '4px',
                          boxShadow: '0 2px 6px rgba(0,0,0,0.4)',
                        }}
                      >
                        <CheckCircle2 size={12} />
                        <span>Verified</span>
                      </div>
                    )}
                  </div>

                  {/* Card Curation Footer: YES / NO Buttons */}
                  <div
                    style={{
                      padding: '10px 14px',
                      backgroundColor: 'var(--bg-surface-elevated)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: '10px',
                    }}
                  >
                    <div
                      style={{
                        fontSize: '0.78rem',
                        color: 'var(--text-muted)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        flex: 1,
                      }}
                      title={photo.fileName}
                    >
                      {photo.fileName}
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      {/* YES Button */}
                      <button
                        className="btn"
                        style={{
                          width: '44px',
                          height: '44px',
                          borderRadius: 'var(--radius-md)',
                          backgroundColor: face.isConfirmed ? '#10b981' : 'rgba(16, 185, 129, 0.15)',
                          color: face.isConfirmed ? '#ffffff' : '#10b981',
                          border: '2px solid #10b981',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          padding: 0,
                          cursor: 'pointer',
                          transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
                          boxShadow: face.isConfirmed ? '0 0 14px rgba(16, 185, 129, 0.5)' : 'none',
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.boxShadow = '0 0 18px rgba(16, 185, 129, 0.85)';
                          e.currentTarget.style.transform = 'scale(1.08)';
                          if (!face.isConfirmed) e.currentTarget.style.backgroundColor = 'rgba(16, 185, 129, 0.3)';
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.boxShadow = face.isConfirmed ? '0 0 14px rgba(16, 185, 129, 0.5)' : 'none';
                          e.currentTarget.style.transform = 'scale(1)';
                          if (!face.isConfirmed) e.currentTarget.style.backgroundColor = 'rgba(16, 185, 129, 0.15)';
                        }}
                        onClick={(e) => handleConfirmFace(face.id, e)}
                        title={`Yes, this is ${selectedPerson.name}`}
                      >
                        <Check size={24} strokeWidth={3} />
                      </button>

                      {/* NO Button */}
                      <button
                        className="btn"
                        style={{
                          width: '44px',
                          height: '44px',
                          borderRadius: 'var(--radius-md)',
                          backgroundColor: 'rgba(239, 68, 68, 0.15)',
                          color: '#ef4444',
                          border: '2px solid #ef4444',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          padding: 0,
                          cursor: 'pointer',
                          transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.boxShadow = '0 0 18px rgba(239, 68, 68, 0.85)';
                          e.currentTarget.style.transform = 'scale(1.08)';
                          e.currentTarget.style.backgroundColor = 'rgba(239, 68, 68, 0.3)';
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.boxShadow = 'none';
                          e.currentTarget.style.transform = 'scale(1)';
                          e.currentTarget.style.backgroundColor = 'rgba(239, 68, 68, 0.15)';
                        }}
                        onClick={(e) => handleUnassignFace(face.id, selectedPerson.name, e)}
                        title={`No, not ${selectedPerson.name}`}
                      >
                        <X size={24} strokeWidth={3} />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Reassign Face Modal */}
        {reassignTarget && (
          <ReassignFaceModal
            face={reassignTarget.face}
            photo={reassignTarget.photo}
            currentPersonName={reassignTarget.currentPersonName}
            people={people}
            onClose={() => setReassignTarget(null)}
          />
        )}

        {/* Change Cover Face Modal */}
        {personForCoverModal && (
          <ChangeCoverFaceModal
            person={personForCoverModal}
            photos={photos}
            onClose={() => setPersonForCoverModal(null)}
          />
        )}
      </div>
    );
  }

  // ================= 2. All People Grid View =================
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Header Bar */}
      <div style={{
        height: '56px',
        padding: '0 24px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderBottom: '1px solid var(--border-subtle)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <Users size={20} color="#ec4899" />
          <h2 style={{ fontSize: '1.1rem', fontWeight: 700 }}>
            People & Faces
          </h2>
          <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
            ({people.length} recognized)
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {people.length >= 2 && (
            <button
              className={`btn ${isMergeMode ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => {
                setIsMergeMode(!isMergeMode);
                setMergeSelection([]);
              }}
              style={{ fontSize: '0.8rem' }}
            >
              <Merge size={15} />
              <span>{isMergeMode ? 'Cancel Merge' : 'Merge People'}</span>
            </button>
          )}

          {isMergeMode && mergeSelection.length === 2 && (
            <button className="btn btn-primary" onClick={handleExecuteMerge} style={{ fontSize: '0.8rem' }}>
              Confirm Merge
            </button>
          )}

          <button
            className="btn btn-secondary"
            onClick={onTriggerFaceDetection}
            disabled={isDetectingFaces}
            style={{ fontSize: '0.8rem' }}
          >
            <Sparkles size={15} color="#ec4899" />
            <span>{isDetectingFaces ? 'Scanning...' : 'Detect Faces'}</span>
          </button>

          {(people.length > 0 || photos.length > 0) && (
            <button
              className="btn btn-ghost"
              onClick={() => {
                const confirmed = window.confirm(
                  'Reset all people data and restart face detection from scratch?\n\nThis will remove all recognized people, face clusters, and manual tags, and re-scan your photos using the updated CosFace face detection engine.'
                );
                if (confirmed) {
                  if (onResetAndRescan) {
                    onResetAndRescan();
                  } else {
                    libraryStore.resetAllPeopleAndFaces();
                    onTriggerFaceDetection();
                  }
                }
              }}
              disabled={isDetectingFaces}
              style={{ fontSize: '0.8rem', color: 'var(--accent-rose)', gap: '6px' }}
              title="Remove all people related data and restart face detection"
            >
              <RotateCcw size={14} />
              <span>Reset & Rescan</span>
            </button>
          )}
        </div>
      </div>

      {/* People Grid */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '24px' }}>
        {people.length === 0 ? (
          <div style={{
            height: '70%',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            textAlign: 'center',
          }}>
            <div style={{
              width: '64px',
              height: '64px',
              borderRadius: 'var(--radius-full)',
              backgroundColor: 'rgba(236, 72, 153, 0.12)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: '16px',
              color: '#ec4899',
            }}>
              <Users size={32} />
            </div>
            <h3 style={{ fontSize: '1.2rem', fontWeight: 700, marginBottom: '6px' }}>
              No Faces Recognized Yet
            </h3>
            <p style={{ color: 'var(--text-muted)', maxWidth: '400px', fontSize: '0.85rem', marginBottom: '20px' }}>
              Run local on-device face recognition on your library. Our AI will automatically detect faces, compute 128-D biometric embeddings, and group them into people virtual albums.
            </p>
            <button
              className="btn btn-primary"
              onClick={onTriggerFaceDetection}
              disabled={isDetectingFaces || photos.length === 0}
            >
              <Sparkles size={16} />
              <span>Run Face Detection</span>
            </button>
          </div>
        ) : (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
            gap: '20px',
          }}>
            {people.map((person) => {
              const { photo: coverPhoto, face: coverFace } = getCoverDetails(person);
              const isSelectedForMerge = mergeSelection.includes(person.id);
              const isEditingThisPerson = editingPersonId === person.id;

              return (
                <div
                  key={person.id}
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest('.person-name-input-container')) {
                      return;
                    }
                    if (isMergeMode) {
                      toggleMergeSelect(person.id, e);
                    } else if (!isEditingThisPerson) {
                      setSelectedPersonId(person.id);
                    }
                  }}
                  style={{
                    backgroundColor: 'var(--bg-surface)',
                    borderRadius: 'var(--radius-lg)',
                    padding: '20px 16px',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    textAlign: 'center',
                    cursor: isEditingThisPerson ? 'default' : 'pointer',
                    border: isSelectedForMerge
                      ? '2px solid var(--accent-primary)'
                      : '1px solid var(--border-subtle)',
                    boxShadow: isSelectedForMerge ? 'var(--shadow-glow)' : 'var(--shadow-sm)',
                    transition: 'all var(--transition-fast)',
                    position: 'relative',
                  }}
                >
                  {/* Zoomed Face Avatar with Change Cover Action */}
                  <div style={{
                    position: 'relative',
                    width: '110px',
                    height: '110px',
                    borderRadius: 'var(--radius-full)',
                    overflow: 'hidden',
                    backgroundColor: 'var(--bg-surface-elevated)',
                    border: '3px solid var(--border-subtle)',
                    marginBottom: '14px',
                    boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)',
                  }}>
                    <FaceAvatar
                      photo={coverPhoto}
                      face={coverFace}
                      box={coverFace?.box}
                      size={110}
                      alt={person.name}
                    />
                    <button
                      className="btn btn-ghost btn-icon"
                      style={{
                        position: 'absolute',
                        bottom: '4px',
                        right: '4px',
                        width: '34px',
                        height: '34px',
                        borderRadius: 'var(--radius-full)',
                        backgroundColor: 'rgba(15, 23, 42, 0.9)',
                        border: '1px solid rgba(255, 255, 255, 0.3)',
                        color: 'white',
                        padding: 0,
                        boxShadow: '0 2px 8px rgba(0,0,0,0.6)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        setPersonForCoverModal(person);
                      }}
                      title={`Change ${person.name}'s cover photo / best face`}
                    >
                      <Camera size={16} />
                    </button>
                  </div>

                  {/* Name Editing & Display */}
                  {isEditingThisPerson ? (
                    <PersonNameInput
                      initialValue={person.name}
                      onSave={(val) => handleSaveRename(person.id, val)}
                      onCancel={() => setEditingPersonId(null)}
                      isLarge={false}
                    />
                  ) : (
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: '8px',
                        maxWidth: '100%',
                        padding: '2px 6px',
                        borderRadius: 'var(--radius-sm)',
                      }}
                      onClick={(e) => handleStartRename(person, e)}
                      title="Click to rename"
                    >
                      <span style={{
                        fontSize: '1rem',
                        fontWeight: 700,
                        color: 'var(--text-primary)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}>
                        {person.name}
                      </span>
                      <button
                        className="btn btn-ghost btn-icon"
                        style={{ width: '30px', height: '30px', padding: 0 }}
                        onClick={(e) => handleStartRename(person, e)}
                        title="Rename"
                      >
                        <Edit2 size={16} color="var(--text-muted)" />
                      </button>
                    </div>
                  )}

                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    width: '100%',
                    marginTop: '8px',
                    paddingTop: '6px',
                    borderTop: '1px solid rgba(255, 255, 255, 0.05)',
                  }}>
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                      {person.photoCount} {person.photoCount === 1 ? 'photo' : 'photos'}
                    </span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                      {people.length >= 2 && (
                        <button
                          className="btn btn-ghost"
                          style={{ padding: '2px 8px', fontSize: '0.72rem', gap: '4px', height: '24px' }}
                          onClick={(e) => {
                            e.stopPropagation();
                            setMergeModalPair({ personA: person });
                          }}
                          title={`Merge ${person.name} with another person`}
                        >
                          <Merge size={12} color="#ec4899" />
                          <span>Merge</span>
                        </button>
                      )}
                      <button
                        className="btn btn-ghost btn-icon"
                        style={{ width: '24px', height: '24px', padding: 0, color: 'var(--accent-rose)' }}
                        onClick={(e) => handleDeletePerson(person.id, person.name, e)}
                        title={`Delete ${person.name} and unassign all detections`}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Merge People Modal ("Merge both people from people list") */}
      {mergeModalPair && (
        <MergePeopleModal
          personA={mergeModalPair.personA}
          personB={mergeModalPair.personB}
          allPeople={people}
          photos={photos}
          onOpenConflictPhoto={(conflictPhoto) => {
            setMergeModalPair(null);
            setMergeSelection([]);
            setIsMergeMode(false);
            onSelectPhoto(conflictPhoto);
          }}
          onClose={() => {
            setMergeModalPair(null);
            setMergeSelection([]);
            setIsMergeMode(false);
          }}
          onSuccess={() => {
            setMergeModalPair(null);
            setMergeSelection([]);
            setIsMergeMode(false);
          }}
        />
      )}

      {/* Change Cover Face Modal */}
      {personForCoverModal && (
        <ChangeCoverFaceModal
          person={personForCoverModal}
          photos={photos}
          onClose={() => setPersonForCoverModal(null)}
        />
      )}
    </div>
  );
};
