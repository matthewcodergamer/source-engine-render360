set -ex

sudo apt update
sudo apt install git curl wget python3 xz-utils llvm binutils -y

# Phase 4 experimental toolchain. Keep the production iPhone baseline pinned on
# its existing SDK; this branch deliberately tests the newer Emscripten runtime
# needed for growable/resizable Wasm-memory views.
EMSCRIPTEN_VERSION="${RENDER360_EMSCRIPTEN_VERSION:-6.0.6}"

git clone --branch "$EMSCRIPTEN_VERSION" --depth 1 https://github.com/emscripten-core/emsdk.git
pushd emsdk
./emsdk install "$EMSCRIPTEN_VERSION"
./emsdk activate "$EMSCRIPTEN_VERSION"
source ./emsdk_env.sh
emcc -v
popd

# 6.0.6 already contains upstream's cross-thread HTML5 event-payload lifetime
# fix, but its callback bridge still aborts the whole program if a late DOM event
# targets a pthread mailbox that has already closed. On mobile Safari that can
# turn a secondary stale input event into the visible crash and hide the earlier
# worker failure. Treat browser input as best-effort: if the tiny wrapper cannot
# be allocated, or the target mailbox is gone, drop that one event and free it.
HTML5_CALLBACK=emsdk/upstream/emscripten/system/lib/html5/callback.c
python3 - "$HTML5_CALLBACK" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text()
marker = 'Render360 mobile: stale cross-thread HTML5 callbacks are non-fatal'
if marker not in text:
    old_alloc = '''  callback_args_t* arg = malloc(sizeof(callback_args_t) + event_data_size);
  arg->callback = f;
'''
    new_alloc = '''  callback_args_t* arg = malloc(sizeof(callback_args_t) + event_data_size);
  if (!arg) {
    // Render360 mobile: stale cross-thread HTML5 callbacks are non-fatal.
    // Input is best-effort under memory pressure; dropping one event is safer
    // than dereferencing a null wrapper and terminating the Source runtime.
    return;
  }
  arg->callback = f;
'''
    if old_alloc not in text:
        raise SystemExit('Render360 Phase 4: Emscripten callback allocation block moved')
    text = text.replace(old_alloc, new_alloc, 1)

    old_fail = '''  if (!emscripten_proxy_async(q, t, do_callback, arg)) {
    assert(false && "emscripten_proxy_async failed");
  }
'''
    new_fail = '''  if (!emscripten_proxy_async(q, t, do_callback, arg)) {
    // A DOM event can race pthread teardown. The payload is owned by `arg` in
    // 6.0.6, so free it and preserve the actual earlier runtime failure.
    free(arg);
    return;
  }
'''
    if old_fail not in text:
        raise SystemExit('Render360 Phase 4: Emscripten callback proxy failure block moved')
    text = text.replace(old_fail, new_fail, 1)

for required in (
    marker,
    'if (!arg) {',
    'free(arg);',
):
    if required not in text:
        raise SystemExit(f'Render360 Phase 4: hardened HTML5 callback missing marker: {required}')

path.write_text(text)
print('Render360 Phase 4: hardened cross-thread HTML5 callbacks for mobile Safari')
PY

# Patch and rebuild SDL2. Newer SDKs may update the SDL release directory name,
# so locate the port source instead of hard-coding SDL-release-2.32.0.
embuilder --pic build sdl2 sdl2-mt
SDL_EMSCRIPTEN_AUDIO=$(find emsdk/upstream/emscripten/cache/ports/sdl2 -type f -path '*/src/audio/emscripten/SDL_emscriptenaudio.c' -print -quit)
if [ -z "$SDL_EMSCRIPTEN_AUDIO" ]; then
	echo "Render360 Phase 4: could not locate SDL_emscriptenaudio.c" >&2
	exit 1
fi
if grep -q 'freq = EM_ASM_INT' "$SDL_EMSCRIPTEN_AUDIO"; then
	sed -Ei 's/freq = EM_ASM_INT/freq = MAIN_THREAD_EM_ASM_INT/' "$SDL_EMSCRIPTEN_AUDIO"
fi
grep -q 'freq = MAIN_THREAD_EM_ASM_INT' "$SDL_EMSCRIPTEN_AUDIO"
embuilder --force --pic build sdl2 sdl2-mt

# Source/ToGL uses glMapBufferRange with flag combinations that stock Emscripten
# rejects. The old unified-diff patch was tied to a specific libwebgl.js line
# number/quote style and stopped applying on 6.0.6. Patch the validation block
# semantically instead so the Phase 4 SDK upgrade remains reproducible.
WEBGL_LIB=emsdk/upstream/emscripten/src/lib/libwebgl.js
if [ ! -f "$WEBGL_LIB" ]; then
	echo "Render360 Phase 4: Emscripten moved libwebgl.js; update the WebGL patch target." >&2
	exit 1
fi
python3 - "$WEBGL_LIB" <<'PY'
from pathlib import Path
import re
import sys

path = Path(sys.argv[1])
text = path.read_text()

pattern = re.compile(
    r"(\s*glMapBufferRange:\s*\(target, offset, length, access\)\s*=>\s*\{\n)"
    r".*?"
    r"(\s*if \(!emscriptenWebGLValidateMapBufferTarget\(target\)\) \{)",
    re.S,
)

replacement = r'''\1    // Render360/Source permits UNSYNCHRONIZED and does not require the
    // INVALIDATE flags here. Read mapping is still unsupported by WebGL.
    if ((access & 0x1/*GL_MAP_READ_BIT*/) != 0) {
      err('glMapBufferRange access does not support MAP_READ');
      GL.recordError(0x501 /* GL_INVALID_VALUE */);
      return 0;
    }

\2'''

updated, count = pattern.subn(replacement, text, count=1)
if count != 1:
    raise SystemExit('Render360 Phase 4: could not locate glMapBufferRange validation block in modern libwebgl.js')

required = (
    'Render360/Source permits UNSYNCHRONIZED',
    "err('glMapBufferRange access does not support MAP_READ')",
    'GL.recordError(0x501 /* GL_INVALID_VALUE */);',
    'if (!emscriptenWebGLValidateMapBufferTarget(target)) {',
)
for marker in required:
    if marker not in updated:
        raise SystemExit(f'Render360 Phase 4: patched libwebgl.js missing marker: {marker}')

for forbidden in (
    'glMapBufferRange access must include MAP_WRITE',
    'glMapBufferRange access must include INVALIDATE_BUFFER or INVALIDATE_RANGE',
):
    if forbidden in updated:
        raise SystemExit(f'Render360 Phase 4: old glMapBufferRange validation survived: {forbidden}')

path.write_text(updated)
print('Render360 Phase 4: patched modern glMapBufferRange validation')
PY

# The release compiler profile force-includes <alloca.h> for every Wasm
# translation unit, so do not mutate dozens of IVP submodule files just to add
# the same declaration. Keeping the submodule checkout clean also makes genuine
# physics-source changes easier to spot in CI diagnostics.

# Source already tears down the old world on Host_Changelevel and explicitly
# unloads unreferenced models. On iPhone we also ask the material system to drop
# materials/textures whose refcounts reached zero at that same safe level-change
# boundary. This preserves referenced shared/UI materials while preventing
# map-specific material caches from quietly accumulating across chambers.
python3 - <<'PY'
from pathlib import Path

path = Path('engine/host.cpp')
text = path.read_text()
marker = 'Render360 Phase 4: released unused level materials after old-world shutdown'
if marker not in text:
    old = '''\tmodelloader->UnloadUnreferencedModels();

\tg_TimeLastMemTest = 0;
'''
    new = '''\tmodelloader->UnloadUnreferencedModels();

#if defined(__EMSCRIPTEN__) && !defined(SWDS)
\t// Render360 iPhone memory policy: the old BSP/world and unreferenced models
\t// are already gone at this point. Release only materials whose reference
\t// counts say they are unused; keep shared UI/common assets that are still
\t// referenced so the next chamber does not pay for a global material reload.
\tif ( server && materials )
\t{
\t\tmaterials->UncacheUnusedMaterials( false );
\t\tMsg( "Render360 Phase 4: released unused level materials after old-world shutdown.\\n" );
\t}
#endif

\tg_TimeLastMemTest = 0;
'''
    if old not in text:
        raise SystemExit('Render360 Phase 4: Host_FreeStateAndWorld cleanup anchor moved')
    text = text.replace(old, new, 1)

for required in (
    marker,
    'materials->UncacheUnusedMaterials( false );',
    'modelloader->UnloadUnreferencedModels();',
):
    if required not in text:
        raise SystemExit(f'Render360 Phase 4: old-world material cleanup missing marker: {required}')

path.write_text(text)
print('Render360 Phase 4: added refcount-safe unused-material cleanup at level shutdown')
PY
