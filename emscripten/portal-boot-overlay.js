(() => {
  'use strict';

  // This overlay is intentionally separate from the map-chunk cache. It is
  // prepared from the tester's own Portal installation and loaded before the
  // Source material system starts, so engine bootstrap files that are not
  // referenced by a BSP are already present in MEMFS.
  //
  // v2 adds the retail Source .vcs shader cache. The previous 18-record overlay
  // fixed bootstrap textures but still let libstdshader_dx9 reach
  // vertexlit_and_unlit_generic_* before shaders/fxc/*.vcs existed in MEMFS.
  const CACHE_NAME = 'render360-portal-boot-overlay-v2';
  const OVERLAY_PATH = './render360-bootstrap-overlay.data';

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
    'materials/effects/flashlight001.vtf',
    'materials/effects/flashlight_border.vtf',
    'materials/console/background01.vmt',
    'materials/console/background01.vtf',
    'materials/console/background01_widescreen.vmt',
    'materials/console/background01_widescreen.vtf',
    'materials/console/loading.vtf',
    'materials/console/startup_loading.vtf'
  ];

  // Source's DX9-on-GL path loads precompiled Direct3D shader combo archives
  // from shaders/{fxc,vsh,psh}/*.vcs and TOGL translates those programs to GL.
  // They are runtime resources, not native executables, and a background BSP
  // dependency scan cannot discover them. Keep every retail .vcs file from the
  // selected Portal/HL2/platform search roots in this small independent overlay.
  const SHADER_RE = /(?:^|\/)shaders\/(?:fxc|vsh|psh)\/[^/]+\.vcs$/i;
  const MAX_SINGLE_SHADER_BYTES = 16 * 1024 * 1024;

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

  function fixedSuffixFor(path) {
    const clean = normalizePath(path);
    for (const suffix of BOOT_ASSET_SUFFIXES) {
      const wanted = normalizePath(suffix);
      if (clean === wanted || clean.endsWith('/' + wanted)) return wanted;
    }
    return null;
  }

  function isShaderPath(path, size) {
    const clean = normalizePath(path);
    return SHADER_RE.test(clean) && Number(size || 0) <= MAX_SINGLE_SHADER_BYTES;
  }

  function addDescriptor(found, descriptor) {
    const key = normalizePath(descriptor.path);
    if (!key || found.has(key)) return false;
    found.set(key, descriptor);
    return true;
  }

  async function indexTargets(files, log) {
    const allFiles = Array.from(files || []);
    const filesByRel = new Map();
    const found = new Map();
    const fixedFound = new Set();
    let looseShaders = 0;
    let vpkShaders = 0;
    let skippedHugeShaders = 0;

    for (const file of allFiles) {
      const rel = inferRelativePath(file);
      if (!rel) continue;
      filesByRel.set(rel, file);

      // Folder selection can expose some game resources as loose files rather
      // than VPK members. Index those too; older overlay revisions only scanned
      // *_dir.vpk and therefore missed loose platform shader caches.
      if (/^(?:portal|hl2|platform)\//.test(rel)) {
        const fixed = fixedSuffixFor(rel);
        if (fixed) {
          fixedFound.add(fixed);
          addDescriptor(found, {
            kind: 'loose',
            path: '/' + rel,
            file,
            size: file.size,
            category: 'boot'
          });
        }
        if (SHADER_RE.test(rel)) {
          if (file.size <= MAX_SINGLE_SHADER_BYTES) {
            if (addDescriptor(found, {
              kind: 'loose',
              path: '/' + rel,
              file,
              size: file.size,
              category: 'shader'
            })) looseShaders++;
          } else {
            skippedHugeShaders++;
            log(`Boot overlay skipped unusually large loose shader (${file.size} bytes): ${rel}`);
          }
        }
      }
    }

    const dirs = [...filesByRel.entries()].filter(([rel]) => /_dir\.vpk$/i.test(rel));
    if (!dirs.length) throw new Error('No *_dir.vpk files found for boot overlay.');

    for (const [rel, file] of dirs) {
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
            const fixed = fixedSuffixFor(internal);
            const totalSize = preload.length + entryLength;
            const shaderCandidate = SHADER_RE.test(internal);
            const shader = shaderCandidate && totalSize <= MAX_SINGLE_SHADER_BYTES;

            if (!fixed && !shader) {
              if (shaderCandidate && totalSize > MAX_SINGLE_SHADER_BYTES) {
                skippedHugeShaders++;
                log(`Boot overlay skipped unusually large VPK shader (${totalSize} bytes): ${parent}/${internal}`);
              }
              continue;
            }

            if (fixed) fixedFound.add(fixed);
            const descriptor = {
              kind: 'vpk',
              path: '/' + [parent, internal].filter(Boolean).join('/'),
              dirFile: file,
              dirRel: rel,
              archiveBase,
              archiveIndex,
              entryOffset,
              entryLength,
              preload,
              headerSize,
              treeSize,
              size: totalSize,
              category: shader ? 'shader' : 'boot'
            };
            if (addDescriptor(found, descriptor) && shader) vpkShaders++;
          }
        }
      }
    }

    log(`Boot overlay: found ${fixedFound.size}/${BOOT_ASSET_SUFFIXES.length} fixed Source assets.`);
    for (const suffix of BOOT_ASSET_SUFFIXES) {
      const normalized = normalizePath(suffix);
      if (!fixedFound.has(normalized)) log(`Boot overlay missing from selected install: ${normalized}`);
    }
    log(`Boot overlay shader cache: ${looseShaders + vpkShaders} .vcs files (${looseShaders} loose, ${vpkShaders} VPK).`);
    if (skippedHugeShaders) log(`Boot overlay skipped ${skippedHugeShaders} shader file(s) larger than ${MAX_SINGLE_SHADER_BYTES} bytes.`);

    return { found, filesByRel, fixedFound, shaderCount: looseShaders + vpkShaders, skippedHugeShaders };
  }

  async function readDescriptor(descriptor, filesByRel) {
    if (descriptor.kind === 'loose') return descriptor.file;

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
    const { found, filesByRel, fixedFound, shaderCount, skippedHugeShaders } = await indexTargets(files, log);
    if (!found.size) throw new Error('None of the shared Source boot assets were found in the selected Portal install.');
    if (!shaderCount) throw new Error('No Source .vcs shader cache was found in the selected Portal/HL2/platform files.');

    // Keep descriptors sorted so repeated builds produce deterministic overlay
    // record order and diagnostics. Blob/File slices are retained as parts; the
    // builder never concatenates all retail bytes into a giant ArrayBuffer.
    const descriptors = [...found.values()].sort((a, b) => a.path.localeCompare(b.path));
    const encoder = new TextEncoder();
    const parts = [];
    let bytes = 0;
    let records = 0;
    let shaderBytes = 0;
    let shaderRecords = 0;

    for (const descriptor of descriptors) {
      const blob = await readDescriptor(descriptor, filesByRel);
      const pathBytes = encoder.encode(descriptor.path);
      const header = new Uint8Array(8);
      const view = new DataView(header.buffer);
      view.setUint32(0, pathBytes.length, true);
      view.setUint32(4, blob.size, true);
      parts.push(header, pathBytes, blob);
      bytes += 8 + pathBytes.length + blob.size;
      records++;
      if (descriptor.category === 'shader') {
        shaderBytes += blob.size;
        shaderRecords++;
      }
    }

    const cache = await caches.open(CACHE_NAME);
    const url = new URL(OVERLAY_PATH, location.href).href;
    await cache.put(url, new Response(new Blob(parts, { type: 'application/octet-stream' }), {
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Render360-Chunk-Source': 'local-vpk-boot-overlay-v2',
        'X-Render360-Boot-Records': String(records),
        'X-Render360-Shader-Records': String(shaderRecords)
      }
    }));

    log(`Boot overlay ready: ${records} records, ${bytes} bytes; shaders=${shaderRecords} records/${shaderBytes} bytes.`);
    return {
      ok: true,
      records,
      bytes,
      shaderRecords,
      shaderBytes,
      fixedRecords: fixedFound.size,
      skippedHugeShaders,
      found: descriptors.map(x => x.path)
    };
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
    SHADER_RE,
    build,
    hasOverlay,
    clear
  };
})();