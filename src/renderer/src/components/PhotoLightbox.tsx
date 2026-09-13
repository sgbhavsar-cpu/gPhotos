import React, { useState, useEffect, useRef } from 'react';
import {
  X,
  ChevronLeft,
  ChevronRight,
  Info,
  Heart,
  Calendar,
  Camera,
  MapPin,
  Users,
  Eye,
  EyeOff,
  Maximize2,
  HardDrive,
  ExternalLink,
  CheckCircle2,
  UserX,
  UserCheck,
  Trash2,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  RotateCw,
  Sparkles,
  Crop,
  Plus,
  Edit2,
  Scissors,
  Save,
  Copy,
  Sliders,
  FolderPlus,
  Check,
  AlertCircle
} from 'lucide-react';
import { Photo, Person, DetectedFace, LocationMetadata } from '../../types';
import { libraryStore, getLocalPhotoUrl } from '../services/libraryStore';
import { FaceAvatar } from './FaceAvatar';
import { ReassignFaceModal } from './ReassignFaceModal';
import { PersonNameInput } from './PersonNameInput';
import { detectFacesInImage, computeDescriptorForBox } from '../services/faceEngine';

function getExpressionEmoji(expr?: string): string {
  if (!expr) return '';
  switch (expr.toLowerCase()) {
    case 'happy':
      return '😄';
    case 'sad':
      return '😢';
    case 'surprised':
      return '😮';
    case 'angry':
      return '😠';
    case 'fearful':
      return '😨';
    case 'disgusted':
      return '🤢';
    case 'neutral':
      return '😐';
    default:
      return '';
  }
}

interface PhotoLightboxProps {
  photo: Photo;
  allPhotos: Photo[];
  people: Person[];
  onClose: () => void;
  onSelectPhoto: (photo: Photo) => void;
  onToggleFavorite: (photoId: string) => void;
  onNavigateToPerson?: (personId: string) => void;
}

export const PhotoLightbox: React.FC<PhotoLightboxProps> = ({
  photo,
  allPhotos = [],
  people = [],
  onClose,
  onSelectPhoto,
  onToggleFavorite,
  onNavigateToPerson,
}) => {
  const [showInfo, setShowInfo] = useState(true);
  const [showFaces, setShowFaces] = useState(true);
  const [reassignFace, setReassignFace] = useState<{
    face: DetectedFace;
    currentPersonName: string;
  } | null>(null);
  const [renamePersonState, setRenamePersonState] = useState<{
    personId: string;
    currentName: string;
  } | null>(null);

  // Location editing states
  const [isEditingLocation, setIsEditingLocation] = useState(false);
  const [locationInput, setLocationInput] = useState('');

  const handleStartEditLocation = () => {
    setIsEditingLocation(true);
    setLocationInput(photo.location?.label || photo.location?.city || '');
  };

  const handleSaveLocation = () => {
    const clean = locationInput.trim();
    const updatedLocation: LocationMetadata = {
      latitude: photo.location?.latitude ?? 0,
      longitude: photo.location?.longitude ?? 0,
      ...photo.location,
      label: clean || undefined,
      city: clean || undefined,
    };
    const updatedPhoto: Photo = {
      ...photo,
      location: clean || (photo.location && (photo.location.latitude !== 0 || photo.location.longitude !== 0))
        ? updatedLocation
        : undefined,
    };
    libraryStore.updatePhoto(updatedPhoto);
    setIsEditingLocation(false);
  };

  const [imgNaturalSize, setImgNaturalSize] = useState<{ width: number; height: number } | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Zoom and Pan states
  const [zoom, setZoom] = useState<number>(1);
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const dragStartRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  // Single Photo Scanning & Manual Tagging states
  const [isScanningSinglePhoto, setIsScanningSinglePhoto] = useState(false);
  const [scanStatusMessage, setScanStatusMessage] = useState<string | null>(null);
  const [isTaggingMode, setIsTaggingMode] = useState(false);
  const [drawBox, setDrawBox] = useState<{ startX: number; startY: number; currentX: number; currentY: number } | null>(null);

  // Check if original full-resolution photo is available on network storage
  const [isOriginalAvailable, setIsOriginalAvailable] = useState<boolean | null>(null);
  const [isLightboxImgLoaded, setIsLightboxImgLoaded] = useState(false);
  const [lightboxImgError, setLightboxImgError] = useState(false);
  const [fallbackToThumbnail, setFallbackToThumbnail] = useState(false);

  useEffect(() => {
    let isMounted = true;
    if (photo.isVirtual && photo.originalRemotePath && window.electronAPI?.checkFileExists) {
      window.electronAPI.checkFileExists(photo.originalRemotePath).then((exists) => {
        if (isMounted) setIsOriginalAvailable(exists);
      });
    } else if (!photo.isVirtual) {
      // Regular local photo stored on current machine is always available
      setIsOriginalAvailable(true);
    } else {
      setIsOriginalAvailable(false);
    }
    return () => {
      isMounted = false;
    };
  }, [photo.id, photo.originalRemotePath, photo.isVirtual]);

  // Reset zoom & pan when photo changes
  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setIsDragging(false);
    setIsTaggingMode(false);
    setScanStatusMessage(null);
    setIsEditing(false);
    setEditRotation(0);
    setEditFlipH(false);
    setIsEditingLocation(false);
    setIsLightboxImgLoaded(false);
    setLightboxImgError(false);
    setFallbackToThumbnail(false);
  }, [photo.id]);

  // Album states
  const [showAddToAlbumModal, setShowAddToAlbumModal] = useState(false);
  const [targetAlbumId, setTargetAlbumId] = useState('new');
  const [newAlbumTitle, setNewAlbumTitle] = useState('');
  const [albumToast, setAlbumToast] = useState<string | null>(null);

  const handleAddPhotoToAlbum = (e: React.FormEvent) => {
    e.preventDefault();
    let albumName = '';
    const currentAlbums = libraryStore.getState().albums || [];
    if (targetAlbumId === 'new') {
      if (!newAlbumTitle.trim()) return;
      const created = libraryStore.createAlbum(newAlbumTitle.trim());
      libraryStore.addPhotosToAlbum(created.id, [photo.id]);
      albumName = created.title;
    } else {
      const existing = currentAlbums.find((a) => a.id === targetAlbumId);
      if (!existing) return;
      libraryStore.addPhotosToAlbum(existing.id, [photo.id]);
      albumName = existing.title;
    }
    setAlbumToast(`✓ Added photo to album "${albumName}"!`);
    setTimeout(() => setAlbumToast(null), 3000);
    setShowAddToAlbumModal(false);
    setNewAlbumTitle('');
  };

  // In-App Editing states (Rotate, Crop, Save to Source)
  const isHeic = /\.(heic|heif)$/i.test(photo.fileName || photo.filePath || photo.originalRemotePath || '');
  const [isEditing, setIsEditing] = useState(false);
  const [editRotation, setEditRotation] = useState<number>(0);
  const [editFlipH, setEditFlipH] = useState(false);
  const [isSavingEdit, setIsSavingEdit] = useState(false);

  const handleApplyEdit = async (saveAsCopy: boolean) => {
    if (!imgRef.current) return;
    setIsSavingEdit(true);

    try {
      const img = imgRef.current;
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas 2D rendering context not available');

      const isRotated90 = (editRotation % 180) !== 0;
      const naturalW = img.naturalWidth || photo.width || 2000;
      const naturalH = img.naturalHeight || photo.height || 1500;

      canvas.width = isRotated90 ? naturalH : naturalW;
      canvas.height = isRotated90 ? naturalW : naturalH;

      ctx.save();
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate((editRotation * Math.PI) / 180);
      if (editFlipH) {
        ctx.scale(-1, 1);
      }
      ctx.drawImage(img, -naturalW / 2, -naturalH / 2);
      ctx.restore();

      const base64Data = canvas.toDataURL('image/jpeg', 0.94);

      if (window.electronAPI?.editPhoto) {
        const res = await window.electronAPI.editPhoto({
          filePath: photo.filePath,
          originalPath: photo.originalRemotePath,
          base64Data,
          saveAsCopy,
          mirrorThumbnailPath: photo.isVirtual ? photo.filePath : undefined,
        });

        if (res.success && res.newPhoto) {
          libraryStore.updatePhoto(res.newPhoto);
          setScanStatusMessage(
            saveAsCopy
              ? '✓ Saved as new edited photo copy!'
              : '✓ Photo saved to source file (backup .bak preserved)!'
          );
          setIsEditing(false);
          setEditRotation(0);
          setEditFlipH(false);
        } else {
          alert(`Error saving photo: ${res.error || 'Unknown error'}`);
        }
      } else {
        setScanStatusMessage('✓ Photo orientation updated!');
        setIsEditing(false);
      }
    } catch (err: any) {
      alert(`Failed to save edit: ${err.message}`);
    } finally {
      setIsSavingEdit(false);
      setTimeout(() => setScanStatusMessage(null), 4000);
    }
  };

  // Sync natural dimensions from image if already loaded
  useEffect(() => {
    if (imgRef.current && imgRef.current.complete && imgRef.current.naturalWidth > 0) {
      setImgNaturalSize({
        width: imgRef.current.naturalWidth,
        height: imgRef.current.naturalHeight,
      });
    }
  }, [photo.id, photo.filePath]);

  // Helper to compute normalized coordinates across resolutions
  const getFaceNormalizedCoords = (
    face: DetectedFace,
    currentPhoto: Photo,
    imgNatural: { width: number; height: number }
  ) => {
    if (face.imageWidth && face.imageHeight && face.imageWidth > 0 && face.imageHeight > 0) {
      return {
        x: face.box.x / face.imageWidth,
        y: face.box.y / face.imageHeight,
        width: face.box.width / face.imageWidth,
        height: face.box.height / face.imageHeight,
      };
    }

    const photoW = currentPhoto.width || imgNatural.width || 500;
    const photoH = currentPhoto.height || imgNatural.height || 500;
    const maxDim = Math.max(photoW, photoH);

    // If face box was detected on 500px thumbnail:
    if (maxDim > 505 && face.box.x + face.box.width <= 505 && face.box.y + face.box.height <= 505) {
      const scale = 500 / maxDim;
      const thumbW = Math.max(1, Math.round(photoW * scale));
      const thumbH = Math.max(1, Math.round(photoH * scale));
      return {
        x: face.box.x / thumbW,
        y: face.box.y / thumbH,
        width: face.box.width / thumbW,
        height: face.box.height / thumbH,
      };
    }

    const baseW = imgNatural.width || photoW || 1;
    const baseH = imgNatural.height || photoH || 1;
    return {
      x: face.box.x / baseW,
      y: face.box.y / baseH,
      width: face.box.width / baseW,
      height: face.box.height / baseH,
    };
  };

  const handleScanFacesInPhoto = async () => {
    if (isScanningSinglePhoto) return;
    setIsScanningSinglePhoto(true);
    setScanStatusMessage('Scanning faces with precision matching...');

    try {
      let preferOriginal = false;
      if (photo.isVirtual && photo.originalRemotePath && window.electronAPI?.checkFileExists) {
        preferOriginal = await window.electronAPI.checkFileExists(photo.originalRemotePath);
      }

      const detections = await detectFacesInImage(
        photo.filePath,
        photo.id,
        photo.originalRemotePath,
        preferOriginal
      );
      if (detections.length === 0) {
        setScanStatusMessage('No faces detected in this photo.');
        setTimeout(() => setScanStatusMessage(null), 3500);
        return;
      }

      const updatedPhoto = await libraryStore.detectAndMatchFacesForPhoto(photo.id, detections, 0.48);
      setShowFaces(true);
      const faceCount = updatedPhoto.faces?.length || 0;
      setScanStatusMessage(`Scan complete: ${faceCount} face${faceCount === 1 ? '' : 's'} recognized!`);
      setTimeout(() => setScanStatusMessage(null), 3500);
    } catch (err) {
      console.error('Failed to scan faces in photo:', err);
      setScanStatusMessage('Error scanning faces.');
      setTimeout(() => setScanStatusMessage(null), 3500);
    } finally {
      setIsScanningSinglePhoto(false);
    }
  };

  const currentIndex = allPhotos.findIndex((p) => p.id === photo.id);
  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex < allPhotos.length - 1;

  const handlePrev = () => {
    if (hasPrev) onSelectPhoto(allPhotos[currentIndex - 1]);
  };

  const handleNext = () => {
    if (hasNext) onSelectPhoto(allPhotos[currentIndex + 1]);
  };

  // Mouse wheel zoom handler
  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const zoomStep = 1.15;
    let newZoom = e.deltaY < 0 ? zoom * zoomStep : zoom / zoomStep;

    if (newZoom < 1.05) {
      newZoom = 1;
      setPan({ x: 0, y: 0 });
    } else if (newZoom > 6) {
      newZoom = 6;
    }

    // Pan towards cursor when zooming
    if (containerRef.current && newZoom > 1 && zoom > 0) {
      const rect = containerRef.current.getBoundingClientRect();
      const mouseX = e.clientX - (rect.left + rect.width / 2);
      const mouseY = e.clientY - (rect.top + rect.height / 2);

      const scaleRatio = newZoom / zoom;
      setPan((prev) => ({
        x: mouseX - (mouseX - prev.x) * scaleRatio,
        y: mouseY - (mouseY - prev.y) * scaleRatio,
      }));
    }

    setZoom(newZoom);
  };

  // Mouse drag handlers for panning
  const handleMouseDown = (e: React.MouseEvent) => {
    if (isTaggingMode) return;
    if (zoom > 1 && e.button === 0) {
      if ((e.target as HTMLElement).closest('button, .face-tag-label, span')) return;
      setIsDragging(true);
      dragStartRef.current = {
        x: e.clientX - pan.x,
        y: e.clientY - pan.y,
      };
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isDragging && zoom > 1) {
      setPan({
        x: e.clientX - dragStartRef.current.x,
        y: e.clientY - dragStartRef.current.y,
      });
    }
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  const handleDoubleClick = (e: React.MouseEvent) => {
    if (isTaggingMode) return;
    if ((e.target as HTMLElement).closest('button, .face-tag-label, span')) return;
    if (zoom > 1) {
      setZoom(1);
      setPan({ x: 0, y: 0 });
    } else {
      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        const mouseX = e.clientX - (rect.left + rect.width / 2);
        const mouseY = e.clientY - (rect.top + rect.height / 2);
        setPan({ x: -mouseX * 1.5, y: -mouseY * 1.5 });
      }
      setZoom(2.5);
    }
  };

  const handleResetZoom = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  const handleZoomIn = () => {
    setZoom((prev) => Math.min(6, prev * 1.3));
  };

  const handleZoomOut = () => {
    setZoom((prev) => {
      const next = prev / 1.3;
      if (next < 1.05) {
        setPan({ x: 0, y: 0 });
        return 1;
      }
      return next;
    });
  };

  const handleConfirmFace = (faceId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const res = libraryStore.confirmFace(faceId);
    if (res && res.newlyAssignedCount > 0) {
      setScanStatusMessage(`✓ Face verified! 2.5x weighted centroid discovered ${res.newlyAssignedCount} additional photo(s).`);
      setTimeout(() => setScanStatusMessage(null), 4500);
    }
  };

  const handleUnassignFace = (faceId: string, _personName: string, e: React.MouseEvent) => {
    e.stopPropagation();
    libraryStore.unassignFaceFromPerson(faceId);
  };

  const handleDeleteDetection = (faceId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    libraryStore.deleteFaceDetection(faceId);
  };

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Do not intercept keystrokes if the user is typing into an input field or textarea
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        (e.target as HTMLElement)?.isContentEditable
      ) {
        return;
      }

      if (e.key === 'Escape') {
        if (isTaggingMode) {
          setIsTaggingMode(false);
          setDrawBox(null);
        } else {
          onClose();
        }
      } else if (e.key === 'ArrowLeft' && !isTaggingMode) {
        handlePrev();
      } else if (e.key === 'ArrowRight' && !isTaggingMode) {
        handleNext();
      } else if (e.key === 'i') {
        setShowInfo((v) => !v);
      } else if (e.key === 'f') {
        onToggleFavorite(photo.id);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [currentIndex, allPhotos, photo, isTaggingMode]);

  const onImageLoad = () => {
    if (imgRef.current) {
      setImgNaturalSize({
        width: imgRef.current.naturalWidth,
        height: imgRef.current.naturalHeight,
      });
    }
  };

  const formattedDate = new Date(photo.dateTaken).toLocaleString(undefined, {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  const fileSizeMB = (photo.fileSize / (1024 * 1024)).toFixed(2);

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: 'rgba(5, 8, 15, 0.96)',
      backdropFilter: 'blur(12px)',
      zIndex: 1000,
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
    }}>
      {/* Header Bar */}
      <header style={{
        height: '60px',
        padding: '0 20px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderBottom: '1px solid var(--border-subtle)',
        backgroundColor: 'rgba(15, 23, 42, 0.6)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <button className="btn btn-ghost btn-icon" onClick={onClose} title="Close (Esc)">
            <X size={20} />
          </button>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                {photo.fileName}
              </span>
              {photo.isVirtual && (
                <>
                  <span style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '4px',
                    fontSize: '11px',
                    padding: '2px 8px',
                    borderRadius: 'var(--radius-full)',
                    backgroundColor: 'rgba(6, 182, 212, 0.2)',
                    color: 'var(--accent-cyan)',
                    border: '1px solid rgba(6, 182, 212, 0.4)',
                    fontWeight: 600,
                  }}>
                    <HardDrive size={11} />
                    {photo.storageName || 'Network Mirror'}
                  </span>

                  {isOriginalAvailable ? (
                    <span
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '5px',
                        fontSize: '11px',
                        padding: '2px 8px',
                        borderRadius: 'var(--radius-full)',
                        backgroundColor: 'rgba(16, 185, 129, 0.2)',
                        color: '#34d399',
                        border: '1px solid rgba(16, 185, 129, 0.4)',
                        fontWeight: 700,
                      }}
                      title={`Original source connected from: ${photo.originalRemotePath}`}
                    >
                      <span style={{ width: '6px', height: '6px', borderRadius: '50%', backgroundColor: '#10b981' }} />
                      Original Full-Res
                    </span>
                  ) : (
                    <span
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '5px',
                        fontSize: '11px',
                        padding: '2px 8px',
                        borderRadius: 'var(--radius-full)',
                        backgroundColor: 'rgba(245, 158, 11, 0.2)',
                        color: '#fbbf24',
                        border: '1px solid rgba(245, 158, 11, 0.4)',
                        fontWeight: 600,
                      }}
                      title="Network storage source is offline or disconnected. Viewing local 500px mirror cache."
                    >
                      <span style={{ width: '6px', height: '6px', borderRadius: '50%', backgroundColor: '#f59e0b' }} />
                      Offline Mirror
                    </span>
                  )}
                </>
              )}
            </div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
              {currentIndex + 1} of {allPhotos.length}
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {/* Edit photo button (available when local or online source, disabled for HEIC) */}
          {(!photo.isVirtual || isOriginalAvailable) && !isHeic && (
            <button
              className={`btn ${isEditing ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => {
                setIsEditing(!isEditing);
                if (isEditing) {
                  setEditRotation(0);
                  setEditFlipH(false);
                }
              }}
              style={{ fontSize: '0.8rem', gap: '6px' }}
              title="Rotate, flip, or edit photo when source is available"
            >
              <Edit2 size={15} />
              <span>{isEditing ? 'Exit Edit' : 'Edit'}</span>
            </button>
          )}

          {/* 1. Run face detection for current photo */}
          <button
            className="btn btn-secondary"
            onClick={handleScanFacesInPhoto}
            disabled={isScanningSinglePhoto}
            style={{ fontSize: '0.8rem', gap: '6px' }}
            title="Scan faces in this photo only and match known people with high precision"
          >
            <Sparkles size={15} color="#ec4899" className={isScanningSinglePhoto ? 'animate-spin' : ''} />
            <span>{isScanningSinglePhoto ? 'Scanning...' : 'Scan Faces'}</span>
          </button>

          {/* 2. Tag face manually */}
          <button
            className={`btn ${isTaggingMode ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => {
              setIsTaggingMode(!isTaggingMode);
              setDrawBox(null);
            }}
            style={{ fontSize: '0.8rem', gap: '6px' }}
            title="Select and tag a person manually on the photo"
          >
            <Crop size={15} />
            <span>{isTaggingMode ? 'Cancel Tagging' : 'Tag Manually'}</span>
          </button>

          {photo.faces && photo.faces.length > 0 && (
            <button
              className={`btn ${showFaces ? 'btn-secondary' : 'btn-ghost'}`}
              onClick={() => setShowFaces(!showFaces)}
              style={{ fontSize: '0.8rem' }}
              title="Toggle Face Tag Overlays"
            >
              {showFaces ? <Eye size={16} /> : <EyeOff size={16} />}
              <span>{showFaces ? 'Hide Faces' : 'Show Faces'}</span>
            </button>
          )}

          <button
            className="btn btn-ghost btn-icon"
            onClick={() => setShowAddToAlbumModal(true)}
            style={{ width: '38px', height: '38px', color: 'var(--accent-primary)' }}
            title="Add photo to an album"
          >
            <FolderPlus size={22} />
          </button>

          <button
            className="btn btn-ghost btn-icon"
            onClick={() => onToggleFavorite(photo.id)}
            style={{ width: '38px', height: '38px', color: photo.isFavorite ? 'var(--accent-rose)' : 'inherit' }}
            title="Favorite (F)"
          >
            <Heart size={22} fill={photo.isFavorite ? 'currentColor' : 'none'} />
          </button>

          <button
            className={`btn btn-icon ${showInfo ? 'btn-secondary' : 'btn-ghost'}`}
            onClick={() => setShowInfo(!showInfo)}
            style={{ width: '38px', height: '38px' }}
            title="Toggle Info Inspector (I)"
          >
            <Info size={22} />
          </button>
        </div>
      </header>

      {/* Main Content Area */}
      <div style={{ flex: 1, display: 'flex', position: 'relative', overflow: 'hidden' }}>
        {/* Navigation Arrows */}
        {hasPrev && (
          <button
            onClick={handlePrev}
            style={{
              position: 'absolute',
              left: '20px',
              top: '50%',
              transform: 'translateY(-50%)',
              zIndex: 10,
              background: 'rgba(15, 23, 42, 0.75)',
              backdropFilter: 'blur(8px)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-full)',
              width: '48px',
              height: '48px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'white',
              cursor: 'pointer',
              transition: 'all var(--transition-fast)',
              boxShadow: '0 4px 16px rgba(0, 0, 0, 0.5)',
            }}
          >
            <ChevronLeft size={28} />
          </button>
        )}

        {hasNext && (
          <button
            onClick={handleNext}
            style={{
              position: 'absolute',
              right: showInfo ? '380px' : '20px',
              top: '50%',
              transform: 'translateY(-50%)',
              zIndex: 10,
              background: 'rgba(15, 23, 42, 0.75)',
              backdropFilter: 'blur(8px)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-full)',
              width: '48px',
              height: '48px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'white',
              cursor: 'pointer',
              transition: 'all var(--transition-fast)',
              boxShadow: '0 4px 16px rgba(0, 0, 0, 0.5)',
            }}
          >
            <ChevronRight size={28} />
          </button>
        )}

        {/* Center Image Container with Mouse Wheel Zoom & Pan */}
        <div
          ref={containerRef}
          onWheel={handleWheel}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onDoubleClick={handleDoubleClick}
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '24px',
            position: 'relative',
            overflow: 'hidden',
            cursor: isTaggingMode ? 'crosshair' : (zoom > 1 ? (isDragging ? 'grabbing' : 'grab') : 'default'),
            userSelect: 'none',
          }}
        >
          {/* Floating Mode Pill / Status Alerts */}
          {isTaggingMode && (
            <div
              style={{
                position: 'absolute',
                top: '20px',
                left: '50%',
                transform: 'translateX(-50%)',
                zIndex: 70,
                backgroundColor: 'rgba(2, 132, 199, 0.95)',
                color: 'white',
                backdropFilter: 'blur(8px)',
                padding: '8px 20px',
                borderRadius: 'var(--radius-full)',
                boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                fontSize: '0.85rem',
                fontWeight: 600,
              }}
            >
              <Crop size={16} />
              <span>Click and drag a box around a face to tag someone</span>
              <button
                className="btn btn-ghost"
                style={{ padding: '2px 8px', fontSize: '0.75rem', color: 'white', border: '1px solid rgba(255,255,255,0.4)', height: '24px' }}
                onClick={() => {
                  setIsTaggingMode(false);
                  setDrawBox(null);
                }}
              >
                Cancel (Esc)
              </button>
            </div>
          )}

          {scanStatusMessage && (
            <div
              style={{
                position: 'absolute',
                top: '20px',
                left: '50%',
                transform: 'translateX(-50%)',
                zIndex: 70,
                backgroundColor: 'rgba(15, 23, 42, 0.92)',
                color: 'white',
                backdropFilter: 'blur(8px)',
                border: '1px solid var(--border-subtle)',
                padding: '8px 20px',
                borderRadius: 'var(--radius-full)',
                boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                fontSize: '0.85rem',
                fontWeight: 600,
              }}
            >
              <Sparkles size={16} color="var(--accent-primary)" className={isScanningSinglePhoto ? 'animate-spin' : ''} />
              <span>{scanStatusMessage}</span>
            </div>
          )}

          {/* Centered Asynchronous Loading Indicator */}
          {!isLightboxImgLoaded && !lightboxImgError && (
            <div
              style={{
                position: 'absolute',
                top: '50%',
                left: '50%',
                transform: 'translate(-50%, -50%)',
                zIndex: 40,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '12px',
                padding: '16px 24px',
                borderRadius: 'var(--radius-lg)',
                backgroundColor: 'rgba(15, 23, 42, 0.85)',
                backdropFilter: 'blur(8px)',
                boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
                pointerEvents: 'none',
              }}
            >
              <Sparkles size={24} color="var(--accent-primary)" className="animate-spin" />
              <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', fontWeight: 500 }}>
                Loading preview...
              </span>
            </div>
          )}

          {/* Graceful Fallback if preview fails or times out */}
          {lightboxImgError && (
            <div
              style={{
                position: 'absolute',
                top: '50%',
                left: '50%',
                transform: 'translate(-50%, -50%)',
                zIndex: 40,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '12px',
                padding: '24px 32px',
                borderRadius: 'var(--radius-lg)',
                backgroundColor: 'rgba(15, 23, 42, 0.95)',
                border: '1px solid var(--border-subtle)',
                color: 'var(--text-secondary)',
                textAlign: 'center',
              }}
            >
              <AlertCircle size={32} color="var(--accent-rose)" />
              <span style={{ fontSize: '0.95rem', color: 'var(--text-primary)', fontWeight: 600 }}>
                Photo Preview Unavailable
              </span>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', maxWidth: '280px' }}>
                The storage drive or network location may be offline or taking too long.
              </span>
            </div>
          )}

          {/* Transformed Stage holding BOTH Image and Face Overlays in lockstep */}
          <div
            style={{
              position: 'relative',
              display: 'inline-block',
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              transformOrigin: 'center center',
              transition: isDragging ? 'none' : 'transform 0.08s ease-out',
            }}
          >
            {/* Immediate blur thumbnail placeholder while high-res original loads */}
            {!isLightboxImgLoaded && !lightboxImgError && (
              <img
                src={getLocalPhotoUrl(photo.thumbnailPath || photo.filePath, undefined, false, 500)}
                alt={photo.fileName}
                aria-hidden="true"
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: '100%',
                  objectFit: 'contain',
                  borderRadius: 'var(--radius-sm)',
                  display: 'block',
                  filter: 'blur(3px)',
                  opacity: 0.7,
                  pointerEvents: 'none',
                  transform: `rotate(${editRotation}deg) ${editFlipH ? 'scaleX(-1)' : ''}`,
                }}
              />
            )}

            <img
              ref={imgRef}
              crossOrigin="anonymous"
              src={getLocalPhotoUrl(
                photo.filePath,
                photo.originalRemotePath,
                (isOriginalAvailable !== false) && !fallbackToThumbnail,
                ((isOriginalAvailable !== false) && !fallbackToThumbnail) ? 0 : 1600
              )}
              alt={photo.fileName}
              decoding="async"
              onLoad={() => {
                setIsLightboxImgLoaded(true);
                onImageLoad();
              }}
              onError={() => {
                if (isOriginalAvailable !== false && !fallbackToThumbnail && photo.isVirtual) {
                  // If high-res original remote load fails, fall back to local cached mirror thumbnail
                  setFallbackToThumbnail(true);
                } else {
                  setLightboxImgError(true);
                  setIsLightboxImgLoaded(false);
                }
              }}
              draggable={false}
              style={{
                maxWidth: '100%',
                maxHeight: 'calc(100vh - 120px)',
                objectFit: 'contain',
                borderRadius: 'var(--radius-sm)',
                boxShadow: '0 16px 48px rgba(0, 0, 0, 0.7)',
                display: 'block',
                pointerEvents: 'none',
                opacity: isLightboxImgLoaded ? 1 : 0,
                transition: 'opacity 0.2s ease-out, transform 0.15s ease-out',
                transform: `rotate(${editRotation}deg) ${editFlipH ? 'scaleX(-1)' : ''}`,
              }}
            />

            {/* Manual Face Tagging Interactive Overlay */}
            {isTaggingMode && (
              <div
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: '100%',
                  cursor: 'crosshair',
                  zIndex: 60,
                  userSelect: 'none',
                  touchAction: 'none',
                }}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  try {
                    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
                  } catch {}
                  const rect = e.currentTarget.getBoundingClientRect();
                  const x = (e.clientX - rect.left) / zoom;
                  const y = (e.clientY - rect.top) / zoom;
                  setDrawBox({ startX: x, startY: y, currentX: x, currentY: y });
                }}
                onPointerMove={(e) => {
                  if (!drawBox) return;
                  e.stopPropagation();
                  const rect = e.currentTarget.getBoundingClientRect();
                  const x = (e.clientX - rect.left) / zoom;
                  const y = (e.clientY - rect.top) / zoom;
                  setDrawBox({ ...drawBox, currentX: x, currentY: y });
                }}
                onPointerUp={async (e) => {
                  try {
                    (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
                  } catch {}
                  if (!drawBox || !imgRef.current) {
                    setDrawBox(null);
                    return;
                  }
                  e.stopPropagation();
                  const minX = Math.min(drawBox.startX, drawBox.currentX);
                  const minY = Math.min(drawBox.startY, drawBox.currentY);
                  const w = Math.abs(drawBox.currentX - drawBox.startX);
                  const h = Math.abs(drawBox.currentY - drawBox.startY);
                  setDrawBox(null);

                  if (w > 10 && h > 10) {
                    const natW = imgNaturalSize?.width || imgRef.current.naturalWidth || photo.width || imgRef.current.clientWidth || 500;
                    const natH = imgNaturalSize?.height || imgRef.current.naturalHeight || photo.height || imgRef.current.clientHeight || 500;
                    const clientW = imgRef.current.clientWidth || 1;
                    const clientH = imgRef.current.clientHeight || 1;

                    const scaleX = natW / clientW;
                    const scaleY = natH / clientH;

                    const box = {
                      x: Math.max(0, Math.round(minX * scaleX)),
                      y: Math.max(0, Math.round(minY * scaleY)),
                      width: Math.min(natW, Math.round(w * scaleX)),
                      height: Math.min(natH, Math.round(h * scaleY)),
                    };

                    let descriptor: number[] | undefined;
                    try {
                      descriptor = await computeDescriptorForBox(imgRef.current, box);
                    } catch (err) {
                      console.warn('Could not compute descriptor for manual box:', err);
                    }

                    const newFace = libraryStore.addManualFace(
                      photo.id,
                      box,
                      descriptor,
                      natW,
                      natH
                    );
                    setIsTaggingMode(false);
                    setShowFaces(true);
                    setReassignFace({
                      face: newFace,
                      currentPersonName: 'New Face',
                    });
                  } else {
                    setScanStatusMessage('Click and drag across the face to create a box');
                    setTimeout(() => setScanStatusMessage(null), 3000);
                  }
                }}
              >
                {drawBox && (
                  <div
                    style={{
                      position: 'absolute',
                      left: `${Math.min(drawBox.startX, drawBox.currentX)}px`,
                      top: `${Math.min(drawBox.startY, drawBox.currentY)}px`,
                      width: `${Math.abs(drawBox.currentX - drawBox.startX)}px`,
                      height: `${Math.abs(drawBox.currentY - drawBox.startY)}px`,
                      border: '2px dashed #38bdf8',
                      backgroundColor: 'rgba(56, 189, 248, 0.25)',
                      borderRadius: '4px',
                      boxShadow: '0 0 12px rgba(56, 189, 248, 0.6)',
                      pointerEvents: 'none',
                    }}
                  >
                    <div
                      style={{
                        position: 'absolute',
                        top: '-24px',
                        left: 0,
                        background: '#0284c7',
                        color: 'white',
                        fontSize: '11px',
                        fontWeight: 700,
                        padding: '2px 6px',
                        borderRadius: '4px',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      New Face Selection
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Face Bounding Box Overlays (Locked to transformed stage) */}
            {showFaces && imgRef.current && photo.faces && (
              photo.faces.map((face) => {
                const imgElem = imgRef.current!;
                const natural = imgNaturalSize || {
                  width: imgElem.naturalWidth || photo.width || 500,
                  height: imgElem.naturalHeight || photo.height || 500,
                };
                const norm = getFaceNormalizedCoords(face, photo, natural);

                const left = norm.x * imgElem.clientWidth;
                const top = norm.y * imgElem.clientHeight;
                const width = norm.width * imgElem.clientWidth;
                const height = norm.height * imgElem.clientHeight;

                const person = people.find((p) => p.id === face.personId);
                const personName = person ? person.name : 'Unknown Person';

                // Counter-scale label gently so it remains legible without occluding faces at high zoom
                const labelScale = 1 / Math.min(Math.max(zoom * 0.75, 1), 2.2);

                return (
                  <div
                    key={face.id}
                    className="face-box-overlay"
                    style={{ left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` }}
                  >
                    <div
                      className="face-tag-label"
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                        pointerEvents: 'auto',
                        transform: `translateX(-50%) scale(${labelScale})`,
                        transformOrigin: 'top center',
                      }}
                    >
                      <span
                        onClick={(e) => {
                          e.stopPropagation();
                          if (face.personId && onNavigateToPerson) {
                            onNavigateToPerson(face.personId);
                          }
                        }}
                        style={{ cursor: face.personId ? 'pointer' : 'default', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                      >
                        <span>{face.isConfirmed ? `✓ ${personName}` : personName}</span>
                        {face.dominantExpression && <span>{getExpressionEmoji(face.dominantExpression)}</span>}
                      </span>
                      <div style={{ display: 'inline-flex', gap: '4px', marginLeft: '4px' }}>
                        <span
                          onClick={(e) => handleConfirmFace(face.id, e)}
                          title={face.isConfirmed ? 'Verified Correct' : 'Confirm Correct Person'}
                          style={{ cursor: 'pointer', display: 'flex', alignItems: 'center' }}
                        >
                          <CheckCircle2 size={13} color={face.isConfirmed ? '#10b981' : '#94a3b8'} />
                        </span>
                        {face.personId && (
                          <span
                            onClick={(e) => handleUnassignFace(face.id, personName, e)}
                            title={`Wrong Person (Remove from ${personName})`}
                            style={{ cursor: 'pointer', display: 'flex', alignItems: 'center' }}
                          >
                            <UserX size={13} color="#f59e0b" />
                          </span>
                        )}
                        {face.personId && (
                          <span
                            onClick={(e) => {
                              e.stopPropagation();
                              setRenamePersonState({ personId: face.personId!, currentName: personName });
                              setRenameInputName(personName);
                            }}
                            title={`Rename "${personName}" across all photos`}
                            style={{ cursor: 'pointer', display: 'flex', alignItems: 'center' }}
                          >
                            <Edit2 size={13} color="#38bdf8" />
                          </span>
                        )}
                        <span
                          onClick={(e) => {
                            e.stopPropagation();
                            setReassignFace({ face, currentPersonName: personName });
                          }}
                          title={`Not ${personName}? Reassign to someone else (e.g. Monika)...`}
                          style={{ cursor: 'pointer', display: 'flex', alignItems: 'center' }}
                        >
                          <UserCheck size={13} color="#3b82f6" />
                        </span>
                        <span
                          onClick={(e) => handleDeleteDetection(face.id, e)}
                          title="Delete Face Detection Completely"
                          style={{ cursor: 'pointer', display: 'flex', alignItems: 'center' }}
                        >
                          <Trash2 size={13} color="#f43f5e" />
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* Floating Photo Editing Toolbar */}
          {isEditing && (
            <div
              style={{
                position: 'absolute',
                bottom: '72px',
                left: '50%',
                transform: 'translateX(-50%)',
                zIndex: 40,
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '8px 16px',
                backgroundColor: 'rgba(15, 23, 42, 0.95)',
                border: '1px solid var(--accent-primary)',
                borderRadius: 'var(--radius-full)',
                boxShadow: '0 12px 36px rgba(0, 0, 0, 0.8)',
                backdropFilter: 'blur(16px)',
              }}
            >
              <button
                className="btn btn-secondary"
                onClick={() => setEditRotation((r) => (r - 90 + 360) % 360)}
                style={{ fontSize: '0.8rem', gap: '6px', padding: '6px 12px' }}
                title="Rotate 90° Left"
              >
                <RotateCcw size={15} />
                <span>-90°</span>
              </button>
              <button
                className="btn btn-secondary"
                onClick={() => setEditRotation((r) => (r + 90) % 360)}
                style={{ fontSize: '0.8rem', gap: '6px', padding: '6px 12px' }}
                title="Rotate 90° Right"
              >
                <RotateCw size={15} />
                <span>+90°</span>
              </button>
              <button
                className={`btn ${editFlipH ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => setEditFlipH(!editFlipH)}
                style={{ fontSize: '0.8rem', gap: '6px', padding: '6px 12px' }}
                title="Flip Horizontal"
              >
                <Scissors size={15} />
                <span>Flip</span>
              </button>
              <div style={{ width: '1px', height: '20px', backgroundColor: 'var(--border-subtle)', margin: '0 4px' }} />
              <button
                className="btn btn-primary"
                onClick={() => handleApplyEdit(false)}
                disabled={isSavingEdit}
                style={{ fontSize: '0.8rem', gap: '6px', padding: '6px 14px' }}
                title="Save changes to source file (keeps safe .bak backup)"
              >
                <Save size={15} />
                <span>{isSavingEdit ? 'Saving...' : 'Save Changes'}</span>
              </button>
              <button
                className="btn btn-secondary"
                onClick={() => handleApplyEdit(true)}
                disabled={isSavingEdit}
                style={{ fontSize: '0.8rem', gap: '6px', padding: '6px 14px' }}
                title="Save as a new copy in same folder"
              >
                <Copy size={15} />
                <span>Save Copy</span>
              </button>
              <button
                className="btn btn-ghost"
                onClick={() => {
                  setIsEditing(false);
                  setEditRotation(0);
                  setEditFlipH(false);
                }}
                style={{ fontSize: '0.8rem', padding: '6px 10px' }}
              >
                Cancel
              </button>
            </div>
          )}

          {/* Floating Zoom & Pan Control Bar */}
          <div
            style={{
              position: 'absolute',
              bottom: '20px',
              left: '50%',
              transform: 'translateX(-50%)',
              zIndex: 30,
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              padding: '6px 12px',
              borderRadius: 'var(--radius-full)',
              backgroundColor: 'rgba(15, 23, 42, 0.88)',
              backdropFilter: 'blur(12px)',
              border: '1px solid var(--border-subtle)',
              boxShadow: '0 8px 32px rgba(0, 0, 0, 0.6)',
              userSelect: 'none',
            }}
          >
            <button
              className="btn btn-ghost btn-icon"
              onClick={handleZoomOut}
              disabled={zoom <= 1}
              style={{ width: '28px', height: '28px', padding: 0 }}
              title="Zoom Out (Scroll Down)"
            >
              <ZoomOut size={16} />
            </button>

            <span
              onClick={handleResetZoom}
              style={{
                fontSize: '0.78rem',
                fontWeight: 600,
                fontFamily: 'var(--font-mono)',
                color: zoom > 1 ? 'var(--accent-primary)' : 'var(--text-secondary)',
                cursor: 'pointer',
                padding: '2px 8px',
                borderRadius: '4px',
                minWidth: '48px',
                textAlign: 'center',
              }}
              title="Click to reset zoom (100%)"
            >
              {Math.round(zoom * 100)}%
            </span>

            <button
              className="btn btn-ghost btn-icon"
              onClick={handleZoomIn}
              disabled={zoom >= 6}
              style={{ width: '28px', height: '28px', padding: 0 }}
              title="Zoom In (Scroll Up)"
            >
              <ZoomIn size={16} />
            </button>

            {zoom > 1 && (
              <button
                className="btn btn-ghost btn-icon"
                onClick={handleResetZoom}
                style={{ width: '28px', height: '28px', padding: 0, color: 'var(--text-muted)' }}
                title="Reset Zoom & Pan (Double click)"
              >
                <RotateCcw size={14} />
              </button>
            )}
          </div>
        </div>

        {/* Right-Side EXIF & Info Inspector */}
        {showInfo && (
          <aside style={{
            width: '370px',
            minWidth: '370px',
            height: '100%',
            backgroundColor: 'var(--bg-surface)',
            borderLeft: '1px solid var(--border-subtle)',
            padding: '20px 24px',
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: '20px',
          }}>
            {/* Header & Quick Action Icon Toolbar on Right Side of Photo */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <h2 style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>
                  Photo Details
                </h2>
                <button
                  className="btn btn-ghost btn-icon"
                  onClick={() => setShowInfo(false)}
                  title="Close Inspector (I)"
                  style={{ width: '28px', height: '28px', padding: 0 }}
                >
                  <X size={16} />
                </button>
              </div>

              {/* Action Toolbar on Right Side */}
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '6px 10px',
                backgroundColor: 'var(--bg-surface-elevated)',
                borderRadius: 'var(--radius-md)',
                border: '1px solid var(--border-subtle)',
              }}>
                <button
                  className={`btn btn-icon ${photo.isFavorite ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => onToggleFavorite(photo.id)}
                  style={{ width: '32px', height: '32px', padding: 0, color: photo.isFavorite ? 'var(--accent-rose)' : 'inherit' }}
                  title="Favorite (F)"
                >
                  <Heart size={16} fill={photo.isFavorite ? 'currentColor' : 'none'} />
                </button>

                <button
                  className="btn btn-ghost btn-icon"
                  onClick={handleScanFacesInPhoto}
                  disabled={isScanningSinglePhoto}
                  style={{ width: '32px', height: '32px', padding: 0, color: '#ec4899' }}
                  title="Scan faces in this photo only (CosFace)"
                >
                  <Sparkles size={16} className={isScanningSinglePhoto ? 'animate-spin' : ''} />
                </button>

                <button
                  className={`btn btn-icon ${isTaggingMode ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => {
                    setIsTaggingMode(!isTaggingMode);
                    setDrawBox(null);
                  }}
                  style={{ width: '32px', height: '32px', padding: 0, color: 'var(--accent-cyan)' }}
                  title="Draw & tag face manually"
                >
                  <Crop size={16} />
                </button>

                {photo.faces && photo.faces.length > 0 && (
                  <button
                    className={`btn btn-icon ${showFaces ? 'btn-secondary' : 'btn-ghost'}`}
                    onClick={() => setShowFaces(!showFaces)}
                    style={{ width: '32px', height: '32px', padding: 0 }}
                    title="Toggle Face Tag Overlays"
                  >
                    {showFaces ? <Eye size={16} /> : <EyeOff size={16} />}
                  </button>
                )}

                <button
                  className="btn btn-ghost btn-icon"
                  onClick={() => {
                    const pathToOpen = photo.isVirtual ? photo.originalRemotePath : photo.filePath;
                    if (pathToOpen && window.electronAPI?.openOriginalFile) {
                      window.electronAPI.openOriginalFile(pathToOpen);
                    }
                  }}
                  disabled={!isOriginalAvailable}
                  style={{ width: '32px', height: '32px', padding: 0, color: isOriginalAvailable ? '#10b981' : 'var(--text-muted)' }}
                  title={isOriginalAvailable ? 'Show Original in Explorer' : 'Original file unavailable'}
                >
                  <ExternalLink size={16} />
                </button>
              </div>
            </div>

            {/* Date & File info with icon on the right side */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div>
                  <div style={{ fontSize: '0.875rem', fontWeight: 600 }}>{formattedDate}</div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                    {photo.width && photo.height ? `${photo.width} × ${photo.height} • ` : ''}
                    {fileSizeMB} MB
                  </div>
                </div>
                <div style={{
                  width: '32px',
                  height: '32px',
                  borderRadius: 'var(--radius-full)',
                  backgroundColor: 'rgba(255, 255, 255, 0.05)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}>
                  <Calendar size={16} color="var(--text-secondary)" />
                </div>
              </div>

              {photo.isVirtual && photo.originalRemotePath && (
                <div style={{
                  backgroundColor: isOriginalAvailable ? 'rgba(16, 185, 129, 0.08)' : 'rgba(245, 158, 11, 0.08)',
                  borderRadius: 'var(--radius-md)',
                  padding: '12px',
                  border: isOriginalAvailable ? '1px solid rgba(16, 185, 129, 0.25)' : '1px solid rgba(245, 158, 11, 0.25)',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
                    <span style={{ fontSize: '0.8rem', fontWeight: 700, color: isOriginalAvailable ? '#34d399' : '#fbbf24' }}>
                      {isOriginalAvailable ? 'Original High-Res Connected' : 'Offline Mirror Cache (500px)'}
                    </span>
                    <div style={{
                      width: '24px',
                      height: '24px',
                      borderRadius: 'var(--radius-full)',
                      backgroundColor: isOriginalAvailable ? 'rgba(16, 185, 129, 0.15)' : 'rgba(245, 158, 11, 0.15)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}>
                      <HardDrive size={13} color={isOriginalAvailable ? '#34d399' : '#fbbf24'} />
                    </div>
                  </div>

                  <div style={{
                    fontSize: '0.72rem',
                    fontFamily: 'var(--font-mono)',
                    color: 'var(--text-secondary)',
                    wordBreak: 'break-all',
                    marginBottom: '10px',
                    lineHeight: 1.4,
                  }}>
                    {photo.originalRemotePath}
                  </div>

                  {isOriginalAvailable ? (
                    <button
                      className="btn btn-secondary"
                      onClick={() => photo.originalRemotePath && window.electronAPI?.openOriginalFile(photo.originalRemotePath)}
                      style={{ width: '100%', fontSize: '0.75rem', padding: '6px 12px', gap: '6px' }}
                    >
                      <ExternalLink size={13} />
                      <span>Show Original in Explorer</span>
                    </button>
                  ) : (
                    <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', lineHeight: 1.3 }}>
                      Network storage is currently disconnected. Viewing local mirror cache.
                    </div>
                  )}
                </div>
              )}
            </div>

            <hr style={{ borderColor: 'var(--border-subtle)', margin: 0 }} />

            {/* Camera & Lens Details with icon on right side */}
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
                <span style={{ fontSize: '0.85rem', fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-muted)' }}>
                  Camera & Settings
                </span>
                <div style={{
                  width: '32px',
                  height: '32px',
                  borderRadius: 'var(--radius-full)',
                  backgroundColor: 'rgba(59, 130, 246, 0.1)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}>
                  <Camera size={16} color="var(--accent-primary)" />
                </div>
              </div>

              {photo.exif ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '0.85rem' }}>
                  {photo.exif.cameraModel && (
                    <div style={{ fontWeight: 600 }}>
                      {photo.exif.cameraMake ? `${photo.exif.cameraMake} ` : ''}{photo.exif.cameraModel}
                    </div>
                  )}
                  {photo.exif.lensModel && (
                    <div style={{ color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
                      {photo.exif.lensModel}
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: '12px', marginTop: '6px', color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', fontSize: '0.75rem' }}>
                    {photo.exif.focalLength && <span>{photo.exif.focalLength}mm</span>}
                    {photo.exif.fNumber && <span>ƒ/{photo.exif.fNumber}</span>}
                    {photo.exif.exposureTime && <span>1/{Math.round(1 / photo.exif.exposureTime)}s</span>}
                    {photo.exif.iso && <span>ISO {photo.exif.iso}</span>}
                  </div>
                </div>
              ) : (
                <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                  No camera EXIF metadata recorded for this photo.
                </div>
              )}
            </div>

            <hr style={{ borderColor: 'var(--border-subtle)', margin: 0 }} />

            {/* Location & Map Section with icon on right side */}
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
                <span style={{ fontSize: '0.85rem', fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-muted)' }}>
                  Location
                </span>
                <div style={{
                  width: '32px',
                  height: '32px',
                  borderRadius: 'var(--radius-full)',
                  backgroundColor: 'rgba(6, 182, 212, 0.1)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}>
                  <MapPin size={16} color="var(--accent-cyan)" />
                </div>
              </div>

              {isEditingLocation ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                    <input
                      type="text"
                      value={locationInput}
                      onChange={(e) => setLocationInput(e.target.value)}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === 'Enter') handleSaveLocation();
                        else if (e.key === 'Escape') setIsEditingLocation(false);
                      }}
                      placeholder="e.g. Paris, Eiffel Tower, Home"
                      className="input"
                      autoFocus
                      style={{ fontSize: '0.85rem', padding: '6px 10px', flex: 1 }}
                    />
                    <button
                      className="btn btn-primary"
                      onClick={handleSaveLocation}
                      style={{ width: '32px', height: '32px', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                      title="Save location (Enter)"
                    >
                      <Check size={16} />
                    </button>
                    <button
                      className="btn btn-ghost"
                      onClick={() => setIsEditingLocation(false)}
                      style={{ width: '32px', height: '32px', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                      title="Cancel (Esc)"
                    >
                      <X size={16} />
                    </button>
                  </div>
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                    Type custom place name and press Enter to save
                  </div>
                </div>
              ) : photo.location ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                    <div style={{ fontWeight: 600, fontSize: '0.9rem', color: 'var(--text-primary)' }}>
                      {photo.location.label || (photo.location.latitude ? `${photo.location.latitude.toFixed(4)}, ${photo.location.longitude.toFixed(4)}` : 'Location named')}
                    </div>
                    <button
                      className="btn btn-ghost btn-icon"
                      style={{ width: '28px', height: '28px', padding: 0 }}
                      onClick={handleStartEditLocation}
                      title="Rename Location"
                    >
                      <Edit2 size={13} color="var(--text-muted)" />
                    </button>
                  </div>
                  {photo.location.latitude !== 0 && photo.location.longitude !== 0 && (
                    <>
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                        {photo.location.latitude.toFixed(5)}°, {photo.location.longitude.toFixed(5)}°
                      </div>
                      <a
                        href={`https://www.openstreetmap.org/?mlat=${photo.location.latitude}&mlon=${photo.location.longitude}#map=15/${photo.location.latitude}/${photo.location.longitude}`}
                        target="_blank"
                        rel="noreferrer"
                        className="btn btn-secondary"
                        style={{ marginTop: '4px', fontSize: '0.75rem', textDecoration: 'none' }}
                      >
                        Open in OpenStreetMap
                      </a>
                    </>
                  )}
                </div>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                    No location set.
                  </div>
                  <button
                    className="btn btn-ghost"
                    onClick={handleStartEditLocation}
                    style={{ fontSize: '0.75rem', padding: '4px 8px', gap: '4px', height: '26px' }}
                    title="Add custom location name"
                  >
                    <Edit2 size={12} />
                    <span>Add Name</span>
                  </button>
                </div>
              )}
            </div>

            <hr style={{ borderColor: 'var(--border-subtle)', margin: 0 }} />

            {/* People In Photo with icon on right side */}
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ fontSize: '0.85rem', fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-muted)' }}>
                    People ({photo.faces?.length || 0})
                  </span>
                  <div style={{ display: 'flex', gap: '4px' }}>
                    <button
                      className="btn btn-secondary"
                      onClick={handleScanFacesInPhoto}
                      disabled={isScanningSinglePhoto}
                      style={{ fontSize: '0.72rem', padding: '2px 8px', height: '24px', gap: '4px' }}
                      title="Scan faces in this photo only"
                    >
                      <Sparkles size={12} color="#ec4899" className={isScanningSinglePhoto ? 'animate-spin' : ''} />
                      <span>Scan</span>
                    </button>
                    <button
                      className={`btn ${isTaggingMode ? 'btn-primary' : 'btn-secondary'}`}
                      onClick={() => {
                        setIsTaggingMode(!isTaggingMode);
                        setDrawBox(null);
                      }}
                      style={{ fontSize: '0.72rem', padding: '2px 8px', height: '24px', gap: '4px' }}
                      title="Draw bounding box to tag a face manually"
                    >
                      <Plus size={12} />
                      <span>Tag</span>
                    </button>
                  </div>
                </div>

                <div style={{
                  width: '32px',
                  height: '32px',
                  borderRadius: 'var(--radius-full)',
                  backgroundColor: 'rgba(236, 72, 153, 0.1)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}>
                  <Users size={16} color="#ec4899" />
                </div>
              </div>

              {photo.faces && photo.faces.length > 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  {photo.faces.map((face) => {
                    const person = people.find((p) => p.id === face.personId);
                    const personName = person ? person.name : 'Unknown Person';

                    return (
                      <div
                        key={face.id}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          padding: '8px 10px',
                          borderRadius: 'var(--radius-md)',
                          backgroundColor: 'var(--bg-surface-elevated)',
                          border: '1px solid var(--border-subtle)',
                        }}
                      >
                        <div
                          onClick={() => face.personId && onNavigateToPerson && onNavigateToPerson(face.personId)}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '10px',
                            cursor: face.personId ? 'pointer' : 'default',
                            flex: 1,
                            minWidth: 0,
                          }}
                        >
                          <div style={{ borderRadius: 'var(--radius-full)', overflow: 'hidden', flexShrink: 0 }}>
                            <FaceAvatar photo={photo} box={face.box} size={36} alt={personName} />
                          </div>
                          <div style={{ overflow: 'hidden' }}>
                            <div style={{
                              fontSize: '0.82rem',
                              fontWeight: 600,
                              color: 'var(--text-primary)',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                              display: 'flex',
                              alignItems: 'center',
                              gap: '6px',
                            }}>
                              <span>{personName}</span>
                              {face.dominantExpression && (
                                <span title={`Expression: ${face.dominantExpression}`} style={{ fontSize: '0.85rem' }}>
                                  {getExpressionEmoji(face.dominantExpression)}
                                </span>
                              )}
                            </div>
                            <div style={{
                              fontSize: '0.7rem',
                              color: face.isConfirmed ? 'var(--accent-emerald)' : 'var(--text-muted)',
                              display: 'flex',
                              alignItems: 'center',
                              gap: '4px',
                              flexWrap: 'wrap',
                            }}>
                              <span>{face.isConfirmed ? '✓ Verified' : 'Detected'}</span>
                              {face.age && <span>• ~{face.age} yrs</span>}
                              {face.gender && <span>• {face.gender === 'female' ? '♀' : '♂'} {face.gender}</span>}
                            </div>
                          </div>
                        </div>

                        {/* Curation actions on right side */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0, marginLeft: '6px' }}>
                          <button
                            className={`btn btn-icon ${face.isConfirmed ? 'btn-primary' : 'btn-ghost'}`}
                            style={{
                              width: '26px',
                              height: '26px',
                              padding: 0,
                              color: face.isConfirmed ? 'white' : 'var(--accent-emerald)',
                              backgroundColor: face.isConfirmed ? 'var(--accent-emerald)' : 'transparent',
                            }}
                            onClick={(e) => handleConfirmFace(face.id, e)}
                            title={face.isConfirmed ? 'Verified Correct' : 'Confirm person is correct'}
                          >
                            <CheckCircle2 size={14} />
                          </button>

                          {/* Reassign (Not Renuka, but Monika) */}
                          <button
                            className="btn btn-ghost btn-icon"
                            style={{ width: '26px', height: '26px', padding: 0, color: 'var(--accent-primary)' }}
                            onClick={(e) => {
                              e.stopPropagation();
                              setReassignFace({ face, currentPersonName: personName });
                            }}
                            title={`Not ${personName}? Reassign to someone else (e.g. Monika)...`}
                          >
                            <UserCheck size={14} />
                          </button>

                          {/* Rename Person (e.g. Person 1 to Monika) */}
                          {face.personId && (
                            <button
                              className="btn btn-ghost btn-icon"
                              style={{ width: '26px', height: '26px', padding: 0, color: 'var(--text-secondary)' }}
                              onClick={(e) => {
                                e.stopPropagation();
                                setRenamePersonState({ personId: face.personId!, currentName: personName });
                                setRenameInputName(personName);
                              }}
                              title={`Rename "${personName}" across all library photos`}
                            >
                              <Edit2 size={13} />
                            </button>
                          )}

                          {face.personId && (
                            <button
                              className="btn btn-ghost btn-icon"
                              style={{ width: '26px', height: '26px', padding: 0, color: 'var(--accent-amber)' }}
                              onClick={(e) => handleUnassignFace(face.id, personName, e)}
                              title={`Wrong Person (Remove from ${personName})`}
                            >
                              <UserX size={14} />
                            </button>
                          )}

                          <button
                            className="btn btn-ghost btn-icon"
                            style={{ width: '26px', height: '26px', padding: 0, color: 'var(--accent-rose)' }}
                            onClick={(e) => handleDeleteDetection(face.id, e)}
                            title="Delete Face Detection Box Completely"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                  No faces detected in this photo yet.
                </div>
              )}
            </div>
          </aside>
        )}
      </div>

      {/* Reassign Face Modal */}
      {reassignFace && (
        <ReassignFaceModal
          face={reassignFace.face}
          photo={photo}
          currentPersonName={reassignFace.currentPersonName}
          people={people}
          onClose={() => setReassignFace(null)}
        />
      )}

      {/* Rename Person Modal */}
      {renamePersonState && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(5, 8, 15, 0.85)',
            backdropFilter: 'blur(8px)',
            zIndex: 3000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '20px',
          }}
          onClick={() => setRenamePersonState(null)}
        >
          <div
            style={{
              width: '100%',
              maxWidth: '420px',
              backgroundColor: 'var(--bg-surface)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-lg)',
              boxShadow: '0 24px 64px rgba(0, 0, 0, 0.6)',
              overflow: 'hidden',
              padding: '24px',
              display: 'flex',
              flexDirection: 'column',
              gap: '16px',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Edit2 size={18} color="var(--accent-primary)" />
                <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                  Rename Person
                </h3>
              </div>
              <button
                className="btn btn-ghost btn-icon"
                onClick={() => setRenamePersonState(null)}
                title="Close"
              >
                <X size={16} />
              </button>
            </div>

            <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--text-secondary)', lineHeight: 1.4 }}>
              Rename <strong>{renamePersonState.currentName}</strong> across all recognized photos in your library.
            </p>

            <PersonNameInput
              initialValue={renamePersonState.currentName}
              onSave={(clean) => {
                const res = libraryStore.updatePersonName(renamePersonState.personId, clean);
                if (!res.success) {
                  alert(res.error || 'Failed to rename person');
                  return;
                }
                if (res.merged) {
                  alert(`Merged with existing person "${res.targetPersonName}".`);
                }
                setRenamePersonState(null);
              }}
              onCancel={() => setRenamePersonState(null)}
              isLarge={true}
              style={{ width: '100%', marginTop: '6px' }}
            />
          </div>
        </div>
      )}

      {/* Album Toast Notification */}
      {albumToast && (
        <div
          style={{
            position: 'absolute',
            top: '70px',
            right: '24px',
            zIndex: 1000,
            padding: '10px 18px',
            backgroundColor: 'rgba(16, 185, 129, 0.95)',
            color: 'white',
            fontWeight: 600,
            fontSize: '0.85rem',
            borderRadius: 'var(--radius-md)',
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.5)',
            backdropFilter: 'blur(8px)',
          }}
        >
          {albumToast}
        </div>
      )}

      {/* Modal: Add to Album */}
      {showAddToAlbumModal && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(5, 8, 15, 0.88)',
            backdropFilter: 'blur(10px)',
            zIndex: 3500,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '24px',
          }}
          onClick={() => setShowAddToAlbumModal(false)}
        >
          <div
            style={{
              width: '100%',
              maxWidth: '440px',
              backgroundColor: 'var(--bg-surface)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-lg)',
              boxShadow: '0 24px 64px rgba(0, 0, 0, 0.7)',
              overflow: 'hidden',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              style={{
                padding: '16px 20px',
                borderBottom: '1px solid var(--border-subtle)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <BookImage size={20} color="var(--accent-primary)" />
                <h3 style={{ fontSize: '1.15rem', fontWeight: 700, margin: 0, color: 'var(--text-primary)' }}>
                  Add to Album
                </h3>
              </div>
              <button
                className="btn btn-ghost btn-icon"
                onClick={() => setShowAddToAlbumModal(false)}
                style={{ width: '32px', height: '32px' }}
              >
                <X size={18} />
              </button>
            </div>

            <form onSubmit={handleAddPhotoToAlbum} style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
              {(libraryStore.getState().albums || []).length > 0 && (
                <div>
                  <label style={{ display: 'block', fontSize: '0.82rem', fontWeight: 600, marginBottom: '6px' }}>
                    Select Album
                  </label>
                  <select
                    className="input"
                    value={targetAlbumId}
                    onChange={(e) => setTargetAlbumId(e.target.value)}
                    style={{ height: '38px', width: '100%' }}
                  >
                    <option value="new">+ Create New Album...</option>
                    {(libraryStore.getState().albums || []).map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.title} ({a.photoIds.length} photos)
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {targetAlbumId === 'new' && (
                <div>
                  <label style={{ display: 'block', fontSize: '0.82rem', fontWeight: 600, marginBottom: '6px' }}>
                    New Album Title <span style={{ color: 'var(--accent-rose)' }}>*</span>
                  </label>
                  <input
                    type="text"
                    className="input"
                    placeholder="e.g. Family Vacation, Birthday 2024"
                    value={newAlbumTitle}
                    onChange={(e) => setNewAlbumTitle(e.target.value)}
                    autoFocus
                    required={targetAlbumId === 'new'}
                    style={{ height: '38px' }}
                  />
                </div>
              )}

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '8px' }}>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => setShowAddToAlbumModal(false)}
                  style={{ height: '38px', padding: '0 16px' }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={targetAlbumId === 'new' && !newAlbumTitle.trim()}
                  style={{ height: '38px', padding: '0 20px' }}
                >
                  Add Photo
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
