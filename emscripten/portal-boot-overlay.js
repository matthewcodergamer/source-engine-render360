(() => {
  'use strict';

  // This overlay is intentionally separate from the map-chunk cache. It is
  // prepared from the tester's own Portal installation and loaded before the
  // Source material system starts, so engine bootstrap files that are not
  // referenced by a BSP are already present in MEMFS.
  //
  // Phase 2: do NOT stage every retail .vcs file. The previous overlay solved
  // missing libstdshader_dx9 resources by copying the complete shader cache,
  // but that pushed the bootstrap to roughly 51 MiB on the test install. Keep
  // only deterministic shader families needed by the menu/background startup.
  // Any family discovered later can be added explicitly to this manifest.
  const CACHE_NAME = 'render360-portal-boot-overlay-v2';
  const OVERLAY_PATH = './render360-bootstrap-overlay.data';
  const MANIFEST_VERSION = 'portal-first-frame-v1';
  const BOOTSTRAP_SHADER_BUDGET_BYTES = 20 * 1024 * 1024;

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

  // Ordered first-frame manifest. "required" families are always retained if
  // they exist in the selected retail install. Optional families are admitted
  // only while the 20 MiB bootstrap budget still has room. This makes additions
  // reviewable instead of silently regressing to "copy every .vcs file".
  //
  // Prefixes refer to the basename before .vcs. Source retail packages contain
  // stage/combo suffixes such as _vs20, _ps20b, _vs30 and _ps30; matching a
  // family includes all of those compiled variants but nothing from unrelated
  // shader families.
  const FIRST_FRAME_SHADER_MANIFEST = [
    { family: 'vertexlit_and_unlit_generic', prefixes: ['vertexlit_and_unlit_generic'], required: true },
    { family: 'lightmappedgeneric', prefixes: ['lightmappedgeneric'], required: true },
    { family: 'unlitgeneric', prefixes: ['unlitgeneric'], required: true },
    { family: 'screenspace_general', prefixes: ['screenspace_general'], required: true },
    { family: 'sky', prefixes: ['sky'], required: false },
    { family: 'sprite', prefixes: ['sprite', 'spritecard'], required: false },
    { family: 'worldvertextransition', prefixes: ['worldvertextransition'], required: false },
    { family: 'worldtwotextureblend', prefixes: ['worldtwotextureblend'], required: false },
    { family: 'depthwrite', prefixes: ['depthwrite'], required: false },
    { family: 'shadow', prefixes: ['shadow', 'shadowmodel'], required: false },
    { family: 'decalmodulate', prefixes: ['decalmodulate'], required: false }
  ];

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

  function basename(path) {
    const p = normalizePath(path);
    const at = p.lastIndexOf('/');
    return at === -1 ? p : p.slice(at + 1);
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

  function shaderManifestEntry(path) {
    const clean = normalizePath(path);
    if (!SHADER_RE.test(clean)) return null;
    const stem = basename(clean).replace(/\.vcs$/i, '');
    for (const entry of FIRST_FRAME_SHADER_MANIFEST) {
      for (const prefix of entry.prefixes) {
        if (stem === prefix || stem.startsWith(prefix + '_')) return entry;
      }
    }
    return null;
  }

  function addDescriptor(found, descriptor) {
    const key = normalizePath(descriptor.path);
    if (!key || found.has(key)) return false;
    found.set(key, descriptor);
    return true;
  }

  function descriptorCost(descriptor) {
    // Include a conservative path/header allowance so the hard budget applies
    // to the packed overlay, not just retail payload bytes.
    return Number(descriptor.size || 0) + 8 + String(descriptor.path || '').length * 2;
  }

  function selectWithinBudget(found, log) {
    const boot = [];
    const byFamily = new Map(FIRST_FRAME_SHADER_MANIFEST.map(x => [x.family, []]));
    for (const descriptor of found.values()) {
      if (descriptor.category !== 'shader') {
        boot.push(descriptor);
        continue;
      }
      if (!byFamily.has(descriptor.family)) byFamily.set(descriptor.family, []);
      byFamily.get(descriptor.family).push(descriptor);
    }

    let bytes = boot.reduce((sum, descriptor) => sum + descriptorCost(descriptor), 0);
    const selected = [...boot];
    const includedFamilies = [];
    const omittedFamilies = [];

    const includeFamily = entry => {
      const files = byFamily.get(entry.family) || [];
      if (!files.length) {
        log(`Boot shader manifest: family not present in selected install: ${entry.family}`);
        return;
      }
      const familyBytes = files.reduce((sum, descriptor) => sum + descriptorCost(descriptor), 0);
      if (!entry.required && bytes + familyBytes > BOOTSTRAP_SHADER_BUDGET_BYTES) {
        omittedFamilies.push({ family: entry.family, files: files.length, bytes: familyBytes, reason: 'budget' });
        log(`Boot shader manifest: deferred optional ${entry.family} (${files.length} files/${familyBytes} bytes) to stay under 20 MiB.`);
        return;
      }
      selected.push(...files);
      bytes += familyBytes;
      includedFamilies.push({ family: entry.family, files: files.length, bytes: familyBytes, required: entry.required });
    };

    for (const entry of FIRST_FRAME_SHADER_MANIFEST.filter(x => x.required)) includeFamily(entry);
    if (bytes > BOOTSTRAP_SHADER_BUDGET_BYTES) {
      const required = includedFamilies.map(x => `${x.family}=${x.bytes}`).join(', ');
      throw new Error(`Required first-frame shader manifest exceeds 20 MiB bootstrap budget (${bytes} bytes). Families: ${required}`);
    }
    for (const entry of FIRST_FRAME_SHADER_MANIFEST.filter(x => !x.required)) includeFamily(entry);

    return { selected, estimatedBytes: bytes, includedFamilies, omittedFamilies };
  }

  async function indexTargets(files, log) {
    const allFiles = Array.from(files || []);
    const filesByRel = new Map();
    const found = new Map();
    const fixedFound = new Set();
    let discoveredShaderFiles = 0;
    let selectedShaderFiles = 0;
    let omittedShaderFiles = 0;
    let looseShaders = 0;
    let vpkShaders = 0;
    let skippedHugeShaders = 0;

    for (const file of allFiles) {
      const rel = inferRelativePath(file);
      if (!rel) continue;
      filesByRel.set(rel, file);

      if (/^(?:portal|hl2|platform)\//.test(rel)) {
        const fixed = fixedSuffixFor(rel);
        if (fixed) {
          fixedFound.add(fixed);
          addDescriptor(found, {
            kind: 'loose', path: '/' + rel, file, size: file.size, category: 'boot'
          });
        }

        if (SHADER_RE.test(rel)) {
          discoveredShaderFiles++;
          const manifest = shaderManifestEntry(rel);
          if (!manifest) {
            omittedShaderFiles++;
          } else if (file.size <= MAX_SINGLE_SHADER_BYTES) {
            if (addDescriptor(found, {
              kind: 'loose', path: '/' + rel, file, size: file.size,
              category: 'shader', family: manifest.family
            })) {
              looseShaders++;
              selectedShaderFiles++;
            }
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
            state.offset += 4;
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
            const manifest = shaderCandidate ? shaderManifestEntry(internal) : null;

            if (shaderCandidate) discoveredShaderFiles++;
            if (shaderCandidate && !manifest) omittedShaderFiles++;
            const shader = !!manifest && totalSize <= MAX_SINGLE_SHADER_BYTES;

            if (!fixed && !shader) {
              if (manifest && totalSize > MAX_SINGLE_SHADER_BYTES) {
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
              category: shader ? 'shader' : 'boot',
              family: shader ? manifest.family : null
            };
            if (addDescriptor(found, descriptor) && shader) {
              vpkShaders++;
              selectedShaderFiles++;
            }
          }
        }
      }
    }

    log(`Boot overlay: found ${fixedFound.size}/${BOOT_ASSET_SUFFIXES.length} fixed Source assets.`);
    for (const suffix of BOOT_ASSET_SUFFIXES) {
      const normalized = normalizePath(suffix);
      if (!fixedFound.has(normalized)) log(`Boot overlay missing from selected install: ${normalized}`);
    }
    log(`Boot shader manifest ${MANIFEST_VERSION}: selected ${selectedShaderFiles}/${discoveredShaderFiles} retail .vcs files; deferred ${omittedShaderFiles} unrelated shader files.`);
    log(`Boot shader sources: ${looseShaders} loose, ${vpkShaders} VPK.`);
    if (skippedHugeShaders) log(`Boot overlay skipped ${skippedHugeShaders} shader file(s) larger than ${MAX_SINGLE_SHADER_BYTES} bytes.`);

    return {
      found, filesByRel, fixedFound, discoveredShaderFiles, selectedShaderFiles,
      omittedShaderFiles, skippedHugeShaders
    };
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
    const indexed = await indexTargets(files, log);
    const { found, filesByRel, fixedFound } = indexed;
    if (!found.size) throw new Error('None of the shared Source boot assets were found in the selected Portal install.');
    if (!indexed.selectedShaderFiles) throw new Error('No first-frame Source .vcs shader families were found in the selected Portal/HL2/platform files.');

    const selection = selectWithinBudget(found, log);
    const descriptors = selection.selected.sort((a, b) => a.path.localeCompare(b.path));
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

    if (bytes > BOOTSTRAP_SHADER_BUDGET_BYTES) {
      throw new Error(`Packed first-frame bootstrap is ${bytes} bytes, above the ${BOOTSTRAP_SHADER_BUDGET_BYTES}-byte Phase 2 budget.`);
    }

    const cache = await caches.open(CACHE_NAME);
    const url = new URL(OVERLAY_PATH, location.href).href;
    await cache.put(url, new Response(new Blob(parts, { type: 'application/octet-stream' }), {
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Render360-Chunk-Source': 'local-vpk-boot-overlay-manifest',
        'X-Render360-Boot-Manifest': MANIFEST_VERSION,
        'X-Render360-Boot-Bytes': String(bytes),
        'X-Render360-Boot-Records': String(records),
        'X-Render360-Shader-Records': String(shaderRecords)
      }
    }));

    log(`Boot overlay ready: ${records} records, ${(bytes / 1048576).toFixed(2)} MiB; shaders=${shaderRecords} records/${(shaderBytes / 1048576).toFixed(2)} MiB.`);
    log(`Boot shader families: ${selection.includedFamilies.map(x => x.family).join(', ') || 'none'}.`);
    if (selection.omittedFamilies.length) log(`Deferred shader families: ${selection.omittedFamilies.map(x => x.family).join(', ')}.`);

    return {
      ok: true,
      manifestVersion: MANIFEST_VERSION,
      records,
      bytes,
      shaderRecords,
      shaderBytes,
      fixedRecords: fixedFound.size,
      discoveredShaderFiles: indexed.discoveredShaderFiles,
      selectedShaderFiles: indexed.selectedShaderFiles,
      deferredShaderFiles: indexed.omittedShaderFiles,
      includedFamilies: selection.includedFamilies,
      omittedFamilies: selection.omittedFamilies,
      skippedHugeShaders: indexed.skippedHugeShaders,
      found: descriptors.map(x => x.path)
    };
  }

  async function hasOverlay() {
    if (!('caches' in globalThis)) return false;
    const cache = await caches.open(CACHE_NAME);
    const response = await cache.match(new URL(OVERLAY_PATH, location.href).href);
    if (!response || !response.ok) return false;
    const version = response.headers.get('X-Render360-Boot-Manifest');
    const bytes = Number(response.headers.get('X-Render360-Boot-Bytes') || 0);
    return version === MANIFEST_VERSION && bytes > 0 && bytes <= BOOTSTRAP_SHADER_BUDGET_BYTES;
  }

  async function clear() {
    if (!('caches' in globalThis)) return;
    const cache = await caches.open(CACHE_NAME);
    await cache.delete(new URL(OVERLAY_PATH, location.href).href);
  }

  globalThis.Render360PortalBootOverlay = {
    CACHE_NAME,
    OVERLAY_PATH,
    MANIFEST_VERSION,
    BOOTSTRAP_SHADER_BUDGET_BYTES,
    BOOT_ASSET_SUFFIXES,
    FIRST_FRAME_SHADER_MANIFEST,
    SHADER_RE,
    shaderManifestEntry,
    build,
    hasOverlay,
    clear
  };
})();