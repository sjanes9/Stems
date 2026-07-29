# Stems

A desktop app that separates a song into instrument stems using Meta's
open-source HT-Demucs model. Load a `.wav` or `.mp3`, pick which stems you
want, and get individual downloadable WAV files. Everything runs on your own
machine — no upload, no account, no cloud service.

## Getting it — Windows

Download `Stems.exe` from the latest build (see the repo's GitHub Actions
run / Releases) and double-click it. A console window opens showing a local
URL (e.g. `http://127.0.0.1:5000`) and your browser opens to it automatically.
Leave the console window open while you use the app; closing it stops the
server. The first time you separate a song, it downloads the AI model
(roughly 300–500MB) and caches it, so later runs are faster to start.

There's no installer — it's a single portable `.exe`. Expect the file itself
to be large (in the 1–2GB range), since it bundles a full Python + PyTorch
runtime so you don't have to install anything yourself.

## Running it from source (any OS)

```bash
git clone <this repo>
cd Stems
python3 -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python server/app.py
```

This opens your browser to the app automatically. Requires Python 3.10+.

## What it does

- Runs Meta's open-source **HT-Demucs (6-stem)** source-separation model
  locally via the official [`demucs`](https://github.com/adefossez/demucs)
  Python package (PyTorch under the hood) — the reference implementation,
  not a reverse-engineered export.
- A small local Flask server handles the upload, runs separation in a
  background thread, and reports real progress back to the page as it works
  through the track.
- Lets you preview and download each selected stem as a WAV, or bundle all
  selected stems into a single `.zip` download.
- The pretrained model downloads automatically on first use and is cached
  by `demucs` afterward (typically under your user cache directory), so
  later runs don't re-download it.

## Stem mapping — read this

You asked for checkboxes for **drums, lead guitar, rhythm guitar, bass,
percussion, and keyboards**. No publicly available source-separation model
(Demucs, Spleeter, or anything else) actually produces that breakdown —
none of them distinguish lead vs. rhythm guitar, or split percussion out
from the drum kit. HT-Demucs's 6-stem model is the finest split that
exists today, with six real outputs: **drums, bass, other, vocals, guitar,
piano**. The UI's checkboxes map onto those:

| Checkbox              | Comes from HT-Demucs stem |
|------------------------|---------------------------|
| Drums                  | `drums` (includes percussion) |
| Bass                    | `bass` |
| Guitar (lead+rhythm)   | `guitar` (both combined, model can't split further) |
| Piano / Keyboards      | `piano` |
| Vocals                  | `vocals` (bonus — included since it's produced for free) |
| Other                   | `other` (anything the model can't attribute above) |

## Performance expectations

Separation runs on your CPU by default (GPU/CUDA is used automatically if
PyTorch detects one). Expect anywhere from under a minute to several minutes
per song depending on your hardware and track length.

## Troubleshooting

- **Nothing happens when double-clicking the exe** — antivirus/SmartScreen
  sometimes holds back unsigned executables the first time; check Windows
  Defender's notification area, or run it from a terminal (`Stems.exe`) to
  see any error text directly.
- **Stuck on "Queued..."** — the first request loads the model into memory
  (and downloads it, on the very first run) before any progress shows;
  large tracks or the very first run can take a while here.
- **Separation fails partway** — check the console window for the actual
  Python error; the most common causes are an unsupported/corrupt input
  file, or running out of disk space for the model download.

## File structure

```
server/app.py            Flask app: upload handling, job queue, demucs invocation, static serving
web/index.html            UI markup
web/css/styles.css        styling
web/js/app.js              UI wiring: upload, job polling, results
requirements.txt          Python dependencies
packaging/stems.spec      PyInstaller build spec (produces the Windows exe)
.github/workflows/        CI workflow that builds Stems.exe on a Windows runner
```
