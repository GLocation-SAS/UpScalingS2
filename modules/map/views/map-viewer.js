document.addEventListener('DOMContentLoaded', () => {
  const mapElement = document.getElementById('map');
  if (!mapElement) return;

  // Leer datos pasados desde el servidor a través de atributos data-*
  const tileUrl = mapElement.dataset.tileUrl;
  const bounds = JSON.parse(mapElement.dataset.bounds);
  const originalUrl = mapElement.dataset.originalUrl;
  const improvedUrl = mapElement.dataset.improvedUrl;

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
    // Añadir la imagen original como una capa
    map.addSource('original-image-source', {
      type: 'image',
      url: originalUrl,
      coordinates: [
        bounds[0], // Suroeste
        [bounds[1][0], bounds[0][1]], // Sureste
        bounds[1], // Noreste
        [bounds[0][0], bounds[1][1]]  // Noroeste
      ]
    });
    map.addLayer({
      id: 'original-image-layer',
      type: 'raster',
      source: 'original-image-source',
      paint: { 'raster-opacity': 1 },
      layout: { 'visibility': 'none' } // Oculta por defecto
    });

    // Añadir la imagen mejorada como una capa
    map.addSource('improved-image-source', {
      type: 'image',
      url: improvedUrl,
      coordinates: [
        bounds[0],
        [bounds[1][0], bounds[0][1]],
        bounds[1],
        [bounds[0][0], bounds[1][1]]
      ]
    });
    map.addLayer({
      id: 'improved-image-layer',
      type: 'raster',
      source: 'improved-image-source',
      paint: { 'raster-opacity': 1 },
      layout: { 'visibility': 'visible' } // Visible por defecto
    });

    // Ajustar el mapa a los límites de la imagen
    map.fitBounds(bounds, { padding: 40 });
  });

  // Lógica para los controles de capa
  document.querySelectorAll('input[name="layer-toggle"]').forEach(radio => {
    radio.addEventListener('change', (event) => {
      const selectedValue = event.target.value;
      map.setLayoutProperty('original-image-layer', 'visibility', selectedValue === 'original' ? 'visible' : 'none');
      map.setLayoutProperty('improved-image-layer', 'visibility', selectedValue === 'improved' ? 'visible' : 'none');
    });
  });

  // Lógica para el slider de opacidad
  const opacitySlider = document.getElementById('opacity-slider');
  opacitySlider.addEventListener('input', (event) => {
    const opacity = parseFloat(event.target.value);
    map.setPaintProperty('improved-image-layer', 'raster-opacity', opacity);
    map.setPaintProperty('original-image-layer', 'raster-opacity', opacity);
  });
});