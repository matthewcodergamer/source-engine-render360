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
