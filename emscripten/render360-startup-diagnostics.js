// Render360 structured Source startup diagnostics.
//
// This intentionally keeps a small bounded trace rather than a general runtime
// log. Its job is to preserve the deepest failing AppSystemGroup and the last
// useful creation checkpoint even when later outer wrapper messages report NONE.
;(() => {
  'use strict'

  const isWindow = typeof window !== 'undefined' && typeof document !== 'undefined'
  if(!isWindow) return

  const TRACE_KEY = 'render360-startup-trace-v2'
  const STAGE_NAMES = [
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
  const MAX_TRACE_LINES = 24
  const MAX_LINE_CHARS = 768
  const MAX_HINT_CHARS = 256

  function freshState() {
    return {
      version: 2,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      deepestFailure: null,
      lastReturn: null,
      lastHint: null,
      trace: []
    }
  }

  let state = freshState()
  try {
    const nav = performance.getEntriesByType?.('navigation')?.[0]
    const preserve = nav?.type === 'reload'
    if(preserve) {
      const previous = JSON.parse(localStorage.getItem(TRACE_KEY) || 'null')
      if(previous && previous.version === 2 && Date.now() - Number(previous.updatedAt || 0) < 3 * 60 * 1000) {
        state = previous
        state.trace = Array.isArray(state.trace) ? state.trace.slice(-MAX_TRACE_LINES) : []
      }
    } else {
      localStorage.removeItem(TRACE_KEY)
    }
  } catch(_) {}

  function stageName(stage) {
    const value = Number(stage)
    return STAGE_NAMES[value] || `UNKNOWN_${value}`
  }

  function persist() {
    state.updatedAt = Date.now()
    try { localStorage.setItem(TRACE_KEY, JSON.stringify(state)) } catch(_) {}
  }

  function pushTrace(line) {
    const compact = String(line || '').trim().slice(-MAX_LINE_CHARS)
    if(!compact) return
    state.trace.push({ at: Date.now(), line: compact })
    if(state.trace.length > MAX_TRACE_LINES) state.trace.splice(0, state.trace.length - MAX_TRACE_LINES)
  }

  function rememberHint(line) {
    const text = String(line || '')
    const hint = text.match(/\[Render360 startup\]\s*(mod-create-(?:fail|client|server|appsystems)[^\n]*)/i)
      || text.match(/\[Render360 startup\]\s*((?:create|preinit)-fail:[^\n]*)/i)
    if(!hint) return
    state.lastHint = String(hint[1] || '').slice(-MAX_HINT_CHARS)
  }

  function considerFailure(group, depth, result, stage, sourceLine) {
    const numericStage = Number(stage)
    if(!Number.isInteger(numericStage) || numericStage < 0 || numericStage >= 8) return

    const candidate = {
      group,
      depth,
      result: Number(result),
      stage: numericStage,
      stageName: stageName(numericStage),
      hint: state.lastHint || null,
      line: String(sourceLine || '').slice(-MAX_LINE_CHARS),
      at: Date.now()
    }
    const current = state.deepestFailure
    if(!current || Number(candidate.depth) >= Number(current.depth || 0)) {
      state.deepestFailure = candidate
    }
  }

  function observeStartup(text) {
    const line = String(text || '').trim()
    if(!line.includes('[Render360 startup]')) return false

    pushTrace(line)
    rememberHint(line)

    let match = line.match(/mod-return:(-?\d+)\s+mod-stage:(\d+)/i)
    if(match) {
      const result = Number(match[1])
      const stage = Number(match[2])
      state.lastReturn = { group: 'mod', result, stage, stageName: stageName(stage), at: Date.now() }
      considerFailure('mod', 3, result, stage, line)
    }

    match = line.match(/steam-return:(-?\d+)\s+steam-stage:(\d+)\s+source-stage:(\d+)/i)
    if(match) {
      const result = Number(match[1])
      const steamStage = Number(match[2])
      const sourceStage = Number(match[3])
      state.lastReturn = {
        group: 'steam/source',
        result,
        steamStage,
        steamStageName: stageName(steamStage),
        sourceStage,
        sourceStageName: stageName(sourceStage),
        at: Date.now()
      }
      considerFailure('source', 2, result, sourceStage, line)
      considerFailure('steam', 1, result, steamStage, line)
    }

    persist()
    return true
  }

  function failurePhase() {
    const failure = state.deepestFailure
    if(!failure) return ''
    const hint = failure.hint ? `:${failure.hint.replace(/[^a-z0-9_.:-]+/gi, '-').slice(0, 80)}` : ''
    return `startup-failure:${failure.group}:${failure.stageName.toLowerCase()}:return:${failure.result}${hint}`
  }

  function restoreDeepestFailurePhase() {
    const phase = failurePhase()
    if(!phase) return
    try { globalThis.render360SetPhase?.(phase) } catch(_) {}
  }

  const oldPrint = typeof Module.print === 'function' ? Module.print.bind(Module) : console.log.bind(console)
  const oldPrintErr = typeof Module.printErr === 'function' ? Module.printErr.bind(Module) : console.error.bind(console)

  Module.print = (...args) => {
    const line = args.join(' ')
    const startup = observeStartup(line)
    oldPrint(...args)
    if(startup && state.deepestFailure) restoreDeepestFailurePhase()
  }

  Module.printErr = (...args) => {
    const line = args.join(' ')
    const startup = observeStartup(line)
    oldPrintErr(...args)
    if(startup && state.deepestFailure) restoreDeepestFailurePhase()
  }

  const oldDiagnosticText = globalThis.render360DiagnosticText
  if(typeof oldDiagnosticText === 'function') {
    globalThis.render360DiagnosticText = () => {
      const base = oldDiagnosticText()
      const lines = [
        base,
        '',
        '--- structured startup diagnostics ---',
        `deepestStartupFailure=${JSON.stringify(state.deepestFailure)}`,
        `lastStartupReturn=${JSON.stringify(state.lastReturn)}`,
        `startupLastHint=${JSON.stringify(state.lastHint)}`,
        'startupTrace:'
      ]
      for(const entry of state.trace.slice(-MAX_TRACE_LINES)) {
        lines.push(`${new Date(Number(entry.at || 0)).toISOString()} ${entry.line}`)
      }
      return lines.join('\n')
    }
  }

  if(typeof diagnosticStatusElement !== 'undefined' && diagnosticStatusElement) {
    diagnosticStatusElement.textContent = 'Latest runtime event + bounded startup trace'
  }

  globalThis.render360StartupDiagnostics = {
    getState: () => JSON.parse(JSON.stringify(state)),
    getDeepestFailure: () => state.deepestFailure ? { ...state.deepestFailure } : null,
    stageName
  }

  persist()
})()
