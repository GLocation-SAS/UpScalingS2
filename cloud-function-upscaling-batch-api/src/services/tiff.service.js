const fetch = require('node-fetch');
const { log, logError, timer } = require('../utils/logger');

const TIFF_URL = process.env.TIFF_URL;

async function fetchTiffCompuesto(geometry, zoom, layer) {
    const t = timer();
    log('TIFF', `Iniciando solicitud — zoom: ${zoom}, layer: ${layer}`);
    log('TIFF', `URL destino: ${TIFF_URL}`);

    const payload = { geometry, zoom, layer };

    const response = await fetch(TIFF_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    log('TIFF', `Respuesta HTTP ${response.status} — ${t.elapsed()}`);

    if (!response.ok) {
        let errorMessage = '';
        try {
            const contentType = response.headers.get('content-type');
            if (contentType && contentType.includes('application/json')) {
                const errorData = await response.json();
                errorMessage = errorData.error || errorData.message || `Error HTTP ${response.status}`;
            } else {
                errorMessage = await response.text() || `Error HTTP ${response.status}`;
            }
        } catch (e) {
            errorMessage = `Error HTTP ${response.status}: ${response.statusText}`;
        }
        logError('TIFF', `Falló — ${t.elapsed()} — ${errorMessage}`);
        throw new Error(`Error al conectar con TIFF compuesto: ${errorMessage}`);
    }

    const result = await response.json();
    log('TIFF', `✅ Completado — ${t.elapsed()} — preview_url: ${result.preview_url || 'N/A'}`);
    return result;
}

module.exports = { fetchTiffCompuesto };
