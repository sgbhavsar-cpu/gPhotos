import assert from 'assert';
import http from 'http';
import { spawn } from 'child_process';
import path from 'path';

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJson(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}

const { handleRequest } = require('../scripts/serve_mobile.js');

async function ensureServerRunning(preferredPort: number = 5174): Promise<{ server: any; port: number }> {
  try {
    const res = await fetchJson(`http://127.0.0.1:${preferredPort}/api/library`);
    if (res && (res.gphotos_library_v1 || res.photos)) {
      console.log(`✓ Web server is already running on port ${preferredPort}`);
      return { server: null, port: preferredPort };
    }
  } catch {}

  return new Promise((resolve, reject) => {
    function tryPort(p: number) {
      const srv = http.createServer(handleRequest);
      srv.once('error', (err: any) => {
        if (err.code === 'EADDRINUSE') {
          tryPort(p + 1);
        } else {
          reject(err);
        }
      });
      srv.listen(p, '0.0.0.0', () => {
        console.log(`✓ Web server started on port ${p}`);
        resolve({ server: srv, port: p });
      });
    }
    tryPort(preferredPort);
  });
}

console.log('🧪 RUNNING END-TO-END TESTS: SIDEBAR NO-OVERLAP SCROLL & BROWSER WEB PHOTO RENDERING...');

async function runTests() {
  const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const { server, port } = await ensureServerRunning(5174);
  const url = `http://192.168.29.30:${port}/`;

  console.log('▶ Test 1: Web server API /api/library verification');
  const libData = await fetchJson('http://127.0.0.1:5174/api/library');
  const photos = libData.gphotos_library_v1?.photos || libData.photos || [];
  assert.ok(photos.length > 0, `Library must contain photos, found: ${photos.length}`);
  console.log(`  ✓ /api/library returned ${photos.length} photos successfully`);

  console.log('▶ Test 2: Real Chromium/Edge browser rendering on ' + url);
  const edge = spawn(edgePath, [
    '--headless=new',
    '--remote-debugging-port=9223',
    '--disable-gpu',
    '--user-data-dir=' + process.env.TEMP + '\\edge-test-' + Date.now(),
    url,
  ]);

  let targets: any = null;
  for (let i = 0; i < 25; i++) {
    await sleep(200);
    try {
      targets = await fetchJson('http://127.0.0.1:9223/json');
      if (targets && targets.length > 0) break;
    } catch {}
  }

  assert.ok(targets && targets.length > 0, 'Must connect to browser CDP');
  const target = targets.find((t: any) => t.type === 'page' && t.url.includes('5174')) || targets[0];
  console.log(`  ✓ Connected to browser page target: "${target.title}"`);

  const WsClass = (globalThis as any).WebSocket;
  assert.ok(WsClass, 'WebSocket required for CDP communication');

  const ws = new WsClass(target.webSocketDebuggerUrl);

  const evaluationResult: any = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('CDP evaluation timed out'));
    }, 15000);

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.enable' }));

      // Set desktop window with constrained height (1280x680)
      ws.send(
        JSON.stringify({
          id: 2,
          method: 'Emulation.setDeviceMetricsOverride',
          params: {
            width: 1280,
            height: 680,
            deviceScaleFactor: 1,
            mobile: false,
          },
        })
      );

      // Wait 3.5s for React to mount, fetch library, and render DOM
      setTimeout(() => {
        ws.send(
          JSON.stringify({
            id: 10,
            method: 'Runtime.evaluate',
            params: {
              expression: `(() => {
                const sidebar = document.querySelector('.sidebar-scrollable');
                const nav = sidebar ? sidebar.querySelector('nav') : null;
                const activeLib = sidebar ? Array.from(sidebar.querySelectorAll('div')).find(d => d.innerText && d.innerText.includes('Active Library:')) : null;
                
                let isOverlapping = false;
                if (nav && activeLib) {
                  const navRect = nav.getBoundingClientRect();
                  const libRect = activeLib.getBoundingClientRect();
                  isOverlapping = (libRect.top < navRect.bottom);
                }

                const images = Array.from(document.querySelectorAll('img')).map(i => i.src);

                return {
                  hasNoPhotos: document.body.innerHTML.includes('No Photos in Library Yet'),
                  imgCount: images.length,
                  firstFewImages: images.slice(0, 3),
                  sidebarExists: !!sidebar,
                  sidebarScrollHeight: sidebar ? sidebar.scrollHeight : 0,
                  sidebarClientHeight: sidebar ? sidebar.clientHeight : 0,
                  sidebarIsScrollable: sidebar ? (sidebar.scrollHeight > sidebar.clientHeight) : false,
                  isOverlapping: isOverlapping,
                  activeLibraryText: activeLib ? activeLib.innerText.replace(/\\n/g, ' ') : null,
                };
              })()`,
              returnByValue: true,
            },
          })
        );
      }, 3500);
    });

    ws.addEventListener('message', (evt: any) => {
      try {
        const msg = JSON.parse(evt.data);
        if (msg.id === 10) {
          clearTimeout(timer);
          resolve(msg.result?.result?.value);
        }
      } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    });
  });

  edge.kill();

  console.log('▶ Test 3: Validating browser photos rendering');
  assert.strictEqual(evaluationResult.hasNoPhotos, false, 'Web browser must NOT show "No Photos in Library Yet"');
  assert.ok(evaluationResult.imgCount > 0, `Web browser must render photo images, found: ${evaluationResult.imgCount}`);
  assert.ok(
    evaluationResult.firstFewImages[0].includes('/api/photo?path='),
    'Photo src must point to /api/photo HTTP endpoint'
  );
  console.log(`  ✓ Browser rendered ${evaluationResult.imgCount} photos successfully via /api/photo!`);

  console.log('▶ Test 4: Validating Desktop Sidebar scrolling and non-overlapping layout');
  assert.strictEqual(evaluationResult.sidebarExists, true, 'Sidebar must be rendered');
  assert.strictEqual(evaluationResult.isOverlapping, false, 'Menu items must NEVER overlap the Active Library section');
  assert.strictEqual(evaluationResult.sidebarIsScrollable, true, 'Sidebar must be scrollable when content exceeds height');
  console.log(
    `  ✓ Sidebar scroll verified: scrollHeight=${evaluationResult.sidebarScrollHeight}px > clientHeight=${evaluationResult.sidebarClientHeight}px (isScrollable: true)`
  );
  if (server) {
    server.close();
  }

  console.log('\n🎉 ALL 4/4 END-TO-END BROWSER & SIDEBAR SCROLL TESTS PASSED PERFECTLY!\n');
}

runTests().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
