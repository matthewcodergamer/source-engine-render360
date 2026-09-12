// Safari/iOS may terminate the WebContent process without giving Wasm a normal
// exception when the Source startup peak crosses the device memory budget. The
// browser then reloads the exact launcher URL, which can immediately repeat the
// expensive startup and make the situation worse. Persist the last launch phase
// so a process-kill reload is stopped before main() runs again.
const RENDER360_IOS_CRASH_STATE_KEY = 'render360-ios-crash-state-v2'
const RENDER360_IOS_CRASH_CHANNEL = 'render360-ios-crash-state-channel-v1'
const render360IsWindow = typeof window !== 'undefined' && typeof document !== 'undefined'
// Use one stable id in both Window and WorkerGlobalScope. Worker location points
// at hl2_launcher.worker.js, so location.pathname cannot be used as a shared id.
const render360LaunchId = 'portal-upstream-baseline'
const render360Now = Date.now()
let render360PreviousState = null
if(render360IsWindow) {
	try {
		render360PreviousState = JSON.parse(localStorage.getItem(RENDER360_IOS_CRASH_STATE_KEY) || 'null')
	} catch(_) {}
}

const render360ProbableProcessReload = !!(
	render360IsWindow &&
	render360PreviousState &&
	render360PreviousState.active === true &&
	render360PreviousState.launchId === render360LaunchId &&
	render360Now - Number(render360PreviousState.updatedAt || 0) < 3 * 60 * 1000
)

const render360CrashState = {
	launchId: render360LaunchId,
	active: !render360ProbableProcessReload,
	blocked: render360ProbableProcessReload,
	phase: render360ProbableProcessReload ? 'probable-process-kill-reload' : 'runtime-script-start',
	startedAt: render360Now,
	updatedAt: render360Now,
	wasmHeapBytes: 0,
	memfsBytes: 0,
	memfsFiles: 0,
	previous: render360ProbableProcessReload ? render360PreviousState : null
}

let render360CrashChannel = null
try {
	if(typeof BroadcastChannel === 'function') {
		render360CrashChannel = new BroadcastChannel(RENDER360_IOS_CRASH_CHANNEL)
	}
} catch(_) {}

function render360ReadWasmHeapBytes() {
	try {
		if(typeof HEAPU8 !== 'undefined' && HEAPU8?.buffer) return HEAPU8.buffer.byteLength || 0
	} catch(_) {}
	return 0
}

function render360WriteCrashState(state) {
	if(render360IsWindow) {
		try { localStorage.setItem(RENDER360_IOS_CRASH_STATE_KEY, JSON.stringify(state)) } catch(_) {}
		return
	}
	if(render360CrashChannel) {
		try { render360CrashChannel.postMessage({ type: 'render360-crash-state', state }) } catch(_) {}
	}
}

function render360PersistCrashState() {
	render360CrashState.updatedAt = Date.now()
	render360CrashState.wasmHeapBytes = render360ReadWasmHeapBytes()
	render360CrashState.memfsBytes = Number(Module.render360ResidentBytes || 0)
	render360CrashState.memfsFiles = Number(Module.render360ResidentFiles || 0)
	render360WriteCrashState(render360CrashState)
}

function render360SetPhase(phase) {
	render360CrashState.phase = String(phase || 'unknown')
	render360PersistCrashState()
}

globalThis.render360SetPhase = render360SetPhase
globalThis.render360MemorySnapshot = (phase) => {
	if(phase) render360SetPhase(phase)
	else render360PersistCrashState()
	return {
		phase: render360CrashState.phase,
		wasmHeapMiB: Math.round(render360CrashState.wasmHeapBytes / 1048576),
		memfsMiB: Math.round(render360CrashState.memfsBytes / 1048576),
		memfsFiles: render360CrashState.memfsFiles
	}
}

// Worker-side phase changes matter most for PROXY_TO_PTHREAD. Relay them to
// the Window so localStorage still contains the last worker phase if WebKit
// kills the process and reloads the launcher.
if(render360IsWindow && render360CrashChannel) {
	render360CrashChannel.addEventListener('message', event => {
		const incoming = event?.data?.type === 'render360-crash-state' ? event.data.state : null
		if(!incoming || incoming.launchId !== render360LaunchId) return
		if(Number(incoming.updatedAt || 0) < Number(render360CrashState.updatedAt || 0)) return
		render360CrashState.active = incoming.active !== false
		render360CrashState.blocked = false
		render360CrashState.phase = String(incoming.phase || render360CrashState.phase)
		render360CrashState.updatedAt = Number(incoming.updatedAt || Date.now())
		render360CrashState.wasmHeapBytes = Number(incoming.wasmHeapBytes || render360CrashState.wasmHeapBytes || 0)
		render360CrashState.memfsBytes = Number(incoming.memfsBytes || render360CrashState.memfsBytes || 0)
		render360CrashState.memfsFiles = Number(incoming.memfsFiles || render360CrashState.memfsFiles || 0)
		try { localStorage.setItem(RENDER360_IOS_CRASH_STATE_KEY, JSON.stringify(render360CrashState)) } catch(_) {}
	})
}

if(render360ProbableProcessReload) {
	// noInitialRun prevents the expensive Source main()/map/module startup from
	// being executed a second time. The launcher can still render diagnostics.
	Module['noInitialRun'] = true
	const previous = render360PreviousState || {}
	setTimeout(() => {
		const heap = Math.round(Number(previous.wasmHeapBytes || 0) / 1048576)
		const memfs = Math.round(Number(previous.memfsBytes || 0) / 1048576)
		const message = `[Render360 iOS guard] Safari restarted this launcher after a probable WebContent/GPU process kill. Previous phase=${previous.phase || 'unknown'}, wasmHeap=${heap} MiB, trackedMEMFS=${memfs} MiB. Use Copy diagnostics, then return to the staging page for a deliberate fresh launch.`
		Module.printErr?.(message)
		if(typeof statusElement !== 'undefined' && statusElement) statusElement.textContent = message
		if(typeof spinnerElement !== 'undefined' && spinnerElement) spinnerElement.style.display = 'none'
	}, 0)
} else {
	render360PersistCrashState()
}

const render360OriginalPrint = typeof Module.print === 'function' ? Module.print.bind(Module) : console.log.bind(console)
const render360OriginalPrintErr = typeof Module.printErr === 'function' ? Module.printErr.bind(Module) : console.error.bind(console)
function render360ObserveRuntimeLine(args) {
	const text = args.map(value => String(value)).join(' ')
	let match = text.match(/LoadLibrary:\s*path:\s*(\S+)/)
	if(match) render360SetPhase(`dlopen-start:${match[1]}`)
	match = text.match(/Render360:\s*loaded module:\s*(\S+)/)
	if(match) render360SetPhase(`dlopen-done:${match[1]}`)
	if(text.includes('IDirect3DDevice9::Create')) render360SetPhase('renderer-device-created')
	if(text.includes('server.so loaded')) render360SetPhase('server-module-ready')
	if(text.includes('Precache:')) render360SetPhase('shader-precache-finished')
}
Module.print = (...args) => {
	render360ObserveRuntimeLine(args)
	render360OriginalPrint(...args)
}
Module.printErr = (...args) => {
	render360ObserveRuntimeLine(args)
	render360OriginalPrintErr(...args)
}

let render360Heartbeat = 0
if(render360IsWindow) {
	render360Heartbeat = setInterval(() => {
		if(render360CrashState.active) render360PersistCrashState()
	}, 3000)
	window.addEventListener('pagehide', () => {
		if(render360Heartbeat) clearInterval(render360Heartbeat)
		if(!render360CrashState.blocked) {
			render360CrashState.active = false
			render360CrashState.phase = 'clean-pagehide'
			render360PersistCrashState()
		}
		try { render360CrashChannel?.close() } catch(_) {}
	}, { once: true })
}

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
	render360SetPhase('prerun-liblauncher-ready')
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
	residentBytes = 0
	residentFileSizes = new Map()

	async loadMapWithDeps(mapName) {
		const index = this.mapsOrdered.indexOf(mapName)
		if(index === -1) throw new Error(`no such map: ${mapName}`)

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
		// This class is also present when hl2_launcher.js is imported by a pthread.
		// Never assume DOM globals exist in WorkerGlobalScope.
		if(typeof spinnerElement === 'undefined' || typeof statusElement === 'undefined' || typeof progressElement === 'undefined') return
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
		const oldSize = Number(this.residentFileSizes.get(path) || 0)
		const newSize = Number(blob?.byteLength || blob?.length || 0)
		FS.mkdirTree(parent)
		try { FS.unlink(path) } catch(_) {}

		if(typeof FS.createDataFile === 'function') {
			FS.createDataFile(parent, name, blob, true, true, true)
		} else {
			FS.writeFile(path, blob)
		}

		this.residentFileSizes.set(path, newSize)
		this.residentBytes += newSize - oldSize
		Module.render360ResidentBytes = this.residentBytes
		Module.render360ResidentFiles = this.residentFileSizes.size
		if((this.residentFileSizes.size & 127) === 0) render360PersistCrashState()
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
			const blob = new Uint8Array(dataLen)
			blob.set(new Uint8Array(dv.buffer, offset + 8 + pathLen, dataLen))
			offset = recordEnd
			fileCount++
			this.installOwnedFile(path, blob)
		}
		return { fileCount, byteLength: dv.byteLength }
	}

	async streamDataResponse(response, label, onProgress) {
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
				const snapshot = globalThis.render360MemorySnapshot?.('boot-overlay-ready')
				Module.print?.(`[Render360] loaded boot overlay: ${result.fileCount} records, ${result.byteLength} bytes; memory=${JSON.stringify(snapshot || {})}`)
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
			const snapshot = globalThis.render360MemorySnapshot?.(`map-ready:${mapName}`)
			Module.print?.(`[Render360] loaded ${mapName}.data: ${result.fileCount} records, ${result.byteLength} bytes; memory=${JSON.stringify(snapshot || {})}`)
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