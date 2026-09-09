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
 * A tiny user-generated boot overlay may also be appended to background1.data.
 * The overlay contains shared HL2/Source bootstrap textures that the engine asks
 * for before the first frame but that are not reliably present in the historical
 * packed web chunk. Appending is safe because the .data format is simply a
 * concatenation of independent records.
 *
 * Mutable engine assets (.js/.wasm/.so/.html and the generated launcher .data
 * package containing runtime SIDE_MODULEs) are always fetched network-first
 * with cache:no-store. Chunk .data requests are handled separately above.
 * Stable filenames must never mix across Pages deployments on Safari.
 *
 * No retail game data is committed to GitHub Pages.
 */

const LOCAL_CHUNK_CACHE = 'render360-portal-local-chunks-v2';
const OLD_LOCAL_CHUNK_CACHE = 'render360-portal-local-chunks-v1';
const BOOT_OVERLAY_PATH = './render360-bootstrap-overlay.data';
const UPSTREAM_CHUNK_BASE = 'https://yikes.pw/portal/chunks/';
const UPSTREAM_TIMEOUT_MS = 8000;
const MUTABLE_RUNTIME_RE = /\.(?:html?|js|mjs|wasm|so|json|data)$/i;

// This staging revision changes how Source handles optional desktop .so modules.
// Force one clean VPK-cache rebuild when the new worker activates so an iPhone
// cannot keep testing a chunk set created by an older runtime revision.
const REBUILD_LOCAL_CHUNKS_ON_ACTIVATE = true;

self.addEventListener('install', event => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    await caches.delete(OLD_LOCAL_CHUNK_CACHE);
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

// Keep concatenation pull-driven. A 220 MiB background chunk must not be copied
// into a second ArrayBuffer just to append a few tiny VPK records, and cancelling
// the launch-page chunk probe must stop the upstream response immediately.
function concatReadableResponses(responses) {
  let index = 0;
  let reader = null;
  return new ReadableStream({
    async pull(controller) {
      while (index < responses.length) {
        const response = responses[index];
        if (!response || !response.body) {
          index++;
          continue;
        }
        if (!reader) reader = response.body.getReader();
        const { done, value } = await reader.read();
        if (done) {
          try { reader.releaseLock(); } catch (_) {}
          reader = null;
          index++;
          continue;
        }
        controller.enqueue(value);
        return;
      }
      controller.close();
    },
    async cancel(reason) {
      if (reader) {
        try { await reader.cancel(reason); } catch (_) {}
        reader = null;
      }
      for (let i = index + 1; i < responses.length; i++) {
        try { await responses[i]?.body?.cancel(reason); } catch (_) {}
      }
    }
  });
}

async function withBootOverlay(baseResponse, cache, chunkName, sourceName) {
  const isBackground = String(chunkName || '').toLowerCase() === 'background1.data';
  if (!isBackground || !baseResponse || !baseResponse.ok || !baseResponse.body) {
    return withIsolationHeaders(baseResponse, {
      'X-Render360-Chunk-Source': sourceName
    });
  }

  const overlayUrl = new URL(BOOT_OVERLAY_PATH, self.location.href).href;
  const overlay = await cache.match(overlayUrl, { ignoreSearch: true });
  if (!overlay || !overlay.ok || !overlay.body) {
    return withIsolationHeaders(baseResponse, {
      'X-Render360-Chunk-Source': sourceName,
      'X-Render360-Boot-Overlay': 'missing'
    });
  }

  // The body length changes when overlay records are appended. Strip validators
  // that describe only the original response so Safari cannot cache/truncate it.
  const headers = isolationHeaders(baseResponse.headers, {
    'Content-Type': 'application/octet-stream',
    'Cache-Control': 'no-store, max-age=0',
    'X-Render360-Chunk-Source': sourceName + '+local-boot',
    'X-Render360-Boot-Overlay': 'appended'
  });
  headers.delete('Content-Length');
  headers.delete('ETag');
  headers.delete('Content-MD5');
  headers.delete('Content-Range');
  headers.delete('Accept-Ranges');

  return new Response(concatReadableResponses([baseResponse, overlay]), {
    status: baseResponse.status,
    statusText: baseResponse.statusText,
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
    return withBootOverlay(local, cache, name, 'local-vpk');
  }

  const upstreamUrl = UPSTREAM_CHUNK_BASE + encodeURIComponent(name);
  try {
    const upstream = await fetchUpstreamChunk(upstreamUrl);
    if (!upstream.ok) throw new Error(`HTTP ${upstream.status}`);
    return withBootOverlay(upstream, cache, name, 'upstream-yikes');
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

async function fetchRuntimeFresh(request, url) {
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
    if (request.method === 'GET' && /\/chunks\/[^/]+\.data$/i.test(url.pathname)) {
      return servePortalChunk(request, url);
    }
    if (request.method === 'GET' && MUTABLE_RUNTIME_RE.test(url.pathname)) {
      return fetchRuntimeFresh(request, url);
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
