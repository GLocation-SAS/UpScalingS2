const mapConfig = {
  containerId: "map",
  tileUrl: "https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}",
  center: [-74.0721, 4.711],
  zoom: 12,
  maplibreLogo: false
};

// URL de tu Cloud Function de GEE (actualiza con tu URL real)
const GEE_FUNCTION_URL = process.env.GEE_FUNCTION_URL || 'https://get-gee-image-209592542335.us-east1.run.app';

// URL de tu Cloud Function de TIFF compuesto
const TIFF_FUNCTION_URL = process.env.TIFF_COMPUESTO_FUNCTION_URL || 'https://tiff-compuesto-satelital-960956212831.us-east1.run.app';

const fetchGeeImage = async (date, geometry) => {
  console.log('\n🔷 [SERVICE] Iniciando fetchGeeImage');
  console.log('🎯 URL destino:', GEE_FUNCTION_URL);
  console.log('📅 Fecha:', date);
  console.log('📍 Geometría type:', geometry.type);
  
  try {
    const payload = { date, geometry };
    console.log('📦 Payload:', JSON.stringify(payload, null, 2));
    
    console.log('⏳ [SERVICE] Enviando petición a Cloud Function...');
    const response = await fetch(GEE_FUNCTION_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    console.log('📨 [SERVICE] Respuesta recibida');
    console.log('📊 Status:', response.status, response.statusText);
    console.log('📋 Headers:', Object.fromEntries(response.headers.entries()));

    if (!response.ok) {
      console.log('⚠️  [SERVICE] Respuesta no exitosa, leyendo error...');
      let errorMessage = '';
      try {
        // Leer el body solo una vez
        const contentType = response.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
          const errorData = await response.json();
          console.log('❌ Error data:', errorData);
          errorMessage = errorData.error || errorData.message || `Error HTTP ${response.status}`;
        } else {
          const textError = await response.text();
          console.log('❌ Error como texto:', textError);
          errorMessage = textError || `Error HTTP ${response.status}`;
        }
      } catch (e) {
        console.log('❌ No se pudo leer el cuerpo de error:', e.message);
        errorMessage = `Error HTTP ${response.status}: ${response.statusText}`;
      }
      throw new Error(errorMessage);
    }

    console.log('✅ [SERVICE] Parseando respuesta exitosa...');
    const result = await response.json();
    console.log('✅ [SERVICE] Respuesta parseada correctamente');
    console.log('🔗 URL obtenida:', result.url?.substring(0, 80) + '...');
    
    return result;
  } catch (error) {
    console.error('\n❌ [SERVICE] ERROR en fetchGeeImage:');
    console.error('🔴 Tipo:', error.constructor.name);
    console.error('📛 Mensaje:', error.message);
    console.error('📚 Stack:', error.stack);
    
    if (error.cause) {
      console.error('🔍 Causa:', error.cause);
    }
    
    // Re-lanzar con más contexto
    throw new Error(`Error al conectar con GEE: ${error.message}`, { cause: error });
  }
};

const fetchTiffCompuesto = async (geometry, zoom, layer) => {
  console.log('\n[Service] Starting fetchTiffCompuesto');
  console.log('[Service] Target URL:', TIFF_FUNCTION_URL);
  console.log('[Service] Geometry type:', geometry.type || 'FeatureCollection');
  console.log('[Service] Zoom:', zoom);
  console.log('[Service] Layer:', layer);

  try {
    const payload = { geometry, zoom, layer };
    console.log('[Service] Payload:', JSON.stringify(payload, null, 2));

    console.log('[Service] Sending request to Cloud Function...');
    const response = await fetch(TIFF_FUNCTION_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    console.log('[Service] Response received');
    console.log('[Service] Status:', response.status, response.statusText);
    console.log('[Service] Headers:', Object.fromEntries(response.headers.entries()));

    if (!response.ok) {
      console.log('[Service] Error response, reading body...');
      let errorMessage = '';
      try {
        const contentType = response.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
          const errorData = await response.json();
          console.log('[Service] Error data:', errorData);
          errorMessage = errorData.error || errorData.message || `Error HTTP ${response.status}`;
        } else {
          const textError = await response.text();
          console.log('[Service] Error text:', textError);
          errorMessage = textError || `Error HTTP ${response.status}`;
        }
      } catch (e) {
        console.log('[Service] Failed to read error body:', e.message);
        errorMessage = `Error HTTP ${response.status}: ${response.statusText}`;
      }
      throw new Error(errorMessage);
    }

    console.log('[Service] Parsing success response...');
    const result = await response.json();
    console.log('[Service] Parsed response OK');
    console.log('[Service] Preview URL:', result.preview_url);

    return result;
  } catch (error) {
    console.error('\n[Service] Error in fetchTiffCompuesto');
    console.error('[Service] Type:', error.constructor.name);
    console.error('[Service] Message:', error.message);
    console.error('[Service] Stack:', error.stack);

    if (error.cause) {
      console.error('[Service] Cause:', error.cause);
    }

    throw new Error(`Error al conectar con la Cloud Function: ${error.message}`, { cause: error });
  }
};

module.exports = { mapConfig, fetchGeeImage, fetchTiffCompuesto };
