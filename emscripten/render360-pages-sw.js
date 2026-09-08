/* Render360 Portal staging service worker.
 *
 * GitHub Pages cannot set COOP/COEP response headers itself. This worker
 * injects them after the first controlled reload so the upstream pthread /
 * SharedArrayBuffer runtime can be exercised on static hosting.
 *
 * It also serves user-imported Portal chunk .data files from Cache Storage.
 * Those files remain local to the browser and are never committed to GitHub.
 */

const LOCAL_CHUNK_CACHE = 'render360-portal-local-chunks-v1';

self.addEventListener('install', event => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', event => {
  if (!event.data) return;
  if (event.data.type === 'RENDER360_CLEAR_LOCAL_CHUNKS') {
    event.waitUntil(caches.delete(LOCAL_CHUNK_CACHE));
  }
});

function withIsolationHeaders(response) {
  if (!response || response.status === 0) return response;

  const headers = new Headers(response.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

self.addEventListener('fetch', event => {
  const request = event.request;

  // Chromium can emit this combination for devtools/cache internals. Let the
  // browser handle it rather than throwing inside the service worker.
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') {
    return;
  }

  event.respondWith((async () => {
    const url = new URL(request.url);
    const sameOrigin = url.origin === self.location.origin;
    let response = null;

    if (sameOrigin && request.method === 'GET' && /\/chunks\/[^/]+\.data$/i.test(url.pathname)) {
      const cache = await caches.open(LOCAL_CHUNK_CACHE);
      response = await cache.match(request, { ignoreSearch: true });
    }

    if (!response) {
      response = await fetch(request);
    }

    return withIsolationHeaders(response);
  })().catch(error => {
    console.error('[Render360 Pages SW] fetch failed', request.url, error);
    return new Response('Render360 staging fetch failed: ' + String(error), {
      status: 502,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Resource-Policy': 'same-origin'
      }
    });
  }));
});
