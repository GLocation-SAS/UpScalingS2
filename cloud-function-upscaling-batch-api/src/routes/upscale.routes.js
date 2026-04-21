const express = require('express');
const router = express.Router();
const { processUpscale } = require('../services/upscale.service');
const { onJobComplete } = require('../services/hooks.service');
const { log, logError, timer } = require('../utils/logger');

router.post('/api/upscale', async (req, res) => {
    const { fecha, geometry, modelo, proyecto, bucket, prompt } = req.body;
    const t = timer();

    log('ROUTE', `Solicitud recibida — modelo: ${modelo}, fecha: ${fecha}, proyecto: ${proyecto || 'N/A'}, bucket: ${bucket}`);
    log('ROUTE', `Geometry type: ${geometry?.type}, coordenadas: ${geometry?.coordinates?.[0]?.length || 0} puntos`);

    if (!fecha) {
        logError('ROUTE', 'Campo faltante: fecha');
        return res.status(400).json({ error: 'Campo requerido: fecha' });
    }
    if (!geometry) {
        logError('ROUTE', 'Campo faltante: geometry');
        return res.status(400).json({ error: 'Campo requerido: geometry' });
    }
    if (!modelo) {
        logError('ROUTE', 'Campo faltante: modelo');
        return res.status(400).json({ error: 'Campo requerido: modelo' });
    }
    if (!bucket) {
        logError('ROUTE', 'Campo faltante: bucket');
        return res.status(400).json({ error: 'Campo requerido: bucket' });
    }

    try {
        const result = await processUpscale({ fecha, geometry, modelo, bucket, proyecto, customPrompt: prompt || null });
        await onJobComplete(result);
        log('ROUTE', `✅ Respuesta enviada — ${t.elapsed()} — área: ${result.area_km2} km², tokens: ${result.tokens?.total}, costo: $${result.costo_usd} USD`);
        res.json(result);
    } catch (error) {
        logError('ROUTE', `Error en /api/upscale — ${t.elapsed()}`, error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
