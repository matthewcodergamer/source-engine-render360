(() => {
  'use strict';

  const FILES_TYPE = 'render360-retail-files';
  const REQUEST_TYPE = 'render360-retail-request';
  const CRASH_STATE_KEY = 'render360-ios-crash-state-v2';
  const DIRECT_ROOT_RE = /^(portal|hl2|platform)\//i;
  const DIRECT_LOOSE_RE = /\/(?:gameinfo\.txt|steam\.inf|game\.inf)$/i;
  const DIRECT_SMALL_TREE_RE = /\/(?:cfg|resource|scripts)\//i;
  const MAX_LOOSE_BYTES = 8 * 1024 * 1024;

  let retailDescriptors = [];
  let runtimeFrame = null;
  let runtimeOverlay = null;
  let phase3Button = null;

  function normalize(value) {
    return String(value || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/').toLowerCase();
  }

  function inferRelativePath(file) {
    const raw = normalize(file?.webkitRelativePath || file?.name || '');
    if(!file?.webkitRelativePath) return raw;
    const parts = raw.split('/');
    return parts.length > 1 ? parts.slice(1).join('/') : raw;
  }

  function keepForDirectVPK(path, file) {
    if(!DIRECT_ROOT_RE.test(path)) return false;
    if(/\.vpk$/i.test(path)) return true;
    if(DIRECT_LOOSE_RE.test(path)) return true;
    if(DIRECT_SMALL_TREE_RE.test(path) && Number(file?.size || 0) <= MAX_LOOSE_BYTES) return true;
    return false;
  }

  function summarize(descriptors) {
    let bytes = 0;
    let vpks = 0;
    let dirs = 0;
    let gameinfo = false;
    for(const item of descriptors) {
      bytes += Number(item.file?.size || 0);
      if(/\.vpk$/i.test(item.path)) vpks++;
      if(/_dir\.vpk$/i.test(item.path)) dirs++;
      if(/(^|\/)portal\/gameinfo\.txt$/i.test(item.path)) gameinfo = true;
    }
    return { files: descriptors.length, bytes, vpks, dirs, gameinfo };
  }

  function setPhase3Status(text) {
    const hint = document.getElementById('launchHint');
    if(hint) hint.textContent = text;
  }

  function refreshButton() {
    if(!phase3Button) return;
    const stats = summarize(retailDescriptors);
    const ready = stats.gameinfo && stats.dirs > 0 && stats.vpks > 0;
    phase3Button.disabled = !ready;
    globalThis.render360Phase3DirectSelected = ready;
    if(ready) {
      phase3Button.textContent = 'Launch Phase 3 · Direct VPK';
      setPhase3Status(`Phase 3 ready: ${stats.vpks} VPK files stay as browser File objects; background1 will not be unpacked into MEMFS.`);
    }
  }

  function rememberFolder(fileList) {
    const files = Array.from(fileList || []);
    const next = [];
    for(const file of files) {
      const path = inferRelativePath(file);
      if(!keepForDirectVPK(path, file)) continue;
      next.push({ path, file });
    }
    retailDescriptors = next;
    globalThis.render360Phase3RetailFiles = retailDescriptors;
    const stats = summarize(retailDescriptors);
    globalThis.render360Phase3DirectSelected = !!(stats.gameinfo && stats.dirs > 0 && stats.vpks > 0);
    try {
      sessionStorage.setItem('render360-phase3-retail-summary-v1', JSON.stringify({
        at: Date.now(), files: stats.files, vpks: stats.vpks, dirs: stats.dirs,
        bytes: stats.bytes, gameinfo: stats.gameinfo
      }));
    } catch(_) {}
    refreshButton();
  }

  function markFreshLaunch() {
    try {
      const state = JSON.parse(localStorage.getItem(CRASH_STATE_KEY) || 'null');
      if(state) {
        state.active = false;
        state.blocked = false;
        state.interruption = null;
        state.phase = 'phase3-manual-relaunch';
        state.updatedAt = Date.now();
        localStorage.setItem(CRASH_STATE_KEY, JSON.stringify(state));
      }
      localStorage.removeItem('render360-ios-last-error-v1');
      localStorage.removeItem('render360-missing-shader-v1');
    } catch(_) {}
  }

  function closeRuntime() {
    if(runtimeFrame) {
      try { runtimeFrame.src = 'about:blank'; } catch(_) {}
      runtimeFrame.remove();
      runtimeFrame = null;
    }
    if(runtimeOverlay) {
      runtimeOverlay.remove();
      runtimeOverlay = null;
    }
    document.documentElement.style.overflow = '';
    document.body.style.overflow = '';
  }

  function launchDirectVPK() {
    const stats = summarize(retailDescriptors);
    if(!stats.gameinfo || !stats.dirs || !stats.vpks) {
      setPhase3Status('Choose the full Portal folder again before launching Phase 3. File objects cannot survive a page reload.');
      return;
    }

    closeRuntime();
    markFreshLaunch();

    const overlay = document.createElement('div');
    overlay.id = 'render360Phase3Runtime';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:#050607;display:flex;flex-direction:column;padding-top:env(safe-area-inset-top);';

    const bar = document.createElement('div');
    bar.style.cssText = 'height:48px;flex:0 0 48px;display:flex;align-items:center;gap:10px;padding:6px 10px;background:rgba(14,16,20,.94);border-bottom:1px solid rgba(255,255,255,.08);font:13px -apple-system,BlinkMacSystemFont,system-ui;color:#dfe5ed;';

    const back = document.createElement('button');
    back.type = 'button';
    back.textContent = 'Exit';
    back.style.cssText = 'appearance:none;border:0;border-radius:10px;padding:8px 12px;background:#f4f7fb;color:#101318;font-weight:700;';
    back.addEventListener('click', closeRuntime);

    const label = document.createElement('span');
    label.textContent = `Phase 3 · direct VPK · ${stats.vpks} VPK files · retail bytes outside MEMFS`;
    label.style.cssText = 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
    bar.append(back, label);

    const frame = document.createElement('iframe');
    frame.id = 'render360Phase3Frame';
    frame.title = 'Render360 Portal Phase 3 runtime';
    frame.allow = 'fullscreen; gamepad';
    frame.style.cssText = 'border:0;width:100%;flex:1 1 auto;min-height:0;background:#111;';
    frame.src = './hl2_launcher.html?render360Phase3=' + Date.now();

    overlay.append(bar, frame);
    document.body.appendChild(overlay);
    document.documentElement.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';
    runtimeOverlay = overlay;
    runtimeFrame = frame;
  }

  function installUI() {
    const folder = document.getElementById('ownershipFolder');
    if(folder) {
      // Register before the page's normal verifier. It later clears input.value,
      // but these File objects remain strongly referenced in this staging page.
      folder.addEventListener('change', event => rememberFolder(event.target.files));
    }

    const existingLaunch = document.getElementById('launch');
    const actions = existingLaunch?.parentElement;
    if(actions && !document.getElementById('launchPhase3')) {
      const button = document.createElement('button');
      button.id = 'launchPhase3';
      button.type = 'button';
      button.disabled = true;
      button.textContent = 'Launch Phase 3 · Direct VPK';
      button.addEventListener('click', launchDirectVPK);
      actions.prepend(button);
      phase3Button = button;
    }
    refreshButton();
  }

  window.addEventListener('message', event => {
    if(event.origin !== location.origin) return;
    if(!runtimeFrame || event.source !== runtimeFrame.contentWindow) return;
    const data = event?.data;
    if(!data || data.type !== REQUEST_TYPE || !data.token) return;
    const stats = summarize(retailDescriptors);
    if(!stats.gameinfo || !stats.dirs || !stats.vpks) return;
    runtimeFrame.contentWindow.postMessage({
      type: FILES_TYPE,
      token: data.token,
      files: retailDescriptors
    }, location.origin);
  });

  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', installUI, { once: true });
  else installUI();
})();
