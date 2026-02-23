const functions = require('@google-cloud/functions-framework');
const { Storage } = require('@google-cloud/storage');
const sharp = require('sharp');

const storage = new Storage();
const bucket = storage.bucket('uss2-images');

/**
 * Cloud Function para procesar imágenes TIFF de Sentinel-2 y convertirlas a JPEG
 * Esta función debe estar en el proyecto emuclient con acceso al bucket uss2-images
 */
functions.http('processSentinelImage', (req, res) => {
  // Configurar CORS
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  
  // Manejar preflight requests
  if (req.method === 'OPTIONS') {
    return res.status(204).send('');
  }
  
  (async () => {
    try {
      // Validar método HTTP
      if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Solo se permite método POST' });
      }

      // Validar parámetros de entrada
      const { tiffUrl, date, metadata } = req.body;
      
      if (!tiffUrl) {
        return res.status(400).json({ error: 'Parámetro "tiffUrl" requerido' });
      }

      if (!date) {
        return res.status(400).json({ error: 'Parámetro "date" requerido' });
      }

      console.log(`Procesando TIFF desde: ${tiffUrl}`);

      // Descargar el TIFF desde la URL de GEE
      const tiffResponse = await fetch(tiffUrl);
      if (!tiffResponse.ok) {
        throw new Error(`Error descargando TIFF de GEE: ${tiffResponse.statusText}`);
      }
      const tiffBuffer = Buffer.from(await tiffResponse.arrayBuffer());
      console.log(`TIFF descargado: ${(tiffBuffer.length / 1024 / 1024).toFixed(2)} MB`);

      // Usar 'latest' como nombre para reemplazar con cada nueva coordenada
      const uniqueId = 'latest';
      const tiffFileName = `sentinel/sentinel_${uniqueId}.tif`;
      const jpegFileName = `sentinel/sentinel_${uniqueId}.jpeg`;

      // 1. Guardar TIFF con nombre 'latest' (se reemplaza con cada nueva coordenada)
      const tiffFile = bucket.file(tiffFileName);
      await tiffFile.save(tiffBuffer, {
        contentType: 'image/tiff',
        metadata: { 
          cacheControl: 'no-cache',
          customMetadata: {
            date: date,
            processedAt: new Date().toISOString()
          }
        }
      });
      console.log(`TIFF guardado (reemplazable): ${tiffFileName}`);

      // 2. Convertir TIFF a JPEG con sharp (todo en memoria)
      const jpegBuffer = await sharp(tiffBuffer)
        .resize(1024, 1024, {
          fit: 'fill', // Escala sin mantener aspecto ratio para llenar 1024x1024
          withoutEnlargement: false // Permite agrandar imágenes pequeñas
        })
        .jpeg({ quality: 90 })
        .toBuffer();
      console.log(`JPEG generado y escalado a 1024x1024: ${(jpegBuffer.length / 1024 / 1024).toFixed(2)} MB`);

      // 3. Guardar JPEG con nombre 'latest' (se reemplaza con cada nueva coordenada)
      const jpegFile = bucket.file(jpegFileName);
      await jpegFile.save(jpegBuffer, {
        contentType: 'image/jpeg',
        metadata: { 
          cacheControl: 'no-cache',
          customMetadata: {
            date: date,
            processedAt: new Date().toISOString(),
            source: 'sentinel-2',
            ...metadata
          }
        }
      });
      console.log(`JPEG guardado (reemplazable): ${jpegFileName}`);

      // 4. Generar URLs públicas
      const jpegPublicUrl = `https://storage.googleapis.com/uss2-images/${jpegFileName}`;
      const geotiffPublicUrl = `https://storage.googleapis.com/uss2-images/${tiffFileName}`;

      // Responder con las URLs del JPEG y GEOTIFF
      res.status(200).json({
        success: true,
        jpegUrl: jpegPublicUrl,
        jpegFileName: jpegFileName,
        geotiffUrl: geotiffPublicUrl,
        geotiffFileName: tiffFileName,
        size: jpegBuffer.length,
        processedAt: new Date().toISOString()
      });

    } catch (error) {
      console.error('Error procesando imagen:', error);

      res.status(500).json({
        success: false,
        error: 'Error procesando imagen',
        message: error.message || error.toString(),
        timestamp: new Date().toISOString()
      });
    }
  })();
});
