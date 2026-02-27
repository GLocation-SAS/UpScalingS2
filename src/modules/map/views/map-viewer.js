document.addEventListener('DOMContentLoaded', () => {
  const mapElement = document.getElementById('map');
  if (!mapElement) return;

  // Leemos los datos directamente de los atributos data-* del DOM
  const tileUrl = mapElement.dataset.tileUrl;
  const bounds = JSON.parse(mapElement.dataset.bounds);
  const originalUrl = mapElement.dataset.originalUrl;
  const improvedUrl = mapElement.dataset.improvedUrl;

  // Verificación de seguridad: si alguna URL es undefined, detenemos la ejecución.
  if (!originalUrl || !improvedUrl) {
    console.error("Error: Las URLs de las imágenes no se encontraron en los atributos del DOM.");
    alert("Error: No se pudieron cargar las URLs de las imágenes para el mapa.");
    return;
  }

  const map = new maplibregl.Map({
    container: 'map',
    style: {
      version: 8,
      sources: { 'raster-tiles': { type: 'raster', tiles: [tileUrl], tileSize: 256 } },
      layers: [{ id: 'base-tiles', type: 'raster', source: 'raster-tiles' }]
    },
    center: [(bounds[0][0] + bounds[1][0]) / 2, (bounds[0][1] + bounds[1][1]) / 2],
    maplibreLogo: false
  });

  map.on('load', () => {
    const imageCoordinates = [
      [bounds[0][0], bounds[1][1]], // Top-Left
      bounds[1],                   // Top-Right
      [bounds[1][0], bounds[0][1]], // Bottom-Right
      bounds[0]                    // Bottom-Left
    ];

    // Añadir la imagen original
    map.addSource('original-image-source', {
      type: 'image',
      url: originalUrl,
      coordinates: imageCoordinates
    });
    map.addLayer({
      id: 'original-image-layer',
      type: 'raster',
      source: 'original-image-source',
      paint: { 'raster-opacity': 1 },
      layout: { 'visibility': 'none' }
    });

    // Añadir la imagen mejorada
    map.addSource('improved-image-source', {
      type: 'image',
      url: improvedUrl,
      coordinates: imageCoordinates
    });
    map.addLayer({
      id: 'improved-image-layer',
      type: 'raster',
      source: 'improved-image-source',
      paint: { 'raster-opacity': 1 },
      layout: { 'visibility': 'visible' }
    });

    // Añadir la imagen satelital no híbrida (si existe)
    const satelliteUrl = mapElement.dataset.satelliteUrl;
    if (satelliteUrl) {
      // Usar bounds propios del satelital si están disponibles (evita desalineación con bounds de GEE)
      let satelliteCoordinates = imageCoordinates;
      const satelliteBboxStr = mapElement.dataset.satelliteBounds;
      if (satelliteBboxStr) {
        try {
          const sBbox = JSON.parse(satelliteBboxStr); // [minLon, minLat, maxLon, maxLat]
          if (Array.isArray(sBbox) && sBbox.length === 4) {
            satelliteCoordinates = [
              [sBbox[0], sBbox[3]], // Top-Left
              [sBbox[2], sBbox[3]], // Top-Right
              [sBbox[2], sBbox[1]], // Bottom-Right
              [sBbox[0], sBbox[1]]  // Bottom-Left
            ];
          }
        } catch (e) {
          console.warn('No se pudieron parsear los bounds del satelital:', e);
        }
      }
      map.addSource('satellite-image-source', {
        type: 'image',
        url: satelliteUrl,
        coordinates: satelliteCoordinates
      });
      map.addLayer({
        id: 'satellite-image-layer',
        type: 'raster',
        source: 'satellite-image-source',
        paint: { 'raster-opacity': 1 },
        layout: { 'visibility': 'none' }
      });
    }

    // Añadir el mapa NDVI (si existe)
    const ndviUrl = mapElement.dataset.ndviUrl;
    if (ndviUrl) {
      map.addSource('ndvi-image-source', {
        type: 'image',
        url: ndviUrl,
        coordinates: imageCoordinates
      });
      map.addLayer({
        id: 'ndvi-image-layer',
        type: 'raster',
        source: 'ndvi-image-source',
        paint: { 'raster-opacity': 1 },
        layout: { 'visibility': 'none' }
      });
    }

    map.fitBounds(bounds, { padding: 40 });
  });

  // Lógica para los checkboxes de capa
  document.querySelectorAll('input[name="layer-checkbox"]').forEach(checkbox => {
    checkbox.addEventListener('change', (event) => {
      const layerIdSuffix = event.target.value;
      const layerId = layerIdSuffix === 'original' ? 'original-image-layer'
        : layerIdSuffix === 'improved' ? 'improved-image-layer'
          : layerIdSuffix === 'satellite' ? 'satellite-image-layer'
            : layerIdSuffix === 'ndvi' ? 'ndvi-image-layer' : null;

      if (layerId && map.getLayer(layerId)) {
        map.setLayoutProperty(layerId, 'visibility', event.target.checked ? 'visible' : 'none');
      }
    });
  });

  // Lógica para los sliders de opacidad por capa
  ['improved', 'original', 'satellite', 'ndvi'].forEach(layerIdSuffix => {
    const slider = document.getElementById(`opacity-${layerIdSuffix}`);
    if (slider) {
      slider.addEventListener('input', (event) => {
        const opacity = parseFloat(event.target.value);
        const layerId = layerIdSuffix === 'original' ? 'original-image-layer'
          : layerIdSuffix === 'improved' ? 'improved-image-layer'
            : layerIdSuffix === 'satellite' ? 'satellite-image-layer'
              : layerIdSuffix === 'ndvi' ? 'ndvi-image-layer' : null;

        if (layerId && map.getLayer(layerId)) {
          map.setPaintProperty(layerId, 'raster-opacity', opacity);
        }
      });
    }
  });

  // Lógica para el menú de descargas
  const downloadBtn = document.getElementById('download-menu-btn');
  const downloadDropdown = document.getElementById('download-dropdown');
  const downloadIcon = document.getElementById('download-menu-icon');

  if (downloadBtn && downloadDropdown) {
    downloadBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isHidden = downloadDropdown.classList.contains('hidden');

      if (isHidden) {
        downloadDropdown.classList.remove('hidden');
        downloadDropdown.classList.add('flex');
        if (downloadIcon) downloadIcon.textContent = 'expand_more';
      } else {
        downloadDropdown.classList.add('hidden');
        downloadDropdown.classList.remove('flex');
        if (downloadIcon) downloadIcon.textContent = 'expand_less';
      }
    });

    // Cerrar al hacer click afuera
    document.addEventListener('click', (e) => {
      if (!downloadBtn.contains(e.target) && !downloadDropdown.contains(e.target)) {
        downloadDropdown.classList.add('hidden');
        downloadDropdown.classList.remove('flex');
        if (downloadIcon) downloadIcon.textContent = 'expand_less';
      }
    });
  }
});