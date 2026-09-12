import React, { useState, useEffect } from 'react';
import {
  Settings,
  Server,
  Cpu,
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
  HelpCircle,
  Clock,
  Sparkles,
  Terminal,
  ShieldCheck,
  Power,
  RotateCw,
  Layers,
  FileText,
  Key,
  Archive,
  FolderDown,
  Smartphone,
  Globe,
  Copy,
  ExternalLink,
  Wifi,
  Check
} from 'lucide-react';
import { BackgroundServiceStatus, BackgroundServiceSettings, WebServerStatus } from '../../types';
import { aiSearchService, AiSearchConfig, AiProvider } from '../services/aiSearchService';

interface SettingsViewProps {
  onOpenHelp?: () => void;
  onOpenDuplicateCleaner?: () => void;
}

export const SettingsView: React.FC<SettingsViewProps> = ({
  onOpenHelp,
  onOpenDuplicateCleaner,
}) => {
  const [serviceStatus, setServiceStatus] = useState<BackgroundServiceStatus | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [logsLoading, setLogsLoading] = useState<boolean>(false);
  const [syncFeedback, setSyncFeedback] = useState<string | null>(null);
  const [aiConfig, setAiConfig] = useState<AiSearchConfig>(aiSearchService.getConfig());
  const [aiFeedback, setAiFeedback] = useState<string | null>(null);

  // Mobile Web Server state
  const [webServerStatus, setWebServerStatus] = useState<WebServerStatus | null>(null);
  const [webServerPortInput, setWebServerPortInput] = useState<string>('5173');
  const [webServerEnabled, setWebServerEnabled] = useState<boolean>(true);
  const [isUpdatingWebServer, setIsUpdatingWebServer] = useState<boolean>(false);
  const [copiedUrl, setCopiedUrl] = useState<boolean>(false);
  const [webServerFeedback, setWebServerFeedback] = useState<string | null>(null);

  useEffect(() => {
    if (window.electronAPI?.getWebServerStatus) {
      window.electronAPI.getWebServerStatus().then((status) => {
        if (status) {
          setWebServerStatus(status);
          setWebServerPortInput(String(status.port || 5173));
          setWebServerEnabled(status.enabled);
        }
      });
    }
  }, []);

  const handleSaveWebServerSettings = async () => {
    const portNum = parseInt(webServerPortInput, 10);
    if (isNaN(portNum) || portNum < 1024 || portNum > 65535) {
      alert('Please enter a valid port number between 1024 and 65535.');
      return;
    }
    setIsUpdatingWebServer(true);
    setWebServerFeedback(null);
    try {
      if (window.electronAPI?.setWebServerSettings) {
        const updated = await window.electronAPI.setWebServerSettings({
          enabled: webServerEnabled,
          port: portNum,
        });
        setWebServerStatus(updated);
        setWebServerFeedback(
          updated.isRunning
            ? `✓ Mobile server successfully running on port ${updated.port}!`
            : `✓ Mobile server settings saved (currently disabled).`
        );
      }
    } catch (err: any) {
      alert('Failed to update web server settings: ' + err.message);
    } finally {
      setIsUpdatingWebServer(false);
    }
  };

  const handleCopyMobileUrl = (url: string) => {
    navigator.clipboard.writeText(url);
    setCopiedUrl(true);
    setTimeout(() => setCopiedUrl(false), 2000);
  };

  // Backup in .zip format state
  const [isBackingUp, setIsBackingUp] = useState<boolean>(false);
  const [backupResult, setBackupResult] = useState<{
    filePath?: string;
    fileSize?: number;
    totalPhotos?: number;
    totalPeople?: number;
    totalAlbums?: number;
  } | null>(null);
  const [backupFeedback, setBackupFeedback] = useState<string | null>(null);

  const handleCreateZipBackup = async () => {
    if (!window.electronAPI?.createLibraryBackupZip) {
      alert('Backup creation is available in the Electron desktop app.');
      return;
    }
    setIsBackingUp(true);
    setBackupFeedback(null);
    try {
      const res = await window.electronAPI.createLibraryBackupZip();
      if (res.canceled) {
        setIsBackingUp(false);
        return;
      }
      if (res.success && res.filePath) {
        setBackupResult(res);
        setBackupFeedback(`✓ Library backup successfully exported to: ${res.filePath} (${((res.fileSize || 0) / 1024).toFixed(1)} KB)`);
      } else {
        alert('Failed to create backup: ' + (res.error || 'Unknown error'));
      }
    } catch (err: any) {
      alert('Backup error: ' + err.message);
    } finally {
      setIsBackingUp(false);
    }
  };

  // Load service status
  const fetchStatus = async () => {
    if (!window.electronAPI?.getBackgroundServiceStatus) {
      setLoading(false);
      return;
    }
    try {
      const status = await window.electronAPI.getBackgroundServiceStatus();
      setServiceStatus(status);
    } catch (err) {
      console.error('Failed to get background service status:', err);
    } finally {
      setLoading(false);
    }
  };

  // Load logs
  const fetchLogs = async () => {
    if (!window.electronAPI?.getServiceLogs) return;
    setLogsLoading(true);
    try {
      const logList = await window.electronAPI.getServiceLogs();
      setLogs(logList);
    } catch (err) {
      console.error('Failed to get service logs:', err);
    } finally {
      setLogsLoading(false);
    }
  };

  useEffect(() => {
    fetchStatus();
    fetchLogs();
    const interval = setInterval(() => {
      fetchStatus();
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  const handleToggleSetting = async (key: keyof BackgroundServiceSettings, value: any) => {
    if (!window.electronAPI?.setBackgroundServiceSettings) return;
    try {
      await window.electronAPI.setBackgroundServiceSettings({ [key]: value });
      await fetchStatus();
    } catch (err) {
      console.error(`Failed to update setting ${key}:`, err);
    }
  };

  const handleInstallService = async () => {
    if (!window.electronAPI?.installSystemService) return;
    setActionLoading('install');
    try {
      const res = await window.electronAPI.installSystemService();
      if (res.success) {
        setSyncFeedback('Autonomous system service registered and started successfully!');
      } else {
        alert('Failed to install service: ' + (res.error || 'Unknown error'));
      }
      await fetchStatus();
      await fetchLogs();
    } catch (err: any) {
      alert('Error: ' + err.message);
    } finally {
      setActionLoading(null);
      setTimeout(() => setSyncFeedback(null), 5000);
    }
  };

  const handleUninstallService = async () => {
    if (!window.electronAPI?.uninstallSystemService) return;
    if (!confirm('Are you sure you want to uninstall the autonomous background service? The application will fall back to in-app background thread syncing.')) {
      return;
    }
    setActionLoading('uninstall');
    try {
      const res = await window.electronAPI.uninstallSystemService();
      if (res.success) {
        setSyncFeedback('System service uninstalled. App background thread is now handling sync.');
      } else {
        alert('Failed to uninstall service: ' + (res.error || 'Unknown error'));
      }
      await fetchStatus();
      await fetchLogs();
    } catch (err: any) {
      alert('Error: ' + err.message);
    } finally {
      setActionLoading(null);
      setTimeout(() => setSyncFeedback(null), 5000);
    }
  };

  const handleTriggerSync = async () => {
    if (!window.electronAPI?.triggerBackgroundServiceSync) return;
    setActionLoading('sync');
    try {
      await window.electronAPI.triggerBackgroundServiceSync();
      setSyncFeedback('Background synchronization cycle triggered.');
      await fetchStatus();
      setTimeout(fetchLogs, 1500);
    } catch (err: any) {
      alert('Sync trigger failed: ' + err.message);
    } finally {
      setActionLoading(null);
      setTimeout(() => setSyncFeedback(null), 4000);
    }
  };

  const isServiceInstalled = serviceStatus?.isSystemServiceInstalled ?? false;
  const isRunning = serviceStatus?.isRunning ?? true;
  const isScanning = serviceStatus?.isScanningNow ?? false;

  return (
    <div style={{
      height: '100%',
      overflowY: 'auto',
      backgroundColor: 'var(--bg-base)',
      padding: '32px',
      color: 'var(--text-primary)',
    }}>
      <div style={{ maxWidth: '1000px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '28px' }}>
        
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', borderBottom: '1px solid var(--border-subtle)', paddingBottom: '20px' }}>
          <div>
            <h1 style={{ fontSize: '1.75rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '12px', margin: 0 }}>
              <Settings size={28} color="var(--accent-cyan)" />
              Application Settings & Services
            </h1>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', marginTop: '6px' }}>
              Configure autonomous background synchronization, service daemon installation, and deduplication rules.
            </p>
          </div>

          <div style={{ display: 'flex', gap: '12px' }}>
            {onOpenHelp && (
              <button
                className="btn btn-secondary"
                onClick={onOpenHelp}
                style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '9px 16px', fontWeight: 600 }}
              >
                <HelpCircle size={18} color="var(--accent-cyan)" />
                User Guide & Help
              </button>
            )}
          </div>
        </div>

        {/* Feedback Alert */}
        {syncFeedback && (
          <div style={{
            backgroundColor: 'rgba(16, 185, 129, 0.15)',
            border: '1px solid rgba(16, 185, 129, 0.4)',
            color: '#10b981',
            borderRadius: 'var(--radius-md)',
            padding: '12px 18px',
            fontSize: '0.9rem',
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            animation: 'fadeIn 0.2s ease-out',
          }}>
            <CheckCircle2 size={18} />
            <span>{syncFeedback}</span>
          </div>
        )}

        {/* Section 0: Mobile Access & Local Web Server (Wi-Fi Sharing) */}
        <div style={{
          backgroundColor: 'var(--bg-surface)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-lg)',
          padding: '24px',
          display: 'flex',
          flexDirection: 'column',
          gap: '20px',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px' }}>
            <div>
              <h2 style={{ fontSize: '1.15rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '10px', margin: 0 }}>
                <Smartphone size={20} color="var(--accent-cyan)" />
                Mobile Access & Local Web Server (Wi-Fi Sharing)
              </h2>
              <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', margin: '4px 0 0 0' }}>
                Self-host your photo collection directly from this application. When running on this PC, browse photos from your iPhone, Android, or any web browser on your Wi-Fi network!
              </p>
            </div>

            <div style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '8px',
              padding: '6px 14px',
              borderRadius: '9999px',
              fontSize: '0.82rem',
              fontWeight: 600,
              backgroundColor: webServerStatus?.isRunning ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)',
              color: webServerStatus?.isRunning ? '#10b981' : '#ef4444',
              border: `1px solid ${webServerStatus?.isRunning ? 'rgba(16, 185, 129, 0.3)' : 'rgba(239, 68, 68, 0.3)'}`,
            }}>
              <span style={{
                width: '8px',
                height: '8px',
                borderRadius: '50%',
                backgroundColor: webServerStatus?.isRunning ? '#10b981' : '#ef4444',
              }} />
              {webServerStatus?.isRunning ? `Running (Port ${webServerStatus.port})` : 'Server Stopped'}
            </div>
          </div>

          {/* Configuration Controls */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '16px' }}>
            <div>
              <label style={{ display: 'block', fontSize: '0.82rem', fontWeight: 600, marginBottom: '8px' }}>
                Self-Hosted Web Server
              </label>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px', height: '40px' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '0.9rem' }}>
                  <input
                    type="checkbox"
                    checked={webServerEnabled}
                    onChange={(e) => setWebServerEnabled(e.target.checked)}
                    style={{ width: '18px', height: '18px', accentColor: 'var(--accent-cyan)' }}
                  />
                  <span>Run Web Server automatically when app is open</span>
                </label>
              </div>
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.82rem', fontWeight: 600, marginBottom: '8px' }}>
                Server Port Configuration
              </label>
              <div style={{ display: 'flex', gap: '8px' }}>
                <input
                  type="number"
                  className="input"
                  value={webServerPortInput}
                  onChange={(e) => setWebServerPortInput(e.target.value)}
                  placeholder="5173"
                  min={1024}
                  max={65535}
                  style={{ height: '40px', width: '130px' }}
                />
                <button
                  className="btn btn-primary"
                  onClick={handleSaveWebServerSettings}
                  disabled={isUpdatingWebServer}
                  style={{ height: '40px', padding: '0 16px', fontSize: '0.85rem' }}
                >
                  {isUpdatingWebServer ? <RotateCw size={15} className="animate-spin" /> : <Check size={15} />}
                  Save & Restart
                </button>
              </div>
            </div>
          </div>

          {/* Active Connection URL for Mobile */}
          {webServerStatus?.isRunning && (
            <div style={{
              backgroundColor: 'var(--bg-surface-elevated)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-md)',
              padding: '16px',
              display: 'flex',
              flexDirection: 'column',
              gap: '12px',
            }}>
              <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Wifi size={16} color="var(--accent-cyan)" />
                📱 Connect from your Phone (Same Wi-Fi Network):
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                <div style={{
                  backgroundColor: '#0a0f1d',
                  border: '1px solid rgba(255, 255, 255, 0.1)',
                  padding: '8px 14px',
                  borderRadius: 'var(--radius-md)',
                  fontFamily: 'monospace',
                  fontSize: '0.95rem',
                  color: 'var(--accent-cyan)',
                  fontWeight: 700,
                  userSelect: 'all',
                }}>
                  {webServerStatus.primaryUrl}
                </div>

                <button
                  className="btn btn-secondary"
                  onClick={() => handleCopyMobileUrl(webServerStatus.primaryUrl)}
                  style={{ height: '36px', padding: '0 14px', fontSize: '0.8rem', gap: '6px' }}
                >
                  {copiedUrl ? <CheckCircle2 size={14} color="#10b981" /> : <Copy size={14} />}
                  {copiedUrl ? 'Copied!' : 'Copy Mobile Link'}
                </button>

                <a
                  href={webServerStatus.primaryUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn btn-ghost"
                  style={{ height: '36px', padding: '0 12px', fontSize: '0.8rem', gap: '6px' }}
                >
                  <ExternalLink size={14} />
                  Open in Browser
                </a>
              </div>

              <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', lineHeight: 1.6 }}>
                💡 <strong>iPhone Safari:</strong> Tap the <em>Share</em> icon at the bottom → tap <em>"Add to Home Screen"</em> to install as a full-screen app.<br />
                💡 <strong>Android Chrome:</strong> Tap the <em>Three Dots (⋮)</em> → tap <em>"Install App"</em> or <em>"Add to Home Screen"</em>.<br />
                📸 <strong>Apple iPhone HEIC Support:</strong> All `.heic` and `.heif` files from iPhone are automatically decoded into high-quality JPEG previews!
              </div>
            </div>
          )}

          {webServerFeedback && (
            <div style={{
              backgroundColor: 'rgba(16, 185, 129, 0.15)',
              border: '1px solid rgba(16, 185, 129, 0.4)',
              color: '#10b981',
              borderRadius: 'var(--radius-md)',
              padding: '10px 14px',
              fontSize: '0.85rem',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
            }}>
              <CheckCircle2 size={16} />
              <span>{webServerFeedback}</span>
            </div>
          )}
        </div>

        {/* Section 1: Background Service & Engine Mode */}
        <div style={{
          backgroundColor: 'var(--bg-surface)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-lg)',
          padding: '24px',
          display: 'flex',
          flexDirection: 'column',
          gap: '20px',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px' }}>
            <div>
              <h2 style={{ fontSize: '1.15rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '10px', margin: 0 }}>
                <Server size={20} color="var(--accent-cyan)" />
                Background Synchronization Engine
              </h2>
              <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginTop: '4px' }}>
                Monitors configured network storages and mirrors in the background without UI lag.
              </p>
            </div>

            {/* Status Badge */}
            <div style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '8px',
              padding: '6px 14px',
              borderRadius: '20px',
              fontSize: '0.82rem',
              fontWeight: 600,
              backgroundColor: isServiceInstalled ? 'rgba(16, 185, 129, 0.15)' : 'rgba(245, 158, 11, 0.15)',
              border: `1px solid ${isServiceInstalled ? 'rgba(16, 185, 129, 0.4)' : 'rgba(245, 158, 11, 0.4)'}`,
              color: isServiceInstalled ? '#10b981' : '#f59e0b',
            }}>
              {isServiceInstalled ? <ShieldCheck size={16} /> : <Cpu size={16} />}
              <span>{isServiceInstalled ? 'System Service Active (Autonomous)' : 'App Background Thread (Fallback)'}</span>
            </div>
          </div>

          {/* Service Mode Card */}
          <div style={{
            backgroundColor: 'var(--bg-card)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-md)',
            padding: '18px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: '16px',
            flexWrap: 'wrap',
          }}>
            <div style={{ flex: 1, minWidth: '280px' }}>
              <div style={{ fontWeight: 600, fontSize: '0.95rem', color: 'var(--text-primary)' }}>
                {isServiceInstalled ? 'Autonomous Windows Background Service' : 'Run as System Service'}
              </div>
              <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)', marginTop: '4px', lineHeight: 1.5 }}>
                {isServiceInstalled
                  ? `The autonomous daemon is registered in Windows startup registry. Process PID: ${serviceStatus?.systemServicePid || 'Detached'}. It runs 24/7 even when this window is closed.`
                  : 'Install the background service so thumbnail indexing and storage scanning run automatically on Windows boot, without requiring the main application window to remain open.'}
              </p>
            </div>

            <div>
              {isServiceInstalled ? (
                <button
                  className="btn btn-secondary"
                  onClick={handleUninstallService}
                  disabled={actionLoading === 'uninstall'}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    color: '#ef4444',
                    borderColor: 'rgba(239, 68, 68, 0.4)',
                    backgroundColor: 'rgba(239, 68, 68, 0.08)',
                  }}
                >
                  <Power size={16} />
                  {actionLoading === 'uninstall' ? 'Uninstalling...' : 'Uninstall System Service'}
                </button>
              ) : (
                <button
                  className="btn btn-primary"
                  onClick={handleInstallService}
                  disabled={actionLoading === 'install'}
                  style={{ display: 'flex', alignItems: 'center', gap: '8px' }}
                >
                  <ShieldCheck size={16} />
                  {actionLoading === 'install' ? 'Installing...' : 'Install Autonomous Service'}
                </button>
              )}
            </div>
          </div>

          {/* Sync Controls Grid */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '16px' }}>
            
            {/* Sync Interval */}
            <div style={{
              backgroundColor: 'var(--bg-card)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-md)',
              padding: '16px',
            }}>
              <label style={{ fontSize: '0.85rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                <Clock size={16} color="var(--accent-cyan)" />
                Sync Frequency
              </label>
              <select
                className="input-field"
                value={serviceStatus?.syncIntervalMinutes || 15}
                onChange={(e) => handleToggleSetting('syncIntervalMinutes', parseInt(e.target.value, 10))}
                style={{ width: '100%', padding: '8px 12px', fontSize: '0.88rem' }}
              >
                <option value={5}>Every 5 minutes</option>
                <option value={15}>Every 15 minutes (Default)</option>
                <option value={30}>Every 30 minutes</option>
                <option value={60}>Every 1 hour</option>
                <option value={360}>Every 6 hours</option>
              </select>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', display: 'block', marginTop: '6px' }}>
                Frequency for checking online network shares for new photos.
              </span>
            </div>

            {/* Tray & Close Behavior */}
            <div style={{
              backgroundColor: 'var(--bg-card)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-md)',
              padding: '16px',
            }}>
              <div style={{ fontSize: '0.85rem', fontWeight: 600, marginBottom: '10px' }}>
                Process & Tray Preferences
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '0.85rem', cursor: 'pointer', marginBottom: '8px' }}>
                <input
                  type="checkbox"
                  checked={serviceStatus?.minimizeToTray ?? true}
                  onChange={(e) => handleToggleSetting('minimizeToTray', e.target.checked)}
                />
                <span>Minimize to System Tray on window close</span>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '0.85rem', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={serviceStatus?.runAtStartup ?? false}
                  onChange={(e) => handleToggleSetting('runAtStartup', e.target.checked)}
                />
                <span>Launch at Windows user logon</span>
              </label>
            </div>
          </div>

          {/* Manual Trigger Bar */}
          <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            paddingTop: '10px',
            borderTop: '1px solid var(--border-subtle)',
            flexWrap: 'wrap',
            gap: '12px',
          }}>
            <div style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>
              Last background sync: {serviceStatus?.lastSyncTime ? new Date(serviceStatus.lastSyncTime).toLocaleString() : 'Never'}
              {isScanning && <span style={{ color: 'var(--accent-cyan)', marginLeft: '10px', fontWeight: 600 }}>• Scanning active...</span>}
            </div>

            <button
              className="btn btn-secondary"
              onClick={handleTriggerSync}
              disabled={actionLoading === 'sync' || isScanning}
              style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.85rem', padding: '8px 14px' }}
            >
              <RefreshCw size={15} className={actionLoading === 'sync' || isScanning ? 'animate-spin' : ''} />
              {isScanning ? 'Sync in Progress...' : 'Run Sync Cycle Now'}
            </button>
          </div>
        </div>

        {/* Section 2: Deduplication & AI Best-Shot Engine */}
        <div style={{
          backgroundColor: 'var(--bg-surface)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-lg)',
          padding: '24px',
          display: 'flex',
          flexDirection: 'column',
          gap: '16px',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px' }}>
            <div>
              <h2 style={{ fontSize: '1.15rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '10px', margin: 0 }}>
                <Sparkles size={20} color="var(--accent-purple)" />
                AI Deduplication & Burst Cleaner
              </h2>
              <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginTop: '4px' }}>
                Combines biometric facial matching with temporal clustering and computer vision quality heuristics.
              </p>
            </div>

            {onOpenDuplicateCleaner && (
              <button
                className="btn btn-secondary"
                onClick={onOpenDuplicateCleaner}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  borderColor: 'rgba(168, 85, 247, 0.4)',
                  color: 'var(--accent-purple)',
                }}
              >
                <Sparkles size={16} />
                Open Duplicate Cleaner
              </button>
            )}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '14px' }}>
            <div style={{
              backgroundColor: 'var(--bg-card)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-md)',
              padding: '16px',
            }}>
              <div style={{ fontWeight: 600, fontSize: '0.9rem', color: 'var(--text-primary)', marginBottom: '6px' }}>
                1. Burst & Time-Window Clustering
              </div>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', lineHeight: 1.5, margin: 0 }}>
                Photos captured within a 60-second window containing matching biometric identities are grouped into burst candidates.
              </p>
            </div>

            <div style={{
              backgroundColor: 'var(--bg-card)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-md)',
              padding: '16px',
            }}>
              <div style={{ fontWeight: 600, fontSize: '0.9rem', color: 'var(--text-primary)', marginBottom: '6px' }}>
                2. AI Best Shot Quality Scoring
              </div>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', lineHeight: 1.5, margin: 0 }}>
                Evaluates facial expression (smile detection), open vs. closed eyes, camera blur/sharpness, and resolution to elect the top photo.
              </p>
            </div>

            <div style={{
              backgroundColor: 'var(--bg-card)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-md)',
              padding: '16px',
            }}>
              <div style={{ fontWeight: 600, fontSize: '0.9rem', color: 'var(--text-primary)', marginBottom: '6px' }}>
                3. Non-Destructive Recycle Bin Trashing
              </div>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', lineHeight: 1.5, margin: 0 }}>
                Unwanted duplicates are safely moved to the Windows Recycle Bin, ensuring instant undo and preventing accidental permanent loss.
              </p>
            </div>
          </div>
        </div>

        {/* Section 3: Live Service Activity Logs */}
        <div style={{
          backgroundColor: 'var(--bg-surface)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-lg)',
          padding: '24px',
          display: 'flex',
          flexDirection: 'column',
          gap: '16px',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h2 style={{ fontSize: '1.15rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '10px', margin: 0 }}>
              <Terminal size={20} color="var(--accent-cyan)" />
              Service & Background Activity Logs
            </h2>

            <button
              className="btn btn-ghost btn-icon"
              onClick={fetchLogs}
              title="Refresh logs"
              style={{ width: '32px', height: '32px' }}
            >
              <RotateCw size={16} className={logsLoading ? 'animate-spin' : ''} />
            </button>
          </div>

          <div style={{
            backgroundColor: '#0a0f1d',
            border: '1px solid rgba(255, 255, 255, 0.08)',
            borderRadius: 'var(--radius-md)',
            padding: '16px',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
            fontSize: '0.78rem',
            color: '#94a3b8',
            maxHeight: '220px',
            overflowY: 'auto',
            lineHeight: 1.6,
          }}>
            {logs.length === 0 ? (
              <div style={{ color: 'var(--text-muted)' }}>No logs recorded yet.</div>
            ) : (
              logs.map((line, idx) => (
                <div key={idx} style={{
                  color: line.includes('Error') ? '#ef4444' : line.includes('installed') || line.includes('completed') ? '#10b981' : '#cbd5e1',
                  wordBreak: 'break-all',
                }}>
                  {line}
                </div>
              ))
            )}
          </div>
        </div>

        {/* Card: AI Search Assistant & LLM Configuration */}
        <div style={{
          backgroundColor: 'var(--bg-surface)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-lg)',
          padding: '24px',
          display: 'flex',
          flexDirection: 'column',
          gap: '20px',
        }}>
          <div>
            <h2 style={{ fontSize: '1.15rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '10px', margin: '0 0 4px 0' }}>
              <Sparkles size={20} color="#a855f7" />
              AI Photo Search & LLM Configuration
            </h2>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', margin: 0 }}>
              Configure your Google Gemini or OpenAI API keys to enable conversational photo searching, person combinations, and memory finding.
            </p>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '16px' }}>
            <div>
              <label style={{ display: 'block', fontSize: '0.82rem', fontWeight: 600, marginBottom: '6px' }}>
                AI Search Provider
              </label>
              <select
                className="input"
                value={aiConfig.provider}
                onChange={(e) => setAiConfig({ ...aiConfig, provider: e.target.value as AiProvider })}
                style={{ height: '40px', width: '100%' }}
              >
                <option value="local">Smart Rule-based NLP Engine (Offline, No Key)</option>
                <option value="gemini">Google Gemini API (Recommended, Fast & Free tier)</option>
                <option value="openai">OpenAI ChatGPT API (GPT-4o mini)</option>
              </select>
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.82rem', fontWeight: 600, marginBottom: '6px' }}>
                Google Gemini API Key
              </label>
              <input
                type="password"
                className="input"
                placeholder="AIzaSy..."
                value={aiConfig.geminiApiKey}
                onChange={(e) => setAiConfig({ ...aiConfig, geminiApiKey: e.target.value })}
                style={{ height: '40px', width: '100%' }}
              />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.82rem', fontWeight: 600, marginBottom: '6px' }}>
                OpenAI API Key
              </label>
              <input
                type="password"
                className="input"
                placeholder="sk-proj-..."
                value={aiConfig.openaiApiKey}
                onChange={(e) => setAiConfig({ ...aiConfig, openaiApiKey: e.target.value })}
                style={{ height: '40px', width: '100%' }}
              />
            </div>
          </div>

          {aiFeedback && (
            <div style={{
              padding: '10px 16px',
              borderRadius: 'var(--radius-md)',
              backgroundColor: 'rgba(16, 185, 129, 0.15)',
              border: '1px solid rgba(16, 185, 129, 0.3)',
              color: 'var(--accent-emerald)',
              fontSize: '0.85rem',
              fontWeight: 600,
            }}>
              {aiFeedback}
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
            <button
              className="btn btn-primary"
              onClick={() => {
                aiSearchService.saveConfig(aiConfig);
                setAiFeedback('✓ AI Configuration saved successfully! Settings are active for AI Chatbot.');
                setTimeout(() => setAiFeedback(null), 4000);
              }}
              style={{ padding: '8px 24px', fontSize: '0.85rem' }}
            >
              Save AI Settings
            </button>
          </div>
        </div>

        {/* Library Data Backup & Export in .zip format Card */}
        <div style={{
          backgroundColor: 'var(--bg-surface)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-lg)',
          padding: '24px',
          display: 'flex',
          flexDirection: 'column',
          gap: '18px',
        }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px' }}>
            <div>
              <h2 style={{ fontSize: '1.15rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '10px', margin: '0 0 4px 0' }}>
                <Archive size={20} color="var(--accent-primary)" />
                Library Data Backup (.zip Archive)
              </h2>
              <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', margin: 0, maxWidth: '680px' }}>
                Create a full offline backup of your photo library database, recognized face profiles, albums, custom locations, and settings in a single compressed .zip file.
              </p>
            </div>

            <button
              className="btn btn-primary"
              onClick={handleCreateZipBackup}
              disabled={isBackingUp}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '10px 22px',
                fontSize: '0.88rem',
                fontWeight: 600,
                backgroundColor: 'var(--accent-primary)',
              }}
            >
              {isBackingUp ? (
                <>
                  <RefreshCw size={16} className="animate-spin" />
                  <span>Creating .zip Backup...</span>
                </>
              ) : (
                <>
                  <FolderDown size={18} />
                  <span>Create Backup (.zip)</span>
                </>
              )}
            </button>
          </div>

          {backupFeedback && (
            <div style={{
              padding: '12px 18px',
              borderRadius: 'var(--radius-md)',
              backgroundColor: 'rgba(16, 185, 129, 0.15)',
              border: '1px solid rgba(16, 185, 129, 0.3)',
              color: 'var(--accent-emerald)',
              fontSize: '0.88rem',
              fontWeight: 600,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
              gap: '10px',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <CheckCircle2 size={18} />
                <span>{backupFeedback}</span>
              </div>

              {backupResult?.filePath && window.electronAPI?.openItemInFolder && (
                <button
                  className="btn btn-secondary"
                  onClick={() => window.electronAPI!.openItemInFolder(backupResult.filePath!)}
                  style={{ fontSize: '0.78rem', padding: '4px 10px', height: 'auto' }}
                >
                  Show in Explorer
                </button>
              )}
            </div>
          )}

          {backupResult && (
            <div style={{
              display: 'flex',
              gap: '16px',
              padding: '12px 16px',
              backgroundColor: 'var(--bg-app)',
              borderRadius: 'var(--radius-md)',
              border: '1px solid var(--border-subtle)',
              fontSize: '0.8rem',
              color: 'var(--text-muted)',
              flexWrap: 'wrap',
            }}>
              <span>Backed up: <strong style={{ color: 'var(--text-primary)' }}>{backupResult.totalPhotos || 0}</strong> photos</span>
              <span>•</span>
              <span>People: <strong style={{ color: 'var(--text-primary)' }}>{backupResult.totalPeople || 0}</strong></span>
              <span>•</span>
              <span>Albums: <strong style={{ color: 'var(--text-primary)' }}>{backupResult.totalAlbums || 0}</strong></span>
              <span>•</span>
              <span>Archive Size: <strong style={{ color: 'var(--accent-cyan)' }}>{((backupResult.fileSize || 0) / 1024).toFixed(1)} KB</strong></span>
            </div>
          )}
        </div>

      </div>
    </div>
  );
};
