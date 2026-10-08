// Render360 on-screen controller for touch devices.
//
// A gamepad-style overlay above the game canvas. Buttons are sent to the
// engine as ordinary keyboard and mouse events (Portal's default bindings),
// so nothing in the engine has to change. Touches that miss every button fall
// through to the canvas, where Source's touch layer turns them into camera
// look (pre.js writes a touch.cfg with one full-screen look zone).
;(() => {
  'use strict';

  let touch = false;
  try { touch = navigator.maxTouchPoints > 0 && matchMedia('(pointer: coarse)').matches; } catch (_) {}
  if (!touch) return;

  const KEYS = {
    W: { key: 'w', code: 'KeyW', keyCode: 87 },
    A: { key: 'a', code: 'KeyA', keyCode: 65 },
    S: { key: 's', code: 'KeyS', keyCode: 83 },
    D: { key: 'd', code: 'KeyD', keyCode: 68 },
    E: { key: 'e', code: 'KeyE', keyCode: 69 },
    SPACE: { key: ' ', code: 'Space', keyCode: 32 },
    CTRL: { key: 'Control', code: 'ControlLeft', keyCode: 17, location: 1 },
    SHIFT: { key: 'Shift', code: 'ShiftLeft', keyCode: 16, location: 1 },
    ESC: { key: 'Escape', code: 'Escape', keyCode: 27 },
    ENTER: { key: 'Enter', code: 'Enter', keyCode: 13 },
    TAB: { key: 'Tab', code: 'Tab', keyCode: 9 },
    F6: { key: 'F6', code: 'F6', keyCode: 117 },
    F9: { key: 'F9', code: 'F9', keyCode: 120 },
  };

  // Portal's default bindings.
  const BUTTONS = [
    { id: 'pause', label: 'Pause', sub: 'Menu', key: 'ESC', cls: 'r360c-pill r360c-amber', menuToggle: true },
    { id: 'back', label: 'Back', sub: 'Save', key: 'F6', cls: 'r360c-pill' },
    { id: 'start', label: 'Start', sub: 'Load', key: 'F9', cls: 'r360c-pill' },
    { id: 'lb', label: 'LB', sub: 'Walk', key: 'SHIFT', cls: 'r360c-shoulder r360c-blue' },
    { id: 'rb', label: 'RB', sub: 'Use', key: 'E', cls: 'r360c-shoulder r360c-blue' },
    { id: 'lt', label: 'LT', sub: 'Blue portal', mouse: 0, cls: 'r360c-trigger r360c-cyan' },
    { id: 'rt', label: 'RT', sub: 'Orange portal', mouse: 2, cls: 'r360c-trigger r360c-orange' },
    { id: 'y', label: 'Y', sub: 'Walk', key: 'SHIFT', cls: 'r360c-face r360c-y' },
    { id: 'x', label: 'X', sub: 'Use', key: 'E', cls: 'r360c-face r360c-x' },
    { id: 'b', label: 'B', sub: 'Crouch', key: 'CTRL', cls: 'r360c-face r360c-b' },
    { id: 'a', label: 'A', sub: 'Jump', key: 'SPACE', cls: 'r360c-face r360c-a' },
  ];

  const css = `
    #r360c { position: fixed; inset: 0; z-index: 25; pointer-events: none; display: none;
      font: 600 15px -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif; color: #f5f5f7;
      -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; }
    body.r360-playing #r360c.r360c-on { display: block; }
    #r360c button { pointer-events: auto; position: absolute; appearance: none; margin: 0; padding: 0;
      border: 1.5px solid rgba(255,255,255,.16); color: #f5f5f7; font: inherit; touch-action: none;
      background: rgba(22,24,30,.55); -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
      display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1px;
      transition: transform .06s ease, background-color .06s ease; }
    #r360c button small { font-size: 9.5px; font-weight: 500; opacity: .6; letter-spacing: .01em; }
    #r360c button.r360c-down { transform: scale(.93); background: rgba(255,255,255,.28); }
    #r360c.r360c-menu button:not([data-id="pause"]) { display: none; }
    #r360c.r360c-menu #r360c-stick { display: none; }
    .r360c-pill { width: 96px; height: 40px; border-radius: 20px; }
    .r360c-shoulder { width: 98px; height: 42px; border-radius: 21px; }
    .r360c-trigger { width: 132px; height: 50px; border-radius: 25px; }
    .r360c-face { width: 64px; height: 64px; border-radius: 50%; font-size: 18px; }
    .r360c-amber { background: rgba(120,84,30,.5) !important; border-color: rgba(230,170,80,.45) !important; }
    .r360c-blue { background: rgba(26,40,66,.55) !important; }
    .r360c-cyan { background: rgba(20,70,90,.5) !important; border-color: rgba(80,190,240,.45) !important; }
    .r360c-orange { background: rgba(100,52,18,.5) !important; border-color: rgba(250,150,60,.45) !important; }
    .r360c-y { background: rgba(90,70,20,.5) !important; }
    .r360c-x { background: rgba(20,46,86,.5) !important; }
    .r360c-b { background: rgba(90,24,32,.5) !important; }
    .r360c-a { background: rgba(20,70,40,.5) !important; }
    #r360c-stick { pointer-events: auto; position: absolute; width: 168px; height: 168px; border-radius: 50%;
      background: rgba(22,24,30,.5); border: 1.5px solid rgba(255,255,255,.14); touch-action: none;
      -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px); }
    #r360c-stick .r360c-arrow { position: absolute; width: 14px; height: 14px; border: solid rgba(255,255,255,.75);
      border-width: 0 2.5px 2.5px 0; }
    #r360c-stick .r360c-up { left: 77px; top: 14px; transform: rotate(-135deg); }
    #r360c-stick .r360c-down { left: 77px; bottom: 14px; transform: rotate(45deg); }
    #r360c-stick .r360c-left { top: 77px; left: 14px; transform: rotate(135deg); }
    #r360c-stick .r360c-right { top: 77px; right: 14px; transform: rotate(-45deg); }
    #r360c-stick .r360c-label { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
      font-size: 14px; opacity: .8; }
    #r360c-knob { position: absolute; left: 54px; top: 54px; width: 60px; height: 60px; border-radius: 50%;
      background: rgba(255,255,255,.22); border: 1.5px solid rgba(255,255,255,.35); opacity: 0; transition: opacity .1s; }
    #r360c-stick.r360c-active #r360c-knob { opacity: 1; }
    #r360c-stick.r360c-active .r360c-label { opacity: 0; }
  `;

  // ------------------------------------------------------------------ input
  const held = new Map();   // key name -> press count (two buttons may share a key)

  function keyEvent(type, name) {
    const k = KEYS[name];
    if (!k) return;
    const event = new KeyboardEvent(type, {
      key: k.key, code: k.code, location: k.location || 0,
      keyCode: k.keyCode, which: k.keyCode, bubbles: true, cancelable: true,
    });
    // WebKit ignores keyCode/which in the init dictionary on some versions;
    // Emscripten's key handler reads them, so pin them on the instance.
    try { Object.defineProperty(event, 'keyCode', { get: () => k.keyCode }); } catch (_) {}
    try { Object.defineProperty(event, 'which', { get: () => k.keyCode }); } catch (_) {}
    window.dispatchEvent(event);
  }

  function press(name) {
    const count = held.get(name) || 0;
    held.set(name, count + 1);
    if (count === 0) keyEvent('keydown', name);
  }

  function release(name) {
    const count = held.get(name) || 0;
    if (count <= 1) {
      held.delete(name);
      if (count === 1) keyEvent('keyup', name);
    } else {
      held.set(name, count - 1);
    }
  }

  function mouseEvent(type, button) {
    const canvas = document.getElementById('canvas');
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const init = {
      bubbles: true, cancelable: true, view: window, button,
      buttons: type === 'mousedown' ? (button === 2 ? 2 : 1) : 0,
      clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2,
      screenX: rect.left + rect.width / 2, screenY: rect.top + rect.height / 2,
    };
    canvas.dispatchEvent(new MouseEvent(type, init));
  }

  function releaseAll() {
    for (const name of Array.from(held.keys())) {
      held.set(name, 1);
      release(name);
    }
  }

  // ------------------------------------------------------------------ build
  const root = document.createElement('div');
  root.id = 'r360c';
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const elements = {};
  for (const spec of BUTTONS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = spec.cls;
    button.dataset.id = spec.id;
    button.innerHTML = `<span></span><small></small>`;
    button.firstChild.textContent = spec.label;
    button.lastChild.textContent = spec.sub;
    root.appendChild(button);
    elements[spec.id] = button;

    let pointer = null;
    const down = (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (pointer !== null) return;
      pointer = event.pointerId;
      try { button.setPointerCapture(pointer); } catch (_) {}
      button.classList.add('r360c-down');
      if (spec.menuToggle) {
        keyEvent('keydown', spec.key);
        keyEvent('keyup', spec.key);
        releaseAll();
        root.classList.toggle('r360c-menu');
      } else if (spec.key) {
        press(spec.key);
      } else if (spec.mouse !== undefined) {
        mouseEvent('mousedown', spec.mouse);
      }
    };
    const up = (event) => {
      if (pointer === null || event.pointerId !== pointer) return;
      event.preventDefault();
      pointer = null;
      button.classList.remove('r360c-down');
      if (spec.menuToggle) return;
      if (spec.key) release(spec.key);
      else if (spec.mouse !== undefined) mouseEvent('mouseup', spec.mouse);
    };
    button.addEventListener('pointerdown', down);
    button.addEventListener('pointerup', up);
    button.addEventListener('pointercancel', up);
    button.addEventListener('lostpointercapture', up);
    button.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  // Move stick: 8-way WASD with a dead zone.
  const stick = document.createElement('div');
  stick.id = 'r360c-stick';
  stick.innerHTML = '<i class="r360c-arrow r360c-up"></i><i class="r360c-arrow r360c-down"></i>' +
    '<i class="r360c-arrow r360c-left"></i><i class="r360c-arrow r360c-right"></i>' +
    '<span class="r360c-label">Move</span><div id="r360c-knob"></div>';
  root.appendChild(stick);
  const knob = stick.querySelector('#r360c-knob');
  let stickPointer = null;
  const stickKeys = new Set();

  function setStickKeys(next) {
    for (const name of stickKeys) if (!next.has(name)) { stickKeys.delete(name); release(name); }
    for (const name of next) if (!stickKeys.has(name)) { stickKeys.add(name); press(name); }
  }

  function moveStick(event) {
    const rect = stick.getBoundingClientRect();
    const radius = rect.width / 2;
    let dx = event.clientX - (rect.left + radius);
    let dy = event.clientY - (rect.top + radius);
    const length = Math.hypot(dx, dy);
    const max = radius - 30;
    if (length > max) { dx = dx / length * max; dy = dy / length * max; }
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
    const nx = dx / max, ny = dy / max;
    const next = new Set();
    const dead = 0.32;
    if (ny < -dead) next.add('W');
    if (ny > dead) next.add('S');
    if (nx < -dead) next.add('A');
    if (nx > dead) next.add('D');
    setStickKeys(next);
  }

  stick.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    if (stickPointer !== null) return;
    stickPointer = event.pointerId;
    try { stick.setPointerCapture(stickPointer); } catch (_) {}
    stick.classList.add('r360c-active');
    moveStick(event);
  });
  stick.addEventListener('pointermove', (event) => {
    if (event.pointerId !== stickPointer) return;
    event.preventDefault();
    moveStick(event);
  });
  const endStick = (event) => {
    if (event.pointerId !== stickPointer) return;
    stickPointer = null;
    stick.classList.remove('r360c-active');
    knob.style.transform = '';
    setStickKeys(new Set());
  };
  stick.addEventListener('pointerup', endStick);
  stick.addEventListener('pointercancel', endStick);
  stick.addEventListener('lostpointercapture', endStick);

  // ------------------------------------------------------------------ layout
  function place(el, x, y) {
    el.style.left = `${Math.round(x)}px`;
    el.style.top = `${Math.round(y)}px`;
  }

  function layout() {
    const vv = window.visualViewport;
    const W = vv ? vv.width : window.innerWidth;
    const H = vv ? vv.height : window.innerHeight;
    const cs = getComputedStyle(document.documentElement);
    const safeL = parseFloat(cs.getPropertyValue('--safe-l')) || 0;
    const safeR = parseFloat(cs.getPropertyValue('--safe-r')) || 0;
    const L = Math.max(16, safeL + 8);
    const R = W - Math.max(16, safeR + 8);
    // Scale everything down a little on short landscape screens.
    const s = Math.max(0.72, Math.min(1, H / 430));

    const sz = (n) => n * s;
    const size = (el, w, h) => { el.style.width = `${sz(w)}px`; el.style.height = `${sz(h)}px`; };

    size(elements.pause, 96, 40); place(elements.pause, L, 12);
    size(elements.back, 86, 40); size(elements.start, 86, 40);
    place(elements.back, W / 2 - sz(86) - sz(54), 12);
    place(elements.start, W / 2 + sz(54), 12);

    size(elements.lb, 98, 42); size(elements.rb, 98, 42);
    place(elements.rb, R - sz(98), 12);
    place(elements.lb, R - sz(98) * 2 - sz(12), 12);

    size(elements.lt, 132, 50); size(elements.rt, 132, 50);
    place(elements.lt, L + sz(20), H * 0.42 - sz(25));
    place(elements.rt, R - sz(132), H * 0.42 - sz(25));

    const face = sz(64);
    for (const id of ['a', 'b', 'x', 'y']) size(elements[id], 64, 64);
    const cx = R - sz(64) - face / 2 - sz(16);
    const cy = H - sz(28) - face * 1.5;
    const gap = face * 0.95;
    place(elements.y, cx - face / 2, cy - gap - face / 2);
    place(elements.a, cx - face / 2, cy + gap - face / 2);
    place(elements.x, cx - gap - face / 2, cy - face / 2);
    place(elements.b, cx + gap - face / 2, cy - face / 2);

    const st = sz(168);
    stick.style.width = stick.style.height = `${st}px`;
    knob.style.left = knob.style.top = `${(st - sz(60)) / 2}px`;
    knob.style.width = knob.style.height = `${sz(60)}px`;
    for (const arrow of stick.querySelectorAll('.r360c-arrow')) arrow.style.margin = '0';
    stick.querySelector('.r360c-up').style.left = stick.querySelector('.r360c-down').style.left = `${st / 2 - 7}px`;
    stick.querySelector('.r360c-left').style.top = stick.querySelector('.r360c-right').style.top = `${st / 2 - 7}px`;
    place(stick, L + sz(30), H - st - sz(20));
  }

  // ------------------------------------------------------------------ state
  // Shown in a real map, hidden on the menu background map so menu taps reach
  // the game. The in-game menu can also show or hide it.
  let wanted = null;    // null = automatic, true/false = player's choice
  let inMap = false;

  function apply() {
    const on = wanted === null ? inMap : wanted;
    root.classList.toggle('r360c-on', on);
    if (!on) { releaseAll(); root.classList.remove('r360c-menu'); }
    const toggle = document.getElementById('r360-controller-row');
    if (toggle) toggle.textContent = on ? 'Hide controller' : 'Show controller';
  }

  window.render360ToggleController = () => {
    const on = root.classList.contains('r360c-on');
    wanted = !on;
    apply();
  };

  // pre.js / phase3 loaders announce every map they load.
  window.render360ControllerSeeLine = (line) => {
    const match = /\[Render360 Phase 3\]\s+([A-Za-z0-9_]+):\s+current-map-only/.exec(line) ||
      /\bloaded\s+([A-Za-z0-9_]+)\.data\b/.exec(line);
    if (!match) return;
    inMap = !/^background/i.test(match[1]);
    root.classList.remove('r360c-menu');
    apply();
  };

  function mount() {
    document.body.appendChild(root);
    layout();
    apply();
  }

  window.addEventListener('resize', layout);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', layout);
  window.addEventListener('blur', releaseAll);
  document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAll(); });
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount, { once: true });
})();
