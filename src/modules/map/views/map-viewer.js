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
      map.addSource('satellite-image-source', {
        type: 'image',
        url: satelliteUrl,
        coordinates: imageCoordinates
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

  // Lógica para los controles de capa (sin cambios)
  document.querySelectorAll('input[name="layer-toggle"]').forEach(radio => {
    radio.addEventListener('change', (event) => {
      const selectedValue = event.target.value;
      map.setLayoutProperty('original-image-layer', 'visibility', selectedValue === 'original' ? 'visible' : 'none');
      map.setLayoutProperty('improved-image-layer', 'visibility', selectedValue === 'improved' ? 'visible' : 'none');

      // Controlar capa satelital no híbrida
      const satelliteUrl = mapElement.dataset.satelliteUrl;
      if (satelliteUrl && map.getLayer('satellite-image-layer')) {
        map.setLayoutProperty('satellite-image-layer', 'visibility', selectedValue === 'satellite' ? 'visible' : 'none');
      }

      // Controlar capa NDVI
      const ndviUrl = mapElement.dataset.ndviUrl;
      if (ndviUrl && map.getLayer('ndvi-image-layer')) {
        map.setLayoutProperty('ndvi-image-layer', 'visibility', selectedValue === 'ndvi' ? 'visible' : 'none');
      }
    });
  });

  // Lógica para el slider de opacidad (sin cambios)
  const opacitySlider = document.getElementById('opacity-slider');
  opacitySlider.addEventListener('input', (event) => {
    const opacity = parseFloat(event.target.value);
    map.setPaintProperty('improved-image-layer', 'raster-opacity', opacity);
    map.setPaintProperty('original-image-layer', 'raster-opacity', opacity);

    // Aplicar opacidad a la capa satelital no híbrida
    const satelliteUrl = mapElement.dataset.satelliteUrl;
    if (satelliteUrl && map.getLayer('satellite-image-layer')) {
      map.setPaintProperty('satellite-image-layer', 'raster-opacity', opacity);
    }

    const ndviUrl = mapElement.dataset.ndviUrl;
    if (ndviUrl && map.getLayer('ndvi-image-layer')) {
      map.setPaintProperty('ndvi-image-layer', 'raster-opacity', opacity);
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