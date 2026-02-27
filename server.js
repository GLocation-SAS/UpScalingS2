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
const API_KEY = process.env.API_KEY;

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
        "script-src 'self' 'unsafe-inline' https://unpkg.com https://maps.googleapis.com https://places.googleapis.com blob:; " +
        "style-src 'self' 'unsafe-inline' https://unpkg.com https://fonts.googleapis.com; " +
        "font-src 'self' https://fonts.gstatic.com; " +
        "connect-src 'self' https://mt1.google.com https://maps.googleapis.com https://places.googleapis.com https://storage.googleapis.com https://unpkg.com; " +
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
                let boundaryStr = contentType.split('boundary=')[1];
                if (boundaryStr) boundaryStr = boundaryStr.split(';')[0].trim();
                const boundary = `--${boundaryStr}`;
                const parts = bufferSplit(buffer, Buffer.from(boundary));
                const files = [];
                const fields = {};
                for (const part of parts) {
                    const headerEndIndex = part.indexOf('\r\n\r\n');
                    if (headerEndIndex === -1) continue;
                    const headers = part.subarray(0, headerEndIndex).toString();
                    const filenameMatch = headers.match(/filename="([^"]+)"/);
                    const nameMatch = headers.match(/name="([^"]+)"/);
                    if (filenameMatch) {
                        let content = part.subarray(headerEndIndex + 4);
                        if (content.length >= 2 && content[content.length - 2] === 0x0d && content[content.length - 1] === 0x0a) {
                            content = content.subarray(0, content.length - 2);
                        }
                        files.push({ filename: filenameMatch[1], buffer: content });
                    } else if (nameMatch) {
                        let content = part.subarray(headerEndIndex + 4);
                        if (content.length >= 2 && content[content.length - 2] === 0x0d && content[content.length - 1] === 0x0a) {
                            content = content.subarray(0, content.length - 2);
                        }
                        fields[nameMatch[1]] = content.toString().trim();
                    }
                }
                resolve({ fields, files });
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

async function callBusinessService(url, payloadObj, attempts = 3) {
    const tokenUrl = `${URLS.token}/?url=${encodeURIComponent(url)}`;

    for (let i = 0; i < attempts; i++) {
        try {
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

            if (serviceResponse.status === 503 || serviceResponse.status === 429) {
                console.warn(`[IA SERVICE] Intento ${i + 1} fallido (Status ${serviceResponse.status}). Reintentando en 3s...`);
                await new Promise(r => setTimeout(r, 3000));
                continue;
            }

            if (!serviceResponse.ok) {
                const errorBody = await serviceResponse.text();
                throw new Error(`IA Service Error (${serviceResponse.status}): ${errorBody}`);
            }
            return serviceResponse.json();
        } catch (err) {
            if (i === attempts - 1) throw err;
            console.warn(`[IA SERVICE] Error en intento ${i + 1}: ${err.message}. Reintentando...`);
            await new Promise(r => setTimeout(r, 2000));
        }
    }
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

// --- CONTEXTO DE ESCALA ESPACIAL PARA PROMPTS ---
// Genera una cláusula que le indica al modelo de IA el nivel de zoom percibido
// y las dimensiones reales del área, para evitar que alucine micro-detalles.
function buildScaleClause(scaleContext) {
    if (!scaleContext) return '';

    const zoom = scaleContext.zoom;
    const dims = scaleContext.dimensions;
    const SENTINEL2_GSD = 10;

    // Determinar la escala del área capturada usando las dimensiones reales en metros
    let areaScale = 'medium';
    if (dims) {
        const maxSide = Math.max(dims.width, dims.height);
        if (maxSide > 5000) areaScale = 'regional';        // > 5km de lado
        else if (maxSide > 2000) areaScale = 'medium';      // 2-5km
        else if (maxSide > 500) areaScale = 'local';         // 500m - 2km
        else areaScale = 'micro';                             // < 500m
    }

    let scaleDescription = '';
    let detailGuidance = '';

    switch (areaScale) {
        case 'regional':
            scaleDescription = `a regional-scale overview covering a large area (${SENTINEL2_GSD}m/px native Sentinel-2 resolution)`;
            detailGuidance = `At this scale with ${SENTINEL2_GSD}m/px source data, only large-scale land cover patterns, major water bodies, and regional terrain are visible. Individual buildings, roads, or vegetation patches should NOT be resolved or inferred. The output should resemble a cleaner, sharper version of the same regional view — NOT a close-up aerial photograph.`;
            break;
        case 'medium':
            scaleDescription = `a medium-scale satellite view (${SENTINEL2_GSD}m/px native Sentinel-2 resolution)`;
            detailGuidance = `At this scale with ${SENTINEL2_GSD}m/px source data, urban blocks and agricultural fields are distinguishable as general patches, but individual buildings are NOT distinctly resolved. Only macro-structural patterns (large building clusters, major roads, field boundaries) are visible. Do NOT infer individual rooftops, narrow streets, tree canopy textures, or fine vegetation details. The output should look like a cleaner Sentinel-2 image with enhanced contrast and edge definition — NOT like a Google Earth close-up.`;
            break;
        case 'local':
            scaleDescription = `a local-scale satellite view of a small area (${SENTINEL2_GSD}m/px native Sentinel-2 resolution)`;
            detailGuidance = `Even though this covers a small area, the source data is still only ${SENTINEL2_GSD}m/px (Sentinel-2). At this resolution, the input image contains very few pixels of actual information. Urban blocks and road corridors may be partially distinguishable as blurred patches, but individual rooftops, narrow streets, and tree canopy details are NOT present in the source. Do NOT generate details that the ${SENTINEL2_GSD}m/px source cannot plausibly support. The output should look like an enhanced Sentinel-2 crop — NOT like a submeter aerial photograph.`;
            break;
        case 'micro':
            scaleDescription = `a very small area crop (${SENTINEL2_GSD}m/px native Sentinel-2 resolution, critically low pixel count)`;
            detailGuidance = `CRITICAL: This is a very small area being viewed at high visual zoom, but the Sentinel-2 source data is only ${SENTINEL2_GSD}m/px. The input image contains extremely few meaningful pixels. At this resolution, almost no fine detail exists in the source data. Do NOT hallucinate buildings, roads, vegetation textures, or any fine-scale features. The output should be a modestly enhanced, cleaner version of the blurry input — any detailed features would be pure fabrication.`;
            break;
    }

    let dimensionInfo = '';
    if (dims) {
        const widthKm = (dims.width / 1000).toFixed(2);
        const heightKm = (dims.height / 1000).toFixed(2);
        const areaKm2 = (dims.area / 1e6).toFixed(2);
        const approxPixels = Math.round(dims.width / SENTINEL2_GSD);
        const approxPixelsH = Math.round(dims.height / SENTINEL2_GSD);
        dimensionInfo = `The captured area covers approximately ${widthKm} km × ${heightKm} km (${areaKm2} km²). At ${SENTINEL2_GSD}m/px Sentinel-2 resolution, this area contains approximately ${approxPixels} × ${approxPixelsH} actual data pixels.`;
    }

    const clause = `

SPATIAL SCALE CONTEXT (CRITICAL — MUST FOLLOW):
The input Sentinel-2 image has a FIXED native resolution of ${SENTINEL2_GSD} meters per pixel. This resolution does NOT change regardless of the size of the captured area or the viewer zoom level.
This corresponds approximately to ${scaleDescription}.
${dimensionInfo}
${detailGuidance}
IMPORTANT: The "1m equivalent GSD" target is PERCEPTUAL and STRUCTURAL only — it means producing a cleaner, higher-contrast version with better-defined boundaries. It does NOT mean recovering true sub-meter satellite imagery. Do NOT generate output that looks like a high-resolution aerial photograph or a Google Earth zoom level 19–20 image. The level of detail in the output MUST be consistent with what a ${SENTINEL2_GSD}m/px source can plausibly support after enhancement.
WARNING: If a secondary reference image (map tile) is provided, be aware that this reference may show MUCH more spatial detail than the ${SENTINEL2_GSD}m/px Sentinel-2 source can support. Use the reference ONLY for geographic orientation (understanding where urban areas, roads, and vegetation boundaries are located). Do NOT copy or replicate the reference image's level of detail, texture quality, or visual resolution.
`;

    console.log(`[SCALE] 📐 Cláusula de escala generada — Área: ${areaScale}, Sentinel-2 GSD: ${SENTINEL2_GSD}m/px, Zoom mapa: ${zoom}`);
    console.log(clause);

    return clause;
}

async function processUpscale(jobId, file, model, mapReferenceUrl = null, customPrompt = null, scaleContext = null) {
    let prompt = customPrompt || '';

    if (!prompt) {
        switch (model) {
            case 'upscaling':
                prompt = `
Positive Prompt
Generate a professional satellite orthophoto via super-resolution enhancement, using exclusively the provided Sentinel-2 input image as the absolute source of information.
Upscale from native 10 meters per pixel to an equivalent 1 meter Ground Sampling Distance (GSD) through coherent structural refinement, balanced edge enhancement, and texture detailing, inferring only plausible macro-details directly supported by the original data without introducing nonexistent elements or artificial fine-scale features.
Maintain strict nadir view with pure orthographic satellite perspective.
Enhance overall visual clarity with high sharpness, coherent separation of land covers through distinct boundaries, structural definition of major edges with crisp, natural outlines, and spatial readability to achieve detailed, photorealistic representation without any blur, softening, or loss of contrast.
Strictly preserve the exact geographic distribution, proportions, and color tones of:

Urban areas with building clusters and roof variations
Natural vegetation patches with canopy textures
Agricultural zones and fields with soil and crop patterns
Water bodies (if present) with accurate reflections and edges
Road infrastructure and alignments with smooth curves
Refine urban block outlines, primary road alignments, and land cover boundaries with precise, high-contrast sharpness while adhering fully to the original Sentinel-2 geometry, morphology, and spectral information.
Render continuous surfaces smoothly yet with realistic, varied textures:
Organized agricultural field patterns showing subtle soil variations
Uniform but detailed forest canopies with natural density and shading only in areas with evident large vegetation masses
Precise water body contours with subtle wave or ripple inferences if supported
Well-defined urban blocks with generalized roof materials without any geometric alterations
Apply coherent structural generalization and simplification, avoiding artistic stylization, while ensuring high-detail textures for all land covers, strong contrast for visibility of structures amid vegetation, and color fidelity to the original image.
Use natural photorealistic lighting with subtle shadows and highlights based on inferred terrain, mimicking high-resolution satellite imagery from sources like Google Earth.
Ensure absolute geographic consistency, high fidelity to the original terrain features, and no scene reinterpretation, territorial reorganization, spatial distortions, or color shifts.

SPATIAL SCALE CONTEXT (CRITICAL — MUST FOLLOW):
The input Sentinel-2 image has a FIXED native resolution of 10 meters per pixel. This resolution does NOT change regardless of the size of the captured area or the viewer zoom level.
The input image provided to you may have been digitally resized (upsampled) to a larger pixel dimension for processing convenience (e.g., 1024x1024 pixels). However, this resizing does not add any new information; the effective resolution is still the native 10m/px. Treat the input as a blurred, low-information image and do not interpret the blurred patterns as high-detail features. Only enhance clarity without adding unsupported details.
This corresponds approximately to a very small area crop (10m/px native Sentinel-2 resolution, critically low pixel count).
The captured area covers approximately 0.5 km × 0.5 km (0.25 km²). At 10m/px Sentinel-2 resolution, this area contains approximately 50 × 50 actual data pixels.
CRITICAL: This is a very small area being viewed at high visual zoom, but the Sentinel-2 source data is only 10m/px. The input image contains extremely few meaningful pixels. At this resolution, almost no fine detail exists in the source data. Do NOT hallucinate buildings, roads, vegetation textures, or any fine-scale features. The output should be a modestly enhanced, cleaner version of the blurry input — any detailed features would be pure fabrication.
IMPORTANT: The "1m equivalent GSD" target is PERCEPTUAL and STRUCTURAL only — it means producing a cleaner, higher-contrast version with better-defined boundaries. It does NOT mean recovering true sub-meter satellite imagery. Do NOT generate output that looks like a high-resolution aerial photograph or a Google Earth zoom level 19–20 image. The level of detail in the output MUST be consistent with what a 10m/px source can plausibly support after enhancement.
WARNING: If a secondary reference image (map tile) is provided, be aware that this reference may show MUCH more spatial detail than the 10m/px Sentinel-2 source can support. Use the reference ONLY for geographic orientation (understanding where urban areas, roads, and vegetation boundaries are located). Do NOT copy or replicate the reference image's level of detail, texture quality, or visual resolution. For park captures or areas with sparse structures, strictly maintain open green spaces, paths, and sparse structures without expanding into urban or agricultural features or inventing elements like circular structures or rectangular slabs not evident in the source.
Negative Prompt
High-frequency noise, artificial micro-textures, excessive oversharpening leading to halos, pixel grid artifacts, visual distortions, dithering, blurring, softening of edges, low contrast, undifferentiated smooth surfaces.
Fine details or objects smaller than 20 meters, including:

Individual vehicles or cars
People
Street furniture
Small shrubs or isolated plants
Minor architectural elements
Invented dense forests within urban zones.
Unauthorized vegetation expansion into non-vegetated areas.
Artificial urbanization of rural or natural zones.
Inaccurate blending or mixing of land cover classes.
Any structural reinterpretations, additions, or territorial reconfigurations not present in the original Sentinel-2 image.
Unnatural edge enhancements that create artifacts, washed-out colors, over-saturated greens, lack of texture in vegetation or fields, indistinct building shapes, hallucinated cityscapes or fields in park areas, sub-meter aerial photo styles inconsistent with 10m/px source data, invented circular or rectangular structures, over-interpretation of blurred patterns as detailed features.
                    `;
                // Inyectar contexto de escala espacial al prompt (solo para modelos que no son custom)
                if (scaleContext) {
                    prompt += buildScaleClause(scaleContext);
                }
                break;
            case 'upscaling_google_maps':
                prompt = `
                                               
POSITIVO:
Professional satellite orthophoto super-resolution enhancement, Sentinel-2 multispectral source imagery. Upscaling from 10m/px to 1m/px GSD. Strict nadir (top-down) view, zero perspective distortion. Primary reference: Sentinel-2 input image — preserve its exact land cover distribution, spectral tone, and spatial layout. Secondary reference image (map tile) provided solely for geographic context and urban boundary orientation — do NOT replicate its style, colors, or symbology. Photorealistic coherent land cover textures: urban blocks with road grid, rooftops, bare soil, agricultural field patterns, water bodies with natural color. Natural diffuse lighting consistent with satellite acquisition. Geographic and topographic fidelity. Vegetation rendered only where spectrally consistent with input image.

NEGATIVO:
Map tile aesthetics, cartographic colors, stylized road lines, vector symbology, OpenStreetMap or Google Maps visual style. Misplaced vegetation: forest canopy, dense tree clusters, or woodland textures over urban zones, industrial areas, or open land not present in Sentinel-2 input. High-frequency noise, invented micro-details, individual vehicles, pedestrians, street furniture. Sharp edges on objects under 20m. Visual artifacts, dithering, checkerboard patterns, over-sharpened micro-textures, hallucinated urban clutter, distorted geometry, blurry halos, upscaling artifacts.

INSTRUCCIÓN DE REFERENCIA:
The Sentinel-2 image is the ground truth source. Enhance its resolution and clarity while maintaining exact fidelity to its land cover, color palette, and structure. The map tile reference is a secondary orientation aid only — use it to understand approximate urban boundaries, do not transfer its visual style. If vegetation appears in the map tile over areas that show urban or bare land in the Sentinel-2 image, ignore it entirely.
                    `;
                if (scaleContext) {
                    prompt += buildScaleClause(scaleContext);
                }
                break;


            case 'upscaling_ndvi':
                prompt = `
                        Positive Prompt

Generate a high-definition super-resolution enhancement of a scientific NDVI (Normalized Difference Vegetation Index) map derived from Sentinel-2 data.

The input image is a quantitative NDVI raster, not a natural-color image.

Upscale from the original spatial resolution through coherent structural refinement while strictly preserving:

Original NDVI value distribution

Relative intensity relationships

Spatial patterns of vegetation density

True boundaries between vegetated and non-vegetated areas

The enhancement must improve:

Edge clarity between NDVI zones

Spatial readability of agricultural parcels

Definition of vegetation gradients

Continuity of forest masses

Boundary precision between crops, bare soil, and urban surfaces

Maintain the exact scientific NDVI color scale, ranging from:

White / light brown (low or negative NDVI, barren or built areas)

Light green (moderate vegetation)

Dark green (high vegetation density)

Do NOT modify, reinterpret, stretch, normalize, or remap the NDVI values.
Do NOT apply artistic color grading.

The output must remain a scientific NDVI visualization with enhanced spatial clarity, not an RGB or photorealistic image.

The spatial scale corresponds to medium-resolution satellite data (approximately 10 meters per pixel).
Enhancement must remain consistent with this observation scale and must not introduce sub-pixel vegetation details that cannot be supported by the original data.

Preserve geographic consistency, vegetation distribution, and spectral integrity.

🔹 Negative Prompt

Natural color rendering, RGB photorealism, satellite true-color imagery, terrain shading, artificial shadows.

Invented vegetation patches, artificial crop rows, fabricated forest density changes, exaggerated canopy textures.

Modification of NDVI value relationships, histogram stretching, contrast over-enhancement altering scientific meaning.

Color palette changes, gradient remapping, oversaturated greens, unrealistic tonal transitions.

High-frequency noise, pixel grid artifacts, oversharpening halos, blurred zone transitions, artificial smoothing that removes real vegetation gradients.

Introduction of buildings, cars, roads, or urban objects not encoded in NDVI data.

Any reinterpretation of land cover beyond what is spectrally represented in the original NDVI raster.
                    `;
                break;
            case 'building_footprint':
                prompt = 'a satellite image highlighting building footprints in bright red, high contrast, clearly defined edges';
                break;
            case 'ways':
                prompt = 'a satellite image with all roads and paths highlighted in bright yellow, high contrast, clean lines';
                break;
            case 'forest':
                prompt = 'a satellite image emphasizing forested areas in vibrant green, high contrast, distinguishing between different types of vegetation';
                break;
            case 'trees':
                prompt = 'a satellite image where individual trees or small clusters of trees are clearly visible and distinct';
                break;
            default:
                console.warn(`[PROCESS] Modelo desconocido '${model}'. Usando prompt de 'upscaling' por defecto.`);
                prompt = 'a satellite image with 4x resolution, high quality, high detail, sharp focus, 8k, UHD, professional';
        }
    }

    console.log(`[PROCESS] Job ${jobId} usando modelo: '${model}'`);
    console.log(`[PROCESS] Prompt generado: "${prompt}"`);

    try {
        updateJobProgress(jobId, { message: "Leyendo metadatos GeoTIFF..." });
        let realBounds = null;

        try {
            let arrayBuffer;
            if (file.buffer instanceof Buffer) {
                arrayBuffer = file.buffer.buffer.slice(file.buffer.byteOffset, file.buffer.byteOffset + file.buffer.byteLength);
            } else if (file.buffer instanceof ArrayBuffer) {
                arrayBuffer = file.buffer;
            } else {
                arrayBuffer = Buffer.from(file.buffer).buffer;
            }

            const tiff = await fromArrayBuffer(arrayBuffer);
            const image = await tiff.getImage();
            try {
                const bbox = image.getBoundingBox();
                realBounds = [[bbox[0], bbox[1]], [bbox[2], bbox[3]]];
                console.log(`[PROCESS] Coordenadas GeoTIFF extraídas:`, realBounds);
            } catch (bboxError) {
                console.warn(`[PROCESS] Advertencia: No se pudieron extraer coordenadas del GeoTIFF (${bboxError.message}). Se usarán coordenadas por defecto.`);
                realBounds = [[-74.20, 4.60], [-74.00, 4.80]];
            }
        } catch (geotiffError) {
            console.warn("[PROCESS] Advertencia: No se pudo leer como GeoTIFF. Procesando como imagen TIFF estándar.", geotiffError.message);
            realBounds = [[-74.20, 4.60], [-74.00, 4.80]];
        }

        const TILE_SIZE = 1024;
        // Usar imageBuffer (JPEG ya redimensionado a 1024x1024 por emuclient) si está disponible.
        // Esto garantiza que la IA recibe una imagen de resolución adecuada, no el GeoTIFF crudo de ~170px.
        const sourceBuffer = file.imageBuffer || file.buffer;
        const sharpImage = sharp(sourceBuffer);
        const jpegBuffer = await sharpImage.jpeg({ quality: 90 }).toBuffer();

        const originalJpegPath = `${BUCKET_BASE_PATH}/original_jpeg/${jobId}.jpeg`;
        await uploadToDocs(jpegBuffer, originalJpegPath);
        const originalPublicUrl = `https://storage.googleapis.com/${BUCKET_NAME}/${originalJpegPath}`;

        let pureSentinelPublicUrl = originalPublicUrl;
        if (file.imageBuffer && file.buffer) {
            try {
                const pureSentinelBuffer = await sharp(file.buffer).resize(1024, 1024, { fit: 'fill' }).jpeg({ quality: 80 }).toBuffer();
                const pureSentinelPath = `${BUCKET_BASE_PATH}/pure_sentinel_jpeg/${jobId}.jpeg`;
                await uploadToDocs(pureSentinelBuffer, pureSentinelPath);
                pureSentinelPublicUrl = `https://storage.googleapis.com/${BUCKET_NAME}/${pureSentinelPath}`;
            } catch (err) {
                console.warn("[PROCESS] Advertencia: No se pudo generar pure_sentinel_jpeg, usando original_jpeg como fallback", err.message);
            }
        }
        const jpegImage = sharp(jpegBuffer);
        const metadata = await jpegImage.metadata();
        const width = metadata.width;
        const height = metadata.height;

        if (!width || !height) {
            throw new Error("No se pudieron determinar las dimensiones de la imagen.");
        }

        console.log(`[PROCESS] Dimensiones de imagen: ${width}x${height}`);

        // Cargar imagen de referencia si existe
        let mapReferenceImage = null;
        let mapMetadata = null;
        console.log(`\n${'─'.repeat(60)}`);
        console.log(`[PROCESS] 🔍 VERIFICACIÓN DE IMAGEN DE REFERENCIA`);
        console.log(`[PROCESS]    Modelo: '${model}'`);
        console.log(`[PROCESS]    mapReferenceUrl recibido: ${mapReferenceUrl || 'null/undefined (NO SE ENVIARÁ REFERENCIA)'}`);
        if (mapReferenceUrl) {
            try {
                console.log(`[PROCESS] ⬇️  Descargando imagen de referencia desde: ${mapReferenceUrl}`);
                const mapBuffer = await downloadFromUrl(mapReferenceUrl);
                mapReferenceImage = sharp(mapBuffer);
                mapMetadata = await mapReferenceImage.metadata();
                console.log(`[PROCESS] ✅ Referencia cargada correctamente. Dimensiones: ${mapMetadata.width}x${mapMetadata.height}`);
            } catch (err) {
                console.warn(`[PROCESS] ⚠️  No se pudo cargar la imagen de referencia (${err.message}). Se continuará SOLO con Sentinel-2.`);
            }
        } else {
            console.log(`[PROCESS] ❌ Sin imagen de referencia: cada tile se enviará a la IA SOLO con Sentinel-2.`);
        }
        console.log(`${'─'.repeat(60)}\n`);

        const tiles = [];
        for (let y = 0; y < height; y += TILE_SIZE) {
            for (let x = 0; x < width; x += TILE_SIZE) {
                const tileWidth = Math.min(TILE_SIZE, width - x);
                const tileHeight = Math.min(TILE_SIZE, height - y);
                // Asegurar que las dimensiones sean positivas y mayores que cero
                if (tileWidth > 0 && tileHeight > 0) {
                    tiles.push({ x, y, width: tileWidth, height: tileHeight });
                }
            }
        }
        updateJobProgress(jobId, { total: tiles.length, processed: 0 });

        let originalsUploaded = 0;
        const originalUploadPromises = tiles.map(async (tile) => {
            const tileBuffer = await jpegImage.extract({ left: tile.x, top: tile.y, width: tile.width, height: tile.height }).toBuffer();
            const destPath = `${BUCKET_BASE_PATH}/grillas_originales/${jobId}/tile_${tile.x}_${tile.y}.jpeg`;
            const gsPath = await uploadToDocs(tileBuffer, destPath);

            let referenceGsPath = null;
            if (mapReferenceImage && mapMetadata) {
                try {
                    // Calcular escala entre Sentinel-2 (width/height) y Referencia (mapMetadata.width/height)
                    const scaleX = mapMetadata.width / width;
                    const scaleY = mapMetadata.height / height;

                    const refX = Math.floor(tile.x * scaleX);
                    const refY = Math.floor(tile.y * scaleY);
                    const refW = Math.floor(tile.width * scaleX);
                    const refH = Math.floor(tile.height * scaleY);

                    // Asegurar que la extracción esté dentro de los límites de la imagen de referencia
                    const safeRefX = Math.max(0, Math.min(refX, mapMetadata.width - 1));
                    const safeRefY = Math.max(0, Math.min(refY, mapMetadata.height - 1));
                    const safeRefW = Math.min(refW, mapMetadata.width - safeRefX);
                    const safeRefH = Math.min(refH, mapMetadata.height - safeRefY);

                    if (safeRefW > 0 && safeRefH > 0) {
                        const refTileBuffer = await mapReferenceImage.extract({
                            left: safeRefX,
                            top: safeRefY,
                            width: safeRefW,
                            height: safeRefH
                        }).toBuffer();
                        const refDestPath = `${BUCKET_BASE_PATH}/grillas_referencia/${jobId}/tile_${tile.x}_${tile.y}.jpeg`;
                        referenceGsPath = await uploadToDocs(refTileBuffer, refDestPath);
                    }
                } catch (err) {
                    console.warn(`[PROCESS] Error extrayendo tile de referencia en x:${tile.x}, y:${tile.y}: ${err.message}`);
                }
            }

            originalsUploaded++;
            updateJobProgress(jobId, { message: `Subiendo grilla original ${originalsUploaded}/${tiles.length}`, processed: originalsUploaded });
            return { gsPath, referenceGsPath };
        });
        const tileGsPaths = await Promise.all(originalUploadPromises);

        let tilesImproved = 0;
        updateJobProgress(jobId, { message: `Mejorando grillas con IA...`, processed: 0 });
        const upgradePromises = tileGsPaths.map((paths, idx) => {
            const hasRef = !!paths.referenceGsPath;
            console.log(`[IA UPGRADE] Tile ${idx + 1}/${tileGsPaths.length} → ${hasRef ? '✅ CON referencia' : '❌ SIN referencia'}`);
            console.log(`[IA UPGRADE]   Base      : ${paths.gsPath}`);
            console.log(`[IA UPGRADE]   Referencia: ${paths.referenceGsPath || 'null (no se enviará 2da imagen a la IA)'}`);
            console.log(`[IA UPGRADE]   Prompt    : "${prompt.trim().substring(0, 80)}..."`);
            return callBusinessService(URLS.upscale, {
                imagen_gs: paths.gsPath,
                imagen_referencia_gs: paths.referenceGsPath,
                prompt: prompt
            }).then(result => {
                tilesImproved++;
                updateJobProgress(jobId, { message: `Mejorando grilla ${tilesImproved}/${tiles.length}`, processed: tilesImproved });
                return result;
            });
        });
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

        console.log(`=========================================`);
        console.log(`[RESULTS] Proceso completado para ${jobId}.`);
        console.log(`[RESULTS] ⬆️ Enviada originalmente a IA (Original JPEG): ${originalPublicUrl}`);
        console.log(`[RESULTS] 🌍 Imagen GPS cruda separada (Pure Sentinel): ${pureSentinelPublicUrl}`);
        console.log(`[RESULTS] ✨ Imagen mejorada generada (PNG visor): ${improvedPngPublicUrl}`);
        console.log(`[RESULTS] 🗺️ Imagen mejorada generada (GeoTIFF descarga): ${finalTifPublicUrl}`);
        if (jobs[jobId].ndviJpegUrl) console.log(`[RESULTS] 🌱 Imagen NDVI disponible: ${jobs[jobId].ndviJpegUrl}`);
        if (jobs[jobId].satellitePreviewUrl) console.log(`[RESULTS] 📡 Mapa Estándar disponible: ${jobs[jobId].satellitePreviewUrl}`);
        console.log(`=========================================`);

        jobs[jobId].result = {
            improvedPngUrl: improvedPngPublicUrl,
            improvedTifUrl: finalTifPublicUrl,
            originalJpegUrl: originalPublicUrl,
            pureSentinelJpegUrl: pureSentinelPublicUrl,
            bounds: realBounds,
            satellitePreviewUrl: jobs[jobId].satellitePreviewUrl || null,
            satelliteTiffUrl: jobs[jobId].satelliteTiffUrl || null,
            satelliteBbox: jobs[jobId].satelliteBbox || null,
            ndviJpegUrl: jobs[jobId].ndviJpegUrl || null
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
        const { files, fields } = await parseMultipartIncoming(req);
        if (!files || files.length === 0) throw new Error('No se ha subido ningún archivo.');
        const model = fields.model || 'upscaling';
        const jobId = randomUUID();
        jobs[jobId] = { status: 'processing', progress: { message: 'Iniciando...', processed: 0, total: 0 } };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jobId }));
        processUpscale(jobId, files[0], model);
    } catch (e) {
        console.error("Error en /api/upscale:", e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
    }
})

app.post('/api/upscale-from-gs', async (req, res, next) => {
    try {
        const { gsPath, model } = await parseJsonBody(req);
        if (!gsPath) throw new Error('Falta el campo "gsPath" en el cuerpo de la petición.');
        const selectedModel = model || 'upscaling';
        const fileBuffer = await downloadFromGCS(gsPath);
        const file = { buffer: fileBuffer, filename: path.basename(gsPath) };
        const jobId = randomUUID();
        jobs[jobId] = { status: 'processing', progress: { message: 'Iniciando...', processed: 0, total: 0 } };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jobId }));
        processUpscale(jobId, file, selectedModel);
    } catch (e) {
        console.error("Error en /api/upscale-from-gs:", e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
    }
})

app.post('/api/upscale-from-url', async (req, res) => {
    try {
        const { imageUrl, geotiffUrl, geometry, satellitePreviewUrl, satelliteTiffUrl, model, ndviJpegUrl, captureZoom, captureDimensions, satelliteBbox } = req.body;

        if (!geotiffUrl) {
            throw new Error('La respuesta de GEE no incluyó la URL del archivo GeoTIFF (geotiffUrl). No se puede procesar.');
        }

        if (!model) {
            throw new Error('Falta el campo "model" en el cuerpo de la petición.');
        }

        // Si el usuario seleccionó mejorar el NDVI, la imagen base ES el NDVI.
        // Si no, es la imagen RGB (preferiblemente el JPEG 1024x1024).
        let inputUrl = model === 'upscaling_ndvi' && ndviJpegUrl ? ndviJpegUrl : (imageUrl || geotiffUrl);

        console.log(`[API] Descargando imagen de entrada desde: ${inputUrl}`);
        const imageResponse = await fetch(inputUrl);
        if (!imageResponse.ok) {
            throw new Error(`No se pudo descargar la imagen de entrada desde ${inputUrl}`);
        }
        const imageBuffer = await imageResponse.buffer();

        // El GeoTIFF siempre se usa SOLO para extraer las coordenadas geoespaciales (bounds)
        let geotiffBuffer = imageBuffer;
        if (inputUrl !== geotiffUrl) {
            console.log(`[API] Descargando GeoTIFF (solo para extraer coordenadas): ${geotiffUrl}`);
            const geotiffResponse = await fetch(geotiffUrl);
            if (geotiffResponse.ok) {
                geotiffBuffer = await geotiffResponse.buffer();
            } else {
                console.warn('[API] No se pudo descargar el GeoTIFF para coordenadas, se usarán por defecto.');
            }
        }

        const file = { buffer: geotiffBuffer, filename: `gee_image_${Date.now()}.tif`, imageBuffer };
        const jobId = randomUUID();
        jobs[jobId] = { status: 'processing', progress: { message: 'Iniciando desde GEE...', processed: 0, total: 0 }, satellitePreviewUrl: satellitePreviewUrl || null, satelliteTiffUrl: satelliteTiffUrl || null, ndviJpegUrl: ndviJpegUrl || null, satelliteBbox: satelliteBbox || null };

        res.json({ jobId });

        // REGLA: Solo 'upscaling_google_maps' envía imagen de referencia (tile de Google Maps).
        // Todos los demás modelos ('upscaling', 'upscaling_ndvi', etc.) trabajan SOLO con Sentinel-2.
        const MODELS_WITH_REFERENCE = ['upscaling_google_maps'];
        let referenceImage = MODELS_WITH_REFERENCE.includes(model) ? satellitePreviewUrl : null;

        console.log(`\n${'='.repeat(60)}`);
        console.log(`[API] 📋 DECISIÓN DE IMAGEN DE REFERENCIA`);
        console.log(`[API] ✅ Modelo seleccionado: '${model}'`);
        console.log(`[API] 📷 Imagen BASE que se procesará: ${imageUrl || geotiffUrl}`);
        console.log(`[API] 🗺️  satellitePreviewUrl recibido del cliente: ${satellitePreviewUrl || 'NINGUNO (null/undefined)'}`);
        console.log(`[API] 🌱 ndviJpegUrl recibido del cliente: ${ndviJpegUrl || 'NINGUNO (null/undefined)'}`);
        console.log(`[API] 📐 Modelos que admiten referencia: [${MODELS_WITH_REFERENCE.join(', ')}]`);
        if (referenceImage) {
            console.log(`[API] ✅ REFERENCIA ENVIADA a processUpscale: ${referenceImage}`);
            console.log(`[API]    ↳ Motivo: El modelo '${model}' está en la lista de modelos con referencia.`);
        } else {
            console.log(`[API] ❌ SIN REFERENCIA → processUpscale recibirá null`);
            console.log(`[API]    ↳ Motivo: El modelo '${model}' NO está en la lista de modelos con referencia.`);
        }
        console.log(`${'='.repeat(60)}\n`);

        // Contexto de escala espacial para inyectar en el prompt
        const scaleContext = (captureZoom || captureDimensions) ? { zoom: captureZoom, dimensions: captureDimensions } : null;
        if (scaleContext) {
            console.log(`[API] 🔭 Contexto de escala: Zoom ${scaleContext.zoom}, Área: ${scaleContext.dimensions ? (scaleContext.dimensions.area / 1e6).toFixed(2) + ' km²' : 'N/A'}`);
        }

        processUpscale(jobId, file, model, referenceImage, req.body.prompt, scaleContext);

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