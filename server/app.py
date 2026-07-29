"""Local server for Stems: serves the web UI and runs Meta's open-source
HT-Demucs (6-stem) model via the official `demucs` package to separate an
uploaded song into drums/bass/guitar/piano/vocals/other WAV files.

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

WEB_DIR = BASE_DIR / "web"
MODEL_NAME = "htdemucs_6s"
STEM_KEYS = ["drums", "bass", "guitar", "piano", "vocals", "other"]

app = Flask(__name__, static_folder=None)

JOBS = {}
JOBS_LOCK = threading.Lock()

_separator = None
_separator_lock = threading.Lock()

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


def run_separation(job_id, input_path, requested_stems):
    with JOBS_LOCK:
        job = JOBS[job_id]
        job["status"] = "processing"

    def progress_callback(info):
        audio_length = info.get("audio_length")
        segment_offset = info.get("segment_offset")
        if audio_length:
            frac = max(0.0, min(1.0, (segment_offset or 0) / audio_length))
            with JOBS_LOCK:
                job["progress"] = frac

    try:
        from demucs.api import save_audio

        with PROCESSING_LOCK:
            separator = get_separator()
            separator.update_parameter(callback=progress_callback, callback_arg={})
            _, separated = separator.separate_audio_file(input_path)

            out_dir = Path(tempfile.mkdtemp(prefix="stems_out_"))
            for stem in requested_stems:
                source = separated.get(stem)
                if source is None:
                    continue
                save_audio(source, str(out_dir / f"{stem}.wav"), samplerate=separator.samplerate)

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
