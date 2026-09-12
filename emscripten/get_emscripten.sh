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

# Patch glMapBufferRange to allow the Source/ToGL parameter combinations used by
# this port. Fail clearly if the newer SDK moves the library implementation.
WEBGL_LIB=emsdk/upstream/emscripten/src/lib/libwebgl.js
if [ ! -f "$WEBGL_LIB" ]; then
	echo "Render360 Phase 4: Emscripten moved libwebgl.js; update libwebgl.patch target." >&2
	exit 1
fi
patch "$WEBGL_LIB" emscripten/libwebgl.patch
