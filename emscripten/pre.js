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
		if(index === -1) throw new Error(`no such map: ${mapName}`)

		// Finish the bootstrap/shader overlay before the large background chunk.
		// Both are streamed record-by-record below, so Safari never needs a 51 MiB
		// overlay ArrayBuffer or a 221 MiB background ArrayBuffer at once.
		await this.loadBootOverlay()

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
		if(/\.(?:dll|dylib|exe|so)$/i.test(path)) {
			Module.printErr?.(`[Render360] ignored native binary from game-data chunk: ${path}`)
			return
		}

		const slash = path.lastIndexOf('/')
		const parent = slash > 0 ? path.slice(0, slash) : '/'
		const name = slash >= 0 ? path.slice(slash + 1) : path
		FS.mkdirTree(parent)
		try { FS.unlink(path) } catch(_) {}

		// In streaming mode each blob is an independent allocation for one file,
		// so canOwn=true no longer pins the complete 221 MiB HTTP response behind
		// thousands of tiny Uint8Array views.
		if(typeof FS.createDataFile === 'function') {
			FS.createDataFile(parent, name, blob, true, true, true)
		} else {
			FS.writeFile(path, blob)
		}
	}

	writeDataBuffer(arrayBuffer, label) {
		if(!(arrayBuffer instanceof ArrayBuffer)) throw new Error(`${label}: response is not binary data`)
		const dv = new DataView(arrayBuffer)
		const decoder = new TextDecoder()
		let offset = 0
		let fileCount = 0
		while(offset < dv.byteLength) {
			if(dv.byteLength - offset < 8) throw new Error(`${label}: truncated record header at ${offset}/${dv.byteLength}`)
			const pathLen = dv.getUint32(offset, true)
			const dataLen = dv.getUint32(offset + 4, true)
			const recordEnd = offset + 8 + pathLen + dataLen
			if(pathLen === 0 || pathLen > 1024 * 1024 || dataLen > 512 * 1024 * 1024 || recordEnd > dv.byteLength) {
				throw new Error(`${label}: record ${fileCount} exceeds buffer (${recordEnd}/${dv.byteLength})`)
			}
			const path = decoder.decode(new Uint8Array(dv.buffer, offset + 8, pathLen))
			// Copy one record in fallback mode so MEMFS does not retain the complete
			// fallback ArrayBuffer just because one file view is still alive.
			const blob = new Uint8Array(dataLen)
			blob.set(new Uint8Array(dv.buffer, offset + 8 + pathLen, dataLen))
			offset = recordEnd
			fileCount++
			this.installOwnedFile(path, blob)
		}
		return { fileCount, byteLength: dv.byteLength }
	}

	async streamDataResponse(response, label, onProgress) {
		// Safari 26 supports ReadableStream response bodies. Keep the old whole-
		// buffer parser only as a compatibility fallback; the normal iPhone path
		// consumes exactly one packed record at a time.
		if(!response.body || typeof response.body.getReader !== 'function') {
			Module.printErr?.(`[Render360] ${label}: streaming unavailable, using bounded fallback parser`)
			return this.writeDataBuffer(await response.arrayBuffer(), label)
		}

		const reader = response.body.getReader()
		const decoder = new TextDecoder()
		const totalLength = Number(response.headers.get('Content-Length') || 0)
		let chunk = new Uint8Array(0)
		let chunkOffset = 0
		let consumed = 0
		let fileCount = 0

		const report = () => {
			if(onProgress && totalLength > 0) onProgress(Math.min(0.999, consumed / totalLength))
		}

		const readExactly = async (length, allowCleanEof = false) => {
			if(length === 0) return new Uint8Array(0)
			const out = new Uint8Array(length)
			let written = 0
			while(written < length) {
				if(chunkOffset >= chunk.length) {
					const next = await reader.read()
					if(next.done) {
						if(allowCleanEof && written === 0) return null
						throw new Error(`${label}: truncated stream after ${consumed} bytes`)
					}
					chunk = next.value || new Uint8Array(0)
					chunkOffset = 0
					if(chunk.length === 0) continue
				}
				const take = Math.min(length - written, chunk.length - chunkOffset)
				out.set(chunk.subarray(chunkOffset, chunkOffset + take), written)
				chunkOffset += take
				written += take
				consumed += take
				report()
			}
			return out
		}

		try {
			for(;;) {
				const header = await readExactly(8, true)
				if(header === null) break
				const view = new DataView(header.buffer, header.byteOffset, header.byteLength)
				const pathLen = view.getUint32(0, true)
				const dataLen = view.getUint32(4, true)
				if(pathLen === 0 || pathLen > 1024 * 1024 || dataLen > 512 * 1024 * 1024) {
					throw new Error(`${label}: invalid record ${fileCount} lengths path=${pathLen} data=${dataLen}`)
				}
				const path = decoder.decode(await readExactly(pathLen))
				const blob = await readExactly(dataLen)
				this.installOwnedFile(path, blob)
				fileCount++

				// Give WebKit regular collection points while unpacking thousands of
				// records. This is especially important before Source starts compiling
				// libclient/libserver/libengine Wasm SIDE_MODULEs.
				if((fileCount & 31) === 0) await new Promise(resolve => setTimeout(resolve, 0))
			}
		} finally {
			try { reader.releaseLock() } catch(_) {}
		}

		if(onProgress) onProgress(1)
		return { fileCount, byteLength: consumed }
	}

	async loadBootOverlay() {
		if(this.bootOverlayPromise) return this.bootOverlayPromise
		this.bootOverlayPromise = (async () => {
			try {
				const response = await fetch('render360-bootstrap-overlay.data', {
					cache: 'no-store',
					credentials: 'same-origin'
				})
				if(response.status === 404) {
					Module.print?.('[Render360] no local boot overlay present; continuing with base chunk')
					return
				}
				if(!response.ok) throw new Error(`HTTP ${response.status}`)
				const result = await this.streamDataResponse(response, 'boot overlay')
				Module.print?.(`[Render360] loaded boot overlay: ${result.fileCount} records, ${result.byteLength} bytes`)
			} catch(error) {
				Module.printErr?.(`[Render360] boot overlay load failed: ${error?.stack || error}`)
			}
		})()
		return this.bootOverlayPromise
	}

	async loadMap(mapName) {
		this.setProgress(mapName, 0)
		try {
			const response = await fetch(`chunks/${mapName}.data`, {
				cache: 'no-store',
				credentials: 'same-origin'
			})
			if(!response.ok) throw new Error(`cannot load map ${mapName}: HTTP ${response.status}`)
			const result = await this.streamDataResponse(
				response,
				`${mapName}.data`,
				progress => this.setProgress(mapName, progress)
			)
			this.setProgress(mapName, 1)
			Module.print?.(`[Render360] loaded ${mapName}.data: ${result.fileCount} records, ${result.byteLength} bytes`)
		} catch(error) {
			this.setProgress(mapName, 1)
			Module.printErr?.(`[Render360] ${error?.stack || error}`)
			throw error
		}
	}
}

const dataLoader = new DataLoader()

Module.downloadMap = (lock, mapName) => {
	dataLoader.loadMapWithDeps(mapName).then(() => {
		Atomics.store(HEAP32, lock, 0)
		Atomics.notify(HEAP32, lock)
	}).catch(error => {
		Module.printErr?.(`[Render360] map dependency load failed for ${mapName}: ${error?.stack || error}`)
		Atomics.store(HEAP32, lock, 0)
		Atomics.notify(HEAP32, lock)
	})
}
