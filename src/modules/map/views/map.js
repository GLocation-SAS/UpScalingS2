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

      // Mostrar log de tokens y área antes de redirigir
      const logDiv = document.getElementById("progress-log");
      if (logDiv && (data.result?.tokenUsage || data.result?.processedArea)) {
        const t = data.result.tokenUsage || {};
        const area = data.result.processedArea || 'N/A';
        logDiv.innerHTML = `🤖 <strong>Vertex AI (Gemini)</strong><br>` +
          `💰 Tokens — Input: ${t.input ?? '?'} | Output: ${t.output ?? '?'} | Total: <strong>${t.total ?? '?'}</strong><br>` +
          `📐 Área procesada: <strong>${area} km²</strong>`;
        logDiv.style.display = "block";
      }

      setTimeout(() => {
        window.location.href = `/map/result/${jobId}`;
      }, 5000);
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

async function startUpscaleProcessFromUrl(jpegUrl, geotiffUrl, geometry, satellitePreviewUrl, satelliteTiffUrl, model, prompt = null, ndviJpegUrl = null, satelliteBbox = null) {
  if (!jpegUrl) return null;
  showProgress("Iniciando mejora con IA...");

  // Enviar contexto de escala al backend para que el prompt sea consciente del nivel de zoom
  const captureZoom = window.currentRectangleZoom ? Math.floor(window.currentRectangleZoom) : null;
  const captureDimensions = window.currentRectangleDimensions || null;

  const response = await fetch("/api/upscale-from-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ imageUrl: jpegUrl, geotiffUrl, geometry, satellitePreviewUrl, satelliteTiffUrl, model, prompt, ndviJpegUrl, satelliteBbox, captureZoom, captureDimensions })
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

  // --- Google Places Search (New API) ---
  let googleSearchMarker = null;
  let searchTimeout = null;

  function setupGooglePlacesSearch() {
    const input = document.getElementById("google-places-search");
    const suggestionsDiv = document.getElementById("places-suggestions");

    if (!input || !suggestionsDiv) {
      console.warn("Google Places search elements not found");
      return;
    }

    const API_KEY = window.GOOGLE_PLACES_API_KEY;
    if (!API_KEY || API_KEY === "undefined") {
      console.error("Google Places API Key not found or invalid");
      return;
    }

    // Debounced autocomplete search
    input.addEventListener("input", async (e) => {
      const value = e.target.value.trim();

      // Clear previous timeout
      if (searchTimeout) clearTimeout(searchTimeout);

      // Clear suggestions if input is too short
      if (value.length < 3) {
        suggestionsDiv.innerHTML = "";
        suggestionsDiv.style.display = "none";
        return;
      }

      // Debounce: wait 300ms after user stops typing
      searchTimeout = setTimeout(async () => {
        try {
          console.log("🔍 [Places API] Iniciando búsqueda...");
          console.log("📝 Input:", value);
          console.log("🔑 API Key (primeros 10 chars):", API_KEY.substring(0, 10) + "...");

          const requestBody = {
            input: value,
            languageCode: "es",
            regionCode: "CO"
          };
          console.log("📦 Request body:", JSON.stringify(requestBody, null, 2));

          const response = await fetch("https://places.googleapis.com/v1/places:autocomplete", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Goog-Api-Key": API_KEY
            },
            body: JSON.stringify(requestBody)
          });

          console.log("📡 Response status:", response.status, response.statusText);
          console.log("📋 Response headers:", [...response.headers.entries()]);

          if (!response.ok) {
            // Intentar leer el cuerpo de la respuesta de error
            const errorText = await response.text();
            console.error("❌ Error response body:", errorText);

            let errorMessage = `Error ${response.status}: ${response.statusText}`;
            try {
              const errorData = JSON.parse(errorText);
              console.error("❌ Error data parsed:", errorData);
              errorMessage = errorData.error?.message || errorData.message || errorMessage;
            } catch (e) {
              console.error("⚠️ Could not parse error as JSON");
            }

            throw new Error(errorMessage);
          }

          const data = await response.json();
          console.log("✅ Success! Suggestions received:", data.suggestions?.length || 0);

          // Clear previous suggestions
          suggestionsDiv.innerHTML = "";

          // Show suggestions
          if (data.suggestions && data.suggestions.length > 0) {
            data.suggestions.forEach(suggestion => {
              const place = suggestion.placePrediction;
              const div = document.createElement("div");
              div.className = "suggestion-item";
              div.innerHTML = `
                <div class="suggestion-main">${place.text.text}</div>
                ${place.structuredFormat?.secondaryText ?
                  `<div class="suggestion-secondary">${place.structuredFormat.secondaryText.text}</div>` :
                  ''}
              `;

              // Click handler to select place
              div.addEventListener("click", async () => {
                await selectPlace(place.placeId, place.text.text);
                input.value = place.text.text;
                suggestionsDiv.innerHTML = "";
                suggestionsDiv.style.display = "none";
              });

              suggestionsDiv.appendChild(div);
            });
            suggestionsDiv.style.display = "block";
          } else {
            suggestionsDiv.innerHTML = '<div class="suggestion-item no-results">No se encontraron resultados</div>';
            suggestionsDiv.style.display = "block";
          }
        } catch (error) {
          console.error("❌ [Places API] Error completo:", error);
          suggestionsDiv.innerHTML = '<div class="suggestion-item error">Error al buscar ubicaciones</div>';
          suggestionsDiv.style.display = "block";
        }
      }, 300);
    });

    // Close suggestions when clicking outside
    document.addEventListener("click", (e) => {
      if (!input.contains(e.target) && !suggestionsDiv.contains(e.target)) {
        suggestionsDiv.innerHTML = "";
        suggestionsDiv.style.display = "none";
      }
    });

    // Clear suggestions on Escape key
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        suggestionsDiv.innerHTML = "";
        suggestionsDiv.style.display = "none";
      }
    });
  }

  // Fetch place details and move map
  async function selectPlace(placeId, placeName) {
    const API_KEY = window.GOOGLE_PLACES_API_KEY;

    try {
      console.log("📍 [Place Details] Obteniendo detalles...");
      console.log("🆔 Place ID:", placeId);
      console.log("📝 Place Name:", placeName);

      const response = await fetch(
        `https://places.googleapis.com/v1/places/${placeId}`,
        {
          headers: {
            "X-Goog-Api-Key": API_KEY,
            "X-Goog-FieldMask": "location,viewport"
          }
        }
      );

      console.log("📡 Response status:", response.status, response.statusText);

      if (!response.ok) {
        const errorText = await response.text();
        console.error("❌ Error response body:", errorText);

        let errorMessage = `Error ${response.status}: ${response.statusText}`;
        try {
          const errorData = JSON.parse(errorText);
          console.error("❌ Error data parsed:", errorData);
          errorMessage = errorData.error?.message || errorData.message || errorMessage;
        } catch (e) {
          console.error("⚠️ Could not parse error as JSON");
        }

        throw new Error(errorMessage);
      }

      const placeDetails = await response.json();
      console.log("✅ Place details received:", placeDetails);

      if (!placeDetails.location) {
        console.error("❌ No location in response");
        alert("No se encontraron coordenadas para esta ubicación.");
        return;
      }

      const lat = placeDetails.location.latitude;
      const lng = placeDetails.location.longitude;
      console.log("📍 Coordinates:", { lat, lng });

      // Ajustar vista del mapa
      if (placeDetails.viewport) {
        const viewport = placeDetails.viewport;
        console.log("🗺️ Fitting bounds to viewport");
        map.fitBounds([
          [viewport.low.longitude, viewport.low.latitude],
          [viewport.high.longitude, viewport.high.latitude]
        ]);
      } else {
        console.log("🗺️ Centering map at coordinates");
        map.setCenter([lng, lat]);
        map.setZoom(14);
      }

      // Agregar o actualizar marcador
      if (googleSearchMarker) googleSearchMarker.remove();

      googleSearchMarker = new maplibregl.Marker({ color: '#f40000ff' })
        .setLngLat([lng, lat])
        .addTo(map);

      console.log(`✅ Successfully moved to: ${placeName}`);
    } catch (error) {
      console.error("❌ [Place Details] Error completo:", error);
      alert("Error al obtener detalles de la ubicación.");
    }
  }

  // --- Estado del dibujo ---
  let drawingMode = false;
  let startLngLat = null;

  // Restricciones de área
  const MAX_AREA = 42250000; // 42 km²
  const MAX_WIDTH = 6500;     // metros
  const MAX_HEIGHT = 6500;    // metros

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
    background: rgba(15, 23, 42, 0.5); display: none; justify-content: center;
    align-items: center; z-index: 1000; backdrop-filter: blur(4px);
  `;
  loadingOverlay.innerHTML = `
    <div class="loading-card">
      <div class="loading-spinner"></div>
      <p class="loading-text">Procesando con Google Earth Engine...</p>
      </div>
  `;
  mapContainer.appendChild(loadingOverlay);

  // --- Area warning overlay ---
  const areaWarning = document.createElement("div");
  areaWarning.id = "area-warning";
  areaWarning.style.cssText = `
    position: absolute; top: 20px; left: 50%; transform: translateX(-50%);
    background: rgba(239, 68, 68, 0.95); color: white; padding: 12px 20px;
    border-radius: 8px; display: none; z-index: 1001; font-size: 14px;
    font-weight: 500; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    pointer-events: none; max-width: 90%; text-align: center;
  `;
  mapContainer.appendChild(areaWarning);

  // --- Area info overlay ---
  const areaInfo = document.createElement("div");
  areaInfo.id = "area-info";
  areaInfo.style.cssText = `
    position: absolute; bottom: 20px; left: 50%; transform: translateX(-50%);
    background: rgba(31, 97, 140, 0.92); color: white; padding: 10px 18px;
    border-radius: 8px; display: none; z-index: 1001; font-size: 13px;
    font-weight: 500; box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    pointer-events: none; text-align: center; white-space: nowrap;
  `;
  mapContainer.appendChild(areaInfo);

  // --- Inicializar capas de dibujo cuando el mapa cargue ---
  map.on("load", () => {

    // Inicializar búsqueda de Google Places
    setupGooglePlacesSearch();

    // --- Custom Prompt Toggle ---
    const modelSelect = document.getElementById("upscaling-model-select");
    const promptContainer = document.getElementById("custom-prompt-container");
    if (modelSelect && promptContainer) {
      modelSelect.addEventListener("change", (e) => {
        if (e.target.value === "Custom") {
          promptContainer.classList.remove("hidden");
        } else {
          promptContainer.classList.add("hidden");
        }
      });
    }

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

  // Calcular distancia en metros usando Haversine
  function calculateDistance(lat1, lng1, lat2, lng2) {
    const R = 6371000; // Radio de la Tierra en metros
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lng2 - lng1) * Math.PI / 180;

    const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
      Math.cos(φ1) * Math.cos(φ2) *
      Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
  }

  // Calcular dimensiones y área del rectángulo
  function calculateRectangleDimensions(lngLat1, lngLat2) {
    const minLng = Math.min(lngLat1.lng, lngLat2.lng);
    const maxLng = Math.max(lngLat1.lng, lngLat2.lng);
    const minLat = Math.min(lngLat1.lat, lngLat2.lat);
    const maxLat = Math.max(lngLat1.lat, lngLat2.lat);

    // Calcular ancho y alto en metros
    const width = calculateDistance(minLat, minLng, minLat, maxLng);
    const height = calculateDistance(minLat, minLng, maxLat, minLng);
    const area = width * height;

    return { width, height, area };
  }

  // Verificar si las dimensiones exceden los límites
  function checkDimensionLimits(lngLat1, lngLat2) {
    const { width, height, area } = calculateRectangleDimensions(lngLat1, lngLat2);

    const errors = [];
    if (area > MAX_AREA) {
      errors.push(`Área: ${(area / 1_000_000).toFixed(2)} km² (máx: ${MAX_AREA / 1_000_000} km²)`);
    }
    if (width > MAX_WIDTH) {
      errors.push(`Ancho: ${Math.round(width)}m (máx: ${MAX_WIDTH}m)`);
    }
    if (height > MAX_HEIGHT) {
      errors.push(`Alto: ${Math.round(height)}m (máx: ${MAX_HEIGHT}m)`);
    }

    return {
      valid: errors.length === 0,
      errors,
      dimensions: { width, height, area }
    };
  }

  // Mostrar advertencia de área
  function showAreaWarning(errors) {
    areaWarning.innerHTML = `
      <div style="font-weight: 600; margin-bottom: 4px;">⚠️ El área dibujada excede los límites</div>
      <div style="font-size: 12px;">${errors.join(' • ')}</div>
    `;
    areaWarning.style.display = "block";
  }

  // Ocultar advertencia de área
  function hideAreaWarning() {
    areaWarning.style.display = "none";
  }

  // Mostrar info de área del rectángulo seleccionado
  function showAreaInfo(dims) {
    const areaKm2 = (dims.area / 1e6).toFixed(3);
    const widthM = Math.round(dims.width);
    const heightM = Math.round(dims.height);
    areaInfo.innerHTML = `📐 ${widthM}m × ${heightM}m &nbsp;|&nbsp; Área: <strong>${areaKm2} km²</strong>`;
    areaInfo.style.display = "block";
  }

  function hideAreaInfo() {
    areaInfo.style.display = "none";
  }

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

    // Ocultar info de área previa al redibujar
    hideAreaInfo();

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

    // Ocultar advertencia
    hideAreaWarning();

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

    // Validar dimensiones en tiempo real
    const validation = checkDimensionLimits(startLngLat, e.lngLat);
    if (!validation.valid) {
      showAreaWarning(validation.errors);
    } else {
      hideAreaWarning();
    }
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
      hideAreaWarning();
      return;
    }

    // Validar dimensiones finales
    const validation = checkDimensionLimits(startLngLat, endLngLat);
    if (!validation.valid) {
      alert(`⚠️ El área dibujada excede los límites permitidos:\n\n${validation.errors.join('\n')}\n\nPor favor, dibuja un área más pequeña.`);
      startLngLat = null;
      map.getSource("draw-rectangle-preview").setData(emptyGeoJSON);
      hideAreaWarning();
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

    const currentZoom = map.getZoom();
    window.currentRectangle = geoJSON;
    window.currentRectangleZoom = currentZoom;
    window.currentRectangleDimensions = validation.dimensions;
    console.log("✓ Rectangle captured:", geoJSON, "at zoom:", currentZoom, "dimensions:", validation.dimensions);

    // Mostrar info del área seleccionada
    showAreaInfo(validation.dimensions);

    // Ocultar advertencia
    hideAreaWarning();

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
      window.currentRectangleZoom = null;
      window.currentRectangleDimensions = null;
      hideAreaWarning();
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

  // --- Función de fetch con retry para cold starts ---
  const fetchWithRetry = async (url, options, maxRetries = 2) => {
    for (let i = 0; i <= maxRetries; i++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 60000);

        const response = await fetch(url, {
          ...options,
          signal: controller.signal
        });

        clearTimeout(timeout);
        return response;
      } catch (error) {
        console.log(`Intento ${i + 1}/${maxRetries + 1} falló:`, error.message);

        if (i === maxRetries) throw error;
        if (error.name === 'AbortError') throw error;

        await new Promise(resolve => setTimeout(resolve, 2000 * (i + 1)));
      }
    }
  };

  // --- Boton Capturar y procesar ---
  const captureBtn = document.getElementById("capture-btn");
  if (captureBtn) {
    captureBtn.addEventListener("click", async function (e) {
      e.preventDefault();
      const geometryOutput = document.getElementById("geometry-output");
      const selectedDate = datePicker?.value;

      const selectedModel = document.getElementById("upscaling-model-select").value;

      if (!geometryOutput.value || geometryOutput.value.trim() === "") {
        alert("⚠️ No hay rectángulo dibujado. Por favor, dibuja un rectángulo en el mapa.");
        return;
      }

      if (!selectedDate) {
        alert("⚠️ Por favor, selecciona una fecha para Sentinel 2.");
        return;
      }

      // Validar dimensiones antes de enviar
      if (!window.currentRectangleDimensions) {
        alert("⚠️ Error: No se pudieron validar las dimensiones del área. Por favor, dibuja el rectángulo nuevamente.");
        return;
      }

      const { width, height, area } = window.currentRectangleDimensions;
      if (area > MAX_AREA || width > MAX_WIDTH || height > MAX_HEIGHT) {
        alert(`⚠️ El área seleccionada excede los límites permitidos:\n\nÁrea: ${(area / 1_000_000).toFixed(2)} km² (máx: ${MAX_AREA / 1_000_000} km²)\nAncho: ${Math.round(width)}m (máx: ${MAX_WIDTH}m)\nAlto: ${Math.round(height)}m (máx: ${MAX_HEIGHT}m)\n\nPor favor, dibuja un área más pequeña.`);
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

        console.log("Enviando peticiones en paralelo...", { date: selectedDate, zoom: Math.floor(map.getZoom()), layer: "satellite" });

        const zoom = window.currentRectangleZoom
          ? Math.floor(window.currentRectangleZoom)
          : Math.floor(map.getZoom());
        const layer = "satellite";

        // Peticiones paralelas: GEE + TIFF compuesto satelital
        const geePromise = fetchWithRetry("/map/gee-image", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ date: selectedDate, geometry, model: selectedModel })
        });

        const tiffPromise = fetchWithRetry("/map/tiff-compuesto", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ geometry: geoJSON, zoom, layer })
        });

        const [geeResult, tiffResult] = await Promise.allSettled([geePromise, tiffPromise]);

        let geeData = null;
        let tiffData = null;
        let geeError = null;
        let tiffError = null;

        if (geeResult.status === "fulfilled") {
          if (!geeResult.value.ok) {
            const errorData = await geeResult.value.json();
            geeError = errorData.message || errorData.error || "Error al obtener imagen Sentinel-2";
          } else {
            geeData = await geeResult.value.json();
          }
        } else {
          geeError = geeResult.reason?.message || "Error al conectar con GEE";
        }

        if (tiffResult.status === "fulfilled") {
          if (!tiffResult.value.ok) {
            const errorData = await tiffResult.value.json();
            tiffError = errorData.message || errorData.error || "Error al obtener mosaico satelital";
          } else {
            tiffData = await tiffResult.value.json();
          }
        } else {
          tiffError = tiffResult.reason?.message || "Error al conectar con TIFF compuesto";
        }

        // Añadir capa GEE al mapa dependiendo del modelo seleccionado
        if (geeData?.url && selectedModel !== 'upscaling_ndvi') {
          addGeeLayerToMap(geeData.url, selectedDate, geometry);
        } else if (geeData?.ndviTileUrl && selectedModel === 'upscaling_ndvi') {
          addGeeLayerToMap(geeData.ndviTileUrl, selectedDate, geometry);
        }

        if (geeError) {
          throw new Error(`Sentinel-2: ${geeError}`);
        }

        const jpegUrl = geeData.jpegUrl || geeData.imageUrl || geeData.image_url || geeData.public_url;
        const geotiffUrl = geeData.geotiffUrl;

        if (!jpegUrl) {
          throw new Error("La respuesta no incluye la URL de la imagen JPEG.");
        }
        if (jpegUrl.includes("{x}") || jpegUrl.includes("{y}") || jpegUrl.includes("{z}")) {
          throw new Error("La URL de imagen es una plantilla de tiles, no un archivo descargable.");
        }

        // Datos del mapa satelital no híbrido
        const satellitePreviewUrl = tiffData?.preview_url || null;
        const satelliteTiffUrl = tiffData?.tiff_url || null;
        const satelliteBbox = tiffData?.bbox || null;

        if (tiffError) {
          console.warn("Advertencia satelital:", tiffError);
        }

        const ndviJpegUrl = geeData?.ndviJpegUrl || null;

        loadingOverlay.style.display = "none";

        const customPromptInput = document.getElementById("custom-prompt-input");
        const customPrompt = customPromptInput && !document.getElementById("custom-prompt-container").classList.contains("hidden")
          ? customPromptInput.value.trim()
          : null;

        const { jobId } = await startUpscaleProcessFromUrl(jpegUrl, geotiffUrl, geometry, satellitePreviewUrl, satelliteTiffUrl, selectedModel, customPrompt, ndviJpegUrl, satelliteBbox);
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
