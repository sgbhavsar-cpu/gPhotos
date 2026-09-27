/**
 * gPhotos Mobile Service Worker
 * Client-side Cache Storage for thumbnails and photo previews, stale-while-revalidate.
 *
 * Note: browsers only allow service workers on secure contexts (https or
 * localhost), so over plain-http LAN access this file never registers and the
 * app simply falls back to the server's own Cache-Control/ETag headers.
 */

const CACHE_NAME = 'gphotos-thumbnails-v2';
const MAX_CACHE_ENTRIES = 1500;
// Entries younger than this are served without asking the server whether they changed.
const REVALIDATE_AFTER_MS = 10 * 60 * 1000;

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

async function trimCache(cache, maxItems) {
  const keys = await cache.keys();
  if (keys.length > maxItems) {
    const toDelete = keys.slice(0, keys.length - maxItems);
    await Promise.all(toDelete.map((req) => cache.delete(req)));
  }
}

// The pairing token is only auth, not identity: leaving it in the key would
// duplicate every entry each time the device re-pairs.
function cacheKeyFor(url) {
  const u = new URL(url.href);
  u.searchParams.delete('token');
  return new Request(u.href);
}

function isFresh(response) {
  const date = Date.parse(response.headers.get('date') || '');
  return Number.isFinite(date) && Date.now() - date < REVALIDATE_AFTER_MS;
}

// A 401 means this device's token was revoked: drop everything it cached.
function purgeIfRevoked(response) {
  if (response && response.status === 401) {
    return caches.delete(CACHE_NAME);
  }
}

async function putAndTrim(cache, key, response) {
  await cache.put(key, response);
  await trimCache(cache, MAX_CACHE_ENTRIES);
}

async function revalidate(cache, key, cached, url) {
  const headers = {};
  const etag = cached.headers.get('etag');
  const lastModified = cached.headers.get('last-modified');
  if (etag) headers['If-None-Match'] = etag;
  else if (lastModified) headers['If-Modified-Since'] = lastModified;
  const res = await fetch(url.href, { headers, cache: 'no-cache', credentials: 'same-origin' });
  if (res.status === 200) {
    await putAndTrim(cache, key, res.clone());
  } else if (res.status === 401) {
    await purgeIfRevoked(res);
  }
  // 304 (or a transient error): keep what we have.
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Only intercept GET requests to /api/photo (thumbnails & previews).
  if (req.method !== 'GET' || url.pathname !== '/api/photo') return;
  // Full-size originals would blow the storage quota, and partial (Range) responses can't be cached.
  const pref = url.searchParams.get('preferOriginal');
  if (pref === '1' || pref === 'true' || req.headers.has('range')) return;

  const key = cacheKeyFor(url);

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(key);
      if (cached) {
        if (!isFresh(cached)) {
          event.waitUntil(revalidate(cache, key, cached, url).catch(() => {}));
        }
        return cached;
      }

      const networkResponse = await fetch(req);
      if (networkResponse.status === 200) {
        event.waitUntil(putAndTrim(cache, key, networkResponse.clone()).catch(() => {}));
      } else if (networkResponse.status === 401) {
        event.waitUntil(Promise.resolve(purgeIfRevoked(networkResponse)).catch(() => {}));
      }
      return networkResponse;
    })
  );
});
