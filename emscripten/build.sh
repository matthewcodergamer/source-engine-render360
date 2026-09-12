#!/bin/sh

buildtype=release
if [ "$1" = "debug" ] || [ "$1" = "release" ]; then
	buildtype=$1
	shift
fi

export CC=emcc
export CXX=em++

# Phase 4 experimental memory profile. The branch defaults to a smaller shared
# heap than the Phase 3 baseline, while keeping an explicit maximum and linear
# growth policy. CI/workflow_dispatch can override these values for A/B testing.
RENDER360_EMSCRIPTEN_VERSION="${RENDER360_EMSCRIPTEN_VERSION:-6.0.6}"
RENDER360_INITIAL_MEMORY_MB="${RENDER360_INITIAL_MEMORY_MB:-320}"
RENDER360_MAXIMUM_MEMORY_MB="${RENDER360_MAXIMUM_MEMORY_MB:-1024}"
RENDER360_MEMORY_GROWTH_LINEAR_STEP_MB="${RENDER360_MEMORY_GROWTH_LINEAR_STEP_MB:-32}"
RENDER360_GROWABLE_ARRAYBUFFERS="${RENDER360_GROWABLE_ARRAYBUFFERS:-1}"

for value in \
	"$RENDER360_INITIAL_MEMORY_MB" \
	"$RENDER360_MAXIMUM_MEMORY_MB" \
	"$RENDER360_MEMORY_GROWTH_LINEAR_STEP_MB" \
	"$RENDER360_GROWABLE_ARRAYBUFFERS"
do
	case "$value" in
		''|*[!0-9]*) echo "Render360 Phase 4: memory profile values must be integers" >&2; exit 1 ;;
	esac
done
if [ "$RENDER360_INITIAL_MEMORY_MB" -gt "$RENDER360_MAXIMUM_MEMORY_MB" ]; then
	echo "Render360 Phase 4: INITIAL_MEMORY cannot exceed MAXIMUM_MEMORY" >&2
	exit 1
fi
if [ "$RENDER360_GROWABLE_ARRAYBUFFERS" -ne 1 ]; then
	echo "Render360 Phase 4: this branch requires GROWABLE_ARRAYBUFFERS=1" >&2
	exit 1
fi

set -ex

# Keep Source's upstream pthread/SharedArrayBuffer architecture intact, but stop
# the browser build from attempting to dlopen desktop-only optional modules.
python3 - <<'PY'
from pathlib import Path
import re

path = Path('tier1/interface.cpp')
text = path.read_text()
pattern = re.compile(
    r'(CSysModule \*Sys_LoadModule\( const char \*pModuleName, Sys_Flags flags /\* = SYS_NOFLAGS \(0\) \*/ \)\n\{\n\tHMODULE hDLL = NULL;\n\n)'
    r'#ifdef __EMSCRIPTEN__\n.*?\n#else\n',
    re.S,
)
replacement = r'''\1#ifdef __EMSCRIPTEN__
	const char *pBaseName = strrchr(pModuleName, '/');
	if(!pBaseName) pBaseName = strrchr(pModuleName, '\\');
	pBaseName = pBaseName ? pBaseName + 1 : pModuleName;

	char szBaseName[1024] = { 0 };
	Q_strncpy(szBaseName, pBaseName, sizeof(szBaseName));
	if(!string_endsWith(szBaseName, ".so")) {
		V_SetExtension(szBaseName, ".so", sizeof(szBaseName));
	}

	char szModuleName[1024] = { 0 };
	if(strncmp(szBaseName, "lib", 3) == 0) {
		Q_strncpy(szModuleName, szBaseName, sizeof(szModuleName));
	} else {
		Q_snprintf(szModuleName, sizeof(szModuleName), "lib%s", szBaseName);
	}

	static const char *s_pOptionalBrowserModules[] = {
		"libsourcevr.so",
		"libvideo_bink.so",
		"libvideo_webm.so",
		"libvideo_quicktime.so",
		"libstdshader_dbg.so",
		"libstdshader_dx6.so",
		"libstdshader_dx7.so",
		"libstdshader_dx8.so",
	};
	for(size_t i = 0; i < sizeof(s_pOptionalBrowserModules) / sizeof(s_pOptionalBrowserModules[0]); ++i) {
		if(Q_stricmp(szModuleName, s_pOptionalBrowserModules[i]) == 0) {
			Msg("Render360: optional browser module skipped: %s\n", szModuleName);
			return reinterpret_cast<CSysModule *>(hDLL);
		}
	}

	Msg("LoadLibrary: path: %s\n", szModuleName);
	hDLL = (HMODULE)dlopen(szModuleName, RTLD_NOW);
	if(!hDLL) {
		const char *pError = dlerror();
		Warning("Can't find module - %s%s%s\n", pModuleName,
			pError ? " · " : "", pError ? pError : "");
	} else {
		Msg("Render360: loaded module: %s\n", szModuleName);
	}
#else
'''
updated, count = pattern.subn(
    lambda match: replacement.replace(r'\1', match.group(1), 1),
    text,
    count=1,
)
if count != 1:
    raise SystemExit('Render360 Portal: could not locate Emscripten Sys_LoadModule block')
for marker in (
    'Render360: optional browser module skipped:',
    'Render360: loaded module:',
    'libsourcevr.so',
    'libvideo_bink.so',
    'libvideo_webm.so',
    'libstdshader_dbg.so',
    'libstdshader_dx8.so',
):
    if marker not in updated:
        raise SystemExit(f'Render360 Portal: loader patch missing {marker}')
if "strrchr(pModuleName, '\\\\');" not in updated:
    raise SystemExit('Render360 Portal: generated backslash basename check is malformed')
if 'Msg("Render360: optional browser module skipped: %s\\n", szModuleName);' not in updated:
    raise SystemExit('Render360 Portal: generated optional-module log newline is malformed')
if 'Msg("LoadLibrary: path: %s\\n", szModuleName);' not in updated:
    raise SystemExit('Render360 Portal: generated LoadLibrary log newline is malformed')
if 'Msg("Render360: loaded module: %s\\n", szModuleName);' not in updated:
    raise SystemExit('Render360 Portal: generated loaded-module log newline is malformed')
path.write_text(updated)
print('Render360 Portal: patched Sys_LoadModule optional browser-module handling')
PY

# Phase 4 transition masking hooks the real Source level state machine instead
# of guessing with timers in JavaScript. Host_Changelevel is synchronous: signal
# BEGIN immediately before it tears the old level down, and READY/FAILED as soon
# as it returns. The signal crosses the app pthread via BroadcastChannel and the
# browser main thread draws only a tiny CSS elevator-door mask; no old/new map or
# canvas snapshot is duplicated for the effect.
python3 - <<'PY'
from pathlib import Path

path = Path('engine/host_state.cpp')
text = path.read_text()

include_anchor = '#include "ccs.h"\n\n'
include_block = '''#include "ccs.h"

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#endif

'''
if '#include <emscripten.h>' not in text:
    if include_anchor not in text:
        raise SystemExit('Render360 Phase 4: host_state include anchor moved')
    text = text.replace(include_anchor, include_block, 1)

helper_anchor = 'static bool Host_ValidGame( void );\n'
helper = r'''#ifdef __EMSCRIPTEN__
static void Render360Phase4_TransitionSignal( const char *pKind, const char *pLevelName )
{
	EM_ASM({
		if ( typeof globalThis.render360Phase4TransitionSignal === 'function' )
		{
			globalThis.render360Phase4TransitionSignal( UTF8ToString($0), UTF8ToString($1) );
		}
	}, pKind ? pKind : "", pLevelName ? pLevelName : "" );
}
#else
static inline void Render360Phase4_TransitionSignal( const char *, const char * ) {}
#endif

static bool Host_ValidGame( void );
'''
if 'Render360Phase4_TransitionSignal' not in text:
    if helper_anchor not in text:
        raise SystemExit('Render360 Phase 4: Host_ValidGame anchor moved')
    text = text.replace(helper_anchor, helper, 1)

mp_old = '''\t\tif ( Host_Changelevel( false, m_levelName, m_landmarkName ) )
\t\t{
\t\t\tSetState( HS_RUN, true );
\t\t\treturn;
\t\t}
'''
mp_new = '''\t\tRender360Phase4_TransitionSignal( "begin", m_levelName );
\t\tconst bool bRender360Changed = Host_Changelevel( false, m_levelName, m_landmarkName );
\t\tRender360Phase4_TransitionSignal( bRender360Changed ? "ready" : "failed", m_levelName );
\t\tif ( bRender360Changed )
\t\t{
\t\t\tSetState( HS_RUN, true );
\t\t\treturn;
\t\t}
'''
if 'bRender360Changed = Host_Changelevel( false' not in text:
    if mp_old not in text:
        raise SystemExit('Render360 Phase 4: multiplayer Host_Changelevel block moved')
    text = text.replace(mp_old, mp_new, 1)

sp_old = '''\tif ( Host_ValidGame() )
\t{
\t\tHost_Changelevel( true, m_levelName, m_landmarkName );
\t\tSetState( HS_RUN, true );
\t\treturn;
\t}
'''
sp_new = '''\tif ( Host_ValidGame() )
\t{
\t\tRender360Phase4_TransitionSignal( "begin", m_levelName );
\t\tconst bool bRender360Changed = Host_Changelevel( true, m_levelName, m_landmarkName );
\t\tRender360Phase4_TransitionSignal( bRender360Changed ? "ready" : "failed", m_levelName );
\t\tSetState( HS_RUN, true );
\t\treturn;
\t}
'''
if 'bRender360Changed = Host_Changelevel( true' not in text:
    if sp_old not in text:
        raise SystemExit('Render360 Phase 4: single-player Host_Changelevel block moved')
    text = text.replace(sp_old, sp_new, 1)

for marker in (
    '#include <emscripten.h>',
    'Render360Phase4_TransitionSignal( "begin", m_levelName )',
    'bRender360Changed = Host_Changelevel( true',
    'bRender360Changed = Host_Changelevel( false',
    'render360Phase4TransitionSignal',
):
    if marker not in text:
        raise SystemExit(f'Render360 Phase 4: transition patch missing marker: {marker}')

path.write_text(text)
print('Render360 Phase 4: patched Source Host_Changelevel transition signals')
PY

python3 waf configure -T $buildtype --notests -4 --togles --emscripten \
	--disable-warns --build-games=portal --prefix=build/install
python3 waf install $@
find build/ -name '*.map' -exec cp {} build/install/ \;

python3 - <<'PY'
from pathlib import Path
mods = sorted(Path('build/install').glob('*.so'))
if not mods:
    raise SystemExit('Render360 Portal: no Emscripten SIDE_MODULE .so files were produced')
bad = []
for path in mods:
    with path.open('rb') as f:
        magic = f.read(4)
    if magic != b'\x00asm':
        bad.append((str(path), magic.hex()))
if bad:
    for path, magic in bad:
        print(f'NON-WASM SIDE_MODULE: {path} magic={magic}')
    raise SystemExit('Render360 Portal: native/non-Wasm .so entered build/install')
Path('build/install/render360-wasm-side-modules.txt').write_text(
    '\n'.join(path.name for path in mods) + '\n'
)
print(f'Render360 Portal: verified {len(mods)} WebAssembly SIDE_MODULEs')
PY

for required in \
	libfilesystem_stdio.so \
	libengine.so \
	libmaterialsystem.so \
	libshaderapidx9.so \
	libstdshader_dx9.so
do
	if [ ! -s "build/install/$required" ]; then
		echo "Render360 Portal: required Wasm module missing: $required" >&2
		exit 1
	fi
done

echo "Render360 Portal: required filesystem/engine/ToGL module set present"

preload_libs=""
for lib in build/install/*.so; do
	base=$(basename "$lib")
	preload_libs="$preload_libs --preload-file $lib@/$base"
done

mkdir -p build
cat > build/render360-phase4-config.js <<EOF
Module['render360Phase4BuildConfig'] = {
  emscripten: '$RENDER360_EMSCRIPTEN_VERSION',
  initialMemoryMiB: $RENDER360_INITIAL_MEMORY_MB,
  maximumMemoryMiB: $RENDER360_MAXIMUM_MEMORY_MB,
  linearGrowthMiB: $RENDER360_MEMORY_GROWTH_LINEAR_STEP_MB,
  growableArrayBuffers: $RENDER360_GROWABLE_ARRAYBUFFERS
};
EOF

# Phase 4 keeps Phase 3's direct-VPK/current-map-only architecture, but moves to
# a modern Emscripten runtime and explicitly enables growable Wasm memory views.
# GROWABLE_ARRAYBUFFERS=1 auto-detects resizable WebAssembly memory buffers and
# falls back on browsers that do not expose the API. This branch intentionally
# keeps pthreads/SharedArrayBuffer/PROXY_TO_PTHREAD so we can isolate the memory
# runtime change before attempting the Phase 5 single-thread fallback.
EMCC_FORCE_STDLIBS=libc,libc++,libc++abi emcc -Os \
	-sUSE_BZIP2=1 -sUSE_SDL=2 -sUSE_FREETYPE=1 -sUSE_LIBJPEG=1 -sUSE_LIBPNG -sMALLOC=dlmalloc \
	-sMAIN_MODULE -sINCLUDE_FULL_LIBRARY=1 \
	-sINITIAL_MEMORY=${RENDER360_INITIAL_MEMORY_MB}mb -sALLOW_MEMORY_GROWTH=1 \
	-sMAXIMUM_MEMORY=${RENDER360_MAXIMUM_MEMORY_MB}mb \
	-sMEMORY_GROWTH_LINEAR_STEP=${RENDER360_MEMORY_GROWTH_LINEAR_STEP_MB}mb \
	-sGROWABLE_ARRAYBUFFERS=${RENDER360_GROWABLE_ARRAYBUFFERS} \
	-sSHARED_MEMORY=1 -sUSE_PTHREADS -sPTHREAD_POOL_SIZE=2 -sPTHREAD_POOL_SIZE_STRICT=0 \
	-sFULL_ES3 -sSTACK_SIZE=4mb -sDEFAULT_PTHREAD_STACK_SIZE=1mb --shell-file=emscripten/shell.html \
	-sASSERTIONS=1 -sSTACK_OVERFLOW_CHECK=1 \
	-sPROXY_TO_PTHREAD -sOFFSCREENCANVASES_TO_PTHREAD="#canvas" -sOFFSCREENCANVAS_SUPPORT=1 \
	-lworkerfs.js \
	--pre-js build/render360-phase4-config.js \
	--pre-js emscripten/phase4-memory-profile.js \
	--pre-js emscripten/phase4-transition-mask.js \
	--pre-js emscripten/pre.js \
	--post-js emscripten/phase3-workerfs.js --post-js emscripten/post.js \
	$preload_libs \
	build/launcher_main/libhl2_launcher.a \
	-o build/launcher_main/hl2_launcher.html

cat > build/install/render360-phase4-profile.json <<EOF
{
  "profile": "phase4-growable-arraybuffers",
  "emscripten": "$RENDER360_EMSCRIPTEN_VERSION",
  "initialMemoryMiB": $RENDER360_INITIAL_MEMORY_MB,
  "maximumMemoryMiB": $RENDER360_MAXIMUM_MEMORY_MB,
  "linearGrowthMiB": $RENDER360_MEMORY_GROWTH_LINEAR_STEP_MB,
  "growableArrayBuffers": $RENDER360_GROWABLE_ARRAYBUFFERS,
  "pthreadPoolSize": 2,
  "directRetailVpk": true,
  "currentMapOnly": true,
  "transitionMask": "css-elevator-host-changelevel",
  "transitionMapPrefetch": false
}
EOF

# Record deploy sizes in CI so the 320 MiB and 256 MiB experiments can be
# compared against the 384 MiB Phase 3 baseline without guessing.
ls -lh build/launcher_main/hl2_launcher.wasm build/launcher_main/hl2_launcher.data || true
du -ch build/install/*.so | tail -n 1 || true
cat build/install/render360-phase4-profile.json

cp build/launcher_main/hl2_launcher.* build/install/
cp -r emscripten/assets build/install/
