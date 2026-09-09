# source-engine-render360

Emscripten port for the Source engine (Portal baseline), with an isolated iPhone Safari staging lane.

## Staging branch

`render360/iphone-baseline` preserves the upstream Source WebAssembly architecture while testing iPhone/WebKit compatibility before anything is merged back into the main Render360 project.

The staging build keeps:

- pthreads / SharedArrayBuffer
- `PROXY_TO_PTHREAD`
- OffscreenCanvas
- `MAIN_MODULE` / Emscripten SIDE_MODULEs
- ToGL / WebGL2
- Source's existing `chunks/<map>.data` loader contract

## Portal data

No retail Portal data is committed to this repository.

The staging page verifies a user-selected Portal installation locally. Runtime map data can then come from either:

1. locally generated chunks built from the selected Portal VPKs and kept in browser Cache Storage; or
2. the original upstream packed-data route when that host is accessible.

The local VPK path reads only the required archive ranges with `File.slice()` and repacks them into the same record format expected by the original Source DataLoader.

Native game binaries (`.dll`, `.so`, `.dylib`, `.exe`) are never copied from the retail game into generated browser chunks. Emscripten `.so` SIDE_MODULEs are produced by the WebAssembly build itself and CI verifies their `\0asm` magic before Pages deployment.

## iPhone browser compatibility hardening

The staging lane deliberately avoids changing the Source renderer architecture. Browser-specific fixes are limited to host/runtime boundaries:

- Safari fullscreen uses the browser canvas API directly and falls back to inline/standalone mode when element fullscreen is unavailable.
- Portal starts with `-novid` and `-nojoy` to avoid unsupported startup/video/controller paths.
- Desktop-only optional modules such as `sourcevr`, Bink/WebM video backends, and pre-DX9/debug shader modules are skipped before `dlopen()` on Emscripten, preventing Safari from feeding 404/HTML/native files into the Wasm dynamic linker.
- Required browser modules (`filesystem_stdio`, `engine`, `materialsystem`, `shaderapidx9`, `stdshader_dx9`) must exist and be valid WebAssembly before deployment.
- The build script validates the generated C++ optional-module patch before the full Source compile so escaping regressions fail immediately with a useful message.

## Merge gate

The staging PR remains draft until an actual iPhone run reaches a visible Portal frame, or the remaining failure has been reduced to a single reproducible WebKit/ToGL incompatibility.
