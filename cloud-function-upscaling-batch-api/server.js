require('dotenv').config();
const express = require('express');
const upscaleRoutes = require('./src/routes/upscale.routes');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());

app.use(upscaleRoutes);

app.get('/', (req, res) => {
    res.json({ service: 'upscaling-batch-api', status: 'ok' });
});

const server = app.listen(PORT, () => {
    console.log(`[SERVER] upscaling-batch-api corriendo en puerto ${PORT}`);
});

// Timeout extendido para requests largos (~3 min de procesamiento)
server.timeout = 600_000; // 10 minutos

module.exports = app;
