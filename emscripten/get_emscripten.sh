set -ex

sudo apt update
sudo apt install git curl wget python3 xz-utils llvm binutils -y

# activate emsdk
git clone https://github.com/emscripten-core/emsdk.git
pushd emsdk
git checkout 2d480a1b7c7a34a354188d93f3e89190a44a1d21
./emsdk install latest
./emsdk activate latest
source ./emsdk_env.sh
popd

# Emscripten 4.0.9's cross-thread HTML5 event bridge allocates a fresh event
# payload for each proxied mouse/touch/key callback, but callback.c does not free
# that payload after dispatch. Upstream fixed this later; backport the ownership
# fix here so iPhone input cannot slowly accumulate Wasm heap pressure. Also make
# a closed/stale target-thread mailbox non-fatal: a late browser event should be
# dropped and freed rather than aborting the whole Source runtime and masking the
# earlier worker failure that closed the mailbox.
HTML5_CALLBACK=emsdk/upstream/emscripten/system/lib/html5/callback.c
python3 - "$HTML5_CALLBACK" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text()
marker = 'Render360 mobile: cross-thread HTML5 callback payload ownership'
if marker not in text:
    old_do = '''static void do_callback(void* arg) {
  callback_args_t* args = (callback_args_t*)arg;
  args->callback(args->event_type, args->event_data, args->user_data);
  free(arg);
}
'''
    new_do = '''static void do_callback(void* arg) {
  callback_args_t* args = (callback_args_t*)arg;
  args->callback(args->event_type, args->event_data, args->user_data);
  // Render360 mobile: cross-thread HTML5 callback payload ownership.
  // libhtml5.js allocates event_data specifically for the proxied callback.
  free(args->event_data);
  free(arg);
}
'''
    if old_do not in text:
        raise SystemExit('Render360: Emscripten callback dispatch block moved')
    text = text.replace(old_do, new_do, 1)

    old_alloc = '''  callback_args_t* arg = malloc(sizeof(callback_args_t));
  arg->callback = f;
'''
    new_alloc = '''  callback_args_t* arg = malloc(sizeof(callback_args_t));
  if (!arg) {
    // Input is best-effort under memory pressure; do not leak the JS-created
    // event payload just because the wrapper allocation failed.
    free(event_data);
    return;
  }
  arg->callback = f;
'''
    if old_alloc not in text:
        raise SystemExit('Render360: Emscripten callback allocation block moved')
    text = text.replace(old_alloc, new_alloc, 1)

    old_fail = '''  if (!emscripten_proxy_async(q, t, do_callback, arg)) {
    assert(false && "emscripten_proxy_async failed");
  }
'''
    new_fail = '''  if (!emscripten_proxy_async(q, t, do_callback, arg)) {
    // The target pthread mailbox can already be closed when a late DOM event
    // arrives. Free both allocations and drop that one input event instead of
    // turning a secondary stale-listener condition into a fatal runtime abort.
    free(arg->event_data);
    free(arg);
    return;
  }
'''
    if old_fail not in text:
        raise SystemExit('Render360: Emscripten callback proxy failure block moved')
    text = text.replace(old_fail, new_fail, 1)

for required in (
    marker,
    'free(args->event_data);',
    'free(arg->event_data);',
    'if (!arg) {',
):
    if required not in text:
        raise SystemExit(f'Render360: hardened HTML5 callback missing marker: {required}')

path.write_text(text)
print('Render360: hardened cross-thread HTML5 callbacks for mobile Safari')
PY

# patch and rebuild sdl2
embuilder --pic build sdl2 sdl2-mt
sed -Ei 's/freq = EM_ASM_INT/freq = MAIN_THREAD_EM_ASM_INT/' emsdk/upstream/emscripten/cache/ports/sdl2/SDL-release-2.32.0/src/audio/emscripten/SDL_emscriptenaudio.c
embuilder --force --pic build sdl2 sdl2-mt

# patch glMapBufferRange to allow some "unsupported" parameters
patch emsdk/upstream/emscripten/src/lib/libwebgl.js emscripten/libwebgl.patch