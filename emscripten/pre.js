// Emscripten's preload-file Wasm plugin normally recognizes every *.so in
// hl2_launcher.data and instantiates it before main(). Source does its own
// runtime dlopen() from the launcher pthread, so that eager preload races the
// first real dlopen and can leave LDSO.loadedLibsByName[name] === "loading"
// while thread synchronization re-enters the same library. On iOS Safari that
// aborts with "Attempt to load 'liblauncher.so' twice before the first load
// completed". Disable only the preload Wasm decoder so *.so bytes are created
// as ordinary MEMFS files; Emscripten's normal dlopen loader will instantiate
// each SIDE_MODULE once, on demand, exactly when Source asks for it.
Module['noWasmDecoding'] = true

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

	async loadMapWithDeps(mapName) {
		const index = this.mapsOrdered.indexOf(mapName)
		if(index === -1) {
			throw new Error(`no such map: ${mapName}`)
		}

		// The packed Portal chunks are deltas: a later map depends on all earlier
		// chunks, so load only the required prefix here. Do not speculatively load
		// the next chamber. background1.data is already ~220 MiB and the first
		// chamber is another ~160 MiB; preloading both before the menu appears is
		// unnecessary memory pressure on iPhone Safari and can push WebKit into an
		// abort/termination path while Source is still creating materials.
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
				if(!(xhr.response instanceof ArrayBuffer)) {
					throw new Error(`cannot load map ${mapName}: response is not binary data`)
				}

				const dv = new DataView(xhr.response)
				let offset = 0
				let fileCount = 0

				// data format: { pathLen: uint32le, dataLen: uint32le, path: bytes, blob: bytes }[]
				while(offset < dv.byteLength) {
					if(dv.byteLength - offset < 8) {
						throw new Error(`corrupt ${mapName}.data: truncated record header at ${offset}/${dv.byteLength}`)
					}
					const pathLen = dv.getUint32(offset, true)
					const dataLen = dv.getUint32(offset + 4, true)
					const recordEnd = offset + 8 + pathLen + dataLen
					if(pathLen === 0 || pathLen > 1024 * 1024 || recordEnd > dv.byteLength) {
						throw new Error(`corrupt ${mapName}.data: record ${fileCount} exceeds buffer (${recordEnd}/${dv.byteLength})`)
					}

					const path = new TextDecoder().decode(new Uint8Array(dv.buffer, offset + 8, pathLen))
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

					const dir = path.replace(/\/[^\/]+$/, '')
					FS.mkdirTree(dir)
					FS.writeFile(path, blob)
				}

				this.setProgress(mapName, 1)
				Module.print?.(`[Render360] loaded ${mapName}.data: ${fileCount} records, ${dv.byteLength} bytes`)
				// Drop event callbacks immediately after the ArrayBuffer has been copied
				// into MEMFS so WebKit can reclaim the large XHR backing store sooner.
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
