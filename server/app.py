"""Local server for Stems: serves the web UI and runs Meta's open-source
HT-Demucs (6-stem) model via the official `demucs` package to separate an
uploaded song into drums/bass/guitar/piano/vocals/other WAV files. The
vocals stem is then optionally run through a second-stage UVR "Karaoke"
model (via the `audio-separator` package) to split lead vocals from
backing vocals/harmonies.

Runs entirely on the user's machine -- nothing is uploaded anywhere else.
"""

import io
import os
import socket
import sys
import tempfile
import threading
import time
import uuid
import webbrowser
import zipfile
from pathlib import Path

from flask import Flask, jsonify, request, send_file, send_from_directory

if getattr(sys, "frozen", False):
    # Running from a PyInstaller-frozen exe: bundled data lives under _MEIPASS.
    BASE_DIR = Path(getattr(sys, "_MEIPASS"))
else:
    BASE_DIR = Path(__file__).resolve().parent.parent


def _ensure_ffmpeg_on_path():
    """audio-separator (via pydub/librosa) shells out to a literal "ffmpeg"
    executable on PATH -- it's a system binary, not something pip installs,
    so most users won't have it. imageio-ffmpeg bundles a static ffmpeg
    build as package data (via a versioned filename like
    "ffmpeg-win-x86_64-vX.Y.exe"), so copy that to a stable ffmpeg(.exe)
    name once and add its folder to PATH, unless the user already has a
    real ffmpeg available."""
    import shutil

    if shutil.which("ffmpeg"):
        return
    try:
        import imageio_ffmpeg

        bundled = imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return

    target_dir = Path(tempfile.gettempdir()) / "stems-ffmpeg"
    target_name = "ffmpeg.exe" if sys.platform == "win32" else "ffmpeg"
    target_path = target_dir / target_name
    if not target_path.exists():
        target_dir.mkdir(parents=True, exist_ok=True)
        shutil.copy2(bundled, target_path)
        if sys.platform != "win32":
            target_path.chmod(0o755)
    os.environ["PATH"] = str(target_dir) + os.pathsep + os.environ.get("PATH", "")


_ensure_ffmpeg_on_path()

WEB_DIR = BASE_DIR / "web"
MODEL_NAME = "htdemucs_6s"
KARAOKE_MODEL_NAME = "mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956.ckpt"
DIRECT_STEM_KEYS = ["drums", "bass", "guitar", "piano", "other"]
VOCAL_STEM_KEYS = ["lead_vocals", "backing_vocals"]
STEM_KEYS = DIRECT_STEM_KEYS + VOCAL_STEM_KEYS

app = Flask(__name__, static_folder=None)

JOBS = {}
JOBS_LOCK = threading.Lock()

_separator = None
_separator_lock = threading.Lock()

_karaoke_separator = None
_karaoke_separator_lock = threading.Lock()

# demucs reuses one loaded model across jobs for speed, but its progress
# callback is set per-instance (Separator.update_parameter), so only one
# separation can run at a time or callbacks from different jobs would clobber
# each other. Fine for a single-user local desktop app.
PROCESSING_LOCK = threading.Lock()


def get_separator():
    """Lazily load the demucs model (first call downloads ~300-500MB of
    pretrained weights via demucs' own downloader, cached afterward)."""
    global _separator
    with _separator_lock:
        if _separator is None:
            from demucs.api import Separator

            _separator = Separator(model=MODEL_NAME)
        return _separator


def get_karaoke_separator(out_dir):
    """Lazily load the UVR "Karaoke" model (splits a vocals-only track into
    lead vocal vs. backing vocals/harmonies). First call downloads its
    checkpoint, cached under the system temp dir afterward."""
    global _karaoke_separator
    with _karaoke_separator_lock:
        if _karaoke_separator is None:
            from audio_separator.separator import Separator as KaraokeSeparator

            model_cache_dir = Path(tempfile.gettempdir()) / "stems-audio-separator-models"
            _karaoke_separator = KaraokeSeparator(model_file_dir=str(model_cache_dir))
            _karaoke_separator.load_model(model_filename=KARAOKE_MODEL_NAME)
        _karaoke_separator.output_dir = str(out_dir)
        return _karaoke_separator


def split_lead_backing_vocals(vocals_path, out_dir, requested_stems):
    """Runs the UVR Karaoke model on an isolated vocals track, producing
    lead_vocals.wav and/or backing_vocals.wav under out_dir (only the ones
    actually requested are kept)."""
    karaoke = get_karaoke_separator(out_dir)
    output_files = karaoke.separate(str(vocals_path))

    for path_str in output_files:
        path = Path(path_str)
        lower = path.name.lower()
        if "instrumental" in lower and "backing_vocals" in requested_stems:
            path.rename(out_dir / "backing_vocals.wav")
        elif "vocals" in lower and "lead_vocals" in requested_stems:
            path.rename(out_dir / "lead_vocals.wav")
        else:
            try:
                path.unlink()
            except OSError:
                pass


def run_separation(job_id, input_path, requested_stems):
    with JOBS_LOCK:
        job = JOBS[job_id]
        job["status"] = "processing"

    wants_vocal_split = any(s in VOCAL_STEM_KEYS for s in requested_stems)
    # demucs takes up the bulk of the time; leave the tail of the progress
    # bar for the karaoke pass when it's needed.
    demucs_progress_span = 0.85 if wants_vocal_split else 1.0

    def progress_callback(info):
        audio_length = info.get("audio_length")
        segment_offset = info.get("segment_offset")
        if audio_length:
            frac = max(0.0, min(1.0, (segment_offset or 0) / audio_length)) * demucs_progress_span
            with JOBS_LOCK:
                job["progress"] = frac

    try:
        from demucs.api import save_audio

        with PROCESSING_LOCK:
            separator = get_separator()
            separator.update_parameter(callback=progress_callback, callback_arg={})
            _, separated = separator.separate_audio_file(input_path)

            out_dir = Path(tempfile.mkdtemp(prefix="stems_out_"))
            for stem in DIRECT_STEM_KEYS:
                if stem not in requested_stems:
                    continue
                save_audio(separated[stem], str(out_dir / f"{stem}.wav"), samplerate=separator.samplerate)

            if wants_vocal_split:
                with JOBS_LOCK:
                    job["progress"] = demucs_progress_span
                # Named to avoid the substring "vocals" so the (Vocals)/
                # (Instrumental) suffix matching in split_lead_backing_vocals
                # can't be confused by the input filename itself.
                vocals_path = out_dir / "_stage1_input.wav"
                save_audio(separated["vocals"], str(vocals_path), samplerate=separator.samplerate)
                split_lead_backing_vocals(vocals_path, out_dir, requested_stems)
                vocals_path.unlink(missing_ok=True)

        with JOBS_LOCK:
            job["out_dir"] = str(out_dir)
            job["status"] = "done"
            job["progress"] = 1.0
    except Exception as exc:  # noqa: BLE001 - surface any failure to the UI
        with JOBS_LOCK:
            job["status"] = "error"
            job["error"] = str(exc)
    finally:
        try:
            os.remove(input_path)
        except OSError:
            pass


@app.route("/")
def index():
    return send_from_directory(WEB_DIR, "index.html")


@app.route("/<path:filename>")
def static_files(filename):
    return send_from_directory(WEB_DIR, filename)


@app.route("/api/separate", methods=["POST"])
def api_separate():
    file = request.files.get("file")
    if file is None or file.filename == "":
        return jsonify({"error": "No file uploaded."}), 400

    suffix = Path(file.filename).suffix.lower()
    if suffix not in (".wav", ".mp3"):
        return jsonify({"error": "Only .wav and .mp3 files are supported."}), 400

    requested_stems = [s for s in request.form.get("stems", "").split(",") if s in STEM_KEYS]
    if not requested_stems:
        return jsonify({"error": "No valid stems requested."}), 400

    tmp_dir = Path(tempfile.mkdtemp(prefix="stems_in_"))
    input_path = tmp_dir / f"input{suffix}"
    file.save(input_path)

    job_id = uuid.uuid4().hex
    with JOBS_LOCK:
        JOBS[job_id] = {
            "status": "queued",
            "error": None,
            "out_dir": None,
            "progress": 0.0,
            "requested_stems": requested_stems,
            "created": time.time(),
        }

    threading.Thread(
        target=run_separation, args=(job_id, str(input_path), requested_stems), daemon=True
    ).start()

    return jsonify({"job_id": job_id})


@app.route("/api/jobs/<job_id>")
def api_job_status(job_id):
    job = JOBS.get(job_id)
    if job is None:
        return jsonify({"error": "Unknown job."}), 404
    return jsonify(
        {
            "status": job["status"],
            "error": job["error"],
            "progress": job.get("progress", 0.0),
            "stems": job["requested_stems"] if job["status"] == "done" else [],
        }
    )


@app.route("/api/jobs/<job_id>/download/<stem>")
def api_job_download(job_id, stem):
    job = JOBS.get(job_id)
    if job is None or job["status"] != "done" or stem not in job["requested_stems"]:
        return jsonify({"error": "Stem not available."}), 404
    return send_file(Path(job["out_dir"]) / f"{stem}.wav", mimetype="audio/wav")


@app.route("/api/jobs/<job_id>/download-all")
def api_job_download_all(job_id):
    job = JOBS.get(job_id)
    if job is None or job["status"] != "done":
        return jsonify({"error": "Job not ready."}), 404

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for stem in job["requested_stems"]:
            path = Path(job["out_dir"]) / f"{stem}.wav"
            if path.exists():
                zf.write(path, arcname=f"{stem}.wav")
    buf.seek(0)
    return send_file(buf, mimetype="application/zip", as_attachment=True, download_name="stems.zip")


def find_free_port(preferred=5000):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind(("127.0.0.1", preferred))
            return preferred
        except OSError:
            s.bind(("127.0.0.1", 0))
            return s.getsockname()[1]


def main():
    port = find_free_port()
    url = f"http://127.0.0.1:{port}"

    def open_browser():
        time.sleep(1.0)
        webbrowser.open(url)

    threading.Thread(target=open_browser, daemon=True).start()

    print(f"Stems is running at {url} (close this window to stop it)")
    try:
        from waitress import serve

        serve(app, host="127.0.0.1", port=port)
    except ImportError:
        app.run(host="127.0.0.1", port=port)


if __name__ == "__main__":
    main()
