# PyInstaller spec for the Stems desktop app.
# Build with: pyinstaller packaging/stems.spec --noconfirm --clean
# Run from the repo root so relative paths ('web', 'server/app.py') resolve.

from PyInstaller.utils.hooks import collect_all

datas = [('web', 'web')]
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
]:
    pkg_datas, pkg_binaries, pkg_hiddenimports = collect_all(pkg)
    datas += pkg_datas
    binaries += pkg_binaries
    hiddenimports += pkg_hiddenimports

a = Analysis(
    ['server/app.py'],
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
