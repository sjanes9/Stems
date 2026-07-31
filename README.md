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

- Runs Meta's open-source **HT-Demucs** source-separation model locally via
  the official [`demucs`](https://github.com/adefossez/demucs) Python
  package (PyTorch under the hood) — the reference implementation, not a
  reverse-engineered export. Two models are selectable in the UI:
  **htdemucs_6s** (6 stems, adds Guitar/Piano) or **htdemucs_ft** (4 stems,
  no Guitar/Piano, but measurably higher fidelity per Demucs' own docs —
  pick this if you don't need Guitar/Piano isolated). A "Better" quality
  toggle also runs Demucs' shift-trick ensembling for fewer artifacts, at
  roughly proportionally longer processing time.
- Optionally runs a second pass on the extracted vocals stem using a
  community **"Karaoke" model** from the [UVR (Ultimate Vocal
  Remover)](https://github.com/nomadkaraoke/python-audio-separator) project,
  splitting it into **Lead Vocals** and **Backing Vocals** (harmonies/BGVs).
  This only runs if you check one of those two boxes, since it's an extra
  model download + processing pass.
- A small local Flask server handles the upload, runs separation in a
  background thread, and reports real progress back to the page as it works
  through the track.
- Lets you preview and download each selected stem as a WAV, or bundle all
  selected stems into a single `.zip` download.
- Pretrained models download automatically on first use and are cached
  afterward (`demucs` under your user cache directory; the karaoke model
  under your system temp dir), so later runs don't re-download them.

## Stem mapping — read this

You originally asked for checkboxes for **drums, lead guitar, rhythm
guitar, bass, percussion, and keyboards**, and later for **lead vocals and
backing vocals** too. Here's what's actually achievable with open, local,
free models vs. not:

- **Lead vocals vs. backing vocals**: achievable — a community "Karaoke"
  model (trained specifically to split a lead vocal from
  backing/harmony vocals) exists in the UVR ecosystem and is wired up here.
- **Lead guitar vs. rhythm guitar**: not achievable locally/for free. No
  open-source separation model makes this distinction — it's a proprietary
  feature of commercial services like Moises.ai, not something downloadable
  and runnable offline. Guitar stays as one combined stem.
- **Percussion as its own stem, separate from the drum kit**: also not
  available in any open model — it's folded into Drums.

HT-Demucs's 6-stem model (htdemucs_6s) gives **drums, bass, other, vocals,
guitar, piano**; the 4-stem model (htdemucs_ft) gives **drums, bass, other,
vocals** at higher fidelity. The vocals stem is further split by the
karaoke model when requested, regardless of which base model you picked.
The UI's checkboxes map onto all of this as:

| Checkbox              | Comes from |
|------------------------|---------------------------|
| Drums                  | HT-Demucs `drums` (includes percussion) |
| Bass                    | HT-Demucs `bass` |
| Guitar (lead+rhythm)   | HT-Demucs `guitar` (both combined, no open model splits this further) |
| Piano / Keyboards      | HT-Demucs `piano` |
| Lead Vocals             | HT-Demucs `vocals` → UVR karaoke model's lead-vocal output |
| Backing Vocals          | HT-Demucs `vocals` → UVR karaoke model's backing-vocal output |
| Other                   | HT-Demucs `other` (anything the model can't attribute above) |

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
- **Stems sound bad / muddy / artifact-y** — switch Model to "Best Quality"
  if you don't need Guitar/Piano (htdemucs_6s trades quality for those two
  extra stems), and/or switch Quality to "Better" for the shift-trick
  ensembling pass. Also worth knowing: no separation model gets a perfect
  clean split — some bleed between stems (e.g. a bit of vocal in the
  "other" stem) is normal even for the best available open models.

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
