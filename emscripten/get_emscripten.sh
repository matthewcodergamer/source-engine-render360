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

# Keep the Phase 4 runtime on the same deterministic browser root as the Phase
# 3 deployment. launcher.cpp cannot infer a native executable directory in
# WebAssembly, so explicitly repair the fallback and add exact startup markers.
python3 - <<'PY'
from pathlib import Path

path = Path('launcher/launcher.cpp')
text = path.read_text()
marker = 'Render360 startup: deterministic WebAssembly base directory'
if marker not in text:
    base_anchor = '''\tif ( IsPC() )
\t{
\t\tchar const *pOverrideDir = CommandLine()->CheckParm( "-basedir" );
\t\tif ( pOverrideDir )
\t\t{
\t\t\tstrcpy( g_szBasedir, pOverrideDir );
\t\t}
\t}

#ifdef WIN32
'''
    base_replacement = '''\tif ( IsPC() )
\t{
\t\tchar const *pOverrideDir = CommandLine()->CheckParm( "-basedir" );
\t\tif ( pOverrideDir )
\t\t{
\t\t\tstrcpy( g_szBasedir, pOverrideDir );
\t\t}
\t}

#ifdef __EMSCRIPTEN__
\t// Render360 startup: deterministic WebAssembly base directory.
\tif ( !g_szBasedir[0] )
\t{
\t\tQ_strncpy( g_szBasedir, "/", sizeof( g_szBasedir ) );
\t\tMsg( "[Render360 startup] basedir-fallback:/\\n" );
\t}
#endif

#ifdef WIN32
'''
    if base_anchor not in text:
        raise SystemExit('Render360 Phase 4 startup: UTIL_ComputeBaseDir anchor moved')
    text = text.replace(base_anchor, base_replacement, 1)

    create_anchor = '''bool CSourceAppSystemGroup::Create()
{
\tIFileSystem *pFileSystem = (IFileSystem*)FindSystem( FILESYSTEM_INTERFACE_VERSION );
'''
    create_replacement = '''bool CSourceAppSystemGroup::Create()
{
#ifdef __EMSCRIPTEN__
\tMsg( "[Render360 startup] create-start\\n" );
#endif
\tIFileSystem *pFileSystem = (IFileSystem*)FindSystem( FILESYSTEM_INTERFACE_VERSION );
'''
    if create_anchor not in text:
        raise SystemExit('Render360 Phase 4 startup: Create anchor moved')
    text = text.replace(create_anchor, create_replacement, 1)

    addsystems_old = '''\tif ( !AddSystems( appSystems ) ) 
\t\treturn false;
'''
    addsystems_new = '''\tif ( !AddSystems( appSystems ) )
\t{
#ifdef __EMSCRIPTEN__
\t\tWarning( "[Render360 startup] create-fail:AddSystems\\n" );
#endif
\t\treturn false;
\t}
'''
    if addsystems_old not in text:
        raise SystemExit('Render360 Phase 4 startup: AddSystems anchor moved')
    text = text.replace(addsystems_old, addsystems_new, 1)

    shader_anchor = '''\tpMaterialSystem->SetShaderAPI( pDLLName );

\tdouble elapsed = Plat_FloatTime() - st;
'''
    shader_replacement = '''\tpMaterialSystem->SetShaderAPI( pDLLName );
#ifdef __EMSCRIPTEN__
\tMsg( "[Render360 startup] create-ready:shaderapi=%s\\n", pDLLName );
#endif

\tdouble elapsed = Plat_FloatTime() - st;
'''
    if shader_anchor not in text:
        raise SystemExit('Render360 Phase 4 startup: shader API anchor moved')
    text = text.replace(shader_anchor, shader_replacement, 1)

    preinit_anchor = '''bool CSourceAppSystemGroup::PreInit()
{
\tif ( !CommandLine()->FindParm( "-nolog" ) )
'''
    preinit_replacement = '''bool CSourceAppSystemGroup::PreInit()
{
#ifdef __EMSCRIPTEN__
\tMsg( "[Render360 startup] preinit-start:basedir=%s game=%s\\n", GetBaseDirectory(), DetermineDefaultMod() );
#endif
\tif ( !CommandLine()->FindParm( "-nolog" ) )
'''
    if preinit_anchor not in text:
        raise SystemExit('Render360 Phase 4 startup: PreInit anchor moved')
    text = text.replace(preinit_anchor, preinit_replacement, 1)

    interfaces_old = '''\tif ( !g_pFullFileSystem || !g_pMaterialSystem )
\t\treturn false;
'''
    interfaces_new = '''\tif ( !g_pFullFileSystem || !g_pMaterialSystem )
\t{
#ifdef __EMSCRIPTEN__
\t\tWarning( "[Render360 startup] preinit-fail:missing-filesystem-or-materialsystem\\n" );
#endif
\t\treturn false;
\t}
'''
    if interfaces_old not in text:
        raise SystemExit('Render360 Phase 4 startup: interface guard moved')
    text = text.replace(interfaces_old, interfaces_new, 1)

    env_old = '''\tif ( FileSystem_SetupSteamEnvironment( steamInfo ) != FS_OK )
\t\treturn false;
'''
    env_new = '''\tif ( FileSystem_SetupSteamEnvironment( steamInfo ) != FS_OK )
\t{
#ifdef __EMSCRIPTEN__
\t\tWarning( "[Render360 startup] preinit-fail:steam-environment:%s\\n", FileSystem_GetLastErrorString() );
#endif
\t\treturn false;
\t}
#ifdef __EMSCRIPTEN__
\tMsg( "[Render360 startup] gameinfo-ready:%s\\n", steamInfo.m_GameInfoPath );
#endif
'''
    if env_old not in text:
        raise SystemExit('Render360 Phase 4 startup: Steam environment anchor moved')
    text = text.replace(env_old, env_new, 1)

    mount_old = '''\tif ( FileSystem_MountContent( fsInfo ) != FS_OK )
\t\treturn false;
'''
    mount_new = '''\tif ( FileSystem_MountContent( fsInfo ) != FS_OK )
\t{
#ifdef __EMSCRIPTEN__
\t\tWarning( "[Render360 startup] preinit-fail:mount-content:%s\\n", FileSystem_GetLastErrorString() );
#endif
\t\treturn false;
\t}
#ifdef __EMSCRIPTEN__
\tMsg( "[Render360 startup] filesystem-mounted\\n" );
#endif
'''
    if mount_old not in text:
        raise SystemExit('Render360 Phase 4 startup: MountContent anchor moved')
    text = text.replace(mount_old, mount_new, 1)

    startupinfo_anchor = '''\tg_pEngineAPI->SetStartupInfo( info );

\treturn true;
}

int CSourceAppSystemGroup::Main()
{
\treturn g_pEngineAPI->Run();
}
'''
    startupinfo_replacement = '''\tg_pEngineAPI->SetStartupInfo( info );
#ifdef __EMSCRIPTEN__
\tMsg( "[Render360 startup] preinit-ready\\n" );
#endif

\treturn true;
}

int CSourceAppSystemGroup::Main()
{
#ifdef __EMSCRIPTEN__
\tMsg( "[Render360 startup] engine-run-enter\\n" );
#endif
\tconst int nRender360Result = g_pEngineAPI->Run();
#ifdef __EMSCRIPTEN__
\tWarning( "[Render360 startup] engine-run-return:%d\\n", nRender360Result );
#endif
\treturn nRender360Result;
}
'''
    if startupinfo_anchor not in text:
        raise SystemExit('Render360 Phase 4 startup: StartupInfo/Main anchor moved')
    text = text.replace(startupinfo_anchor, startupinfo_replacement, 1)

    run_anchor = '''\t\tCSourceAppSystemGroup sourceSystems;
\t\tCSteamApplication steamApplication( &sourceSystems );
\t\tint nRetval = steamApplication.Run();
'''
    run_replacement = '''\t\tCSourceAppSystemGroup sourceSystems;
\t\tCSteamApplication steamApplication( &sourceSystems );
\t\tint nRetval = steamApplication.Run();
#ifdef __EMSCRIPTEN__
\t\tWarning( "[Render360 startup] steam-run-return:%d stage:%d\\n", nRetval, (int)steamApplication.GetErrorStage() );
#endif
'''
    if run_anchor not in text:
        raise SystemExit('Render360 Phase 4 startup: SteamApplication anchor moved')
    text = text.replace(run_anchor, run_replacement, 1)

for required in (
    marker,
    '[Render360 startup] create-start',
    '[Render360 startup] preinit-start',
    '[Render360 startup] gameinfo-ready:',
    '[Render360 startup] filesystem-mounted',
    '[Render360 startup] engine-run-enter',
    '[Render360 startup] engine-run-return:',
    '[Render360 startup] steam-run-return:',
):
    if required not in text:
        raise SystemExit(f'Render360 Phase 4 startup patch missing marker: {required}')
path.write_text(text)
print('Render360 Phase 4: hardened and instrumented Source WebAssembly startup')
PY

# The mobile runtime wrapper is already tracked in this branch. Keep Phase 4's
# build script change minimal and idempotent so the 320/256 MiB profile uses the
# same explicit -basedir and fullscreen fallback as the deployed Phase 3 path.
python3 - <<'PY'
from pathlib import Path
path = Path('emscripten/build.sh')
text = path.read_text()
marker = '--pre-js emscripten/phase3-mobile-runtime.js'
if marker not in text:
    old = '''\t--pre-js emscripten/pre.js \\
\t--post-js emscripten/phase3-workerfs.js --post-js emscripten/post.js \\
'''
    new = '''\t--pre-js emscripten/pre.js \\
\t--pre-js emscripten/phase3-mobile-runtime.js \\
\t--post-js emscripten/phase3-workerfs.js --post-js emscripten/post.js \\
'''
    if old not in text:
        raise SystemExit('Render360 Phase 4: build pre-js anchor moved')
    text = text.replace(old, new, 1)
if marker not in text:
    raise SystemExit('Render360 Phase 4: mobile runtime wrapper was not wired')
path.write_text(text)
print('Render360 Phase 4: wired mobile startup/fullscreen pre-js')
PY
