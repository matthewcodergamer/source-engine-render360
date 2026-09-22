# Hosting the web build

## The one hard requirement: cross-origin isolation

The engine is linked with pthreads (`-sUSE_PTHREADS -sSHARED_MEMORY=1
-sPROXY_TO_PTHREAD`). Threads need `SharedArrayBuffer`, and browsers only hand
one out to a **cross-origin isolated** document. Two response headers make a
page isolated:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Serve the build without them and it never starts, on any browser. The shell now
detects this and says so on screen instead of leaving a black page.

Isolation also requires a **secure context**: `https://` or `http://localhost`.
A plain `http://192.168.1.x` address is not secure, so opening the dev server's
LAN address directly on a phone will never work no matter what headers you send.

### Local

```sh
python3 emscripten/serve.py --dir build/install
# http://localhost:8080/hl2_launcher.html
```

### Testing on a real iPhone

The phone needs HTTPS, so tunnel the local server:

```sh
python3 emscripten/serve.py --dir build/install &
cloudflared tunnel --url http://localhost:8080
# or: ssh -R 80:localhost:8080 nokey@localhost.run
```

Open the resulting `https://` URL on the phone.

### Netlify / Cloudflare Pages

Copy `emscripten/_headers` to the site root. `build.sh` already copies it into
`build/install/`.

### nginx

```nginx
location / {
    add_header Cross-Origin-Opener-Policy   same-origin   always;
    add_header Cross-Origin-Embedder-Policy require-corp  always;
    types { application/wasm wasm; }
}
```

### Apache

```apache
Header always set Cross-Origin-Opener-Policy   "same-origin"
Header always set Cross-Origin-Embedder-Policy "require-corp"
AddType application/wasm .wasm
```

### GitHub Pages

GitHub Pages cannot set custom headers, so it cannot host this build directly.

## Playing on iPhone / iPad

Requirements:

- **iOS 17 or newer.** The build renders from a worker through
  `OffscreenCanvas`, which Safari gained in 16.4, and relies on WebGL 2 and
  growable `SharedArrayBuffer`. iOS 17 is the first release where all of it is
  reliable.
- **Lockdown Mode off** (Settings > Privacy & Security). It disables the JIT and
  most of WebAssembly.
- **Landscape.** The touch layout puts the move zone on the left half and the
  look zone on the right half of the screen.

Controls come from the engine's built-in touch layer, which `pre.js` turns on
automatically when it sees a touch device:

| Action | Input |
| --- | --- |
| Move | drag on the left half of the screen |
| Look | drag on the right half |
| Fire portal / alt portal | the two on-screen buttons on the right |
| Jump, crouch, use | on-screen buttons on the right edge |
| Menu | on-screen button, top left |

The layout is editable in-game via the `edit` button, or with the `touch_*`
console variables (`touch_yaw`, `touch_pitch`, `touch_forwardzone`,
`touch_sidezone`, `touch_addbutton`, ...).

### Button icons

The move and look zones are invisible by design, and they work with no assets at
all. The labelled buttons want `materials/vgui/touch/*.vtf`, which ships with the
Android build of source-engine rather than with desktop Portal. Drop those files
into `<gamedata>/portal/materials/vgui/touch/` (or `hl2/`) before running
`repackage.js` and they are packed into the base chunk. Without them the buttons
are still there and still work, they just draw with the missing-material texture.
The textures must be square and power-of-two.

### Fullscreen on iPhone

iPhone Safari does not implement `Element.requestFullscreen`, so no web page can
go fullscreen in the browser. To get a chrome-free game, use **Share > Add to
Home Screen** and launch it from the Home Screen icon; the shell ships the
`apple-mobile-web-app-capable` meta tag that makes that a standalone app window.
iPad Safari does support fullscreen, and the Fullscreen button works there.

### Memory

Memory is the tightest constraint on a phone. The build starts at 512 MB and
grows (`EM_INITIAL_MEMORY` / `EM_MAXIMUM_MEMORY` in `build.sh`), and `pre.js`
passes `+mat_picmip 2` plus a resolution capped to a 1280x720 pixel budget on
touch devices. If the game still aborts partway through a chapter, lower
`EM_MAXIMUM_MEMORY` and raise `mat_picmip`, and close other Safari tabs --
iOS kills the tab well before a desktop browser would.
