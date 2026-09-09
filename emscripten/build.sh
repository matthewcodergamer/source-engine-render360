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
# On GitHub Pages a missing .so request can return a non-Wasm response and
# Emscripten then reports "need to see wasm magic number". Native Source treats
# these modules as optional already; fail them immediately in the Emscripten
# loader instead of doing a pointless network/dylink attempt.
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
	// Emscripten SIDE_MODULEs are linked into the runtime by basename. Normalize
	// absolute/relative Source module names to the linked lib*.so name first.
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

	// These are optional desktop/legacy modules. Native Source also continues
	// when they are absent. Do not let Safari fetch a 404/HTML body and hand it
	// to Emscripten's dynamic linker as though it were WebAssembly.
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
	}
#else
'''
updated, count = pattern.subn(replacement, text, count=1)
if count != 1:
    raise SystemExit('Render360 Portal: could not locate Emscripten Sys_LoadModule block')
for marker in (
    'Render360: optional browser module skipped:',
    'libsourcevr.so',
    'libvideo_bink.so',
    'libvideo_webm.so',
    'libstdshader_dbg.so',
    'libstdshader_dx8.so',
):
    if marker not in updated:
        raise SystemExit(f'Render360 Portal: loader patch missing {marker}')
path.write_text(updated)
print('Render360 Portal: patched Sys_LoadModule optional browser-module handling')
PY

#rm -rf build/install
python3 waf configure -T $buildtype --notests -4 --togles --emscripten \
	--disable-warns --build-games=portal --prefix=build/install
python3 waf install $@
find build/ -name '*.map' -exec cp {} build/install/ \;

# Emscripten dynamic linking expects SIDE_MODULEs to be WebAssembly modules even
# when they use a Unix-style .so suffix. Fail CI immediately if a native ELF,
# HTML error page, or other non-Wasm file ever enters the runtime module set.
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

#link_libs="-sERROR_ON_UNDEFINED_SYMBOLS=0"
for lib in build/install/*.so; do
	libname=$(echo $lib | sed -E 's/^.+\/lib(.+)\.so/\1/g')
	link_libs="$link_libs -l$libname"
done

emcc \
	-sUSE_BZIP2=1 -sUSE_SDL=2 -sUSE_FREETYPE=1 -sUSE_LIBJPEG=1 -sUSE_LIBPNG -sMALLOC=mimalloc \
	-sMAIN_MODULE -sINITIAL_MEMORY=2047mb -sSHARED_MEMORY=1 -sUSE_PTHREADS -sPTHREAD_POOL_SIZE=8 -sPTHREAD_POOL_SIZE_STRICT=2 \
	-sFULL_ES3 -sSTACK_SIZE=4mb --shell-file=emscripten/shell.html \
	-sASSERTIONS=2 -sSTACK_OVERFLOW_CHECK=2 --profiling-funcs \
	-sPROXY_TO_PTHREAD -sOFFSCREENCANVASES_TO_PTHREAD="#canvas" -sOFFSCREENCANVAS_SUPPORT=1 \
	--pre-js emscripten/pre.js --post-js emscripten/post.js \
	-L build/install/ \
	build/launcher_main/libhl2_launcher.a \
	$link_libs \
	-o build/launcher_main/hl2_launcher.html

cp build/launcher_main/hl2_launcher.* build/install/
cp -r emscripten/assets build/install/
