const SENTINEL2_GSD = 10;

function buildScaleClause(scaleContext) {
    if (!scaleContext) return '';

    const zoom = scaleContext.zoom;
    const dims = scaleContext.dimensions;

    let areaScale = 'medium';
    if (dims) {
        const maxSide = Math.max(dims.width, dims.height);
        if (maxSide > 5000) areaScale = 'regional';
        else if (maxSide > 2000) areaScale = 'medium';
        else if (maxSide > 500) areaScale = 'local';
        else areaScale = 'micro';
    }

    let scaleDescription = '';
    let detailGuidance = '';

    switch (areaScale) {
        case 'regional':
            scaleDescription = `a regional-scale overview covering a large area (${SENTINEL2_GSD}m/px native Sentinel-2 resolution)`;
            detailGuidance = `At this scale with ${SENTINEL2_GSD}m/px source data, only large-scale land cover patterns, major water bodies, and regional terrain are visible. Individual buildings, roads, or vegetation patches should NOT be resolved or inferred. The output should resemble a cleaner, sharper version of the same regional view — NOT a close-up aerial photograph.`;
            break;
        case 'medium':
            scaleDescription = `a medium-scale satellite view (${SENTINEL2_GSD}m/px native Sentinel-2 resolution)`;
            detailGuidance = `At this scale with ${SENTINEL2_GSD}m/px source data, urban blocks and agricultural fields are distinguishable as general patches, but individual buildings are NOT distinctly resolved. Only macro-structural patterns (large building clusters, major roads, field boundaries) are visible. Do NOT infer individual rooftops, narrow streets, tree canopy textures, or fine vegetation details. The output should look like a cleaner Sentinel-2 image with enhanced contrast and edge definition — NOT like a Google Earth close-up.`;
            break;
        case 'local':
            scaleDescription = `a local-scale satellite view of a small area (${SENTINEL2_GSD}m/px native Sentinel-2 resolution)`;
            detailGuidance = `Even though this covers a small area, the source data is still only ${SENTINEL2_GSD}m/px (Sentinel-2). At this resolution, the input image contains very few pixels of actual information. Urban blocks and road corridors may be partially distinguishable as blurred patches, but individual rooftops, narrow streets, and tree canopy details are NOT present in the source. Do NOT generate details that the ${SENTINEL2_GSD}m/px source cannot plausibly support. The output should look like an enhanced Sentinel-2 crop — NOT like a submeter aerial photograph.`;
            break;
        case 'micro':
            scaleDescription = `a very small area crop (${SENTINEL2_GSD}m/px native Sentinel-2 resolution, critically low pixel count)`;
            detailGuidance = `CRITICAL: This is a very small area being viewed at high visual zoom, but the Sentinel-2 source data is only ${SENTINEL2_GSD}m/px. The input image contains extremely few meaningful pixels. At this resolution, almost no fine detail exists in the source data. Do NOT hallucinate buildings, roads, vegetation textures, or any fine-scale features. The output should be a modestly enhanced, cleaner version of the blurry input — any detailed features would be pure fabrication.`;
            break;
    }

    let dimensionInfo = '';
    if (dims) {
        const widthKm = (dims.width / 1000).toFixed(2);
        const heightKm = (dims.height / 1000).toFixed(2);
        const areaKm2 = (dims.area / 1e6).toFixed(2);
        const approxPixels = Math.round(dims.width / SENTINEL2_GSD);
        const approxPixelsH = Math.round(dims.height / SENTINEL2_GSD);
        dimensionInfo = `The captured area covers approximately ${widthKm} km × ${heightKm} km (${areaKm2} km²). At ${SENTINEL2_GSD}m/px Sentinel-2 resolution, this area contains approximately ${approxPixels} × ${approxPixelsH} actual data pixels.`;
    }

    const clause = `

SPATIAL SCALE CONTEXT (CRITICAL — MUST FOLLOW):
The input Sentinel-2 image has a FIXED native resolution of ${SENTINEL2_GSD} meters per pixel. This resolution does NOT change regardless of the size of the captured area or the viewer zoom level.
This corresponds approximately to ${scaleDescription}.
${dimensionInfo}
${detailGuidance}
IMPORTANT: The "1m equivalent GSD" target is PERCEPTUAL and STRUCTURAL only — it means producing a cleaner, higher-contrast version with better-defined boundaries. It does NOT mean recovering true sub-meter satellite imagery. Do NOT generate output that looks like a high-resolution aerial photograph or a Google Earth zoom level 19–20 image. The level of detail in the output MUST be consistent with what a ${SENTINEL2_GSD}m/px source can plausibly support after enhancement.
WARNING: If a secondary reference image (map tile) is provided, be aware that this reference may show MUCH more spatial detail than the ${SENTINEL2_GSD}m/px Sentinel-2 source can support. Use the reference ONLY for geographic orientation (understanding where urban areas, roads, and vegetation boundaries are located). Do NOT copy or replicate the reference image's level of detail, texture quality, or visual resolution.
`;

    console.log(`[SCALE] 📐 Cláusula de escala generada — Área: ${areaScale}, Sentinel-2 GSD: ${SENTINEL2_GSD}m/px, Zoom: ${zoom}`);

    return clause;
}

function buildPrompt(model, scaleContext, customPrompt) {
    if (customPrompt) return customPrompt;

    let prompt = '';

    switch (model) {
        case 'upscaling':
            prompt = `
Positive Prompt
Generate a professional satellite orthophoto via super-resolution enhancement, using exclusively the provided Sentinel-2 input image as the absolute source of information.
Upscale from native 10 meters per pixel to an equivalent 1 meter Ground Sampling Distance (GSD) through coherent structural refinement, balanced edge enhancement, and texture detailing, inferring only plausible macro-details directly supported by the original data without introducing nonexistent elements or artificial fine-scale features.
Maintain strict nadir view with pure orthographic satellite perspective.
Enhance overall visual clarity with high sharpness, coherent separation of land covers through distinct boundaries, structural definition of major edges with crisp, natural outlines, and spatial readability to achieve detailed, photorealistic representation without any blur, softening, or loss of contrast.
Strictly preserve the exact geographic distribution, proportions, and color tones of:

Urban areas with building clusters and roof variations
Natural vegetation patches with canopy textures
Agricultural zones and fields with soil and crop patterns
Water bodies (if present) with accurate reflections and edges
Road infrastructure and alignments with smooth curves
Refine urban block outlines, primary road alignments, and land cover boundaries with precise, high-contrast sharpness while adhering fully to the original Sentinel-2 geometry, morphology, and spectral information.
Render continuous surfaces smoothly yet with realistic, varied textures:
Organized agricultural field patterns showing subtle soil variations
Uniform but detailed forest canopies with natural density and shading only in areas with evident large vegetation masses
Precise water body contours with subtle wave or ripple inferences if supported
Well-defined urban blocks with generalized roof materials without any geometric alterations
Apply coherent structural generalization and simplification, avoiding artistic stylization, while ensuring high-detail textures for all land covers, strong contrast for visibility of structures amid vegetation, and color fidelity to the original image.
Use natural photorealistic lighting with subtle shadows and highlights based on inferred terrain, mimicking high-resolution satellite imagery from sources like Google Earth.
Ensure absolute geographic consistency, high fidelity to the original terrain features, and no scene reinterpretation, territorial reorganization, spatial distortions, or color shifts.

SPATIAL SCALE CONTEXT (CRITICAL — MUST FOLLOW):
The input Sentinel-2 image has a FIXED native resolution of 10 meters per pixel. This resolution does NOT change regardless of the size of the captured area or the viewer zoom level.
The input image provided to you may have been digitally resized (upsampled) to a larger pixel dimension for processing convenience (e.g., 1024x1024 pixels). However, this resizing does not add any new information; the effective resolution is still the native 10m/px. Treat the input as a blurred, low-information image and do not interpret the blurred patterns as high-detail features. Only enhance clarity without adding unsupported details.
This corresponds approximately to a very small area crop (10m/px native Sentinel-2 resolution, critically low pixel count).
The captured area covers approximately 0.5 km × 0.5 km (0.25 km²). At 10m/px Sentinel-2 resolution, this area contains approximately 50 × 50 actual data pixels.
CRITICAL: This is a very small area being viewed at high visual zoom, but the Sentinel-2 source data is only 10m/px. The input image contains extremely few meaningful pixels. At this resolution, almost no fine detail exists in the source data. Do NOT hallucinate buildings, roads, vegetation textures, or any fine-scale features. The output should be a modestly enhanced, cleaner version of the blurry input — any detailed features would be pure fabrication.
IMPORTANT: The "1m equivalent GSD" target is PERCEPTUAL and STRUCTURAL only — it means producing a cleaner, higher-contrast version with better-defined boundaries. It does NOT mean recovering true sub-meter satellite imagery. Do NOT generate output that looks like a high-resolution aerial photograph or a Google Earth zoom level 19–20 image. The level of detail in the output MUST be consistent with what a 10m/px source can plausibly support after enhancement.
WARNING: If a secondary reference image (map tile) is provided, be aware that this reference may show MUCH more spatial detail than the 10m/px Sentinel-2 source can support. Use the reference ONLY for geographic orientation (understanding where urban areas, roads, and vegetation boundaries are located). Do NOT copy or replicate the reference image's level of detail, texture quality, or visual resolution. For park captures or areas with sparse structures, strictly maintain open green spaces, paths, and sparse structures without expanding into urban or agricultural features or inventing elements like circular structures or rectangular slabs not evident in the source.
Negative Prompt
High-frequency noise, artificial micro-textures, excessive oversharpening leading to halos, pixel grid artifacts, visual distortions, dithering, blurring, softening of edges, low contrast, undifferentiated smooth surfaces.
Fine details or objects smaller than 20 meters, including:

Individual vehicles or cars
People
Street furniture
Small shrubs or isolated plants
Minor architectural elements
Invented dense forests within urban zones.
Unauthorized vegetation expansion into non-vegetated areas.
Artificial urbanization of rural or natural zones.
Inaccurate blending or mixing of land cover classes.
Any structural reinterpretations, additions, or territorial reconfigurations not present in the original Sentinel-2 image.
Unnatural edge enhancements that create artifacts, washed-out colors, over-saturated greens, lack of texture in vegetation or fields, indistinct building shapes, hallucinated cityscapes or fields in park areas, sub-meter aerial photo styles inconsistent with 10m/px source data, invented circular or rectangular structures, over-interpretation of blurred patterns as detailed features.
            `;
            if (scaleContext) prompt += buildScaleClause(scaleContext);
            break;

        case 'upscaling_google_maps':
            prompt = `

POSITIVO:
Professional satellite orthophoto super-resolution enhancement, Sentinel-2 multispectral source imagery. Upscaling from 10m/px to 1m/px GSD. Strict nadir (top-down) view, zero perspective distortion. Primary reference: Sentinel-2 input image — preserve its exact land cover distribution, spectral tone, and spatial layout. Secondary reference image (map tile) provided solely for geographic context and urban boundary orientation — do NOT replicate its style, colors, or symbology. Photorealistic coherent land cover textures: urban blocks with road grid, rooftops, bare soil, agricultural field patterns, water bodies with natural color. Natural diffuse lighting consistent with satellite acquisition. Geographic and topographic fidelity. Vegetation rendered only where spectrally consistent with input image.

NEGATIVO:
Map tile aesthetics, cartographic colors, stylized road lines, vector symbology, OpenStreetMap or Google Maps visual style. Misplaced vegetation: forest canopy, dense tree clusters, or woodland textures over urban zones, industrial areas, or open land not present in Sentinel-2 input. High-frequency noise, invented micro-details, individual vehicles, pedestrians, street furniture. Sharp edges on objects under 20m. Visual artifacts, dithering, checkerboard patterns, over-sharpened micro-textures, hallucinated urban clutter, distorted geometry, blurry halos, upscaling artifacts.

INSTRUCCIÓN DE REFERENCIA:
The Sentinel-2 image is the ground truth source. Enhance its resolution and clarity while maintaining exact fidelity to its land cover, color palette, and structure. The map tile reference is a secondary orientation aid only — use it to understand approximate urban boundaries, do not transfer its visual style. If vegetation appears in the map tile over areas that show urban or bare land in the Sentinel-2 image, ignore it entirely.
            `;
            if (scaleContext) prompt += buildScaleClause(scaleContext);
            break;

        case 'upscaling_ndvi':
            prompt = `
                    Positive Prompt

Generate a high-definition super-resolution enhancement of a scientific NDVI (Normalized Difference Vegetation Index) map derived from Sentinel-2 data.

The input image is a quantitative NDVI raster, not a natural-color image.

Upscale from the original spatial resolution through coherent structural refinement while strictly preserving:

Original NDVI value distribution

Relative intensity relationships

Spatial patterns of vegetation density

True boundaries between vegetated and non-vegetated areas

The enhancement must improve:

Edge clarity between NDVI zones

Spatial readability of agricultural parcels

Definition of vegetation gradients

Continuity of forest masses

Boundary precision between crops, bare soil, and urban surfaces

Maintain the exact scientific NDVI color scale, ranging from:

White / light brown (low or negative NDVI, barren or built areas)

Light green (moderate vegetation)

Dark green (high vegetation density)

Do NOT modify, reinterpret, stretch, normalize, or remap the NDVI values.
Do NOT apply artistic color grading.

The output must remain a scientific NDVI visualization with enhanced spatial clarity, not an RGB or photorealistic image.

The spatial scale corresponds to medium-resolution satellite data (approximately 10 meters per pixel).
Enhancement must remain consistent with this observation scale and must not introduce sub-pixel vegetation details that cannot be supported by the original data.

Preserve geographic consistency, vegetation distribution, and spectral integrity.

🔹 Negative Prompt

Natural color rendering, RGB photorealism, satellite true-color imagery, terrain shading, artificial shadows.

Invented vegetation patches, artificial crop rows, fabricated forest density changes, exaggerated canopy textures.

Modification of NDVI value relationships, histogram stretching, contrast over-enhancement altering scientific meaning.

Color palette changes, gradient remapping, oversaturated greens, unrealistic tonal transitions.

High-frequency noise, pixel grid artifacts, oversharpening halos, blurred zone transitions, artificial smoothing that removes real vegetation gradients.

Introduction of buildings, cars, roads, or urban objects not encoded in NDVI data.

Any reinterpretation of land cover beyond what is spectrally represented in the original NDVI raster.
            `;
            break;

        case 'building_footprint':
            prompt = 'a satellite image highlighting building footprints in bright red, high contrast, clearly defined edges';
            break;

        case 'ways':
            prompt = 'a satellite image with all roads and paths highlighted in bright yellow, high contrast, clean lines';
            break;

        case 'forest':
            prompt = 'a satellite image emphasizing forested areas in vibrant green, high contrast, distinguishing between different types of vegetation';
            break;

        case 'trees':
            prompt = 'a satellite image where individual trees or small clusters of trees are clearly visible and distinct';
            break;

        default:
            console.warn(`[PROCESS] Modelo desconocido '${model}'. Usando prompt por defecto.`);
            prompt = 'a satellite image with 4x resolution, high quality, high detail, sharp focus, 8k, UHD, professional';
    }

    return prompt;
}

module.exports = { buildScaleClause, buildPrompt };
