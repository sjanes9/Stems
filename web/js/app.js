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
let polling = null;

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

function setProgress(fraction, label) {
  els.progressSection.hidden = false;
  if (fraction === null) {
    els.progressBar.removeAttribute('value');
  } else {
    els.progressBar.value = Math.max(0, Math.min(1, fraction));
  }
  els.progressLabel.textContent = label;
}

function baseName(filename) {
  return filename.replace(/\.[^/.]+$/, '');
}

function handleFile(file) {
  clearError();
  if (!file) return;

  const okType = /\.(wav|mp3)$/i.test(file.name);
  if (!okType) {
    showError('Please choose a .wav or .mp3 file.');
    return;
  }

  currentFile = file;
  els.resultsSection.hidden = true;
  els.fileInfo.textContent = `${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)`;
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

function renderResultCard(jobId, stemKey) {
  const card = document.createElement('div');
  card.className = 'result-card';

  const title = document.createElement('h3');
  title.textContent = STEM_LABELS[stemKey] || stemKey;
  card.appendChild(title);

  const audio = document.createElement('audio');
  audio.controls = true;
  audio.src = `/api/jobs/${jobId}/download/${stemKey}`;
  card.appendChild(audio);

  const downloadLink = document.createElement('a');
  downloadLink.href = `/api/jobs/${jobId}/download/${stemKey}`;
  downloadLink.download = `${baseName(currentFile.name)}_${stemKey}.wav`;
  downloadLink.className = 'download-link';
  downloadLink.textContent = 'Download WAV';
  card.appendChild(downloadLink);

  els.resultsList.appendChild(card);
}

async function pollJob(jobId) {
  const res = await fetch(`/api/jobs/${jobId}`);
  if (!res.ok) throw new Error(`Status check failed (HTTP ${res.status}).`);
  const data = await res.json();

  if (data.status === 'error') {
    throw new Error(data.error || 'Separation failed.');
  }
  if (data.status === 'done') {
    return data;
  }

  const label = data.status === 'queued' ? 'Queued...' : 'Separating stems...';
  if (typeof data.progress === 'number' && data.progress > 0) {
    setProgress(data.progress, `${label} ${(data.progress * 100).toFixed(0)}%`);
  } else {
    setProgress(null, label);
  }
  return null;
}

els.separateBtn.addEventListener('click', async () => {
  clearError();
  els.separateBtn.disabled = true;
  els.resultsSection.hidden = true;
  els.resultsList.innerHTML = '';
  if (polling) clearInterval(polling);

  try {
    const formData = new FormData();
    formData.append('file', currentFile);
    const selectedStems = els.checkboxes.filter((c) => c.checked).map((c) => c.dataset.stem);
    formData.append('stems', selectedStems.join(','));

    setProgress(null, 'Uploading...');

    const res = await fetch('/api/separate', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Upload failed (HTTP ${res.status}).`);

    const jobId = data.job_id;

    const result = await new Promise((resolve, reject) => {
      polling = setInterval(async () => {
        try {
          const status = await pollJob(jobId);
          if (status) {
            clearInterval(polling);
            polling = null;
            resolve(status);
          }
        } catch (err) {
          clearInterval(polling);
          polling = null;
          reject(err);
        }
      }, 1200);
    });

    els.resultsList.innerHTML = '';
    for (const stemKey of result.stems) {
      renderResultCard(jobId, stemKey);
    }
    els.downloadAllBtn.onclick = () => {
      window.location.href = `/api/jobs/${jobId}/download-all`;
    };
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

updateSeparateEnabled();
