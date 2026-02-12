const { mapConfig, fetchGeeImage } = require("./map.services");

const renderMap = (req, res) => {
  res.render("map/views/map", { mapConfig });
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

const renderMapResult = (req, res) => {
  const { jobs } = req;
  const { jobId } = req.params;
  const job = jobs[jobId];

  if (!job || !job.result) {
    return res.status(404).send("Resultado no encontrado o aún en proceso. Por favor, vuelve a la página anterior.");
  }

  res.render("map/views/map-viewer", {
    mapConfig: {
      containerId: "map",
      tileUrl: "https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}",
      maplibreLogo: false
    },
    resultData: job.result,
    jobId: jobId
  });
};

module.exports = { renderMap, getGeeImageUrl, renderMapResult };