const viewLanding = document.getElementById('view-landing');
const fileUploadInput = document.getElementById('file-upload');
const btnGsutil = document.getElementById('btn-gsutil-path');

const progressOverlay = document.getElementById('progress-overlay');
const progressText = document.getElementById('progress-text');
const progressBar = document.getElementById('progress-bar');
const progressCounter = document.getElementById('progress-counter');

function showProgress(text = 'Iniciando proceso...') {
  progressText.textContent = text;
  progressCounter.textContent = '';
  progressBar.style.width = '0%';
  progressOverlay.classList.remove('hidden');
  progressOverlay.classList.add('flex');
}

function updateProgress(data) {
  if (data.message) progressText.textContent = data.message;
  if (data.total > 0) {
    const percent = Math.round((data.processed / data.total) * 100);
    progressBar.style.width = `${percent}%`;
    progressCounter.textContent = `${data.processed} / ${data.total}`;
  }
}

function hideProgress() {
  progressOverlay.classList.add('hidden');
  progressOverlay.classList.remove('flex');
}

function handleJobProgress(jobId) {
  const eventSource = new EventSource(`/api/progress/${jobId}`);
  eventSource.onmessage = (event) => {
    const data = JSON.parse(event.data);

    if (data.status === 'error') {
      alert(`Error durante el procesamiento: ${data.error}`);
      eventSource.close();
      hideProgress();
    } else if (data.status === 'complete') {
      updateProgress(data); // Actualiza una última vez al 100%
      eventSource.close();
      // Espera un momento para que el usuario vea el 100% y luego redirige
      setTimeout(() => {
        window.location.href = `/map/result/${jobId}`;
      }, 500);
      return;
    } else {
      updateProgress(data);
    }
  };
  eventSource.onerror = () => {
    alert('Se perdió la conexión con el servidor.');
    eventSource.close();
    hideProgress();
  };
}

async function startUpscaleProcessFromFile(file) {
  if (!file) return;
  showProgress('Subiendo archivo al servidor...');
  const formData = new FormData();
  formData.append('image', file);
  try {
    const response = await fetch('/api/upscale', { method: 'POST', body: formData });
    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || 'Error en el servidor.');
    }
    const { jobId } = await response.json();
    handleJobProgress(jobId);
  } catch (error) {
    alert(`No se pudo iniciar el proceso: ${error.message}`);
    hideProgress();
  }
}

async function startUpscaleProcessFromGsPath(gsPath) {
  if (!gsPath) return;
  showProgress('Iniciando proceso desde GSUtil...');
  try {
    const response = await fetch('/api/upscale-from-gs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gsPath }),
    });
    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || 'Error en el servidor.');
    }
    const { jobId } = await response.json();
    handleJobProgress(jobId);
  } catch (error) {
    alert(`No se pudo iniciar el proceso: ${error.message}`);
    hideProgress();
  }
}

// Event Listeners
fileUploadInput.addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (file) startUpscaleProcessFromFile(file);
  e.target.value = '';
});

btnGsutil.addEventListener('click', () => {
  const gsPath = prompt('Pega la ruta completa de GSUtil aquí (ej: gs://bucket/ruta/imagen.tif)');
  if (gsPath && gsPath.trim().startsWith('gs://')) {
    startUpscaleProcessFromGsPath(gsPath.trim());
  } else if (gsPath) {
    alert('La ruta no es válida. Debe comenzar con "gs://".');
  }
});