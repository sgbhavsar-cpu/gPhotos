import React, { useState, useEffect } from 'react';
import { Sidebar, ActiveTab } from './components/Sidebar';
import { GalleryView } from './views/GalleryView';
import { AlbumsView } from './views/AlbumsView';
import { PeopleView } from './views/PeopleView';
import { PlacesMapView } from './views/PlacesMapView';
import { OrganizerView } from './views/OrganizerView';
import { VirtualStorageView } from './views/VirtualStorageView';
import { FolderTreeView } from './views/FolderTreeView';
import { PhotoLightbox } from './components/PhotoLightbox';
import { DuplicateCleanerModal } from './components/DuplicateCleanerModal';
import { HelpModal } from './components/HelpModal';
import { AiAssistantModal } from './components/AiAssistantModal';
import { LibrarySwitcherModal } from './components/LibrarySwitcherModal';
import { SettingsView } from './views/SettingsView';
import { MobileTopBar } from './components/MobileTopBar';
import { MobileBottomNav } from './components/MobileBottomNav';
import { MobileMenuDrawer } from './components/MobileMenuDrawer';
import { libraryStore, LibraryState, getLocalPhotoUrl } from './services/libraryStore';
import { detectFacesInImage, loadFaceModels } from './services/faceEngine';
import { faceQueue } from './services/faceQueue';
import { Photo, DetectedFace, VirtualStorageConfig, BackgroundScanProgress, NetworkStorageProgress } from '../types';
import { AiPhotoFilter } from './services/aiSearchService';
import { RefreshCw, CheckCircle2, X } from 'lucide-react';
import { ResponseActivityIndicator } from './components/ResponseActivityIndicator';
import { responseTracker } from './services/responseTracker';

export const App: React.FC = () => {
  const [libraryState, setLibraryState] = useState<LibraryState>(libraryStore.getState());
  const [activeTab, setActiveTab] = useState<ActiveTab>('photos');
  const [activeLightboxPhoto, setActiveLightboxPhoto] = useState<Photo | null>(null);
  const [selectedPersonIdForView, setSelectedPersonIdForView] = useState<string | null>(null);
  const [virtualStorages, setVirtualStorages] = useState<VirtualStorageConfig[]>([]);
  const [storageProgressMap, setStorageProgressMap] = useState<Record<string, NetworkStorageProgress>>({});
  const [toastMessage, setToastMessage] = useState<{ message: string; type?: 'info' | 'success' | 'warning' } | null>(null);
  const [selectedFolderForTree, setSelectedFolderForTree] = useState<string | null>(null);
  const [showDuplicateCleaner, setShowDuplicateCleaner] = useState(false);
  const [showHelpModal, setShowHelpModal] = useState(false);
  const [showAiAssistant, setShowAiAssistant] = useState(false);
  const [showLibrarySwitcher, setShowLibrarySwitcher] = useState(false);
  const [showMobileDrawer, setShowMobileDrawer] = useState(false);
  const [isMobile, setIsMobile] = useState<boolean>(typeof window !== 'undefined' ? window.innerWidth <= 768 : false);
  const [activeAiFilter, setActiveAiFilter] = useState<AiPhotoFilter | null>(null);
  const [aiFilteredPhotos, setAiFilteredPhotos] = useState<Photo[] | null>(null);
  const [bgScanProgress, setBgScanProgress] = useState<BackgroundScanProgress | null>(null);

  const showToast = (message: string, type: 'info' | 'success' | 'warning' = 'info') => {
    setToastMessage({ message, type });
    setTimeout(() => {
      setToastMessage((cur) => (cur?.message === message ? null : cur));
    }, 4500);
  };

  // Detect mobile viewport on mount and resize
  useEffect(() => {
    const handleResize = () => {
      setIsMobile(window.innerWidth <= 768);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Subscribe to library store updates and ensure persisted data is fetched on mount
  useEffect(() => {
    responseTracker.installSafeFetchInterceptor();
    libraryStore.loadPersistedData().finally(() => {
      // Smoothly dismiss browser inline splash screen
      const splash = document.getElementById('app-splash-screen');
      if (splash) {
        splash.classList.add('loaded');
        setTimeout(() => splash.remove(), 600);
      }
      // Notify Electron main process that renderer has mounted and is interactive
      if (window.electronAPI?.sendAppReady) {
        window.electronAPI.sendAppReady();
      }
    });

    return libraryStore.subscribe(() => {
      setLibraryState({ ...libraryStore.getState() });
    });
  }, []);

  // Load configured network storages on startup and auto-discover stored mirrors
  useEffect(() => {
    const loadStorages = async () => {
      let saved: VirtualStorageConfig[] | null = null;
      if (window.electronAPI) {
        saved = await window.electronAPI.loadLibraryData('gphotos_virtual_storages_v1');
      }
      if (!saved) {
        const raw = localStorage.getItem('gphotos_virtual_storages_v1');
        if (raw) saved = JSON.parse(raw);
      }
      let unlinked: string[] = [];
      if (window.electronAPI) {
        unlinked = (await window.electronAPI.loadLibraryData('gphotos_unlinked_storages_v1')) || [];
      } else {
        const raw = localStorage.getItem('gphotos_unlinked_storages_v1');
        if (raw) unlinked = JSON.parse(raw);
      }
      const unlinkedSet = new Set(unlinked.map((n) => n.toLowerCase()));

      let combined: VirtualStorageConfig[] = saved
        ? [...saved].filter((s) => !unlinkedSet.has(s.name.toLowerCase()))
        : [];

      // Immediate paint of configured storages without blocking startup
      setVirtualStorages(combined);

      // Defer unneeded background discovery and auto-mirror scanning to 3.5s after mount
      setTimeout(async () => {
        if (window.electronAPI?.discoverMirrors) {
          try {
            const discovered = await window.electronAPI.discoverMirrors();
            if (discovered && discovered.length > 0) {
              let changed = false;
              for (const disc of discovered) {
                if (unlinkedSet.has(disc.name.toLowerCase())) continue;

                const idx = combined.findIndex(
                  (s) => s.name.toLowerCase() === disc.name.toLowerCase() || s.id === disc.id
                );
                if (idx === -1) {
                  combined.push(disc);
                  changed = true;
                } else {
                  combined[idx] = {
                    ...combined[idx],
                    totalItems: disc.totalItems || combined[idx].totalItems,
                    totalSizeSaved: disc.totalSizeSaved || combined[idx].totalSizeSaved,
                    lastSynced: combined[idx].lastSynced || disc.lastSynced,
                  };
                  changed = true;
                }
              }
              if (changed) setVirtualStorages([...combined]);
            }
          } catch (err) {
            console.warn('Failed to auto-discover mirrors:', err);
          }
        }

        // If no photos currently in library but we have configured mirrors or an active mirror folder, auto-load them
        const curPhotos = libraryStore.getState().photos;
        if (curPhotos.length === 0 && combined.length > 0 && window.electronAPI?.scanVirtualMirror) {
          const curFolder = libraryStore.getState().selectedFolder;
          const target = combined.find(
            (s) => curFolder && `${s.localMirrorRoot}\\${s.name}`.toLowerCase() === curFolder.toLowerCase()
          ) || combined.find((s) => (s.totalItems || 0) > 0) || combined[0];

          if (target) {
            const mirrorPath = `${target.localMirrorRoot}\\${target.name}`;
            try {
              const mirroredPhotos = await window.electronAPI.scanVirtualMirror(mirrorPath);
              if (mirroredPhotos && mirroredPhotos.length > 0) {
                libraryStore.setPhotos(mirroredPhotos, mirrorPath);
              }
            } catch (loadErr) {
              console.warn('Failed to auto-load mirrored photos:', loadErr);
            }
          }
        }
      }, 3500);
    };
    loadStorages();
  }, []);

  // Listen for non-blocking background folder/drive scan events
  useEffect(() => {
    if (!window.electronAPI?.onBackgroundScanProgress) return;
    const unsubscribe = window.electronAPI.onBackgroundScanProgress((progress: any) => {
      setBgScanProgress(progress);
      const photosToAdd = progress.newPhotos || progress.newlyAddedPhotos;
      if (photosToAdd && photosToAdd.length > 0) {
        libraryStore.addPhotos(photosToAdd, progress.mirrorDirPath);
        faceQueue.enqueue(photosToAdd);
      }
      if (progress.storageName) {
        const pct = progress.percent || Math.round((progress.processedCount / Math.max(1, progress.totalDiscovered)) * 100);
        setStorageProgressMap((prev) => ({
          ...prev,
          [progress.storageName]: {
            storageName: progress.storageName,
            phase: progress.isComplete ? 'completed' : 'thumbnails',
            thumbnailCurrent: progress.processedCount,
            thumbnailTotal: progress.totalDiscovered,
            faceCurrent: prev[progress.storageName]?.faceCurrent || 0,
            faceTotal: prev[progress.storageName]?.faceTotal || 0,
            percent: pct,
            currentFile: progress.currentFile,
          },
        }));
      }
      if (progress.status === 'completed' || progress.isComplete) {
        setTimeout(() => {
          setBgScanProgress((p) => (p?.status === 'completed' || p?.isComplete ? null : p));
        }, 5000);
      }
    });
    return () => {
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, []);

  // Listen for granular network storage thumbnail sync progress
  useEffect(() => {
    if (!window.electronAPI?.onMirrorProgress) return;
    const unsubscribe = window.electronAPI.onMirrorProgress((progress: any) => {
      const storageName = progress.storageName || 'Network Storage';
      const pct = progress.percent ?? (progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0);
      setStorageProgressMap((prev) => ({
        ...prev,
        [storageName]: {
          storageName,
          phase: (progress.phase as any) || (progress.status === 'completed' ? 'completed' : 'thumbnails'),
          thumbnailCurrent: progress.current,
          thumbnailTotal: progress.total,
          faceCurrent: prev[storageName]?.faceCurrent || 0,
          faceTotal: prev[storageName]?.faceTotal || 0,
          percent: pct,
          currentFile: progress.currentFile,
        },
      }));

      if (progress.status === 'completed' && progress.phase === 'completed') {
        setTimeout(() => {
          setStorageProgressMap((prev) => {
            const cur = prev[storageName];
            if (cur && cur.phase === 'completed') {
              const copy = { ...prev };
              delete copy[storageName];
              return copy;
            }
            return prev;
          });
        }, 4000);
      }
    });
    return () => {
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, []);

  // Load any previously saved/interrupted storage checkpoints and library statuses
  useEffect(() => {
    if (window.electronAPI?.getStorageCheckpoints) {
      window.electronAPI.getStorageCheckpoints().then((checkpoints) => {
        if (!checkpoints || typeof checkpoints !== 'object') return;
        setStorageProgressMap((prev) => {
          const next = { ...prev };
          for (const [storageName, cp] of Object.entries(checkpoints)) {
            if (cp && cp.phase !== 'completed' && cp.processedCount > 0) {
              next[storageName] = {
                storageName,
                phase: 'interrupted',
                thumbnailCurrent: cp.processedCount,
                thumbnailTotal: cp.totalDiscovered,
                faceCurrent: 0,
                faceTotal: 0,
                percent: cp.percent,
                currentFile: cp.lastProcessedFile ? `Saved checkpoint: ${cp.lastProcessedFile}` : undefined,
                message: `Interrupted at ${cp.percent}% (${cp.processedCount}/${cp.totalDiscovered}). Ready to resume from photo ${cp.lastProcessedIndex + 1}.`,
                canResume: true,
              };
            }
          }
          return next;
        });
      }).catch(() => {});
    }

    if (window.electronAPI?.getAllLibraryStatuses) {
      window.electronAPI.getAllLibraryStatuses().then((statuses) => {
        if (!statuses || typeof statuses !== 'object') return;
        setStorageProgressMap((prev) => {
          const next = { ...prev };
          for (const [_key, st] of Object.entries(statuses)) {
            if (st && st.totalPhotos > 0 && (st.thumbnailCachedCount > 0 || st.faceScannedCount > 0)) {
              const name = st.libraryName || 'Library';
              const isCompleted = st.thumbnailCompleted && st.faceCompleted;
              const phase = isCompleted ? 'completed' : 'interrupted';
              if (!next[name] || next[name].phase === 'idle' || next[name].phase === 'interrupted') {
                next[name] = {
                  storageName: name,
                  phase,
                  thumbnailCurrent: st.thumbnailCachedCount,
                  thumbnailTotal: st.thumbnailTotalCount || st.totalPhotos,
                  faceCurrent: st.faceScannedCount,
                  faceTotal: st.faceTotalCount || st.totalPhotos,
                  percent: Math.min(100, Math.round(((st.thumbnailCachedCount + st.faceScannedCount) / Math.max(1, st.totalPhotos * 2)) * 100)),
                  currentFile: st.thumbnailLastFile || st.faceLastFile,
                  message: isCompleted
                    ? '✓ 100% Caching & Face Scan Complete'
                    : `Cached: ${st.thumbnailCachedCount}/${st.totalPhotos} • Faces: ${st.faceScannedCount}/${st.totalPhotos}. Ready to resume.`,
                  canResume: !isCompleted,
                };
              }
            }
          }
          return next;
        });
      }).catch(() => {});
    }
  }, []);

  // Run AI face detection helper for any given batch of photos
  // Run AI face detection helper for any given batch of photos
  const runFaceDetectionForPhotos = async (
    photosToScan: Photo[],
    isManualTrigger = false,
    storageName?: string
  ) => {
    if (photosToScan.length === 0) {
      if (isManualTrigger) showToast('No photos in library to scan.', 'info');
      return;
    }

    // Skip photos that already have face scan completed or already have faces identified
    const candidates = photosToScan.filter((p) => {
      if (p.faceScanCompleted) return false;
      if (p.faces && p.faces.length > 0) return false;
      return true;
    });

    const totalPhotos = photosToScan.length;
    const alreadyScannedCount = totalPhotos - candidates.length;
    const initialPct = totalPhotos > 0 ? Math.round((alreadyScannedCount / totalPhotos) * 100) : 0;
    const libraryPath = storageName || libraryStore.getState().selectedFolder || libraryStore.getState().currentDirectory || 'library';

    if (candidates.length === 0) {
      if (isManualTrigger) {
        showToast('All photos in this library have already been scanned for faces.', 'info');
      }
      if (window.electronAPI?.saveLibraryStatus) {
        window.electronAPI.saveLibraryStatus({
          libraryPath,
          totalPhotos,
          faceScannedCount: totalPhotos,
          faceTotalCount: totalPhotos,
          faceCompleted: true,
          facePercent: 100,
          phase: 'completed',
        }).catch(() => {});
      }
      return;
    }

    libraryStore.setDetectingFaces(true, {
      current: alreadyScannedCount,
      total: totalPhotos,
      currentPhotoName: 'Loading AI face models...',
    });

    if (storageName) {
      setStorageProgressMap((prev) => ({
        ...prev,
        [storageName]: {
          storageName,
          phase: 'faces',
          thumbnailCurrent: prev[storageName]?.thumbnailTotal || totalPhotos,
          thumbnailTotal: prev[storageName]?.thumbnailTotal || totalPhotos,
          faceCurrent: alreadyScannedCount,
          faceTotal: totalPhotos,
          percent: initialPct,
          message: alreadyScannedCount > 0
            ? `Resuming faces: ${alreadyScannedCount}/${totalPhotos} (${initialPct}%)`
            : `Recognizing faces: 0/${totalPhotos}`,
        },
      }));
    }

    const loaded = await loadFaceModels();
    if (!loaded) {
      console.warn('Face models could not be loaded.');
      if (isManualTrigger) {
        showToast('Failed to load Face-API neural network models. Make sure model weights are present.', 'warning');
      }
      libraryStore.setDetectingFaces(false, null);
      return;
    }

    const allNewFaces: DetectedFace[] = [];

    try {
      for (let i = 0; i < candidates.length; i++) {
        const photo = candidates[i];
        const currentScanned = alreadyScannedCount + i + 1;
        const facePct = Math.round((currentScanned / Math.max(1, totalPhotos)) * 100);

        libraryStore.setDetectingFaces(true, {
          current: currentScanned,
          total: totalPhotos,
          currentPhotoName: photo.fileName,
        });

        if (storageName) {
          setStorageProgressMap((prev) => ({
            ...prev,
            [storageName]: {
              ...prev[storageName],
              storageName,
              phase: 'faces',
              faceCurrent: currentScanned,
              faceTotal: totalPhotos,
              percent: facePct,
              currentFile: photo.fileName,
              message: `Recognizing faces: ${currentScanned}/${totalPhotos} (${facePct}%)`,
            },
          }));
        }

        try {
          let preferOriginal = false;
          if (photo.isVirtual && photo.originalRemotePath && window.electronAPI?.checkFileExists) {
            preferOriginal = await window.electronAPI.checkFileExists(photo.originalRemotePath);
          }

          const detectedFaces = await detectFacesInImage(
            photo.filePath,
            photo.id,
            photo.originalRemotePath,
            preferOriginal
          );
          photo.faces = detectedFaces;
          photo.faceScanCompleted = true;
          libraryStore.updatePhotoQuietly(photo);

          if (detectedFaces.length > 0) {
            allNewFaces.push(...detectedFaces);
          }
        } catch (err) {
          console.warn(`Face detection skipped for ${photo.fileName}:`, err);
          photo.faceScanCompleted = true;
          libraryStore.updatePhotoQuietly(photo);
        }

        // Intermittent persistence: save library photos and faces to disk every 8 photos so stopping never loses progress!
        if ((i + 1) % 8 === 0 || i === candidates.length - 1) {
          libraryStore.notifyListeners();
          await libraryStore.persistNow();
          if (window.electronAPI?.saveLibraryStatus) {
            await window.electronAPI.saveLibraryStatus({
              libraryPath,
              totalPhotos,
              faceScannedCount: currentScanned,
              faceTotalCount: totalPhotos,
              faceDetectedCount: allNewFaces.length,
              faceLastIndex: currentScanned - 1,
              faceLastFile: photo.fileName,
              faceCompleted: i === candidates.length - 1,
              facePercent: facePct,
              phase: i === candidates.length - 1 ? 'completed' : 'faces',
            });
          }
        }

        // Non-blocking yield to event loop for smooth background execution and 60fps UI
        await new Promise((r) => setTimeout(r, 20));
      }

      if (allNewFaces.length > 0) {
        libraryStore.updateFacesAndPeople(allNewFaces);
        if (isManualTrigger) {
          showToast(`Face recognition complete! Detected ${allNewFaces.length} new face instances.`, 'success');
        }
      } else if (isManualTrigger) {
        showToast('Face recognition finished. No faces detected.', 'info');
      }

      if (storageName) {
        setStorageProgressMap((prev) => ({
          ...prev,
          [storageName]: {
            ...prev[storageName],
            storageName,
            phase: 'completed',
            faceCurrent: totalPhotos,
            faceTotal: totalPhotos,
            percent: 100,
            message: '✓ Up to date',
          },
        }));
        setTimeout(() => {
          setStorageProgressMap((prev) => {
            const cur = prev[storageName];
            if (cur && cur.phase === 'completed') {
              const copy = { ...prev };
              delete copy[storageName];
              return copy;
            }
            return prev;
          });
        }, 4000);
      }
    } finally {
      libraryStore.setDetectingFaces(false, null);
    }
  };

  const handleOpenFolder = async () => {
    responseTracker.clearAll();
    if (!window.electronAPI) {
      showToast('Native folder selection is available in the Electron desktop app.', 'warning');
      return;
    }

    const dir = await window.electronAPI.selectDirectory();
    if (!dir) return;

    libraryStore.setScanning(true);
    try {
      const switched = await libraryStore.switchLibrary(dir);
      if (switched) {
        setActiveTab('photos');
        showToast(`Opened library: ${dir}`, 'success');
        return;
      }

      const photos = await window.electronAPI.scanDirectory(dir);
      libraryStore.setPhotos(photos, dir);
      setActiveTab('photos');

      // Unified single-pass: automatically run face detection on newly scanned photos
      await runFaceDetectionForPhotos(photos, false);
    } catch (err: any) {
      showToast(`Error opening folder: ${err.message}`, 'warning');
    } finally {
      libraryStore.setScanning(false);
    }
  };

  const handleSelectLibrary = async (dirPath: string) => {
    responseTracker.clearAll();
    libraryStore.setScanning(true);
    try {
      const switched = await libraryStore.switchLibrary(dirPath);
      if (switched) {
        setActiveTab('photos');
        showToast(`Switched library: ${dirPath}`, 'success');
        return;
      }

      if (window.electronAPI) {
        const photos = await window.electronAPI.scanDirectory(dirPath);
        libraryStore.setPhotos(photos, dirPath);
        setActiveTab('photos');
        await runFaceDetectionForPhotos(photos, false);
      }
    } catch (err: any) {
      showToast(`Failed to load selected library: ${err.message}`, 'warning');
    } finally {
      libraryStore.setScanning(false);
    }
  };

  // Run AI face detection manually across all indexed photos
  const handleTriggerFaceDetection = async () => {
    await runFaceDetectionForPhotos(libraryState.photos, true);
  };

  // Reset all people and faces from scratch and restart fresh face detection on all photos
  const handleResetAndRescan = async () => {
    faceQueue.clear();
    libraryStore.resetAllPeopleAndFaces();
    const freshPhotos = libraryStore.getState().photos;
    await runFaceDetectionForPhotos(freshPhotos, true);
  };

  const handleToggleFavorite = (photoId: string) => {
    libraryStore.toggleFavorite(photoId);
  };

  const handleUpdatePersonName = (personId: string, newName: string) => {
    libraryStore.updatePersonName(personId, newName);
  };

  const handleMergePeople = (targetPersonId: string, sourcePersonId: string) => {
    libraryStore.mergePeople(targetPersonId, sourcePersonId);
  };

  const handleNavigateToPerson = (personId: string) => {
    setActiveLightboxPhoto(null);
    setSelectedPersonIdForView(personId);
    setActiveTab('people');
  };

  const handleOrganizeComplete = async (targetDir: string) => {
    // Automatically re-scan the organized target folder
    if (window.electronAPI) {
      libraryStore.setScanning(true);
      const organizedPhotos = await window.electronAPI.scanDirectory(targetDir);
      libraryStore.setPhotos(organizedPhotos, targetDir);
      libraryStore.setScanning(false);
      setActiveTab('photos');
    }
  };

  const handleLoadMirroredPhotos = async (mirrorRootPath: string) => {
    if (window.electronAPI) {
      libraryStore.setScanning(true);
      const mirroredPhotos = await window.electronAPI.scanVirtualMirror(mirrorRootPath);
      libraryStore.setPhotos(mirroredPhotos, mirrorRootPath);
      libraryStore.setScanning(false);
      setActiveTab('photos');

      // Auto-run face detection on the local 500px thumbnails
      await runFaceDetectionForPhotos(mirroredPhotos, false);
    }
  };

  const handleSelectVirtualStorage = async (config: VirtualStorageConfig) => {
    responseTracker.clearAll();
    const mirrorLocalPath = `${config.localMirrorRoot}\\${config.name}`;
    await handleLoadMirroredPhotos(mirrorLocalPath);
  };

  const handleRefreshNetworkStorage = async (targetConfig?: VirtualStorageConfig) => {
    if (!window.electronAPI) return;

    let config = targetConfig;
    if (!config) {
      const activeFolder = libraryState.selectedFolder || libraryState.currentDirectory;
      const firstVirtual = libraryState.photos.find((p) => p.isVirtual);
      config =
        virtualStorages.find(
          (s) =>
            (activeFolder && `${s.localMirrorRoot}\\${s.name}`.toLowerCase() === activeFolder.toLowerCase()) ||
            s.name === firstVirtual?.storageName
        ) || virtualStorages[0];
    }

    if (!config) {
      showToast('No network mirrors configured yet. Go to Network Mirrors tab to connect a remote or cloud folder.', 'warning');
      return;
    }

    // Set live initial progress in network storage list
    setStorageProgressMap((prev) => ({
      ...prev,
      [config!.name]: {
        storageName: config!.name,
        phase: 'scanning',
        thumbnailCurrent: 0,
        thumbnailTotal: 0,
        faceCurrent: 0,
        faceTotal: 0,
        percent: 0,
        message: 'Scanning remote directory...',
      },
    }));

    try {
      // 1. Sync any new photos from remote source, generate 500px local thumbnails & EXIF metadata sidecars
      const res = await window.electronAPI.syncVirtualStorage(config);
      const mirrorLocalPath = `${config.localMirrorRoot}\\${config.name}`;
      const updatedPhotos = await window.electronAPI.scanVirtualMirror(mirrorLocalPath);

      // 2. Update library photos (preserves recognized faces and favorites)
      libraryStore.setPhotos(updatedPhotos, mirrorLocalPath);

      // 3. Update storage metadata and persist
      const updatedList = virtualStorages.map((s) =>
        s.id === config!.id
          ? {
              ...s,
              lastSynced: new Date().toISOString(),
              totalItems: res.totalSynced,
              totalSizeSaved: res.totalSizeSaved,
              newlyAdded: res.newlyAdded,
            }
          : s
      );
      setVirtualStorages(updatedList);
      await window.electronAPI.saveLibraryData('gphotos_virtual_storages_v1', updatedList);

      // 4. Automatically recognize faces on any newly added photos or unscanned photos
      const photosNeedingFaces = updatedPhotos.filter((p) => !p.faces || p.faces.length === 0);
      if (res.newlyAdded > 0 || photosNeedingFaces.length > 0) {
        showToast(`Mirrored ${res.newlyAdded} new photos from ${config.name}. Starting face recognition...`, 'info');
        await runFaceDetectionForPhotos(updatedPhotos, false, config.name);
      } else {
        setStorageProgressMap((prev) => ({
          ...prev,
          [config!.name]: {
            storageName: config!.name,
            phase: 'completed',
            thumbnailCurrent: res.totalSynced,
            thumbnailTotal: res.totalSynced,
            faceCurrent: 0,
            faceTotal: 0,
            percent: 100,
            message: '✓ Up to date',
          },
        }));
        showToast(`Rescan Complete: ${config.name} is up-to-date (${res.totalSynced} photos).`, 'success');
        setTimeout(() => {
          setStorageProgressMap((prev) => {
            const copy = { ...prev };
            delete copy[config!.name];
            return copy;
          });
        }, 4000);
      }
    } catch (err: any) {
      setStorageProgressMap((prev) => ({
        ...prev,
        [config!.name]: {
          storageName: config!.name,
          phase: 'error',
          thumbnailCurrent: 0,
          thumbnailTotal: 0,
          faceCurrent: 0,
          faceTotal: 0,
          percent: 0,
          error: err.message,
        },
      }));
      showToast(`Error refreshing network storage: ${err.message}`, 'warning');
    }
  };

  const [tabResetTrigger, setTabResetTrigger] = useState<number>(0);

  const handleSelectTab = (tab: ActiveTab) => {
    responseTracker.clearAll();
    setSelectedPersonIdForView(null);
    setSelectedFolderForTree(null);
    setTabResetTrigger(Date.now());
    setActiveTab(tab);
  };

  return (
    <div
      className="app-container"
      style={{
        flexDirection: isMobile ? 'column' : 'row',
      }}
    >
      {/* Top Bar for Mobile */}
      {isMobile ? (
        <MobileTopBar
          selectedFolder={libraryState.selectedFolder}
          onOpenLibrarySwitcher={() => setShowLibrarySwitcher(true)}
          onOpenAiAssistant={() => setShowAiAssistant(true)}
          onOpenDuplicateCleaner={() => setShowDuplicateCleaner(true)}
          onToggleDrawer={() => setShowMobileDrawer(true)}
        />
      ) : (
        /* Sidebar Navigation for Desktop */
        <Sidebar
          activeTab={activeTab}
          onSelectTab={handleSelectTab}
          state={libraryState}
          onOpenFolder={handleOpenFolder}
          onTriggerFaceDetection={handleTriggerFaceDetection}
          virtualStorages={virtualStorages}
          storageProgressMap={storageProgressMap}
          onSelectStorage={handleSelectVirtualStorage}
          onRefreshStorage={handleRefreshNetworkStorage}
          onOpenDuplicateCleaner={() => setShowDuplicateCleaner(true)}
          onOpenHelp={() => setShowHelpModal(true)}
          onOpenAiAssistant={() => setShowAiAssistant(true)}
          onOpenLibrarySwitcher={() => setShowLibrarySwitcher(true)}
        />
      )}

      {/* Main View Area */}
      <main
        style={{
          flex: 1,
          height: isMobile ? 'calc(100% - 56px)' : '100%',
          overflow: 'hidden',
          position: 'relative',
          paddingBottom: isMobile ? '64px' : '0',
        }}
      >
        {activeTab === 'photos' && (
          <GalleryView
            photos={aiFilteredPhotos || libraryState.photos}
            onSelectPhoto={(p) => setActiveLightboxPhoto(p)}
            onToggleFavorite={handleToggleFavorite}
            onOpenFolder={handleOpenFolder}
            onRefreshNetwork={() => handleRefreshNetworkStorage()}
            virtualStorages={virtualStorages}
            onSelectStorage={handleSelectVirtualStorage}
            onOpenDuplicateCleaner={() => setShowDuplicateCleaner(true)}
            onOpenHelp={() => setShowHelpModal(true)}
            onOpenAiSearch={() => setShowAiAssistant(true)}
            activeAiFilter={activeAiFilter}
            onClearAiFilter={() => {
              setActiveAiFilter(null);
              setAiFilteredPhotos(null);
            }}
            resetTrigger={tabResetTrigger}
          />
        )}

        {activeTab === 'favorites' && (
          <GalleryView
            photos={libraryState.photos}
            onSelectPhoto={(p) => setActiveLightboxPhoto(p)}
            onToggleFavorite={handleToggleFavorite}
            onOpenFolder={handleOpenFolder}
            onRefreshNetwork={() => handleRefreshNetworkStorage()}
            filterFavorite={true}
            virtualStorages={virtualStorages}
            onSelectStorage={handleSelectVirtualStorage}
            onOpenDuplicateCleaner={() => setShowDuplicateCleaner(true)}
            onOpenHelp={() => setShowHelpModal(true)}
            resetTrigger={tabResetTrigger}
          />
        )}

        {activeTab === 'albums' && (
          <AlbumsView
            photos={libraryState.photos}
            albums={libraryState.albums || []}
            onSelectPhoto={(p) => setActiveLightboxPhoto(p)}
            resetTrigger={tabResetTrigger}
          />
        )}

        {activeTab === 'people' && (
          <PeopleView
            people={libraryState.people}
            photos={libraryState.photos}
            onUpdatePersonName={handleUpdatePersonName}
            onMergePeople={handleMergePeople}
            onSelectPhoto={(p) => setActiveLightboxPhoto(p)}
            onToggleFavorite={handleToggleFavorite}
            onTriggerFaceDetection={handleTriggerFaceDetection}
            onResetAndRescan={handleResetAndRescan}
            isDetectingFaces={libraryState.isDetectingFaces}
            initialSelectedPersonId={selectedPersonIdForView}
            onClearSelectedPerson={() => setSelectedPersonIdForView(null)}
            resetTrigger={tabResetTrigger}
          />
        )}

        {activeTab === 'places' && (
          <PlacesMapView
            photos={libraryState.photos}
            places={libraryState.places}
            onSelectPhoto={(p) => setActiveLightboxPhoto(p)}
            onToggleFavorite={handleToggleFavorite}
            resetTrigger={tabResetTrigger}
          />
        )}

        {activeTab === 'folders' && (
          <FolderTreeView
            onSelectPhoto={(p) => setActiveLightboxPhoto(p)}
            storages={virtualStorages}
            initialFolderPath={selectedFolderForTree}
            resetTrigger={tabResetTrigger}
            onStartBackgroundScan={(path, name) => {
              if (window.electronAPI?.startBackgroundScan) {
                window.electronAPI.startBackgroundScan({
                  sourcePath: path,
                  storageName: name || path.split(/[/\\]/).filter(Boolean).pop() || 'Folder',
                  mirrorDir: 'C:\\GPhotos_VirtualMirrors'
                });
              }
            }}
            onPhotosDiscovered={(newPhotos) => {
              libraryStore.addPhotos(newPhotos);
              faceQueue.enqueue(newPhotos);
            }}
          />
        )}

        {activeTab === 'virtual_storage' && (
          <VirtualStorageView
            onLoadMirroredPhotos={handleLoadMirroredPhotos}
            onStoragesUpdated={(storages) => setVirtualStorages(storages)}
            storageProgressMap={storageProgressMap}
            onBrowseFolderTree={(folderPath) => {
              setSelectedFolderForTree(folderPath);
              setActiveTab('folders');
            }}
          />
        )}

        {activeTab === 'organize' && (
          <OrganizerView onOrganizeComplete={handleOrganizeComplete} />
        )}

        {activeTab === 'settings' && (
          <SettingsView
            onOpenHelp={() => setShowHelpModal(true)}
            onOpenDuplicateCleaner={() => setShowDuplicateCleaner(true)}
          />
        )}
      </main>

      {/* Fullscreen Photo Lightbox */}
      {activeLightboxPhoto && (
        <PhotoLightbox
          photo={libraryState.photos.find((p) => p.id === activeLightboxPhoto.id) || activeLightboxPhoto}
          allPhotos={libraryState.photos}
          people={libraryState.people}
          onClose={() => setActiveLightboxPhoto(null)}
          onSelectPhoto={(p) => setActiveLightboxPhoto(p)}
          onToggleFavorite={handleToggleFavorite}
          onNavigateToPerson={handleNavigateToPerson}
        />
      )}

      {/* Duplicate & Burst Cleaner Modal */}
      {showDuplicateCleaner && (
        <DuplicateCleanerModal
          photos={libraryState.photos}
          onClose={() => setShowDuplicateCleaner(false)}
        />
      )}

      {/* Interactive HTML Help & Feature Guide Modal */}
      {showHelpModal && (
        <HelpModal onClose={() => setShowHelpModal(false)} />
      )}

      {/* Floating Background Scan Status Dock */}
      {bgScanProgress && (
        <div
          style={{
            position: 'fixed',
            bottom: '24px',
            right: '24px',
            zIndex: 900,
            backgroundColor: 'rgba(15, 23, 42, 0.95)',
            border: `1px solid ${bgScanProgress.status === 'completed' ? 'rgba(16, 185, 129, 0.6)' : 'var(--accent-cyan)'}`,
            borderRadius: 'var(--radius-lg)',
            padding: '12px 18px',
            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.7)',
            backdropFilter: 'blur(16px)',
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            maxWidth: '380px',
            minWidth: '280px',
            animation: 'fadeIn 0.2s ease-out',
          }}
        >
          <div style={{
            width: '32px',
            height: '32px',
            borderRadius: '50%',
            backgroundColor: bgScanProgress.status === 'completed' ? 'rgba(16, 185, 129, 0.2)' : 'rgba(6, 182, 212, 0.2)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}>
            {bgScanProgress.status === 'completed' ? (
              <CheckCircle2 size={18} color="#10b981" />
            ) : (
              <RefreshCw size={16} color="var(--accent-cyan)" className="animate-spin" />
            )}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-primary)', display: 'flex', justifyContent: 'space-between' }}>
              <span>{bgScanProgress.status === 'completed' ? 'Scan Completed' : 'Background Scanning...'}</span>
              <span style={{ fontSize: '0.75rem', color: 'var(--accent-cyan)' }}>
                {bgScanProgress.totalPhotosFound} photos
              </span>
            </div>
            <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: '2px' }}>
              {bgScanProgress.currentFolder || bgScanProgress.sourcePath}
            </div>
          </div>
          <button
            className="btn btn-ghost btn-icon"
            onClick={() => setBgScanProgress(null)}
            style={{ width: '24px', height: '24px', padding: 0 }}
          >
            <X size={14} />
          </button>
        </div>
      )}

      {/* Non-blocking Floating Toast Feedback Notification */}
      {toastMessage && (
        <div
          style={{
            position: 'fixed',
            top: '20px',
            right: '24px',
            zIndex: 1000,
            backgroundColor:
              toastMessage.type === 'success'
                ? 'rgba(6, 78, 59, 0.95)'
                : toastMessage.type === 'warning'
                ? 'rgba(120, 53, 15, 0.95)'
                : 'rgba(15, 23, 42, 0.95)',
            border: `1px solid ${
              toastMessage.type === 'success'
                ? '#10b981'
                : toastMessage.type === 'warning'
                ? '#f59e0b'
                : 'var(--accent-primary)'
            }`,
            borderRadius: 'var(--radius-md)',
            padding: '10px 16px',
            boxShadow: '0 8px 30px rgba(0,0,0,0.5)',
            backdropFilter: 'blur(12px)',
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            fontSize: '0.85rem',
            color: 'white',
            maxWidth: '420px',
            animation: 'fadeIn 0.2s ease',
          }}
        >
          {toastMessage.type === 'success' ? (
            <CheckCircle2 size={18} color="#34d399" style={{ flexShrink: 0 }} />
          ) : (
            <RefreshCw size={18} color="var(--accent-primary)" style={{ flexShrink: 0 }} />
          )}
          <span style={{ flex: 1 }}>{toastMessage.message}</span>
          <button
            onClick={() => setToastMessage(null)}
            style={{
              background: 'none',
              border: 'none',
              color: 'rgba(255,255,255,0.7)',
              cursor: 'pointer',
              padding: 0,
              display: 'flex',
              alignItems: 'center',
            }}
          >
            <X size={14} />
          </button>
        </div>
      )}

      {/* AI Search Assistant Modal */}
      <AiAssistantModal
        photos={libraryState.photos}
        people={libraryState.people}
        isOpen={showAiAssistant}
        onClose={() => setShowAiAssistant(false)}
        onApplyFilter={(filter, matchedPhotos) => {
          setActiveAiFilter(filter);
          setAiFilteredPhotos(matchedPhotos);
          setActiveTab('photos');
        }}
      />

      {/* Library Switcher Modal */}
      {showLibrarySwitcher && (
        <LibrarySwitcherModal
          currentLibrary={libraryState.selectedFolder}
          recentLibraries={libraryState.recentLibraries || []}
          virtualStorages={virtualStorages}
          onSelectLibrary={handleSelectLibrary}
          onBrowseNewLibrary={handleOpenFolder}
          onSelectVirtualStorage={handleSelectVirtualStorage}
          onClose={() => setShowLibrarySwitcher(false)}
        />
      )}
      {/* Mobile Bottom Navigation Bar */}
      {isMobile && (
        <MobileBottomNav
          activeTab={activeTab}
          onSelectTab={handleSelectTab}
        />
      )}

      {/* Mobile Menu Drawer */}
      {isMobile && (
        <MobileMenuDrawer
          isOpen={showMobileDrawer}
          onClose={() => setShowMobileDrawer(false)}
          activeTab={activeTab}
          onSelectTab={handleSelectTab}
          state={libraryState}
          onOpenLibrarySwitcher={() => setShowLibrarySwitcher(true)}
          onOpenDuplicateCleaner={() => setShowDuplicateCleaner(true)}
          onOpenHelp={() => setShowHelpModal(true)}
          onOpenAiAssistant={() => setShowAiAssistant(true)}
        />
      )}

      {/* Global 20ms Latency Response Indicator & Wait Dialog */}
      <ResponseActivityIndicator />
    </div>
  );
};
