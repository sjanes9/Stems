// Runs Meta's open-source HT-Demucs 6-stem source-separation model
// (drums, bass, other, vocals, guitar, piano) entirely client-side using
// onnxruntime-web. Pretrained ONNX weights are pulled from the
// `StemSplitio/htdemucs-6s-onnx` Hugging Face repo (MIT-licensed export of
// Meta's Demucs) on first use and cached locally afterward.
//
// No publicly available model separates "lead" vs "rhythm" guitar, or
// treats "percussion" and "keyboards" as their own stems -- HT-Demucs's six
// outputs are the finest split that exists. The UI maps onto them as:
//   Drums (includes percussion) / Bass / Guitar (lead+rhythm) /
//   Piano & Keyboards / Vocals / Other.

const HF_REPO = 'StemSplitio/htdemucs-6s-onnx';
const HF_TREE_URL = `https://huggingface.co/api/models/${HF_REPO}/tree/main`;
const HF_RESOLVE_BASE = `https://huggingface.co/${HF_REPO}/resolve/main/`;

// Fallback candidate filenames if the tree API can't be reached (e.g. CORS
// change upstream). Tried in order with a HEAD request.
const FALLBACK_CANDIDATES = {
  fp32: ['model.onnx', 'htdemucs_6s.onnx', 'htdemucs-6s.onnx'],
  fp16: ['model_fp16.onnx', 'model.fp16.onnx', 'htdemucs_6s_fp16.onnx', 'htdemucs_6s.fp16.onnx'],
};

const STEM_ORDER = ['drums', 'bass', 'other', 'vocals', 'guitar', 'piano'];
const STEM_KEYWORDS = {
  drums: ['drum'],
  bass: ['bass'],
  vocals: ['vocal', 'voice'],
  guitar: ['guitar'],
  piano: ['piano', 'keys', 'keyboard'],
  other: ['other'],
};

const SAMPLE_RATE = 44100;
const SEGMENT_SAMPLES = 343980; // 7.8s @ 44100Hz, HT-Demucs's native segment length
const OVERLAP = 0.25;
const HOP_SAMPLES = Math.round(SEGMENT_SAMPLES * (1 - OVERLAP));

class DemucsEngine {
  constructor({ onLog } = {}) {
    this.session = null;
    this.onLog = onLog || (() => {});
    this.modelUrlOverride = null;
  }

  log(...args) {
    this.onLog(args.map(String).join(' '));
  }

  async discoverModelUrl(precision) {
    if (this.modelUrlOverride) return this.modelUrlOverride;

    try {
      const res = await fetch(HF_TREE_URL);
      if (res.ok) {
        const entries = await res.json();
        const onnxFiles = entries
          .filter((e) => e.path && e.path.endsWith('.onnx'))
          .map((e) => e.path);
        const wantFp16 = precision === 'fp16';
        const match =
          onnxFiles.find((p) => /fp16/i.test(p) === wantFp16) || onnxFiles[0];
        if (match) return HF_RESOLVE_BASE + match;
      }
    } catch (err) {
      this.log('Model file listing lookup failed, falling back to known filenames:', err.message);
    }

    for (const name of FALLBACK_CANDIDATES[precision] || FALLBACK_CANDIDATES.fp32) {
      const url = HF_RESOLVE_BASE + name;
      try {
        const head = await fetch(url, { method: 'HEAD' });
        if (head.ok) return url;
      } catch (_) {
        // try next candidate
      }
    }

    throw new Error(
      'Could not automatically locate the ONNX model file on Hugging Face. ' +
      'Open the "Advanced" panel and paste a direct model URL manually.'
    );
  }

  async loadModel({ precision = 'fp16', executionProvider = 'auto', onProgress } = {}) {
    const url = await this.discoverModelUrl(precision);
    this.log('Downloading model from', url);

    const arrayBuffer = await fetchWithProgress(url, (loaded, total) => {
      if (onProgress) onProgress({ phase: 'download', loaded, total });
    });

    let providers;
    if (executionProvider === 'auto') {
      providers = (typeof navigator !== 'undefined' && navigator.gpu) ? ['webgpu', 'wasm'] : ['wasm'];
    } else {
      providers = [executionProvider];
    }

    // graphOptimizationLevel 'all' runs layout/constant-folding passes that
    // hold extra copies of the graph in memory during session creation --
    // on a ~130-260MB model that's enough to blow WASM's heap (bad_alloc).
    // 'basic' keeps memory use close to the model's raw size.
    this.session = await ort.InferenceSession.create(arrayBuffer, {
      executionProviders: providers,
      graphOptimizationLevel: 'basic',
      enableCpuMemArena: false,
      enableMemPattern: false,
    });

    this.log('Model loaded. Inputs:', this.session.inputNames.join(', '),
      '| Outputs:', this.session.outputNames.join(', '));

    if (onProgress) onProgress({ phase: 'ready' });
  }

  isLoaded() {
    return !!this.session;
  }

  // Decodes any browser-supported audio file (wav/mp3/etc.) and resamples
  // it to the model's native 44.1kHz stereo format.
  async decodeAndResampleFile(file) {
    const arrayBuffer = await file.arrayBuffer();
    const decodeCtx = new (window.AudioContext || window.webkitAudioContext)();
    let decoded;
    try {
      decoded = await decodeCtx.decodeAudioData(arrayBuffer);
    } finally {
      decodeCtx.close();
    }

    if (decoded.sampleRate === SAMPLE_RATE && decoded.numberOfChannels >= 2) {
      return {
        left: decoded.getChannelData(0).slice(),
        right: decoded.getChannelData(1).slice(),
        duration: decoded.duration,
      };
    }

    const offlineCtx = new OfflineAudioContext(2, Math.ceil(decoded.duration * SAMPLE_RATE), SAMPLE_RATE);
    const source = offlineCtx.createBufferSource();
    source.buffer = decoded;
    source.connect(offlineCtx.destination);
    source.start();
    const rendered = await offlineCtx.startRendering();

    const left = rendered.getChannelData(0).slice();
    const right = rendered.numberOfChannels > 1 ? rendered.getChannelData(1).slice() : rendered.getChannelData(0).slice();
    return { left, right, duration: rendered.duration };
  }

  buildOlaWeight(length) {
    const half = Math.floor(length / 2);
    const odd = length % 2;
    const w = new Float32Array(length);
    for (let i = 0; i < half; i++) w[i] = i + 1;
    for (let i = 0; i < half + odd; i++) w[half + i] = half + odd - i;
    let max = 0;
    for (let i = 0; i < length; i++) if (w[i] > max) max = w[i];
    for (let i = 0; i < length; i++) w[i] = w[i] / max;
    return w;
  }

  analyzeDims(dims) {
    const hasBatch = dims.length === 4;
    let batchIndex = null, stemIndex = null, chIndex = null, timeIndex = null;
    if (hasBatch) {
      batchIndex = dims.findIndex((d) => d === 1);
    }
    for (let i = 0; i < dims.length; i++) {
      if (i === batchIndex) continue;
      if (stemIndex === null && dims[i] === STEM_ORDER.length) { stemIndex = i; continue; }
      if (chIndex === null && dims[i] === 2) { chIndex = i; continue; }
      timeIndex = i;
    }
    return { batchIndex, stemIndex, chIndex, timeIndex };
  }

  strides(dims) {
    const s = new Array(dims.length).fill(1);
    for (let i = dims.length - 2; i >= 0; i--) s[i] = s[i + 1] * dims[i + 1];
    return s;
  }

  // Splits ONNX output tensor(s) for one segment into { stemName: [Float32Array L, Float32Array R] }
  extractSegmentStems(results) {
    const outputNames = this.session.outputNames;
    const stems = {};

    if (outputNames.length === 1) {
      const tensor = results[outputNames[0]];
      const dims = tensor.dims;
      const data = tensor.data;
      const { stemIndex, chIndex, timeIndex } = this.analyzeDims(dims);
      const strides = this.strides(dims);

      if (stemIndex === null || chIndex === null || timeIndex === null) {
        throw new Error(`Unrecognized model output shape [${dims.join(',')}]`);
      }

      for (let s = 0; s < STEM_ORDER.length; s++) {
        const name = STEM_ORDER[s];
        const left = new Float32Array(SEGMENT_SAMPLES);
        const right = new Float32Array(SEGMENT_SAMPLES);
        const baseL = s * strides[stemIndex] + 0 * strides[chIndex];
        const baseR = s * strides[stemIndex] + 1 * strides[chIndex];
        const step = strides[timeIndex];
        for (let t = 0; t < SEGMENT_SAMPLES; t++) {
          left[t] = data[baseL + t * step];
          right[t] = data[baseR + t * step];
        }
        stems[name] = [left, right];
      }
      return stems;
    }

    // Multiple named outputs: one tensor per stem.
    outputNames.forEach((outName, idx) => {
      const tensor = results[outName];
      const dims = tensor.dims;
      const data = tensor.data;
      const chAxisSize2 = dims.findIndex((d) => d === 2);
      const timeAxis = dims.findIndex((d, i) => i !== chAxisSize2 && d !== 1);
      const strides = this.strides(dims);
      const left = new Float32Array(SEGMENT_SAMPLES);
      const right = new Float32Array(SEGMENT_SAMPLES);
      const step = strides[timeAxis];
      const baseL = 0 * strides[chAxisSize2];
      const baseR = 1 * strides[chAxisSize2];
      for (let t = 0; t < SEGMENT_SAMPLES; t++) {
        left[t] = data[baseL + t * step];
        right[t] = data[baseR + t * step];
      }

      const lowerName = outName.toLowerCase();
      let matched = Object.keys(STEM_KEYWORDS).find((stem) =>
        STEM_KEYWORDS[stem].some((kw) => lowerName.includes(kw))
      );
      if (!matched) matched = STEM_ORDER[idx] || `stem${idx}`;
      stems[matched] = [left, right];
    });

    return stems;
  }

  async separate(pcm, { onProgress } = {}) {
    if (!this.session) throw new Error('Model not loaded yet.');

    const totalLength = pcm.left.length;
    const numSegments = Math.max(1, Math.ceil((totalLength - SEGMENT_SAMPLES) / HOP_SAMPLES) + 1);
    const weight = this.buildOlaWeight(SEGMENT_SAMPLES);

    const sumOut = {};
    for (const stem of STEM_ORDER) {
      sumOut[stem] = [new Float32Array(totalLength), new Float32Array(totalLength)];
    }
    const sumWeight = new Float32Array(totalLength);

    const inputName = this.session.inputNames.includes('mix')
      ? 'mix'
      : this.session.inputNames[0];

    for (let seg = 0; seg < numSegments; seg++) {
      const offset = seg * HOP_SAMPLES;
      const validLen = Math.min(SEGMENT_SAMPLES, totalLength - offset);

      const chunkData = new Float32Array(2 * SEGMENT_SAMPLES);
      chunkData.set(pcm.left.subarray(offset, offset + validLen), 0);
      chunkData.set(pcm.right.subarray(offset, offset + validLen), SEGMENT_SAMPLES);

      const inputTensor = new ort.Tensor('float32', chunkData, [1, 2, SEGMENT_SAMPLES]);
      const results = await this.session.run({ [inputName]: inputTensor });
      const segmentStems = this.extractSegmentStems(results);

      for (const stem of STEM_ORDER) {
        const [segL, segR] = segmentStems[stem];
        const [outL, outR] = sumOut[stem];
        for (let i = 0; i < validLen; i++) {
          const w = weight[i];
          outL[offset + i] += segL[i] * w;
          outR[offset + i] += segR[i] * w;
        }
      }
      for (let i = 0; i < validLen; i++) sumWeight[offset + i] += weight[i];

      if (onProgress) onProgress({ phase: 'infer', segment: seg + 1, totalSegments: numSegments });
    }

    const result = { sampleRate: SAMPLE_RATE };
    for (const stem of STEM_ORDER) {
      const [outL, outR] = sumOut[stem];
      for (let i = 0; i < totalLength; i++) {
        const w = sumWeight[i] || 1;
        outL[i] /= w;
        outR[i] /= w;
      }
      result[stem] = [outL, outR];
    }
    return result;
  }
}
