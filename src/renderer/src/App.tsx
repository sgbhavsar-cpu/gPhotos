import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
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
import { selectDirectoryOrPrompt } from './services/selectDirectory';
import { faceQueue } from './services/faceQueue';
import { Photo, DetectedFace, VirtualStorageConfig, BackgroundScanProgress, NetworkStorageProgress, DuplicateCluster } from '../types';
import { AiPhotoFilter } from './services/aiSearchService';
import { RefreshCw, CheckCircle2, X } from 'lucide-react';
import { ResponseActivityIndicator } from './components/ResponseActivityIndicator';
import { PrefetchStatusIndicator } from './components/PrefetchStatusIndicator';
import { responseTracker } from './services/responseTracker';
import { splitStoragesByExistence } from './services/storageValidation';
import { useIsMobile } from './hooks/useIsMobile';

export const App: React.FC = () => {
  const [libraryState, setLibraryState] = useState<LibraryState>(libraryStore.getState());
  const [activeTab, setActiveTab] = useState<ActiveTab>('photos');
  const [activeLightboxPhoto, setActiveLightboxPhoto] = useState<Photo | null>(null);
  // When the lightbox is opened from a context narrower than the whole
  // library (currently: an album), this holds that context's photo ids so
  // next/prev navigation stays inside it instead of falling through to
  // libraryState.photos. Storing ids (not Photo objects) and re-deriving the
  // list below keeps it live — a favorite toggle or removal while the
  // lightbox is open is reflected immediately, the same way the album view
  // itself stays in sync.
  const [activeLightboxContextIds, setActiveLightboxContextIds] = useState<string[] | null>(null);
  const [selectedPersonIdForView, setSelectedPersonIdForView] = useState<string | null>(null);
  const [virtualStorages, setVirtualStorages] = useState<VirtualStorageConfig[]>([]);
  const [storageProgressMap, setStorageProgressMap] = useState<Record<string, NetworkStorageProgress>>({});
  const [toastMessage, setToastMessage] = useState<{ message: string; type?: 'info' | 'success' | 'warning' } | null>(null);
  const [switchingLibraryLabel, setSwitchingLibraryLabel] = useState<string | null>(null);
  const [selectedFolderForTree, setSelectedFolderForTree] = useState<string | null>(null);
  const [showDuplicateCleaner, setShowDuplicateCleaner] = useState(false);
  const [duplicateCleanerCluster, setDuplicateCleanerCluster] = useState<DuplicateCluster | null>(null);
  const [showHelpModal, setShowHelpModal] = useState(false);
  const [showAiAssistant, setShowAiAssistant] = useState(false);
  const [showLibrarySwitcher, setShowLibrarySwitcher] = useState(false);
  const [showMobileDrawer, setShowMobileDrawer] = useState(false);
  const isMobile = useIsMobile();
  const [activeAiFilter, setActiveAiFilter] = useState<AiPhotoFilter | null>(null);
  const [aiFilteredPhotos, setAiFilteredPhotos] = useState<Photo[] | null>(null);
  const [bgScanProgress, setBgScanProgress] = useState<BackgroundScanProgress | null>(null);

  const tabHistoryRef = useRef<ActiveTab[]>(['photos']);

  useEffect(() => {
    const history = tabHistoryRef.current;
    if (history[history.length - 1] !== activeTab) {
      history.push(activeTab);
    }
  }, [activeTab]);

  // Stop background tasks immediately (called on Navigation click or Escape key press)
  const stopBackgroundTasksImmediately = useCallback(() => {
    try {
      console.log('[IdleControl] User interacted/navigated/pressed Esc: Stopping background tasks immediately');
      if (!faceQueue.getStatus().isPaused) {
        faceQueue.pause();
      }
      if (window.electronAPI?.pauseThumbnailPreCache) {
        window.electronAPI.pauseThumbnailPreCache().catch(() => {});
      }
    } catch (e) {
      console.warn('[IdleControl] Error stopping background tasks:', e);
    }
  }, []);

  // Start / resume background tasks (called when user is idle for 15s)
  const startBackgroundTasks = useCallback(async () => {
    try {
      const currentPhotos = libraryStore.getState().photos || [];
      if (currentPhotos.length === 0) return;

      console.log('[IdleControl] User idle for 15s: Auto-starting background caching and face detection...');

      // 1. Resume / start background thumbnail pre-caching
      if (window.electronAPI?.startThumbnailPreCache) {
        window.electronAPI.startThumbnailPreCache(currentPhotos).catch(() => {});
      }

      // 2. Resume / enqueue face detection queue
      const unscannedPhotos = currentPhotos.filter(
        (p) => !p.facesLocked && !p.faceScanCompleted && (!p.faces || p.faces.length === 0)
      );
      if (unscannedPhotos.length > 0) {
        faceQueue.enqueue(unscannedPhotos);
      }
      if (faceQueue.getStatus().isPaused) {
        faceQueue.resume();
      }
    } catch (e) {
      console.warn('[IdleControl] Error starting background tasks:', e);
    }
  }, []);

  // Global Escape key navigation handler
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;

      // Stop background tasks immediately when Esc key is pressed
      stopBackgroundTasksImmediately();

      // 1. Close lightbox if active
      if (activeLightboxPhoto) {
        setActiveLightboxPhoto(null);
        setActiveLightboxContextIds(null);
        return;
      }

      // 2. Close global modals
      if (showDuplicateCleaner) {
        setShowDuplicateCleaner(false);
        setDuplicateCleanerCluster(null);
        return;
      }
      if (showHelpModal) {
        setShowHelpModal(false);
        return;
      }
      if (showAiAssistant) {
        setShowAiAssistant(false);
        return;
      }
      if (showLibrarySwitcher) {
        setShowLibrarySwitcher(false);
        return;
      }
      if (showMobileDrawer) {
        setShowMobileDrawer(false);
        return;
      }

      // 3. Clear active AI search filter or tree folder selection
      if (activeAiFilter || aiFilteredPhotos) {
        setActiveAiFilter(null);
        setAiFilteredPhotos(null);
        return;
      }
      if (selectedFolderForTree) {
        setSelectedFolderForTree(null);
        return;
      }
      if (selectedPersonIdForView) {
        setSelectedPersonIdForView(null);
        return;
      }

      // 4. Pop tab navigation history back to previous tab
      if (activeTab !== 'photos') {
        const history = tabHistoryRef.current;
        while (history.length > 0 && history[history.length - 1] === activeTab) {
          history.pop();
        }
        const previousTab = history.length > 0 ? history.pop()! : 'photos';
        setActiveTab(previousTab);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    activeLightboxPhoto,
    showDuplicateCleaner,
    showHelpModal,
    showAiAssistant,
    showLibrarySwitcher,
    showMobileDrawer,
    activeAiFilter,
    aiFilteredPhotos,
    selectedFolderForTree,
    selectedPersonIdForView,
    activeTab,
    stopBackgroundTasksImmediately,
  ]);

  // 15-Second Idle Inactivity Detector & Auto-Resume Handler
  useEffect(() => {
    let idleTimer: any = null;

    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        startBackgroundTasks();
      }, 15000);
    };

    const handleUserActivity = () => {
      resetIdleTimer();
    };

    const activityEvents = ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart', 'scroll'];
    activityEvents.forEach((evt) => {
      window.addEventListener(evt, handleUserActivity, { passive: true });
    });

    // Start 15s idle timer
    resetIdleTimer();

    return () => {
      if (idleTimer) clearTimeout(idleTimer);
      activityEvents.forEach((evt) => {
        window.removeEventListener(evt, handleUserActivity);
      });
    };
  }, [startBackgroundTasks]);

  const showToast = (message: string, type: 'info' | 'success' | 'warning' = 'info') => {
    setToastMessage({ message, type });
    setTimeout(() => {
      setToastMessage((cur) => (cur?.message === message ? null : cur));
    }, 4500);
  };

  // Subscribe to library store updates and ensure persisted data is fetched on mount
  useEffect(() => {
    responseTracker.installSafeFetchInterceptor();
    libraryStore.loadPersistedData().finally(async () => {
      // The "active library" pointer (shown in the sidebar) is a path
      // remembered independently of whether that folder still exists —
      // deleting it outside the app (or a network share/drive going
      // permanently unreachable) otherwise leaves the sidebar forever
      // pointing at a folder that's gone. Verified once here, at startup,
      // since this is the one place every load path converges afterward.
      const activeFolder = libraryStore.getState().selectedFolder;
      if (activeFolder && window.electronAPI?.checkFileExists) {
        try {
          const exists = await window.electronAPI.checkFileExists(activeFolder);
          if (!exists) {
            libraryStore.clearMissingActiveLibrary();
          }
        } catch {}
      }

      // Same check for the "Recent Libraries" list in the Switch Library
      // modal — a separate remembered list from both the active-folder
      // pointer above and the configured-storages list, with the exact same
      // "never re-verified against disk" gap.
      if (window.electronAPI?.checkFileExists) {
        const recent = libraryStore.getRecentLibraries();
        if (recent.length > 0) {
          try {
            const checks = await Promise.all(
              recent.map(async (p) => ({ path: p, exists: await window.electronAPI!.checkFileExists(p).catch(() => true) }))
            );
            const stillValid = checks.filter((c) => c.exists).map((c) => c.path);
            if (stillValid.length !== recent.length) {
              libraryStore.setRecentLibraries(stillValid);
            }
          } catch {}
        }
      }

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

      // Prune entries whose local mirror folder no longer exists — this is
      // a second, independent copy of the same load VirtualStorageView.tsx
      // does (this one feeds the sidebar's "Switch Library" modal and
      // FolderTreeView, which mount before that screen ever does), so it
      // needs the same check or a folder deleted outside the app keeps
      // showing up here even after being cleaned up there.
      if (window.electronAPI?.checkFileExists && combined.length > 0) {
        const { valid, removed } = await splitStoragesByExistence(combined, window.electronAPI.checkFileExists);
        if (removed.length > 0) {
          combined = valid;
          const removedNames = removed.map((s) => s.name.toLowerCase());
          const nextUnlinked = Array.from(new Set([...unlinked, ...removedNames]));
          unlinked = nextUnlinked;
          unlinkedSet.clear();
          nextUnlinked.forEach((n) => unlinkedSet.add(n));
          if (window.electronAPI) {
            await window.electronAPI.saveLibraryData('gphotos_unlinked_storages_v1', nextUnlinked);
            await window.electronAPI.saveLibraryData('gphotos_virtual_storages_v1', combined);
          }
          for (const s of removed) {
            libraryStore.removePhotosByStorage(s.name);
          }
        }
      }

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

  // The load above only runs once, at mount — but the background sync
  // daemon (backgroundDaemon.ts, on its own ~15 min timer / 45s after
  // launch) keeps updating each storage's totalItems/lastSynced/
  // totalSizeSaved in the persisted setting the whole time the app is
  // running, entirely independent of whether this state ever re-reads it.
  // Without this, the sidebar's photo count for a storage stays frozen at
  // whatever it happened to be at app launch, even while a sync is visibly
  // progressing underneath it — exactly what looks like the count "never
  // updates". Cheap merge, not a full reload: only touches the few fields
  // the daemon actually writes, so it can't clobber in-progress UI state.
  useEffect(() => {
    const refreshStorageTotals = async () => {
      if (!window.electronAPI?.loadLibraryData) return;
      try {
        const saved: VirtualStorageConfig[] | null = await window.electronAPI.loadLibraryData('gphotos_virtual_storages_v1');
        if (!saved || saved.length === 0) return;
        const byName = new Map(saved.map((s) => [s.name.toLowerCase(), s]));
        setVirtualStorages((prev) => {
          if (prev.length === 0) return prev;
          let changed = false;
          const merged = prev.map((s) => {
            const fresh = byName.get(s.name.toLowerCase());
            if (
              fresh &&
              (fresh.totalItems !== s.totalItems ||
                fresh.lastSynced !== s.lastSynced ||
                fresh.totalSizeSaved !== s.totalSizeSaved)
            ) {
              changed = true;
              return { ...s, totalItems: fresh.totalItems, lastSynced: fresh.lastSynced, totalSizeSaved: fresh.totalSizeSaved };
            }
            return s;
          });
          return changed ? merged : prev;
        });

        // The settings blob above only tells us what the LAST FULLY-COMPLETED
        // sync pass wrote — for a large library still working through its
        // first pass (thumbnails done, face detection still catching up over
        // many minutes), that stays stale until the whole pass finishes.
        // getStorageDetails is a live DB + filesystem query with no such lag
        // (it reflects however many photos have actually finished face
        // detection RIGHT NOW), so polling it here keeps the sidebar's
        // "Cached X/Y · Faces X/Y" row correct continuously — updating within
        // this 5s window of each photo actually completing — rather than
        // only once an entire multi-thousand-photo pass finishes, and rather
        // than depending on an active mirror:progress stream from a sync this
        // session happens to be watching live.
        if (window.electronAPI?.getStorageDetails) {
          for (const s of saved) {
            try {
              const details = await window.electronAPI.getStorageDetails(s.name, s.localMirrorRoot);
              if (!details || details.totalPhotos <= 0) continue;
              setStorageProgressMap((prev) => {
                const existing = prev[s.name];
                // Don't fight an actively-streaming local sync — its
                // per-photo mirror:progress updates are more frequent and
                // already correct; only fill in when nothing fresher is
                // already driving this storage's row.
                if (existing && existing.phase !== 'completed' && existing.phase !== 'idle' && existing.currentFile) {
                  return prev;
                }
                return {
                  ...prev,
                  [s.name]: {
                    storageName: s.name,
                    phase: details.phase === 'completed' ? 'completed' : (details.thumbnailCachedCount < details.totalPhotos ? 'thumbnails' : 'faces'),
                    thumbnailCurrent: details.thumbnailCachedCount,
                    thumbnailTotal: details.totalPhotos,
                    faceCurrent: details.faceScannedCount,
                    faceTotal: details.totalPhotos,
                    percent: details.percent,
                  },
                };
              });
            } catch {}
          }
        }
      } catch {}
    };
    const intervalId = setInterval(refreshStorageTotals, 5000);
    refreshStorageTotals();
    return () => clearInterval(intervalId);
  }, []);

  // Listen for non-blocking background folder/drive scan events
  useEffect(() => {
    if (!window.electronAPI?.onBackgroundScanProgress) return;
    const unsubscribe = window.electronAPI.onBackgroundScanProgress((progress: any) => {
      setBgScanProgress(progress);
      const photosToAdd = progress.newPhotos || progress.newlyAddedPhotos;
      if (photosToAdd && photosToAdd.length > 0) {
        libraryStore.addPhotos(photosToAdd, progress.mirrorDirPath);
      }
      // Run face detection through the same restart-safe pipeline "Rescan"
      // uses, once the whole background scan finishes — rather than the old
      // per-batch faceQueue.enqueue(), which lived only in memory: if the app
      // restarted before the queue drained, those photos were left with no
      // face data and nothing ever retried them. runFaceDetectionForPhotos
      // re-derives its candidate list fresh (skipping anything already
      // scanned), so this is a safe, idempotent catch-up pass every time.
      if (progress.isComplete && progress.storageName && !progress.error) {
        const mirrorRoot = progress.mirrorRoot || 'C:\\GPhotos_VirtualMirrors';
        handleScanStorageFaces({
          id: `storage_${progress.storageName}`,
          name: progress.storageName,
          networkSourcePath: progress.sourcePath || '',
          localMirrorRoot: mirrorRoot,
        }).catch((err) => console.warn('Post-scan face detection failed:', err));
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
      // The backend reports both the thumbnail step and the face-detection
      // step for the SAME file index through the same current/total fields,
      // distinguished only by `phase` — this used to always be written into
      // thumbnailCurrent/Total regardless of which phase the event actually
      // was, so faceCurrent/faceTotal never updated from a live event at all
      // (stuck at whatever they defaulted to, usually 0/0). Thumbnails are
      // always done for a file by the time any progress event fires for it
      // (face detection runs strictly after), so thumbnailCurrent can track
      // progress.current unconditionally; faceCurrent only advances during
      // an actual 'faces' phase event, carrying its previous value otherwise.
      const isFacesPhase = progress.phase === 'faces';
      setStorageProgressMap((prev) => ({
        ...prev,
        [storageName]: {
          storageName,
          phase: (progress.phase as any) || (progress.status === 'completed' ? 'completed' : 'thumbnails'),
          thumbnailCurrent: progress.current,
          thumbnailTotal: progress.total,
          faceCurrent: isFacesPhase ? progress.current : (prev[storageName]?.faceCurrent || 0),
          faceTotal: progress.total,
          percent: pct,
          currentFile: progress.currentFile,
        },
      }));

      if (progress.status === 'completed' && progress.phase === 'completed') {
        // Keep completed status persisted in storageProgressMap so UI stays up-to-date
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
              const safeTotal = st.totalPhotos || 1;
              const safeThumb = Math.min(st.thumbnailCachedCount, safeTotal);
              const safeFaces = Math.min(st.faceScannedCount, safeTotal);
              if (!next[name] || next[name].phase === 'idle' || next[name].phase === 'interrupted') {
                next[name] = {
                  storageName: name,
                  phase,
                  thumbnailCurrent: safeThumb,
                  thumbnailTotal: safeTotal,
                  faceCurrent: safeFaces,
                  faceTotal: safeTotal,
                  percent: Math.min(100, Math.round(((safeThumb + safeFaces) / Math.max(1, safeTotal * 2)) * 100)),
                  currentFile: st.thumbnailLastFile || st.faceLastFile,
                  message: isCompleted
                    ? '✓ 100% Caching & Face Scan Complete'
                    : `Cached: ${safeThumb}/${safeTotal} • Faces: ${safeFaces}/${safeTotal}. Ready to resume.`,
                  canResume: !isCompleted,
                };
              }
            }
          }
          return next;
        });
      }).catch(() => {});
    }

    // Reconcile against the live, freshly-recomputed truth from each
    // storage's own catalog database — a stale checkpoint or status file
    // (e.g. left over from before a sync pipeline started keeping them
    // updated, or from an interrupted run that never got a final save) can
    // otherwise misreport a storage as "interrupted"/"resumable" forever,
    // even once it's genuinely 100% done. Only ever overrides *toward*
    // "completed" when the live data unambiguously says so — never invents
    // a worse status than what was already shown.
    if (window.electronAPI?.getAllStorageDetails) {
      window.electronAPI.getAllStorageDetails().then((details) => {
        if (!details || typeof details !== 'object') return;
        setStorageProgressMap((prev) => {
          const next = { ...prev };
          for (const [name, d] of Object.entries(details)) {
            if (d && d.phase === 'completed' && next[name] && next[name].phase !== 'completed') {
              next[name] = {
                storageName: name,
                phase: 'completed',
                thumbnailCurrent: d.totalPhotos,
                thumbnailTotal: d.totalPhotos,
                faceCurrent: d.totalPhotos,
                faceTotal: d.totalPhotos,
                percent: 100,
                message: '✓ Up to date',
              };
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

    // Skip photos that already have face scan completed, already have faces
    // identified, or were manually verified by the user (e.g. via "Remove
    // Unknown Faces") — that lock only lifts when the user explicitly
    // re-runs "Scan Faces" on that specific photo.
    const candidates = photosToScan.filter((p) => {
      if (p.facesLocked) return false;
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

    // Requirement: face detection on an ad-hoc/manual basis must not run
    // against an unreachable network storage. Local (non-virtual) photos
    // have no such gate. Checked per-storage (not just the first virtual
    // candidate found) so scanning a mixed local+network batch still
    // processes whatever's actually reachable instead of bailing outright.
    // See docs/PIPELINE_REDESIGN_DEV_DOC.md §3.6.
    const reachabilityByDir = new Map<string, boolean>();
    const offlineStorageNames = new Set<string>();
    let scannable = candidates;
    if (candidates.some((p) => p.isVirtual)) {
      scannable = [];
      for (const p of candidates) {
        if (!p.isVirtual) {
          scannable.push(p);
          continue;
        }
        const sourceDir = p.originalRemotePath
          ? p.originalRemotePath.substring(0, p.originalRemotePath.lastIndexOf('\\'))
          : undefined;
        if (!sourceDir) {
          scannable.push(p);
          continue;
        }
        if (!reachabilityByDir.has(sourceDir)) {
          reachabilityByDir.set(sourceDir, (await window.electronAPI?.checkFileExists?.(sourceDir)) ?? true);
        }
        if (reachabilityByDir.get(sourceDir)) {
          scannable.push(p);
        } else {
          offlineStorageNames.add(p.storageName || sourceDir);
        }
      }
    }

    if (offlineStorageNames.size > 0 && isManualTrigger) {
      showToast(
        `Skipping ${offlineStorageNames.size} offline storage${offlineStorageNames.size === 1 ? '' : 's'} (${[...offlineStorageNames].join(', ')}) — reconnect to detect faces there.`,
        'warning'
      );
    }

    if (scannable.length === 0) {
      return;
    }

    libraryStore.setDetectingFaces(true, {
      current: alreadyScannedCount,
      total: totalPhotos,
      currentPhotoName: 'Detecting faces...',
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

    if (!window.electronAPI?.detectFacesBatch) {
      libraryStore.setDetectingFaces(false, null);
      return;
    }

    try {
      // Detection, clustering and persistence all happen in the main
      // process now (see faceDetectionEngine.ts + pipelineOrchestrator.ts)
      // — this just hands over the candidates and adopts the authoritative
      // result, in chunks so progress/UI stays responsive on a large batch.
      const CHUNK_SIZE = 8;
      let totalDetected = 0;
      for (let i = 0; i < scannable.length; i += CHUNK_SIZE) {
        const chunk = scannable.slice(i, i + CHUNK_SIZE);
        const currentScanned = Math.min(alreadyScannedCount + i + chunk.length, totalPhotos);
        const facePct = Math.round((currentScanned / Math.max(1, totalPhotos)) * 100);

        libraryStore.setDetectingFaces(true, {
          current: currentScanned,
          total: totalPhotos,
          currentPhotoName: chunk[chunk.length - 1]?.fileName,
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
              message: `Recognizing faces: ${currentScanned}/${totalPhotos} (${facePct}%)`,
            },
          }));
        }

        const { results, people } = await window.electronAPI.detectFacesBatch(chunk);
        const perPhotoFaces = results.map((r) => ({
          photoId: r.photoId,
          faces: r.faces,
          faceScanCompleted: true,
          facesLocked: r.locked,
        }));
        libraryStore.applyServerDetectedFaces(perPhotoFaces, people);
        totalDetected += results.reduce((sum, r) => sum + r.faceCount, 0);

        if (window.electronAPI?.saveLibraryStatus) {
          await window.electronAPI.saveLibraryStatus({
            libraryPath,
            totalPhotos,
            faceScannedCount: currentScanned,
            faceTotalCount: totalPhotos,
            faceDetectedCount: totalDetected,
            faceLastFile: chunk[chunk.length - 1]?.fileName,
            faceCompleted: currentScanned >= totalPhotos,
            facePercent: facePct,
            phase: currentScanned >= totalPhotos ? 'completed' : 'faces',
          }).catch(() => {});
        }

        await libraryStore.persistNow();
      }

      if (totalDetected > 0) {
        if (isManualTrigger) {
          showToast(`Face recognition complete! Detected ${totalDetected} new face instances.`, 'success');
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

    const dir = await selectDirectoryOrPrompt(
      'Enter the full path to the photo folder on the computer running gPhotos (e.g. C:\\Photos or /home/user/Photos):'
    );
    if (!dir) return;

    libraryStore.setScanning(true);
    setSwitchingLibraryLabel(`Opening ${dir}...`);
    try {
      const switched = await libraryStore.switchLibrary(dir);
      if (switched) {
        setActiveTab('photos');
        showToast(`Opened library: ${dir}`, 'success');
        return;
      }

      setSwitchingLibraryLabel(`Scanning ${dir}...`);
      const photos = await window.electronAPI.scanDirectory(dir);
      const enriched = libraryStore.setPhotos(photos, dir);
      setActiveTab('photos');

      // Unified single-pass: automatically run face detection on any remaining unscanned photos
      await runFaceDetectionForPhotos(enriched, false);
    } catch (err: any) {
      showToast(`Error opening folder: ${err.message}`, 'warning');
    } finally {
      libraryStore.setScanning(false);
      setSwitchingLibraryLabel(null);
    }
  };

  const handleSelectLibrary = async (dirPath: string) => {
    responseTracker.clearAll();
    libraryStore.setScanning(true);
    setSwitchingLibraryLabel(`Switching to ${dirPath}...`);
    try {
      const switched = await libraryStore.switchLibrary(dirPath);
      if (switched) {
        setActiveTab('photos');
        showToast(`Switched library: ${dirPath}`, 'success');
        return;
      }

      if (window.electronAPI) {
        setSwitchingLibraryLabel(`Scanning ${dirPath}...`);
        const photos = await window.electronAPI.scanDirectory(dirPath);
        const enriched = libraryStore.setPhotos(photos, dirPath);
        setActiveTab('photos');
        await runFaceDetectionForPhotos(enriched, false);
      }
    } catch (err: any) {
      showToast(`Failed to load selected library: ${err.message}`, 'warning');
    } finally {
      libraryStore.setScanning(false);
      setSwitchingLibraryLabel(null);
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
      try {
        const mirroredPhotos = await window.electronAPI.scanVirtualMirror(mirrorRootPath);
        const enriched = libraryStore.setPhotos(mirroredPhotos, mirrorRootPath);
        setActiveTab('photos');

        // Auto-run face detection on any remaining unscanned photos
        await runFaceDetectionForPhotos(enriched, false);
      } finally {
        libraryStore.setScanning(false);
      }
    }
  };

  const handleSelectVirtualStorage = async (config: VirtualStorageConfig) => {
    responseTracker.clearAll();
    const mirrorLocalPath = `${config.localMirrorRoot}\\${config.name}`;
    setSwitchingLibraryLabel(`Switching to ${config.name}...`);
    try {
      // Fast path: this mirror's photos are indexed in its own SQLite database
      // (written the first time it was synced/saved) — reuse the same
      // instant meta + first-page switch used for regular library folders,
      // instead of re-walking every sidecar JSON file in the mirror
      // directory on disk, which is what made switching to a large network
      // storage take a long time and feel stuck.
      const switched = await libraryStore.switchLibrary(mirrorLocalPath);
      if (switched) {
        setActiveTab('photos');
        return;
      }

      // First-ever switch to this mirror (nothing indexed yet) — fall back
      // to scanning the mirror directory directly.
      await handleLoadMirroredPhotos(mirrorLocalPath);
    } finally {
      setSwitchingLibraryLabel(null);
    }
  };

  /**
   * Unified sync: syncVirtualStorage now runs the full per-photo pipeline
   * itself — thumbnail, then (for whichever photos aren't already locked,
   * and only while the storage is reachable) face detection, then OneDrive
   * space-reclaim if applicable — one shared implementation for plain
   * network and OneDrive-backed storages alike (see
   * docs/PIPELINE_REDESIGN_DEV_DOC.md §3.3). Faces land straight in SQLite
   * from the main process, so this just re-reads them afterward rather than
   * running a separate renderer-side detection pass.
   */
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
      // 1. Thumbnail + face detection + OneDrive reclaim, per photo, in the main process.
      const res = await window.electronAPI.syncVirtualStorage(config);
      const mirrorLocalPath = `${config.localMirrorRoot}\\${config.name}`;

      // 2. Pick up the result — including any faces the pipeline just
      // detected and persisted straight to SQLite — from the DB rather than
      // the sidecar JSON (which never carries face data).
      const updatedPhotos = (await window.electronAPI.getPhotosByStorageName?.(config.name, config.localMirrorRoot)) ||
        (await window.electronAPI.scanVirtualMirror(mirrorLocalPath));
      libraryStore.setPhotos(updatedPhotos, mirrorLocalPath);

      // 3. Update storage metadata and persist. totalItems must come from
      // the catalog's own authoritative count (getStorageDetails, DB-backed),
      // NOT res.totalSynced — that's just how many source files THIS ONE
      // pass touched, which silently undercounts whenever the network/
      // OneDrive source listing is briefly incomplete (a transient hiccup),
      // permanently sticking the sidebar at that smaller number until some
      // later pass happens to see every file again. The catalog only grows
      // via confirmed processed photos, so it can't regress this way.
      let authoritativeTotal = res.totalSynced;
      try {
        const details = await window.electronAPI.getStorageDetails?.(config.name, config.localMirrorRoot);
        if (details && details.totalPhotos > 0) authoritativeTotal = details.totalPhotos;
      } catch {}

      const updatedList = virtualStorages.map((s) =>
        s.id === config!.id
          ? {
              ...s,
              lastSynced: new Date().toISOString(),
              totalItems: authoritativeTotal,
              totalSizeSaved: res.totalSizeSaved,
              newlyAdded: res.newlyAdded,
            }
          : s
      );
      setVirtualStorages(updatedList);
      await window.electronAPI.saveLibraryData('gphotos_virtual_storages_v1', updatedList);

      setStorageProgressMap((prev) => ({
        ...prev,
        [config!.name]: {
          storageName: config!.name,
          phase: 'completed',
          thumbnailCurrent: res.totalSynced,
          thumbnailTotal: res.totalSynced,
          faceCurrent: res.totalSynced,
          faceTotal: res.totalSynced,
          percent: 100,
          message: '✓ Up to date',
        },
      }));
      showToast(
        res.newlyAdded > 0
          ? `Synced ${res.newlyAdded} new photo(s) from ${config.name} (thumbnails + faces).`
          : `Rescan Complete: ${config.name} is up-to-date (${res.totalSynced} photos).`,
        'success'
      );
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

  /**
   * Turns an arbitrary folder browsed via the folder-tree view into a new
   * virtual storage and runs it through the same unified inventory ->
   * thumbnail -> face -> reclaim pipeline as one added from the Virtual
   * Storage tab — replaces the old "Scan in Background" button's separate
   * thumbnail-only startBackgroundScan call (which never ran face detection
   * at all and used its own, different photo-id scheme).
   */
  const handleScanFolderAsStorage = async (path: string, name?: string) => {
    if (!window.electronAPI) return;
    const storageName = name || path.split(/[\\/]/).filter(Boolean).pop() || 'Folder';
    const defaultMirrorRoot = (await window.electronAPI.getDefaultMirrorRoot?.()) || 'GPhotos_VirtualMirrors';

    const newConfig: VirtualStorageConfig = {
      id: `storage_${Date.now()}`,
      name: storageName,
      networkSourcePath: path,
      localMirrorRoot: defaultMirrorRoot,
      inventoryStatus: 'not_started',
    };

    setVirtualStorages((prev) => {
      const updated = [...prev.filter((s) => s.name.toLowerCase() !== storageName.toLowerCase()), newConfig];
      window.electronAPI?.saveLibraryData('gphotos_virtual_storages_v1', updated).catch(() => {});
      return updated;
    });

    // Inventory gate: count everything under the folder and fix that number
    // before any thumbnail/face processing starts.
    if (window.electronAPI.scanStorageInventory) {
      const result = await window.electronAPI.scanStorageInventory(path);
      newConfig.inventoryStatus = result.status;
      newConfig.inventoryTotalFiles = result.totalFiles;
      newConfig.inventoryCompletedAt = result.completedAt;
      newConfig.inventoryError = result.error;
      if (result.status !== 'completed') {
        showToast(`Could not inventory ${storageName}: ${result.error || 'unknown error'}`, 'warning');
        return;
      }
    }

    await handleRefreshNetworkStorage(newConfig);
  };

  // "Scan Faces" on a storage card: syncVirtualStorage's per-photo pipeline
  // already runs face detection as part of sync (and cheaply no-ops the
  // thumbnail step for anything already up to date), so this is just an
  // explicit re-entry into the same unified path rather than a separate one.
  const handleScanStorageFaces = async (storage: VirtualStorageConfig) => {
    showToast(`Starting face recognition for ${storage.name}...`, 'info');
    await handleRefreshNetworkStorage(storage);
  };

  const [tabResetTrigger, setTabResetTrigger] = useState<number>(0);

  const handleSelectTab = (tab: ActiveTab) => {
    stopBackgroundTasksImmediately();
    responseTracker.clearAll();
    setSelectedPersonIdForView(null);
    setSelectedFolderForTree(null);
    setTabResetTrigger(Date.now());
    setActiveTab(tab);
  };

  const handleOpenDuplicateCleaner = (cluster?: DuplicateCluster | null) => {
    setDuplicateCleanerCluster(cluster || null);
    setShowDuplicateCleaner(true);
  };

  // Re-derived from the live library on every render (rather than freezing
  // the Photo objects at the moment the lightbox opened) so a favorite
  // toggle or an album removal while browsing is reflected immediately —
  // same as the album grid itself. Falls back to the whole library when the
  // lightbox wasn't opened from a narrower context (e.g. the main gallery).
  const activeLightboxPhotoList = useMemo(() => {
    if (!activeLightboxContextIds) return libraryState.photos;
    const photoMap = new Map(libraryState.photos.map((p) => [p.id, p]));
    return activeLightboxContextIds
      .map((id) => photoMap.get(id))
      .filter((p): p is Photo => p !== undefined);
  }, [activeLightboxContextIds, libraryState.photos]);

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
          onOpenDuplicateCleaner={() => handleOpenDuplicateCleaner()}
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
          onOpenDuplicateCleaner={() => handleOpenDuplicateCleaner()}
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
            totalCount={libraryState.totalCount}
            onSelectPhoto={(p) => setActiveLightboxPhoto(p)}
            onToggleFavorite={handleToggleFavorite}
            onOpenFolder={handleOpenFolder}
            onRefreshNetwork={() => handleRefreshNetworkStorage()}
            virtualStorages={virtualStorages}
            onSelectStorage={handleSelectVirtualStorage}
            onOpenDuplicateCleaner={handleOpenDuplicateCleaner}
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
            totalCount={libraryState.totalCount}
            onSelectPhoto={(p) => setActiveLightboxPhoto(p)}
            onToggleFavorite={handleToggleFavorite}
            onOpenFolder={handleOpenFolder}
            onRefreshNetwork={() => handleRefreshNetworkStorage()}
            filterFavorite={true}
            virtualStorages={virtualStorages}
            onSelectStorage={handleSelectVirtualStorage}
            onOpenDuplicateCleaner={handleOpenDuplicateCleaner}
            onOpenHelp={() => setShowHelpModal(true)}
            resetTrigger={tabResetTrigger}
          />
        )}

        {activeTab === 'albums' && (
          <AlbumsView
            photos={libraryState.photos}
            albums={libraryState.albums || []}
            onSelectPhoto={(p, contextPhotos) => {
              setActiveLightboxPhoto(p);
              setActiveLightboxContextIds(contextPhotos ? contextPhotos.map((cp) => cp.id) : null);
            }}
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
              handleScanFolderAsStorage(path, name);
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
          allPhotos={activeLightboxPhotoList}
          people={libraryState.people}
          onClose={() => {
            setActiveLightboxPhoto(null);
            setActiveLightboxContextIds(null);
          }}
          onSelectPhoto={(p) => setActiveLightboxPhoto(p)}
          onToggleFavorite={handleToggleFavorite}
          onNavigateToPerson={handleNavigateToPerson}
        />
      )}

      {/* Duplicate & Burst Cleaner Modal */}
      {showDuplicateCleaner && (
        <DuplicateCleanerModal
          photos={libraryState.photos}
          initialCluster={duplicateCleanerCluster}
          onClose={() => {
            setShowDuplicateCleaner(false);
            setDuplicateCleanerCluster(null);
          }}
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

      {/* Thumbnail pre-fetch activity indicator (bottom-left) */}
      <PrefetchStatusIndicator />

      {/* Small centered "please wait" popup shown while a library/storage switch is in flight */}
      {switchingLibraryLabel && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 10000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: 'rgba(5, 8, 15, 0.35)',
            pointerEvents: 'none',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '12px',
              padding: '16px 22px',
              borderRadius: 'var(--radius-lg)',
              backgroundColor: 'rgba(15, 23, 42, 0.95)',
              border: '1px solid rgba(56, 189, 248, 0.45)',
              boxShadow: '0 20px 50px rgba(0, 0, 0, 0.6), 0 0 24px rgba(6, 182, 212, 0.2)',
              backdropFilter: 'blur(16px)',
              maxWidth: '420px',
              animation: 'fadeIn 0.2s ease',
            }}
          >
            <RefreshCw
              size={20}
              color="var(--accent-cyan)"
              className="animate-spin"
              style={{ animationDuration: '0.85s', flexShrink: 0 }}
            />
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }}>
              <span style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                Please wait
              </span>
              <span
                style={{
                  fontSize: '0.78rem',
                  color: 'var(--text-secondary)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {switchingLibraryLabel}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
