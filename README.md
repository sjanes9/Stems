# Stems

A single-page HTML app that separates a song into instrument stems entirely
in your browser — no server, no upload, no account. Load a `.wav` or `.mp3`,
pick which stems you want, and get individual downloadable WAV files.

## Running it

Because the app fetches a ~130–260MB AI model from Hugging Face at runtime,
most browsers won't allow that from a plain `file://` page. Serve the folder
over HTTP instead:

```bash
cd Stems
python3 -m http.server 8000
# then open http://localhost:8000
```

Any other static file server (`npx serve`, `caddy file-server`, etc.) works
too.

## What it does

- Decodes your `.wav`/`.mp3` locally using the Web Audio API and resamples it
  to 44.1kHz stereo.
- Runs Meta's open-source **HT-Demucs (6-stem)** source-separation model via
  [onnxruntime-web](https://github.com/microsoft/onnxruntime) (WebAssembly,
  or WebGPU when available), using a pretrained ONNX export hosted at
  [`StemSplitio/htdemucs-6s-onnx`](https://huggingface.co/StemSplitio/htdemucs-6s-onnx)
  on Hugging Face (MIT-licensed).
- Processes audio in overlapping ~7.8s chunks with a triangular
  overlap-add crossfade (the same windowing scheme the original Demucs
  project uses) so stitched output has no clicks/seams at chunk boundaries.
- Lets you preview and download each selected stem as a WAV, or bundle all
  selected stems into a single `.zip` (built client-side, no dependency).
- Caches the model in the browser's Cache Storage after the first
  download, so later separations skip re-downloading it.

## Stem mapping — read this

You asked for checkboxes for **drums, lead guitar, rhythm guitar, bass,
percussion, and keyboards**. No publicly available source-separation model
(Demucs, Spleeter, or anything else) actually produces that breakdown —
none of them distinguish lead vs. rhythm guitar, or split percussion out
from the drum kit. HT-Demucs's 6-stem model is the finest split that
exists today, with six real outputs: **drums, bass, other, vocals, guitar,
piano**. The UI's checkboxes map onto those:

| Checkbox            | Comes from HT-Demucs stem |
|----------------------|---------------------------|
| Drums                | `drums` (includes percussion) |
| Bass                  | `bass` |
| Guitar (lead+rhythm) | `guitar` (both combined, model can't split further) |
| Piano / Keyboards    | `piano` |
| Vocals                | `vocals` (bonus — included since it's produced for free) |
| Other                 | `other` (anything the model can't attribute above) |

## Performance expectations

Running a hybrid-transformer neural net entirely in-browser via WASM is
much slower than a native/server GPU setup. Expect **a few minutes per
song** on CPU; enabling the WebGPU execution provider (Advanced settings,
if your browser supports it) is noticeably faster. Very long tracks
(> ~8 minutes) can also use a lot of memory, since every stem is held in
memory as float32 PCM before being encoded to WAV — the app warns you but
doesn't hard-block it.

## Troubleshooting

- **"Could not automatically locate the ONNX model file"** — the app looks
  up the model file list from the Hugging Face repo automatically; if that
  repo's file layout changes, open **How this works / limitations →
  Advanced settings** and paste a direct `.onnx` URL from
  https://huggingface.co/StemSplitio/htdemucs-6s-onnx/tree/main into the
  "Model URL override" field.
- **Slow / tab freezes** — try a shorter clip first, switch Advanced
  settings → Execution provider to WebGPU if your browser supports it, or
  close other tabs to free up memory.
- **CORS / network errors fetching the model** — some networks block
  Hugging Face; try a different network, or download the `.onnx` file
  yourself and change the override URL to a local path you're serving.

## File structure

```
index.html            UI markup
css/styles.css         styling
js/wav-encoder.js      Float32 PCM -> 16-bit WAV Blob
js/zip-writer.js       store-only ZIP writer (bundles stems for download)
js/model-cache.js      fetch + Cache Storage API for the ONNX model
js/demucs-engine.js    model loading, resampling, chunked inference, overlap-add
js/app.js              UI wiring / orchestration
```
