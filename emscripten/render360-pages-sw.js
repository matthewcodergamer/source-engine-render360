/* Render360 Portal staging service worker.
 *
 * GitHub Pages cannot set COOP/COEP response headers itself. This worker
 * injects them after the first controlled reload so the upstream pthread /
 * SharedArrayBuffer runtime can be exercised on static hosting.
 *
 * Portal's Source runtime still requests the original same-origin
 * `chunks/<map>.data` path. This worker provides that path from either:
 *   1. chunks generated locally from the user's selected Portal/VPK files, or
 *   2. the original yikes.pw packed-data host when CORS allows it.
 *
 * No retail game data is committed to GitHub Pages.
 */

const LOCAL_CHUNK_CACHE = 'render360-portal-local-chunks-v2';
const OLD_LOCAL_CHUNK_CACHE = 'render360-portal-local-chunks-v1';
const UPSTREAM_CHUNK_BASE = 'https://yikes.pw/portal/chunks/';
const UPSTREAM_TIMEOUT_MS = 8000;

self.addEventListener('install', event => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    await caches.delete(OLD_LOCAL_CHUNK_CACHE);
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (!event.data) return;
  if (event.data.type === 'RENDER360_CLEAR_LOCAL_CHUNKS') {
    event.waitUntil(Promise.all([
      caches.delete(LOCAL_CHUNK_CACHE),
      caches.delete(OLD_LOCAL_CHUNK_CACHE)
    ]));
  }
});

function withIsolationHeaders(response, extraHeaders = {}) {
  if (!response || response.status === 0) return response;
  const headers = new Headers(response.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  for (const [key, value] of Object.entries(extraHeaders)) headers.set(key, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

async function fetchUpstreamChunk(upstreamUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('upstream chunk timeout'), UPSTREAM_TIMEOUT_MS);
  try {
    return await fetch(upstreamUrl, {
      method: 'GET',
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

async function servePortalChunk(request, url) {
  const name = url.pathname.split('/').pop();
  const cache = await caches.open(LOCAL_CHUNK_CACHE);
  const local = await cache.match(request, { ignoreSearch: true });
  if (local) {
    return withIsolationHeaders(local, {
      'X-Render360-Chunk-Source': 'local-vpk'
    });
  }

  const upstreamUrl = UPSTREAM_CHUNK_BASE + encodeURIComponent(name);
  try {
    const upstream = await fetchUpstreamChunk(upstreamUrl);
    if (!upstream.ok) throw new Error(`HTTP ${upstream.status}`);
    return withIsolationHeaders(upstream, {
      'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
      'X-Render360-Chunk-Source': 'upstream-yikes'
    });
  } catch (error) {
    console.warn('[Render360 Pages SW] upstream chunk unavailable', upstreamUrl, error);
    return withIsolationHeaders(new Response(
      'Portal chunk unavailable from both local VPK cache and original upstream host: ' + String(error),
      { status: 502, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
    ), {
      'X-Render360-Chunk-Source': 'unavailable'
    });
  }
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return;

  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;

  if (!sameOrigin) {
    event.respondWith(fetch(request));
    return;
  }

  event.respondWith((async () => {
    if (request.method === 'GET' && /\/chunks\/[^/]+\.data$/i.test(url.pathname)) {
      return servePortalChunk(request, url);
    }
    return withIsolationHeaders(await fetch(request));
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
