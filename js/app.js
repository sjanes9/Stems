const ORT_VERSION = '1.27.0';
if (typeof ort !== 'undefined') {
  ort.env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
}

const engine = new DemucsEngine({ onLog: (msg) => console.log('[stems]', msg) });

const els = {
  fileInput: document.getElementById('file-input'),
  dropZone: document.getElementById('drop-zone'),
  fileInfo: document.getElementById('file-info'),
  separateBtn: document.getElementById('separate-btn'),
  checkboxes: Array.from(document.querySelectorAll('.stem-checkbox')),
  progressSection: document.getElementById('progress-section'),
  progressBar: document.getElementById('progress-bar'),
  progressLabel: document.getElementById('progress-label'),
  resultsSection: document.getElementById('results-section'),
  resultsList: document.getElementById('results-list'),
  downloadAllBtn: document.getElementById('download-all-btn'),
  errorBanner: document.getElementById('error-banner'),
  precisionSelect: document.getElementById('precision-select'),
  epSelect: document.getElementById('ep-select'),
  modelUrlInput: document.getElementById('model-url-override'),
};

const STEM_LABELS = {
  drums: 'Drums',
  bass: 'Bass',
  guitar: 'Guitar (Lead + Rhythm)',
  piano: 'Piano / Keyboards',
  vocals: 'Vocals',
  other: 'Other',
};

let currentFile = null;
let currentPcm = null;
let lastResults = null; // { stemKey: Blob }

function showError(msg) {
  els.errorBanner.textContent = msg;
  els.errorBanner.hidden = false;
}

function clearError() {
  els.errorBanner.hidden = true;
  els.errorBanner.textContent = '';
}

function updateSeparateEnabled() {
  const anyChecked = els.checkboxes.some((c) => c.checked);
  els.separateBtn.disabled = !(currentFile && anyChecked);
}

els.checkboxes.forEach((cb) => cb.addEventListener('change', updateSeparateEnabled));

function baseName(filename) {
  return filename.replace(/\.[^/.]+$/, '');
}

function formatBytes(n) {
  if (!n) return '? MB';
  return `${(n / 1024 / 1024).toFixed(0)} MB`;
}

function setProgress(fraction, label) {
  els.progressSection.hidden = false;
  els.progressBar.value = Math.max(0, Math.min(1, fraction));
  els.progressLabel.textContent = label;
}

async function handleFile(file) {
  clearError();
  if (!file) return;

  const okType = /\.(wav|mp3)$/i.test(file.name) ||
    /^audio\/(wav|x-wav|wave|mpeg|mp3)$/i.test(file.type);
  if (!okType) {
    showError('Please choose a .wav or .mp3 file.');
    return;
  }

  currentFile = file;
  currentPcm = null;
  lastResults = null;
  els.resultsSection.hidden = true;
  els.fileInfo.textContent = `${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB) — decoding...`;

  try {
    currentPcm = await engine.decodeAndResampleFile(file);
    const mins = Math.floor(currentPcm.duration / 60);
    const secs = Math.round(currentPcm.duration % 60).toString().padStart(2, '0');
    els.fileInfo.textContent = `${file.name} — ${mins}:${secs}`;
    if (currentPcm.duration > 8 * 60) {
      showError('Heads up: tracks over ~8 minutes can be slow and memory-heavy to fully process in-browser.');
    }
  } catch (err) {
    showError(`Could not decode this audio file: ${err.message}`);
    currentFile = null;
    els.fileInfo.textContent = '';
  }

  updateSeparateEnabled();
}

els.fileInput.addEventListener('change', (e) => handleFile(e.target.files[0]));

['dragenter', 'dragover'].forEach((evt) =>
  els.dropZone.addEventListener(evt, (e) => {
    e.preventDefault();
    els.dropZone.classList.add('drag-over');
  })
);
['dragleave', 'drop'].forEach((evt) =>
  els.dropZone.addEventListener(evt, (e) => {
    e.preventDefault();
    els.dropZone.classList.remove('drag-over');
  })
);
els.dropZone.addEventListener('drop', (e) => {
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  handleFile(file);
});
els.dropZone.addEventListener('click', () => els.fileInput.click());
els.dropZone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') els.fileInput.click();
});

function renderResultCard(stemKey, blob) {
  const url = URL.createObjectURL(blob);
  const card = document.createElement('div');
  card.className = 'result-card';

  const title = document.createElement('h3');
  title.textContent = STEM_LABELS[stemKey] || stemKey;
  card.appendChild(title);

  const audio = document.createElement('audio');
  audio.controls = true;
  audio.src = url;
  card.appendChild(audio);

  const downloadLink = document.createElement('a');
  downloadLink.href = url;
  downloadLink.download = `${baseName(currentFile.name)}_${stemKey}.wav`;
  downloadLink.className = 'download-link';
  downloadLink.textContent = 'Download WAV';
  card.appendChild(downloadLink);

  els.resultsList.appendChild(card);
}

els.separateBtn.addEventListener('click', async () => {
  clearError();
  els.separateBtn.disabled = true;
  els.resultsSection.hidden = true;
  els.resultsList.innerHTML = '';

  try {
    if (els.modelUrlInput && els.modelUrlInput.value.trim()) {
      engine.modelUrlOverride = els.modelUrlInput.value.trim();
    }

    if (!engine.isLoaded()) {
      const precision = els.precisionSelect ? els.precisionSelect.value : 'fp16';
      const ep = els.epSelect ? els.epSelect.value : 'auto';
      await engine.loadModel({
        precision,
        executionProvider: ep,
        onProgress: ({ phase, loaded, total }) => {
          if (phase === 'download') {
            const frac = total ? loaded / total : 0;
            setProgress(frac, `Downloading AI model (first run only, then cached): ${formatBytes(loaded)} / ${formatBytes(total)}`);
          } else if (phase === 'ready') {
            setProgress(1, 'Model ready.');
          }
        },
      });
    }

    if (!currentPcm) {
      currentPcm = await engine.decodeAndResampleFile(currentFile);
    }

    const results = await engine.separate(currentPcm, {
      onProgress: ({ segment, totalSegments }) => {
        setProgress(segment / totalSegments, `Separating stems: chunk ${segment} / ${totalSegments}`);
      },
    });

    setProgress(1, 'Encoding WAV files...');

    const selectedStems = els.checkboxes.filter((c) => c.checked).map((c) => c.dataset.stem);
    lastResults = {};

    for (const stemKey of selectedStems) {
      const [left, right] = results[stemKey];
      const blob = encodeWav([left, right], results.sampleRate);
      lastResults[stemKey] = blob;
      renderResultCard(stemKey, blob);
    }

    els.resultsSection.hidden = false;
    els.progressSection.hidden = true;
  } catch (err) {
    console.error(err);
    showError(err.message || String(err));
    els.progressSection.hidden = true;
  } finally {
    updateSeparateEnabled();
  }
});

els.downloadAllBtn.addEventListener('click', async () => {
  if (!lastResults) return;
  const files = [];
  for (const [stemKey, blob] of Object.entries(lastResults)) {
    const arrayBuffer = await blob.arrayBuffer();
    files.push({ name: `${baseName(currentFile.name)}_${stemKey}.wav`, data: new Uint8Array(arrayBuffer) });
  }
  const zipBlob = createZip(files);
  const url = URL.createObjectURL(zipBlob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${baseName(currentFile.name)}_stems.zip`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
});

updateSeparateEnabled();
