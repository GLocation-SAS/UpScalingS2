const functions = require('@google-cloud/functions-framework');
const { Storage } = require('@google-cloud/storage');
const turf = require('@turf/turf');
const fetch = require('node-fetch');
const sharp = require('sharp');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');

const storage = new Storage();
const bucket = storage.bucket('uss2-images');

const TILE_SIZE = 1024;
const MAX_TILES = 400;
const EARTH_RADIUS = 6378137;
const DEFAULT_LAYER = 'satellite';

const TILE_BASE_URLS = {
  satellite: 'https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}&scale=4',
  hybrid: 'https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}&scale=4'
};

const toRadians = (deg) => (deg * Math.PI) / 180;

const lonLatToTile = (lon, lat, zoom) => {
  const n = 2 ** zoom;
  const latRad = toRadians(lat);
  const x = Math.floor(((lon + 180) / 360) * n);
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n
  );
  return { x, y };
};

const tileToLonLat = (x, y, zoom) => {
  const n = 2 ** zoom;
  const lon = (x / n) * 360 - 180;
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
  const lat = (latRad * 180) / Math.PI;
  return { lon, lat };
};

const lonLatToMercator = (lon, lat) => {
  const x = EARTH_RADIUS * toRadians(lon);
  const y = EARTH_RADIUS * Math.log(Math.tan(Math.PI / 4 + toRadians(lat) / 2));
  return { x, y };
};

const computeTileRange = (bbox, zoom) => {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const topLeft = lonLatToTile(minLon, maxLat, zoom);
  const bottomRight = lonLatToTile(maxLon, minLat, zoom);

  const n = 2 ** zoom;
  const minX = Math.max(0, Math.min(topLeft.x, bottomRight.x));
  const maxX = Math.min(n - 1, Math.max(topLeft.x, bottomRight.x));
  const minY = Math.max(0, Math.min(topLeft.y, bottomRight.y));
  const maxY = Math.min(n - 1, Math.max(topLeft.y, bottomRight.y));

  return { minX, minY, maxX, maxY };
};

const computeMercatorBoundsFromTiles = (tileRange, zoom) => {
  const { minX, minY, maxX, maxY } = tileRange;
  const topLeft = tileToLonLat(minX, minY, zoom);
  const bottomRight = tileToLonLat(maxX + 1, maxY + 1, zoom);

  const topLeftMercator = lonLatToMercator(topLeft.lon, topLeft.lat);
  const bottomRightMercator = lonLatToMercator(bottomRight.lon, bottomRight.lat);

  return {
    minX: topLeftMercator.x,
    maxX: bottomRightMercator.x,
    minY: bottomRightMercator.y,
    maxY: topLeftMercator.y,
    lonLatBounds: [topLeft.lon, bottomRight.lat, bottomRight.lon, topLeft.lat]
  };
};

const buildTileUrl = (layer, x, y, z) => {
  const base = TILE_BASE_URLS[layer] || TILE_BASE_URLS[DEFAULT_LAYER];
  return base.replace('{x}', x).replace('{y}', y).replace('{z}', z);
};

const fetchTile = async (layer, x, y, z) => {
  const url = buildTileUrl(layer, x, y, z);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Tile download failed (${response.status}) at ${x},${y},${z}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
};

const fetchTilesWithLimit = async (tileJobs, layer, concurrency = 8) => {
  let index = 0;
  const results = new Array(tileJobs.length);

  const workers = new Array(Math.min(concurrency, tileJobs.length))
    .fill(null)
    .map(async () => {
      while (index < tileJobs.length) {
        const current = index;
        index += 1;
        const job = tileJobs[current];
        try {
          results[current] = await fetchTile(layer, job.x, job.y, job.z);
        } catch (error) {
          results[current] = null;
        }
      }
    });

  await Promise.all(workers);
  return results;
};

const buildMosaic = async (tileRange, tiles, zoom) => {
  const { minX, minY, maxX, maxY } = tileRange;
  const tilesX = maxX - minX + 1;
  const tilesY = maxY - minY + 1;
  const width = tilesX * TILE_SIZE;
  const height = tilesY * TILE_SIZE;

  const composites = [];
  let tileIndex = 0;

  for (let y = 0; y < tilesY; y += 1) {
    for (let x = 0; x < tilesX; x += 1) {
      const tileBuffer = tiles[tileIndex];
      if (tileBuffer) {
        composites.push({
          input: tileBuffer,
          left: x * TILE_SIZE,
          top: y * TILE_SIZE
        });
      }
      tileIndex += 1;
    }
  }

  const base = sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    }
  }).composite(composites);

  const jpegBuffer = await base.clone().jpeg({ quality: 90 }).toBuffer();
  const { data, info } = await base.clone().raw().toBuffer({ resolveWithObject: true });

  if (!data || !info) {
    throw new Error('No se pudo generar el mosaico en memoria');
  }

  return { jpegBuffer, raw: data, width: info.width, height: info.height, channels: info.channels };
};

const cropMosaicToUserBounds = async (mosaicData, tileMercatorBounds, userBbox, zoom) => {
  // Calcular bounds del usuario en Web Mercator
  // userBbox = [minLon, minLat, maxLon, maxLat]
  const bottomLeft = lonLatToMercator(userBbox[0], userBbox[1]);  // minLon, minLat
  const topRight = lonLatToMercator(userBbox[2], userBbox[3]);    // maxLon, maxLat
  
  const userMercatorBounds = {
    minX: bottomLeft.x,
    minY: bottomLeft.y,
    maxX: topRight.x,
    maxY: topRight.y
  };

  // Calcular cuántos píxeles por unidad mercator tiene el mosaico completo
  const tileMercatorWidth = tileMercatorBounds.maxX - tileMercatorBounds.minX;
  const tileMercatorHeight = tileMercatorBounds.maxY - tileMercatorBounds.minY;
  const pixelsPerMercatorX = mosaicData.width / tileMercatorWidth;
  const pixelsPerMercatorY = mosaicData.height / tileMercatorHeight;

  // Calcular posición del bbox del usuario dentro del mosaico (en píxeles)
  const cropLeft = Math.floor((userMercatorBounds.minX - tileMercatorBounds.minX) * pixelsPerMercatorX);
  const cropTop = Math.floor((tileMercatorBounds.maxY - userMercatorBounds.maxY) * pixelsPerMercatorY);
  const cropWidth = Math.ceil((userMercatorBounds.maxX - userMercatorBounds.minX) * pixelsPerMercatorX);
  const cropHeight = Math.ceil((userMercatorBounds.maxY - userMercatorBounds.minY) * pixelsPerMercatorY);

  // Validar que los valores de recorte estén dentro de los límites
  const validLeft = Math.max(0, Math.min(cropLeft, mosaicData.width - 1));
  const validTop = Math.max(0, Math.min(cropTop, mosaicData.height - 1));
  const validWidth = Math.max(1, Math.min(cropWidth, mosaicData.width - validLeft));
  const validHeight = Math.max(1, Math.min(cropHeight, mosaicData.height - validTop));

  console.log('Cropping mosaic:', {
    original: { width: mosaicData.width, height: mosaicData.height },
    crop: { left: validLeft, top: validTop, width: validWidth, height: validHeight },
    userBbox,
    tileBounds: tileMercatorBounds,
    userBounds: userMercatorBounds
  });

  // Recortar el mosaico
  const croppedJpeg = await sharp(mosaicData.jpegBuffer)
    .extract({ left: validLeft, top: validTop, width: validWidth, height: validHeight })
    .jpeg({ quality: 90 })
    .toBuffer();

  const croppedRaw = await sharp(mosaicData.jpegBuffer)
    .extract({ left: validLeft, top: validTop, width: validWidth, height: validHeight })
    .raw()
    .toBuffer();

  return {
    jpegBuffer: croppedJpeg,
    raw: croppedRaw,
    width: validWidth,
    height: validHeight,
    channels: mosaicData.channels,
    mercatorBounds: userMercatorBounds
  };
};

const buildGeoTiff = async (rawData, width, height, channels, mercatorBounds) => {
  const pixelSizeX = (mercatorBounds.maxX - mercatorBounds.minX) / width;
  const pixelSizeY = (mercatorBounds.maxY - mercatorBounds.minY) / height;

  // Extraer solo RGB (primeros 3 canales) en formato intercalado
  const rgbSize = width * height * 3;
  const rgbData = new Uint8Array(rgbSize);
  
  for (let i = 0; i < width * height; i += 1) {
    const srcIndex = i * channels;
    const dstIndex = i * 3;
    rgbData[dstIndex] = rawData[srcIndex];       // R
    rgbData[dstIndex + 1] = rawData[srcIndex + 1]; // G
    rgbData[dstIndex + 2] = rawData[srcIndex + 2]; // B
  }

  const geotiffModule = await import('geotiff');
  const writeArrayBuffer =
    geotiffModule.writeArrayBuffer || geotiffModule.default?.writeArrayBuffer;

  if (!writeArrayBuffer) {
    throw new Error('No se pudo cargar writeArrayBuffer desde geotiff');
  }

  // Metadata con nombres exactos de tags TIFF
  const metadata = {
    width,
    height,
    samplesPerPixel: 3,
    photometricInterpretation: 2, // RGB
    compression: 1, // Sin compresión
    bitsPerSample: 8,
    sampleFormat: 1, // unsigned integer
    planarConfiguration: 1, // Interleaved
    ModelPixelScale: [pixelSizeX, pixelSizeY, 0],
    ModelTiepoint: [0, 0, 0, mercatorBounds.minX, mercatorBounds.maxY, 0],
    GeoKeyDirectory: {
      GTModelTypeGeoKey: 1,
      GTRasterTypeGeoKey: 1,
      ProjectedCSTypeGeoKey: 3857
    }
  };

  const arrayBuffer = await writeArrayBuffer(rgbData, metadata);

  if (!arrayBuffer) {
    throw new Error('GeoTIFF no generado');
  }

  return Buffer.from(arrayBuffer);
};

const uploadToBucket = async (filePath, destination, contentType, metadata = {}) => {
  await bucket.upload(filePath, {
    destination,
    metadata: {
      contentType,
      cacheControl: 'no-cache',
      metadata
    }
  });

  return `https://storage.googleapis.com/${bucket.name}/${destination}`;
};

const calculateResolution = (bbox, zoom) => {
  const centerLat = (bbox[1] + bbox[3]) / 2;
  return (156543.03392 * Math.cos(toRadians(centerLat))) / (2 ** zoom);
};

functions.http('tiff-compuesto-satelital', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).send('');
  }

  (async () => {
    let tempDir;
    try {
      if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Solo se permite metodo POST' });
      }

      const { geometry, zoom, layer } = req.body || {};

      if (!geometry || geometry.type !== 'FeatureCollection') {
        return res.status(400).json({ error: 'Parametro "geometry" invalido (FeatureCollection)' });
      }

      if (typeof zoom !== 'number' || Number.isNaN(zoom)) {
        return res.status(400).json({ error: 'Parametro "zoom" invalido' });
      }

      const normalizedLayer = layer || DEFAULT_LAYER;

      const bbox = turf.bbox(geometry);
      const tileRange = computeTileRange(bbox, zoom);
      const tilesX = tileRange.maxX - tileRange.minX + 1;
      const tilesY = tileRange.maxY - tileRange.minY + 1;
      const totalTiles = tilesX * tilesY;

      if (totalTiles > MAX_TILES) {
        return res.status(400).json({
          error: 'La seleccion requiere demasiados tiles',
          details: { totalTiles, maxTiles: MAX_TILES }
        });
      }

      const tileJobs = [];
      for (let y = tileRange.minY; y <= tileRange.maxY; y += 1) {
        for (let x = tileRange.minX; x <= tileRange.maxX; x += 1) {
          tileJobs.push({ x, y, z: zoom });
        }
      }

      if (tileJobs.length === 0) {
        return res.status(400).json({
          error: 'No se encontraron tiles para el bbox indicado',
          details: { bbox, zoom }
        });
      }

      // Always process with satellite tiles under the hood.
      const tiles = await fetchTilesWithLimit(tileJobs, DEFAULT_LAYER, 8);
      const downloadedTiles = tiles.filter(Boolean).length;

      if (downloadedTiles === 0) {
        throw new Error('No se pudo descargar ningun tile');
      }

      console.log(`Tiles descargados: ${downloadedTiles}/${tiles.length}`);
      const mosaic = await buildMosaic(tileRange, tiles, zoom);

      // Obtener bounds de los tiles completos
      const tileMercatorBounds = computeMercatorBoundsFromTiles(tileRange, zoom);
      
      // Recortar el mosaico al bbox exacto del usuario
      const croppedMosaic = await cropMosaicToUserBounds(mosaic, tileMercatorBounds, bbox, zoom);
      
      // Generar GeoTIFF con los bounds exactos del usuario
      const tiffBuffer = await buildGeoTiff(
        croppedMosaic.raw,
        croppedMosaic.width,
        croppedMosaic.height,
        croppedMosaic.channels,
        croppedMosaic.mercatorBounds
      );

      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tiff-compuesto-'));
      const timestamp = Date.now();
      const jpegName = `mosaic/satellite_${timestamp}.jpeg`;
      const tiffName = `mosaic/satellite_${timestamp}.tif`;

      const jpegPath = path.join(tempDir, 'mosaic.jpeg');
      const tiffPath = path.join(tempDir, 'mosaic.tif');

      await fs.writeFile(jpegPath, croppedMosaic.jpegBuffer);
      await fs.writeFile(tiffPath, tiffBuffer);

      const previewUrl = await uploadToBucket(jpegPath, jpegName, 'image/jpeg', {
        layer: normalizedLayer,
        zoom: String(zoom)
      });
      const tiffUrl = await uploadToBucket(tiffPath, tiffName, 'image/tiff', {
        layer: normalizedLayer,
        zoom: String(zoom)
      });

      const resolution = calculateResolution(bbox, zoom);

      res.status(200).json({
        status: 'ok',
        zoom_used: zoom,
        resolution_m_per_pixel: resolution,
        bbox,
        preview_url: previewUrl,
        tiff_url: tiffUrl
      });
    } catch (error) {
      console.error('Error en tiff-compuesto-satelital:', error);
      res.status(500).json({
        status: 'error',
        message: error.message || String(error)
      });
    } finally {
      if (tempDir) {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    }
  })();
});
