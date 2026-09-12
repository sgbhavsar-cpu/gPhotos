/**
 * gPhotos Mobile Service Worker
 * Blazing-fast client-side Cache Storage for thumbnails and photo previews.
 */

const CACHE_NAME = 'gphotos-thumbnails-v1';
const MAX_CACHE_ENTRIES = 1500;

self.addEventListener('install', (event) => {
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

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Only intercept GET requests to /api/photo (thumbnails & previews)
  if (event.request.method === 'GET' && url.pathname === '/api/photo') {
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        // 1. Check client-side disk/memory cache
        const cachedResponse = await cache.match(event.request);
        if (cachedResponse) {
          return cachedResponse;
        }

        // 2. Fetch from local network server
        try {
          const networkResponse = await fetch(event.request);
          if (networkResponse && networkResponse.status === 200) {
            cache.put(event.request, networkResponse.clone());
            // Trim old entries asynchronously
            trimCache(cache, MAX_CACHE_ENTRIES).catch(() => {});
          }
          return networkResponse;
        } catch (err) {
          // If offline or network error, return cached or fallback
          if (cachedResponse) return cachedResponse;
          throw err;
        }
      })
    );
  }
});
