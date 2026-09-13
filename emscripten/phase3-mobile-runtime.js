// Render360 Phase 3 mobile runtime hardening.
//
// Keep this file small: it is embedded into hl2_launcher.js and imported by
// pthread workers. The window-only section improves diagnostics/fullscreen;
// the argument fix is shared so Source receives a deterministic browser root.
;(() => {
  'use strict'

  Module['arguments'] = Module['arguments'] || []

  function ensureArg(name, value) {
    const args = Module['arguments']
    if(args.includes(name)) return
    args.push(name)
    if(value !== undefined && value !== null) args.push(String(value))
  }

  // launcher/launcher.cpp cannot derive its base directory from GetModuleFileName
  // on POSIX/WebAssembly. Without an explicit -basedir, Source can reach the
  // shader API and then leave startup with an empty base path. The Phase 3
  // retail tree is rooted at /portal, /hl2 and /platform, so / is the correct
  // deterministic browser base directory.
  ensureArg('-basedir', '/')

  const isWindow = typeof window !== 'undefined' && typeof document !== 'undefined'
  if(!isWindow) return

  const STARTUP_KEY = 'render360-startup-checkpoint-v2'
  const STARTUP_DEBUG_KEY = 'render360-startup-debug-v1'
  const STARTUP_TRACE_LIMIT = 24
  const APP_SYSTEM_STAGE_NAMES = [
    'CREATION',
    'CONNECTION',
    'PREINITIALIZATION',
    'INITIALIZATION',
    'SHUTDOWN',
    'POSTSHUTDOWN',
    'DISCONNECTION',
    'DESTRUCTION',
    'NONE'
  ]

  let lastStartupCheckpoint = ''
  let viewportFullscreen = false

  function navigationType() {
    try {
      return performance.getEntriesByType?.('navigation')?.[0]?.type || ''
    } catch(_) {
      return ''
    }
  }

  function newStartupDebugState() {
    return {
      version: 1,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      navigationType: navigationType(),
      latest: '',
      deepestFailure: null,
      failureHint: null,
      stages: {
        steam: null,
        source: null,
        mod: null
      },
      trace: []
    }
  }

  let startupDebug = newStartupDebugState()
  if(startupDebug.navigationType === 'reload') {
    try {
      const previous = JSON.parse(localStorage.getItem(STARTUP_DEBUG_KEY) || 'null')
      if(previous && Array.isArray(previous.trace)) {
        startupDebug = {
          ...newStartupDebugState(),
          ...previous,
          navigationType: 'reload',
          updatedAt: Date.now(),
          trace: previous.trace.slice(-STARTUP_TRACE_LIMIT)
        }
        lastStartupCheckpoint = String(previous.latest || '')
      }
    } catch(_) {}
  } else {
    try {
      localStorage.removeItem(STARTUP_KEY)
      localStorage.removeItem(STARTUP_DEBUG_KEY)
    } catch(_) {}
  }

  function appSystemStageName(value) {
    const stage = Number(value)
    return Number.isInteger(stage) && stage >= 0 && stage < APP_SYSTEM_STAGE_NAMES.length
      ? APP_SYSTEM_STAGE_NAMES[stage]
      : `UNKNOWN_${String(value)}`
  }

  function failurePriority(group) {
    if(group === 'mod') return 3
    if(group === 'source') return 2
    if(group === 'steam') return 1
    return 0
  }

  function persistStartupDebug() {
    startupDebug.updatedAt = Date.now()
    try {
      localStorage.setItem(STARTUP_KEY, JSON.stringify({
        at: startupDebug.updatedAt,
        line: lastStartupCheckpoint
      }))
      localStorage.setItem(STARTUP_DEBUG_KEY, JSON.stringify(startupDebug))
    } catch(_) {}
  }

  function recordStage(checkpoint, group, value) {
    const stage = Number(value)
    if(!Number.isInteger(stage)) return

    startupDebug.stages[group] = {
      value: stage,
      name: appSystemStageName(stage),
      at: Date.now()
    }

    // NONE (8) explicitly means this wrapper did not fail startup. Never allow
    // an outer NONE to overwrite a real failure from a deeper app-system group.
    if(stage === 8) return

    const returnMatch = checkpoint.match(new RegExp(`(?:${group}|engine)-return:(-?\\d+)`, 'i'))
    const candidate = {
      group,
      stage,
      stageName: appSystemStageName(stage),
      returnCode: returnMatch ? Number(returnMatch[1]) : null,
      checkpoint: checkpoint.slice(0, 512),
      at: Date.now()
    }
    const current = startupDebug.deepestFailure
    if(!current || failurePriority(group) >= failurePriority(current.group)) {
      startupDebug.deepestFailure = candidate
    }
  }

  function recordStartupCheckpoint(checkpoint, fullLine) {
    const clean = String(checkpoint || '').trim().slice(0, 512)
    if(!clean) return

    const now = Date.now()
    startupDebug.latest = String(fullLine || clean).slice(-512)
    lastStartupCheckpoint = startupDebug.latest

    const lastTrace = startupDebug.trace[startupDebug.trace.length - 1]
    if(lastTrace && lastTrace.checkpoint === clean) {
      lastTrace.at = now
      lastTrace.line = startupDebug.latest
    } else {
      startupDebug.trace.push({ at: now, checkpoint: clean, line: startupDebug.latest })
      if(startupDebug.trace.length > STARTUP_TRACE_LIMIT) {
        startupDebug.trace.splice(0, startupDebug.trace.length - STARTUP_TRACE_LIMIT)
      }
    }

    for(const match of clean.matchAll(/\b(steam|source|mod)-stage:(-?\d+)/gi)) {
      recordStage(clean, match[1].toLowerCase(), match[2])
    }

    if(/(?:^|[-:])fail(?:ure)?[:=-]/i.test(clean) || /(?:ClientDLL_Load|ServerDLL_Load).*fail/i.test(clean)) {
      startupDebug.failureHint = {
        checkpoint: clean,
        at: now
      }
    }

    persistStartupDebug()

    try {
      const deepest = startupDebug.deepestFailure
      if(deepest) {
        globalThis.render360SetPhase?.(
          `startup-failure:${deepest.group}:${deepest.stageName}:${deepest.checkpoint.slice(0, 96)}`
        )
      } else {
        globalThis.render360SetPhase?.(`startup:${clean.slice(0, 160)}`)
      }
    } catch(_) {}
  }

  function rememberStartup(text) {
    const line = String(text || '').trim()
    if(!line) return
    const meaningful =
      line.includes('[Render360 startup]') ||
      /(?:filesystem|gameinfo\.txt|engine error|unable to|failed to mount|startup failed)/i.test(line)
    if(!meaningful) return

    const match = line.match(/\[Render360 startup\]\s*(.+)$/i)
    recordStartupCheckpoint(match ? match[1] : line, line)
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

  // Copy diagnostics keeps the latest general runtime event, but now also adds a
  // bounded startup trace and the deepest non-NONE app-system failure. This is
  // deliberately small enough for iPhone Safari/localStorage while preserving
  // the evidence needed after an outer wrapper returns -1.
  const oldDiagnosticText = globalThis.render360DiagnosticText
  if(typeof oldDiagnosticText === 'function') {
    globalThis.render360DiagnosticText = () => {
      let checkpoint = lastStartupCheckpoint
      let debug = startupDebug
      if(!checkpoint || !debug?.trace?.length) {
        try {
          checkpoint = checkpoint || JSON.parse(localStorage.getItem(STARTUP_KEY) || 'null')?.line || ''
          debug = JSON.parse(localStorage.getItem(STARTUP_DEBUG_KEY) || 'null') || debug
        } catch(_) {}
      }
      const base = oldDiagnosticText()
      const additions = []
      if(checkpoint) additions.push(`lastStartupCheckpoint=${checkpoint}`)
      if(debug) additions.push(`startupDebug=${JSON.stringify(debug)}`)
      return additions.length ? `${base}\n${additions.join('\n')}` : base
    }
  }

  try {
    if(typeof diagnosticStatusElement !== 'undefined' && diagnosticStatusElement) {
      diagnosticStatusElement.textContent = 'Latest runtime event + bounded startup trace'
    }
  } catch(_) {}

  function fullscreenButton() {
    try {
      const buttons = document.querySelectorAll('input[type="button"]')
      for(const button of buttons) {
        if(/fullscreen/i.test(button.value || '')) return button
      }
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
    } catch(_) {
      return false
    }
  }

  async function exitNativeFullscreen() {
    const exit = document.exitFullscreen || document.webkitExitFullscreen
    if(typeof exit !== 'function') return false
    try {
      const result = exit.call(document)
      if(result && typeof result.then === 'function') await result
      return true
    } catch(_) {
      return false
    }
  }

  // Override the shell helper. First use the real Fullscreen API while the click
  // still has transient user activation. If iPhone Safari refuses element
  // fullscreen, fall back to a same-origin viewport mode that removes the Phase
  // 3 header and makes the game iframe occupy the entire visual viewport.
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
