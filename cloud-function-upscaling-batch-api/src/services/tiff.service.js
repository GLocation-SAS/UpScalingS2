const fetch = require('node-fetch');

const TIFF_URL = process.env.TIFF_URL;

async function fetchTiffCompuesto(geometry, zoom, layer) {
    console.log('[TIFF] Iniciando fetchTiffCompuesto');
    console.log('[TIFF] URL:', TIFF_URL);
    console.log('[TIFF] Zoom:', zoom, 'Layer:', layer);

    const payload = { geometry, zoom, layer };

    const response = await fetch(TIFF_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

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
        throw new Error(`Error al conectar con TIFF compuesto: ${errorMessage}`);
    }

    const result = await response.json();
    console.log('[TIFF] Respuesta recibida correctamente');
    return result;
}

module.exports = { fetchTiffCompuesto };
