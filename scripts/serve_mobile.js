const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const url = require('url');

const PORT = parseInt(process.env.PORT || '5173', 10);
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
    path.join(appData, 'gPhotos', 'library.json'),
    path.join(appData, 'gphotos-desktop', 'library.json'),
    path.join(__dirname, '..', 'library.json'),
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return candidates[0];
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

// Lazy-loaded exifr for iPhone HEIC embedded JPEG extraction
let exifr = null;
try {
  exifr = require('exifr');
} catch {}

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

  // Endpoint: /api/photo?path=...
  if (pathname === '/api/photo') {
    const filePath = parsedUrl.searchParams.get('path');
    const originalPath = parsedUrl.searchParams.get('originalPath');
    const preferOriginal =
      parsedUrl.searchParams.get('preferOriginal') === '1' ||
      parsedUrl.searchParams.get('preferOriginal') === 'true';

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

      // Handle iPhone HEIC/HEIF photos by extracting embedded JPEG preview
      if (ext === '.heic' || ext === '.heif') {
        if (exifr && typeof exifr.thumbnail === 'function') {
          try {
            const thumbBuffer = await exifr.thumbnail(targetPath);
            if (thumbBuffer && thumbBuffer.length > 0) {
              res.setHeader('Content-Type', 'image/jpeg');
              res.end(Buffer.from(thumbBuffer));
              return;
            }
          } catch (heicErr) {
            console.warn('Failed to extract embedded JPEG from HEIC:', heicErr);
          }
        }
      }

      res.setHeader('Content-Type', MIME_TYPES[ext] || 'image/jpeg');
      fs.createReadStream(targetPath).pipe(res);
      return;
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
  if (pathname === '/api/discover-mirrors') {
    const defaultRoot = 'C:\\GPhotos_VirtualMirrors';
    const mirrors = [];
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
              totalItems: files.filter((f) => /\.(jpe?g|png|webp|gif|bmp)$/i.test(f)).length,
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
  const srv = http.createServer(handleRequest);
  srv.once('error', (err) => {
    if (err.code === 'EADDRINUSE') {
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
    console.log('   ✨ Google Photos Desktop — Mobile Web Server is Running! ✨');
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

startServer(PORT);

