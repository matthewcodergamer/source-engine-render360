/* Render360 Portal staging service worker.
 *
 * GitHub Pages cannot set COOP/COEP response headers itself. This worker
 * injects them after the first controlled reload so the upstream pthread /
 * SharedArrayBuffer runtime can be exercised on static hosting.
 *
 * Important: the original Portal port keeps packed game chunks outside the
 * GitHub source tree and serves them from yikes.pw. Cross-origin chunk
 * requests are therefore passed through unchanged; only same-origin Pages
 * responses receive the isolation headers below.
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

  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') {
    return;
  }

  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;

  // Preserve the original upstream response and its CORS/CORP headers. Adding
  // a same-origin CORP header to yikes.pw here would make the browser reject
  // the very cross-origin chunk we are trying to load.
  if (!sameOrigin) {
    event.respondWith(fetch(request));
    return;
  }

  event.respondWith((async () => {
    let response = null;

    if (request.method === 'GET' && /\/chunks\/[^/]+\.data$/i.test(url.pathname)) {
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
