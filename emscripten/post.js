

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
// This intentionally does not alter Source threading or synchronization.
if (typeof globalThis !== 'undefined' && globalThis.addEventListener) {
	globalThis.addEventListener('error', event => {
		const error = event && event.error
		console.error(
			'[Render360 worker/global error]',
			event && (event.message || event.type),
			error && error.stack ? error.stack : error || ''
		)
	})

	globalThis.addEventListener('unhandledrejection', event => {
		const reason = event && event.reason
		console.error(
			'[Render360 worker/global unhandled rejection]',
			reason && reason.stack ? reason.stack : reason
		)
	})
}
