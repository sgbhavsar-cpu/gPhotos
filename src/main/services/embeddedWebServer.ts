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
import { scanPhotoDirectory } from './fileOrganizer';
import { scanVirtualMirrorDirectory, syncVirtualStorage } from './virtualMirrorService';
import { WebServerStatus } from '../../types';

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

// 2. Locate active library.json with highest priority given to active Electron store
function getLibraryPath(): string {
  try {
    if (app && typeof app.getPath === 'function') {
      const electronPath = path.join(app.getPath('userData'), 'library.json');
      if (fs.existsSync(electronPath)) return electronPath;
    }
  } catch {}

  const appData =
    process.env.APPDATA ||
    (process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library/Application Support')
      : path.join(os.homedir(), '.config'));

  const candidates = [
    path.join(appData, 'gphotos-desktop', 'library.json'),
    path.join(appData, 'gPhotos', 'library.json'),
    path.join(__dirname, '..', '..', '..', 'library.json'),
  ];

  let bestCandidate: string | null = null;
  let bestSize = -1;
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try {
        const sz = fs.statSync(p).size;
        if (sz > bestSize) {
          bestSize = sz;
          bestCandidate = p;
        }
      } catch {}
    }
  }
  return bestCandidate || candidates[0];
}

// 3. Settings path for web server config
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

  // Endpoint: /api/library
  if (pathname === '/api/library') {
    const libPath = getLibraryPath();
    if (req.method === 'GET') {
      res.setHeader('Content-Type', 'application/json');
      if (fs.existsSync(libPath)) {
        fs.createReadStream(libPath).pipe(res);
      } else {
        res.end(JSON.stringify({ photos: [], people: [], faces: [], albums: [] }));
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
          let current: Record<string, any> = {};
          if (fs.existsSync(libPath)) {
            try {
              current = JSON.parse(fs.readFileSync(libPath, 'utf8'));
            } catch {}
          }
          current[key] = data;
          fs.mkdirSync(path.dirname(libPath), { recursive: true });
          fs.writeFileSync(libPath, JSON.stringify(current, null, 2), 'utf8');
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ success: true }));
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
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(result));
      } catch (err: any) {
        res.statusCode = 500;
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

      // Robust Apple iPhone HEIC/HEIF Handling:
      // When quality is high or preferOriginal is requested (e.g. fullscreen lightbox), serve HQ JPEG.
      // Otherwise, serve fast, disk-cached 500px auto-oriented thumbnail.
      if (ext === '.heic' || ext === '.heif') {
        const isHq = preferOriginal || quality === 'high';
        const jpegBuf = isHq
          ? await getHeicHighQualityJpegBuffer(targetPath)
          : await getOrGenerateHeicThumbnail500(targetPath);

        if (jpegBuf && jpegBuf.length > 0) {
          res.setHeader('Content-Type', 'image/jpeg');
          res.setHeader('Cache-Control', 'public, max-age=86400');
          res.end(jpegBuf);
          return;
        }
      }

      res.setHeader('Content-Type', MIME_TYPES[ext] || 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      fs.createReadStream(targetPath).pipe(res);
      return;
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
      const srv = http.createServer(handleHttpRequest);

      srv.on('error', (err: any) => {
        if (err.code === 'EADDRINUSE') {
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
