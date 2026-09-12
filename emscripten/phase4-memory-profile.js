// Render360 Phase 4 — runtime telemetry for the growable/resizable Wasm-memory
// experiment. This does not force support: -sGROWABLE_ARRAYBUFFERS=1 lets
// Emscripten auto-detect the platform API and use the normal fallback otherwise.
;(() => {
  'use strict'

  const memoryProto = typeof WebAssembly !== 'undefined' && WebAssembly.Memory
    ? WebAssembly.Memory.prototype
    : null
  const sharedProto = typeof SharedArrayBuffer !== 'undefined'
    ? SharedArrayBuffer.prototype
    : null

  const profile = {
    name: 'phase4-growable-arraybuffers',
    emscripten: '6.0.6',
    initialMemoryMiB: 320,
    maximumMemoryMiB: 1024,
    linearGrowthMiB: 32,
    growableArrayBuffers: 1,
    wasmResizableBufferAPI: !!(memoryProto && typeof memoryProto.toResizableBuffer === 'function'),
    wasmFixedLengthBufferAPI: !!(memoryProto && typeof memoryProto.toFixedLengthBuffer === 'function'),
    growableSharedArrayBufferAPI: !!(sharedProto && typeof sharedProto.grow === 'function'),
    crossOriginIsolated: typeof crossOriginIsolated !== 'undefined' ? !!crossOriginIsolated : null,
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined'
  }

  Module.render360Phase4MemoryProfile = profile
  globalThis.render360Phase4MemoryProfile = profile

  function report() {
    try {
      Module.print?.(`[Render360 Phase 4] memory profile=${JSON.stringify(profile)}`)
      if(!profile.wasmResizableBufferAPI) {
        Module.print?.('[Render360 Phase 4] WebAssembly.Memory.toResizableBuffer is unavailable; GROWABLE_ARRAYBUFFERS=1 will use Emscripten fallback behavior.')
      }
    } catch(_) {}
  }

  Module.preRun = Module.preRun || []
  Module.preRun.push(report)
})()
