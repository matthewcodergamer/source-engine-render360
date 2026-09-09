// Keep packaged SIDE_MODULE bytes as ordinary MEMFS files. Source performs its
// own runtime dlopen() calls and must not race Emscripten's preload-file Wasm
// decoder on the same .so names.
Module['noWasmDecoding'] = true

// liblauncher.so is the first Source module opened from the PROXY_TO_PTHREAD
// application thread. On iOS the first runtime dlopen can re-enter through
// Emscripten's pthread task queue while that DSO is still marked "loading",
// producing: Attempt to load 'liblauncher.so' twice before the first load
// completed. Load this ONE root DSO before main() using Emscripten's supported
// MAIN_MODULE startup path. Source's later dlopen then reuses the completed DSO.
// All other Source SIDE_MODULEs remain demand-loaded by Source.
Module['dynamicLibraries'] = ['liblauncher.so']

Module['preRun'] = Module['preRun'] || []
Module['preRun'].push(() => {
	Module.print?.('[Render360] load-time liblauncher preload requested')
})

Module['arguments'] = Module['arguments'] || []
Module['arguments'].push(
	'-game', 'portal',
	'-noip',
	'-language', 'english',
	'-windowed',
	'-novid',
	'-nojoy',
	'+mat_hdr_level', '0',
	'+mat_colorcorrection', '1'
)

class DataLoader {
	mapsOrdered = [
		'background1',
		'testchmb_a_00',
		'testchmb_a_01',
		'testchmb_a_02',
		'testchmb_a_03',
		'testchmb_a_04',
		'testchmb_a_05',
		'testchmb_a_06',
		'testchmb_a_07',
		'testchmb_a_08',
		'testchmb_a_09',
		'testchmb_a_10',
		'testchmb_a_11',
		'testchmb_a_13',
		'testchmb_a_14',
		'testchmb_a_15'
	]

	loadedMaps = {}
	bootOverlayPromise = null

	async loadMapWithDeps(mapName) {
		const index = this.mapsOrdered.indexOf(mapName)
		if(index === -1) {
			throw new Error(`no such map: ${mapName}`)
		}

		// Load the ~50 MiB bootstrap/shader overlay to completion before starting
		// the ~220 MiB background XHR. The old order parsed background1 first and
		// then fetched the overlay while the background ArrayBuffer was still held
		// by the XHR callback. On iPhone Safari that creates a large avoidable peak
		// exactly while WebAssembly, pthread workers and SIDE_MODULEs are starting.
		await this.loadBootOverlay()

		// The packed Portal chunks are deltas: a later map depends on all earlier
		// chunks, so load only the required prefix here. Do not speculatively load
		// the next chamber. background1.data is already ~220 MiB and the first
		// chamber is another ~160 MiB; preloading both before the menu appears is
		// unnecessary memory pressure on iPhone Safari.
		for(let i = 0; i < index + 1; i++) {
			await this.loadMapCached(this.mapsOrdered[i])
		}
	}

	async loadMapCached(mapName) {
		if(mapName in this.loadedMaps) return this.loadedMaps[mapName]
		const promise = this.loadMap(mapName)
		this.loadedMaps[mapName] = promise
		return promise
	}

	async setProgress(mapName, progress) {
		if(progress < 1) {
			spinnerElement.style.display = ''
			statusElement.innerText = `Loading map data ${mapName}`
			progressElement.hidden = false
			progressElement.value = Number.isFinite(progress) ? progress : 0
		} else {
			spinnerElement.style.display = 'none'
			statusElement.innerText = ''
			progressElement.hidden = true
		}
	}

	installOwnedFile(path, blob) {
		const slash = path.lastIndexOf('/')
		const parent = slash > 0 ? path.slice(0, slash) : '/'
		const name = slash >= 0 ? path.slice(slash + 1) : path
		FS.mkdirTree(parent)

		// Boot-overlay files intentionally overlap a few background resources.
		// Replace an existing MEMFS node before installing the newer record.
		try { FS.unlink(path) } catch(_) {}

		// FS.writeFile() copies every record into a second allocation. During a
		// 220 MiB XHR that means Safari temporarily owns both the complete response
		// and another ~220 MiB of MEMFS copies. createDataFile(..., canOwn=true)
		// lets MEMFS keep views into the original ArrayBuffer instead, avoiding the
		// transient duplicate. Fall back only if a future Emscripten build removes
		// the legacy helper.
		if(typeof FS.createDataFile === 'function') {
			FS.createDataFile(parent, name, blob, true, true, true)
		} else {
			FS.writeFile(path, blob)
		}
	}

	writeDataBuffer(arrayBuffer, label) {
		if(!(arrayBuffer instanceof ArrayBuffer)) {
			throw new Error(`${label}: response is not binary data`)
		}

		const dv = new DataView(arrayBuffer)
		let offset = 0
		let fileCount = 0
		const decoder = new TextDecoder()

		// data format: { pathLen: uint32le, dataLen: uint32le, path: bytes, blob: bytes }[]
		while(offset < dv.byteLength) {
			if(dv.byteLength - offset < 8) {
				throw new Error(`${label}: truncated record header at ${offset}/${dv.byteLength}`)
			}
			const pathLen = dv.getUint32(offset, true)
			const dataLen = dv.getUint32(offset + 4, true)
			const recordEnd = offset + 8 + pathLen + dataLen
			if(pathLen === 0 || pathLen > 1024 * 1024 || recordEnd > dv.byteLength) {
				throw new Error(`${label}: record ${fileCount} exceeds buffer (${recordEnd}/${dv.byteLength})`)
			}

			const path = decoder.decode(new Uint8Array(dv.buffer, offset + 8, pathLen))
			const blob = new Uint8Array(dv.buffer, offset + 8 + pathLen, dataLen)
			offset = recordEnd
			fileCount++

			// Game-data chunks must never supply native executables/shared libraries.
			// Emscripten SIDE_MODULE .so files are built and shipped with the runtime,
			// not sourced from Portal retail/VPK data.
			if(/\.(?:dll|dylib|exe|so)$/i.test(path)) {
				Module.printErr?.(`[Render360] ignored native binary from game-data chunk: ${path}`)
				continue
			}

			this.installOwnedFile(path, blob)
		}

		return { fileCount, byteLength: dv.byteLength }
	}

	async loadBootOverlay() {
		if(this.bootOverlayPromise) return this.bootOverlayPromise

		this.bootOverlayPromise = (async () => {
			try {
				// Fetch the user-generated VPK bootstrap/shader overlay separately from
				// the large map chunk, and finish it first so their raw response buffers
				// never overlap during startup on iPhone Safari.
				const response = await fetch('render360-bootstrap-overlay.data', {
					cache: 'no-store',
					credentials: 'same-origin'
				})
				if(response.status === 404) {
					Module.print?.('[Render360] no local boot overlay present; continuing with base chunk')
					return
				}
				if(!response.ok) {
					throw new Error(`HTTP ${response.status}`)
				}
				const bytes = await response.arrayBuffer()
				const result = this.writeDataBuffer(bytes, 'boot overlay')
				Module.print?.(`[Render360] loaded boot overlay: ${result.fileCount} records, ${result.byteLength} bytes`)
			} catch(error) {
				// The base historical chunk may already contain enough files to boot, so
				// surface the overlay error but do not convert it into a fake map failure.
				Module.printErr?.(`[Render360] boot overlay load failed: ${error?.stack || error}`)
			}
		})()

		return this.bootOverlayPromise
	}

	async loadMap(mapName) {
		this.setProgress(mapName, 0)

		let resolve, reject
		const promise = new Promise((res, rej) => { resolve = res; reject = rej })

		const xhr = new XMLHttpRequest()
		xhr.responseType = 'arraybuffer'
		xhr.onprogress = e => {
			this.setProgress(mapName, e.lengthComputable && e.total > 0 ? e.loaded / e.total : 0)
		}

		xhr.onerror = () => {
			reject(new Error(`cannot load map ${mapName}: network error`))
		}

		xhr.onload = () => {
			try {
				if(xhr.status < 200 || xhr.status >= 300) {
					throw new Error(`cannot load map ${mapName}: HTTP ${xhr.status}`)
				}

				const result = this.writeDataBuffer(xhr.response, `${mapName}.data`)
				this.setProgress(mapName, 1)
				Module.print?.(`[Render360] loaded ${mapName}.data: ${result.fileCount} records, ${result.byteLength} bytes`)
				xhr.onprogress = null
				xhr.onerror = null
				xhr.onload = null
				resolve()
			} catch(error) {
				this.setProgress(mapName, 1)
				Module.printErr?.(`[Render360] ${error?.stack || error}`)
				xhr.onprogress = null
				xhr.onerror = null
				xhr.onload = null
				reject(error)
			}
		}
		xhr.open('GET', `chunks/${mapName}.data`, true)
		xhr.setRequestHeader('Cache-Control', 'no-cache')
		xhr.send()

		return promise
	}
}

const dataLoader = new DataLoader()

Module.downloadMap = (lock, mapName) => {
	dataLoader.loadMapWithDeps(mapName).then(() => {
		Atomics.store(HEAP32, lock, 0)
		Atomics.notify(HEAP32, lock)
	}).catch(error => {
		Module.printErr?.(`[Render360] map dependency load failed for ${mapName}: ${error?.stack || error}`)
		// Do not leave the Source pthread asleep forever. Wake it so the engine can
		// surface the real missing-map/file error in its own startup path.
		Atomics.store(HEAP32, lock, 0)
		Atomics.notify(HEAP32, lock)
	})
}
