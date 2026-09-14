// Render360 browser-backed retail file bridge.
//
// This code is linked into the MAIN_MODULE and exported for filesystem_stdio.so.
// Source runs under PROXY_TO_PTHREAD, so these EM_JS calls execute on the calling
// Source pthread. Phase 3 mounts the user's File objects in that pthread through
// WORKERFS; FileReaderSync can therefore service synchronous Source/VPK reads
// without copying the retail archives into MEMFS or the Wasm heap permanently.

#ifdef __EMSCRIPTEN__

#include <emscripten.h>
#include <stddef.h>

// Keep path normalization free of JavaScript regex literals whose escaped
// trailing slash can become a C/C++ // token while EM_JS is being preprocessed.
// String operations are tiny here and make this bridge stable across Clang/
// Emscripten versions.
EM_JS(int, render360_browser_file_open_js, (const char *pathPtr), {
  try {
    if (typeof FileReaderSync === 'undefined') return -1;
    var path = UTF8ToString(pathPtr || 0);
    path = path.split('\\').join('/');
    while (path.indexOf('//') >= 0) path = path.split('//').join('/');
    while (path.charAt(0) === '/') path = path.slice(1);
    while (path.indexOf('/./') >= 0) path = path.split('/./').join('/');
    while (path.slice(0, 2) === './') path = path.slice(2);
    path = path.toLowerCase();

    var file = null;
    var files = globalThis.__render360RetailFileMap;
    if (files && typeof files.get === 'function') file = files.get(path) || null;

    // The Phase 3 handoff already mounted these File/Blob objects in this
    // pthread's WORKERFS. Resolve the backing Blob directly instead of entering
    // libc/legacy JS FS, whose pthread syscalls are normally proxied to the
    // browser main thread and cannot use FileReaderSync.
    if (!file && typeof FS !== 'undefined') {
      try {
        var resolved = FS.lookupPath('/render360-retail/' + path, { follow: true });
        var node = resolved && resolved.node;
        if (node && node.contents && typeof node.contents.slice === 'function') {
          file = node.contents;
        }
      } catch (_) {}
    }
    if (!file) return -1;

    var handles = globalThis.__render360RetailHandles;
    if (!handles) handles = globalThis.__render360RetailHandles = new Map();
    var next = (globalThis.__render360RetailNextHandle | 0) || 1;
    while (handles.has(next)) {
      next = (next + 1) | 0;
      if (next <= 0) next = 1;
    }
    handles.set(next, file);
    globalThis.__render360RetailNextHandle = (next + 1) | 0;
    return next;
  } catch (e) {
    try { console.error('[Render360 direct file] open failed', e); } catch (_) {}
    return -1;
  }
});

EM_JS(double, render360_browser_file_size_js, (int handle), {
  try {
    var handles = globalThis.__render360RetailHandles;
    var file = handles && handles.get(handle | 0);
    return file ? Number(file.size || 0) : -1;
  } catch (_) {
    return -1;
  }
});

EM_JS(int, render360_browser_file_read_js,
      (int handle, double offset, void *dest, int length), {
  try {
    var handles = globalThis.__render360RetailHandles;
    var file = handles && handles.get(handle | 0);
    if (!file || typeof FileReaderSync === 'undefined') return -1;
    var start = Math.max(0, Math.floor(Number(offset) || 0));
    var requested = Math.max(0, length | 0);
    if (!requested || start >= file.size) return 0;
    var end = Math.min(file.size, start + requested);
    var buffer = new FileReaderSync().readAsArrayBuffer(file.slice(start, end));
    var bytes = new Uint8Array(buffer);
    HEAPU8.set(bytes, dest >>> 0);
    return bytes.byteLength | 0;
  } catch (e) {
    try { console.error('[Render360 direct file] read failed', e); } catch (_) {}
    return -1;
  }
});

EM_JS(void, render360_browser_file_close_js, (int handle), {
  try {
    var handles = globalThis.__render360RetailHandles;
    if (handles) handles.delete(handle | 0);
  } catch (_) {}
});

EM_JS(double, render360_browser_file_stat_js, (const char *pathPtr), {
  try {
    var path = UTF8ToString(pathPtr || 0);
    path = path.split('\\').join('/');
    while (path.indexOf('//') >= 0) path = path.split('//').join('/');
    while (path.charAt(0) === '/') path = path.slice(1);
    while (path.indexOf('/./') >= 0) path = path.split('/./').join('/');
    while (path.slice(0, 2) === './') path = path.slice(2);
    path = path.toLowerCase();

    var file = null;
    var files = globalThis.__render360RetailFileMap;
    if (files && typeof files.get === 'function') file = files.get(path) || null;
    if (!file && typeof FS !== 'undefined') {
      try {
        var resolved = FS.lookupPath('/render360-retail/' + path, { follow: true });
        var node = resolved && resolved.node;
        if (node && node.contents && typeof node.contents.slice === 'function') {
          file = node.contents;
        }
      } catch (_) {}
    }
    return file ? Number(file.size || 0) : -1;
  } catch (_) {
    return -1;
  }
});

extern "C" EMSCRIPTEN_KEEPALIVE int render360_browser_file_open(const char *path)
{
    return render360_browser_file_open_js(path);
}

extern "C" EMSCRIPTEN_KEEPALIVE double render360_browser_file_size(int handle)
{
    return render360_browser_file_size_js(handle);
}

extern "C" EMSCRIPTEN_KEEPALIVE int render360_browser_file_read(int handle, double offset, void *dest, int length)
{
    return render360_browser_file_read_js(handle, offset, dest, length);
}

extern "C" EMSCRIPTEN_KEEPALIVE void render360_browser_file_close(int handle)
{
    render360_browser_file_close_js(handle);
}

extern "C" EMSCRIPTEN_KEEPALIVE double render360_browser_file_stat(const char *path)
{
    return render360_browser_file_stat_js(path);
}

#endif // __EMSCRIPTEN__
