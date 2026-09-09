(() => {
  'use strict';

  // Keep the boot overlay in its own cache. The local VPK map builder clears
  // and rebuilds render360-portal-local-chunks-v2 before packing maps; when the
  // overlay shared that cache it was silently deleted immediately after a
  // successful Portal-folder verification. That produced the confusing state
  // "local fallback ready" + "choose folder to prepare boot textures" and could
  // make the launcher fall back to the network again.
  const CACHE_NAME = 'render360-portal-boot-overlay-v1';
  const OVERLAY_PATH = './render360-bootstrap-overlay.data';

  // Source asks for these before/while creating the first D3D9/WebGL materials.
  // They live in the shared HL2 texture VPKs shipped with Portal, but the old
  // packed web chunk can omit them because they are engine bootstrap assets and
  // are not necessarily referenced by the background BSP itself.
  const BOOT_ASSET_SUFFIXES = [
    'materials/debug/debugempty.vtf',
    'materials/debug/debugluxels.vtf',
    'materials/debug/debugluxelsnoalpha.vtf',
    'materials/dev/identitylightwarp.vtf',
    'materials/engine/defaultcubemap.vtf',
    'materials/engine/framesync1.vtf',
    'materials/engine/framesync2.vtf',
    'materials/engine/glinthighlight.vtf',
    'materials/engine/lightsprite.vtf',
    'materials/engine/noise-blur-256x256.vtf',
    'materials/engine/normalize.vtf',
    'materials/engine/normalizedrandomdirections2d.vtf',
    'materials/console/background01.vmt',
    'materials/console/background01.vtf',
    'materials/console/background01_widescreen.vmt',
    'materials/console/background01_widescreen.vtf',
    'materials/console/loading.vtf',
    'materials/console/startup_loading.vtf'
  ];

  function normalizePath(value) {
    return String(value || '')
      .replace(/\\/g, '/')
      .replace(/^\/+/, '')
      .replace(/\/+/g, '/')
      .toLowerCase();
  }

  function dirname(path) {
    const p = normalizePath(path);
    const at = p.lastIndexOf('/');
    return at === -1 ? '' : p.slice(0, at);
  }

  function inferRelativePath(file) {
    const raw = normalizePath(file.webkitRelativePath || file.name);
    if (!file.webkitRelativePath) return raw;
    const parts = raw.split('/');
    return parts.length > 1 ? parts.slice(1).join('/') : raw;
  }

  function readCString(bytes, state) {
    const start = state.offset;
    while (state.offset < bytes.length && bytes[state.offset] !== 0) state.offset++;
    if (state.offset >= bytes.length) throw new Error('unterminated VPK directory string');
    const value = new TextDecoder('utf-8').decode(bytes.subarray(start, state.offset));
    state.offset++;
    return value;
  }

  async function indexTargets(files, log) {
    const allFiles = Array.from(files || []);
    const filesByRel = new Map();
    for (const file of allFiles) {
      const rel = inferRelativePath(file);
      if (rel) filesByRel.set(rel, file);
    }

    const wanted = new Set(BOOT_ASSET_SUFFIXES.map(normalizePath));
    const found = new Map();
    const dirs = [...filesByRel.entries()].filter(([rel]) => /_dir\.vpk$/i.test(rel));
    if (!dirs.length) throw new Error('No *_dir.vpk files found for boot overlay.');

    for (const [rel, file] of dirs) {
      if (found.size === wanted.size) break;
      const headerBytes = new Uint8Array(await file.slice(0, 28).arrayBuffer());
      if (headerBytes.length < 12) continue;
      const headerView = new DataView(headerBytes.buffer, headerBytes.byteOffset, headerBytes.byteLength);
      if (headerView.getUint32(0, true) !== 0x55aa1234) continue;
      const version = headerView.getUint32(4, true);
      const treeSize = headerView.getUint32(8, true);
      const headerSize = version === 1 ? 12 : version === 2 ? 28 : 0;
      if (!headerSize || treeSize <= 0 || headerSize + treeSize > file.size) continue;

      const treeBytes = new Uint8Array(await file.slice(headerSize, headerSize + treeSize).arrayBuffer());
      const treeView = new DataView(treeBytes.buffer, treeBytes.byteOffset, treeBytes.byteLength);
      const state = { offset: 0 };
      const parent = dirname(rel);
      const archiveBase = rel.slice(0, -'_dir.vpk'.length);

      while (state.offset < treeBytes.length) {
        const extension = readCString(treeBytes, state);
        if (!extension) break;
        while (state.offset < treeBytes.length) {
          const directoryRaw = readCString(treeBytes, state);
          if (!directoryRaw) break;
          const directory = directoryRaw === ' ' ? '' : normalizePath(directoryRaw);
          while (state.offset < treeBytes.length) {
            const fileNameRaw = readCString(treeBytes, state);
            if (!fileNameRaw) break;
            if (state.offset + 18 > treeBytes.length) throw new Error(`truncated VPK metadata in ${rel}`);

            const fileName = normalizePath(fileNameRaw);
            state.offset += 4; // CRC
            const preloadBytes = treeView.getUint16(state.offset, true); state.offset += 2;
            const archiveIndex = treeView.getUint16(state.offset, true); state.offset += 2;
            const entryOffset = treeView.getUint32(state.offset, true); state.offset += 4;
            const entryLength = treeView.getUint32(state.offset, true); state.offset += 4;
            const terminator = treeView.getUint16(state.offset, true); state.offset += 2;
            if (terminator !== 0xffff) throw new Error(`bad VPK entry terminator in ${rel}`);
            if (state.offset + preloadBytes > treeBytes.length) throw new Error(`truncated VPK preload in ${rel}`);
            const preload = treeBytes.slice(state.offset, state.offset + preloadBytes);
            state.offset += preloadBytes;

            const ext = extension === ' ' ? '' : normalizePath(extension);
            const internal = [directory, fileName + (ext ? '.' + ext : '')].filter(Boolean).join('/');
            const suffix = normalizePath(internal);
            if (!wanted.has(suffix) || found.has(suffix)) continue;

            found.set(suffix, {
              path: '/' + [parent, internal].filter(Boolean).join('/'),
              dirFile: file,
              dirRel: rel,
              archiveBase,
              archiveIndex,
              entryOffset,
              entryLength,
              preload,
              headerSize,
              treeSize
            });
          }
        }
      }
    }

    log(`Boot overlay: found ${found.size}/${wanted.size} shared Source assets.`);
    for (const suffix of wanted) if (!found.has(suffix)) log(`Boot overlay missing from selected install: ${suffix}`);
    return { found, filesByRel };
  }

  async function readDescriptor(descriptor, filesByRel) {
    const pieces = [];
    if (descriptor.preload.length) pieces.push(descriptor.preload);
    if (descriptor.entryLength) {
      let archiveFile;
      let start;
      if (descriptor.archiveIndex === 0x7fff) {
        archiveFile = descriptor.dirFile;
        start = descriptor.headerSize + descriptor.treeSize + descriptor.entryOffset;
      } else {
        const rel = `${descriptor.archiveBase}_${String(descriptor.archiveIndex).padStart(3, '0')}.vpk`;
        archiveFile = filesByRel.get(rel);
        if (!archiveFile) throw new Error(`missing VPK segment ${rel} required by ${descriptor.path}`);
        start = descriptor.entryOffset;
      }
      const end = start + descriptor.entryLength;
      if (end > archiveFile.size) throw new Error(`VPK entry exceeds ${archiveFile.name}: ${descriptor.path}`);
      pieces.push(archiveFile.slice(start, end));
    }
    return new Blob(pieces, { type: 'application/octet-stream' });
  }

  async function build(files, options = {}) {
    if (!('caches' in globalThis)) throw new Error('Cache Storage is unavailable.');
    const log = typeof options.log === 'function' ? options.log : () => {};
    const { found, filesByRel } = await indexTargets(files, log);
    if (!found.size) throw new Error('None of the shared Source boot assets were found in the selected Portal install.');

    const encoder = new TextEncoder();
    const parts = [];
    let bytes = 0;
    let records = 0;
    for (const descriptor of found.values()) {
      const blob = await readDescriptor(descriptor, filesByRel);
      const pathBytes = encoder.encode(descriptor.path);
      const header = new Uint8Array(8);
      const view = new DataView(header.buffer);
      view.setUint32(0, pathBytes.length, true);
      view.setUint32(4, blob.size, true);
      parts.push(header, pathBytes, blob);
      bytes += 8 + pathBytes.length + blob.size;
      records++;
    }

    const cache = await caches.open(CACHE_NAME);
    const url = new URL(OVERLAY_PATH, location.href).href;
    await cache.put(url, new Response(new Blob(parts, { type: 'application/octet-stream' }), {
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Render360-Chunk-Source': 'local-vpk-boot-overlay',
        'X-Render360-Boot-Records': String(records)
      }
    }));
    log(`Boot overlay ready: ${records} records, ${bytes} bytes.`);
    return { ok: true, records, bytes, found: [...found.keys()] };
  }

  async function hasOverlay() {
    if (!('caches' in globalThis)) return false;
    const cache = await caches.open(CACHE_NAME);
    return !!(await cache.match(new URL(OVERLAY_PATH, location.href).href));
  }

  async function clear() {
    if (!('caches' in globalThis)) return;
    const cache = await caches.open(CACHE_NAME);
    await cache.delete(new URL(OVERLAY_PATH, location.href).href);
  }

  globalThis.Render360PortalBootOverlay = {
    CACHE_NAME,
    OVERLAY_PATH,
    BOOT_ASSET_SUFFIXES,
    build,
    hasOverlay,
    clear
  };
})();
