# One-click Kronos for StratForge (Windows).
#
# First run: installs everything into %LOCALAPPDATA%\StratForge-Kronos (about 5-10 minutes):
#   uv (Python manager) -> Python 3.13 -> the Kronos code (pinned commit) -> PyTorch (CUDA if an NVIDIA GPU is
#   found, otherwise CPU) -> the Python packages -> these server files -> the StratForge web app.
# Every run: starts the server and opens StratForge at http://127.0.0.1:8765/stratforge/
#
#   start-kronos.cmd            (double-click)
#   start-kronos.cmd -Cpu       force the CPU build of PyTorch
#   start-kronos.cmd -Update    re-download the server files and the web app
#   start-kronos.cmd -NoStart   install only

param([switch]$Cpu, [switch]$Update, [switch]$NoStart, [string]$Root = "$env:LOCALAPPDATA\StratForge-Kronos")

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$KronosCommit = "67b630e67f6a18c9e9be918d9b4337c960db1e9a"   # shiyu-coder/Kronos, MIT licence
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Kronos = Join-Path $Root "Kronos"
$Py = Join-Path $Kronos ".venv\Scripts\python.exe"
$App = Join-Path $Kronos "stratforge-app"

function Step($msg) { Write-Host "`n== $msg" -ForegroundColor Cyan }

New-Item -ItemType Directory -Force $Root | Out-Null

# 1. uv, the Python installer and package manager from Astral
$uv = Get-Command uv -ErrorAction SilentlyContinue
if (-not $uv) {
    Step "Installing uv (https://astral.sh/uv)"
    powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://astral.sh/uv/install.ps1 | iex"
    $env:Path = "$env:USERPROFILE\.local\bin;$env:Path"
    $uv = Get-Command uv -ErrorAction Stop
}
$uv = $uv.Source

# 2. The Kronos code, pinned to a known commit
if (-not (Test-Path (Join-Path $Kronos "model\kronos.py"))) {
    Step "Downloading the Kronos code"
    $zip = Join-Path $Root "kronos.zip"
    Invoke-WebRequest "https://github.com/shiyu-coder/Kronos/archive/$KronosCommit.zip" -OutFile $zip
    Expand-Archive $zip -DestinationPath $Root -Force
    if (Test-Path $Kronos) { Remove-Item $Kronos -Recurse -Force }
    Rename-Item (Join-Path $Root "Kronos-$KronosCommit") "Kronos"
    Remove-Item $zip
}

# 3. Python environment, PyTorch and packages
if (-not (Test-Path $Py)) {
    Step "Creating the Python environment"
    & $uv venv --python 3.13 (Join-Path $Kronos ".venv")
    $gpu = (-not $Cpu) -and [bool](Get-Command nvidia-smi -ErrorAction SilentlyContinue)
    $index = if ($gpu) { "https://download.pytorch.org/whl/cu128" } else { "https://download.pytorch.org/whl/cpu" }
    Step ("Installing PyTorch for " + $(if ($gpu) { "the NVIDIA GPU (about 3 GB)" } else { "the CPU (about 200 MB)" }))
    & $uv pip install --python $Py torch --index-url $index
    Step "Installing the other packages"
    & $uv pip install --python $Py "numpy<2.3" pandas==2.2.3 einops==0.8.1 huggingface_hub==0.33.1 safetensors==0.6.2 tqdm
}

# 4. The server files (from this folder when run from a StratForge checkout, otherwise from GitHub)
$files = "stratforge_server.py", "kronos_paths.py", "eval_btc.py"
if ($Update -or -not (Test-Path (Join-Path $Kronos "stratforge_server.py"))) {
    Step "Copying the StratForge server files"
    foreach ($f in $files) {
        $local = Join-Path $Here $f
        if (Test-Path $local) { Copy-Item $local $Kronos -Force }
        else { Invoke-WebRequest "https://raw.githubusercontent.com/Limin-design/stratforge/main/tools/kronos-server/$f" -OutFile (Join-Path $Kronos $f) }
    }
}

# 5. The StratForge web app, served by the same server so the browser needs no local-network permission
if ($Update -or -not (Test-Path (Join-Path $App "index.html"))) {
    Step "Downloading the StratForge web app"
    $zip = Join-Path $Root "site.zip"
    Invoke-WebRequest "https://github.com/Limin-design/Limin-design.github.io/archive/refs/heads/main.zip" -OutFile $zip
    $tmp = Join-Path $Root "site"
    if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
    Expand-Archive $zip -DestinationPath $tmp -Force
    if (Test-Path $App) { Remove-Item $App -Recurse -Force }
    Move-Item (Join-Path $tmp "Limin-design.github.io-main\stratforge") $App
    Remove-Item $tmp -Recurse -Force
    Remove-Item $zip
}

if ($NoStart) { Write-Host "`nInstalled in $Kronos"; return }

# 6. Start: the browser opens once the model has loaded
Step "Starting Kronos (close this window to stop it)"
Start-Job -ScriptBlock {
    for ($i = 0; $i -lt 120; $i++) {
        try { Invoke-RestMethod "http://127.0.0.1:8765/health" -TimeoutSec 2 | Out-Null; Start-Process "http://127.0.0.1:8765/stratforge/"; return } catch { Start-Sleep 2 }
    }
} | Out-Null
Set-Location $Kronos
& $Py stratforge_server.py
