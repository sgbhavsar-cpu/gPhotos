import React, { useState, useEffect } from 'react';
import {
  X,
  Sparkles,
  CheckCircle2,
  Trash2,
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  ShieldCheck,
  Check,
  RefreshCw,
  MinusCircle,
  Maximize2,
  Minimize2,
  CheckSquare,
  Square,
  Eye,
  Info,
  Layers
} from 'lucide-react';
import { Photo, DuplicateCluster } from '../../types';
import { identifyDuplicateClusters } from '../services/deduplication';
import { libraryStore, getLocalPhotoUrl } from '../services/libraryStore';

interface DuplicateCleanerModalProps {
  photos: Photo[];
  onClose: () => void;
  onPhotosDeleted?: (deletedCount: number) => void;
  initialCluster?: DuplicateCluster | null;
}

export const DuplicateCleanerModal: React.FC<DuplicateCleanerModalProps> = ({
  photos,
  onClose,
  onPhotosDeleted,
  initialCluster,
}) => {
  const [clusters, setClusters] = useState<DuplicateCluster[]>([]);
  const [currentClusterIdx, setCurrentClusterIdx] = useState(0);
  // clusterId -> Set of photoIds that user chooses to KEEP
  const [keptPhotoIds, setKeptPhotoIds] = useState<Record<string, Set<string>>>({});
  const [isDeleting, setIsDeleting] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [excludedPhotoIds, setExcludedPhotoIds] = useState<Set<string>>(new Set());

  // Fullscreen photo preview
  const [fullscreenPhoto, setFullscreenPhoto] = useState<Photo | null>(null);

  useEffect(() => {
    if (initialCluster) {
      setClusters([initialCluster]);
      setKeptPhotoIds({
        [initialCluster.id]: new Set([initialCluster.bestPhotoId]),
      });
      return;
    }

    const found = identifyDuplicateClusters(photos);
    setClusters(found);

    const initialKeepers: Record<string, Set<string>> = {};
    for (const c of found) {
      initialKeepers[c.id] = new Set([c.bestPhotoId]);
    }
    setKeptPhotoIds(initialKeepers);
  }, [photos, initialCluster]);

  const activeCluster = clusters[currentClusterIdx];

  // Helper to check if a photo in the active cluster is marked to keep
  const isPhotoKept = (clusterId: string, photoId: string): boolean => {
    const set = keptPhotoIds[clusterId];
    if (!set) {
      const cluster = clusters.find((c) => c.id === clusterId);
      return cluster ? cluster.bestPhotoId === photoId : false;
    }
    return set.has(photoId);
  };

  // Toggle keeping a photo
  const handleToggleKeep = (clusterId: string, photoId: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setKeptPhotoIds((prev) => {
      const currentCluster = clusters.find((c) => c.id === clusterId);
      const existingSet = prev[clusterId] ? new Set(prev[clusterId]) : new Set([currentCluster?.bestPhotoId || '']);
      if (existingSet.has(photoId)) {
        existingSet.delete(photoId);
      } else {
        existingSet.add(photoId);
      }
      return {
        ...prev,
        [clusterId]: existingSet,
      };
    });
  };

  // Quick Action: Keep All photos in current cluster
  const handleKeepAll = (clusterId: string) => {
    const cluster = clusters.find((c) => c.id === clusterId);
    if (!cluster) return;
    setKeptPhotoIds((prev) => ({
      ...prev,
      [clusterId]: new Set(cluster.photos.map((p) => p.id)),
    }));
    setStatusMessage('All photos in this group marked to KEEP.');
    setTimeout(() => setStatusMessage(null), 2500);
  };

  // Quick Action: Keep only the AI Best Shot
  const handleKeepBestOnly = (clusterId: string) => {
    const cluster = clusters.find((c) => c.id === clusterId);
    if (!cluster) return;
    setKeptPhotoIds((prev) => ({
      ...prev,
      [clusterId]: new Set([cluster.bestPhotoId]),
    }));
    setStatusMessage('Only AI Best Shot marked to KEEP.');
    setTimeout(() => setStatusMessage(null), 2500);
  };

  // Quick Action: Deselect all (mark all for removal)
  const handleDeselectAll = (clusterId: string) => {
    setKeptPhotoIds((prev) => ({
      ...prev,
      [clusterId]: new Set<string>(),
    }));
  };

  // Facility to remove a photograph from clustering when it does not actually belong
  const handleExcludeFromCluster = (clusterId: string, photoId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setExcludedPhotoIds((prev) => new Set(prev).add(photoId));

    setClusters((prevClusters) => {
      const updated: DuplicateCluster[] = [];
      for (const c of prevClusters) {
        if (c.id === clusterId) {
          const remainingPhotos = c.photos.filter((p) => p.id !== photoId);
          if (remainingPhotos.length >= 2) {
            let highestScore = -1;
            let bestId = remainingPhotos[0].id;
            for (const item of remainingPhotos) {
              const score = c.scores[item.id]?.totalScore ?? 0;
              if (score > highestScore) {
                highestScore = score;
                bestId = item.id;
              }
            }
            updated.push({
              ...c,
              photos: remainingPhotos,
              bestPhotoId: c.bestPhotoId === photoId ? bestId : c.bestPhotoId,
            });
          }
        } else {
          updated.push(c);
        }
      }
      return updated;
    });

    setKeptPhotoIds((prev) => {
      if (prev[clusterId]) {
        const nextSet = new Set(prev[clusterId]);
        nextSet.delete(photoId);
        return { ...prev, [clusterId]: nextSet };
      }
      return prev;
    });

    setStatusMessage('Photo removed from duplicate group. Cluster re-evaluated.');
    setTimeout(() => setStatusMessage(null), 3000);
  };

  // Re-cluster all eligible photos (excluding photos user marked as not duplicates)
  const handleReclusterAll = () => {
    const eligible = photos.filter((p) => !excludedPhotoIds.has(p.id));
    const found = identifyDuplicateClusters(eligible);
    setClusters(found);
    setCurrentClusterIdx(0);

    const initialKeepers: Record<string, Set<string>> = {};
    for (const c of found) {
      initialKeepers[c.id] = new Set([c.bestPhotoId]);
    }
    setKeptPhotoIds(initialKeepers);

    setStatusMessage(`✓ Re-clustered library: ${found.length} duplicate group(s) identified.`);
    setTimeout(() => setStatusMessage(null), 3500);
  };

  // Delete duplicates in active cluster (any photos not marked to keep)
  const handleDeleteRemaining = async () => {
    if (!activeCluster) return;

    const keptSet = keptPhotoIds[activeCluster.id] || new Set([activeCluster.bestPhotoId]);
    const toDelete = activeCluster.photos.filter((p) => !keptSet.has(p.id));
    const count = toDelete.length;

    if (count === 0) {
      alert('All photos in this group are currently selected to KEEP. To delete photos, uncheck the ones you want to remove.');
      return;
    }

    const confirmed = window.confirm(
      `Keep the ${keptSet.size} selected photo(s) and move the other ${count} unselected duplicate photo(s) to the Recycle Bin?\n\nThis is safe and frees up space.`
    );
    if (!confirmed) return;

    setIsDeleting(true);
    const deletePaths = toDelete.map((p) => p.originalRemotePath || p.filePath);

    try {
      // Only remove photos that were actually trashed — a photo whose network
      // storage is offline is skipped by trashFiles rather than attempted, so
      // it must stay in the library instead of silently disappearing from view.
      let trashedIds = toDelete.map((p) => p.id);
      let failureMessage: string | null = null;

      if (window.electronAPI?.trashFiles) {
        const result = await window.electronAPI.trashFiles(deletePaths);
        const trashedPathSet = new Set(result.trashedPaths);
        trashedIds = toDelete
          .filter((p) => trashedPathSet.has(p.originalRemotePath || p.filePath))
          .map((p) => p.id);

        if (result.errors.length > 0) {
          const offlineCount = result.errors.filter((e) => e.includes('network storage is not available')).length;
          failureMessage = offlineCount > 0
            ? `${offlineCount} of ${count} photo(s) skipped — network storage is not available.`
            : `${result.errors.length} of ${count} photo(s) could not be removed.`;
        }
      }

      if (trashedIds.length > 0) {
        libraryStore.removePhotos(trashedIds);
      }

      setStatusMessage(
        failureMessage
          ? (trashedIds.length > 0
              ? `⚠ Kept ${keptSet.size} photo(s), removed ${trashedIds.length}. ${failureMessage}`
              : `⚠ ${failureMessage}`)
          : `✓ Kept ${keptSet.size} photo(s) and safely removed ${count} duplicate(s)!`
      );
      if (onPhotosDeleted) onPhotosDeleted(trashedIds.length);

      // Remove this cluster from view
      const remainingClusters = clusters.filter((_, idx) => idx !== currentClusterIdx);
      setClusters(remainingClusters);
      if (currentClusterIdx >= remainingClusters.length) {
        setCurrentClusterIdx(Math.max(0, remainingClusters.length - 1));
      }
    } catch (err: any) {
      alert(`Failed to delete duplicates: ${err.message}`);
    } finally {
      setIsDeleting(false);
      setTimeout(() => setStatusMessage(null), 3500);
    }
  };

  // Calculate total space recoverable
  const totalDuplicatePhotosCount = clusters.reduce((acc, c) => {
    const kept = keptPhotoIds[c.id] || new Set([c.bestPhotoId]);
    return acc + Math.max(0, c.photos.length - kept.size);
  }, 0);

  const totalSpaceBytes = clusters.reduce((acc, c) => {
    const kept = keptPhotoIds[c.id] || new Set([c.bestPhotoId]);
    const toRemove = c.photos.filter((p) => !kept.has(p.id));
    return acc + toRemove.reduce((sum, p) => sum + (p.fileSize || 0), 0);
  }, 0);
  const totalSpaceMB = (totalSpaceBytes / (1024 * 1024)).toFixed(1);

  // Keyboard navigation for Fullscreen Lightbox
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!fullscreenPhoto || !activeCluster) return;

      if (e.key === 'Escape') {
        setFullscreenPhoto(null);
      } else if (e.key === 'ArrowRight') {
        const idx = activeCluster.photos.findIndex((p) => p.id === fullscreenPhoto.id);
        if (idx !== -1 && idx < activeCluster.photos.length - 1) {
          setFullscreenPhoto(activeCluster.photos[idx + 1]);
        }
      } else if (e.key === 'ArrowLeft') {
        const idx = activeCluster.photos.findIndex((p) => p.id === fullscreenPhoto.id);
        if (idx > 0) {
          setFullscreenPhoto(activeCluster.photos[idx - 1]);
        }
      } else if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        handleToggleKeep(activeCluster.id, fullscreenPhoto.id);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [fullscreenPhoto, activeCluster]);

  const activeKeptSet = activeCluster
    ? keptPhotoIds[activeCluster.id] || new Set([activeCluster.bestPhotoId])
    : new Set<string>();
  const activeUnkeptCount = activeCluster
    ? activeCluster.photos.filter((p) => !activeKeptSet.has(p.id)).length
    : 0;

  return (
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
      onClick={onClose}
    >
      <div
        style={{
          width: '100%',
          maxWidth: '1080px',
          maxHeight: '92vh',
          backgroundColor: 'var(--bg-surface)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: '0 24px 64px rgba(0, 0, 0, 0.7)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            padding: '18px 24px',
            borderBottom: '1px solid var(--border-subtle)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <Sparkles size={24} color="var(--accent-primary)" />
            <div>
              <h2 style={{ fontSize: '1.25rem', fontWeight: 700, margin: 0 }}>
                AI Duplicate & Burst Cleaner
              </h2>
              {clusters.length > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px' }}>
                  <span
                    style={{
                      fontSize: '0.8rem',
                      color: 'var(--accent-emerald)',
                      backgroundColor: 'rgba(16, 185, 129, 0.12)',
                      padding: '3px 10px',
                      borderRadius: 'var(--radius-full)',
                      fontWeight: 600,
                    }}
                  >
                    {totalDuplicatePhotosCount} duplicate(s) to remove ({totalSpaceMB} MB recoverable)
                  </span>
                  {excludedPhotoIds.size > 0 && (
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                      ({excludedPhotoIds.size} excluded from groups)
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            {/* Recluster Button */}
            <button
              className="btn btn-secondary"
              onClick={handleReclusterAll}
              title="Re-run duplicate clustering across all eligible library photos"
              style={{ padding: '8px 14px', fontSize: '0.82rem', gap: '8px', height: '38px' }}
            >
              <RefreshCw size={16} />
              <span>Re-cluster</span>
            </button>

            <button
              className="btn btn-ghost btn-icon"
              onClick={onClose}
              title="Close"
              style={{ width: '38px', height: '38px', borderRadius: 'var(--radius-md)' }}
            >
              <X size={22} />
            </button>
          </div>
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '24px' }}>
          {statusMessage && (
            <div
              style={{
                marginBottom: '16px',
                padding: '12px 18px',
                backgroundColor: 'rgba(16, 185, 129, 0.15)',
                border: '1px solid rgba(16, 185, 129, 0.3)',
                borderRadius: 'var(--radius-md)',
                color: 'var(--accent-emerald)',
                fontSize: '0.88rem',
                fontWeight: 600,
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
              }}
            >
              <CheckCircle2 size={18} />
              <span>{statusMessage}</span>
            </div>
          )}

          {clusters.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-muted)' }}>
              <ShieldCheck size={56} color="var(--accent-emerald)" style={{ margin: '0 auto 16px' }} />
              <h3 style={{ fontSize: '1.25rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '8px' }}>
                Your Library is Clean!
              </h3>
              <p style={{ maxWidth: '420px', margin: '0 auto 20px', fontSize: '0.9rem', lineHeight: 1.5 }}>
                No duplicate bursts or identical similar photos found. All indexed photos are distinct.
              </p>
              {excludedPhotoIds.size > 0 && (
                <button
                  className="btn btn-secondary"
                  onClick={() => {
                    setExcludedPhotoIds(new Set());
                    const found = identifyDuplicateClusters(photos);
                    setClusters(found);
                    setCurrentClusterIdx(0);
                  }}
                  style={{ gap: '8px', padding: '10px 18px' }}
                >
                  <RefreshCw size={16} />
                  <span>Reset Exclusions & Scan Again</span>
                </button>
              )}
            </div>
          ) : activeCluster ? (
            <div>
              {/* Cluster Progress & Multi-Keep Selector Bar */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginBottom: '18px',
                  backgroundColor: 'var(--bg-surface-elevated)',
                  padding: '14px 18px',
                  borderRadius: 'var(--radius-md)',
                  border: '1px solid var(--border-subtle)',
                  flexWrap: 'wrap',
                  gap: '12px',
                }}
              >
                <div>
                  <div style={{ fontSize: '0.95rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                    Group {currentClusterIdx + 1} of {clusters.length} • {activeCluster.photos.length} Similar Photos
                  </div>
                  <div style={{ fontSize: '0.82rem', color: 'var(--accent-primary)', marginTop: '3px', fontWeight: 500 }}>
                    {activeCluster.bestReason}
                  </div>
                </div>

                {/* Multi-Keep Quick Controls */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginRight: '4px' }}>
                    Keep Selection:
                  </span>
                  <button
                    className="btn btn-secondary"
                    onClick={() => handleKeepBestOnly(activeCluster.id)}
                    style={{ fontSize: '0.78rem', padding: '6px 12px', height: '32px' }}
                    title="Keep only the single best shot detected by AI"
                  >
                    Keep AI Best Only
                  </button>
                  <button
                    className="btn btn-secondary"
                    onClick={() => handleKeepAll(activeCluster.id)}
                    style={{ fontSize: '0.78rem', padding: '6px 12px', height: '32px' }}
                    title="Keep all photos in this group (do not delete any)"
                  >
                    Keep All Photos
                  </button>
                  <button
                    className="btn btn-ghost"
                    onClick={() => handleDeselectAll(activeCluster.id)}
                    style={{ fontSize: '0.78rem', padding: '6px 12px', height: '32px' }}
                    title="Mark all photos in this group for removal"
                  >
                    Deselect All
                  </button>

                  <div style={{ width: '1px', height: '24px', backgroundColor: 'var(--border-subtle)', margin: '0 4px' }} />

                  {/* Navigation Arrows */}
                  <button
                    className="btn btn-secondary btn-icon"
                    disabled={currentClusterIdx === 0}
                    onClick={() => setCurrentClusterIdx((v) => Math.max(0, v - 1))}
                    title="Previous Group"
                    style={{ width: '34px', height: '34px' }}
                  >
                    <ChevronLeft size={18} />
                  </button>
                  <button
                    className="btn btn-secondary btn-icon"
                    disabled={currentClusterIdx >= clusters.length - 1}
                    onClick={() => setCurrentClusterIdx((v) => Math.min(clusters.length - 1, v + 1))}
                    title="Next Group"
                    style={{ width: '34px', height: '34px' }}
                  >
                    <ChevronRight size={18} />
                  </button>
                </div>
              </div>

              {/* Photos Comparison Grid */}
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: `repeat(${Math.min(4, activeCluster.photos.length)}, 1fr)`,
                  gap: '16px',
                  marginBottom: '24px',
                }}
              >
                {activeCluster.photos.map((photo) => {
                  const isKept = isPhotoKept(activeCluster.id, photo.id);
                  const isAiRecommended = activeCluster.bestPhotoId === photo.id;
                  const score = activeCluster.scores[photo.id];

                  return (
                    <div
                      key={photo.id}
                      style={{
                        position: 'relative',
                        borderRadius: 'var(--radius-lg)',
                        overflow: 'hidden',
                        border: isKept ? '3px solid var(--accent-emerald)' : '1px solid rgba(239, 68, 68, 0.4)',
                        boxShadow: isKept ? '0 0 20px rgba(16, 185, 129, 0.35)' : 'var(--shadow-sm)',
                        backgroundColor: 'var(--bg-surface-elevated)',
                        display: 'flex',
                        flexDirection: 'column',
                        transition: 'all var(--transition-fast)',
                      }}
                    >
                      {/* Image Thumbnail Container */}
                      <div
                        style={{ height: '240px', backgroundColor: '#0f172a', position: 'relative', cursor: 'pointer' }}
                        onClick={() => handleToggleKeep(activeCluster.id, photo.id)}
                        title="Click to toggle Keep / Remove"
                      >
                        <img
                          src={getLocalPhotoUrl(photo.filePath, photo.originalRemotePath)}
                          alt={photo.fileName}
                          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                        />

                        {/* Top-Left: AI Best Shot Badge */}
                        {isAiRecommended && (
                          <div
                            style={{
                              position: 'absolute',
                              top: '10px',
                              left: '10px',
                              backgroundColor: 'rgba(234, 179, 8, 0.95)',
                              color: '#000',
                              fontSize: '0.72rem',
                              fontWeight: 700,
                              padding: '3px 9px',
                              borderRadius: 'var(--radius-full)',
                              display: 'flex',
                              alignItems: 'center',
                              gap: '5px',
                              boxShadow: '0 2px 8px rgba(0,0,0,0.5)',
                            }}
                          >
                            <Sparkles size={13} />
                            <span>AI Best Shot</span>
                          </div>
                        )}

                        {/* Top-Right: Action Badges (Fullscreen Preview + Exclude + Keep Checkbox) */}
                        <div
                          style={{
                            position: 'absolute',
                            top: '10px',
                            right: '10px',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '6px',
                          }}
                        >
                          {/* Fullscreen Preview Trigger */}
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setFullscreenPhoto(photo);
                            }}
                            style={{
                              backgroundColor: 'rgba(15, 23, 42, 0.85)',
                              backdropFilter: 'blur(6px)',
                              color: 'white',
                              border: '1px solid rgba(255, 255, 255, 0.3)',
                              borderRadius: 'var(--radius-full)',
                              width: '32px',
                              height: '32px',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              cursor: 'pointer',
                              boxShadow: '0 2px 6px rgba(0,0,0,0.5)',
                              transition: 'all 0.15s ease',
                            }}
                            title="Open photo full screen to inspect details"
                          >
                            <Maximize2 size={16} />
                          </button>

                          {/* Exclude from cluster button */}
                          <button
                            onClick={(e) => handleExcludeFromCluster(activeCluster.id, photo.id, e)}
                            style={{
                              backgroundColor: 'rgba(15, 23, 42, 0.85)',
                              backdropFilter: 'blur(6px)',
                              color: '#f87171',
                              border: '1px solid rgba(239, 68, 68, 0.5)',
                              borderRadius: 'var(--radius-full)',
                              width: '32px',
                              height: '32px',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              cursor: 'pointer',
                              boxShadow: '0 2px 6px rgba(0,0,0,0.5)',
                              transition: 'all 0.15s ease',
                            }}
                            title="Not a duplicate: remove photograph from this group"
                          >
                            <MinusCircle size={17} />
                          </button>

                          {/* Multi-Keep Checkbox Indicator */}
                          <div
                            onClick={(e) => handleToggleKeep(activeCluster.id, photo.id, e)}
                            style={{
                              backgroundColor: isKept ? 'var(--accent-emerald)' : 'rgba(15, 23, 42, 0.75)',
                              color: 'white',
                              width: '32px',
                              height: '32px',
                              borderRadius: 'var(--radius-full)',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              boxShadow: '0 2px 6px rgba(0,0,0,0.5)',
                              border: isKept ? '2px solid white' : '1px solid rgba(255,255,255,0.3)',
                              cursor: 'pointer',
                            }}
                            title={isKept ? 'Photo marked to KEEP (click to uncheck)' : 'Click to mark as KEEP'}
                          >
                            {isKept && <Check size={18} strokeWidth={3} />}
                          </div>
                        </div>

                        {/* Bottom Status Pill */}
                        <div
                          style={{
                            position: 'absolute',
                            bottom: '10px',
                            left: '10px',
                            right: '10px',
                            backgroundColor: isKept ? 'rgba(16, 185, 129, 0.95)' : 'rgba(239, 68, 68, 0.88)',
                            color: 'white',
                            fontSize: '0.75rem',
                            fontWeight: 700,
                            padding: '5px 10px',
                            borderRadius: 'var(--radius-sm)',
                            textAlign: 'center',
                            letterSpacing: '0.02em',
                            boxShadow: '0 2px 6px rgba(0,0,0,0.4)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: '6px',
                          }}
                        >
                          {isKept ? (
                            <>
                              <CheckCircle2 size={14} />
                              <span>KEEP THIS PHOTO</span>
                            </>
                          ) : (
                            <>
                              <Trash2 size={14} />
                              <span>REMOVE AS DUPLICATE</span>
                            </>
                          )}
                        </div>
                      </div>

                      {/* Photo Details & Fullscreen link */}
                      <div style={{ padding: '12px 14px' }}>
                        <div
                          style={{
                            fontSize: '0.85rem',
                            fontWeight: 600,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                          title={photo.fileName}
                        >
                          {photo.fileName}
                        </div>
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '4px' }}>
                          {(photo.fileSize / (1024 * 1024)).toFixed(2)} MB • Quality: {score?.totalScore || 75}/100
                        </div>

                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '8px' }}>
                          <button
                            onClick={() => setFullscreenPhoto(photo)}
                            style={{
                              background: 'none',
                              border: 'none',
                              color: 'var(--accent-cyan)',
                              fontSize: '0.75rem',
                              fontWeight: 600,
                              cursor: 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                              gap: '4px',
                              padding: 0,
                            }}
                          >
                            <Eye size={13} />
                            <span>View Fullscreen</span>
                          </button>

                          <button
                            onClick={(e) => handleToggleKeep(activeCluster.id, photo.id, e)}
                            style={{
                              background: 'none',
                              border: 'none',
                              color: isKept ? 'var(--accent-emerald)' : 'var(--text-muted)',
                              fontSize: '0.75rem',
                              fontWeight: 600,
                              cursor: 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                              gap: '4px',
                              padding: 0,
                            }}
                          >
                            {isKept ? <CheckSquare size={14} /> : <Square size={14} />}
                            <span>{isKept ? 'Keep' : 'Mark'}</span>
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Action Toolbar */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  paddingTop: '18px',
                  borderTop: '1px solid var(--border-subtle)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <button
                    className="btn btn-ghost"
                    onClick={() => setCurrentClusterIdx((v) => Math.min(clusters.length - 1, v + 1))}
                    style={{ fontSize: '0.88rem', padding: '10px 16px', height: '40px' }}
                  >
                    Skip this Group
                  </button>
                  <span style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>
                    Keeping <strong>{activeKeptSet.size}</strong> of {activeCluster.photos.length} photo(s)
                  </span>
                </div>

                <button
                  className="btn btn-primary"
                  onClick={handleDeleteRemaining}
                  disabled={isDeleting || activeUnkeptCount === 0}
                  style={{
                    backgroundColor: activeUnkeptCount > 0 ? 'var(--accent-rose)' : 'var(--bg-surface-elevated)',
                    color: activeUnkeptCount > 0 ? 'white' : 'var(--text-muted)',
                    fontSize: '0.9rem',
                    gap: '10px',
                    padding: '12px 24px',
                    height: '42px',
                    boxShadow: activeUnkeptCount > 0 ? '0 4px 14px rgba(244, 63, 94, 0.4)' : 'none',
                    cursor: activeUnkeptCount > 0 ? 'pointer' : 'default',
                  }}
                >
                  <Trash2 size={18} />
                  <span>
                    {isDeleting
                      ? 'Moving to Recycle Bin...'
                      : activeUnkeptCount > 0
                      ? `Delete ${activeUnkeptCount} Unselected Photo(s) (Keep ${activeKeptSet.size})`
                      : 'All Photos Kept (0 to Delete)'}
                  </span>
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {/* Fullscreen Photo Lightbox Modal */}
      {fullscreenPhoto && activeCluster && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(2, 6, 23, 0.96)',
            backdropFilter: 'blur(16px)',
            zIndex: 4500,
            display: 'flex',
            flexDirection: 'column',
          }}
          onClick={() => setFullscreenPhoto(null)}
        >
          {/* Lightbox Header */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '16px 24px',
              backgroundColor: 'rgba(15, 23, 42, 0.8)',
              borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
              <div style={{ fontSize: '1.05rem', fontWeight: 700, color: 'white' }}>
                {fullscreenPhoto.fileName}
              </div>
              {activeCluster.bestPhotoId === fullscreenPhoto.id && (
                <span
                  style={{
                    backgroundColor: 'rgba(234, 179, 8, 0.9)',
                    color: 'black',
                    fontSize: '0.75rem',
                    fontWeight: 700,
                    padding: '2px 8px',
                    borderRadius: 'var(--radius-full)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px',
                  }}
                >
                  <Sparkles size={12} />
                  <span>AI Best Shot</span>
                </span>
              )}
              <span style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>
                {(fullscreenPhoto.fileSize / (1024 * 1024)).toFixed(2)} MB • {fullscreenPhoto.width || 0}×{fullscreenPhoto.height || 0}
              </span>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              {/* Toggle Keep inside Lightbox */}
              <button
                className={`btn ${isPhotoKept(activeCluster.id, fullscreenPhoto.id) ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => handleToggleKeep(activeCluster.id, fullscreenPhoto.id)}
                style={{
                  backgroundColor: isPhotoKept(activeCluster.id, fullscreenPhoto.id) ? 'var(--accent-emerald)' : undefined,
                  fontSize: '0.85rem',
                  gap: '8px',
                  padding: '8px 16px',
                }}
              >
                {isPhotoKept(activeCluster.id, fullscreenPhoto.id) ? (
                  <>
                    <Check size={16} strokeWidth={3} />
                    <span>Selected to KEEP</span>
                  </>
                ) : (
                  <>
                    <Trash2 size={16} />
                    <span>Marked for REMOVAL (Click to Keep)</span>
                  </>
                )}
              </button>

              <button
                className="btn btn-ghost btn-icon"
                onClick={() => setFullscreenPhoto(null)}
                style={{ color: 'white', width: '38px', height: '38px' }}
                title="Close Fullscreen (Esc)"
              >
                <X size={24} />
              </button>
            </div>
          </div>

          {/* Lightbox Main Image & Nav */}
          <div
            style={{
              flex: 1,
              position: 'relative',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '20px',
              overflow: 'hidden',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Prev Photo Arrow */}
            {activeCluster.photos.length > 1 && (
              <button
                className="btn btn-secondary btn-icon"
                onClick={() => {
                  const idx = activeCluster.photos.findIndex((p) => p.id === fullscreenPhoto.id);
                  if (idx > 0) setFullscreenPhoto(activeCluster.photos[idx - 1]);
                }}
                disabled={activeCluster.photos.findIndex((p) => p.id === fullscreenPhoto.id) === 0}
                style={{
                  position: 'absolute',
                  left: '24px',
                  zIndex: 10,
                  width: '48px',
                  height: '48px',
                  borderRadius: 'var(--radius-full)',
                  backgroundColor: 'rgba(15, 23, 42, 0.8)',
                  color: 'white',
                }}
                title="Previous Photo in Group (Left Arrow)"
              >
                <ChevronLeft size={28} />
              </button>
            )}

            {/* High-Resolution Photo */}
            <img
              src={getLocalPhotoUrl(fullscreenPhoto.filePath, fullscreenPhoto.originalRemotePath, true)}
              alt={fullscreenPhoto.fileName}
              style={{
                maxWidth: '100%',
                maxHeight: '100%',
                objectFit: 'contain',
                borderRadius: 'var(--radius-md)',
                boxShadow: '0 20px 50px rgba(0,0,0,0.8)',
              }}
            />

            {/* Next Photo Arrow */}
            {activeCluster.photos.length > 1 && (
              <button
                className="btn btn-secondary btn-icon"
                onClick={() => {
                  const idx = activeCluster.photos.findIndex((p) => p.id === fullscreenPhoto.id);
                  if (idx !== -1 && idx < activeCluster.photos.length - 1) {
                    setFullscreenPhoto(activeCluster.photos[idx + 1]);
                  }
                }}
                disabled={activeCluster.photos.findIndex((p) => p.id === fullscreenPhoto.id) === activeCluster.photos.length - 1}
                style={{
                  position: 'absolute',
                  right: '24px',
                  zIndex: 10,
                  width: '48px',
                  height: '48px',
                  borderRadius: 'var(--radius-full)',
                  backgroundColor: 'rgba(15, 23, 42, 0.8)',
                  color: 'white',
                }}
                title="Next Photo in Group (Right Arrow)"
              >
                <ChevronRight size={28} />
              </button>
            )}
          </div>

          {/* Lightbox Footer: Score Breakdown & Thumbnails strip */}
          <div
            style={{
              padding: '12px 24px',
              backgroundColor: 'rgba(15, 23, 42, 0.85)',
              borderTop: '1px solid rgba(255, 255, 255, 0.1)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Cluster thumbnails for quick clicking */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', overflowX: 'auto' }}>
              {activeCluster.photos.map((p, pIdx) => {
                const isCurrent = p.id === fullscreenPhoto.id;
                const isKept = isPhotoKept(activeCluster.id, p.id);
                return (
                  <div
                    key={p.id}
                    onClick={() => setFullscreenPhoto(p)}
                    style={{
                      width: '52px',
                      height: '52px',
                      borderRadius: 'var(--radius-sm)',
                      overflow: 'hidden',
                      cursor: 'pointer',
                      border: isCurrent
                        ? '3px solid var(--accent-cyan)'
                        : isKept
                        ? '2px solid var(--accent-emerald)'
                        : '1px solid rgba(255,255,255,0.2)',
                      opacity: isCurrent ? 1 : 0.65,
                      position: 'relative',
                    }}
                    title={`Shot #${pIdx + 1}: ${p.fileName}`}
                  >
                    <img
                      src={getLocalPhotoUrl(p.filePath, p.originalRemotePath)}
                      alt={p.fileName}
                      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                    />
                    {isKept && (
                      <div
                        style={{
                          position: 'absolute',
                          top: '2px',
                          right: '2px',
                          backgroundColor: 'var(--accent-emerald)',
                          borderRadius: 'var(--radius-full)',
                          width: '14px',
                          height: '14px',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          color: 'white',
                        }}
                      >
                        <Check size={10} strokeWidth={3} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Quality breakdown info */}
            {activeCluster.scores[fullscreenPhoto.id] && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '16px', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                <span>Sharpness: <strong style={{ color: 'white' }}>{activeCluster.scores[fullscreenPhoto.id].sharpnessScore}/40</strong></span>
                <span>Expression: <strong style={{ color: 'white' }}>{activeCluster.scores[fullscreenPhoto.id].expressionScore}/25</strong></span>
                <span>Eyes Open: <strong style={{ color: 'white' }}>{activeCluster.scores[fullscreenPhoto.id].eyeOpenScore}/10</strong></span>
                <span>Total Score: <strong style={{ color: 'var(--accent-cyan)' }}>{activeCluster.scores[fullscreenPhoto.id].totalScore}/100</strong></span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
