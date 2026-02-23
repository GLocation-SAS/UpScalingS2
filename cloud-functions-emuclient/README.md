# Cloud Function - Process Sentinel Image

Esta Cloud Function procesa imágenes TIFF de Sentinel-2 y las convierte a JPEG.

## Ubicación
- **Proyecto GCP**: `emuclient`
- **Bucket**: `uss2-images`
- **Región**: `us-east1`

## Funcionalidad

1. Recibe la URL de descarga del TIFF desde Google Earth Engine
2. Descarga el TIFF en memoria (sin disco local)
3. Guarda el TIFF temporalmente en `uss2-images/sentinel/temp/`
4. Convierte el TIFF a JPEG usando sharp
5. Guarda el JPEG final en `uss2-images/sentinel/`
6. Elimina el TIFF temporal
7. Retorna la URL pública del JPEG

## Instalación

```bash
cd cloud-functions-emuclient
npm install
```

## Desarrollo local

```bash
npm run dev
```

## Deploy

```bash
npm run deploy
```

## Request Body

```json
{
  "tiffUrl": "https://earthengine.googleapis.com/...",
  "date": "2024-01-15",
  "metadata": {
    "imagesFound": 5,
    "dateRange": {
      "start": "2023-12-15",
      "end": "2024-02-15"
    }
  }
}
```

## Response

```json
{
  "success": true,
  "jpegUrl": "https://storage.googleapis.com/uss2-images/sentinel/sentinel_2024-01-15_1234567890_abc123.jpeg",
  "jpegFileName": "sentinel/sentinel_2024-01-15_1234567890_abc123.jpeg",
  "size": 2048000,
  "processedAt": "2024-01-15T10:30:00.000Z"
}
```

## Permisos necesarios

La cuenta de servicio de Cloud Run debe tener:
- **Storage Object Admin** en el bucket `uss2-images`
- O permisos específicos: `storage.objects.create`, `storage.objects.delete`, `storage.objects.get`

## Configuración del bucket

Para URLs públicas, el bucket debe tener:
```bash
gsutil iam ch allUsers:objectViewer gs://uss2-images
```

O configurar signed URLs en lugar de URLs públicas.
