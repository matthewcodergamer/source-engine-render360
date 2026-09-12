#!/bin/sh

buildtype=release
if [ "$1" = "debug" ] || [ "$1" = "release" ]; then
	buildtype=$1
	shift
fi

export CC=emcc
export CXX=em++

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

# iPhone Safari has a relatively tight WebContent process budget. At startup
# Portal simultaneously holds the shared Wasm heap, Wasm SIDE_MODULE bytes/JIT
# code, pthread stacks and WebGL resources. Phase 3 removes the retail map/VPK
# payload from MEMFS: the staging page keeps the user's File objects alive and
# forwards them to the Source pthread where WORKERFS exposes them read-only.
# Source then opens the retail VPKs and performs its own range reads on demand.
# WORKERFS is not part of the default JS filesystem, so link it explicitly.
EMCC_FORCE_STDLIBS=libc,libc++,libc++abi emcc -Os \
	-sUSE_BZIP2=1 -sUSE_SDL=2 -sUSE_FREETYPE=1 -sUSE_LIBJPEG=1 -sUSE_LIBPNG -sMALLOC=dlmalloc \
	-sMAIN_MODULE -sINCLUDE_FULL_LIBRARY=1 \
	-sINITIAL_MEMORY=384mb -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=1024mb -sMEMORY_GROWTH_LINEAR_STEP=32mb \
	-sSHARED_MEMORY=1 -sUSE_PTHREADS -sPTHREAD_POOL_SIZE=2 -sPTHREAD_POOL_SIZE_STRICT=0 \
	-sFULL_ES3 -sSTACK_SIZE=4mb -sDEFAULT_PTHREAD_STACK_SIZE=1mb --shell-file=emscripten/shell.html \
	-sASSERTIONS=1 -sSTACK_OVERFLOW_CHECK=1 \
	-sPROXY_TO_PTHREAD -sOFFSCREENCANVASES_TO_PTHREAD="#canvas" -sOFFSCREENCANVAS_SUPPORT=1 \
	-lworkerfs.js \
	--pre-js emscripten/pre.js \
	--post-js emscripten/phase3-workerfs.js --post-js emscripten/post.js \
	$preload_libs \
	build/launcher_main/libhl2_launcher.a \
	-o build/launcher_main/hl2_launcher.html

# Record deploy sizes in CI so future regressions that grow the threaded Wasm
# or SIDE_MODULE package are visible before they become another iPhone reload.
ls -lh build/launcher_main/hl2_launcher.wasm build/launcher_main/hl2_launcher.data || true
du -ch build/install/*.so | tail -n 1 || true

cp build/launcher_main/hl2_launcher.* build/install/
cp -r emscripten/assets build/install/
