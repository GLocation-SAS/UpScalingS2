/**
 * Logger con timestamp ISO y medición de tiempos.
 * Uso:
 *   const { log, logError, timer } = require('./logger')
 *   const t = timer()
 *   log('TAG', 'mensaje')
 *   log('TAG', `tardó ${t.elapsed()}`)
 */

function log(tag, msg, data = null) {
    const ts = new Date().toISOString()
    if (data !== null) {
        console.log(`[${ts}] [${tag}] ${msg}`, typeof data === 'object' ? JSON.stringify(data) : data)
    } else {
        console.log(`[${ts}] [${tag}] ${msg}`)
    }
}

function logError(tag, msg, err = null) {
    const ts = new Date().toISOString()
    if (err) {
        console.error(`[${ts}] [${tag}] ❌ ${msg} — ${err?.message || err}`)
    } else {
        console.error(`[${ts}] [${tag}] ❌ ${msg}`)
    }
}

function timer() {
    const start = Date.now()
    return {
        elapsed: () => `${Date.now() - start}ms`
    }
}

module.exports = { log, logError, timer }
