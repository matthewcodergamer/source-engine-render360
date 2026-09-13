#!/usr/bin/env python3
from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise SystemExit(f"Render360 startup diagnostics: anchor moved: {label}")
    return text.replace(old, new, 1)


# launcher.cpp has already received the narrow Emscripten startup patch from
# get_emscripten.sh by the time build.sh runs. Upgrade the outer Steam-only
# checkpoint so it exposes the nested CSourceAppSystemGroup stage as well.
launcher_path = Path("launcher/launcher.cpp")
launcher = launcher_path.read_text()
launcher_marker = "Render360 nested startup diagnostics: Steam + Source stages"
if launcher_marker not in launcher:
    old = '''#ifdef __EMSCRIPTEN__
\t\tWarning( "[Render360 startup] steam-run-return:%d stage:%d\\n", nRetval, (int)steamApplication.GetErrorStage() );
#endif
'''
    new = '''#ifdef __EMSCRIPTEN__
\t\t// Render360 nested startup diagnostics: Steam + Source stages. The outer
\t\t// CSteamApplication can report NONE while Main() simply returns a failure
\t\t// from the child CSourceAppSystemGroup, so always log both layers.
\t\tWarning( "[Render360 startup] steam-return:%d steam-stage:%d source-stage:%d\\n",
\t\t\tnRetval,
\t\t\t(int)steamApplication.GetErrorStage(),
\t\t\t(int)sourceSystems.GetErrorStage() );
#endif
'''
    launcher = replace_once(launcher, old, new, "launcher Steam return checkpoint")

for required in (
    launcher_marker,
    "steam-stage:%d source-stage:%d",
    "sourceSystems.GetErrorStage()",
):
    if required not in launcher:
        raise SystemExit(f"Render360 startup diagnostics: launcher marker missing: {required}")
launcher_path.write_text(launcher)


# Instrument the next nested boundary. CEngineAPI::RunListenServer() starts with
# RUN_OK and then takes its result directly from CModAppSystemGroup::Run(). That
# group is therefore the first place to inspect when Source returns -1 while the
# outer Steam/Source wrappers themselves report NONE.
engine_path = Path("engine/sys_dll2.cpp")
engine = engine_path.read_text()
engine_marker = "Render360 nested startup diagnostics: mod app-system group"
if engine_marker not in engine:
    create_anchor = '''bool CModAppSystemGroup::Create()
{
#ifndef SWDS
\tif ( !IsServerOnly() )
{
\t\tif ( !ClientDLL_Load() )
\treturn false;
}
#endif 

\tif ( !ServerDLL_Load( IsServerOnly() ) )
\t\treturn false;
'''
    create_replacement = '''bool CModAppSystemGroup::Create()
{
#ifdef __EMSCRIPTEN__
\t// Render360 nested startup diagnostics: mod app-system group.
\tMsg( "[Render360 startup] mod-create-start:serverOnly=%d\\n", IsServerOnly() ? 1 : 0 );
#endif
#ifndef SWDS
\tif ( !IsServerOnly() )
\t{
#ifdef __EMSCRIPTEN__
\t\tMsg( "[Render360 startup] mod-create-client-load-enter\\n" );
#endif
\t\tif ( !ClientDLL_Load() )
\t\t{
#ifdef __EMSCRIPTEN__
\t\t\tWarning( "[Render360 startup] mod-create-fail:ClientDLL_Load\\n" );
#endif
\t\t\treturn false;
\t\t}
#ifdef __EMSCRIPTEN__
\t\tMsg( "[Render360 startup] mod-create-client-load-ready\\n" );
#endif
\t}
#endif

#ifdef __EMSCRIPTEN__
\tMsg( "[Render360 startup] mod-create-server-load-enter\\n" );
#endif
\tif ( !ServerDLL_Load( IsServerOnly() ) )
\t{
#ifdef __EMSCRIPTEN__
\t\tWarning( "[Render360 startup] mod-create-fail:ServerDLL_Load\\n" );
#endif
\t\treturn false;
\t}
#ifdef __EMSCRIPTEN__
\tMsg( "[Render360 startup] mod-create-server-load-ready\\n" );
#endif
'''
    engine = replace_once(engine, create_anchor, create_replacement, "CModAppSystemGroup::Create entry")

    client_shared_old = '''\t\tclientSharedSystems = ( IClientDLLSharedAppSystems * )g_ClientFactory( CLIENT_DLL_SHARED_APPSYSTEMS, NULL );
\t\tif ( !clientSharedSystems )
\t\t\treturn AddLegacySystems();
'''
    client_shared_new = '''\t\tclientSharedSystems = ( IClientDLLSharedAppSystems * )g_ClientFactory( CLIENT_DLL_SHARED_APPSYSTEMS, NULL );
\t\tif ( !clientSharedSystems )
\t\t{
#ifdef __EMSCRIPTEN__
\t\t\tMsg( "[Render360 startup] mod-create-client-shared-missing:legacy-fallback\\n" );
#endif
\t\t\treturn AddLegacySystems();
\t\t}
#ifdef __EMSCRIPTEN__
\t\tMsg( "[Render360 startup] mod-create-client-shared-ready\\n" );
#endif
'''
    engine = replace_once(engine, client_shared_old, client_shared_new, "client shared app systems")

    server_shared_old = '''\t\tIServerDLLSharedAppSystems *serverSharedSystems = ( IServerDLLSharedAppSystems * )g_ServerFactory( SERVER_DLL_SHARED_APPSYSTEMS, NULL );
\t\tif ( !serverSharedSystems )
\t\t{
\t\t\tAssert( !"Expected both game and client .dlls to have or not have shared app systems interfaces!!!" );
\t\t\treturn AddLegacySystems();
\t\t}
'''
    server_shared_new = '''\t\tIServerDLLSharedAppSystems *serverSharedSystems = ( IServerDLLSharedAppSystems * )g_ServerFactory( SERVER_DLL_SHARED_APPSYSTEMS, NULL );
\t\tif ( !serverSharedSystems )
\t\t{
#ifdef __EMSCRIPTEN__
\t\t\tWarning( "[Render360 startup] mod-create-server-shared-missing:legacy-fallback\\n" );
#endif
\t\t\tAssert( !"Expected both game and client .dlls to have or not have shared app systems interfaces!!!" );
\t\t\treturn AddLegacySystems();
\t\t}
#ifdef __EMSCRIPTEN__
\t\tMsg( "[Render360 startup] mod-create-server-shared-ready\\n" );
#endif
'''
    engine = replace_once(engine, server_shared_old, server_shared_new, "server shared app systems")

    addsystems_old = '''\tif ( !AddSystems( systems.Base() ) ) 
\t\treturn false;
'''
    addsystems_new = '''\tif ( !AddSystems( systems.Base() ) )
\t{
#ifdef __EMSCRIPTEN__
\t\tWarning( "[Render360 startup] mod-create-fail:AddSystems\\n" );
#endif
\t\treturn false;
\t}
#ifdef __EMSCRIPTEN__
\tMsg( "[Render360 startup] mod-create-appsystems-ready\\n" );
#endif
'''
    engine = replace_once(engine, addsystems_old, addsystems_new, "mod AddSystems")

    tool_old = '''\t\tif ( !AddSystem( toolFrameworkModule, VTOOLFRAMEWORK_INTERFACE_VERSION ) )
\t\t\treturn false;
\t}
#endif

\treturn true;
}
'''
    tool_new = '''\t\tif ( !AddSystem( toolFrameworkModule, VTOOLFRAMEWORK_INTERFACE_VERSION ) )
\t\t{
#ifdef __EMSCRIPTEN__
\t\t\tWarning( "[Render360 startup] mod-create-fail:toolframework\\n" );
#endif
\t\t\treturn false;
\t\t}
\t}
#endif
#ifdef __EMSCRIPTEN__
\tMsg( "[Render360 startup] mod-create-ready\\n" );
#endif

\treturn true;
}
'''
    engine = replace_once(engine, tool_old, tool_new, "tool framework / Create ready")

    modinit_anchor = '''\t// Innocent until proven guilty
\tint nRunResult = RUN_OK;

\t// Happens every time we start up and shut down a mod
\tif ( ModInit( m_StartupInfo.m_pInitialMod, m_StartupInfo.m_pInitialGame ) )
\t{
'''
    modinit_replacement = '''\t// Innocent until proven guilty
\tint nRunResult = RUN_OK;

#ifdef __EMSCRIPTEN__
\tMsg( "[Render360 startup] mod-init-enter:mod=%s game=%s\\n",
\t\tm_StartupInfo.m_pInitialMod ? m_StartupInfo.m_pInitialMod : "<null>",
\t\tm_StartupInfo.m_pInitialGame ? m_StartupInfo.m_pInitialGame : "<null>" );
#endif

\t// Happens every time we start up and shut down a mod
\tif ( ModInit( m_StartupInfo.m_pInitialMod, m_StartupInfo.m_pInitialGame ) )
\t{
#ifdef __EMSCRIPTEN__
\t\tMsg( "[Render360 startup] mod-init-ready\\n" );
#endif
'''
    engine = replace_once(engine, modinit_anchor, modinit_replacement, "RunListenServer ModInit")

    modrun_old = '''\t\tnRunResult = modAppSystemGroup.Run();

\t\tg_AppSystemFactory = NULL;
'''
    modrun_new = '''#ifdef __EMSCRIPTEN__
\t\tMsg( "[Render360 startup] mod-group-run-enter\\n" );
#endif
\t\tnRunResult = modAppSystemGroup.Run();
#ifdef __EMSCRIPTEN__
\t\tWarning( "[Render360 startup] mod-return:%d mod-stage:%d\\n",
\t\t\tnRunResult, (int)modAppSystemGroup.GetErrorStage() );
#endif

\t\tg_AppSystemFactory = NULL;
'''
    engine = replace_once(engine, modrun_old, modrun_new, "mod app-system Run return")

for required in (
    engine_marker,
    "mod-create-fail:ClientDLL_Load",
    "mod-create-fail:ServerDLL_Load",
    "mod-create-fail:AddSystems",
    "mod-create-fail:toolframework",
    "mod-group-run-enter",
    "mod-return:%d mod-stage:%d",
    "modAppSystemGroup.GetErrorStage()",
):
    if required not in engine:
        raise SystemExit(f"Render360 startup diagnostics: engine marker missing: {required}")
engine_path.write_text(engine)

print("Render360: installed nested Source app-system startup diagnostics")
