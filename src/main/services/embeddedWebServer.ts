import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { app } from 'electron';
import {
  getHeicJpegBuffer,
  getOrGenerateHeicThumbnail500,
  getHeicHighQualityJpegBuffer,
  prepareHeicHqTemp,
  cleanupHeicHqTemp,
} from './heicService';
import { scanVirtualMirrorDirectory, syncVirtualStorage, deleteFilesPermanently, trashFiles, rotatePhotoFile, rotatePhotoWithOfflineQueue, processPendingRotations, discoverStoredMirrors, scanStorageInventory } from './virtualMirrorService';
import { scanPhotoDirectory } from './fileOrganizer';
import { getOrGenerateCachedThumbnail, clearThumbnailCache, refreshThumbnailsFromSource } from './thumbnailCacheService';
import { getCatalogMeta, getCatalogPage, switchCatalogLibrary, ensureMigratedIfEmpty } from './catalogService';
import { handleStorageSave, handleStorageLoad, STORAGE_KEY, GLOBAL_PEOPLE_KEY } from './storageHandlers';
import { sendFileStream } from './fileStream';
import { isPathAllowedRemote, isSafeRelativeName, getDefaultMirrorRoot } from './pathSecurity';
import { browseDirectory } from './directoryBrowser';
import { getSpriteCoordinate, getSpriteCoordinatesBatch, getSpritePath } from './spriteService';
import { thumbnailWorker } from './thumbnailWorkerService';
import { getBackgroundServiceStatus } from './backgroundDaemon';
import { isPathReachable, clearOfflineCache } from './networkReachabilityCache';
import { detectFacesForPhoto, resolveDbForPhoto } from './pipelineOrchestrator';
import { getFacesForPhoto, getAllPeople } from './libraryRepository';
import { WebServerStatus, Photo } from '../../types';
import {
  verifyPin,
  createSessionToken,
  validateToken,
  isLockedOut,
  lockoutRetrySeconds,
  recordFailedAttempt,
  clearFailedAttempts,
} from './webAuthService';

let serverInstance: http.Server | null = null;
let activePort: number = 5173;
let isServerRunning: boolean = false;
let serverEnabled: boolean = true;
let serverError: string | undefined = undefined;
// The port the caller asked for (activePort can differ after an in-use fallback).
let requestedPort: number = 5173;
// Serializes start/stop so concurrent settings saves can't leak a second listening server.
let startChain: Promise<unknown> = Promise.resolve();

const MIN_PORT = 1024;
const MAX_PORT = 65535;
const PORT_FALLBACK_TRIES = 10;
function isValidPort(p: unknown): p is number {
  return typeof p === 'number' && Number.isInteger(p) && p >= MIN_PORT && p <= MAX_PORT;
}

// Request body limits (bytes). /api/auth/pair is unauthenticated, so it gets a tiny cap.
const MAX_BODY_PAIR = 4 * 1024;
const MAX_BODY_DEFAULT = 128 * 1024 * 1024;

// Only real image formats may be served by /api/photo (no .html/.svg/.js from a library folder).
const SERVABLE_IMAGE_EXTS = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.heic', '.heif', '.tiff', '.tif', '.avif',
  '.dng', '.raw', '.cr2', '.nef',
]);

const MIN_THUMB_SIZE = 32;
const MAX_THUMB_SIZE = 2048;
function clampThumbSize(n: unknown, fallback: number): number {
  const v = typeof n === 'number' ? n : NaN;
  if (!Number.isFinite(v) || v <= 0) return fallback;
  return Math.min(MAX_THUMB_SIZE, Math.max(MIN_THUMB_SIZE, Math.floor(v)));
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Reads a request body as UTF-8 (Buffer.concat, so multi-byte chars split across chunks survive) with a size cap. */
function readBody(req: http.IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const declared = parseInt(String(req.headers['content-length'] || '0'), 10);
    if (declared > limit) {
      reject(new HttpError(413, 'Request body too large'));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      reject(err);
    };
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        fail(new HttpError(413, 'Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (err) => fail(err));
    req.on('close', () => fail(new HttpError(400, 'Request closed before the body was received')));
  });
}

function sendJsonError(res: http.ServerResponse, err: any): void {
  const status = err instanceof HttpError ? err.status : 500;
  if (res.writableEnded || res.destroyed) return;
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  if (status === 413) {
    // The client is still sending: answer, then drop the connection instead of draining it.
    res.setHeader('Connection', 'close');
    res.end(JSON.stringify({ error: err.message }), () => res.socket?.destroy());
    return;
  }
  res.end(JSON.stringify({ error: err?.message || 'Internal Server Error' }));
}

/**
 * Reads the request body (size-capped) then runs `handler` with it. Any read
 * failure or error the handler lets escape becomes a JSON error response
 * instead of an unhandled rejection inside a bare req.on('end', async ...).
 */
function withBody(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  limit: number,
  handler: (body: string) => Promise<void> | void
): void {
  readBody(req, limit)
    .then((body) => handler(body))
    .catch((err) => {
      if (!(err instanceof HttpError)) console.warn('[EmbeddedWebServer] Request handler error:', err);
      sendJsonError(res, err);
    });
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.bin': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

// 1. Detect active non-internal IPv4 network interfaces
export function getNetworkIps(): Array<{ name: string; address: string }> {
  const ips: Array<{ name: string; address: string }> = [];
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        ips.push({ name, address: iface.address });
      }
    }
  }
  return ips;
}

// 2. Settings path for web server config
function getSettingsPath(): string {
  const appData =
    process.env.APPDATA ||
    (process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library/Application Support')
      : path.join(os.homedir(), '.config'));
  return path.join(appData, 'gPhotos', 'webserver_settings.json');
}

export function loadSavedWebServerSettings(): { enabled: boolean; port: number } {
  try {
    const p = getSettingsPath();
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      const port = parseInt(data.port || '5173', 10);
      return {
        enabled: data.enabled !== false,
        port: isValidPort(port) ? port : 5173,
      };
    }
  } catch {}
  return { enabled: true, port: 5173 };
}

export function saveWebServerSettings(settings: { enabled: boolean; port: number }): void {
  try {
    const p = getSettingsPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(settings, null, 2), 'utf8');
  } catch (err) {
    console.warn('Failed to save webserver settings:', err);
  }
}

/**
 * Rejects a request whose path parameter(s) fall outside the app's known
 * library/mirror roots. Applied to every route on this LAN-facing server
 * that accepts a filesystem path — a paired phone/device is a lower-trust
 * client than the desktop app's own renderer, so this server confines it to
 * the user's actual photo folders rather than the whole host filesystem.
 * Returns true (and has already written the 403 response) if rejected.
 */
/** First entry that is not a non-empty image-file path (or is a directory); null when all are fine. */
async function firstInvalidDeleteTarget(paths: unknown[]): Promise<unknown | null> {
  for (const p of paths) {
    if (typeof p !== 'string' || !p.trim() || !SERVABLE_IMAGE_EXTS.has(path.extname(p).toLowerCase())) return p;
    try {
      if ((await fs.promises.stat(p)).isDirectory()) return p;
    } catch {
      // missing/unreachable: reported per file by the delete helpers
    }
  }
  return null;
}

function rejectIfPathNotAllowed(res: http.ServerResponse, candidatePaths: Array<string | null | undefined>, context: string): boolean {
  for (const p of candidatePaths) {
    if (p && !isPathAllowedRemote(p)) {
      res.statusCode = 403;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: `Access denied: path is outside the app's known library/mirror folders (${context}).` }));
      return true;
    }
  }
  return false;
}

/**
 * True if a client-supplied Photo object only references known folders:
 * filePath (required), originalRemotePath (if any), and — for a virtual photo —
 * the mirror folder the per-library DB would be opened/created in (mirrors the
 * derivation in db.ts resolveDbForPhoto).
 */
function isPhotoRequestAllowed(photo: any): boolean {
  if (!photo || typeof photo !== 'object') return false;
  if (!isPathAllowedRemote(photo.filePath)) return false;
  if (photo.originalRemotePath && !isPathAllowedRemote(photo.originalRemotePath)) return false;
  if (photo.isVirtual && photo.storageName) {
    if (!isSafeRelativeName(photo.storageName)) return false;
    const segments = String(photo.filePath).split(/[\\/]+/);
    const idx = segments.findIndex((s) => s.toLowerCase() === String(photo.storageName).toLowerCase());
    if (idx !== -1 && !isPathAllowedRemote(segments.slice(0, idx + 1).join(path.sep))) return false;
  }
  return true;
}

// Request handler for all HTTP requests
async function handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  // Never let a browser sniff a served file into something executable.
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url || '/', `http://localhost:${activePort}`);
  const pathname = parsedUrl.pathname;

  // Endpoint: /api/status
  if (pathname === '/api/status') {
    res.setHeader('Content-Type', 'application/json');
    // Public endpoint: don't expose the internal error text (can contain paths).
    res.end(JSON.stringify({ ...getEmbeddedWebServerStatus(), error: undefined }));
    return;
  }

  // Endpoint: /api/auth/status — always public, lets the client know a PIN is required.
  // (No side effects: the PIN is created lazily by Settings / the first pairing attempt.)
  if (pathname === '/api/auth/status') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ pinRequired: true }));
    return;
  }

  // Endpoint: /api/auth/pair — public, exchanges a valid PIN for a session token
  if (pathname === '/api/auth/pair' && req.method === 'POST') {
    const clientIp = req.socket.remoteAddress || 'unknown';
    withBody(req, res, MAX_BODY_PAIR, (body) => {
      res.setHeader('Content-Type', 'application/json');
      if (isLockedOut(clientIp)) {
        const wait = lockoutRetrySeconds(clientIp);
        res.statusCode = 429;
        if (wait > 0) res.setHeader('Retry-After', String(wait));
        res.end(JSON.stringify({
          error: wait > 60
            ? `Too many failed attempts. Try again in ${Math.ceil(wait / 60)} minutes, or generate a new PIN in gPhotos Settings.`
            : `Too many failed attempts. Try again in ${Math.max(1, wait)} seconds.`,
        }));
        return;
      }
      let parsed: any;
      try {
        parsed = JSON.parse(body || '{}') || {};
      } catch (err: any) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: err.message }));
        return;
      }
      const { pin, deviceLabel } = parsed;
      if (!verifyPin(pin)) {
        recordFailedAttempt(clientIp);
        res.statusCode = 401;
        res.end(JSON.stringify({ error: 'Incorrect PIN' }));
        return;
      }
      clearFailedAttempts(clientIp);
      try {
        const { token } = createSessionToken(deviceLabel || 'Unknown device');
        res.end(JSON.stringify({ token }));
      } catch (err: any) {
        // e.g. the pairing couldn't be saved to disk — tell the phone instead of issuing a token that won't persist.
        res.statusCode = 500;
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // All other /api/* routes require a valid paired-device session token.
  if (pathname.startsWith('/api/')) {
    const authHeader = req.headers['authorization'] || '';
    const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    const queryToken = parsedUrl.searchParams.get('token') || '';
    const token = bearerToken || queryToken;
    if (!validateToken(token)) {
      res.statusCode = 401;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'unauthorized', pinRequired: true }));
      return;
    }
  }

  // Endpoint: /api/auth/verify — reaching here means the gate above already validated the token
  if (pathname === '/api/auth/verify') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ valid: true }));
    return;
  }

  // Endpoint: /api/library?libraryDir=...
  if (pathname === '/api/library') {
    if (req.method === 'GET') {
      const libraryDir = parsedUrl.searchParams.get('libraryDir') || undefined;
      if (libraryDir && rejectIfPathNotAllowed(res, [libraryDir], '/api/library')) return;
      try {
        ensureMigratedIfEmpty();
        const libraryData = (await handleStorageLoad(STORAGE_KEY, libraryDir)) || { photos: [], people: [], faces: [], albums: [] };
        const peopleRegistry = await handleStorageLoad(GLOBAL_PEOPLE_KEY);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ [STORAGE_KEY]: libraryData, [GLOBAL_PEOPLE_KEY]: peopleRegistry }));
      } catch (err: any) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    } else if (req.method === 'POST') {
      withBody(req, res, MAX_BODY_DEFAULT, (body) => {
        try {
          const { key, data } = JSON.parse(body);
          // isRemote: a paired device must not be able to change selectedFolder /
          // recentLibraries / virtual-storage roots (they define what this server trusts).
          const result = handleStorageSave(key, data, { isRemote: true });
          if (result.enqueuePhotos) {
            thumbnailWorker.enqueuePhotos(result.enqueuePhotos, result.enqueueLibraryPath || undefined);
          }
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ success: result.success }));
        } catch (err: any) {
          res.statusCode = /^Access denied|cannot be written over the network/.test(err?.message || '') ? 403 : 500;
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }
  }

  // Endpoint: /api/scan?path=...
  if (pathname === '/api/scan') {
    const targetDir = parsedUrl.searchParams.get('path');
    if (rejectIfPathNotAllowed(res, [targetDir], '/api/scan')) return;
    if (targetDir && fs.existsSync(targetDir)) {
      try {
        const photos = await scanPhotoDirectory(targetDir);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(photos));
        return;
      } catch (err: any) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: err.message }));
        return;
      }
    } else {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'Invalid or missing directory path' }));
      return;
    }
  }

  // Endpoint: /api/scan-mirror?path=...
  if (pathname === '/api/scan-mirror') {
    const mirrorPath = parsedUrl.searchParams.get('path');
    if (rejectIfPathNotAllowed(res, [mirrorPath], '/api/scan-mirror')) return;
    if (mirrorPath && fs.existsSync(mirrorPath)) {
      try {
        const photos = await scanVirtualMirrorDirectory(mirrorPath);
        if (photos && photos.length > 0) {
          thumbnailWorker.enqueuePhotos(photos);
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(photos));
        return;
      } catch (err: any) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: err.message }));
        return;
      }
    } else {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'Invalid or missing mirror directory path' }));
      return;
    }
  }

  // Endpoint: /api/scan-storage-inventory?path=... — the mobile/LAN
  // counterpart of the mirror:scan-inventory IPC channel. Without this,
  // adding a network storage from the mobile/web UI silently never started
  // syncing: ensureInventoryCompleted() in VirtualStorageView.tsx treats a
  // missing scanStorageInventory capability as "not completed yet" and the
  // caller bails out rather than proceeding, with no error shown.
  if (pathname === '/api/scan-storage-inventory') {
    const sourcePath = parsedUrl.searchParams.get('path');
    if (rejectIfPathNotAllowed(res, [sourcePath], '/api/scan-storage-inventory')) return;
    try {
      const result = await scanStorageInventory(sourcePath || '');
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(result));
    } catch (err: any) {
      res.statusCode = 500;
      res.end(JSON.stringify({ status: 'failed', totalFiles: 0, error: err.message }));
    }
    return;
  }

  // Endpoint: /api/sync-virtual-storage (POST)
  if (pathname === '/api/sync-virtual-storage' && req.method === 'POST') {
    withBody(req, res, MAX_BODY_DEFAULT, async (body) => {
      try {
        const config = JSON.parse(body);
        // The config comes straight from the client: confine both roots to the
        // known folders and make sure `name` can't climb out of localMirrorRoot.
        if (
          !config ||
          typeof config.localMirrorRoot !== 'string' ||
          !isSafeRelativeName(config.name) ||
          (config.networkSourcePath !== undefined && typeof config.networkSourcePath !== 'string')
        ) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Invalid storage configuration' }));
          return;
        }
        if (rejectIfPathNotAllowed(res, [config.networkSourcePath, config.localMirrorRoot], '/api/sync-virtual-storage')) return;
        // A manual sync IS the user explicitly asking to check this storage
        // again — see the matching comment on the Electron IPC equivalent
        // (mirror:sync-storage in main.ts) for why this only happens here,
        // not from the periodic background sync cycle.
        if (config?.networkSourcePath) {
          clearOfflineCache(config.networkSourcePath);
        }
        const result = await syncVirtualStorage(config);
        try {
          const mirrorPath = path.join(config.localMirrorRoot, config.name);
          const photos = await scanVirtualMirrorDirectory(mirrorPath);
          if (photos && photos.length > 0) {
            thumbnailWorker.enqueuePhotos(photos);
          }
        } catch {}
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(result));
      } catch (err: any) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Endpoint: /api/faces/detect-batch (POST) — the mobile/LAN counterpart of
  // the faces:detect-batch IPC channel. Without this, runFaceDetectionForPhotos
  // in App.tsx checks `window.electronAPI?.detectFacesBatch` and silently
  // returns when it's missing — so photos synced from the mobile/web UI got
  // thumbnails but face detection never ran, with no error surfaced anywhere.
  if (pathname === '/api/faces/detect-batch' && req.method === 'POST') {
    withBody(req, res, MAX_BODY_DEFAULT, async (body) => {
      try {
        const photos: Photo[] = JSON.parse(body);
        if (!Array.isArray(photos)) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Expected an array of photos' }));
          return;
        }
        const results: Array<{ photoId: string; ran: boolean; faceCount: number; locked: boolean; skippedReason?: string; faces: any[] }> = [];
        for (const photo of photos) {
          try {
            // Paths come from the client: never decode / open a DB for anything outside the known folders.
            // (Reported with the existing 'decode-failed' reason so the client contract is unchanged.)
            if (!isPhotoRequestAllowed(photo)) {
              results.push({ photoId: photo?.id, ran: false, faceCount: 0, locked: false, skippedReason: 'decode-failed', faces: [] });
              continue;
            }
            const sourceFilePath = photo.isVirtual ? (photo.originalRemotePath || photo.filePath) : photo.filePath;
            const db = resolveDbForPhoto(photo);
            const result = await detectFacesForPhoto(photo, sourceFilePath!, db);
            results.push({ photoId: photo.id, ...result, faces: getFacesForPhoto(photo.id, db) });
          } catch (err: any) {
            results.push({ photoId: photo.id, ran: false, faceCount: 0, locked: false, skippedReason: 'decode-failed', faces: [] });
          }
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ results, people: getAllPeople() }));
      } catch (err: any) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Endpoint: /api/precache-status (GET)
  if (pathname === '/api/precache-status') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(thumbnailWorker.getStatus()));
    return;
  }

  // Endpoint: /api/background-service-status (GET)
  if (pathname === '/api/background-service-status') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(getBackgroundServiceStatus()));
    return;
  }

  // Endpoint: /api/start-precache (POST)
  if (pathname === '/api/start-precache' && req.method === 'POST') {
    withBody(req, res, MAX_BODY_DEFAULT, (body) => {
      try {
        const { photos } = JSON.parse(body || '{}');
        const safePhotos = Array.isArray(photos) ? photos.filter(isPhotoRequestAllowed) : [];
        if (safePhotos.length > 0) {
          thumbnailWorker.enqueuePhotos(safePhotos);
        }
        thumbnailWorker.resume();
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ started: true }));
      } catch (err: any) {
        res.statusCode = 500;
        res.end(JSON.stringify({ started: false, error: err.message }));
      }
    });
    return;
  }

  // Endpoint: /api/pause-precache (POST)
  if (pathname === '/api/pause-precache' && req.method === 'POST') {
    thumbnailWorker.pause();
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ paused: true }));
    return;
  }

  // Endpoint: /api/thumbnails/refresh-from-source (POST)
  if (pathname === '/api/thumbnails/refresh-from-source' && (req.method === 'POST' || req.method === 'OPTIONS')) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }
    withBody(req, res, MAX_BODY_DEFAULT, async (body) => {
      try {
        const { items } = JSON.parse(body || '{}');
        // filePath is written to, so it must be allowed; an out-of-bounds originalRemotePath is dropped.
        const safeItems = (Array.isArray(items) ? items : [])
          .filter((item: any) => item && isPathAllowedRemote(item.filePath))
          .map((item: any) => ({
            ...item,
            originalRemotePath: isPathAllowedRemote(item.originalRemotePath) ? item.originalRemotePath : undefined,
          }));
        const result = await refreshThumbnailsFromSource(safeItems);
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.end(JSON.stringify(result));
      } catch (err: any) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.end(JSON.stringify({ refreshedCount: 0, errors: [err.message] }));
      }
    });
    return;
  }

  // Endpoint: /api/batch-thumbnails (POST) - Fetch up to 100 thumbnails in one single async request
  if (pathname === '/api/batch-thumbnails' && req.method === 'POST') {
    withBody(req, res, MAX_BODY_DEFAULT, async (body) => {
      try {
        const { items, size } = JSON.parse(body || '{}');
        const targetSize = clampThumbSize(size, 250);
        // Every path that will actually be opened must be allowed: `path` is required to be,
        // an out-of-bounds originalPath is dropped (never falls back to it).
        const requestedItems: Array<{ path: string; originalPath?: string }> = Array.isArray(items)
          ? items
              .slice(0, 100) // Cap at 100 items per batch
              .filter((item: any) => item && isPathAllowedRemote(item.path))
              .map((item: any) => ({
                path: item.path as string,
                originalPath: isPathAllowedRemote(item.originalPath) ? (item.originalPath as string) : undefined,
              }))
          : [];

        const thumbnails: Record<string, string> = {};

        // Fetch/generate thumbnails concurrently without blocking
        await Promise.all(
          requestedItems.map(async (item) => {
            if (!item || !item.path) return;
            const targetPath = (item.path && fs.existsSync(item.path))
              ? item.path
              : (item.originalPath && fs.existsSync(item.originalPath) ? item.originalPath : null);

            if (!targetPath) return;

            try {
              const resThumb = await getOrGenerateCachedThumbnail(targetPath, targetSize);
              if (resThumb) {
                let buf: Buffer | null = resThumb.buffer || null;
                if (!buf && resThumb.filePath) {
                  buf = await fs.promises.readFile(resThumb.filePath);
                }
                if (buf) {
                  thumbnails[item.path] = `data:${resThumb.mime || 'image/jpeg'};base64,${buf.toString('base64')}`;
                }
              }
            } catch {}
          })
        );

        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify({ thumbnails }));
      } catch (err: any) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Endpoint: /api/delete-files (POST) - Delete files (Recycle Bin or permanently)
  if (pathname === '/api/delete-files' && req.method === 'POST') {
    withBody(req, res, MAX_BODY_DEFAULT, async (body) => {
      try {
        const { filePaths, permanent } = JSON.parse(body || '{}');
        const paths = Array.isArray(filePaths) ? filePaths : [];
        if (rejectIfPathNotAllowed(res, paths, '/api/delete-files')) return;
        // Only individual image files: never a directory (an allowed root itself passes the path
        // gate), an empty entry, or a non-image file. A path that no longer exists is left to
        // trashFiles/deleteFilesPermanently, which already report it per file.
        const invalid = await firstInvalidDeleteTarget(paths);
        if (invalid !== null) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ success: false, error: `Refusing to delete "${String(invalid).slice(0, 200)}": only image files can be deleted.` }));
          return;
        }
        const result = permanent
          ? await deleteFilesPermanently(paths)
          : await trashFiles(paths);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(result));
      } catch (err: any) {
        res.statusCode = 500;
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // Endpoint: /api/rotate-photo (POST) - Physically rotate image file on disk (with offline queue durability)
  if (pathname === '/api/rotate-photo' && req.method === 'POST') {
    withBody(req, res, MAX_BODY_DEFAULT, async (body) => {
      try {
        const { filePath, rotationDegrees, originalRemotePath } = JSON.parse(body || '{}');
        if (rejectIfPathNotAllowed(res, [filePath, originalRemotePath], '/api/rotate-photo')) return;
        const result = await rotatePhotoWithOfflineQueue({
          localFilePath: filePath,
          originalRemotePath,
          rotationDegrees: rotationDegrees || 90,
        });
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(result));
      } catch (err: any) {
        res.statusCode = 500;
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // Endpoint: /api/process-pending-rotations (POST) - Drain pending rotation queue
  if (pathname === '/api/process-pending-rotations' && req.method === 'POST') {
    try {
      const result = await processPendingRotations();
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(result));
    } catch (err: any) {
      res.statusCode = 500;
      res.end(JSON.stringify({ processed: 0, remaining: 0, error: err.message }));
    }
    return;
  }

  // Endpoint: /api/catalog-meta - Pre-computed lightweight index (<20 KB)
  if (pathname === '/api/catalog-meta') {
    try {
      const meta = await getCatalogMeta();
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'public, max-age=60');
      res.end(JSON.stringify(meta));
      return;
    } catch (err: any) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: err.message }));
      return;
    }
  }

  // Endpoint: /api/catalog-page?page=0&size=100&libraryDir=...
  if (pathname === '/api/catalog-page') {
    const pageIndex = parseInt(parsedUrl.searchParams.get('page') || '0', 10);
    const pageSize = parseInt(parsedUrl.searchParams.get('size') || '100', 10);
    const libraryDir = parsedUrl.searchParams.get('libraryDir') || undefined;
    if (libraryDir && rejectIfPathNotAllowed(res, [libraryDir], '/api/catalog-page')) return;
    try {
      const pageData = await getCatalogPage(pageIndex, pageSize, libraryDir);
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.end(JSON.stringify(pageData));
      return;
    } catch (err: any) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: err.message }));
      return;
    }
  }

  // Endpoint: /api/switch-library (POST)
  if (pathname === '/api/switch-library' && req.method === 'POST') {
    withBody(req, res, MAX_BODY_DEFAULT, async (body) => {
      try {
        const { targetPath } = JSON.parse(body);
        if (!targetPath || typeof targetPath !== 'string') {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'targetPath required' }));
          return;
        }
        // Gated to folders the app already trusts (a known library/storage
        // root or something under one). switchCatalogLibrary persists
        // targetPath as selectedFolder/recentLibraries, which feed the
        // allowed-roots list — leaving this open let a paired device add e.g.
        // C:\ as a trusted root and then read/delete anything under it.
        // A brand-new library outside every known root must be opened once
        // from the desktop app.
        if (rejectIfPathNotAllowed(res, [targetPath], '/api/switch-library')) return;
        const result = await switchCatalogLibrary(targetPath);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(result));
      } catch (err: any) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Endpoint: /api/browse-directory?path=... — lets the mobile/LAN client
  // browse the host's own folder structure (directory NAMES only, never
  // file contents) to build a real folder-picker dialog, since a browser has
  // no native OS folder dialog of its own. Deliberately NOT gated by
  // rejectIfPathNotAllowed — restricting it to already-known paths would
  // make it useless for its one job, discovering folders that aren't known
  // yet. This is the same visibility a native folder dialog already gives
  // any local user of this machine; it's just reachable from a
  // PIN-authenticated paired device instead of only in front of the screen.
  if (pathname === '/api/browse-directory') {
    const targetPath = parsedUrl.searchParams.get('path') || undefined;
    try {
      const result = browseDirectory(targetPath);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(result));
    } catch (err: any) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Endpoint: /api/sprites/:id.webp - Stream pre-baked static WebP sprite sheets
  if (pathname && pathname.startsWith('/api/sprites/')) {
    const filename = path.basename(pathname);
    const spriteId = path.basename(filename, path.extname(filename));
    const spriteFile = getSpritePath(spriteId);

    if (fs.existsSync(spriteFile)) {
      res.setHeader('Content-Type', 'image/webp');
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      sendFileStream(res, spriteFile, 404, 'Sprite not found');
      return;
    } else {
      res.statusCode = 404;
      res.end('Sprite not found');
      return;
    }
  }

  // Endpoint: /api/sprite-coord?path=...
  if (pathname === '/api/sprite-coord') {
    const photoPath = parsedUrl.searchParams.get('path');
    if (photoPath) {
      const coord = getSpriteCoordinate(photoPath);
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.end(JSON.stringify(coord || null));
      return;
    }
  }

  // Endpoint: /api/sprite-coords-batch (POST) - looks up sprite coordinates
  // for many photos in one request instead of one HTTP round-trip per photo
  // card, which was the main cause of scroll stutter on large libraries.
  if (pathname === '/api/sprite-coords-batch' && req.method === 'POST') {
    withBody(req, res, MAX_BODY_DEFAULT, (body) => {
      try {
        const { paths } = JSON.parse(body || '{}');
        const requestedPaths: string[] = Array.isArray(paths) ? paths.slice(0, 500) : [];
        const coords = getSpriteCoordinatesBatch(requestedPaths);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(coords));
      } catch (err: any) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Endpoint: /api/photo?path=...
  if (pathname === '/api/photo') {
    const filePath = parsedUrl.searchParams.get('path');
    const originalPath = parsedUrl.searchParams.get('originalPath');
    const preferOriginal =
      parsedUrl.searchParams.get('preferOriginal') === '1' ||
      parsedUrl.searchParams.get('preferOriginal') === 'true';
    const quality = parsedUrl.searchParams.get('quality');
    const sizeParam = parsedUrl.searchParams.get('size');
    const requestedSize = sizeParam ? parseInt(sizeParam, 10) : 0;

    if (rejectIfPathNotAllowed(res, [filePath, originalPath], '/api/photo')) return;

    let targetPath: string | null = null;
    // isPathReachable (not fs.existsSync) is what keeps an offline network
    // share from hanging the whole app: it bounds each check to ~1.5s and,
    // once a storage is found offline, skips checking it again for a while
    // instead of blocking on the OS's full network timeout on every request.
    if (preferOriginal && originalPath && (await isPathReachable(originalPath))) {
      targetPath = originalPath;
    } else if (filePath && (await isPathReachable(filePath))) {
      targetPath = filePath;
    } else if (originalPath && (await isPathReachable(originalPath))) {
      targetPath = originalPath;
    }

    if (targetPath) {
      const ext = path.extname(targetPath).toLowerCase();

      // Only real image formats are served — never an .html/.svg/.js/.json that happens to sit in a library folder.
      if (!SERVABLE_IMAGE_EXTS.has(ext)) {
        res.statusCode = 415;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Unsupported file type' }));
        return;
      }

      // 1. Raw original full-resolution requested (e.g. download or 100% zoom)
      if (preferOriginal) {
        if (ext === '.heic' || ext === '.heif') {
          const jpegBuf = await getHeicHighQualityJpegBuffer(targetPath);
          if (jpegBuf && jpegBuf.length > 0) {
            res.setHeader('Content-Type', 'image/jpeg');
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
            res.end(jpegBuf);
            return;
          }
        }

        try {
          const stat = await fs.promises.stat(targetPath);
          const etag = `"${stat.mtimeMs.toString(36)}-${stat.size.toString(36)}"`;
          if (req.headers['if-none-match'] === etag) {
            res.statusCode = 304;
            res.end();
            return;
          }
          res.setHeader('ETag', etag);
          res.setHeader('Content-Type', MIME_TYPES[ext] || 'image/jpeg');
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          sendFileStream(res, targetPath, 500, 'Failed reading photo', req);
          return;
        } catch {
          res.statusCode = 500;
          res.end('Failed reading photo');
          return;
        }
      }

      // 2. Multi-tier thumbnail caching (250px grid, 500px medium, 1600px preview)
      const targetSize = requestedSize > 0
        ? clampThumbSize(requestedSize, 250)
        : (quality === 'high' ? 1600 : 250);

      const thumbResult = await getOrGenerateCachedThumbnail(targetPath, targetSize);
      if (thumbResult) {
        if (req.headers['if-none-match'] === thumbResult.etag) {
          res.statusCode = 304;
          res.end();
          return;
        }

        res.setHeader('ETag', thumbResult.etag);
        res.setHeader('Content-Type', thumbResult.mime || 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');

        if (thumbResult.filePath && fs.existsSync(thumbResult.filePath)) {
          sendFileStream(res, thumbResult.filePath, 500, 'Error streaming thumbnail', req);
        } else if (thumbResult.buffer) {
          res.end(thumbResult.buffer);
        } else {
          res.statusCode = 500;
          res.end('Thumbnail unavailable');
        }
        return;
      }

      // 3. Fallback direct stream if thumbnail generation was skipped
      try {
        const stat = await fs.promises.stat(targetPath);
        const etag = `"${stat.mtimeMs.toString(36)}-${stat.size.toString(36)}"`;
        if (req.headers['if-none-match'] === etag) {
          res.statusCode = 304;
          res.end();
          return;
        }
        res.setHeader('ETag', etag);
        res.setHeader('Content-Type', MIME_TYPES[ext] || 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        sendFileStream(res, targetPath, 500, 'Error streaming file', req);
        return;
      } catch {
        res.statusCode = 500;
        res.end('Error streaming file');
        return;
      }
    } else {
      res.statusCode = 404;
      res.end('Photo not found');
      return;
    }
  }

  // Endpoint: /api/heic/prepare-hq?path=...&id=...
  if (pathname === '/api/heic/prepare-hq') {
    const targetPath = parsedUrl.searchParams.get('path');
    const photoId = parsedUrl.searchParams.get('id') || 'temp';
    if (rejectIfPathNotAllowed(res, [targetPath], '/api/heic/prepare-hq')) return;
    if (targetPath && fs.existsSync(targetPath)) {
      const tempPath = await prepareHeicHqTemp(targetPath, photoId);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        tempPath,
        url: `/api/photo?path=${encodeURIComponent(tempPath || targetPath)}&quality=high`,
      }));
      return;
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'File not found' }));
      return;
    }
  }

  // Endpoint: /api/heic/cleanup-hq?id=...
  if (pathname === '/api/heic/cleanup-hq') {
    const photoId = parsedUrl.searchParams.get('id');
    if (photoId) {
      cleanupHeicHqTemp(photoId);
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: true }));
    return;
  }

  // Endpoint: /api/file-exists?path=...
  if (pathname === '/api/file-exists') {
    const p = parsedUrl.searchParams.get('path');
    if (rejectIfPathNotAllowed(res, [p], '/api/file-exists')) return;
    const exists = p ? await isPathReachable(p) : false;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ exists }));
    return;
  }

  // Endpoint: /api/discover-mirrors
  //
  // This used to be its own, separate reimplementation of mirror discovery
  // — built before VirtualStorageConfig grew networkSourcePath/inventory*
  // fields, and never updated to match. It always sent sourcePath: '' (an
  // entirely different, non-existent field — the real one is
  // networkSourcePath), a syncIntervalMinutes/isVirtualServerRunning shape
  // nothing else in the app uses, and a naive file-extension count instead
  // of the real inventory total. Accessing the app from a phone browser
  // (this HTTP path) triggered it, and the renderer's discovery-merge logic
  // wrote its broken object straight into the same persisted storage list
  // the desktop Electron app reads — permanently overwriting a correctly
  // configured storage's real network source path with an empty string,
  // which is exactly what made "Rescan" fail with "No source path
  // configured" and every displayed count go wrong afterward. Delegating to
  // the same discoverStoredMirrors() the Electron IPC path uses guarantees
  // this HTTP path can never again diverge from — or corrupt — what the
  // desktop app considers a storage's real configuration.
  if (pathname === '/api/discover-mirrors') {
    let mirrors: any[] = [];
    try {
      mirrors = discoverStoredMirrors();
    } catch {}
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(mirrors));
    return;
  }

  // Endpoint: /api/default-mirror-root — the host machine's platform-aware
  // default (a mobile client should suggest what the HOST would create the
  // mirror under, not guess from the phone's own OS).
  if (pathname === '/api/default-mirror-root') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ path: getDefaultMirrorRoot() }));
    return;
  }

  // Any /api/* request that reached this point matched no route (unknown
  // path, or a known path with the wrong method): answer with a JSON 404
  // instead of falling through to the SPA and returning index.html as a 200.
  if (pathname.startsWith('/api/')) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  // Serve static assets from dist/ (or public/ in dev)
  let distDir = path.join(__dirname, '..', '..', '..', 'dist');
  let publicDir = path.join(__dirname, '..', '..', '..', 'public');

  if (app && app.isPackaged) {
    distDir = path.join(process.resourcesPath, 'app.asar', 'dist');
    publicDir = path.join(process.resourcesPath, 'app.asar', 'public');
  }

  let relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
  let fullPath = path.join(distDir, relativePath);

  if (!fs.existsSync(fullPath)) {
    const publicCandidate = path.join(publicDir, relativePath);
    if (fs.existsSync(publicCandidate)) {
      fullPath = publicCandidate;
    }
  }

  if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
    const ext = path.extname(fullPath).toLowerCase();
    res.setHeader('Content-Type', MIME_TYPES[ext] || 'application/octet-stream');
    sendFileStream(res, fullPath, 500, 'Failed reading file');
    return;
  }

  // SPA Fallback: index.html
  const indexPath = path.join(distDir, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    sendFileStream(res, indexPath, 500, 'Failed reading file');
    return;
  }

  res.statusCode = 404;
  res.end('Not Found');
}

/**
 * Starts (or restarts on a different port) the server. Calls are serialized so
 * two overlapping starts can't each bind a server and leak one. Never rejects:
 * a failure is reported through the returned status' `error` field.
 */
export function startEmbeddedWebServer(port: number = 5173): Promise<WebServerStatus> {
  const run = startChain.then(() => doStartServer(port));
  startChain = run.catch(() => {});
  return run;
}

function closeServerInstance(): void {
  if (serverInstance) {
    const srv = serverInstance;
    serverInstance = null;
    try {
      srv.close();
      // Also drop keep-alive/in-flight connections, otherwise a "stopped" or
      // restarted server keeps answering paired devices on old sockets.
      (srv as any).closeAllConnections?.();
    } catch {}
  }
  isServerRunning = false;
}

function doStartServer(port: number): Promise<WebServerStatus> {
  return new Promise((resolve) => {
    if (!isValidPort(port)) {
      // Leave any running server untouched; just report why the new port was refused.
      serverError = `Invalid port ${port}: use a number between ${MIN_PORT} and ${MAX_PORT}.`;
      resolve(getEmbeddedWebServerStatus());
      return;
    }

    if (isServerRunning && serverInstance && requestedPort === port) {
      resolve(getEmbeddedWebServerStatus());
      return;
    }

    closeServerInstance();

    serverEnabled = true;
    requestedPort = port;
    const lastPort = Math.min(MAX_PORT, port + PORT_FALLBACK_TRIES);

    function fail(message: string) {
      serverError = message;
      isServerRunning = false;
      activePort = port;
      console.warn(`[EmbeddedWebServer] ${message}`);
      resolve(getEmbeddedWebServerStatus());
    }

    function tryPort(targetPort: number) {
      const srv = http.createServer((req, res) => {
        handleHttpRequest(req, res).catch((err) => {
          console.error('[EmbeddedWebServer] Unhandled request error:', err);
          if (!res.headersSent) {
            res.statusCode = 500;
            res.end('Internal Server Error');
          } else if (!res.writableEnded) {
            res.destroy();
          }
        });
      });
      // Bound how long a client may take to deliver headers/body (slowloris);
      // does not limit how long a handler may take to respond (sync/scan can be long).
      srv.headersTimeout = 30_000;
      srv.requestTimeout = 120_000;

      srv.on('error', (err: any) => {
        if (err.code === 'EADDRINUSE') {
          try {
            srv.close();
          } catch {}
          if (targetPort < lastPort) {
            console.warn(`[EmbeddedWebServer] Port ${targetPort} in use, trying ${targetPort + 1}...`);
            tryPort(targetPort + 1);
          } else {
            fail(`Ports ${port}-${lastPort} are all in use. Choose a different port in Settings.`);
          }
        } else if (srv === serverInstance) {
          // Runtime error on the live server.
          serverError = err.message;
          isServerRunning = false;
        } else {
          fail(`Could not start the web server: ${err.message}`);
        }
      });

      try {
        srv.listen(targetPort, '0.0.0.0', () => {
          serverInstance = srv;
          activePort = targetPort;
          isServerRunning = true;
          // A fallback is surfaced (not silent) so the desktop user knows the URL changed.
          serverError = targetPort !== port ? `Port ${port} was already in use, so the server is using port ${targetPort} instead.` : undefined;
          console.log(`[EmbeddedWebServer] Running at http://0.0.0.0:${activePort}`);
          resolve(getEmbeddedWebServerStatus());
        });
      } catch (err: any) {
        fail(`Could not start the web server: ${err?.message || err}`);
      }
    }

    tryPort(port);
  });
}

export function stopEmbeddedWebServer(): void {
  closeServerInstance();
}

export function getEmbeddedWebServerStatus(): WebServerStatus {
  const ips = getNetworkIps();
  const primaryIp =
    ips.find((i) => i.name.toLowerCase().includes('wi-fi') || i.name.toLowerCase().includes('wireless'))?.address ||
    ips[0]?.address ||
    'localhost';

  const primaryUrl = `http://${primaryIp}:${activePort}/`;
  const allUrls = ips.map((item) => ({
    name: item.name,
    ip: item.address,
    url: `http://${item.address}:${activePort}/`,
  }));

  return {
    enabled: serverEnabled,
    isRunning: isServerRunning,
    port: activePort,
    primaryIp,
    primaryUrl,
    allUrls,
    error: serverError,
  };
}

export async function updateEmbeddedWebServerSettings(newSettings: {
  enabled: boolean;
  port: number;
}): Promise<WebServerStatus> {
  const port = Number(newSettings.port);
  if (!newSettings.enabled) {
    // Turning the server OFF must work even if the port field is empty/garbage: keep the
    // last good port and stop, instead of leaving it running on 0.0.0.0.
    saveWebServerSettings({ enabled: false, port: isValidPort(port) ? port : loadSavedWebServerSettings().port });
    startChain = startChain.then(() => {
      serverEnabled = false;
      stopEmbeddedWebServer();
    });
    await startChain;
    return getEmbeddedWebServerStatus();
  }
  if (!isValidPort(port)) {
    // Refuse before saving or touching the running server, so a typo can't take the server down
    // (or persist a port that then fails on every launch).
    serverError = `Invalid port ${newSettings.port}: use a number between ${MIN_PORT} and ${MAX_PORT}.`;
    return getEmbeddedWebServerStatus();
  }
  saveWebServerSettings({ enabled: true, port });
  return await startEmbeddedWebServer(port);
}
