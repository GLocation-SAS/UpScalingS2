const { mapConfig, fetchGeeImage, fetchTiffCompuesto } = require("./map.services");

const renderMap = (req, res) => {
  const API_KEY = process.env.API_KEY;
  res.render("map/views/map", { mapConfig, API_KEY });
};

const getGeeImageUrl = async (req, res) => {
  console.log("\n🔵 [CONTROLLER] Recibiendo petición /gee-image");
  console.log("📅 Fecha:", req.body.date);
  console.log("🗺️  Geometría:", JSON.stringify(req.body.geometry, null, 2));
  
  try {
    const { date, geometry } = req.body;
    
    if (!date || !geometry) {
      console.log("❌ [CONTROLLER] Parámetros faltantes");
      return res.status(400).json({
        error: "Parámetros requeridos: date y geometry"
      });
    }
    
    console.log("🚀 [CONTROLLER] Llamando a fetchGeeImage...");
    const result = await fetchGeeImage(date, geometry);
    console.log("✅ [CONTROLLER] Respuesta recibida de GEE");
    console.log("🔗 URL de tiles:", result.url?.substring(0, 100) + "...");
    console.log("📊 Metadata:", result.metadata);
    
    res.json(result);
    console.log("✅ [CONTROLLER] Respuesta enviada al cliente\n");
  } catch (error) {
    console.error("\n❌ [CONTROLLER] ERROR:");
    console.error("📛 Mensaje:", error.message);
    console.error("📚 Stack:", error.stack);
    console.error("🔍 Error completo:", error);
    
    res.status(500).json({
      error: "Error al procesar la solicitud",
      message: error.message,
      details: error.cause ? error.cause.message : null
    });
    console.log("⚠️  [CONTROLLER] Respuesta de error enviada al cliente\n");
  }
};

const getTiffCompuesto = async (req, res) => {
  console.log('\n[Controller] Received /tiff-compuesto');
  console.log('[Controller] Zoom:', req.body.zoom);
  console.log('[Controller] Layer:', req.body.layer);
  console.log('[Controller] Geometry:', JSON.stringify(req.body.geometry, null, 2));

  try {
    const { geometry, zoom, layer } = req.body;

    if (!geometry || typeof zoom !== 'number') {
      console.log('[Controller] Missing parameters');
      return res.status(400).json({
        error: 'Parametros requeridos: geometry y zoom'
      });
    }

    console.log('[Controller] Calling fetchTiffCompuesto...');
    const result = await fetchTiffCompuesto(geometry, zoom, layer);
    console.log('[Controller] Response received from Cloud Function');
    console.log('[Controller] Preview URL:', result.preview_url);
    console.log('[Controller] TIFF URL:', result.tiff_url);

    res.json(result);
    console.log('[Controller] Response sent\n');
  } catch (error) {
    console.error('\n[Controller] Error');
    console.error('[Controller] Message:', error.message);
    console.error('[Controller] Stack:', error.stack);
    console.error('[Controller] Full error:', error);

    res.status(500).json({
      error: 'Error al procesar la solicitud',
      message: error.message,
      details: error.cause ? error.cause.message : null
    });
    console.log('[Controller] Error response sent\n');
  }
};

const renderMapResult = (req, res) => {
  const { jobs } = req;
  const { jobId } = req.params;
  const job = jobs[jobId];

  if (!job || !job.result) {
    return res.status(404).send("Resultado no encontrado o aún en proceso. Por favor, vuelve a la página anterior.");
  }

  res.render("map/views/map-viewer", {
    jobId,
    mapConfig: {
      containerId: "map",
      tileUrl: "https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}",
      maplibreLogo: false
    },
    resultData: job.result
  });
};

module.exports = { renderMap, getGeeImageUrl, getTiffCompuesto, renderMapResult };