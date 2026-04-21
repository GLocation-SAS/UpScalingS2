const fetch = require('node-fetch');
const { log, logError, timer } = require('../utils/logger');

const GEE_URL = process.env.GEE_URL;

async function fetchGeeImage(date, geometry) {
    const t = timer();
    log('GEE', `Iniciando solicitud — fecha: ${date}`);
    log('GEE', `URL destino: ${GEE_URL}`);

    const payload = { date, geometry };

    const response = await fetch(GEE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    log('GEE', `Respuesta HTTP ${response.status} — ${t.elapsed()}`);

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
        logError('GEE', `Falló — ${t.elapsed()} — ${errorMessage}`);
        throw new Error(`Error al conectar con GEE: ${errorMessage}`);
    }

    const result = await response.json();
    const jpegUrl = result.jpegUrl || result.imageUrl || result.image_url || result.public_url || 'N/A';
    const geotiffUrl = result.geotiffUrl || 'N/A';
    log('GEE', `✅ Completado — ${t.elapsed()} — jpegUrl: ${jpegUrl}`);
    log('GEE', `geotiffUrl: ${geotiffUrl}, ndviJpegUrl: ${result.ndviJpegUrl || 'N/A'}`);
    return result;
}

module.exports = { fetchGeeImage };
