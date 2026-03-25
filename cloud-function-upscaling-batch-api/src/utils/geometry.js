function getBoundsFromGeometry(geometry) {
    if (!geometry || !geometry.coordinates || geometry.coordinates.length === 0) {
        return [[-74.20, 4.60], [-74.00, 4.80]];
    }

    const coords = geometry.coordinates[0];
    const lngs = coords.map(c => c[0]);
    const lats = coords.map(c => c[1]);

    const minLng = Math.min(...lngs);
    const maxLng = Math.max(...lngs);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);

    return [[minLng, minLat], [maxLng, maxLat]];
}

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

function calculateRectangleDimensions(geometry) {
    const coords = geometry.coordinates[0];
    const lngs = coords.map(c => c[0]);
    const lats = coords.map(c => c[1]);

    const minLng = Math.min(...lngs);
    const maxLng = Math.max(...lngs);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);

    const width = calculateDistance(minLat, minLng, minLat, maxLng);
    const height = calculateDistance(minLat, minLng, maxLat, minLng);
    const area = width * height;

    return { width, height, area };
}

module.exports = { getBoundsFromGeometry, calculateDistance, calculateRectangleDimensions };
