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
