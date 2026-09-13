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
import { scanVirtualMirrorDirectory, syncVirtualStorage, deleteFilesPermanently, trashFiles, rotatePhotoFile, rotatePhotoWithOfflineQueue, processPendingRotations } from './virtualMirrorService';
import { scanPhotoDirectory } from './fileOrganizer';
import { getOrGenerateCachedThumbnail, clearThumbnailCache, refreshThumbnailsFromSource } from './thumbnailCacheService';
import { getCatalogMeta, getCatalogPage, switchCatalogLibrary, ensureMigratedIfEmpty } from './catalogService';
import { handleStorageSave, handleStorageLoad, STORAGE_KEY, GLOBAL_PEOPLE_KEY } from './storageHandlers';
import { getSpriteCoordinate, getSpritePath } from './spriteService';
import { thumbnailWorker } from './thumbnailWorkerService';
import { getBackgroundServiceStatus } from './backgroundDaemon';
import { WebServerStatus } from '../../types';
import {
  getOrCreatePin,
  verifyPin,
  createSessionToken,
  validateToken,
  isLockedOut,
  recordFailedAttempt,
  clearFailedAttempts,
} from './webAuthService';

let serverInstance: http.Server | null = null;
let activePort: number = 5173;
let isServerRunning: boolean = false;
let serverEnabled: boolean = true;
let serverError: string | undefined = undefined;

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
      return {
        enabled: data.enabled !== false,
        port: parseInt(data.port || '5173', 10) || 5173,
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

// Request handler for all HTTP requests
async function handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

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
    res.end(JSON.stringify(getEmbeddedWebServerStatus()));
    return;
  }

  // Endpoint: /api/auth/status — always public, lets the client know a PIN is required
  if (pathname === '/api/auth/status') {
    getOrCreatePin(); // ensure a PIN exists so Settings can display it even before first pairing
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ pinRequired: true }));
    return;
  }

  // Endpoint: /api/auth/pair — public, exchanges a valid PIN for a session token
  if (pathname === '/api/auth/pair' && req.method === 'POST') {
    const clientIp = req.socket.remoteAddress || 'unknown';
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (isLockedOut(clientIp)) {
        res.statusCode = 429;
        res.end(JSON.stringify({ error: 'Too many attempts. Try again in a minute.' }));
        return;
      }
      try {
        const { pin, deviceLabel } = JSON.parse(body || '{}');
        if (!verifyPin(pin)) {
          recordFailedAttempt(clientIp);
          res.statusCode = 401;
          res.end(JSON.stringify({ error: 'Incorrect PIN' }));
          return;
        }
        clearFailedAttempts(clientIp);
        const { token } = createSessionToken(deviceLabel || 'Unknown device');
        res.end(JSON.stringify({ token }));
      } catch (err: any) {
        res.statusCode = 400;
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

  // Endpoint: /api/library
  if (pathname === '/api/library') {
    if (req.method === 'GET') {
      try {
        ensureMigratedIfEmpty();
        const libraryData = handleStorageLoad(STORAGE_KEY) || { photos: [], people: [], faces: [], albums: [] };
        const peopleRegistry = handleStorageLoad(GLOBAL_PEOPLE_KEY);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ [STORAGE_KEY]: libraryData, [GLOBAL_PEOPLE_KEY]: peopleRegistry }));
      } catch (err: any) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    } else if (req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        try {
          const { key, data } = JSON.parse(body);
          const result = handleStorageSave(key, data);
          if (result.enqueuePhotos) {
            thumbnailWorker.enqueuePhotos(result.enqueuePhotos, result.enqueueLibraryPath || undefined);
          }
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ success: result.success }));
        } catch (err: any) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }
  }

  // Endpoint: /api/scan?path=...
  if (pathname === '/api/scan') {
    const targetDir = parsedUrl.searchParams.get('path');
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
    if (mirrorPath && fs.existsSync(mirrorPath)) {
      try {
        const photos = scanVirtualMirrorDirectory(mirrorPath);
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

  // Endpoint: /api/sync-virtual-storage (POST)
  if (pathname === '/api/sync-virtual-storage' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', async () => {
      try {
        const config = JSON.parse(body);
        const result = await syncVirtualStorage(config);
        try {
          const mirrorPath = path.join(config.localMirrorRoot, config.name);
          const photos = scanVirtualMirrorDirectory(mirrorPath);
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
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const { photos } = JSON.parse(body || '{}');
        if (Array.isArray(photos) && photos.length > 0) {
          thumbnailWorker.enqueuePhotos(photos);
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
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        const { items } = JSON.parse(body || '{}');
        const result = await refreshThumbnailsFromSource(Array.isArray(items) ? items : []);
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
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', async () => {
      try {
        const { items, size } = JSON.parse(body || '{}');
        const targetSize = typeof size === 'number' && size > 0 ? size : 250;
        const requestedItems: Array<{ path: string; originalPath?: string }> = Array.isArray(items)
          ? items.slice(0, 100) // Cap at 100 items per batch
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
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        const { filePaths, permanent } = JSON.parse(body || '{}');
        const paths = Array.isArray(filePaths) ? filePaths : [];
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
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        const { filePath, rotationDegrees, originalRemotePath } = JSON.parse(body || '{}');
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

  // Endpoint: /api/catalog-page?page=0&size=100
  if (pathname === '/api/catalog-page') {
    const pageIndex = parseInt(parsedUrl.searchParams.get('page') || '0', 10);
    const pageSize = parseInt(parsedUrl.searchParams.get('size') || '100', 10);
    try {
      const pageData = await getCatalogPage(pageIndex, pageSize);
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
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', async () => {
      try {
        const { targetPath } = JSON.parse(body);
        if (!targetPath) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'targetPath required' }));
          return;
        }
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

  // Endpoint: /api/sprites/:id.webp - Stream pre-baked static WebP sprite sheets
  if (pathname && pathname.startsWith('/api/sprites/')) {
    const filename = path.basename(pathname);
    const spriteId = path.basename(filename, path.extname(filename));
    const spriteFile = getSpritePath(spriteId);

    if (fs.existsSync(spriteFile)) {
      res.setHeader('Content-Type', 'image/webp');
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      fs.createReadStream(spriteFile).pipe(res);
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

    let targetPath: string | null = null;
    if (preferOriginal && originalPath && fs.existsSync(originalPath)) {
      targetPath = originalPath;
    } else if (filePath && fs.existsSync(filePath)) {
      targetPath = filePath;
    } else if (originalPath && fs.existsSync(originalPath)) {
      targetPath = originalPath;
    }

    if (targetPath && fs.existsSync(targetPath)) {
      const ext = path.extname(targetPath).toLowerCase();

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
          const stream = fs.createReadStream(targetPath);
          stream.on('error', () => {
            if (!res.headersSent) {
              res.statusCode = 500;
              res.end('Failed reading photo');
            }
          });
          stream.pipe(res);
          return;
        } catch {
          res.statusCode = 500;
          res.end('Failed reading photo');
          return;
        }
      }

      // 2. Multi-tier thumbnail caching (250px grid, 500px medium, 1600px preview)
      const targetSize = requestedSize > 0
        ? requestedSize
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
          const stream = fs.createReadStream(thumbResult.filePath);
          stream.on('error', () => {
            if (!res.headersSent) {
              res.statusCode = 500;
              res.end('Error streaming thumbnail');
            }
          });
          stream.pipe(res);
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
        const stream = fs.createReadStream(targetPath);
        stream.on('error', () => {
          if (!res.headersSent) {
            res.statusCode = 500;
            res.end('Error streaming file');
          }
        });
        stream.pipe(res);
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
    const exists = p ? fs.existsSync(p) : false;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ exists }));
    return;
  }

  // Endpoint: /api/discover-mirrors
  if (pathname === '/api/discover-mirrors') {
    const defaultRoot = 'C:\\GPhotos_VirtualMirrors';
    const mirrors: any[] = [];
    if (fs.existsSync(defaultRoot)) {
      try {
        const entries = fs.readdirSync(defaultRoot, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const mirrorPath = path.join(defaultRoot, entry.name);
            const files = fs.readdirSync(mirrorPath);
            mirrors.push({
              id: `mirror_${entry.name}`,
              name: entry.name,
              sourcePath: '',
              localMirrorRoot: defaultRoot,
              syncIntervalMinutes: 60,
              lastSynced: Date.now(),
              totalItems: files.filter((f) => /\.(jpe?g|png|webp|gif|bmp|heic|heif)$/i.test(f)).length,
              totalSizeSaved: files.length * 2500000,
              isVirtualServerRunning: true,
            });
          }
        }
      } catch {}
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(mirrors));
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
    fs.createReadStream(fullPath).pipe(res);
    return;
  }

  // SPA Fallback: index.html
  const indexPath = path.join(distDir, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    fs.createReadStream(indexPath).pipe(res);
    return;
  }

  res.statusCode = 404;
  res.end('Not Found');
}

export function startEmbeddedWebServer(port: number = 5173): Promise<WebServerStatus> {
  return new Promise((resolve) => {
    if (isServerRunning && serverInstance && activePort === port) {
      resolve(getEmbeddedWebServerStatus());
      return;
    }

    if (serverInstance) {
      try {
        serverInstance.close();
      } catch {}
      serverInstance = null;
      isServerRunning = false;
    }

    serverEnabled = true;

    function tryPort(targetPort: number) {
      const srv = http.createServer((req, res) => {
        req.setTimeout(12000, () => {
          if (!res.headersSent) {
            res.statusCode = 408;
            res.end('Request Timeout');
          }
        });

        handleHttpRequest(req, res).catch((err) => {
          console.error('[EmbeddedWebServer] Unhandled request error:', err);
          if (!res.headersSent) {
            res.statusCode = 500;
            res.end('Internal Server Error');
          }
        });
      });

      srv.on('error', (err: any) => {
        if (err.code === 'EADDRINUSE') {
          try {
            srv.close();
          } catch {}
          console.warn(`[EmbeddedWebServer] Port ${targetPort} in use, trying ${targetPort + 1}...`);
          tryPort(targetPort + 1);
        } else {
          serverError = err.message;
          isServerRunning = false;
          resolve(getEmbeddedWebServerStatus());
        }
      });

      srv.listen(targetPort, '0.0.0.0', () => {
        serverInstance = srv;
        activePort = targetPort;
        isServerRunning = true;
        serverError = undefined;
        console.log(`[EmbeddedWebServer] 🚀 Running at http://0.0.0.0:${activePort}`);
        resolve(getEmbeddedWebServerStatus());
      });
    }

    tryPort(port);
  });
}

export function stopEmbeddedWebServer(): void {
  if (serverInstance) {
    try {
      serverInstance.close();
    } catch {}
    serverInstance = null;
  }
  isServerRunning = false;
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
  saveWebServerSettings(newSettings);
  if (!newSettings.enabled) {
    serverEnabled = false;
    stopEmbeddedWebServer();
    return getEmbeddedWebServerStatus();
  }
  return await startEmbeddedWebServer(newSettings.port);
}
