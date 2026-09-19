import { app, ipcMain } from 'electron';
import fs from 'fs';
import path from 'path';

// Diagnostic-only module: detects when the main process event loop stalls
// (the actual cause of Windows "Not Responding") and attributes the stall to
// whichever IPC handler was in flight, without changing any behavior. Enable
// during testing to get hard evidence of which action froze the app instead
// of guessing from symptoms.

interface InFlightCall {
  channel: string;
  startedAt: number;
}

const inFlight = new Map<number, InFlightCall>();
let callSeq = 0;
let logFilePath: string | null = null;

function getLogFilePath(): string {
  if (!logFilePath) {
    const dir = path.join(app.getPath('userData'), 'logs');
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {}
    logFilePath = path.join(dir, 'hang-watchdog.log');
  }
  return logFilePath;
}

function writeLog(line: string): void {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  console.warn(stamped);
  try {
    fs.appendFileSync(getLogFilePath(), stamped + '\n', 'utf-8');
  } catch {}
}

function describeInFlight(now: number): string {
  const active = [...inFlight.values()]
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((c) => `${c.channel} (running ${now - c.startedAt}ms)`);
  return active.length > 0
    ? active.join(', ')
    : 'none tracked via IPC — likely startup work, a native call (execSync/DatabaseSync/sharp), or GC, not an ipcMain.handle';
}

/**
 * Installs a self-correcting timer that measures drift between the expected
 * and actual tick time. A blocked event loop makes the timer fire late by
 * roughly the blocked duration. Must be called before any ipcMain.handle()
 * registrations so it can wrap them all and report which one was running.
 */
export function installHangWatchdog(options?: { lagThresholdMs?: number; checkIntervalMs?: number }): void {
  const lagThresholdMs = options?.lagThresholdMs ?? 300;
  const checkIntervalMs = options?.checkIntervalMs ?? 200;

  const originalHandle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = ((channel: string, listener: (...args: any[]) => any) => {
    return originalHandle(channel, async (...args: any[]) => {
      const id = ++callSeq;
      inFlight.set(id, { channel, startedAt: Date.now() });
      try {
        return await listener(...args);
      } finally {
        inFlight.delete(id);
      }
    });
  }) as typeof ipcMain.handle;

  let expected = Date.now() + checkIntervalMs;
  const tick = () => {
    const now = Date.now();
    const drift = now - expected;
    if (drift > lagThresholdMs) {
      writeLog(`MAIN PROCESS STALL: blocked for ~${drift}ms. In-flight IPC handlers: ${describeInFlight(now)}`);
    }
    expected = now + checkIntervalMs;
    setTimeout(tick, checkIntervalMs);
  };
  setTimeout(tick, checkIntervalMs);

  writeLog(`Hang watchdog installed (lag threshold ${lagThresholdMs}ms). Log file: ${getLogFilePath()}`);
}

/** Attaches Electron's built-in renderer hang detection with diagnostic context. */
export function attachRendererHangDetection(win: Electron.BrowserWindow, label: string): void {
  win.webContents.on('unresponsive', () => {
    writeLog(`RENDERER UNRESPONSIVE: window "${label}" stopped responding to input. In-flight IPC handlers: ${describeInFlight(Date.now())}`);
  });
  win.webContents.on('responsive', () => {
    writeLog(`RENDERER RECOVERED: window "${label}" is responsive again.`);
  });
}

export function getHangWatchdogLogPath(): string {
  return getLogFilePath();
}
