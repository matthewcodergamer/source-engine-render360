// Render360 Phase 3/4 mobile runtime hardening.
;(() => {
  'use strict'

  Module['arguments'] = Module['arguments'] || []

  function ensureArg(name, value) {
    const args = Module['arguments']
    if(args.includes(name)) return
    args.push(name)
    if(value !== undefined && value !== null) args.push(String(value))
  }

  // Source's POSIX launcher cannot discover a native executable directory in
  // WebAssembly. The retail tree is rooted at /portal, /hl2 and /platform.
  ensureArg('-basedir', '/')

  const isWindow = typeof window !== 'undefined' && typeof document !== 'undefined'
  if(!isWindow) return

  // Source validates portal/gameinfo.txt during PREINITIALIZATION, before VPK
  // search paths are ready. Keep VPK/map payloads zero-copy and browser-backed,
  // but stage the tiny loose bootstrap metadata into primary MEMFS so this early
  // libc/FS check sees the same paths a native install would expose.
  const DIRECT_REQUEST_TYPE = 'render360-retail-request'
  const DIRECT_FILES_TYPE = 'render360-retail-files'
  const BOOTSTRAP_DEPENDENCY = 'render360-phase3-bootstrap-metadata'
  const BOOTSTRAP_MAX_FILE_BYTES = 1024 * 1024
  const BOOTSTRAP_MAX_TOTAL_BYTES = 2 * 1024 * 1024
  const BOOTSTRAP_TIMEOUT_MS = 20000
  const embeddedPhase3 = !!(
    window.parent &&
    window.parent !== window &&
    new URLSearchParams(location.search).has('render360Phase3')
  )

  function normalizeRetailPath(value) {
    return String(value || '')
      .replace(/\\/g, '/')
      .replace(/^\/+/, '')
      .replace(/\/+/g, '/')
      .toLowerCase()
  }

  function bootstrapMetadataPath(path) {
    const clean = normalizeRetailPath(path)
    if(!/^(portal|hl2|platform)\//.test(clean)) return false
    return /\/(?:gameinfo\.txt|steam\.inf|game\.inf)$/.test(clean)
  }

  function dirname(path) {
    const at = String(path || '').lastIndexOf('/')
    return at <= 0 ? '/' : path.slice(0, at)
  }

  if(embeddedPhase3) {
    const token = `bootstrap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
    let dependencyHeld = false
    let settled = false
    let timeout = 0

    function finishBootstrap() {
      if(settled) return
      settled = true
      if(timeout) clearTimeout(timeout)
      try { globalThis.render360SetPhase?.('phase3-bootstrap-ready') } catch(_) {}
      if(dependencyHeld) {
        dependencyHeld = false
        removeRunDependency(BOOTSTRAP_DEPENDENCY)
      }
    }

    function failBootstrap(message) {
      if(settled) return
      settled = true
      if(timeout) clearTimeout(timeout)
      const text = `[Render360 Phase 3] bootstrap metadata failed: ${message}`
      try { globalThis.render360SetPhase?.(`phase3-bootstrap-failed:${String(message).slice(0, 120)}`) } catch(_) {}
      try { Module.printErr?.(text) } catch(_) { try { console.error(text) } catch(__) {} }
      if(typeof abort === 'function') abort(text)
      else throw new Error(text)
    }

    async function stageBootstrapMetadata(descriptors) {
      const selected = []
      let declaredBytes = 0
      for(const descriptor of descriptors || []) {
        const path = normalizeRetailPath(descriptor?.path)
        const file = descriptor?.file
        if(!bootstrapMetadataPath(path) || !(file instanceof Blob)) continue
        const size = Number(file.size || 0)
        if(size <= 0 || size > BOOTSTRAP_MAX_FILE_BYTES) {
          throw new Error(`${path} has invalid bootstrap size ${size}`)
        }
        declaredBytes += size
        if(declaredBytes > BOOTSTRAP_MAX_TOTAL_BYTES) {
          throw new Error(`bootstrap metadata exceeds ${BOOTSTRAP_MAX_TOTAL_BYTES} bytes`)
        }
        selected.push({ path, file, size })
      }

      if(!selected.some(item => item.path === 'portal/gameinfo.txt')) {
        throw new Error('portal/gameinfo.txt was not supplied by the verified Portal folder')
      }

      let writtenBytes = 0
      for(const item of selected) {
        const buffer = await item.file.arrayBuffer()
        if(buffer.byteLength !== item.size || buffer.byteLength > BOOTSTRAP_MAX_FILE_BYTES) {
          throw new Error(`${item.path} changed size while staging`)
        }
        const livePath = '/' + item.path
        FS.mkdirTree(dirname(livePath))
        try { FS.unlink(livePath) } catch(_) {}
        FS.writeFile(livePath, new Uint8Array(buffer))
        writtenBytes += buffer.byteLength
      }

      let gameinfoStat = null
      try { gameinfoStat = FS.stat('/portal/gameinfo.txt') } catch(_) {}
      if(!gameinfoStat || Number(gameinfoStat.size || 0) <= 0) {
        throw new Error('/portal/gameinfo.txt was not visible after MEMFS bootstrap staging')
      }

      Module.render360BootstrapMetadata = {
        files: selected.length,
        bytes: writtenBytes,
        gameinfoBytes: Number(gameinfoStat.size || 0)
      }
      try {
        Module.print?.(`[Render360 Phase 3] bootstrap metadata ready: ${selected.length} files, ${writtenBytes} bytes; /portal/gameinfo.txt is visible before Source PREINITIALIZATION.`)
      } catch(_) {}
    }

    window.addEventListener('message', event => {
      if(event.origin !== location.origin || event.source !== window.parent) return
      const data = event?.data
      if(!data || data.type !== DIRECT_FILES_TYPE || data.token !== token || settled) return
      if(!Array.isArray(data.files) || !data.files.length) {
        failBootstrap('staging page did not provide retail File handles')
        return
      }
      stageBootstrapMetadata(data.files).then(finishBootstrap).catch(error => {
        failBootstrap(String(error?.stack || error?.message || error))
      })
    })

    Module.preRun = Module.preRun || []
    Module.preRun.push(() => {
      if(dependencyHeld || settled) return
      addRunDependency(BOOTSTRAP_DEPENDENCY)
      dependencyHeld = true
      timeout = setTimeout(() => {
        failBootstrap('timed out waiting for Portal bootstrap metadata')
      }, BOOTSTRAP_TIMEOUT_MS)
      try { globalThis.render360SetPhase?.('phase3-bootstrap-await-files') } catch(_) {}
      window.parent.postMessage({ type: DIRECT_REQUEST_TYPE, token }, location.origin)
    })
  }

  const STARTUP_KEY = 'render360-startup-checkpoint-v1'
  let lastStartupCheckpoint = ''
  let viewportFullscreen = false

  function rememberStartup(text) {
    const line = String(text || '').trim()
    if(!line) return
    const meaningful =
      line.includes('[Render360 startup]') ||
      /(?:filesystem|gameinfo\.txt|engine error|unable to|failed to mount|startup failed)/i.test(line)
    if(!meaningful) return
    lastStartupCheckpoint = line.slice(-2048)
    try {
      localStorage.setItem(STARTUP_KEY, JSON.stringify({ at: Date.now(), line: lastStartupCheckpoint }))
    } catch(_) {}
    const match = line.match(/\[Render360 startup\]\s*(.+)$/i)
    if(match) {
      try { globalThis.render360SetPhase?.(`startup:${match[1].slice(0, 160)}`) } catch(_) {}
    }
  }

  const oldPrint = typeof Module.print === 'function' ? Module.print.bind(Module) : console.log.bind(console)
  const oldPrintErr = typeof Module.printErr === 'function' ? Module.printErr.bind(Module) : console.error.bind(console)
  Module.print = (...args) => {
    rememberStartup(args.join(' '))
    oldPrint(...args)
  }
  Module.printErr = (...args) => {
    rememberStartup(args.join(' '))
    oldPrintErr(...args)
  }

  const oldDiagnosticText = globalThis.render360DiagnosticText
  if(typeof oldDiagnosticText === 'function') {
    globalThis.render360DiagnosticText = () => {
      let checkpoint = lastStartupCheckpoint
      if(!checkpoint) {
        try { checkpoint = JSON.parse(localStorage.getItem(STARTUP_KEY) || 'null')?.line || '' } catch(_) {}
      }
      const base = oldDiagnosticText()
      return checkpoint ? `${base}\nlastStartupCheckpoint=${checkpoint}` : base
    }
  }

  function fullscreenButton() {
    try {
      const buttons = document.querySelectorAll('input[type="button"]')
      for(const button of buttons) if(/fullscreen/i.test(button.value || '')) return button
    } catch(_) {}
    return null
  }

  function setButtonLabel() {
    const button = fullscreenButton()
    if(!button) return
    const nativeActive = !!(document.fullscreenElement || document.webkitFullscreenElement)
    button.value = (nativeActive || viewportFullscreen) ? 'Exit fullscreen' : 'Fullscreen'
  }

  function setViewportFullscreen(active) {
    viewportFullscreen = !!active
    let frame = null
    try { frame = window.frameElement } catch(_) {}
    if(!frame || !frame.ownerDocument) {
      setButtonLabel()
      return false
    }
    const parentDoc = frame.ownerDocument
    const overlay = frame.parentElement
    const bar = overlay?.firstElementChild
    if(active) {
      if(overlay) {
        overlay.dataset.render360ViewportFullscreen = '1'
        overlay.style.paddingTop = '0'
        overlay.style.zIndex = '2147483647'
      }
      if(bar) {
        bar.dataset.render360OldDisplay = bar.style.display || ''
        bar.style.display = 'none'
      }
      frame.style.position = 'fixed'
      frame.style.inset = '0'
      frame.style.width = '100vw'
      frame.style.height = '100dvh'
      frame.style.minHeight = '100vh'
      frame.style.zIndex = '2147483647'
      frame.style.background = '#000'
      parentDoc.documentElement.style.overflow = 'hidden'
      parentDoc.body.style.overflow = 'hidden'
    } else {
      if(overlay) {
        delete overlay.dataset.render360ViewportFullscreen
        overlay.style.paddingTop = 'env(safe-area-inset-top)'
        overlay.style.zIndex = '2147483000'
      }
      if(bar) {
        bar.style.display = bar.dataset.render360OldDisplay || ''
        delete bar.dataset.render360OldDisplay
      }
      frame.style.position = ''
      frame.style.inset = ''
      frame.style.width = '100%'
      frame.style.height = ''
      frame.style.minHeight = '0'
      frame.style.zIndex = ''
      parentDoc.documentElement.style.overflow = 'hidden'
      parentDoc.body.style.overflow = 'hidden'
    }
    setButtonLabel()
    return true
  }

  async function requestNativeFullscreen(target) {
    if(!target) return false
    const request = target.requestFullscreen || target.webkitRequestFullscreen
    if(typeof request !== 'function') return false
    try {
      const result = request.call(target)
      if(result && typeof result.then === 'function') await result
      return true
    } catch(_) { return false }
  }

  async function exitNativeFullscreen() {
    const exit = document.exitFullscreen || document.webkitExitFullscreen
    if(typeof exit !== 'function') return false
    try {
      const result = exit.call(document)
      if(result && typeof result.then === 'function') await result
      return true
    } catch(_) { return false }
  }

  globalThis.render360RequestFullscreen = async () => {
    if(document.fullscreenElement || document.webkitFullscreenElement) {
      await exitNativeFullscreen()
      setButtonLabel()
      return true
    }
    if(viewportFullscreen) {
      setViewportFullscreen(false)
      return true
    }
    const canvas = Module.canvas || document.getElementById('canvas')
    if(await requestNativeFullscreen(canvas)) {
      setButtonLabel()
      return true
    }
    let frame = null
    try { frame = window.frameElement } catch(_) {}
    if(await requestNativeFullscreen(frame)) {
      setButtonLabel()
      return true
    }
    setViewportFullscreen(true)
    try { render360AppendOutput?.('[Render360 fullscreen] Native element fullscreen unavailable; using full-viewport iPhone mode.') } catch(_) {}
    return true
  }

  document.addEventListener('fullscreenchange', setButtonLabel)
  document.addEventListener('webkitfullscreenchange', setButtonLabel)
  window.addEventListener('pagehide', () => {
    if(viewportFullscreen) setViewportFullscreen(false)
  }, { once: true })
  setButtonLabel()
})()
