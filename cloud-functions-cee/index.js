const functions = require('@google-cloud/functions-framework');
const ee = require('@google/earthengine');
const { GoogleAuth } = require('google-auth-library');

// Variables globales para caché de token
let lastTokenTime = 0;
let cachedToken = null;
const TOKEN_EXPIRY_MS = 45 * 60 * 1000; // 45 minutos (margen conservador de 15 min)

/**
 * Obtiene un token de acceso fresco o del caché
 * @returns {Promise<string>}
 */
const getAccessToken = async () => {
  const now = Date.now();
  const timeSinceLastToken = now - lastTokenTime;

  // Intentar reutilizar token cacheado si es reciente
  if (cachedToken && timeSinceLastToken < TOKEN_EXPIRY_MS) {
    console.log(`♻️  Reutilizando token en caché (edad: ${Math.floor(timeSinceLastToken / 60000)} min)`);
    return cachedToken;
  }

  // Obtener token fresco
  if (timeSinceLastToken >= TOKEN_EXPIRY_MS && lastTokenTime > 0) {
    console.log(`🔄 Token expiró (edad: ${Math.floor(timeSinceLastToken / 60000)} min), obteniendo uno nuevo...`);
  } else {
    console.log('🔐 Obteniendo token por primera vez...');
  }

  const auth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/earthengine']
  });

  const client = await auth.getClient();
  const accessToken = await client.getAccessToken();

  if (!accessToken.token) {
    throw new Error('No se pudo obtener access token');
  }

  // Cachear el token nuevo
  cachedToken = accessToken.token;
  lastTokenTime = Date.now();

  console.log('✅ Token fresco obtenido y cacheado');
  return cachedToken;
};

/**
 * Inicializa Google Earth Engine
 * @param {boolean} forceRefresh - Forzar obtención de token nuevo
 * @returns {Promise<void>}
 */
const initGee = async (forceRefresh = false) => {
  try {
    if (forceRefresh) {
      console.log('🔄 Forzando renovación de token...');
      cachedToken = null;
      lastTokenTime = 0;
    }

    const token = await getAccessToken();

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        console.error('⏱️  TIMEOUT: Inicialización de GEE tardó más de 30 segundos');
        reject(new Error('Timeout inicializando Google Earth Engine'));
      }, 30000);

      // Configurar el access token
      ee.data.setAuthToken(
        '',
        'Bearer',
        token,
        3600,
        null,
        null,
        false
      );

      ee.initialize(
        null,
        null,
        () => {
          clearTimeout(timeoutId);
          console.log('✅ GEE inicializado correctamente');
          resolve();
        },
        (error) => {
          clearTimeout(timeoutId);
          console.error('❌ Error en initialize:', error);
          reject(new Error(`Error en initialize: ${error}`));
        }
      );
    });
  } catch (error) {
    console.error('❌ Error obteniendo credenciales:', error);
    throw error;
  }
};

/**
 * Ejecuta una función de Earth Engine con retry en caso de error de autenticación
 * @param {Function} fn - Función a ejecutar
 * @returns {Promise<any>}
 */
const executeWithAuthRetry = async (fn) => {
  try {
    return await fn();
  } catch (error) {
    const errorMsg = error.message || error.toString();

    // Si es error de autenticación, reintentar con token fresco
    if (errorMsg.includes('authentication') || errorMsg.includes('OAuth')) {
      console.log('⚠️  Error de autenticación detectado, reintentando con token fresco...');

      // Forzar renovación de token
      await initGee(true);

      // Reintentar la operación
      return await fn();
    }

    // Si no es error de auth, propagar el error
    throw error;
  }
};

/**
 * Obtiene la URL de descarga de una imagen de Earth Engine como GeoTIFF
 * @param {ee.Image} image - Imagen procesada
 * @param {Object} params - Parámetros de descarga
 * @returns {Promise<string>}
 */
const getDownloadUrl = (image, params) => {
  return new Promise((resolve, reject) => {
    image.getDownloadURL(params, (url, error) => {
      if (error) {
        reject(new Error(`Error en getDownloadURL: ${error}`));
      } else if (url) {
        resolve(url);
      } else {
        reject(new Error('No se pudo obtener la URL de descarga'));
      }
    });
  });
};

/**
 * Obtiene la URL de tiles de una imagen de Earth Engine
 * @param {ee.Image} image - Imagen procesada
 * @param {Object} visParams - Parámetros de visualización
 * @returns {Promise<string>}
 */
const getMapUrl = (image, visParams) => {
  return new Promise((resolve, reject) => {
    image.getMap(visParams, (mapId, error) => {
      if (error) {
        reject(new Error(`Error en getMap: ${error}`));
      } else if (mapId && mapId.urlFormat) {
        resolve(mapId.urlFormat);
      } else {
        reject(new Error('No se pudo obtener el MapID'));
      }
    });
  });
};

/**
 * Máscara de nubes y neblina para Sentinel-2
 * @param {ee.Image} image - Imagen Sentinel-2
 * @returns {ee.Image}
 */
const cloudMask = (image) => {
  const scl = image.select('SCL');
  const cloudProb = image.select('QA60').eq(0);
  const aot = image.select('AOT').lt(500);

  const mask = scl.neq(3)
    .and(scl.neq(7))
    .and(scl.neq(8))
    .and(scl.neq(9))
    .and(scl.neq(10))
    .and(scl.neq(11))
    .and(aot)
    .and(cloudProb);

  return image.updateMask(mask).select(['B2', 'B3', 'B4', 'B5', 'B8']);
};

/**
 * Rellena píxeles enmascarados usando imágenes históricas
 * @param {ee.Image} image - Imagen con máscara aplicada
 * @param {ee.Geometry} roi - Región de interés
 * @returns {ee.Image}
 */
const fillGaps = (image, roi) => {
  const filled = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
    .filterBounds(roi)
    .filterDate(
      ee.Date(image.get('system:time_start')).advance(-6, 'month'),
      ee.Date(image.get('system:time_start'))
    )
    .map(cloudMask)
    .mean();

  return image.unmask(filled);
};

/**
 * Normaliza la geometría recibida del frontend
 * @param {Object} geometry - GeoJSON del frontend
 * @returns {ee.Geometry}
 */
const normalizeGeometry = (geometry) => {
  if (!geometry) {
    throw new Error('Geometría no proporcionada');
  }

  if (geometry.type === 'Feature' && geometry.geometry) {
    return ee.Geometry(geometry.geometry);
  }

  if (geometry.type && geometry.coordinates) {
    return ee.Geometry(geometry);
  }

  throw new Error('Formato de geometría no válido');
};

/**
 * Cloud Function HTTP principal
 */
functions.http('getGeeImage', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).send('');
  }

  (async () => {
    try {
      console.log(`📥 REQUEST recibido - Método: ${req.method}`);

      if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Solo se permite método POST' });
      }

      const { date, geometry, model } = req.body;

      if (!date) {
        return res.status(400).json({ error: 'Parámetro "date" requerido (formato ISO)' });
      }

      if (!geometry) {
        return res.status(400).json({ error: 'Parámetro "geometry" requerido (GeoJSON)' });
      }

      const selectedModel = model || 'upscaling'; // Modelo por defecto si no se envía
      console.log(`📅 Procesando request - Fecha: ${date}, Modelo: ${selectedModel}`);

      // Inicializar GEE con token (caché o fresco según edad)
      await initGee();

      // Ejecutar procesamiento con retry automático si hay error de auth
      const result = await executeWithAuthRetry(async () => {
        const roi = normalizeGeometry(geometry);

        const centerDate = ee.Date(date);
        const startDate = centerDate.advance(-1, 'month');
        const endDate = centerDate.advance(1, 'month');

        console.log('🛰️  Filtrando colección Sentinel-2...');

        const collection = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
          .filterBounds(roi)
          .filterDate(startDate, endDate)
          .map(cloudMask);

        const size = await new Promise((resolve, reject) => {
          collection.size().evaluate((result, error) => {
            if (error) reject(error);
            else resolve(result);
          });
        });

        if (size === 0) {
          return res.status(404).json({
            error: 'No se encontraron imágenes Sentinel-2 para la fecha y región especificadas',
            details: {
              date,
              startDate: startDate.format('YYYY-MM-dd').getInfo(),
              endDate: endDate.format('YYYY-MM-dd').getInfo()
            }
          });
        }

        console.log(`✅ Imágenes encontradas: ${size}`);

        const collectionWithFill = collection.map(img => fillGaps(img, roi));
        const imageResult = collectionWithFill.median().clip(roi);

        console.log('🌱  Calculando NDVI...');
        const ndvi = imageResult.normalizedDifference(['B8', 'B4']).rename('NDVI');

        console.log('🗺️  Generando tiles...');
        const tileUrl = await getMapUrl(imageResult, {
          bands: ['B4', 'B3', 'B2'],
          min: 0,
          max: 3000
        });

        const ndviVisParams = {
          min: -0.2,
          max: 0.8,
          palette: [
            'FFFFFF', 'CE7E45', 'DF923D', 'F1B555', 'FCD163', '99B718', '74A901',
            '66A000', '529400', '3E8601', '207401', '056201', '004C00', '023B01',
            '012E01', '011D01', '011301'
          ]
        };
        const ndviTileUrl = await getMapUrl(ndvi, ndviVisParams);

        console.log('✅ Tiles generados exitosamente');
        console.log('📦 Obteniendo URL de descarga del TIFF desde GEE...');

        const visualizedRGB = imageResult.visualize({
          bands: ['B4', 'B3', 'B2'],
          min: 0,
          max: 3000
        });

        const downloadUrlRGB = await getDownloadUrl(visualizedRGB, {
          name: 'sentinel_image',
          region: roi,
          scale: 10,
          format: 'GEO_TIFF'
        });

        // NDVI Download
        const visualizedNDVI = ndvi.visualize(ndviVisParams);
        const downloadUrlNDVI = await getDownloadUrl(visualizedNDVI, {
          name: 'sentinel_ndvi',
          region: roi,
          scale: 10,
          format: 'GEO_TIFF'
        });

        const processingUrl = 'https://process-sentinel-image-960956212831.us-east1.run.app';
        const dateRange = { start: startDate.format('YYYY-MM-dd').getInfo(), end: endDate.format('YYYY-MM-dd').getInfo() };

        let jpegUrl = null, geotiffUrl = null, ndviJpegUrl = null, ndviGeotiffUrl = null;

        // Siempre procesar RGB — es la imagen original Sentinel-2 y base para todos los modelos
        console.log('🖥️ Procesando imagen RGB via emuclient...');
        const responseRGB = await fetch(processingUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tiffUrl: downloadUrlRGB,
            date: `${date}_rgb`,
            metadata: { imagesFound: size, type: 'rgb', dateRange }
          })
        });
        if (!responseRGB.ok) {
          const errorText = await responseRGB.text();
          throw new Error(`Error procesando RGB: ${responseRGB.status} - ${errorText}`);
        }
        const resultRGB = await responseRGB.json();
        jpegUrl = resultRGB.jpegUrl;
        geotiffUrl = resultRGB.geotiffUrl;
        console.log(`✅ RGB procesado: ${jpegUrl}`);

        // Siempre procesar NDVI — se guarda para mostrarlo en el visor de resultados
        // (cuando el modelo es 'upscaling_ndvi', el backend lo usa también como referencia IA)
        console.log('🌱 Procesando imagen NDVI via emuclient...');
        const responseNDVI = await fetch(processingUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tiffUrl: downloadUrlNDVI,
            date: `${date}_ndvi`,
            metadata: { imagesFound: size, type: 'ndvi', dateRange }
          })
        });
        if (!responseNDVI.ok) {
          const errorText = await responseNDVI.text();
          throw new Error(`Error procesando NDVI: ${responseNDVI.status} - ${errorText}`);
        }
        const resultNDVI = await responseNDVI.json();
        ndviJpegUrl = resultNDVI.jpegUrl;
        ndviGeotiffUrl = resultNDVI.geotiffUrl;
        console.log(`✅ NDVI procesado: ${ndviJpegUrl}`);

        console.log('✅ Procesamiento completado.');

        return {
          url: tileUrl,
          jpegUrl,
          geotiffUrl,

          ndviTileUrl,
          ndviJpegUrl,
          ndviGeotiffUrl,

          attribution: '© Google Earth Engine - Sentinel-2 MSI',
          metadata: {
            date,
            model: selectedModel,
            imagesFound: size,
            dateRange
          }
        };
      });

      res.status(200).json(result);

    } catch (error) {
      console.error('❌ Error procesando request:', error);

      res.status(500).json({
        error: 'Error interno del servidor',
        message: error.message || error.toString(),
        timestamp: new Date().toISOString()
      });
    }
  })();
});