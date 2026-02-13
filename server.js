require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { randomUUID } = require('crypto');
const FormData = require('form-data');
const fetch = require('node-fetch');
const { Storage } = require('@google-cloud/storage');
const mapRoutes = require('./src/modules/map/map.routes.js');
const { fromArrayBuffer } = require('geotiff');


const storage = new Storage();
const app = express();
const PORT = process.env.PORT || 8080;

const URLS = {
    token: 'https://gentoken-960956212831.us-central1.run.app',
    upload: 'https://uss2-upload-960956212831.us-central1.run.app',
    upscale: 'https://uss2-image-upgrade-960956212831.us-central1.run.app',
};

const BUCKET_NAME = "uss2-images";
const BUCKET_BASE_PATH = "sentinel";

const jobs = {};

app.use((req, res, next) => {
    req.jobs = jobs;
    next();
});

// --- MIDDLEWARE DE EXPRESS ---
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'src', 'modules'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'src')));
app.use('/modules', express.static(path.join(__dirname, 'src', 'modules')));
app.use('/assets/modules', express.static(path.join(__dirname, 'src', 'modules')));

app.use((req, res, next) => {
    res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; " +
        "script-src 'self' https://unpkg.com blob:; " +
        "style-src 'self' 'unsafe-inline' https://unpkg.com https://fonts.googleapis.com; " +
        "font-src 'self' https://fonts.gstatic.com; " +
        "connect-src 'self' https://mt1.google.com https://storage.googleapis.com https://unpkg.com; " +
        "img-src 'self' data: https://storage.googleapis.com https://mt1.google.com; " +
        "frame-src 'self';" +
        "worker-src 'self' blob:;"
    );
    next();
});
// --- HELPERS (Solo parseo de la petición entrante) ---
async function parseJsonBody(req) {
    if (req.body && Object.keys(req.body).length > 0) {
        return req.body;
    }
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', () => {
            try {
                resolve(JSON.parse(body));
            } catch (e) {
                reject(new Error('Cuerpo de la petición JSON inválido.'));
            }
        });
    });
}

async function downloadFromGCS(gsPath) {
    const match = gsPath.match(/^gs:\/\/([^\/]+)\/(.+)$/);
    if (!match) throw new Error('Ruta GSUtil inválida.');

    const bucketName = match[1];
    const filePath = match[2];

    console.log(`Descargando de gs://${bucketName}/${filePath}`);
    const [fileBuffer] = await storage.bucket(bucketName).file(filePath).download();
    return fileBuffer;
}

async function downloadFromUrl(imageUrl) {
    const response = await fetch(imageUrl);
    if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Error descargando imagen (${response.status}): ${errorBody}`);
    }
    return response.buffer();
}

function bufferSplit(buffer, separator) {
    const res = []; let start = 0;
    while (true) {
        const index = buffer.indexOf(separator, start);
        if (index === -1) { res.push(buffer.subarray(start)); break; }
        res.push(buffer.subarray(start, index));
        start = index + separator.length;
    }
    return res;
}
function parseMultipartIncoming(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            try {
                const buffer = Buffer.concat(chunks);
                const contentType = req.headers['content-type'] || '';
                if (!contentType.includes('boundary=')) return resolve({ fields: {}, files: [] });
                const boundary = `--${contentType.split('boundary=')[1]}`;
                const parts = bufferSplit(buffer, Buffer.from(boundary));
                const files = [];
                for (const part of parts) {
                    const headerEndIndex = part.indexOf('\r\n\r\n');
                    if (headerEndIndex === -1) continue;
                    const headers = part.subarray(0, headerEndIndex).toString();
                    const filenameMatch = headers.match(/filename="([^"]+)"/);
                    if (filenameMatch) {
                        const content = part.subarray(headerEndIndex + 4, part.length - 2);
                        files.push({ filename: filenameMatch[1], buffer: content });
                    }
                }
                resolve({ fields: {}, files });
            } catch (err) { reject(err); }
        });
    });
}

// --- FUNCIONES DE SERVICIO REESCRITAS CON node-fetch (Correctas) ---
async function uploadToDocs(fileBuffer, destinationPath) {
    const form = new FormData();
    form.append('destinationPath', destinationPath);
    form.append('files', fileBuffer, { filename: path.basename(destinationPath) });
    const response = await fetch(`${URLS.upload}?action=upload`, {
        method: 'POST',
        body: form
    });

    if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Upload error (${response.status}): ${errorBody}`);
    }

    return `gs://${BUCKET_NAME}/${destinationPath}`;
}

async function callBusinessService(url, payloadObj) {
    const tokenUrl = `${URLS.token}/?url=${encodeURIComponent(url)}`;
    const tokenResponse = await fetch(tokenUrl);
    if (!tokenResponse.ok) {
        const errorBody = await tokenResponse.text();
        throw new Error(`Error obteniendo token (${tokenResponse.status}): ${errorBody}`);
    }
    const tokenData = await tokenResponse.json();
    if (!tokenData.token) throw new Error(`Respuesta de token inválida`);
    const token = tokenData.token;
    const serviceResponse = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(payloadObj)
    });
    if (!serviceResponse.ok) {
        const errorBody = await serviceResponse.text();
        throw new Error(`IA Service Error (${serviceResponse.status}): ${errorBody}`);
    }
    return serviceResponse.json();
}

// --- LÓGICA PRINCIPAL DE PROCESAMIENTO ---
function getBoundsFromGeometry(geometry) {
    if (!geometry || !geometry.coordinates || geometry.coordinates.length === 0) {
        return [[-74.20, 4.60], [-74.00, 4.80]];
    }

    const coords = geometry.coordinates[0];
    const lngs = coords.map(c => c[0]);
    const lats = coords.map(c => c[1]);

    const minLng = Math.min(...lngs);
    const maxLng = Math.max(...lngs);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);

    return [[minLng, minLat], [maxLng, maxLat]];
}

function updateJobProgress(jobId, progressUpdate) {
    if (jobs[jobId]) {
        // Si el objeto de actualización tiene un 'status', actualiza el status principal del job.
        if (progressUpdate.status) {
            jobs[jobId].status = progressUpdate.status;
        }
        // Siempre actualiza el sub-objeto de progreso.
        jobs[jobId].progress = { ...jobs[jobId].progress, ...progressUpdate };
    }
}

async function processUpscale(jobId, file) {
    try {
        updateJobProgress(jobId, { message: "Leyendo metadatos GeoTIFF..." });

        try {
            const arrayBuffer = file.buffer.buffer.slice(file.buffer.byteOffset, file.buffer.byteOffset + file.buffer.byteLength);
            const tiff = await fromArrayBuffer(arrayBuffer);
            const image = await tiff.getImage();
            const bbox = image.getBoundingBox();
            realBounds = [[bbox[0], bbox[1]], [bbox[2], bbox[3]]];
            console.log(`[PROCESS] Coordenadas GeoTIFF extraídas:`, realBounds);
        } catch (geotiffError) {
            console.error("[PROCESS] Error Crítico: El archivo proporcionado no es un GeoTIFF válido.", geotiffError);
            throw new Error("El archivo de entrada debe ser un GeoTIFF válido para extraer las coordenadas.");
        }

        const TILE_SIZE = 1024;
        const sharpImage = sharp(file.buffer);
        const jpegBuffer = await sharpImage.jpeg({ quality: 90 }).toBuffer();

        const originalJpegPath = `${BUCKET_BASE_PATH}/original_jpeg/${jobId}.jpeg`;
        await uploadToDocs(jpegBuffer, originalJpegPath);
        const originalPublicUrl = `https://storage.googleapis.com/${BUCKET_NAME}/${originalJpegPath}`;

        const jpegImage = sharp(jpegBuffer);
        const { width, height } = await jpegImage.metadata();

        const tiles = [];
        for (let y = 0; y < height; y += TILE_SIZE) {
            for (let x = 0; x < width; x += TILE_SIZE) {
                tiles.push({ x, y, width: Math.min(TILE_SIZE, width - x), height: Math.min(TILE_SIZE, height - y) });
            }
        }
        updateJobProgress(jobId, { total: tiles.length, processed: 0 });

        let originalsUploaded = 0;
        const originalUploadPromises = tiles.map(async (tile) => {
            const tileBuffer = await jpegImage.extract({ left: tile.x, top: tile.y, width: tile.width, height: tile.height }).toBuffer();
            const destPath = `${BUCKET_BASE_PATH}/grillas_originales/${jobId}/tile_${tile.x}_${tile.y}.jpeg`;
            const gsPath = await uploadToDocs(tileBuffer, destPath);
            originalsUploaded++;
            updateJobProgress(jobId, { message: `Subiendo grilla original ${originalsUploaded}/${tiles.length}`, processed: originalsUploaded });
            return gsPath;
        });
        const originalGsPaths = await Promise.all(originalUploadPromises);

        let tilesImproved = 0;
        updateJobProgress(jobId, { message: `Mejorando grillas con IA...`, processed: 0 });
        const upgradePromises = originalGsPaths.map(gsPath =>
            callBusinessService(URLS.upscale, { imagen_gs: gsPath }).then(result => {
                tilesImproved++;
                updateJobProgress(jobId, { message: `Mejorando grilla ${tilesImproved}/${tiles.length}`, processed: tilesImproved });
                return result;
            })
        );
        const upgradedResults = await Promise.all(upgradePromises);

        let tilesAssembled = 0;
        updateJobProgress(jobId, { message: `Analizando y guardando resultados...`, processed: 0 });
        const inspectionPromises = upgradedResults.map(async (tileInfo, i) => {
            const response = await fetch(tileInfo.public_url);
            const buffer = await response.buffer();
            const improvedTileDestPath = `${BUCKET_BASE_PATH}/grillas_mejoradas/${jobId}/tile_${tiles[i].x}_${tiles[i].y}.png`;
            uploadToDocs(buffer, improvedTileDestPath).catch(err => console.error(`Fallo al subir grilla mejorada: ${err.message}`));
            const metadata = await sharp(buffer).metadata();
            tilesAssembled++;
            updateJobProgress(jobId, { message: `Analizando resultado ${tilesAssembled}/${tiles.length}`, processed: tilesAssembled });
            return { buffer, originalX: tiles[i].x, originalY: tiles[i].y, width: metadata.width, height: metadata.height };
        });
        const inspectedTiles = await Promise.all(inspectionPromises);

        const columnWidths = {}; const rowHeights = {};
        inspectedTiles.forEach(tile => { columnWidths[tile.originalX] = Math.max(columnWidths[tile.originalX] || 0, tile.width); rowHeights[tile.originalY] = Math.max(rowHeights[tile.originalY] || 0, tile.height); });
        const finalWidth = Object.values(columnWidths).reduce((sum, w) => sum + w, 0); const finalHeight = Object.values(rowHeights).reduce((sum, h) => sum + h, 0);
        const xCoords = Object.keys(columnWidths).map(Number).sort((a, b) => a - b); const yCoords = Object.keys(rowHeights).map(Number).sort((a, b) => a - b);
        const positionMap = { x: {}, y: {} }; let currentLeft = 0; xCoords.forEach(x => { positionMap.x[x] = currentLeft; currentLeft += columnWidths[x]; }); let currentTop = 0; yCoords.forEach(y => { positionMap.y[y] = currentTop; currentTop += rowHeights[y]; });
        const compositeArray = inspectedTiles.map(tile => ({ input: tile.buffer, left: positionMap.x[tile.originalX], top: positionMap.y[tile.originalY] }));

        updateJobProgress(jobId, { message: 'Generando archivos finales...' });
        const finalCompositeImage = sharp({
            create: { width: finalWidth, height: finalHeight, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } }
        }).composite(compositeArray);

        // Generar y subir el TIF para descarga
        const finalTifBuffer = await finalCompositeImage.clone().tiff({ quality: 100, compression: 'lzw' }).toBuffer();
        const finalTifDestPath = `${BUCKET_BASE_PATH}/resultados_finales/${jobId}.tif`;
        await uploadToDocs(finalTifBuffer, finalTifDestPath);
        const finalTifPublicUrl = `https://storage.googleapis.com/${BUCKET_NAME}/${finalTifDestPath}`;

        // Generar y subir el PNG para visualización en el mapa
        const finalPngBuffer = await finalCompositeImage.clone().png().toBuffer();
        const finalPngDestPath = `${BUCKET_BASE_PATH}/resultados_previsualizacion/${jobId}.png`;
        await uploadToDocs(finalPngBuffer, finalPngDestPath);
        const improvedPngPublicUrl = `https://storage.googleapis.com/${BUCKET_NAME}/${finalPngDestPath}`;

        console.log(`Proceso completado para ${jobId}.`);
        jobs[jobId].result = {
            improvedPngUrl: improvedPngPublicUrl,
            improvedTifUrl: finalTifPublicUrl,
            originalJpegUrl: originalPublicUrl,
            bounds: realBounds
        };
        updateJobProgress(jobId, {
            status: 'complete',
            message: '¡Proceso completado!',
            processed: tiles.length,
            total: tiles.length
        });
    } catch (error) {
        console.error(`Error en el trabajo ${jobId}:`, error);
        updateJobProgress(jobId, { status: 'error', error: error.message });
    }
}

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'src', 'views', 'index.html'));
});

app.use('/map', mapRoutes);

// Ruta para el visor del mapa
app.get('/api/progress/:jobId', (req, res) => {
    const { jobId } = req.params;
    if (!jobs[jobId]) return res.status(404).send('Job not found');

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });

    const intervalId = setInterval(() => {
        const job = jobs[jobId];
        if (!job) { clearInterval(intervalId); return res.end(); }
        // Enviamos el objeto de progreso completo, incluyendo el resultado si existe
        res.write(`data: ${JSON.stringify({ status: job.status, ...job.progress, result: job.result })}\n\n`);
        if (job.status === 'complete' || job.status === 'error') {
            clearInterval(intervalId);
            res.end();
            // Opcional: limpiar el trabajo de la memoria después de un tiempo
            setTimeout(() => delete jobs[jobId], 60000);
        }
    }, 1000);
    req.on('close', () => clearInterval(intervalId));
});


app.post('/api/upscale', async (req, res, next) => {
    try {
        const { files } = await parseMultipartIncoming(req);
        if (!files || files.length === 0) throw new Error('No se ha subido ningún archivo.');
        const jobId = randomUUID();
        jobs[jobId] = { status: 'processing', progress: { message: 'Iniciando...', processed: 0, total: 0 } };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jobId }));
        processUpscale(jobId, files[0]);
    } catch (e) {
        console.error("Error en /api/upscale:", e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
    }
})

app.post('/api/upscale-from-gs', async (req, res, next) => {
    const { gsPath } = await parseJsonBody(req);
    if (!gsPath) throw new Error('Falta el campo "gsPath" en el cuerpo de la petición.');
    const fileBuffer = await downloadFromGCS(gsPath);
    const file = { buffer: fileBuffer, filename: path.basename(gsPath) };
    const jobId = randomUUID();
    jobs[jobId] = { status: 'processing', progress: { message: 'Iniciando...', processed: 0, total: 0 } };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jobId }));
    processUpscale(jobId, file);
})

app.post('/api/upscale-from-url', async (req, res) => {
    try {
        const { geotiffUrl, geometry } = req.body;

        if (!geotiffUrl) {
            throw new Error('La respuesta de GEE no incluyó la URL del archivo GeoTIFF (geotiffUrl). No se puede procesar.');
        }

        console.log(`[API] Descargando GeoTIFF desde URL de GEE: ${geotiffUrl}`);
        const imageResponse = await fetch(geotiffUrl);
        if (!imageResponse.ok) {
            throw new Error(`No se pudo descargar el GeoTIFF desde ${geotiffUrl}`);
        }
        const imageBuffer = await imageResponse.buffer();

        // El archivo que pasamos a processUpscale es ahora el GeoTIFF real
        const file = { buffer: imageBuffer, filename: `gee_image_${Date.now()}.tif` };
        const jobId = randomUUID();
        jobs[jobId] = { status: 'processing', progress: { message: 'Iniciando desde GEE...', processed: 0, total: 0 } };

        res.json({ jobId }); // Devolver el jobId inmediatamente

        processUpscale(jobId, file);

    } catch (e) {
        console.error("[API] Error en /api/upscale-from-url:", e);
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/progress/:jobId', (req, res) => {
    const jobId = req.url.split('/')[3];
    if (!jobs[jobId]) { res.writeHead(404); res.end('Job not found'); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    const intervalId = setInterval(() => {
        const job = jobs[jobId];
        if (!job) { clearInterval(intervalId); res.end(); return; }
        res.write(`data: ${JSON.stringify({ status: job.status, ...job.progress })}\n\n`);
        if (job.status === 'complete' || job.status === 'error') {
            clearInterval(intervalId);
            delete jobs[jobId];
            res.end();
        }
    }, 1000);
    req.on('close', () => clearInterval(intervalId));
})

app.listen(PORT, () => console.log(`Servidor Express iniciado en http://localhost:${PORT}`));
// --- SERVIDOR PRINCIPAL Y RUTAS ---
// http.createServer(async (req, res) => {
//     res.setHeader('Access-Control-Allow-Origin', '*');
//     res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
//     res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
//     if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
//     // RUTA: Cargar desde archivo local
//     if (req.method === 'POST' && req.url === '/api/upscale') {
//         try {
//             const { files } = await parseMultipartIncoming(req);
//             if (!files || files.length === 0) throw new Error('No se ha subido ningún archivo.');
//             const jobId = randomUUID();
//             jobs[jobId] = { status: 'processing', progress: { message: 'Iniciando...', processed: 0, total: 0 } };
//             res.writeHead(200, { 'Content-Type': 'application/json' });
//             res.end(JSON.stringify({ jobId }));
//             processUpscale(jobId, files[0]);
//         } catch (e) {
//             console.error("Error en /api/upscale:", e.message);
//             res.writeHead(500, { 'Content-Type': 'application/json' });
//             res.end(JSON.stringify({ error: e.message }));
//         }
//     }
//     // RUTA: Cargar desde GSUtil
//     else if (req.method === 'POST' && req.url === '/api/upscale-from-gs') {
//         const { gsPath } = await parseJsonBody(req);
//         if (!gsPath) throw new Error('Falta el campo "gsPath" en el cuerpo de la petición.');
//         const fileBuffer = await downloadFromGCS(gsPath);
//         const file = { buffer: fileBuffer, filename: path.basename(gsPath) };
//         const jobId = randomUUID();
//         jobs[jobId] = { status: 'processing', progress: { message: 'Iniciando...', processed: 0, total: 0 } };
//         res.writeHead(200, { 'Content-Type': 'application/json' });
//         res.end(JSON.stringify({ jobId }));
//         processUpscale(jobId, file);
//     }
//     else if (req.method === 'GET' && req.url.startsWith('/api/progress/')) {
//         const jobId = req.url.split('/')[3];
//         if (!jobs[jobId]) { res.writeHead(404); res.end('Job not found'); return; }
//         res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
//         const intervalId = setInterval(() => {
//             const job = jobs[jobId];
//             if (!job) { clearInterval(intervalId); res.end(); return; }
//             res.write(`data: ${JSON.stringify({ status: job.status, ...job.progress })}\n\n`);
//             if (job.status === 'complete' || job.status === 'error') {
//                 clearInterval(intervalId);
//                 delete jobs[jobId];
//                 res.end();
//             }
//         }, 1000);
//         req.on('close', () => clearInterval(intervalId));
//     }
//     else if (req.method === 'GET') {
//         const requestedPath = (req.url === '/') ? path.join('src', 'views', 'index.html') : path.join('src', decodeURIComponent(req.url));
//         const filePath = path.join(__dirname, requestedPath);
//         fs.readFile(filePath, (err, content) => {
//             if (err) { res.writeHead(404); res.end('404 Not Found'); return; }
//             const mime = {
//                 '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json',
//                 '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml'
//             };
//             const ext = path.extname(filePath);
//             res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream' });
//             res.end(content);
//         });
//     } else {
//         res.writeHead(404);
//         res.end();
//     }
// }).listen(PORT, () => console.log(`Servidor iniciado en http://localhost:${PORT}`));