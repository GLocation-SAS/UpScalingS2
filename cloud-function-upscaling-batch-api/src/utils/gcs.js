const { Storage } = require('@google-cloud/storage');
const FormData = require('form-data');
const fetch = require('node-fetch');
const path = require('path');

const storage = new Storage();

const UPLOAD_URL = process.env.UPLOAD_URL;

async function uploadToDocs(fileBuffer, destinationPath, bucket) {
    const form = new FormData();
    form.append('destinationPath', destinationPath);
    form.append('files', fileBuffer, { filename: path.basename(destinationPath) });

    const response = await fetch(`${UPLOAD_URL}?action=upload`, {
        method: 'POST',
        body: form
    });

    if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Upload error (${response.status}): ${errorBody}`);
    }

    return `gs://${bucket}/${destinationPath}`;
}

async function downloadFromGCS(gsPath) {
    const match = gsPath.match(/^gs:\/\/([^\/]+)\/(.+)$/);
    if (!match) throw new Error('Ruta GSUtil inválida.');

    const bucketName = match[1];
    const filePath = match[2];

    console.log(`Descargando de gs://${bucketName}/${filePath}`);
    const [fileBuffer] = await storage.bucket(bucketName).file(filePath).download();
    return fileBuffer;
}

async function downloadFromUrl(imageUrl) {
    const response = await fetch(imageUrl);
    if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Error descargando imagen (${response.status}): ${errorBody}`);
    }
    return response.buffer();
}

module.exports = { uploadToDocs, downloadFromGCS, downloadFromUrl };
