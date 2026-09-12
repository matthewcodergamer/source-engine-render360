

;(() => {
	if(typeof window === 'undefined') return;
	// fix for accidental close via browser shortcut ctrl+w, crouch+move forward obviously
	window.addEventListener('beforeunload', function (event) {
		event.preventDefault()
	})

	canvasElement.onkeypress = e => e.preventDefault()

	addRunDependency('load_game_data')
	dataLoader.loadMapWithDeps('background1').then(x => {
		removeRunDependency('load_game_data')
	}).catch(error => {
		const message = error && error.message ? error.message : String(error)
		console.error('[Render360 game-data load failure]', error && error.stack ? error.stack : error)
		if (typeof render360Report === 'function') {
			render360Report('game-data load failure', message, error)
		}
		// Do not leave Emscripten printing "still waiting on run dependencies"
		// forever after a missing/invalid chunk. Abort the staging runtime with the
		// real cause instead of allowing Source to start with an incomplete FS.
		if (typeof abort === 'function') {
			abort('Portal game-data load failure: ' + message)
			return
		}
		throw error
	})
})();

// Diagnostic-only addition for PROXY_TO_PTHREAD / worker-side failures.
// Keep this WorkerGlobalScope-safe: hl2_launcher.js is imported by pthreads and
// there is deliberately no `window` object in those workers.
if (typeof globalThis !== 'undefined' && globalThis.addEventListener) {
	globalThis.addEventListener('error', event => {
		const error = event && event.error
		const message = event && (event.message || event.type) || 'worker/global error'
		if (typeof globalThis.render360SetPhase === 'function') {
			globalThis.render360SetPhase(`worker-error:${String(message).slice(0, 160)}`)
		}
		console.error(
			'[Render360 worker/global error]',
			message,
			error && error.stack ? error.stack : error || ''
		)
	})

	globalThis.addEventListener('unhandledrejection', event => {
		const reason = event && event.reason
		const message = reason && reason.message ? reason.message : String(reason)
		if (typeof globalThis.render360SetPhase === 'function') {
			globalThis.render360SetPhase(`worker-unhandled-rejection:${message.slice(0, 160)}`)
		}
		console.error(
			'[Render360 worker/global unhandled rejection]',
			reason && reason.stack ? reason.stack : reason
		)
	})
}
