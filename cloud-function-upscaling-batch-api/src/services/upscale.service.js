require('dotenv').config();
const sharp = require('sharp');
const fetch = require('node-fetch');
const { fromArrayBuffer } = require('geotiff');
const { uploadToDocs, downloadFromUrl } = require('../utils/gcs');
const { calculateRectangleDimensions } = require('../utils/geometry');
const { buildPrompt } = require('../utils/prompts');
const { calculateCost } = require('../utils/costs');
const { fetchGeeImage } = require('./gee.service');
const { fetchTiffCompuesto } = require('./tiff.service');
const { log, logError, timer } = require('../utils/logger');

const TOKEN_URL = process.env.TOKEN_URL;
const UPSCALE_URL = process.env.UPSCALE_URL;

const MODELS_WITH_REFERENCE = ['construcciones', 'urbano_rural', 'conurbacion', 'upscaling_google_maps', 'building_footprint', 'Custom'];

async function callBusinessService(url, payloadObj, attempts = 3) {
    const tokenUrl = `${TOKEN_URL}/?url=${encodeURIComponent(url)}`;

    for (let i = 0; i < attempts; i++) {
        try {
            const tToken = timer();
            log('TOKEN', `Obteniendo token (intento ${i + 1}/${attempts}) — ${tokenUrl}`);
            const tokenResponse = await fetch(tokenUrl);
            if (!tokenResponse.ok) {
                const errorBody = await tokenResponse.text();
                throw new Error(`Error obteniendo token (${tokenResponse.status}): ${errorBody}`);
            }
            const tokenData = await tokenResponse.json();
            if (!tokenData.token) throw new Error('Respuesta de token inválida');
            log('TOKEN', `✅ Token obtenido — ${tToken.elapsed()}`);

            const tGemini = timer();
            log('GEMINI', `Llamando servicio de mejora (intento ${i + 1}/${attempts}) — ${url}`);
            const serviceResponse = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${tokenData.token}`,
                },
                body: JSON.stringify(payloadObj)
            });

            if (serviceResponse.status === 503 || serviceResponse.status === 429) {
                log('GEMINI', `⚠️ Intento ${i + 1} fallido (HTTP ${serviceResponse.status}) — reintentando en 3s...`);
                await new Promise(r => setTimeout(r, 3000));
                continue;
            }

            if (!serviceResponse.ok) {
                const errorBody = await serviceResponse.text();
                throw new Error(`IA Service Error (${serviceResponse.status}): ${errorBody}`);
            }

            const result = await serviceResponse.json();
            log('GEMINI', `✅ Respuesta recibida — ${tGemini.elapsed()} — tokens entrada: ${result.tokens?.input || 'N/A'}, salida: ${result.tokens?.output || 'N/A'}`);
            return result;
        } catch (err) {
            if (i === attempts - 1) throw err;
            logError('GEMINI', `Error en intento ${i + 1}: ${err.message} — reintentando en 2s...`);
            await new Promise(r => setTimeout(r, 2000));
        }
    }
}

async function processUpscale({ fecha, geometry, modelo, bucket, proyecto, customPrompt }) {
    const BUCKET_BASE_PATH = 'sentinel';
    const jobId = `batch_${Date.now()}`;
    const tJob = timer();

    log('BATCH', `══════════════════════════════════════`);
    log('BATCH', `Iniciando job ${jobId}`);
    log('BATCH', `Parámetros — fecha: ${fecha}, modelo: ${modelo}, bucket: ${bucket}, proyecto: ${proyecto || 'N/A'}`);

    // Calcular dimensiones reales del área
    const dimensions = calculateRectangleDimensions(geometry);
    const areaKm2 = (dimensions.area / 1e6).toFixed(3);
    const scaleContext = { zoom: 12, dimensions };
    log('BATCH', `Área calculada: ${areaKm2} km² (${Math.round(dimensions.width)}m × ${Math.round(dimensions.height)}m)`);

    // TIFF compuesto espera un FeatureCollection, no un Polygon directo
    const geoFeatureCollection = {
        type: 'FeatureCollection',
        features: [{ type: 'Feature', properties: {}, geometry }]
    };

    // ── FASE 1: GEE + TIFF en paralelo ───────────────────────────────────────
    const tFase1 = timer();
    log('BATCH', `[FASE 1] Peticiones paralelas GEE + TIFF compuesto...`);
    const [geeData, tiffData] = await Promise.all([
        fetchGeeImage(fecha, geometry),
        fetchTiffCompuesto(geoFeatureCollection, 12, 'satellite').catch(err => {
            log('BATCH', `⚠️ TIFF compuesto falló (no crítico): ${err.message}`);
            return null;
        })
    ]);
    log('BATCH', `[FASE 1] Completada — ${tFase1.elapsed()}`);

    // Extraer URLs de GEE
    const jpegUrl = geeData.jpegUrl || geeData.imageUrl || geeData.image_url || geeData.public_url;
    const geotiffUrl = geeData.geotiffUrl;
    const ndviJpegUrl = geeData.ndviJpegUrl || null;

    if (!jpegUrl) throw new Error('GEE no retornó URL de imagen JPEG');
    if (!geotiffUrl) throw new Error('GEE no retornó URL de GeoTIFF');

    const satellitePreviewUrl = tiffData?.preview_url || null;
    const satelliteTiffUrl = tiffData?.tiff_url || null;
    log('BATCH', `TIFF compuesto — preview: ${satellitePreviewUrl || 'no disponible'}`);

    // ── FASE 2: Descargas ────────────────────────────────────────────────────
    const tFase2 = timer();
    log('BATCH', `[FASE 2] Descargando imágenes...`);
    log('BATCH', `Descargando JPEG base: ${jpegUrl}`);
    const imageBuffer = await downloadFromUrl(jpegUrl);
    log('BATCH', `JPEG descargado (${(imageBuffer.length / 1024).toFixed(1)} KB)`);

    let geotiffBuffer = imageBuffer;
    if (jpegUrl !== geotiffUrl) {
        try {
            log('BATCH', `Descargando GeoTIFF: ${geotiffUrl}`);
            geotiffBuffer = await downloadFromUrl(geotiffUrl);
            log('BATCH', `GeoTIFF descargado (${(geotiffBuffer.length / 1024).toFixed(1)} KB)`);
        } catch (err) {
            log('BATCH', `⚠️ No se pudo descargar GeoTIFF, usando JPEG para coordenadas`);
        }
    }

    // Determinar la imagen base según el modelo
    let inputUrl = modelo === 'upscaling_ndvi' && ndviJpegUrl ? ndviJpegUrl : jpegUrl;
    let inputBuffer = imageBuffer;
    if (inputUrl !== jpegUrl) {
        log('BATCH', `Descargando imagen NDVI: ${inputUrl}`);
        inputBuffer = await downloadFromUrl(inputUrl);
    }
    log('BATCH', `[FASE 2] Completada — ${tFase2.elapsed()}`);

    // ── Extraer bounds del GeoTIFF ────────────────────────────────────────────
    let realBounds = null;
    try {
        let arrayBuffer;
        if (geotiffBuffer instanceof Buffer) {
            arrayBuffer = geotiffBuffer.buffer.slice(geotiffBuffer.byteOffset, geotiffBuffer.byteOffset + geotiffBuffer.byteLength);
        } else {
            arrayBuffer = geotiffBuffer;
        }
        const tiff = await fromArrayBuffer(arrayBuffer);
        const image = await tiff.getImage();
        try {
            const bbox = image.getBoundingBox();
            realBounds = [[bbox[0], bbox[1]], [bbox[2], bbox[3]]];
            log('BATCH', `Bounds extraídos del GeoTIFF: [[${bbox[0].toFixed(5)}, ${bbox[1].toFixed(5)}], [${bbox[2].toFixed(5)}, ${bbox[3].toFixed(5)}]]`);
        } catch (bboxError) {
            log('BATCH', `⚠️ No se pudieron extraer bounds: ${bboxError.message}`);
        }
    } catch (geotiffError) {
        log('BATCH', `⚠️ No se pudo leer GeoTIFF: ${geotiffError.message}`);
    }

    // Construir prompt
    const prompt = buildPrompt(modelo, scaleContext, customPrompt);
    log('BATCH', `Prompt construido para modelo '${modelo}' (${prompt.length} caracteres)`);

    // ── FASE 3: Upload imagen original ───────────────────────────────────────
    const tFase3 = timer();
    log('BATCH', `[FASE 3] Subiendo imagen original a GCS...`);

    // Aplicar la misma corrección de aspect ratio que se aplica a la imagen mejorada en FASE 6
    let sentinelSharp = sharp(inputBuffer);
    if (scaleContext?.dimensions?.width && scaleContext?.dimensions?.height) {
        const aspectRatio = scaleContext.dimensions.width / scaleContext.dimensions.height;
        const targetW = aspectRatio >= 1 ? 1024 : Math.round(1024 * aspectRatio);
        const targetH = aspectRatio >= 1 ? Math.round(1024 / aspectRatio) : 1024;
        log('BATCH', `Corrigiendo aspect ratio Sentinel-2: ${targetW}x${targetH} (ratio ${aspectRatio.toFixed(3)})`);
        sentinelSharp = sentinelSharp.resize(targetW, targetH, { fit: 'fill' });
    }
    const jpegBuffer = await sentinelSharp.jpeg({ quality: 90 }).toBuffer();
    const originalJpegPath = `${BUCKET_BASE_PATH}/original_jpeg/${jobId}.jpeg`;
    await uploadToDocs(jpegBuffer, originalJpegPath, bucket);
    const originalPublicUrl = `https://storage.googleapis.com/${bucket}/${originalJpegPath}`;
    log('BATCH', `JPEG original subido: ${originalPublicUrl}`);

    try {
        const pureSentinelBuffer = await sharp(geotiffBuffer).resize(1024, 1024, { fit: 'inside' }).jpeg({ quality: 80 }).toBuffer();
        const pureSentinelPath = `${BUCKET_BASE_PATH}/pure_sentinel_jpeg/${jobId}.jpeg`;
        await uploadToDocs(pureSentinelBuffer, pureSentinelPath, bucket);
        log('BATCH', `pure_sentinel_jpeg subido: gs://${bucket}/${pureSentinelPath}`);
    } catch (err) {
        log('BATCH', `⚠️ No se pudo generar pure_sentinel_jpeg: ${err.message}`);
    }
    log('BATCH', `[FASE 3] Completada — ${tFase3.elapsed()}`);

    // Dimensiones de la imagen
    const jpegImage = sharp(jpegBuffer);
    const metadata = await jpegImage.metadata();
    const { width, height } = metadata;
    if (!width || !height) throw new Error('No se pudieron determinar las dimensiones de la imagen.');
    log('BATCH', `Dimensiones imagen entrada: ${width}x${height}px`);

    // Cargar imagen de referencia si aplica
    // Fallback: si el mapa de teselas no está disponible, usar la propia imagen Sentinel-2
    // para que Gemini al menos tenga contexto geográfico y no genere clasificaciones inventadas
    let mapReferenceImage = null;
    let mapMetadata = null;
    let referenceUrl = null;
    if (MODELS_WITH_REFERENCE.includes(modelo)) {
        if (satellitePreviewUrl) {
            referenceUrl = satellitePreviewUrl;
        } else {
            referenceUrl = originalPublicUrl;
            log('BATCH', `⚠️ Tesela de mapa no disponible — usando Sentinel-2 como referencia de respaldo`);
        }
    }
    if (referenceUrl) {
        try {
            log('BATCH', `Descargando imagen de referencia: ${referenceUrl}`);
            const mapBuffer = await downloadFromUrl(referenceUrl);
            mapReferenceImage = sharp(mapBuffer);
            mapMetadata = await mapReferenceImage.metadata();
            log('BATCH', `Referencia cargada: ${mapMetadata.width}x${mapMetadata.height}px`);
        } catch (err) {
            log('BATCH', `⚠️ No se pudo cargar imagen de referencia: ${err.message}`);
        }
    }

    // ── FASE 4: Generación y upload de tiles ─────────────────────────────────
    const TILE_SIZE = 1024;
    const tiles = [];
    for (let y = 0; y < height; y += TILE_SIZE) {
        for (let x = 0; x < width; x += TILE_SIZE) {
            const tileWidth = Math.min(TILE_SIZE, width - x);
            const tileHeight = Math.min(TILE_SIZE, height - y);
            if (tileWidth > 0 && tileHeight > 0) {
                tiles.push({ x, y, width: tileWidth, height: tileHeight });
            }
        }
    }
    log('BATCH', `[FASE 4] Tiles generados: ${tiles.length} (${width}x${height}px @ ${TILE_SIZE}px/tile)`);

    const tFase4 = timer();
    const originalUploadPromises = tiles.map(async (tile) => {
        const tileBuffer = await jpegImage.extract({ left: tile.x, top: tile.y, width: tile.width, height: tile.height }).toBuffer();
        const destPath = `${BUCKET_BASE_PATH}/grillas_originales/${jobId}/tile_${tile.x}_${tile.y}.jpeg`;
        const gsPath = await uploadToDocs(tileBuffer, destPath, bucket);
        log('BATCH', `Tile original subido: tile_${tile.x}_${tile.y}.jpeg → ${gsPath}`);

        let referenceGsPath = null;
        if (mapReferenceImage && mapMetadata) {
            try {
                const scaleX = mapMetadata.width / width;
                const scaleY = mapMetadata.height / height;
                const refX = Math.max(0, Math.min(Math.floor(tile.x * scaleX), mapMetadata.width - 1));
                const refY = Math.max(0, Math.min(Math.floor(tile.y * scaleY), mapMetadata.height - 1));
                const refW = Math.min(Math.floor(tile.width * scaleX), mapMetadata.width - refX);
                const refH = Math.min(Math.floor(tile.height * scaleY), mapMetadata.height - refY);

                if (refW > 0 && refH > 0) {
                    const refTileBuffer = await mapReferenceImage.extract({ left: refX, top: refY, width: refW, height: refH }).toBuffer();
                    const refDestPath = `${BUCKET_BASE_PATH}/grillas_referencia/${jobId}/tile_${tile.x}_${tile.y}.jpeg`;
                    referenceGsPath = await uploadToDocs(refTileBuffer, refDestPath, bucket);
                    log('BATCH', `Tile referencia subido: tile_${tile.x}_${tile.y}.jpeg → ${referenceGsPath}`);
                }
            } catch (err) {
                log('BATCH', `⚠️ Error extrayendo tile referencia ${tile.x},${tile.y}: ${err.message}`);
            }
        }
        return { gsPath, referenceGsPath };
    });
    const tileGsPaths = await Promise.all(originalUploadPromises);
    log('BATCH', `[FASE 4] Completada — ${tFase4.elapsed()} — ${tileGsPaths.length} tiles subidos`);

    // ── FASE 5: Mejora con Gemini ─────────────────────────────────────────────
    const totalTokens = { input: 0, output: 0, total: 0 };
    const tFase5 = timer();
    log('BATCH', `[FASE 5] Enviando ${tileGsPaths.length} tile(s) a Gemini IA...`);

    const upgradePromises = tileGsPaths.map((paths, idx) => {
        log('BATCH', `Tile ${idx + 1}/${tileGsPaths.length} → imagen: ${paths.gsPath} | referencia: ${paths.referenceGsPath || 'ninguna'}`);
        return callBusinessService(UPSCALE_URL, {
            imagen_gs: paths.gsPath,
            imagen_referencia_gs: paths.referenceGsPath,
            prompt
        }).then(result => {
            if (result.tokens) {
                totalTokens.input  += result.tokens.input  || 0;
                totalTokens.output += result.tokens.output || 0;
                totalTokens.total  += result.tokens.total  || 0;
            }
            log('BATCH', `Tile ${idx + 1} mejorado — tokens acumulados: ${totalTokens.total}`);
            return result;
        });
    });
    const upgradedResults = await Promise.all(upgradePromises);

    const { inputCost, outputImageCost, totalCost } = calculateCost(totalTokens);
    log('BATCH', `[FASE 5] Completada — ${tFase5.elapsed()}`);
    log('RESULTS', `Tokens — Input: ${totalTokens.input} | Output: ${totalTokens.output} | Total: ${totalTokens.total}`);
    log('RESULTS', `Costo  — Input: $${inputCost.toFixed(6)} | Imagen: $${outputImageCost.toFixed(6)} | Total: $${totalCost.toFixed(6)} USD`);

    // ── FASE 6: Ensamblado de tiles mejorados ─────────────────────────────────
    const tFase6 = timer();
    log('BATCH', `[FASE 6] Ensamblando imagen final...`);
    const inspectionPromises = upgradedResults.map(async (tileInfo, i) => {
        const response = await fetch(tileInfo.public_url);
        let buffer = await response.buffer();

        const improvedTilePath = `${BUCKET_BASE_PATH}/grillas_mejoradas/${jobId}/tile_${tiles[i].x}_${tiles[i].y}.png`;
        uploadToDocs(buffer, improvedTilePath, bucket).catch(err => logError('BATCH', `Fallo al subir tile mejorado`, err));

        const originalTileW = tiles[i].width;
        const originalTileH = tiles[i].height;
        const tileMeta = await sharp(buffer).metadata();
        if (tileMeta.width !== originalTileW || tileMeta.height !== originalTileH) {
            log('BATCH', `Tile ${i + 1}: redimensionando ${tileMeta.width}x${tileMeta.height} → ${originalTileW}x${originalTileH}`);
            buffer = await sharp(buffer).resize(originalTileW, originalTileH, { fit: 'fill' }).png().toBuffer();
        }
        return { buffer, originalX: tiles[i].x, originalY: tiles[i].y, width: originalTileW, height: originalTileH };
    });
    const inspectedTiles = await Promise.all(inspectionPromises);

    // Construir imagen compuesta
    const columnWidths = {};
    const rowHeights = {};
    inspectedTiles.forEach(tile => {
        columnWidths[tile.originalX] = Math.max(columnWidths[tile.originalX] || 0, tile.width);
        rowHeights[tile.originalY]   = Math.max(rowHeights[tile.originalY]   || 0, tile.height);
    });
    const finalWidth  = Object.values(columnWidths).reduce((sum, w) => sum + w, 0);
    const finalHeight = Object.values(rowHeights).reduce((sum, h) => sum + h, 0);
    log('BATCH', `Imagen compuesta: ${finalWidth}x${finalHeight}px (${inspectedTiles.length} tiles)`);

    const xCoords = Object.keys(columnWidths).map(Number).sort((a, b) => a - b);
    const yCoords = Object.keys(rowHeights).map(Number).sort((a, b) => a - b);
    const positionMap = { x: {}, y: {} };
    let currentLeft = 0;
    xCoords.forEach(x => { positionMap.x[x] = currentLeft; currentLeft += columnWidths[x]; });
    let currentTop = 0;
    yCoords.forEach(y => { positionMap.y[y] = currentTop; currentTop += rowHeights[y]; });
    const compositeArray = inspectedTiles.map(tile => ({
        input: tile.buffer,
        left: positionMap.x[tile.originalX],
        top: positionMap.y[tile.originalY]
    }));

    let compositeBase = sharp({
        create: { width: finalWidth, height: finalHeight, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } }
    }).composite(compositeArray);

    // Corregir aspecto ratio
    if (scaleContext?.dimensions?.width && scaleContext?.dimensions?.height) {
        const realW = scaleContext.dimensions.width;
        const realH = scaleContext.dimensions.height;
        const aspectRatio = realW / realH;
        let targetW, targetH;
        if (aspectRatio >= 1) {
            targetW = 1024;
            targetH = Math.round(1024 / aspectRatio);
        } else {
            targetH = 1024;
            targetW = Math.round(1024 * aspectRatio);
        }
        log('BATCH', `Corrección aspect ratio: ${finalWidth}x${finalHeight} → ${targetW}x${targetH} (ratio ${aspectRatio.toFixed(3)})`);
        const correctedBuffer = await compositeBase.png().toBuffer();
        compositeBase = sharp(correctedBuffer).resize(targetW, targetH, { fit: 'fill' });
    }

    // Subir resultados finales
    log('BATCH', `Subiendo GeoTIFF final...`);
    const finalTifBuffer = await compositeBase.clone().tiff({ quality: 100, compression: 'lzw' }).toBuffer();
    const finalTifPath = `${BUCKET_BASE_PATH}/resultados_finales/${jobId}.tif`;
    await uploadToDocs(finalTifBuffer, finalTifPath, bucket);
    const finalTifPublicUrl = `https://storage.googleapis.com/${bucket}/${finalTifPath}`;
    log('BATCH', `GeoTIFF subido: ${finalTifPublicUrl}`);

    log('BATCH', `Subiendo PNG final...`);
    const finalPngBuffer = await compositeBase.clone().png().toBuffer();
    const finalPngPath = `${BUCKET_BASE_PATH}/resultados_previsualizacion/${jobId}.png`;
    await uploadToDocs(finalPngBuffer, finalPngPath, bucket);
    const improvedPngPublicUrl = `https://storage.googleapis.com/${bucket}/${finalPngPath}`;
    log('BATCH', `PNG subido: ${improvedPngPublicUrl}`);

    log('BATCH', `[FASE 6] Completada — ${tFase6.elapsed()}`);
    log('BATCH', `✅ Job ${jobId} finalizado — tiempo total: ${tJob.elapsed()} — área: ${areaKm2} km²`);
    log('BATCH', `══════════════════════════════════════`);

    return {
        status: 'complete',
        modelo,
        area_km2: parseFloat(areaKm2),
        imagenes: {
            sentinel2_jpeg: originalPublicUrl,
            sentinel2_tif: geotiffUrl,
            mejorada_png: improvedPngPublicUrl,
            mejorada_tif: finalTifPublicUrl,
            google_maps_jpeg: satellitePreviewUrl,
            google_maps_tif: satelliteTiffUrl,
            ndvi_jpeg: ndviJpegUrl
        },
        bounds: realBounds,
        tokens: totalTokens,
        costo_usd: parseFloat(totalCost.toFixed(6))
    };
}

module.exports = { processUpscale };
