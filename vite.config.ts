import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import fs from 'fs';
import os from 'os';

function photoApiPlugin() {
  const getLibraryPath = () => {
    const appData =
      process.env.APPDATA ||
      (process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library/Application Support')
        : path.join(os.homedir(), '.config'));
    const candidates = [
      path.join(appData, 'gPhotos', 'library.json'),
      path.join(appData, 'gphotos-desktop', 'library.json'),
      path.join(__dirname, 'library.json'),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    return candidates[0];
  };

  return {
    name: 'photo-api-plugin',
    configureServer(server: any) {
      server.middlewares.use((req: any, res: any, next: any) => {
        const urlObj = new URL(req.url || '', 'http://localhost:5173');

        if (urlObj.pathname === '/api/library') {
          const libPath = getLibraryPath();
          if (req.method === 'GET') {
            if (fs.existsSync(libPath)) {
              res.setHeader('Content-Type', 'application/json');
              fs.createReadStream(libPath).pipe(res);
            } else {
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({}));
            }
            return;
          } else if (req.method === 'POST') {
            let body = '';
            req.on('data', (c: any) => {
              body += c;
            });
            req.on('end', () => {
              try {
                const { key, data } = JSON.parse(body);
                let current: any = {};
                if (fs.existsSync(libPath)) {
                  current = JSON.parse(fs.readFileSync(libPath, 'utf8'));
                }
                current[key] = data;
                fs.mkdirSync(path.dirname(libPath), { recursive: true });
                fs.writeFileSync(libPath, JSON.stringify(current, null, 2), 'utf8');
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ success: true }));
              } catch (e: any) {
                res.statusCode = 500;
                res.end(JSON.stringify({ error: e.message }));
              }
            });
            return;
          }
        }

        if (urlObj.pathname === '/api/photo') {
          const filePath = urlObj.searchParams.get('path');
          const originalPath = urlObj.searchParams.get('originalPath');
          const preferOriginal =
            urlObj.searchParams.get('preferOriginal') === '1' ||
            urlObj.searchParams.get('preferOriginal') === 'true';

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
            const mimeMap: Record<string, string> = {
              '.jpg': 'image/jpeg',
              '.jpeg': 'image/jpeg',
              '.png': 'image/png',
              '.webp': 'image/webp',
              '.gif': 'image/gif',
              '.bmp': 'image/bmp',
            };
            res.setHeader('Content-Type', mimeMap[ext] || 'image/jpeg');
            res.setHeader('Access-Control-Allow-Origin', '*');
            fs.createReadStream(targetPath).pipe(res);
            return;
          } else {
            res.statusCode = 404;
            res.end('Photo not found');
            return;
          }
        }

        if (urlObj.pathname === '/api/file-exists') {
          const p = urlObj.searchParams.get('path');
          const exists = p ? fs.existsSync(p) : false;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ exists }));
          return;
        }

        if (urlObj.pathname === '/api/discover-mirrors') {
          const defaultRoot = 'C:\\GPhotos_VirtualMirrors';
          const mirrors: any[] = [];
          if (fs.existsSync(defaultRoot)) {
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
          }
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(mirrors));
          return;
        }

        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), photoApiPlugin()],
  root: path.resolve(__dirname, 'src/renderer'),
  base: './',
  publicDir: path.resolve(__dirname, 'public'),
  build: {
    outDir: path.resolve(__dirname, 'dist'),
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src/renderer/src'),
      '@shared': path.resolve(__dirname, 'src/types'),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
  },
});

