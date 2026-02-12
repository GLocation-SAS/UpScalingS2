const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;

const URLS = {
    token: 'https://gentoken-960956212831.us-central1.run.app',
    upload: 'https://uss2-upload-960956212831.us-central1.run.app',
};

const BUCKET_NAME = "uss2-images/sentinel";

// HELPERS HTTP
function makeHttpRequest(url, options, bodyBuffer = null) {
    const protocol = url.startsWith('https') ? https : http;
    return new Promise((resolve, reject) => {
        const req = protocol.request(url, options, (res) => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const responseBody = Buffer.concat(chunks).toString('utf8');
                resolve({ statusCode: res.statusCode, body: responseBody, headers: res.headers });
            });
        });

        req.on('error', (err) => {
            console.error(`Error de red hacia ${url}:`, err.message);
            reject(err);
        });

        if (bodyBuffer) {
            req.end(bodyBuffer);
        } else {
            req.end();
        }
    });
}

function bufferSplit(buffer, separator) {
    const res = [];
    let start = 0;
    let index = 0;
    while ((index = buffer.indexOf(separator, start)) !== -1) {
        res.push(buffer.subarray(start, index));
        start = index + separator.length;
    }
    res.push(buffer.subarray(start));
    return res;
}

// PARSER MULTIPART
function parseMultipartIncoming(req) {
    return new Promise((resolve) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            const buffer = Buffer.concat(chunks);
            const contentType = req.headers['content-type'] || '';

            if (!contentType.includes('boundary=')) return resolve({ fields: {}, files: [] });

            let boundary = contentType.split('boundary=')[1];
            if (boundary.includes(';')) boundary = boundary.split(';')[0];
            boundary = boundary.trim();

            const separator = Buffer.from(`--${boundary}`);
            const parts = bufferSplit(buffer, separator);

            const fields = {};
            const files = [];

            parts.forEach(part => {
                const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'));
                if (headerEnd === -1) return;

                const headers = part.subarray(0, headerEnd).toString();
                const bodyStart = headerEnd + 4;
                let bodyEnd = part.length;
                if (part.length > 2 && part[part.length - 2] === 13) bodyEnd -= 2;

                const content = part.subarray(bodyStart, bodyEnd);

                const nameMatch = headers.match(/name="([^"]+)"/);
                const filenameMatch = headers.match(/filename="([^"]+)"/);

                if (filenameMatch) {
                    files.push({ filename: filenameMatch[1], buffer: content });
                } else if (nameMatch) {
                    fields[nameMatch[1]] = content.toString().trim();
                }
            });
            resolve({ fields, files });
        });
    });
}

// FUNCIONES DE SERVICIO
async function uploadToDocs(file) {
    const boundary = 'NodeBoundary' + Date.now();
    const crlf = '\r\n';

    const head = `--${boundary}${crlf}Content-Disposition: form-data; name="files"; filename="${file.filename}"${crlf}Content-Type: application/octet-stream${crlf}${crlf}`;
    const foot = `${crlf}--${boundary}--${crlf}`;

    const payload = Buffer.concat([Buffer.from(head), file.buffer, Buffer.from(foot)]);

    const res = await makeHttpRequest(`${URLS.upload}?action=upload`, {
        method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': payload.length }
    }, payload);

    if (res.statusCode !== 200) throw new Error(`Upload error (${res.statusCode}): ${res.body}`);
    return `gs://${BUCKET_NAME}/${file.filename}`;
}

async function deleteFromDocs(gsPath) {
    if (!gsPath) return;
    const jsonString = JSON.stringify({ path: gsPath });
    const payloadBuffer = Buffer.from(jsonString, 'utf8');
    try {
        await makeHttpRequest(`${URLS.upload}?action=delete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': payloadBuffer.length }
        }, payloadBuffer);
    } catch (e) { console.error(`Delete error: ${e.message}`); }
}

async function callBusinessService(url, payloadObj) {
    // OBTENER TOKEN
    const tokenUrl = `${URLS.token}/?url=${encodeURIComponent(url)}`;
    console.log(`[TOKEN] Solicitando para: ${url}`);

    const tRes = await makeHttpRequest(tokenUrl, { method: 'GET' });

    if (tRes.statusCode !== 200) {
        throw new Error(`Error obteniendo token (${tRes.statusCode}): ${tRes.body}`);
    }

    let tokenData;
    try {
        tokenData = JSON.parse(tRes.body);
    } catch (e) {
        throw new Error(`Respuesta de token inválida (No JSON): ${tRes.body}`);
    }

    if (!tokenData.token) {
        throw new Error(`Respuesta de token sin campo 'token': ${JSON.stringify(tokenData)}`);
    }

    const token = tokenData.token;

    // LLAMAR AL SERVICIO DE NEGOCIO
    const jsonString = JSON.stringify(payloadObj);
    const payloadBuffer = Buffer.from(jsonString, 'utf8');

    return makeHttpRequest(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
            'Content-Length': payloadBuffer.length
        }
    }, payloadBuffer);
}

// SERVIDOR PRINCIPAL

http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // HELPER PARA MANEJAR RUTAS DE NEGOCIO
    const handleBusinessRoute = async (serviceUrl, processPayloadFunc, responseType = 'text/csv', requiredFields = []) => {
        let uploadedPaths = [];
        try {
            const { fields, files } = await parseMultipartIncoming(req);

            // Validar campos requeridos
            for (const field of requiredFields) {
                if (!fields[field]) throw new Error(`Falta campo requerido: ${field}`);
            }

            // Validaciones específicas
            if (serviceUrl === URLS.evaluacion && files.length === 0) throw new Error("Faltan archivos para evaluación");
            if (serviceUrl === URLS.epicas && files.length === 0 && (!fields.indicaciones || fields.indicaciones.trim() === '')) throw new Error("Se requiere archivo o indicaciones");

            // Subir archivos
            if (files.length > 0) {
                console.log(`Subiendo ${files.length} archivos...`);
                uploadedPaths = await Promise.all(files.map(uploadToDocs));
            }

            // Construir Payload específico
            const payload = processPayloadFunc(fields, uploadedPaths);

            console.log(`Llamando servicio... Payload keys: ${Object.keys(payload)}`);
            const apiRes = await callBusinessService(serviceUrl, payload);

            res.writeHead(apiRes.statusCode, { 'Content-Type': responseType });
            res.end(apiRes.body);

        } catch (e) {
            console.error("Error en ruta:", e.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        } finally {
            if (uploadedPaths.length > 0) {
                uploadedPaths.forEach(deleteFromDocs);
            }
        }
    };

    // EVALUACIÓN
    if (req.method === 'POST' && req.url === '/api/evaluar') {
        await handleBusinessRoute(URLS.evaluacion, (fields, paths) => ({
            urls: paths,
            riesgo: parseInt(fields.riesgo)
        }), 'application/json', ['riesgo']);
    }

    // VISTAS ESTÁTICOS
    else if (req.method === 'GET') {
        const filePath = path.join('./src', req.url === '/' ? '/views/index.html' : req.url);

        fs.readFile(filePath, (err, content) => {
            if (err) {
                console.log('No encontrado:', filePath);
                res.writeHead(404);
                res.end('404 Not Found');
                return;
            }

            const ext = path.extname(filePath).toLowerCase();

            const mime = {
                '.html': 'text/html',
                '.css': 'text/css',
                '.js': 'application/javascript',
                '.json': 'application/json',
                '.png': 'image/png',
                '.jpg': 'image/jpeg',
                '.svg': 'image/svg+xml'
            };

            res.writeHead(200, {
                'Content-Type': mime[ext] || 'application/octet-stream'
            });

            res.end(content);
        });
    } else { res.writeHead(404); res.end(); }

}).listen(PORT, () => console.log(`Server en http://localhost:${PORT}`));