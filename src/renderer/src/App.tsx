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
import { FolderBrowserModalHost } from './components/FolderBrowserModal';
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
import { joinMirrorPath } from './services/pathUtils';
import { logNavigation } from './services/userActionLogger';
import { logger } from './services/logger';
import { faceQueue, isFaceResultFinal } from './services/faceQueue';
import { notify, notifyError, runAction } from './services/notifications';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Photo, DetectedFace, VirtualStorageConfig, BackgroundScanProgress, NetworkStorageProgress, DuplicateCluster } from '../../types';
import { AiPhotoFilter } from './services/aiSearchService';
import { RefreshCw, CheckCircle2, X } from 'lucide-react';
import { ResponseActivityIndicator } from './components/ResponseActivityIndicator';
import { PrefetchStatusIndicator } from './components/PrefetchStatusIndicator';
import { responseTracker } from './services/responseTracker';
import { splitStoragesByExistence, isPathConfirmedMissing } from './services/storageValidation';
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
  const lastPrecacheCountRef = useRef(-1);
  // Latest configured storages, readable from async code that outlives the render it was created in.
  // Handlers used to close over `virtualStorages` and, minutes later (after a sync), write that stale
  // list back to state AND disk — dropping a storage added meanwhile and reverting removals.
  const virtualStoragesRef = useRef<VirtualStorageConfig[]>([]);
  // Bumped by every face-detection run/library switch; a sweep whose id is no longer current stops.
  const faceRunIdRef = useRef(0);
  const startupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleScanStorageFacesRef = useRef<(s: VirtualStorageConfig) => Promise<void>>(async () => {});

  const updateVirtualStorages = (fn: (prev: VirtualStorageConfig[]) => VirtualStorageConfig[]): VirtualStorageConfig[] => {
    const next = fn(virtualStoragesRef.current);
    virtualStoragesRef.current = next;
    setVirtualStorages(next);
    return next;
  };

  /** Persists the storage list; a failed write is reported (main resolves false rather than throwing). */
  const saveVirtualStorages = async (list: VirtualStorageConfig[]): Promise<void> => {
    try {
      const ok = await window.electronAPI?.saveLibraryData('gphotos_virtual_storages_v1', list);
      if (ok === false) throw new Error('the settings database rejected the write');
    } catch (err) {
      notifyError('Could not save your network storage list', err);
    }
  };

  useEffect(() => {
    const history = tabHistoryRef.current;
    if (history[history.length - 1] !== activeTab) {
      history.push(activeTab);
    }
  }, [activeTab]);

  // Stop background tasks immediately (called on any qualifying user
  // activity — navigation, Escape, mouse/keyboard input — see the 15-second
  // idle detector effect below). Uses the activity-specific thumbnail
  // pause/resume pair, not the Settings page's manual one, so this never
  // clears a pause the user set deliberately (and can never itself be
  // overridden by one) — see thumbnailWorkerService.ts's activityPaused doc
  // comment.
  const stopBackgroundTasksImmediately = useCallback(() => {
    try {
      console.log('[IdleControl] User interacted/navigated/pressed Esc: Stopping background tasks immediately');
      if (!faceQueue.getStatus().isPaused) {
        faceQueue.pause();
      }
      if (window.electronAPI?.pauseThumbnailPreCacheForActivity) {
        window.electronAPI.pauseThumbnailPreCacheForActivity().catch(() => {});
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
      if (window.electronAPI?.resumeThumbnailPreCacheForActivity) {
        window.electronAPI.resumeThumbnailPreCacheForActivity().catch(() => {});
      }
      // Re-armed every idle tick, so only re-send when the photo set changed,
      // and without faces (unused here) — the full payload was ~26K face
      // descriptors cloned over IPC every 15s, stalling main for seconds.
      if (window.electronAPI?.startThumbnailPreCache && lastPrecacheCountRef.current !== currentPhotos.length) {
        lastPrecacheCountRef.current = currentPhotos.length;
        const slim = currentPhotos.map((p) => ({ ...p, faces: undefined }));
        window.electronAPI.startThumbnailPreCache(slim as typeof currentPhotos).catch(() => {});
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

  // Idle Inactivity Detector & Auto-Resume Handler — threshold is
  // configurable (Settings > idleResumeSeconds, default 15s).
  useEffect(() => {
    let idleTimer: any = null;
    let idleThresholdMs = 15000; // default until the real setting is fetched below
    let cancelled = false;

    if (window.electronAPI?.getBackgroundServiceStatus) {
      window.electronAPI.getBackgroundServiceStatus()
        .then((status) => {
          if (!cancelled && typeof status?.idleResumeSeconds === 'number' && status.idleResumeSeconds > 0) {
            idleThresholdMs = status.idleResumeSeconds * 1000;
          }
        })
        .catch(() => {});
    }

    // Tracks whether background work is currently paused BECAUSE of
    // activity, so handleUserActivity only calls stopBackgroundTasksImmediately
    // once per activity burst (not on every qualifying event). Starts false
    // — at mount nothing has happened yet, so whatever background
    // caching/face-detection other triggers (opening a library, etc.)
    // already started keeps running freely until the user actually
    // interacts; only real activity should ever pause it.
    let isPausedForActivity = false;

    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        isPausedForActivity = false;
        startBackgroundTasks();
        // Re-arm rather than firing once: startBackgroundTasks() can be a
        // no-op if it runs before the library's later pages have finished
        // loading (loadNextCatalogPages is fire-and-forget) — without this,
        // an app left idle from launch with no further activity to re-trigger
        // handleUserActivity got exactly one attempt for the whole session
        // and pending caching/face detection could silently never resume.
        // enqueuePhotos()/faceQueue.enqueue() both dedupe, so a repeat call
        // once everything's already queued/caught up is a cheap no-op.
        resetIdleTimer();
      }, idleThresholdMs);
    };

    const handleUserActivity = () => {
      if (!isPausedForActivity) {
        isPausedForActivity = true;
        stopBackgroundTasksImmediately();
      }
      resetIdleTimer();
    };

    // Deliberately excludes 'mousemove' (and window focus) — the cursor
    // merely drifting across the window, or the window regaining focus,
    // isn't the user actually doing anything and shouldn't cancel an
    // otherwise-idle wait. Only real intent: a click, a keypress, scrolling,
    // or touch input.
    const activityEvents = ['mousedown', 'keydown', 'wheel', 'touchstart', 'scroll'];
    activityEvents.forEach((evt) => {
      window.addEventListener(evt, handleUserActivity, { passive: true });
    });

    // Start the countdown; nothing is paused yet at mount (see
    // isPausedForActivity's doc comment above).
    resetIdleTimer();

    return () => {
      cancelled = true;
      if (idleTimer) clearTimeout(idleTimer);
      activityEvents.forEach((evt) => {
        window.removeEventListener(evt, handleUserActivity);
      });
    };
  }, [startBackgroundTasks, stopBackgroundTasksImmediately]);

  // 'warning' toasts here always report a failed action, so they are shown as errors (sticky until dismissed).
  const showToast = (message: string, type: 'info' | 'success' | 'warning' = 'info') => {
    notify(type === 'warning' ? 'error' : type, message);
  };

  // Subscribe to library store updates and ensure persisted data is fetched on mount
  useEffect(() => {
    responseTracker.installSafeFetchInterceptor();
    libraryStore.loadPersistedData().finally(async () => {
      // Dismiss the splash and tell main we're interactive FIRST: the existence checks below hit
      // the disk/network (a dead UNC path can take the SMB timeout) and used to hold startup hostage.
      const splash = document.getElementById('app-splash-screen');
      if (splash) {
        splash.classList.add('loaded');
        setTimeout(() => splash.remove(), 600);
      }
      if (window.electronAPI?.sendAppReady) {
        window.electronAPI.sendAppReady();
      }

      const checkFileExists = window.electronAPI?.checkFileExists;
      if (!checkFileExists) return;
      try {
        // The "active library" pointer (shown in the sidebar) is a path remembered independently of
        // whether that folder still exists — deleting it outside the app otherwise leaves the sidebar
        // pointing at a folder that's gone. Only cleared when it is CONFIRMED missing (two reads, a
        // failed check counts as present): clearing persists, so one transient false must not do it.
        const activeFolder = libraryStore.getState().selectedFolder;
        // The user is already interactive: only clear if they haven't switched libraries meanwhile.
        if (
          activeFolder &&
          (await isPathConfirmedMissing(checkFileExists, activeFolder)) &&
          libraryStore.getState().selectedFolder === activeFolder
        ) {
          libraryStore.clearMissingActiveLibrary();
        }

        // Same check for the "Recent Libraries" list in the Switch Library modal.
        const recent = libraryStore.getRecentLibraries();
        if (recent.length > 0) {
          const checks = await Promise.all(
            recent.map(async (p) => ({ path: p, missing: await isPathConfirmedMissing(checkFileExists, p) }))
          );
          // Re-read the list: libraries may have been opened (added to it) while the checks ran.
          const missing = new Set(checks.filter((c) => c.missing).map((c) => c.path));
          const latest = libraryStore.getRecentLibraries();
          const stillValid = latest.filter((p) => !missing.has(p));
          if (stillValid.length !== latest.length) {
            libraryStore.setRecentLibraries(stillValid);
          }
        }
      } catch (err) {
        console.warn('[Startup] library existence checks failed:', err);
      }
    });

    return libraryStore.subscribe(() => {
      setLibraryState({ ...libraryStore.getState() });
    });
  }, []);

  // Load configured network storages on startup and auto-discover stored mirrors
  useEffect(() => {
    let cancelled = false;
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
      if (cancelled) return;
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
        if (cancelled) return;
        if (removed.length > 0) {
          combined = valid;
          const removedNames = removed.map((s) => s.name.toLowerCase());
          const nextUnlinked = Array.from(new Set([...unlinked, ...removedNames]));
          unlinked = nextUnlinked;
          unlinkedSet.clear();
          nextUnlinked.forEach((n) => unlinkedSet.add(n));
          if (window.electronAPI) {
            const okUnlinked = await window.electronAPI.saveLibraryData('gphotos_unlinked_storages_v1', nextUnlinked);
            const okStorages = await window.electronAPI.saveLibraryData('gphotos_virtual_storages_v1', combined);
            if (okUnlinked === false || okStorages === false) {
              notifyError('Could not save your network storage list', new Error('the settings database rejected the write'));
            }
          }
          for (const s of removed) {
            libraryStore.removePhotosByStorage(s.name);
          }
        }
      }

      // Immediate paint of configured storages without blocking startup
      updateVirtualStorages(() => combined);

      // Defer unneeded background discovery and auto-mirror scanning to 3.5s after mount
      startupTimerRef.current = setTimeout(async () => {
        startupTimerRef.current = null;
        if (cancelled) return;
        if (window.electronAPI?.discoverMirrors) {
          try {
            const discovered = await window.electronAPI.discoverMirrors();
            if (discovered && discovered.length > 0) {
              // Merged into the CURRENT list (not the copy captured at mount) so storages the
              // user added/removed in the meantime aren't reverted.
              updateVirtualStorages((prev) => {
                const next = [...prev];
                for (const disc of discovered) {
                  if (unlinkedSet.has(disc.name.toLowerCase())) continue;
                  const idx = next.findIndex(
                    (s) => s.name.toLowerCase() === disc.name.toLowerCase() || s.id === disc.id
                  );
                  if (idx === -1) {
                    next.push(disc);
                  } else {
                    next[idx] = {
                      ...next[idx],
                      totalItems: disc.totalItems || next[idx].totalItems,
                      totalSizeSaved: disc.totalSizeSaved || next[idx].totalSizeSaved,
                      lastSynced: next[idx].lastSynced || disc.lastSynced,
                    };
                  }
                }
                return next;
              });
            }
          } catch (err) {
            console.warn('Failed to auto-discover mirrors:', err);
          }
        }

        // If no photos currently in library but we have configured mirrors or an active mirror folder, auto-load them
        const curPhotos = libraryStore.getState().photos;
        const current = virtualStoragesRef.current;
        if (!cancelled && curPhotos.length === 0 && current.length > 0 && window.electronAPI?.scanVirtualMirror) {
          const curFolder = libraryStore.getState().selectedFolder;
          const target = current.find(
            (s) => curFolder && `${s.localMirrorRoot}\\${s.name}`.toLowerCase() === curFolder.toLowerCase()
          ) || current.find((s) => (s.totalItems || 0) > 0) || current[0];

          if (target) {
            const mirrorPath = `${target.localMirrorRoot}\\${target.name}`;
            try {
              const mirroredPhotos = await window.electronAPI.scanVirtualMirror(mirrorPath);
              if (mirroredPhotos && mirroredPhotos.length > 0) {
                libraryStore.setPhotos(mirroredPhotos, mirrorPath);
              }
            } catch (loadErr) {
              console.warn('Failed to auto-load mirrored photos:', loadErr);
              notifyError('Could not load photos from your network storage', loadErr);
            }
          }
        }
      }, 3500);
    };
    // A failed read here must not look like "no storages" (and must never be pruned/saved over).
    loadStorages().catch((err) => notifyError('Could not load your network storages', err));
    return () => {
      cancelled = true;
      if (startupTimerRef.current) clearTimeout(startupTimerRef.current);
    };
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
    // Best-effort polling: failures stay quiet (the next tick retries). Ticks never overlap, so a slow
    // main process can't pile up queued IPC calls.
    let polling = false;
    const refreshStorageTotals = async () => {
      if (polling) return;
      polling = true;
      try {
        await pollStorageTotals();
      } finally {
        polling = false;
      }
    };
    const pollStorageTotals = async () => {
      if (!window.electronAPI?.loadLibraryData) return;
      try {
        const saved: VirtualStorageConfig[] | null = await window.electronAPI.loadLibraryData('gphotos_virtual_storages_v1');
        if (!saved || saved.length === 0) return;
        const byName = new Map(saved.map((s) => [s.name.toLowerCase(), s]));
        updateVirtualStorages((prev) => {
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
        // getStorageDetailsFast is a live checkpoint+DB query with no such
        // lag (it reflects however many photos have actually finished face
        // detection RIGHT NOW), so polling it here keeps the sidebar's
        // "Cached X/Y · Faces X/Y" row correct continuously — updating within
        // this 5s window of each photo actually completing — rather than
        // only once an entire multi-thousand-photo pass finishes, and rather
        // than depending on an active mirror:progress stream from a sync this
        // session happens to be watching live.
        //
        // This runs unconditionally, every 5s, for the app's whole lifetime —
        // regardless of which tab is open — so it must never be the plain
        // getStorageDetails() (a live recursive sidecar-folder walk per
        // configured storage): that measured as a genuine multi-second
        // main-process stall on every single tick, for every user, all the
        // time, not just while the Network Mirrors screen happened to be
        // open. One bulk fast call replaces what used to be N slow
        // one-at-a-time round trips.
        if (window.electronAPI?.getAllStorageDetailsFast) {
          try {
            const allDetails = await window.electronAPI.getAllStorageDetailsFast();
            // One state update for all storages (was one per storage per tick).
            setStorageProgressMap((prev) => {
              let next = prev;
              for (const s of saved) {
                const details = allDetails?.[s.name];
                if (!details || details.totalPhotos <= 0) continue;
                const existing = next[s.name];
                // Don't fight an actively-streaming local sync — its
                // per-photo mirror:progress updates are more frequent and
                // already correct; only fill in when nothing fresher is
                // already driving this storage's row.
                if (existing && existing.phase !== 'completed' && existing.phase !== 'idle' && existing.currentFile) {
                  continue;
                }
                next = {
                  ...next,
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
              }
              return next;
            });
          } catch {}
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
        libraryStore.addPhotos(photosToAdd);
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
        // Through a ref: this effect runs once, so a direct call would use the first render's handler.
        handleScanStorageFacesRef.current({
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
      if (progress.error) {
        showToast(`Background scan failed: ${progress.error}`, 'warning');
      }
      if (progress.isComplete) {
        setTimeout(() => {
          setBgScanProgress((p) => (p?.isComplete ? null : p));
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
      // progress.current is the sync loop's WALK POSITION through the file
      // list — accurate for thumbnails (every walked file has been checked/
      // cached), but not a count of photos with completed face scans, since
      // face detection can lag well behind the walk for a large backlog of
      // never-scanned photos. facesCompletedCount (added alongside the
      // face-cluster-cache perf fix) is the real, accurate cumulative count
      // the backend tracks; only fall back to the old walk-position proxy
      // for a backend/build that predates it.
      setStorageProgressMap((prev) => ({
        ...prev,
        [storageName]: {
          storageName,
          phase: (progress.phase as any) || (progress.status === 'completed' ? 'completed' : 'thumbnails'),
          thumbnailCurrent: progress.current,
          thumbnailTotal: progress.total,
          faceCurrent: progress.facesCompletedCount ?? (prev[storageName]?.faceCurrent || 0),
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
    //
    // getAllStorageDetailsFast, NOT getAllStorageDetails: this runs
    // unconditionally at every app mount, across every configured storage —
    // the plain version's full recursive sidecar-folder walk measured as a
    // 150+ SECOND startup block on a real multi-storage library (each
    // storage paying its own thousands-of-files walk, back to back). The
    // fast path still self-heals a stale "interrupted" flag correctly: its
    // phase is computed fresh from the checkpoint/DB counts every time
    // (completed as soon as thumbnailCachedCount/faceScannedCount both
    // reach totalPhotos), never just copied from the stale flag itself —
    // it only stops catching drift the live disk scan would (e.g. a
    // checkpoint whose OWN counts are themselves wrong), which is a much
    // narrower and rarer case than what this reconciliation exists for.
    if (window.electronAPI?.getAllStorageDetailsFast) {
      window.electronAPI.getAllStorageDetailsFast().then((details) => {
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

  /** Stops any in-flight face-detection sweep (its next loop check sees a stale run id) and clears its progress flag. */
  const cancelFaceSweep = () => {
    faceRunIdRef.current++;
    if (libraryStore.getState().isDetectingFaces) libraryStore.setDetectingFaces(false, null);
  };

  // Run AI face detection helper for any given batch of photos
  const runFaceDetectionForPhotos = async (
    photosToScan: Photo[],
    isManualTrigger = false,
    storageName?: string
  ) => {
    const faceDetectStartedAt = Date.now();
    // Superseded (by a newer run or a library switch) => this sweep stops instead of feeding the old
    // library's photos to the detector and stomping the new run's progress state.
    cancelFaceSweep();
    const runId = faceRunIdRef.current;
    const isCurrentRun = () => runId === faceRunIdRef.current;
    logger.debug('UserAction', `start: runFaceDetectionForPhotos (${photosToScan.length} candidate photos${storageName ? `, storage=${storageName}` : ''})`);
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
          // A failed check means "unknown", not "offline": scan it and let detection report per photo.
          const reachable = await window.electronAPI?.checkFileExists?.(sourceDir).catch(() => true);
          reachabilityByDir.set(sourceDir, reachable ?? true);
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

    // Superseded while awaiting the reachability checks: a cancelled sweep must not re-raise the flag.
    if (scannable.length === 0 || !isCurrentRun()) {
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
      if (isCurrentRun()) libraryStore.setDetectingFaces(false, null);
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
        // Re-check after every await of the previous chunk (saveLibraryStatus) before touching the flag.
        if (!isCurrentRun()) return;
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

        // This sweep (run right after opening/switching to a library) is
        // otherwise unaware of the 15s-idle activity gate — faceQueue's own
        // per-photo loop already respects it, but this one chunks through
        // possibly thousands of photos independently of that queue. Waiting
        // here between chunks means an aggressive first-time backlog scan
        // yields to the user immediately on activity instead of continuing
        // to hammer the main process with detectFacesBatch calls while
        // they're trying to interact with the app.
        while (faceQueue.getStatus().isPaused && isCurrentRun()) {
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
        if (!isCurrentRun()) return;

        const { results, people } = await window.electronAPI.detectFacesBatch(chunk);
        if (!isCurrentRun()) return;
        // Only adopt real outcomes: an offline/undecodable photo (ran:false) must not be stamped
        // "scanned" (it would never be retried) nor have its faces replaced by the empty list.
        const perPhotoFaces = results
          .filter(isFaceResultFinal)
          .map((r) => ({
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
        // No persistNow(): detectFacesBatch already persisted this chunk in the main process.
      }

      if (totalDetected > 0) {
        if (isManualTrigger) {
          showToast(`Face recognition complete! Detected ${totalDetected} new face instances.`, 'success');
        }
      } else if (isManualTrigger) {
        showToast('Face recognition finished. No faces detected.', 'info');
      }

      if (storageName && isCurrentRun()) {
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
      if (isCurrentRun()) libraryStore.setDetectingFaces(false, null);
      logger.debug('UserAction', `end: runFaceDetectionForPhotos (${Date.now() - faceDetectStartedAt}ms)`);
    }
  };

  const handleOpenFolder = async () => {
    responseTracker.clearAll();
    if (!window.electronAPI) {
      showToast('Native folder selection is available in the Electron desktop app.', 'warning');
      return;
    }

    let dir: string | null = null;
    try {
      dir = await selectDirectoryOrPrompt(
        'Enter the full path to the photo folder on the computer running gPhotos (e.g. C:\\Photos or /home/user/Photos):'
      );
    } catch (err) {
      notifyError('Could not open the folder picker', err);
      return;
    }
    if (!dir) return;
    cancelFaceSweep();

    logger.debug('UserAction', `start: handleOpenFolder (${dir})`);
    const openFolderStartedAt = Date.now();
    libraryStore.setScanning(true);
    setSwitchingLibraryLabel(`Opening ${dir}...`);
    try {
      const switched = await libraryStore.switchLibrary(dir);
      if (switched) {
        setActiveTab('photos');
        showToast(`Opened library: ${dir}`, 'success');
        // Cheap no-op for a library that was already indexed (every
        // candidate is filtered out by faceScanCompleted) — but for a
        // folder opened for the very first time, switchLibrary's server
        // side just scanned it fresh and these photos have never been
        // through face detection at all.
        await runFaceDetectionForPhotos(libraryStore.getState().photos, false);
        return;
      }

      setSwitchingLibraryLabel(`Scanning ${dir}...`);
      const photos = await window.electronAPI.scanDirectory(dir);
      const enriched = libraryStore.setPhotos(photos, dir);
      setActiveTab('photos');

      // Unified single-pass: automatically run face detection on any remaining unscanned photos
      await runFaceDetectionForPhotos(enriched, false);
    } catch (err) {
      notifyError('Could not open the folder', err);
    } finally {
      libraryStore.setScanning(false);
      setSwitchingLibraryLabel(null);
      logger.debug('UserAction', `end: handleOpenFolder (${Date.now() - openFolderStartedAt}ms)`);
    }
  };

  const handleSelectLibrary = async (dirPath: string) => {
    responseTracker.clearAll();
    cancelFaceSweep();
    libraryStore.setScanning(true);
    setSwitchingLibraryLabel(`Switching to ${dirPath}...`);
    try {
      const switched = await libraryStore.switchLibrary(dirPath);
      if (switched) {
        setActiveTab('photos');
        showToast(`Switched library: ${dirPath}`, 'success');
        await runFaceDetectionForPhotos(libraryStore.getState().photos, false);
        return;
      }

      if (window.electronAPI) {
        setSwitchingLibraryLabel(`Scanning ${dirPath}...`);
        const photos = await window.electronAPI.scanDirectory(dirPath);
        const enriched = libraryStore.setPhotos(photos, dirPath);
        setActiveTab('photos');
        await runFaceDetectionForPhotos(enriched, false);
      }
    } catch (err) {
      notifyError('Could not load the selected library', err);
    } finally {
      libraryStore.setScanning(false);
      setSwitchingLibraryLabel(null);
    }
  };

  // Run AI face detection manually across all indexed photos
  const handleTriggerFaceDetection = runAction('Face detection', async () => {
    await runFaceDetectionForPhotos(libraryState.photos, true);
  });

  // Reset all people and faces from scratch and restart fresh face detection on all photos
  const handleResetAndRescan = runAction('Reset & rescan faces', async () => {
    faceQueue.clear();
    libraryStore.resetAllPeopleAndFaces();
    const freshPhotos = libraryStore.getState().photos;
    await runFaceDetectionForPhotos(freshPhotos, true);
  });

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
      try {
        const organizedPhotos = await window.electronAPI.scanDirectory(targetDir);
        libraryStore.setPhotos(organizedPhotos, targetDir);
        setActiveTab('photos');
      } catch (err) {
        notifyError('Could not load the organized folder', err);
      } finally {
        // Was skipped when the scan threw, leaving the whole app stuck in "scanning".
        libraryStore.setScanning(false);
      }
    }
  };

  const handleLoadMirroredPhotos = async (mirrorRootPath: string) => {
    if (window.electronAPI) {
      cancelFaceSweep();
      libraryStore.setScanning(true);
      try {
        const mirroredPhotos = await window.electronAPI.scanVirtualMirror(mirrorRootPath);
        const enriched = libraryStore.setPhotos(mirroredPhotos, mirrorRootPath);
        setActiveTab('photos');

        // Auto-run face detection on any remaining unscanned photos
        await runFaceDetectionForPhotos(enriched, false);
      } catch (err) {
        notifyError('Could not load the mirrored photos', err);
      } finally {
        libraryStore.setScanning(false);
      }
    }
  };

  const handleSelectVirtualStorage = async (config: VirtualStorageConfig) => {
    responseTracker.clearAll();
    cancelFaceSweep();
    const mirrorLocalPath = joinMirrorPath(config.localMirrorRoot, config.name);
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
        await runFaceDetectionForPhotos(libraryStore.getState().photos, false);
        return;
      }

      // First-ever switch to this mirror (nothing indexed yet) — fall back
      // to scanning the mirror directory directly.
      await handleLoadMirroredPhotos(mirrorLocalPath);
    } catch (err) {
      notifyError(`Could not switch to ${config.name}`, err);
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
      const storages = virtualStoragesRef.current;
      config =
        storages.find(
          (s) =>
            (activeFolder && `${s.localMirrorRoot}\\${s.name}`.toLowerCase() === activeFolder.toLowerCase()) ||
            s.name === firstVirtual?.storageName
        ) || storages[0];
    }

    if (!config) {
      showToast('No network mirrors configured yet. Go to Network Mirrors tab to connect a remote or cloud folder.', 'warning');
      return;
    }

    // Seed the progress card from what's already cached (checkpoint/DB —
    // cheap, see getAllStorageDetailsFast's doc comment) instead of
    // resetting it to 0/0/0% — a Rescan is usually a no-op re-verification
    // over an already-mostly-synced storage, and showing 0% while that
    // happens looks exactly like "it's starting over from scratch" even
    // when the sync loop below is about to skip almost every file.
    let seeded: NetworkStorageProgress = {
      storageName: config.name,
      phase: 'scanning',
      thumbnailCurrent: 0,
      thumbnailTotal: 0,
      faceCurrent: 0,
      faceTotal: 0,
      percent: 0,
      message: 'Scanning remote directory...',
    };
    try {
      const known = await window.electronAPI.getAllStorageDetailsFast?.(config.localMirrorRoot);
      const details = known?.[config.name];
      if (details && details.totalPhotos > 0) {
        seeded = {
          ...seeded,
          thumbnailCurrent: details.thumbnailCachedCount,
          thumbnailTotal: details.totalPhotos,
          faceCurrent: details.faceScannedCount,
          faceTotal: details.totalPhotos,
          percent: details.percent,
          message: `Checking for changes… (${details.thumbnailCachedCount}/${details.totalPhotos} already cached)`,
        };
      }
    } catch {}
    setStorageProgressMap((prev) => ({ ...prev, [config!.name]: seeded }));

    try {
      // 1. Thumbnail + face detection + OneDrive reclaim, per photo, in the main process.
      const res = await window.electronAPI.syncVirtualStorage(config);
      if (res.success === false) {
        // Partial failures still return their counts, so carry on with what was synced — but say so.
        notifyError(`Sync of ${config.name} finished with errors`, new Error(res.errors?.[0] || 'the sync reported a failure'));
      }
      const mirrorLocalPath = joinMirrorPath(config.localMirrorRoot, config.name);

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
      // Also the source of the completed-state thumbnailCurrent/faceCurrent
      // below — res.totalSynced is how many files this ONE pass touched
      // (thumbnail-wise), not an actual count of photos with completed face
      // scans, which can legitimately lag behind after a pass that deferred
      // some (offline mid-run, etc.). This one ground-truth read, once,
      // right after a full sync finishes, is a fine cost — unlike polling it
      // on a timer, which is what getAllStorageDetailsFast exists to avoid.
      let finalDetails: Awaited<ReturnType<NonNullable<typeof window.electronAPI.getStorageDetails>>> = null;
      try {
        finalDetails = await window.electronAPI.getStorageDetails?.(config.name, config.localMirrorRoot) ?? null;
        if (finalDetails && finalDetails.totalPhotos > 0) authoritativeTotal = finalDetails.totalPhotos;
      } catch {}

      // Applied to the CURRENT list (ref), not the one captured when this sync started — minutes ago,
      // before storages may have been added/removed/synced elsewhere. Using the stale copy dropped a
      // just-added storage and reverted removals, in state and on disk.
      const updatedList = updateVirtualStorages((prev) =>
        prev.map((s) =>
          s.id === config!.id
            ? {
                ...s,
                lastSynced: new Date().toISOString(),
                totalItems: authoritativeTotal,
                totalSizeSaved: res.totalSizeSaved,
                newlyAdded: res.newlyAdded,
              }
            : s
        )
      );
      await saveVirtualStorages(updatedList);

      const facesFullyDone = !finalDetails || finalDetails.faceScannedCount >= authoritativeTotal;
      setStorageProgressMap((prev) => ({
        ...prev,
        [config!.name]: {
          storageName: config!.name,
          phase: 'completed',
          thumbnailCurrent: finalDetails?.thumbnailCachedCount ?? res.totalSynced,
          thumbnailTotal: authoritativeTotal,
          faceCurrent: finalDetails?.faceScannedCount ?? res.totalSynced,
          faceTotal: authoritativeTotal,
          percent: finalDetails?.percent ?? 100,
          message: facesFullyDone
            ? '✓ Up to date'
            : `Thumbnails up to date — ${finalDetails?.faceScannedCount ?? 0}/${authoritativeTotal} faces scanned (some deferred)`,
        },
      }));
      showToast(
        res.newlyAdded > 0
          ? `Synced ${res.newlyAdded} new photo(s) from ${config.name} (thumbnails + faces).`
          : `Rescan Complete: ${config.name} is up-to-date (${res.totalSynced} photos).`,
        'success'
      );
    } catch (err) {
      const message = (err as Error)?.message || String(err);
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
          error: message,
        },
      }));
      notifyError('Could not refresh the network storage', err);
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
  const handleScanFolderAsStorage = runAction('Scanning the folder', async (path: string, name?: string) => {
    if (!window.electronAPI) return;
    const storageName = name || path.split(/[\\/]/).filter(Boolean).pop() || 'Folder';
    const defaultMirrorRoot = (await window.electronAPI.getDefaultMirrorRoot?.()) || 'GPhotos_VirtualMirrors';

    let newConfig: VirtualStorageConfig = {
      id: `storage_${Date.now()}`,
      name: storageName,
      networkSourcePath: path,
      localMirrorRoot: defaultMirrorRoot,
      inventoryStatus: 'not_started',
    };

    // Registered in the ref-backed list synchronously (no IPC inside a state updater — StrictMode
    // runs those twice) so handleRefreshNetworkStorage's later merge sees it.
    const withNew = updateVirtualStorages((prev) => [
      ...prev.filter((s) => s.name.toLowerCase() !== storageName.toLowerCase()),
      newConfig,
    ]);
    await saveVirtualStorages(withNew);

    // Inventory gate: count everything under the folder and fix that number
    // before any thumbnail/face processing starts.
    if (window.electronAPI.scanStorageInventory) {
      const result = await window.electronAPI.scanStorageInventory(path);
      newConfig = {
        ...newConfig,
        inventoryStatus: result.status,
        inventoryTotalFiles: result.totalFiles,
        inventoryCompletedAt: result.completedAt,
        inventoryError: result.error,
      };
      updateVirtualStorages((prev) => prev.map((s) => (s.id === newConfig.id ? newConfig : s)));
      if (result.status !== 'completed') {
        showToast(`Could not inventory ${storageName}: ${result.error || 'unknown error'}`, 'warning');
        return;
      }
    }

    await handleRefreshNetworkStorage(newConfig);
  });

  // "Scan Faces" on a storage card: syncVirtualStorage's per-photo pipeline
  // already runs face detection as part of sync (and cheaply no-ops the
  // thumbnail step for anything already up to date), so this is just an
  // explicit re-entry into the same unified path rather than a separate one.
  const handleScanStorageFaces = async (storage: VirtualStorageConfig) => {
    showToast(`Starting face recognition for ${storage.name}...`, 'info');
    await handleRefreshNetworkStorage(storage);
  };
  handleScanStorageFacesRef.current = handleScanStorageFaces;

  const [tabResetTrigger, setTabResetTrigger] = useState<number>(0);

  const handleSelectTab = (tab: ActiveTab) => {
    logNavigation(tab, activeTab);
    stopBackgroundTasksImmediately();
    responseTracker.clearAll();
    setSelectedPersonIdForView(null);
    setSelectedFolderForTree(null);
    setTabResetTrigger(Date.now());
    setActiveTab(tab);
  };

  const handleOpenDuplicateCleaner = (cluster?: DuplicateCluster | null) => {
    // Only a real cluster counts: a handler wired straight to onClick receives the
    // click event here, and storing that crashed the whole app in the modal.
    setDuplicateCleanerCluster(cluster && Array.isArray((cluster as any).photos) ? cluster : null);
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
        {/* One boundary for whichever screen is showing: a crash in it leaves the sidebar usable, and
            switching tabs (resetKey) clears the error. */}
        <ErrorBoundary compact resetKey={activeTab} fallbackTitle="This screen ran into a problem">
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
            onStoragesUpdated={(storages) => updateVirtualStorages(() => storages)}
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
        </ErrorBoundary>
      </main>

      {/* Fullscreen Photo Lightbox */}
      {activeLightboxPhoto && (
        // Same fixed layer/z-index as the lightbox itself, so a crashed lightbox shows its error
        // (with a way out: "Try Again" closes it) instead of taking the whole app down.
        <div style={{ position: 'fixed', inset: 0, zIndex: 1000 }}>
          <ErrorBoundary
            compact
            fallbackTitle="This photo could not be displayed"
            onReset={() => {
              setActiveLightboxPhoto(null);
              setActiveLightboxContextIds(null);
            }}
          >
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
          </ErrorBoundary>
        </div>
      )}

      {/* Shared folder-picker dialog — renders itself only when some other
          component (via selectDirectoryOrPrompt) has an active request */}
      <FolderBrowserModalHost />

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
            border: `1px solid ${bgScanProgress.isComplete ? 'rgba(16, 185, 129, 0.6)' : 'var(--accent-cyan)'}`,
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
            backgroundColor: bgScanProgress.isComplete ? 'rgba(16, 185, 129, 0.2)' : 'rgba(6, 182, 212, 0.2)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}>
            {bgScanProgress.isComplete ? (
              <CheckCircle2 size={18} color="#10b981" />
            ) : (
              <RefreshCw size={16} color="var(--accent-cyan)" className="animate-spin" />
            )}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-primary)', display: 'flex', justifyContent: 'space-between' }}>
              <span>{bgScanProgress.isComplete ? 'Scan Completed' : 'Background Scanning...'}</span>
              <span style={{ fontSize: '0.75rem', color: 'var(--accent-cyan)' }}>
                {bgScanProgress.processedCount} / {bgScanProgress.totalDiscovered} photos
              </span>
            </div>
            <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: '2px' }}>
              {bgScanProgress.currentFile || bgScanProgress.sourcePath}
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
