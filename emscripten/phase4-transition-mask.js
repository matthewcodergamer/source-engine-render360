// Render360 Phase 4 — lightweight diegetic transition mask.
//
// The Source engine still owns the real map lifetime: Host_Changelevel tears the
// old BSP/world down and brings the next one up. This layer only hides the short
// synchronous transition from the player. It deliberately does NOT capture the
// canvas, duplicate textures, preload a second BSP, or retain the previous map.
// The mask is CSS-only so the memory cost stays tiny on iPhone.
;(() => {
  'use strict'

  const CHANNEL_NAME = 'render360-phase4-transition-v1'
  const MESSAGE_TYPE = 'render360-phase4-transition'
  const REVEAL_DELAY_MS = 90
  const MIN_VISIBLE_MS = 320
  const OPEN_ANIMATION_MS = 360
  const OVER_BUDGET_MS = 10000

  const isWindow = typeof window !== 'undefined' && typeof document !== 'undefined'
  const isPthread = typeof ENVIRONMENT_IS_PTHREAD !== 'undefined' && !!ENVIRONMENT_IS_PTHREAD

  let channel = null
  try {
    if(typeof BroadcastChannel === 'function') channel = new BroadcastChannel(CHANNEL_NAME)
  } catch(_) {}

  const state = {
    active: false,
    visible: false,
    map: null,
    startedAt: 0,
    visibleAt: 0,
    completedAt: 0,
    lastDurationMs: 0,
    sequence: 0,
    overBudget: false
  }

  let overlay = null
  let revealTimer = 0
  let hideTimer = 0
  let budgetTimer = 0

  function now() {
    return typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now()
  }

  function normalizeMap(value) {
    const clean = String(value || '').replace(/\\/g, '/').toLowerCase()
    return clean.slice(clean.lastIndexOf('/') + 1).replace(/\.bsp$/i, '') || clean
  }

  function safePrint(text, error = false) {
    try {
      const fn = error ? Module.printErr : Module.print
      if(typeof fn === 'function') fn(text)
      else (error ? console.error : console.log)(text)
    } catch(_) {}
  }

  function snapshot(label) {
    try { return globalThis.render360MemorySnapshot?.(label) || null } catch(_) { return null }
  }

  function publish() {
    const copy = { ...state }
    Module.render360Phase4Transition = copy
    globalThis.render360Phase4Transition = copy
  }

  function clearTimer(id) {
    if(id) clearTimeout(id)
    return 0
  }

  function ensureOverlay() {
    if(!isWindow) return null
    if(overlay && overlay.isConnected) return overlay

    const style = document.createElement('style')
    style.id = 'render360-phase4-transition-style'
    style.textContent = `
      #render360-phase4-transition {
        position: fixed;
        inset: 0;
        z-index: 2147483646;
        overflow: hidden;
        pointer-events: none;
        touch-action: none;
        opacity: 0;
        visibility: hidden;
        background: #060708;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        contain: strict;
      }
      #render360-phase4-transition.r360-visible {
        opacity: 1;
        visibility: visible;
        pointer-events: auto;
      }
      #render360-phase4-transition .r360-door {
        position: absolute;
        top: 0;
        bottom: 0;
        width: 50.2%;
        background:
          linear-gradient(90deg, rgba(255,255,255,.025), rgba(255,255,255,0) 18%),
          repeating-linear-gradient(90deg, #101316 0 1px, #0b0d0f 1px 46px, #15181b 47px 48px);
        will-change: transform;
        transition: transform 220ms cubic-bezier(.2,.75,.2,1);
      }
      #render360-phase4-transition .r360-left { left: 0; transform: translate3d(-101%,0,0); }
      #render360-phase4-transition .r360-right { right: 0; transform: translate3d(101%,0,0); }
      #render360-phase4-transition.r360-visible .r360-left,
      #render360-phase4-transition.r360-visible .r360-right { transform: translate3d(0,0,0); }
      #render360-phase4-transition.r360-opening .r360-left { transform: translate3d(-101%,0,0); transition-duration: ${OPEN_ANIMATION_MS}ms; }
      #render360-phase4-transition.r360-opening .r360-right { transform: translate3d(101%,0,0); transition-duration: ${OPEN_ANIMATION_MS}ms; }
      #render360-phase4-transition .r360-seam {
        position: absolute;
        left: 50%;
        top: 0;
        bottom: 0;
        width: 1px;
        transform: translateX(-.5px);
        background: rgba(255,255,255,.16);
        box-shadow: 0 0 14px rgba(255,255,255,.08);
        opacity: 0;
        transition: opacity 120ms ease 160ms;
      }
      #render360-phase4-transition.r360-visible .r360-seam { opacity: 1; }
      #render360-phase4-transition.r360-opening .r360-seam { opacity: 0; transition-delay: 0ms; }
      #render360-phase4-transition .r360-label {
        position: absolute;
        left: 50%;
        bottom: max(28px, env(safe-area-inset-bottom));
        transform: translateX(-50%);
        color: rgba(255,255,255,.62);
        font-size: 10px;
        font-weight: 600;
        letter-spacing: .24em;
        white-space: nowrap;
        opacity: 0;
        transition: opacity 160ms ease 180ms;
      }
      #render360-phase4-transition.r360-visible .r360-label { opacity: 1; }
      #render360-phase4-transition.r360-opening .r360-label { opacity: 0; transition-delay: 0ms; }
      #render360-phase4-transition .r360-pulse {
        display: inline-block;
        width: 5px;
        height: 5px;
        margin-right: 9px;
        border-radius: 50%;
        background: currentColor;
        vertical-align: 1px;
        animation: r360TransitPulse 900ms ease-in-out infinite alternate;
      }
      @keyframes r360TransitPulse { from { opacity: .25; } to { opacity: 1; } }
      @media (prefers-reduced-motion: reduce) {
        #render360-phase4-transition .r360-door,
        #render360-phase4-transition .r360-seam,
        #render360-phase4-transition .r360-label { transition-duration: 1ms !important; }
        #render360-phase4-transition .r360-pulse { animation: none; }
      }
    `
    if(!document.getElementById(style.id)) (document.head || document.documentElement).appendChild(style)

    overlay = document.createElement('div')
    overlay.id = 'render360-phase4-transition'
    overlay.setAttribute('aria-hidden', 'true')
    overlay.innerHTML = '<div class="r360-door r360-left"></div><div class="r360-door r360-right"></div><div class="r360-seam"></div><div class="r360-label"><span class="r360-pulse"></span>APERTURE SCIENCE · TRANSIT</div>'
    ;(document.body || document.documentElement).appendChild(overlay)
    return overlay
  }

  function reveal(sequence) {
    if(!state.active || sequence !== state.sequence) return
    const node = ensureOverlay()
    if(!node) return
    state.visible = true
    state.visibleAt = now()
    node.classList.remove('r360-opening')
    // Force the initial offscreen transform to paint before the closing class.
    void node.offsetWidth
    node.classList.add('r360-visible')
    node.setAttribute('aria-hidden', 'false')
    publish()
  }

  function begin(mapName) {
    const map = normalizeMap(mapName)
    state.sequence++
    state.active = true
    state.visible = false
    state.map = map
    state.startedAt = now()
    state.completedAt = 0
    state.overBudget = false
    revealTimer = clearTimer(revealTimer)
    hideTimer = clearTimer(hideTimer)
    budgetTimer = clearTimer(budgetTimer)

    const sequence = state.sequence
    revealTimer = setTimeout(() => reveal(sequence), REVEAL_DELAY_MS)
    budgetTimer = setTimeout(() => {
      if(!state.active || sequence !== state.sequence) return
      state.overBudget = true
      publish()
      safePrint(`[Render360 Phase 4] transition to ${map || 'unknown'} exceeded ${OVER_BUDGET_MS}ms; keeping the CSS transit mask up while Source finishes.`, true)
    }, OVER_BUDGET_MS)

    snapshot(`phase4-transition-begin:${map}`)
    publish()
    safePrint(`[Render360 Phase 4] transition begin -> ${map || 'unknown'}; previous BSP may now be released by Source before the next BSP becomes active.`)
  }

  function finish(kind, mapName) {
    const map = normalizeMap(mapName) || state.map
    if(!state.active) {
      state.map = map
      state.completedAt = now()
      publish()
      return
    }

    revealTimer = clearTimer(revealTimer)
    budgetTimer = clearTimer(budgetTimer)
    state.active = false
    state.completedAt = now()
    state.lastDurationMs = Math.max(0, state.completedAt - state.startedAt)
    snapshot(`phase4-transition-${kind}:${map}`)

    if(kind === 'ready') {
      // Host_Changelevel has returned. At this point Source has completed the
      // native level swap; Render360 itself still retains no prior BSP payload.
      try {
        Module.render360Phase4LastReleasedMap = Module.render360MapResidency?.previousMap || null
        Module.render360Phase4LastReleaseAt = Date.now()
      } catch(_) {}
    }

    const closeOut = () => {
      if(!overlay || !state.visible) {
        state.visible = false
        publish()
        return
      }
      overlay.classList.add('r360-opening')
      hideTimer = setTimeout(() => {
        if(!overlay) return
        overlay.classList.remove('r360-visible', 'r360-opening')
        overlay.setAttribute('aria-hidden', 'true')
        state.visible = false
        publish()
      }, OPEN_ANIMATION_MS)
    }

    if(state.visible) {
      const visibleFor = Math.max(0, now() - state.visibleAt)
      hideTimer = setTimeout(closeOut, Math.max(0, MIN_VISIBLE_MS - visibleFor))
    } else {
      closeOut()
    }

    publish()
    safePrint(`[Render360 Phase 4] transition ${kind} -> ${map || 'unknown'} in ${state.lastDurationMs.toFixed(0)}ms; mask=${state.visible ? 'shown' : 'skipped-fast-path'}.`)
  }

  function handle(kind, mapName) {
    if(kind === 'begin') begin(mapName)
    else if(kind === 'ready' || kind === 'failed') finish(kind, mapName)
  }

  // Called from the Emscripten engine-side Host_Changelevel instrumentation.
  // With PROXY_TO_PTHREAD the game normally calls this inside the application
  // pthread, so relay to the browser main context over BroadcastChannel.
  globalThis.render360Phase4TransitionSignal = (kind, mapName) => {
    const cleanKind = String(kind || '').toLowerCase()
    const cleanMap = normalizeMap(mapName)
    if(!cleanKind) return
    if(isWindow) {
      handle(cleanKind, cleanMap)
      return
    }
    try { channel?.postMessage({ type: MESSAGE_TYPE, kind: cleanKind, map: cleanMap }) } catch(_) {}
  }

  if(isWindow && channel) {
    channel.addEventListener('message', event => {
      const data = event?.data
      if(!data || data.type !== MESSAGE_TYPE) return
      handle(String(data.kind || '').toLowerCase(), data.map)
    })
  }

  publish()
  globalThis.render360Phase4TransitionMask = {
    channel: CHANNEL_NAME,
    revealDelayMs: REVEAL_DELAY_MS,
    minVisibleMs: MIN_VISIBLE_MS,
    openAnimationMs: OPEN_ANIMATION_MS,
    get state() { return { ...state } },
    signal: globalThis.render360Phase4TransitionSignal
  }
})()
