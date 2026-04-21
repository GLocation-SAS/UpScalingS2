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

        // ─── CONSTRUCCIONES ───────────────────────────────────────────────────────
        // Visualización cartográfica de huellas de edificaciones estilo GIS/choropleth.
        // Objetivo: generar un mapa temático donde cada edificio se distingue con un
        // color sólido único, fondo neutro claro, calles blancas. Inspirado en mapas
        // de edificios tipo NYC building footprint choropleth.
        case 'construcciones':
            prompt = `
TASK: Generate a colorful GIS-style urban building footprint map from the provided satellite imagery. This is a cartographic visualization task, NOT a photorealistic image enhancement.

OUTPUT STYLE — BUILDING FOOTPRINT CHOROPLETH MAP:
The output must look exactly like a professional urban building footprint dataset rendered as a thematic map, similar to NYC or European city building footprint open data visualizations. Specific visual requirements:

BACKGROUND AND STREETS:
- Background (non-built areas, open land, water): very light gray (#e8e8e8 to #f0f0f0) or white
- Street network and road corridors: white or near-white (#ffffff to #f5f5f5), clearly visible as crisp light corridors separating urban blocks
- Street widths must be proportional to road hierarchy — major arterials wider, local streets narrower
- No street labels, no map text, no cartographic symbols

BUILDING FOOTPRINTS — COLOR AND GEOMETRY:
- Every individual building footprint must be filled with a SOLID flat color chosen from a vibrant multi-color palette
- Use the following colors randomly distributed across buildings to create a rich choropleth appearance: cobalt blue (#1a6fad), bright teal (#2ab0a0), golden yellow (#f5a623), amber orange (#e8890c), sky blue (#4aa8d8), deep navy (#1a3c6e), turquoise (#00b4c8), coral (#e85c30), light teal (#5dc8c0)
- Adjacent buildings or buildings within the same block should preferably use different colors to maximize visual discriminability
- Each building polygon must have a very thin white or light gray outline (1-2px equivalent) to separate it from neighbors
- Building footprint geometry must be geometrically clean: sharp right angles where appropriate, smooth curves only for curved facades, no fuzzy or blurred edges
- Do NOT use gradients, textures, shadows, or 3D effects inside building footprints — flat solid fill only

SPATIAL ACCURACY:
- Infer building footprint locations, shapes, and sizes from the satellite input image and the reference map tile if provided
- The reference map tile is the PRIMARY source for understanding individual building geometries, block layouts, and street network topology
- Preserve the exact geographic distribution and relative proportions of built versus non-built areas
- Do NOT invent buildings in areas that appear as open land, vegetation, or water in the source imagery
- Maintain correct urban block structure: buildings arranged around blocks separated by street corridors

WHAT THE OUTPUT MUST NOT CONTAIN:
- Photorealistic textures, roof materials, shadows, or satellite imagery appearance
- Any photographic or semi-photographic rendering style
- Terrain, elevation, or hillshading effects
- Labels, annotations, legends, scale bars, north arrows, or any map marginalia
- Uniform single-color fills — every building must be individually colored
- Monochromatic or grayscale building fills
- Blurry or anti-aliased building edges that reduce polygon crispness
- Vegetation rendered inside building footprint polygons
- Cars, people, or objects at street level

REFERENCE IMAGE GUIDANCE:
If a secondary reference image (satellite map tile) is provided, use it as the PRIMARY geometric reference for identifying individual building footprints, block boundaries, parcel layouts, and street widths. The Sentinel-2 input establishes the overall spatial extent and built-up zone locations. The reference tile provides the fine-grained building geometry detail needed to draw accurate footprint polygons.
            `;
            break;

        // ─── URBANO RURAL ─────────────────────────────────────────────────────────
        // Mapa de clasificación de uso del suelo estilo teledetección supervisada.
        // Cada categoría de uso (urbano, cultivos, vegetación, suelo desnudo, agua)
        // se renderiza con un color sólido distinto, como una clasificación Landsat/
        // Sentinel procesada en GIS. Inspirado en mapas de land cover/land use.
        case 'urbano_rural':
            prompt = `
TASK: Generate a land use / land cover (LULC) classification map from the provided satellite imagery, styled like a supervised remote sensing classification output. This is a thematic cartographic visualization task, NOT a photorealistic image enhancement.

CRITICAL — GEOMETRIC FIDELITY (MOST IMPORTANT RULE):
You MUST trace and follow the EXACT geometry visible in the provided reference image (map tile). This means:
- Urban blocks must match the ACTUAL block shapes, sizes, and orientations shown in the reference — irregular, organic, or diagonal street grids must be preserved exactly as they appear
- Road corridors must follow the EXACT street layout from the reference — do NOT replace irregular or diagonal streets with a regular orthogonal grid
- Vegetation patches, parks, and water bodies must be placed exactly where they appear in the reference, with their actual shapes
- Do NOT invent, regularize, or generalize the urban fabric — if the reference shows irregular blocks typical of Latin American or informal urban development, preserve that irregularity faithfully
- Do NOT generate a generic or idealized city layout based on training data — the output geometry must be derived exclusively from the reference image provided

COARSE-GRAINED CLASSIFICATION — NO BUILDING-LEVEL DETAIL:
This is a LAND USE map, not a building footprint map. Classification must be at neighborhood / zone level, NOT at individual building level:
- Urban areas must be filled with a single flat solid color covering entire blocks, including buildings AND streets within that urban block — do NOT outline individual buildings or show individual rooftops
- The boundary between "urban" and "non-urban" follows block edges and major street corridors, NOT individual parcel boundaries
- A city block classified as Urban must appear as one solid orange-brown shape — not a mosaic of individual building outlines
- Street corridors between urban blocks may be shown as narrow gaps of the same urban color or slightly lighter tone — do NOT draw white street lines

OUTPUT STYLE — LAND USE CLASSIFICATION MAP:
The output must look like a professional remote sensing land cover classification map, similar to outputs from ENVI, ArcGIS, or QGIS supervised classification of Sentinel-2 or Landsat imagery. Each land use category is rendered as a distinct solid color fill covering the entire surface — no background, no white areas, every pixel belongs to a land use class.

LAND USE CATEGORIES AND THEIR ASSIGNED COLORS:
Classify the entire image area into the following categories based on the spectral and visual information from the Sentinel-2 input and the reference image. Apply these exact solid colors:

- Urban / Built-up areas (buildings, roads, impervious surfaces): warm orange-brown (#c1440e)
- Dense forest / Mature tree canopy: dark green (#1a6b2a)
- Natural vegetation / Shrubland / Grassland: medium green (#4caf50)
- Agricultural cropland — active crops / irrigated fields: bright lime green (#8bc34a)
- Agricultural cropland — dry / fallow fields / bare soil with crop residue: light tan (#d4b483)
- Bare soil / Exposed earth / Construction sites: sandy brown (#b8860b)
- Water bodies (rivers, lakes, reservoirs, irrigation canals): medium blue (#2196f3)
- Wetlands / Riparian vegetation along water: teal green (#26a69a)
- Pasture / Permanent grassland: soft yellow-green (#cddc39)

CLASSIFICATION RULES:
- Every pixel of the output image must be filled with one of the above category colors — there must be NO white, black, or transparent background areas
- Color boundaries between land use categories must be sharp and clean, not blurred or gradient-blended
- Each contiguous area of the same land use category must be filled with a uniform flat solid color — no texture, no shading, no photographic appearance within any category
- Adjacent areas of the same category must merge into a single coherent color region — no internal sub-divisions within a single land use zone
- Category boundaries must follow the actual landscape geometry visible in the reference image

HANDLING DARK AREAS OR VISUAL ANOMALIES IN THE REFERENCE:
If the reference image contains dark patches, shadows, smoke, clouds, or any visual obstruction that hides the terrain:
- Do NOT classify those dark areas as a separate category
- Infer the land use from the surrounding context and the Sentinel-2 spectral signal for that zone
- If the surrounding area is urban, classify the dark patch as urban; if surrounded by vegetation, classify as vegetation

SPATIAL ACCURACY — CATEGORY ASSIGNMENT:
Use the Sentinel-2 input as the primary spectral reference to determine which land use category each area belongs to:
- Dark green Sentinel-2 tones → Dense forest or natural vegetation
- Bright green / high NDVI tones → Active cropland or irrigated agriculture
- Gray / beige / low-reflectance tones → Urban built-up or bare soil
- Brown / reddish tones → Bare soil, dry crops, or fallow land
- Blue / dark tones → Water bodies
- Mixed light green → Pasture or grassland
Use the reference map tile to confirm the EXACT boundaries and spatial layout of land use zones.

WHAT THE OUTPUT MUST NOT CONTAIN:
- Photorealistic satellite imagery texture or aerial photo appearance within any category
- White or empty background areas — every pixel must be classified
- Gradients, semi-transparency, or blended color transitions between categories
- Labels, legends, scale bars, north arrows, coordinate grids, or any annotation
- Terrain shading or hillshading effects
- Individual building outlines, rooftop shapes, or parcel boundaries within urban zones
- A regular orthogonal street grid that does not match the reference image geometry
- Invented urban layouts, idealized city patterns, or generic training-data cities
- Oval or circular park shapes that do not correspond to actual vegetation in the reference
- Noise, speckle, or unclassified pixels

REFERENCE IMAGE GUIDANCE:
The reference map tile is the PRIMARY geometric authority for this task. Its street layout, block shapes, vegetation patches, and water bodies define the exact geometry of the classification output. The Sentinel-2 input provides the spectral signal to determine which land use category applies to each zone. Together: Sentinel-2 tells you WHAT each area is, the reference tells you WHERE the boundaries are and what SHAPE they have.
            `;
            break;

        // ─── CONURBACIÓN ──────────────────────────────────────────────────────────
        // Mapa cartográfico GIS de huellas de edificaciones mostrando múltiples
        // núcleos urbanos con colores diferenciados por zona, fondo blanco, calles
        // como corredores blancos y límite entre núcleos como línea negra gruesa.
        // Inspirado en atlas de morfología urbana europeos y mapas de conurbación.
        case 'conurbacion':
            prompt = `
TASK: Generate a GIS-style urban conurbation map showing building footprints of multiple distinct urban nuclei, each rendered in a different solid color scheme, separated by a visible thick black morphological boundary line. This is a cartographic visualization task, NOT a photorealistic image enhancement.

CRITICAL — ONLY DRAW BUILDINGS WHERE THEY ACTUALLY EXIST:
This is the most important rule. You MUST only place building footprints in areas where buildings are ACTUALLY visible in the reference image. Specifically:
- If the reference shows forest, hillside vegetation, open land, parks, or water covering a large portion of the image, those areas MUST remain as white/light background — do NOT fill them with building footprints
- If the reference shows sparse urban development with large gaps of vegetation between clusters, preserve those gaps faithfully — do NOT connect isolated building clusters into a continuous urban fabric
- The urban nuclei may be small relative to the total image area — that is correct and expected, especially in peri-urban or hillside contexts
- Do NOT invent buildings to fill empty space. An image that is 70% white background with 30% colored building footprints is a correct output if that matches the actual urban density in the reference

CRITICAL — GEOMETRIC FIDELITY:
- Trace the EXACT building footprint shapes, sizes, and positions visible in the reference image
- Preserve the EXACT street layout and block structure from the reference — organic, winding, or diagonal streets must remain as shown
- Do NOT replace irregular Latin American or hillside urban fabric with a regular European grid
- Do NOT generate a generic city layout from training data — every building polygon must correspond to an actual building visible in the reference

OUTPUT STYLE — MULTI-NUCLEI BUILDING FOOTPRINT MAP:
The output must look like a professional urban atlas cartographic plate showing a metropolitan conurbation with clearly differentiated urban areas. Reference style: European urban morphology atlases and municipal GIS building footprint datasets where each municipality or urban nucleus uses a distinct color family.

BACKGROUND AND STREET NETWORK:
- Background (non-built land, forest, open areas, vegetation, water): pure white (#ffffff) or very light gray (#f5f5f5) — this may cover the majority of the image
- Street network: white open corridors (negative space between building blocks)
- Major roads and arterials: slightly wider white corridors with a very thin light gray (#cccccc) edge line
- No street labels, no map text, no cartographic symbols anywhere in the image

URBAN NUCLEI — ZONE COLOR DIFFERENTIATION:
Identify 2 or more spatially distinct urban clusters visible in the reference. Assign a consistent color to ALL buildings within each cluster:
- Zone A (consolidated urban core / denser nucleus): ALL buildings filled with steel blue (#4a7cb5) — flat solid fill, no variation within this zone
- Zone B (secondary or peripheral nucleus): ALL buildings filled with coral red (#d94f4f) — flat solid fill, no variation within this zone
- Zone C (tertiary zone if present): ALL buildings filled with warm gray (#8c8c8c)
- If only one urban nucleus is visible in the reference, use only Zone A (blue) — do NOT invent a second nucleus
- Within each zone every building uses exactly the same color
- Each building polygon has a very thin white outline (0.5px equivalent) to separate adjacent buildings

INTER-NUCLEI BOUNDARY LINE:
- Draw a THICK BLACK LINE (#000000), approximately 4-6px equivalent width, along the morphological boundary separating the distinct urban nuclei
- This boundary follows the actual spatial transition between urban zones — organic, following the urban edge, natural features, or major infrastructure
- Only draw this line if two or more distinct urban nuclei are present — if the area has only one cluster, omit the boundary line
- The boundary line must be clearly visible and unambiguous

BUILDING FOOTPRINT GEOMETRY:
- Geometrically clean polygons: sharp corners for rectangular buildings, accurate shapes for irregular structures
- Each building individually discernible as a separate polygon
- Preserve morphological character: dense regular grid for consolidated cores, irregular scattered pattern for hillside or peripheral areas
- Flat solid fills only — no gradients, textures, shadows, or 3D effects

WHAT THE OUTPUT MUST NOT CONTAIN:
- Buildings placed in areas that show forest, vegetation, open land, or water in the reference
- A continuous urban fabric covering the entire image when the reference shows sparse development
- A regular orthogonal grid that does not match the reference street layout
- Invented building clusters not visible in the reference
- Photorealistic imagery, roof textures, aerial photo appearance, or shadows
- Labels, legends, scale bars, north arrows, or any annotation
- Gradient fills or transparency effects

REFERENCE IMAGE GUIDANCE:
The reference map tile is the PRIMARY geometric authority. Use it to identify: (1) exactly where buildings exist vs where there is open land or vegetation, (2) the exact shape and layout of each building cluster, (3) the morphological character that distinguishes one urban nucleus from another. The Sentinel-2 input confirms which areas are built-up vs vegetated at a spectral level. Together they define both WHERE buildings exist and WHAT the boundary between zones looks like.
            `;
            break;

        // ─── MODELOS ORIGINALES ───────────────────────────────────────────────────

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
