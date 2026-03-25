const fetch = require('node-fetch');

const GEE_URL = process.env.GEE_URL;

async function fetchGeeImage(date, geometry) {
    console.log('[GEE] Iniciando fetchGeeImage');
    console.log('[GEE] URL:', GEE_URL);
    console.log('[GEE] Fecha:', date);

    const payload = { date, geometry };

    const response = await fetch(GEE_URL, {
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
        throw new Error(`Error al conectar con GEE: ${errorMessage}`);
    }

    const result = await response.json();
    console.log('[GEE] Respuesta recibida correctamente');
    return result;
}

module.exports = { fetchGeeImage };
