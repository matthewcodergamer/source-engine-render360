Module['arguments'] = Module['arguments'] || []
Module['arguments'].push(
	'-game', 'portal',
	'-noip',
	'-language', 'english',
	'-windowed',
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

	chunkUrl(mapName) {
		const base = String(Module['portalChunkBaseUrl'] || 'chunks/').replace(/\/?$/, '/')
		return new URL(base + mapName + '.data', location.href).href
	}

	async loadMapWithDeps(mapName) {
		const index = this.mapsOrdered.indexOf(mapName)
		if(index === -1) {
			throw new Error(`no such map: ${mapName}`)
		}

		// load past maps and current one
		for(let i = 0; i < index + 1; i++) {
			await this.loadMapCached(this.mapsOrdered[i])
		}

		// schedule next map if it exists
		const next = this.mapsOrdered[index + 1]
		if(next) {
			this.loadMapCached(next).catch(error => {
				console.error('[Render360 background chunk preload failed]', error)
			})
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
			statusElement.innerText = `Downloading map ${mapName}`
			progressElement.hidden = false
			progressElement.value = Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0))
		} else {
			spinnerElement.style.display = 'none'
			statusElement.innerText = ''
			progressElement.hidden = true
		}
	}

	parsePackedChunk(mapName, url, buffer) {
		if(!(buffer instanceof ArrayBuffer)) {
			throw new Error(`chunk ${mapName} did not return an ArrayBuffer`)
		}
		if(buffer.byteLength < 8) {
			throw new Error(`chunk ${mapName} is too small (${buffer.byteLength} bytes)`)
		}

		const firstBytes = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 96))
		const firstText = new TextDecoder().decode(firstBytes)
		if(/^\s*</.test(firstText)) {
			throw new Error(`received HTML instead of packed Portal data from ${url}; the chunk path is probably missing or returned a GitHub Pages error page`)
		}

		const dv = new DataView(buffer)
		const decoder = new TextDecoder()
		let offset = 0
		let entries = 0

		// packed format: { pathLen: uint32le, dataLen: uint32le, path: bytes, blob: bytes }[]
		while(offset < dv.byteLength) {
			const remaining = dv.byteLength - offset
			if(remaining < 8) {
				throw new Error(`truncated chunk header at byte ${offset}; ${remaining} byte(s) remain`)
			}

			const pathLen = dv.getUint32(offset, true)
			const dataLen = dv.getUint32(offset + 4, true)
			if(pathLen === 0 || pathLen > 65536) {
				throw new Error(`invalid path length ${pathLen} at byte ${offset}`)
			}

			const pathStart = offset + 8
			const dataStart = pathStart + pathLen
			const end = dataStart + dataLen
			if(dataStart > dv.byteLength || end > dv.byteLength) {
				throw new Error(`packed entry ${entries} exceeds chunk bounds (offset=${offset}, pathLen=${pathLen}, dataLen=${dataLen}, chunkBytes=${dv.byteLength})`)
			}

			const path = decoder.decode(new Uint8Array(buffer, pathStart, pathLen))
			if(!path.startsWith('/') || path.includes('\0')) {
				throw new Error(`invalid packed path at entry ${entries}: ${JSON.stringify(path.slice(0, 120))}`)
			}

			const blob = new Uint8Array(buffer, dataStart, dataLen)
			const dir = path.replace(/\/[^\/]+$/, '')
			if(dir) FS.mkdirTree(dir)
			FS.writeFile(path, blob)

			offset = end
			entries++
		}

		if(entries === 0) {
			throw new Error(`chunk ${mapName} contained no packed files`)
		}
		return entries
	}

	async loadMap(mapName) {
		this.setProgress(mapName, 0)

		return new Promise((resolve, reject) => {
			const xhr = new XMLHttpRequest()
			const url = this.chunkUrl(mapName)
			xhr.responseType = 'arraybuffer'
			xhr.timeout = 60000

			xhr.onprogress = e => {
				if(e.lengthComputable && e.total > 0) {
					this.setProgress(mapName, e.loaded / e.total)
				}
			}

			xhr.onerror = () => {
				reject(new Error(`network error while loading Portal chunk ${mapName} from ${url}`))
			}
			xhr.onabort = () => {
				reject(new Error(`Portal chunk request aborted for ${mapName}`))
			}
			xhr.ontimeout = () => {
				reject(new Error(`timed out loading Portal chunk ${mapName} from ${url}`))
			}

			xhr.onload = () => {
				try {
					if(xhr.status < 200 || xhr.status >= 300) {
						throw new Error(`HTTP ${xhr.status} ${xhr.statusText || ''} loading ${url}`.trim())
					}
					const entries = this.parsePackedChunk(mapName, url, xhr.response)
					this.setProgress(mapName, 1)
					console.log(`[Render360 chunk] loaded ${mapName}: ${entries} files, ${xhr.response.byteLength} bytes`)
					resolve()
				} catch(error) {
					this.setProgress(mapName, 1)
					reject(new Error(`Portal chunk ${mapName} is missing or invalid: ${error && error.message ? error.message : String(error)}`))
				}
			}

			console.log('[Render360 chunk] GET', url)
			xhr.open('GET', url, true)
			xhr.send()
		})
	}
}

const dataLoader = new DataLoader()

Module.downloadMap = (lock, mapName) => {
	dataLoader.loadMapWithDeps(mapName).then(() => {
		Atomics.store(HEAP32, lock, 0)
		Atomics.notify(HEAP32, lock)
	}).catch(error => {
		console.error('[Render360 map download failure]', mapName, error && error.stack ? error.stack : error)
		// Never leave Source permanently blocked on a failed browser-side map request.
		Atomics.store(HEAP32, lock, 0)
		Atomics.notify(HEAP32, lock)
	})
}
