const express = require('express');
const router = express.Router();
const { processUpscale } = require('../services/upscale.service');
const { onJobComplete } = require('../services/hooks.service');

router.post('/api/upscale', async (req, res) => {
    const { fecha, geometry, modelo, proyecto, bucket, prompt } = req.body;

    if (!fecha) return res.status(400).json({ error: 'Campo requerido: fecha' });
    if (!geometry) return res.status(400).json({ error: 'Campo requerido: geometry' });
    if (!modelo) return res.status(400).json({ error: 'Campo requerido: modelo' });
    if (!bucket) return res.status(400).json({ error: 'Campo requerido: bucket' });

    try {
        const result = await processUpscale({ fecha, geometry, modelo, bucket, proyecto, customPrompt: prompt || null });
        await onJobComplete(result);
        res.json(result);
    } catch (error) {
        console.error('[ROUTE] Error en /api/upscale:', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
