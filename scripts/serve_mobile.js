const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const url = require('url');

const PORT = parseInt(process.env.PORT || '5174', 10);
const DIST_DIR = path.join(__dirname, '..', 'dist');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// 1. Detect all non-internal IPv4 network addresses
function getNetworkIps() {
  const ips = [];
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

// 2. Locate active library.json
function getLibraryPath() {
  const appData =
    process.env.APPDATA ||
    (process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library/Application Support')
      : path.join(os.homedir(), '.config'));

  const candidates = [
    path.join(appData, 'gphotos-desktop', 'library.json'),
    path.join(appData, 'gPhotos', 'library.json'),
    path.join(__dirname, '..', 'library.json'),
  ];

  let best = candidates[0];
  let bestSize = -1;
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try {
        const sz = fs.statSync(p).size;
        if (sz > bestSize) {
          bestSize = sz;
          best = p;
        }
      } catch {}
    }
  }
  return best;
}

const MIME_TYPES = {
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

// Lazy-loaded exifr and heic-convert for iPhone HEIC decoding
let exifr = null;
try {
  exifr = require('exifr');
} catch {}

let heicConvert = null;
try {
  heicConvert = require('heic-convert');
} catch {}

let sharp = null;
try {
  sharp = require('sharp');
} catch {}

let catalogService = null;
try {
  catalogService = require('../dist-electron/main/services/catalogService');
} catch {}

let spriteService = null;
try {
  spriteService = require('../dist-electron/main/services/spriteService');
} catch {}

const crypto = require('crypto');

function getThumbCacheDir(size) {
  const appData =
    process.env.APPDATA ||
    (process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library/Application Support')
      : path.join(os.homedir(), '.config'));
  const d = path.join(appData, 'gPhotos', 'cache', 'thumbnails', String(size));
  if (!fs.existsSync(d)) {
    fs.mkdirSync(d, { recursive: true });
  }
  return d;
}

const inFlightMobileJobs = new Map();

async function getCachedThumb(sourcePath, size) {
  try {
    const stat = await fs.promises.stat(sourcePath);
    const key = crypto.createHash('sha1').update(`${sourcePath}:${stat.mtimeMs}:${size}`).digest('hex');
    const cacheDir = getThumbCacheDir(size);
    const cacheFile = path.join(cacheDir, `${key}.jpg`);

    // Check cache
    try {
      const cStat = await fs.promises.stat(cacheFile);
      return {
        filePath: cacheFile,
        etag: `"${cStat.mtimeMs.toString(36)}-${cStat.size.toString(36)}"`,
      };
    } catch {}

    const jobKey = `${key}:${size}`;
    if (inFlightMobileJobs.has(jobKey)) {
      return inFlightMobileJobs.get(jobKey);
    }

    const job = (async () => {
      if (sharp) {
        const buf = await sharp(sourcePath)
          .rotate()
          .resize(size, size, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: size > 500 ? 86 : 82, mozjpeg: true })
          .toBuffer();
        await fs.promises.writeFile(cacheFile, buf);
        return {
          filePath: cacheFile,
          etag: `"${stat.mtimeMs.toString(36)}-${buf.length.toString(36)}"`,
        };
      }
      return null;
    })();

    inFlightMobileJobs.set(jobKey, job);
    try {
      return await job;
    } finally {
      inFlightMobileJobs.delete(jobKey);
    }
  } catch {}
  return null;
}

const heicCache = new Map();
const MAX_HEIC_CACHE = 100;

async function getHeicBuffer(targetPath) {
  const stat = fs.statSync(targetPath);
  const cacheKey = `${targetPath}:${stat.mtimeMs}`;
  if (heicCache.has(cacheKey)) {
    return heicCache.get(cacheKey);
  }

  const fileBuf = fs.readFileSync(targetPath);

  // 1. Fast path: embedded EXIF JPEG
  if (exifr && typeof exifr.thumbnail === 'function') {
    try {
      const thumb = await exifr.thumbnail(fileBuf);
      if (thumb && thumb.length > 0) {
        const res = Buffer.from(thumb);
        if (heicCache.size >= MAX_HEIC_CACHE) {
          const first = heicCache.keys().next().value;
          if (first) heicCache.delete(first);
        }
        heicCache.set(cacheKey, res);
        return res;
      }
    } catch {}
  }

  // 2. Fallback: full bitstream decode
  if (heicConvert) {
    try {
      const converted = await heicConvert({
        buffer: fileBuf,
        format: 'JPEG',
        quality: 0.88,
      });
      const res = Buffer.from(converted);
      if (heicCache.size >= MAX_HEIC_CACHE) {
        const first = heicCache.keys().next().value;
        if (first) heicCache.delete(first);
      }
      heicCache.set(cacheKey, res);
      return res;
    } catch (err) {
      console.warn('heicConvert failed:', err);
    }
  }

  return null;
}

async function handleRequest(req, res) {
  // Enable CORS for all requests
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url || '/', `http://localhost:${PORT}`);
  const pathname = parsedUrl.pathname;
  // Endpoint: /api/status
  if (pathname === '/api/status') {
    res.setHeader('Content-Type', 'application/json');
    const ips = getNetworkIps();
    res.end(
      JSON.stringify({
        enabled: true,
        isRunning: true,
        port: PORT,
        primaryIp: ips.length > 0 ? ips[0].address : '127.0.0.1',
        primaryUrl: `http://${ips.length > 0 ? ips[0].address : '127.0.0.1'}:${PORT}/`,
        allUrls: ips.map((i) => ({ name: i.name, ip: i.address, url: `http://${i.address}:${PORT}/` })),
      })
    );
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
          let current = {};
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
        } catch (err) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }
  }

  // Endpoint: /api/delete-files (POST)
  if (pathname === '/api/delete-files' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        const { filePaths, permanent } = JSON.parse(body || '{}');
        const paths = Array.isArray(filePaths) ? filePaths : [];
        let deletedCount = 0;
        const errors = [];
        for (const fp of paths) {
          if (!fs.existsSync(fp)) continue;
          try {
            fs.unlinkSync(fp);
            const jsonSidecar = fp.replace(/\.[^/.]+$/, '') + '.json';
            if (fs.existsSync(jsonSidecar)) {
              try { fs.unlinkSync(jsonSidecar); } catch {}
            }
            deletedCount++;
          } catch (e) {
            errors.push(e.message);
          }
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ success: errors.length === 0, deletedCount, errors }));
      } catch (err) {
        res.statusCode = 500;
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // Endpoint: /api/rotate-photo (POST)
  if (pathname === '/api/rotate-photo' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        const { filePath, rotationDegrees } = JSON.parse(body || '{}');
        let sharp = null;
        try { sharp = require('sharp'); } catch {}
        if (sharp && fs.existsSync(filePath)) {
          const degrees = ((rotationDegrees % 360) + 360) % 360;
          const bakPath = `${filePath}.bak`;
          if (!fs.existsSync(bakPath)) {
            try { fs.copyFileSync(filePath, bakPath); } catch {}
          }
          const buf = await sharp(filePath).rotate(degrees).withMetadata().toBuffer();
          fs.writeFileSync(filePath, buf);
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ success: true, newPath: filePath }));
      } catch (err) {
        res.statusCode = 500;
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // Endpoint: /api/scan-mirror?path=...
  if (pathname === '/api/scan-mirror') {
    const mirrorPath = parsedUrl.searchParams.get('path');
    if (mirrorPath && fs.existsSync(mirrorPath)) {
      try {
        const photos = [];
        function scanDir(current) {
          const entries = fs.readdirSync(current, { withFileTypes: true });
          for (const entry of entries) {
            const fullPath = path.join(current, entry.name);
            if (entry.isDirectory()) {
              if (!entry.name.startsWith('.')) scanDir(fullPath);
            } else if (entry.isFile() && entry.name.endsWith('.json')) {
              try {
                const meta = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
                if (fs.existsSync(meta.thumbnailPath)) {
                  const date = new Date(meta.dateTaken);
                  photos.push({
                    id: Buffer.from(meta.thumbnailPath).toString('base64'),
                    filePath: meta.thumbnailPath,
                    fileName: meta.fileName,
                    fileSize: meta.originalFileSize,
                    fileDate: meta.dateTaken,
                    dateTaken: meta.dateTaken,
                    year: date.getFullYear(),
                    month: date.getMonth() + 1,
                    day: date.getDate(),
                    width: meta.width,
                    height: meta.height,
                    exif: meta.exif,
                    location: meta.location,
                    isVirtual: true,
                    originalRemotePath: meta.originalFilePath,
                    storageName: meta.storageName,
                    isFavorite: false,
                  });
                }
              } catch {}
            }
          }
        }
        scanDir(mirrorPath);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(photos));
        return;
      } catch (err) {
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

  // Endpoint: /api/precache-status (GET)
  if (pathname === '/api/precache-status') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ isRunning: false, paused: false, current: 0, total: 0, cpuPercent: 0, ramMb: 0 }));
    return;
  }

  // Endpoint: /api/background-service-status (GET)
  if (pathname === '/api/background-service-status') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      isRunning: true,
      isPaused: false,
      runAtStartup: false,
      minimizeToTray: true,
      syncIntervalMinutes: 15,
      isScanningNow: false,
      enableThumbnailPreCache: true,
      thumbnailsPreCachedCount: 0,
      thumbnailsPreCachedTotal: 0,
      isPreCachingActive: false,
    }));
    return;
  }

  // Endpoint: /api/start-precache (POST)
  if (pathname === '/api/start-precache' && req.method === 'POST') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ started: true }));
    return;
  }

  // Endpoint: /api/pause-precache (POST)
  if (pathname === '/api/pause-precache' && req.method === 'POST') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ paused: true }));
    return;
  }

  // Endpoint: /api/batch-thumbnails (POST)
  if (pathname === '/api/batch-thumbnails' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', async () => {
      try {
        const { items, size } = JSON.parse(body || '{}');
        const targetSize = typeof size === 'number' && size > 0 ? size : 250;
        const requestedItems = Array.isArray(items) ? items.slice(0, 100) : [];
        const thumbnails = {};

        await Promise.all(
          requestedItems.map(async (item) => {
            if (!item || !item.path) return;
            const targetPath = (item.path && fs.existsSync(item.path))
              ? item.path
              : (item.originalPath && fs.existsSync(item.originalPath) ? item.originalPath : null);

            if (!targetPath) return;

            try {
              const resThumb = await getCachedThumb(targetPath, targetSize);
              if (resThumb && resThumb.filePath && fs.existsSync(resThumb.filePath)) {
                const buf = await fs.promises.readFile(resThumb.filePath);
                thumbnails[item.path] = `data:image/jpeg;base64,${buf.toString('base64')}`;
              }
            } catch {}
          })
        );

        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify({ thumbnails }));
      } catch (err) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Endpoint: /api/catalog-meta
  if (pathname === '/api/catalog-meta') {
    if (catalogService && catalogService.getCatalogMeta) {
      try {
        const meta = await catalogService.getCatalogMeta();
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'public, max-age=60');
        res.end(JSON.stringify(meta));
        return;
      } catch (err) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: err.message }));
        return;
      }
    }
  }

  // Endpoint: /api/catalog-page
  if (pathname === '/api/catalog-page') {
    const pageIndex = parseInt(parsedUrl.searchParams.get('page') || '0', 10);
    const pageSize = parseInt(parsedUrl.searchParams.get('size') || '100', 10);
    if (catalogService && catalogService.getCatalogPage) {
      try {
        const pageData = await catalogService.getCatalogPage(pageIndex, pageSize);
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'public, max-age=300');
        res.end(JSON.stringify(pageData));
        return;
      } catch (err) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: err.message }));
        return;
      }
    }
  }

  // Endpoint: /api/switch-library
  if (pathname === '/api/switch-library' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => body += chunk);
    req.on('end', async () => {
      try {
        const { targetPath } = JSON.parse(body);
        if (catalogService && catalogService.switchCatalogLibrary) {
          const result = await catalogService.switchCatalogLibrary(targetPath);
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(result));
          return;
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Endpoint: /api/sprites/:id.webp
  if (pathname && pathname.startsWith('/api/sprites/')) {
    const filename = path.basename(pathname);
    const spriteId = path.basename(filename, path.extname(filename));
    const appData = process.env.APPDATA || (process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library/Application Support')
      : path.join(os.homedir(), '.config'));
    const spritePath = spriteService && spriteService.getSpritePath
      ? spriteService.getSpritePath(spriteId)
      : path.join(appData, 'gPhotos', 'cache', 'sprites', `${spriteId}.webp`);

    if (fs.existsSync(spritePath)) {
      res.setHeader('Content-Type', 'image/webp');
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      fs.createReadStream(spritePath).pipe(res);
      return;
    } else {
      res.statusCode = 404;
      res.end('Sprite not found');
      return;
    }
  }

  // Endpoint: /api/sprite-coord
  if (pathname === '/api/sprite-coord') {
    const photoPath = parsedUrl.searchParams.get('path');
    if (photoPath && spriteService && spriteService.getSpriteCoordinate) {
      const coord = spriteService.getSpriteCoordinate(photoPath);
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

    let targetPath = null;
    if (preferOriginal && originalPath && fs.existsSync(originalPath)) {
      targetPath = originalPath;
    } else if (filePath && fs.existsSync(filePath)) {
      targetPath = filePath;
    } else if (originalPath && fs.existsSync(originalPath)) {
      targetPath = originalPath;
    }

    if (targetPath && fs.existsSync(targetPath)) {
      const ext = path.extname(targetPath).toLowerCase();

      // 1. Raw original full resolution
      if (preferOriginal) {
        if (ext === '.heic' || ext === '.heif') {
          const heicBuf = await getHeicBuffer(targetPath);
          if (heicBuf && heicBuf.length > 0) {
            res.setHeader('Content-Type', 'image/jpeg');
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
            res.end(heicBuf);
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

      // 2. Multi-tier thumbnail caching
      const targetSize = requestedSize > 0
        ? requestedSize
        : (quality === 'high' ? 1600 : 250);

      const thumb = await getCachedThumb(targetPath, targetSize);
      if (thumb) {
        if (req.headers['if-none-match'] === thumb.etag) {
          res.statusCode = 304;
          res.end();
          return;
        }
        res.setHeader('ETag', thumb.etag);
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        const stream = fs.createReadStream(thumb.filePath);
        stream.on('error', () => {
          if (!res.headersSent) {
            res.statusCode = 500;
            res.end('Error streaming thumbnail');
          }
        });
        stream.pipe(res);
        return;
      }

      // 3. Fallback direct stream
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

  // Endpoint: /api/file-exists?path=...
  if (pathname === '/api/file-exists') {
    const p = parsedUrl.searchParams.get('path');
    const exists = p ? fs.existsSync(p) : false;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ exists }));
    return;
  }

  // Endpoint: /api/discover-mirrors
  //
  // This used to be its own throwaway reimplementation that always sent
  // sourcePath: '' (not even the real field name — that's
  // networkSourcePath) and a shape (syncIntervalMinutes,
  // isVirtualServerRunning) nothing else in the app recognizes. Accessing
  // the app from a phone browser hit this endpoint, and the renderer wrote
  // its broken object straight into the same persisted storage list the
  // desktop Electron app reads — permanently overwriting a correctly
  // configured storage's real network source path with an empty string,
  // which is exactly what made "Rescan" fail with "No source path
  // configured" and every displayed count go wrong afterward. This is now a
  // direct port of discoverStoredMirrors() in
  // src/main/services/virtualMirrorService.ts (same sample-sidecar ->
  // storageRoot/storageName extraction), kept in sync by hand since this
  // script runs standalone, outside the compiled Electron main process.
  if (pathname === '/api/discover-mirrors') {
    const defaultRoot = 'C:\\GPhotos_VirtualMirrors';
    const housekeepingFiles = new Set(['_sync_checkpoint.json', '_mirror_summary.json']);
    const isHousekeeping = (name) => housekeepingFiles.has(name) || name.startsWith('.');
    const mirrors = [];
    if (fs.existsSync(defaultRoot)) {
      try {
        const entries = fs.readdirSync(defaultRoot, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.name.startsWith('.')) continue;

          const subDir = path.join(defaultRoot, entry.name);
          const summaryFile = path.join(subDir, '_mirror_summary.json');

          if (fs.existsSync(summaryFile)) {
            try {
              const cached = JSON.parse(fs.readFileSync(summaryFile, 'utf-8'));
              if (cached && cached.name) {
                mirrors.push(cached);
                continue;
              }
            } catch {}
          }

          let detectedName = entry.name;
          let networkSourcePath = '';
          let sampleMetaFound = false;
          let totalPhotos = 0;
          let sampleOrigSize = 0;
          let sampleThumbSize = 0;
          let latestMtime = 0;

          const quickScan = (dir, depth) => {
            if (depth > 6) return;
            try {
              const subEntries = fs.readdirSync(dir, { withFileTypes: true });
              for (const se of subEntries) {
                const p = path.join(dir, se.name);
                if (se.isDirectory() && !se.name.startsWith('.')) {
                  quickScan(p, depth + 1);
                } else if (se.isFile() && se.name.endsWith('.json') && !isHousekeeping(se.name)) {
                  totalPhotos++;
                  if (!sampleMetaFound) {
                    try {
                      const stat = fs.statSync(p);
                      if (stat.mtimeMs > latestMtime) latestMtime = stat.mtimeMs;
                      const meta = JSON.parse(fs.readFileSync(p, 'utf-8'));
                      if (meta.storageName) detectedName = meta.storageName;
                      if (meta.storageRoot) networkSourcePath = meta.storageRoot;
                      sampleOrigSize = meta.originalFileSize || 3500000;
                      if (meta.thumbnailPath && fs.existsSync(meta.thumbnailPath)) {
                        sampleThumbSize = fs.statSync(meta.thumbnailPath).size;
                      }
                      sampleMetaFound = true;
                    } catch {}
                  }
                }
              }
            } catch {}
          };

          quickScan(subDir, 0);

          if (totalPhotos > 0) {
            const estOriginal = totalPhotos * (sampleOrigSize || 3500000);
            const estThumb = totalPhotos * (sampleThumbSize || 65000);
            const config = {
              id: `storage_${entry.name}`,
              name: detectedName,
              networkSourcePath: networkSourcePath || subDir,
              localMirrorRoot: defaultRoot,
              lastSynced: latestMtime > 0 ? new Date(latestMtime).toISOString() : new Date().toISOString(),
              totalItems: totalPhotos,
              totalSizeSaved: Math.max(0, estOriginal - estThumb),
            };
            mirrors.push(config);
            try {
              fs.writeFileSync(summaryFile, JSON.stringify(config, null, 2), 'utf-8');
            } catch {}
          }
        }
      } catch {}
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(mirrors));
    return;
  }

  // Serve static files from dist/ or public/ (models, icons, assets)
  let relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
  let fullPath = path.join(DIST_DIR, relativePath);

  // If not found in dist, check public
  if (!fs.existsSync(fullPath)) {
    const publicCandidate = path.join(PUBLIC_DIR, relativePath);
    if (fs.existsSync(publicCandidate)) {
      fullPath = publicCandidate;
    }
  }

  // If file doesn't exist and has no extension, fallback to index.html (SPA routing)
  if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
    fullPath = path.join(DIST_DIR, 'index.html');
  }

  if (fs.existsSync(fullPath) && !fs.statSync(fullPath).isDirectory()) {
    const ext = path.extname(fullPath).toLowerCase();
    res.setHeader('Content-Type', MIME_TYPES[ext] || 'application/octet-stream');
    fs.createReadStream(fullPath).pipe(res);
  } else {
    res.statusCode = 404;
    res.end('Not Found');
  }
}

function startServer(port) {
  const srv = http.createServer((req, res) => {
    req.setTimeout(12000, () => {
      if (!res.headersSent) {
        res.statusCode = 408;
        res.end('Request Timeout');
      }
    });

    handleRequest(req, res).catch((err) => {
      console.error('[MobileServer] Unhandled request error:', err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end('Internal Server Error');
      }
    });
  });
  srv.once('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      try {
        srv.close();
      } catch {}
      console.warn(`  ⚠️ Port ${port} is already in use, trying port ${port + 1}...`);
      startServer(port + 1);
    } else {
      console.error('Server error:', err);
    }
  });

  srv.listen(port, '0.0.0.0', () => {
    const ips = getNetworkIps();
    const primaryIp = ips.find((i) => i.name.toLowerCase().includes('wi-fi') || i.name.toLowerCase().includes('wireless'))?.address || ips[0]?.address || 'localhost';

    console.log('\n================================================================');
    console.log('   ✨ gPhotos Desktop — Mobile Web Server is Running! ✨');
    console.log('================================================================\n');
    console.log(`  📱 Open on your iPhone or Android browser (Chrome / Safari):`);
    console.log(`     👉 http://${primaryIp}:${port}/\n`);
    console.log(`  💻 Open locally on this PC:`);
    console.log(`     👉 http://localhost:${port}/\n`);

    if (ips.length > 1) {
      console.log('  Other Available Network Interfaces:');
      for (const item of ips) {
        console.log(`   - ${item.name}: http://${item.address}:${port}/`);
      }
      console.log('');
    }

    console.log('  🔒 Tips for Mobile:');
    console.log('   1. Ensure your phone is connected to the same Wi-Fi network.');
    console.log('   2. On iPhone: In Safari, tap "Share" -> "Add to Home Screen" to use as a full-screen app!');
    console.log('   3. On Android: In Chrome, tap "Menu" (3 dots) -> "Install App" or "Add to Home Screen".');
    console.log('\n================================================================\n');
  });
}

if (require.main === module) {
  process.on('uncaughtException', (err) => {
    console.error('[MobileServer] Uncaught Exception:', err);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[MobileServer] Unhandled Rejection:', reason);
  });
  process.on('SIGINT', () => {
    console.log('[MobileServer] Received SIGINT');
  });
  process.on('SIGTERM', () => {
    console.log('[MobileServer] Received SIGTERM');
  });
  process.on('SIGBREAK', () => {
    console.log('[MobileServer] Received SIGBREAK');
  });
  process.on('exit', (code) => {
    console.log(`[MobileServer] Exiting with code: ${code}`);
  });

  // Keep event loop active and ignore stdin closure
  if (process.stdin.isTTY === false) {
    process.stdin.resume();
  }

  startServer(PORT);
}

module.exports = { startServer, handleRequest, getLibraryPath };

