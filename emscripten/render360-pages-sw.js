/* Render360 Portal staging service worker.
 *
 * GitHub Pages cannot set COOP/COEP response headers itself. This worker
 * injects them after the first controlled reload so the upstream pthread /
 * SharedArrayBuffer runtime can be exercised on static hosting.
 *
 * Portal's Source runtime still requests the original same-origin
 * `chunks/<map>.data` path. Keep the original web port's packed data as the
 * authoritative first choice because those chunks were generated from the
 * Source engine's real OpenForRead trace/order. A locally generated VPK chunk
 * is only the fallback when the original host cannot be reached.
 *
 * The user-generated Source boot overlay is deliberately served as its own
 * response and lives in its own Cache Storage bucket. v2 also contains the
 * retail Source .vcs shader cache needed by libstdshader_dx9 before the first
 * rendered frame. Keeping it separate avoids rebuilding hundreds of MiB of map
 * chunks just to refresh bootstrap material/shader resources.
 *
 * Mutable engine assets (.js/.wasm/.so/.html and the generated launcher .data
 * package containing runtime SIDE_MODULEs) are always fetched network-first
 * with cache:no-store. Stable filenames must never mix across Pages deploys.
 *
 * No retail game data is committed to GitHub Pages.
 */

const LOCAL_CHUNK_CACHE = 'render360-portal-local-chunks-v2';
const OLD_LOCAL_CHUNK_CACHE = 'render360-portal-local-chunks-v1';
const BOOT_OVERLAY_CACHE = 'render360-portal-boot-overlay-v2';
const OLD_BOOT_OVERLAY_CACHE = 'render360-portal-boot-overlay-v1';
const BOOT_OVERLAY_PATH = './render360-bootstrap-overlay.data';
const UPSTREAM_CHUNK_BASE = 'https://yikes.pw/portal/chunks/';
const UPSTREAM_TIMEOUT_MS = 8000;
const UPSTREAM_RETRY_COOLDOWN_MS = 60000;
const MUTABLE_RUNTIME_RE = /\.(?:html?|js|mjs|wasm|so|json|data)$/i;

// Never delete the current local map cache merely because a new service worker
// activates. The iPhone staging page can spend minutes building chunks from
// user-selected VPKs; schema changes should bump LOCAL_CHUNK_CACHE instead.
const REBUILD_LOCAL_CHUNKS_ON_ACTIVATE = false;
let upstreamUnavailableUntil = 0;

self.addEventListener('install', event => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    await Promise.all([
      caches.delete(OLD_LOCAL_CHUNK_CACHE),
      // Invalidate the old 18-record texture-only overlay. A stale v1 overlay
      // would otherwise let the page say "boot ready" while Source still lacks
      // shaders/fxc/*.vcs and aborts at vertexlit_and_unlit_generic_*.
      caches.delete(OLD_BOOT_OVERLAY_CACHE)
    ]);
    if (REBUILD_LOCAL_CHUNKS_ON_ACTIVATE) {
      await caches.delete(LOCAL_CHUNK_CACHE);
      console.info('[Render360 Pages SW] cleared local Portal chunks for clean runtime rebuild');
    }
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
  if (event.data.type === 'RENDER360_CLEAR_BOOT_OVERLAY') {
    event.waitUntil(Promise.all([
      caches.delete(BOOT_OVERLAY_CACHE),
      caches.delete(OLD_BOOT_OVERLAY_CACHE)
    ]));
  }
});

function isolationHeaders(headers, extraHeaders = {}) {
  const out = new Headers(headers);
  out.set('Cross-Origin-Opener-Policy', 'same-origin');
  out.set('Cross-Origin-Embedder-Policy', 'require-corp');
  out.set('Cross-Origin-Resource-Policy', 'same-origin');
  for (const [key, value] of Object.entries(extraHeaders)) out.set(key, value);
  return out;
}

function withIsolationHeaders(response, extraHeaders = {}) {
  if (!response || response.status === 0) return response;
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: isolationHeaders(response.headers, extraHeaders)
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
  const upstreamUrl = UPSTREAM_CHUNK_BASE + encodeURIComponent(name);

  // The original hosted chunks are the canonical Portal web-port chunks. Use
  // them first whenever the host is healthy. This restores the exact map delta
  // plan that weliveinhell/source-engine's DataLoader was written for instead
  // of silently preferring our heuristic VPK reconstruction just because a
  // local cache entry exists.
  if (Date.now() >= upstreamUnavailableUntil) {
    try {
      const upstream = await fetchUpstreamChunk(upstreamUrl);
      if (!upstream.ok) throw new Error(`HTTP ${upstream.status}`);
      upstreamUnavailableUntil = 0;
      return withIsolationHeaders(upstream, {
        'Cache-Control': 'no-store, max-age=0',
        'X-Render360-Chunk-Source': 'upstream-yikes'
      });
    } catch (error) {
      upstreamUnavailableUntil = Date.now() + UPSTREAM_RETRY_COOLDOWN_MS;
      console.warn('[Render360 Pages SW] original Portal chunk unavailable; trying local VPK fallback', upstreamUrl, error);
    }
  }

  // Only fall back to browser-generated chunks after the original host failed.
  // Cache Storage can stream the stored Response back without rebuilding all
  // VPKs or retaining the user's selected File objects in the launcher page.
  const local = await cache.match(request, { ignoreSearch: true });
  if (local && local.ok) {
    return withIsolationHeaders(local, {
      'Cache-Control': 'no-store, max-age=0',
      'X-Render360-Chunk-Source': 'local-vpk'
    });
  }

  return withIsolationHeaders(new Response(
    'Portal chunk unavailable from the original Source web-port host and the local VPK cache.',
    { status: 502, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
  ), {
    'X-Render360-Chunk-Source': 'unavailable'
  });
}

async function serveBootOverlay() {
  const cache = await caches.open(BOOT_OVERLAY_CACHE);
  const overlayUrl = new URL(BOOT_OVERLAY_PATH, self.location.href).href;
  const overlay = await cache.match(overlayUrl, { ignoreSearch: true });
  if (!overlay || !overlay.ok) {
    return withIsolationHeaders(new Response('Render360 local boot/shader overlay not prepared', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    }), {
      'Cache-Control': 'no-store, max-age=0',
      'X-Render360-Chunk-Source': 'local-boot-missing'
    });
  }

  return withIsolationHeaders(overlay, {
    'Content-Type': 'application/octet-stream',
    'Cache-Control': 'no-store, max-age=0',
    'X-Render360-Chunk-Source': 'local-boot-overlay-v2'
  });
}

async function fetchRuntimeFresh(request) {
  const freshRequest = new Request(request, { cache: 'no-store' });
  const response = await fetch(freshRequest);
  return withIsolationHeaders(response, {
    'Cache-Control': 'no-store, max-age=0',
    'X-Render360-Runtime-Fresh': '1'
  });
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
    if (request.method === 'GET' && url.pathname.endsWith('/render360-bootstrap-overlay.data')) {
      return serveBootOverlay();
    }
    if (request.method === 'GET' && /\/chunks\/[^/]+\.data$/i.test(url.pathname)) {
      return servePortalChunk(request, url);
    }
    if (request.method === 'GET' && MUTABLE_RUNTIME_RE.test(url.pathname)) {
      return fetchRuntimeFresh(request);
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
        'Cross-Origin-Resource-Policy': 'same-origin',
        'Cache-Control': 'no-store, max-age=0'
      }
    });
  }));
});