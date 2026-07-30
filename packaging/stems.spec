# PyInstaller spec for the Stems desktop app.
# Build with: pyinstaller packaging/stems.spec --noconfirm --clean
#
# PyInstaller resolves relative paths in a .spec file relative to the spec
# file's OWN directory, not the cwd it was invoked from -- so paths here are
# built from SPECPATH (injected by PyInstaller into this file's namespace)
# rather than assumed to be relative to the repo root.

import os

from PyInstaller.utils.hooks import collect_all

ROOT = os.path.dirname(SPECPATH)  # packaging/ -> repo root

datas = [(os.path.join(ROOT, 'web'), 'web')]
binaries = []
hiddenimports = []

# torch/demucs and their audio/model-hub dependencies have historically been
# finicky with PyInstaller's default import scanning (native extensions,
# dynamically-loaded submodules, packaged data files), so pull in everything
# for each rather than trying to hand-list hidden imports.
for pkg in [
    'torch',
    'demucs',
    'einops',
    'julius',
    'sphn',
    'safetensors',
    'huggingface_hub',
    'waitress',
    'numpy',
    'audio_separator',
    'onnxruntime',
    'librosa',
    'onnx2torch',
]:
    try:
        pkg_datas, pkg_binaries, pkg_hiddenimports = collect_all(pkg)
    except Exception as exc:  # noqa: BLE001 - one missing/renamed package shouldn't sink the build
        print(f'stems.spec: skipping collect_all for {pkg!r}: {exc}')
        continue
    datas += pkg_datas
    binaries += pkg_binaries
    hiddenimports += pkg_hiddenimports

a = Analysis(
    [os.path.join(ROOT, 'server', 'app.py')],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='Stems',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=None,
)
