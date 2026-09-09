#!/bin/sh

buildtype=release
if [ "$1" = "debug" ] || [ "$1" = "release" ]; then
	buildtype=$1
	shift
fi

export CC=emcc
export CXX=em++

set -ex

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
