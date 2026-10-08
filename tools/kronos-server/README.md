# Kronos forecast server (optional)

[Kronos](https://github.com/shiyu-coder/Kronos) is an open foundation model (MIT licence) trained only on
financial candles (OHLCV) from more than 45 exchanges. This small server keeps it loaded on your computer so
StratForge can ask it for a forecast: the **Kronos** button above the chart draws the next 24 bars as a dashed
line, and the analyst can call the `forecast_kronos` tool.

Everything runs locally. The server listens on `127.0.0.1:8765` only and answers browser requests only from
the StratForge origins listed in `ALLOWED_ORIGINS`.

## Setup (Windows, about 5 minutes)

```bash
git clone https://github.com/shiyu-coder/Kronos.git
cd Kronos
uv venv --python 3.13 .venv
uv pip install --python .venv/Scripts/python.exe torch --index-url https://download.pytorch.org/whl/cpu
uv pip install --python .venv/Scripts/python.exe "numpy<2.3" pandas==2.2.3 einops==0.8.1 huggingface_hub==0.33.1 safetensors==0.6.2 tqdm
copy <path-to-stratforge>\tools\kronos-server\stratforge_server.py .
.venv\Scripts\python.exe stratforge_server.py
```

The first run downloads Kronos-small (24.7M parameters) and its tokenizer from Hugging Face. On a laptop CPU a
24-bar forecast with 5 samples takes a few seconds. `--model NeoQuasar/Kronos-mini` is smaller and reads up to
2,048 bars; `--device cuda` uses an NVIDIA GPU if PyTorch was installed with CUDA.

## What it is and is not

Kronos returns the mean of several sampled paths. It has not been validated on any particular asset here,
and averaging hides how far the samples disagree. Treat the forecast as one input to test, never as a signal.
