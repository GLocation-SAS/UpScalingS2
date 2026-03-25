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

const TOKEN_URL = process.env.TOKEN_URL;
const UPSCALE_URL = process.env.UPSCALE_URL;

const MODELS_WITH_REFERENCE = ['upscaling_google_maps', 'building_footprint', 'Custom'];

async function callBusinessService(url, payloadObj, attempts = 3) {
    const tokenUrl = `${TOKEN_URL}/?url=${encodeURIComponent(url)}`;

    for (let i = 0; i < attempts; i++) {
        try {
            const tokenResponse = await fetch(tokenUrl);
            if (!tokenResponse.ok) {
                const errorBody = await tokenResponse.text();
                throw new Error(`Error obteniendo token (${tokenResponse.status}): ${errorBody}`);
            }
            const tokenData = await tokenResponse.json();
            if (!tokenData.token) throw new Error('Respuesta de token inválida');
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

async function processUpscale({ fecha, geometry, modelo, bucket, proyecto, customPrompt }) {
    const BUCKET_BASE_PATH = 'sentinel';
    const jobId = `batch_${Date.now()}`;

    console.log(`[BATCH] Iniciando job ${jobId}`);
    console.log(`[BATCH] Fecha: ${fecha}, Modelo: ${modelo}, Bucket: ${bucket}`);

    // Calcular dimensiones reales del área
    const dimensions = calculateRectangleDimensions(geometry);
    const areaKm2 = (dimensions.area / 1e6).toFixed(3);
    const scaleContext = { zoom: 12, dimensions };
    console.log(`[BATCH] Área: ${areaKm2} km² (${Math.round(dimensions.width)}m × ${Math.round(dimensions.height)}m)`);

    // TIFF compuesto espera un FeatureCollection, no un Polygon directo
    const geoFeatureCollection = {
        type: 'FeatureCollection',
        features: [{ type: 'Feature', properties: {}, geometry }]
    };

    // Llamadas en paralelo: GEE + TIFF compuesto
    console.log('[BATCH] Iniciando peticiones paralelas: GEE + TIFF compuesto...');
    const [geeData, tiffData] = await Promise.all([
        fetchGeeImage(fecha, geometry),
        fetchTiffCompuesto(geoFeatureCollection, 12, 'satellite').catch(err => {
            console.warn(`[BATCH] TIFF compuesto falló (no crítico): ${err.message}`);
            return null;
        })
    ]);

    // Extraer URLs de GEE
    const jpegUrl = geeData.jpegUrl || geeData.imageUrl || geeData.image_url || geeData.public_url;
    const geotiffUrl = geeData.geotiffUrl;
    const ndviJpegUrl = geeData.ndviJpegUrl || null;

    if (!jpegUrl) throw new Error('GEE no retornó URL de imagen JPEG');
    if (!geotiffUrl) throw new Error('GEE no retornó URL de GeoTIFF');

    const satellitePreviewUrl = tiffData?.preview_url || null;
    const satelliteTiffUrl = tiffData?.tiff_url || null;
    const satelliteBbox = tiffData?.bbox || null;

    // Descargar imágenes
    console.log(`[BATCH] Descargando imagen base: ${jpegUrl}`);
    const imageBuffer = await downloadFromUrl(jpegUrl);

    console.log(`[BATCH] Descargando GeoTIFF para coordenadas: ${geotiffUrl}`);
    let geotiffBuffer = imageBuffer;
    if (jpegUrl !== geotiffUrl) {
        try {
            geotiffBuffer = await downloadFromUrl(geotiffUrl);
        } catch (err) {
            console.warn(`[BATCH] No se pudo descargar GeoTIFF, usando imagen base para coordenadas`);
        }
    }

    // Determinar la imagen base según el modelo
    let inputUrl = modelo === 'upscaling_ndvi' && ndviJpegUrl ? ndviJpegUrl : jpegUrl;
    let inputBuffer = imageBuffer;
    if (inputUrl !== jpegUrl) {
        inputBuffer = await downloadFromUrl(inputUrl);
    }

    // Extraer bounds del GeoTIFF
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
            console.log('[BATCH] Bounds del GeoTIFF:', realBounds);
        } catch (bboxError) {
            console.warn(`[BATCH] No se pudieron extraer bounds del GeoTIFF: ${bboxError.message}`);
            realBounds = null;
        }
    } catch (geotiffError) {
        console.warn('[BATCH] No se pudo leer como GeoTIFF:', geotiffError.message);
    }

    // Construir prompt
    const prompt = buildPrompt(modelo, scaleContext, customPrompt);
    console.log(`[BATCH] Prompt generado para modelo '${modelo}'`);

    // Preparar imagen JPEG para upload
    const jpegBuffer = await sharp(inputBuffer).jpeg({ quality: 90 }).toBuffer();
    const originalJpegPath = `${BUCKET_BASE_PATH}/original_jpeg/${jobId}.jpeg`;
    await uploadToDocs(jpegBuffer, originalJpegPath, bucket);
    const originalPublicUrl = `https://storage.googleapis.com/${bucket}/${originalJpegPath}`;

    // Pure sentinel (GeoTIFF resized)
    let pureSentinelPublicUrl = originalPublicUrl;
    try {
        const pureSentinelBuffer = await sharp(geotiffBuffer).resize(1024, 1024, { fit: 'inside' }).jpeg({ quality: 80 }).toBuffer();
        const pureSentinelPath = `${BUCKET_BASE_PATH}/pure_sentinel_jpeg/${jobId}.jpeg`;
        await uploadToDocs(pureSentinelBuffer, pureSentinelPath, bucket);
        pureSentinelPublicUrl = `https://storage.googleapis.com/${bucket}/${pureSentinelPath}`;
    } catch (err) {
        console.warn('[BATCH] No se pudo generar pure_sentinel_jpeg:', err.message);
    }

    // Dimensiones de la imagen
    const jpegImage = sharp(jpegBuffer);
    const metadata = await jpegImage.metadata();
    const { width, height } = metadata;
    if (!width || !height) throw new Error('No se pudieron determinar las dimensiones de la imagen.');
    console.log(`[BATCH] Dimensiones imagen: ${width}x${height}`);

    // Cargar imagen de referencia si aplica
    let mapReferenceImage = null;
    let mapMetadata = null;
    const referenceUrl = MODELS_WITH_REFERENCE.includes(modelo) ? satellitePreviewUrl : null;
    if (referenceUrl) {
        try {
            console.log(`[BATCH] Descargando imagen de referencia: ${referenceUrl}`);
            const mapBuffer = await downloadFromUrl(referenceUrl);
            mapReferenceImage = sharp(mapBuffer);
            mapMetadata = await mapReferenceImage.metadata();
            console.log(`[BATCH] Referencia cargada: ${mapMetadata.width}x${mapMetadata.height}`);
        } catch (err) {
            console.warn(`[BATCH] No se pudo cargar imagen de referencia: ${err.message}`);
        }
    }

    // Generar tiles
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
    console.log(`[BATCH] Tiles a procesar: ${tiles.length}`);

    // Subir tiles originales
    const originalUploadPromises = tiles.map(async (tile) => {
        const tileBuffer = await jpegImage.extract({ left: tile.x, top: tile.y, width: tile.width, height: tile.height }).toBuffer();
        const destPath = `${BUCKET_BASE_PATH}/grillas_originales/${jobId}/tile_${tile.x}_${tile.y}.jpeg`;
        const gsPath = await uploadToDocs(tileBuffer, destPath, bucket);

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
                }
            } catch (err) {
                console.warn(`[BATCH] Error extrayendo tile referencia ${tile.x},${tile.y}: ${err.message}`);
            }
        }
        return { gsPath, referenceGsPath };
    });
    const tileGsPaths = await Promise.all(originalUploadPromises);

    // Mejorar tiles con IA
    const totalTokens = { input: 0, output: 0, total: 0 };
    console.log(`[BATCH] Enviando ${tileGsPaths.length} tiles a Gemini...`);
    const upgradePromises = tileGsPaths.map((paths, idx) => {
        console.log(`[IA] Tile ${idx + 1}/${tileGsPaths.length} — ${paths.referenceGsPath ? 'CON referencia' : 'SIN referencia'}`);
        return callBusinessService(UPSCALE_URL, {
            imagen_gs: paths.gsPath,
            imagen_referencia_gs: paths.referenceGsPath,
            prompt
        }).then(result => {
            if (result.tokens) {
                totalTokens.input += result.tokens.input || 0;
                totalTokens.output += result.tokens.output || 0;
                totalTokens.total += result.tokens.total || 0;
            }
            return result;
        });
    });
    const upgradedResults = await Promise.all(upgradePromises);

    // Log tokens y costo
    const { inputCost, outputImageCost, totalCost } = calculateCost(totalTokens);
    console.log(`[RESULTS] 💰 Tokens — Input: ${totalTokens.input} | Output: ${totalTokens.output} | Total: ${totalTokens.total}`);
    console.log(`[RESULTS] 💵 Costo — Input: $${inputCost.toFixed(6)} | Output imagen: $${outputImageCost.toFixed(6)} | Total: $${totalCost.toFixed(6)} USD | Área: ${areaKm2} km²`);

    // Ensamblar tiles mejorados
    const inspectionPromises = upgradedResults.map(async (tileInfo, i) => {
        const response = await fetch(tileInfo.public_url);
        let buffer = await response.buffer();

        const improvedTilePath = `${BUCKET_BASE_PATH}/grillas_mejoradas/${jobId}/tile_${tiles[i].x}_${tiles[i].y}.png`;
        uploadToDocs(buffer, improvedTilePath, bucket).catch(err => console.error(`Fallo al subir tile mejorado: ${err.message}`));

        const originalTileW = tiles[i].width;
        const originalTileH = tiles[i].height;
        const tileMeta = await sharp(buffer).metadata();
        if (tileMeta.width !== originalTileW || tileMeta.height !== originalTileH) {
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
        rowHeights[tile.originalY] = Math.max(rowHeights[tile.originalY] || 0, tile.height);
    });
    const finalWidth = Object.values(columnWidths).reduce((sum, w) => sum + w, 0);
    const finalHeight = Object.values(rowHeights).reduce((sum, h) => sum + h, 0);
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
        console.log(`[BATCH] Corrigiendo aspecto ratio: ${finalWidth}x${finalHeight} → ${targetW}x${targetH}`);
        const correctedBuffer = await compositeBase.png().toBuffer();
        compositeBase = sharp(correctedBuffer).resize(targetW, targetH, { fit: 'fill' });
    }

    // Generar y subir TIF y PNG finales
    const finalTifBuffer = await compositeBase.clone().tiff({ quality: 100, compression: 'lzw' }).toBuffer();
    const finalTifPath = `${BUCKET_BASE_PATH}/resultados_finales/${jobId}.tif`;
    await uploadToDocs(finalTifBuffer, finalTifPath, bucket);
    const finalTifPublicUrl = `https://storage.googleapis.com/${bucket}/${finalTifPath}`;

    const finalPngBuffer = await compositeBase.clone().png().toBuffer();
    const finalPngPath = `${BUCKET_BASE_PATH}/resultados_previsualizacion/${jobId}.png`;
    await uploadToDocs(finalPngBuffer, finalPngPath, bucket);
    const improvedPngPublicUrl = `https://storage.googleapis.com/${bucket}/${finalPngPath}`;

    console.log(`[BATCH] ✅ Proceso completado para ${jobId}`);

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
