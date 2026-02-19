import { http } from "@google-cloud/functions-framework";
import { GoogleGenAI } from "@google/genai";
import { Storage } from "@google-cloud/storage";
import { OAuth2Client } from "google-auth-library";

const storage = new Storage();

const env_vars = {
    CODIGO_AMBIENTE: process.env.CODIGO_AMBIENTE || "960956212831",
    proyecto: process.env.proyecto || "emuclient",
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    BUCKET_NAME: process.env.BUCKET_NAME || "uss2-images"
};

const allowedOrigins = [
    `http://localhost:8080`,
    `https://uss2-image-upgrade-${env_vars.CODIGO_AMBIENTE}.us-central1.run.app`
];

const validAudiences = [
    `https://uss2-image-upgrade-${env_vars.CODIGO_AMBIENTE}.us-central1.run.app`
];

http("image-upgrade", async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');

    const origin = req.headers.origin;
    let allowOrigin = "";

    if (origin && allowedOrigins.includes(origin)) {
        allowOrigin = origin;
    }

    if (req.method === "OPTIONS") {
        if (allowOrigin) res.set("Access-Control-Allow-Origin", allowOrigin);
        res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
        res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
        res.set("Access-Control-Allow-Credentials", "true");
        res.set("Access-Control-Max-Age", "3600");
        res.status(204).send();
        return;
    }

    if (allowOrigin) res.set("Access-Control-Allow-Origin", allowOrigin);
    res.set("Access-Control-Allow-Credentials", "true");
    res.set("Content-Type", "application/json");

    // Auth
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        res.status(401).json({ success: false, error: "missing or invalid token" });
        return;
    }

    const token = authHeader.replace("Bearer ", "");
    let tokenValid = false;

    const client = new OAuth2Client();
    for (const audience of validAudiences) {
        try {
            const ticket = await client.verifyIdToken({ idToken: token, audience });
            const payload = ticket.getPayload();
            console.log("Payload:", payload);
            tokenValid = true;
            break;
        } catch (error) {
            console.log(`Token validation failed for audience ${audience}: ${error.message}`);
        }
    }

    if (!tokenValid) {
        console.log("TOKEN INVALIDO ++++++++++++++");
        res.status(403).json({ success: false, error: "Token inválido" });
        return;
    }

        // --- PROCESAMIENTO ---
    let { imagen_gs, prompt } = req.body;

    // 1. Validaciones Nano Banana
    if (!imagen_gs || !imagen_gs.startsWith("gs://")) {
        return res.status(400).json({ error: "Se requiere 'imagen_gs' (ruta gs://...)" });
    }
    if (!prompt) {
        // return res.status(400).json({ error: "Se requiere 'prompt' con la instrucción de modificación." });
        prompt = `
        Positivo: Professional satellite orthophoto super-resolution, Sentinel-2 source. Upscaling from 10m to 1m GSD. Nadir view. Focus on coherent land cover textures and macro-geological features. Smooth rendering of continuous surfaces: agricultural patterns, forest canopies, water bodies, and defined urban blocks. Abstract generalization of materials. Photorealistic natural lighting, geographic consistency, high fidelity terrain. 
        Negativo: High-frequency noise, micro-details, individual vehicles, cars, people, street furniture, small bushes, sharp edges on small objects (<20m), visual artifacts, dithering, invented urban clutter, over-sharpened micro-textures, distorted geometry.
        `
    }

    try {
        // 2. Descargar la imagen de origen desde GS (Buffer)
        console.log(`Descargando ${imagen_gs}...`);
        const urlParts = imagen_gs.replace("gs://", "").split("/");
        const sourceBucket = urlParts.shift();
        const sourceFile = urlParts.join("/");
        
        const [inputBuffer] = await storage.bucket(sourceBucket).file(sourceFile).download();
        const inputBase64 = inputBuffer.toString('base64');

        // 3. Configurar Gemini (Tu código nuevo)
        const ai = new GoogleGenAI({ apiKey: env_vars.GEMINI_API_KEY });
        
        // Usamos el modelo capaz de generar imágenes
        const modelName = 'gemini-3-pro-image-preview'; 

        const config = {
            responseModalities: ['IMAGE', 'TEXT'],
            generationConfig: {
                responseMimeType: "application/json" // Opcional, dependiendo si quieres texto mixto
            }
        };

        const contents = [
            {
                role: 'user',
                parts: [
                    { text: prompt },
                    { 
                        inlineData: { 
                            mimeType: "image/png", // Asumimos PNG o detectamos dinámicamente
                            data: inputBase64 
                        } 
                    },
                ],
            },
        ];

        console.log("Enviando a Gemini para generación...");
        const responseStream = await ai.models.generateContentStream({
            model: modelName,
            config: config,
            contents: contents,
        });

        // 4. Procesar el Stream y Capturar la Imagen de Salida
        let generatedImageBuffer = null;
        let generatedMimeType = "image/png";
        let textoExplicativo = "";

        for await (const chunk of responseStream) {
            // Verificamos si este chunk trae datos binarios (imagen)
            const candidate = chunk.candidates?.[0]?.content?.parts?.[0];
            
            if (candidate?.inlineData) {
                console.log("¡Chunk de imagen recibido!");
                generatedMimeType = candidate.inlineData.mimeType || "image/png";
                generatedImageBuffer = Buffer.from(candidate.inlineData.data, 'base64');
            } else if (candidate?.text) {
                textoExplicativo += candidate.text;
            }
        }

        if (!generatedImageBuffer) {
            throw new Error(`Gemini no devolvió una imagen. Respuesta texto: ${textoExplicativo}`);
        }

        // 5. Guardar la nueva imagen en GS (Salida Nano Banana)
        const outputFileName = `output/gen_${Date.now()}.png`;
        const bucket = storage.bucket(env_vars.BUCKET_NAME);
        const file = bucket.file(outputFileName);

        await file.save(generatedImageBuffer, {
            contentType: generatedMimeType,
            metadata: {
                metadata: {
                    original: imagen_gs,
                    prompt: prompt
                }
            }
        });

        console.log(`Imagen guardada en gs://${env_vars.BUCKET_NAME}/${outputFileName}`);

        // 6. Generar URL Firmada para el frontend
        const [signedUrl] = await file.getSignedUrl({
            action: 'read',
            expires: Date.now() + 60 * 60 * 1000, // 1 hora
        });

        // Respuesta ligera
        res.status(200).json({
            success: true,
            gs_url: `gs://${env_vars.BUCKET_NAME}/${outputFileName}`,
            public_url: signedUrl,
            comentario_ia: textoExplicativo // Por si el modelo dijo algo además de la imagen
        });

    } catch (error) {
        console.error("Error en generación:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});