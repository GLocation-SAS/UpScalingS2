const mapElement = document.querySelector(".map");

const progressOverlay = document.getElementById("progress-overlay");
const progressText = document.getElementById("progress-text");
const progressBar = document.getElementById("progress-bar");
const progressCounter = document.getElementById("progress-counter");

function showProgress(text = "Iniciando proceso...") {
  if (!progressOverlay) return;
  progressText.textContent = text;
  progressCounter.textContent = "";
  progressBar.style.width = "0%";
  progressOverlay.classList.remove("hidden");
}

function updateProgress(data) {
  if (!progressOverlay) return;
  if (data.message) progressText.textContent = data.message;
  if (data.total > 0) {
    const percent = Math.round((data.processed / data.total) * 100);
    progressBar.style.width = `${percent}%`;
    progressCounter.textContent = `${data.processed} / ${data.total}`;
  }
}

function hideProgress() {
  if (!progressOverlay) return;
  progressOverlay.classList.add("hidden");
}

function handleJobProgress(jobId) {
  const eventSource = new EventSource(`/api/progress/${jobId}`);
  eventSource.onmessage = (event) => {
    const data = JSON.parse(event.data);

    if (data.status === "error") {
      alert(`Error durante el procesamiento: ${data.error}`);
      eventSource.close();
      hideProgress();
    } else if (data.status === "complete") {
      updateProgress(data);
      eventSource.close();
      setTimeout(() => {
        window.location.href = `/map/result/${jobId}`;
      }, 500);
    } else {
      updateProgress(data);
    }
  };
  eventSource.onerror = () => {
    alert("Se perdió la conexión con el servidor.");
    eventSource.close();
    hideProgress();
  };
}

async function startUpscaleProcessFromUrl(imageUrl) {
  if (!imageUrl) return null;
  showProgress("Iniciando mejora con IA...");
  const response = await fetch("/api/upscale-from-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ imageUrl })
  });

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(errorData.error || "Error en el servidor.");
  }

  return response.json();
}

if (mapElement) {
  const tileUrl = mapElement.dataset.tileUrl;
  const center = JSON.parse(mapElement.dataset.center || "[0, 0]");
  const zoom = Number(mapElement.dataset.zoom || "1");
  const maplibreLogo = mapElement.dataset.logo === "true";

  const style = {
    version: 8,
    sources: {
      "raster-tiles": {
        type: "raster",
        tiles: [tileUrl],
        tileSize: 256,
        maxzoom: 19
      }
    },
    layers: [
      {
        id: "base-tiles",
        type: "raster",
        source: "raster-tiles",
        minzoom: 0,
        maxzoom: 22
      }
    ]
  };

  const map = new maplibregl.Map({
    container: mapElement.id,
    style,
    center,
    zoom,
    maplibreLogo
  });

  // --- Estado del dibujo ---
  let drawingMode = false;
  let startLngLat = null;

  // GeoJSON vacio para el rectangulo
  const emptyGeoJSON = {
    type: "FeatureCollection",
    features: []
  };

  // --- Loading overlay ---
  const mapContainer = mapElement.parentElement;
  const loadingOverlay = document.createElement("div");
  loadingOverlay.id = "loading-overlay";
  loadingOverlay.style.cssText = `
    position: absolute; top: 0; left: 0; width: 100%; height: 100%;
    background: rgba(0,0,0,0.7); display: none; justify-content: center;
    align-items: center; z-index: 1000; flex-direction: column;
  `;
  loadingOverlay.innerHTML = `
    <img src="https://i.gifer.com/ZKZg.gif" alt="Cargando..." style="width:100px;height:100px;">
    <p style="color:white;margin-top:20px;font-size:18px;">Procesando con Google Earth Engine...</p>
  `;
  mapContainer.appendChild(loadingOverlay);

  // --- Inicializar capas de dibujo cuando el mapa cargue ---
  map.on("load", () => {

    // Source para el rectangulo que se esta dibujando (preview)
    map.addSource("draw-rectangle-preview", {
      type: "geojson",
      data: emptyGeoJSON
    });

    map.addLayer({
      id: "draw-rectangle-preview-fill",
      type: "fill",
      source: "draw-rectangle-preview",
      paint: {
        "fill-color": "#4f83ff",
        "fill-opacity": 0.25
      }
    });

    map.addLayer({
      id: "draw-rectangle-preview-outline",
      type: "line",
      source: "draw-rectangle-preview",
      paint: {
        "line-color": "#1f3b6d",
        "line-width": 2,
        "line-dasharray": [3, 2]
      }
    });

    // Source para el rectangulo confirmado (permanente)
    map.addSource("draw-rectangle-final", {
      type: "geojson",
      data: emptyGeoJSON
    });

    map.addLayer({
      id: "draw-rectangle-final-fill",
      type: "fill",
      source: "draw-rectangle-final",
      paint: {
        "fill-color": "#4f83ff",
        "fill-opacity": 0.2
      }
    });

    map.addLayer({
      id: "draw-rectangle-final-outline",
      type: "line",
      source: "draw-rectangle-final",
      paint: {
        "line-color": "#1f3b6d",
        "line-width": 2.5
      }
    });

    console.log("✓ Map layers initialized (native MapLibre drawing)");
  });

  // --- Funciones de dibujo ---

  function makeRectangleGeoJSON(lngLat1, lngLat2) {
    const minLng = Math.min(lngLat1.lng, lngLat2.lng);
    const maxLng = Math.max(lngLat1.lng, lngLat2.lng);
    const minLat = Math.min(lngLat1.lat, lngLat2.lat);
    const maxLat = Math.max(lngLat1.lat, lngLat2.lat);

    return {
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        geometry: {
          type: "Polygon",
          coordinates: [[
            [minLng, minLat],
            [maxLng, minLat],
            [maxLng, maxLat],
            [minLng, maxLat],
            [minLng, minLat]
          ]]
        },
        properties: { type: "rectangle" }
      }]
    };
  }

  function enableDrawing() {
    drawingMode = true;
    startLngLat = null;
    map.getCanvas().style.cursor = "crosshair";

    // Desactivar drag del mapa mientras dibujamos
    map.dragPan.disable();

    console.log("✓ Drawing mode ON");
  }

  function disableDrawing() {
    drawingMode = false;
    startLngLat = null;
    map.getCanvas().style.cursor = "";

    // Reactivar drag del mapa
    map.dragPan.enable();

    // Limpiar preview
    const src = map.getSource("draw-rectangle-preview");
    if (src) src.setData(emptyGeoJSON);

    console.log("✓ Drawing mode OFF");
  }

  // --- Eventos de raton sobre el mapa ---

  map.on("mousedown", (e) => {
    if (!drawingMode) return;

    startLngLat = e.lngLat;
    e.preventDefault();
  });

  map.on("mousemove", (e) => {
    if (!drawingMode || !startLngLat) return;

    const preview = makeRectangleGeoJSON(startLngLat, e.lngLat);
    map.getSource("draw-rectangle-preview").setData(preview);
  });

  map.on("mouseup", (e) => {
    if (!drawingMode || !startLngLat) return;

    const endLngLat = e.lngLat;

    // Verificar que el rectángulo tenga tamaño mínimo
    const dlng = Math.abs(endLngLat.lng - startLngLat.lng);
    const dlat = Math.abs(endLngLat.lat - startLngLat.lat);

    if (dlng < 0.0001 && dlat < 0.0001) {
      // Click sin arrastrar, ignorar
      startLngLat = null;
      return;
    }

    // Crear GeoJSON final
    const geoJSON = makeRectangleGeoJSON(startLngLat, endLngLat);

    // Mostrar rectángulo permanente
    map.getSource("draw-rectangle-final").setData(geoJSON);

    // Limpiar preview
    map.getSource("draw-rectangle-preview").setData(emptyGeoJSON);

    // Actualizar textarea
    const geometryOutput = document.getElementById("geometry-output");
    if (geometryOutput) {
      geometryOutput.value = JSON.stringify(geoJSON, null, 2);
    }

    window.currentRectangle = geoJSON;
    console.log("✓ Rectangle captured:", geoJSON);

    // Desactivar modo dibujo
    disableDrawing();
    setInactiveAll();
  });

  // --- Boton Rectangulo ---
  const drawBtn = document.getElementById("draw-rectangle");
  if (drawBtn) {
    drawBtn.addEventListener("click", function (e) {
      e.preventDefault();

      if (drawingMode) {
        disableDrawing();
        this.classList.remove("active");
      } else {
        enableDrawing();
        setActiveButton(this);
      }
    });
  }

  // --- Boton Limpiar ---
  const clearBtn = document.getElementById("delete-all");
  if (clearBtn) {
    clearBtn.addEventListener("click", function (e) {
      e.preventDefault();

      disableDrawing();

      // Limpiar rectángulo permanente
      const src = map.getSource("draw-rectangle-final");
      if (src) src.setData(emptyGeoJSON);

      // Limpiar textarea
      const geometryOutput = document.getElementById("geometry-output");
      if (geometryOutput) geometryOutput.value = "";

      window.currentRectangle = null;
      setInactiveAll();

      // Remover capas GEE
      map.getStyle().layers.forEach(layer => {
        if (layer.id.startsWith("gee-layer-")) map.removeLayer(layer.id);
      });
      Object.keys(map.getStyle().sources).forEach(sid => {
        if (sid.startsWith("gee-source-")) map.removeSource(sid);
      });

      console.log("✓ Everything cleared");
    });
  }

  // --- Date picker ---
  const datePicker = document.getElementById("date-picker");
  if (datePicker) {
    datePicker.valueAsDate = new Date();
  }

  // --- Boton Capturar y procesar ---
  const captureBtn = document.getElementById("capture-btn");
  if (captureBtn) {
    captureBtn.addEventListener("click", async function (e) {
      e.preventDefault();
      const geometryOutput = document.getElementById("geometry-output");
      const selectedDate = datePicker?.value;

      if (!geometryOutput.value || geometryOutput.value.trim() === "") {
        alert("⚠️ No hay rectángulo dibujado. Por favor, dibuja un rectángulo en el mapa.");
        return;
      }

      if (!selectedDate) {
        alert("⚠️ Por favor, selecciona una fecha para Sentinel 2.");
        return;
      }

      try {
        const geoJSON = JSON.parse(geometryOutput.value);
        const geometry = geoJSON.features[0].geometry;

        // Mostrar loading overlay
        loadingOverlay.style.display = "flex";

        captureBtn.disabled = true;
        captureBtn.innerHTML = `
          <svg width="18" height="18" viewBox="0 0 20 20">
            <circle cx="10" cy="10" r="8" stroke="currentColor" stroke-width="2"
              fill="none" stroke-dasharray="15" stroke-dashoffset="0">
              <animateTransform attributeName="transform" type="rotate"
                from="0 10 10" to="360 10 10" dur="1s" repeatCount="indefinite"/>
            </circle>
          </svg>
          Procesando...
        `;

        console.log("Enviando petición a GEE:", { date: selectedDate, geometry });

        const response = await fetch("/map/gee-image", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ date: selectedDate, geometry })
        });

        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.error || "Error al obtener imagen");
        }

        const data = await response.json();
        console.log("✓ Respuesta recibida:", data);

        addGeeLayerToMap(data.url, selectedDate, geometry);

        const imageUrl = data.jpegUrl || data.imageUrl || data.image_url || data.public_url;
        if (!imageUrl) {
          throw new Error("La respuesta no incluye la URL de la imagen JPEG.");
        }
        if (imageUrl.includes("{x}") || imageUrl.includes("{y}") || imageUrl.includes("{z}")) {
          throw new Error("La URL de imagen es una plantilla de tiles, no un archivo descargable.");
        }

        loadingOverlay.style.display = "none";
        const { jobId } = await startUpscaleProcessFromUrl(imageUrl);
        handleJobProgress(jobId);
      } catch (error) {
        alert(`⚠️ Error: ${error.message}`);
        console.error("Error al procesar:", error);
        hideProgress();
      } finally {
        loadingOverlay.style.display = "none";
        captureBtn.disabled = false;
        captureBtn.innerHTML = `
          <svg width="18" height="18" viewBox="0 0 20 20">
            <path d="M10 2a8 8 0 100 16 8 8 0 000-16zm1 11h-2V9h2v4zm0-5h-2V6h2v2z" fill="currentColor"/>
          </svg>
          Capturar y procesar
        `;
      }
    });
  }

  // --- Agregar capa GEE al mapa ---
  function addGeeLayerToMap(tileUrl, date, geometry) {
    const layerId = `gee-layer-${Date.now()}`;
    const sourceId = `gee-source-${Date.now()}`;

    // Remover capas GEE anteriores
    map.getStyle().layers.forEach(layer => {
      if (layer.id.startsWith("gee-layer-")) map.removeLayer(layer.id);
    });
    Object.keys(map.getStyle().sources).forEach(sid => {
      if (sid.startsWith("gee-source-")) map.removeSource(sid);
    });

    map.addSource(sourceId, {
      type: "raster",
      tiles: [tileUrl],
      tileSize: 256,
      maxzoom: 19
    });

    map.addLayer({
      id: layerId,
      type: "raster",
      source: sourceId,
      paint: { "raster-opacity": 0.85 }
    });

    // Zoom al área del rectángulo
    if (geometry?.coordinates?.[0]) {
      const coords = geometry.coordinates[0];
      const lngs = coords.map(c => c[0]);
      const lats = coords.map(c => c[1]);

      map.fitBounds(
        [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
        { padding: 50, duration: 1000 }
      );
    }

    console.log(`✓ Capa GEE agregada: ${layerId}`);
  }

  // --- Utilidades de botones ---
  function setActiveButton(button) {
    document.querySelectorAll(".tool-btn").forEach(btn => btn.classList.remove("active"));
    button.classList.add("active");
  }

  function setInactiveAll() {
    document.querySelectorAll(".tool-btn").forEach(btn => btn.classList.remove("active"));
  }
}
