import './input.css';
import './style.css';

/** URL del archivo cargado (para revocar y liberar memoria al volver). */
let loadedFileUrl = null;

/**
 * Muestra la vista con iframe y carga el archivo seleccionado en ella.
 * @param {File} file - Archivo seleccionado por el usuario.
 */
function goToIframeView(file) {
  if (!file) return;

  if (loadedFileUrl) {
    URL.revokeObjectURL(loadedFileUrl);
  }
  loadedFileUrl = URL.createObjectURL(file);

  const iframe = document.getElementById('file-iframe');
  const viewLanding = document.getElementById('view-landing');
  const viewIframe = document.getElementById('view-iframe');

  iframe.src = loadedFileUrl;
  viewLanding.classList.add('hidden');
  viewIframe.classList.remove('hidden');
}

/**
 * Vuelve a la vista inicial (cargar archivo) y libera la URL del archivo.
 */
function goToLandingView() {
  const iframe = document.getElementById('file-iframe');
  const viewLanding = document.getElementById('view-landing');
  const viewIframe = document.getElementById('view-iframe');

  iframe.src = 'about:blank';
  viewIframe.classList.add('hidden');
  viewLanding.classList.remove('hidden');

  if (loadedFileUrl) {
    URL.revokeObjectURL(loadedFileUrl);
    loadedFileUrl = null;
  }
}

document.getElementById('file-upload').addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (file) goToIframeView(file);
  e.target.value = '';
});

document.getElementById('btn-back').addEventListener('click', goToLandingView);
