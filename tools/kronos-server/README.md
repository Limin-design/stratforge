# Kronos forecast server (optional)

[Kronos](https://github.com/shiyu-coder/Kronos) is an open foundation model (MIT licence) trained only on
financial candles (OHLCV) from more than 45 exchanges. This small server keeps it loaded on your computer so
StratForge can ask it for a forecast: the **Kronos** button above the chart draws the forecast, and the analyst
can call the `forecast_kronos` tool.

Everything runs locally. The server listens on `127.0.0.1:8765` only and answers browser requests only from
the StratForge origins listed in `ALLOWED_ORIGINS`. It also serves the StratForge web app at
`http://127.0.0.1:8765/stratforge/`: use that address. From the public website, browsers may block a public page
from reaching your computer.

## One click (Windows)

Double-click **`start-kronos.cmd`** in this folder. The first run installs everything into
`%LOCALAPPDATA%\StratForge-Kronos` (uv, Python 3.13, the Kronos code at a pinned commit, PyTorch with CUDA when it
finds an NVIDIA GPU or the CPU build otherwise, the packages, the server and the StratForge web app). Then, and on
every later run, it starts the server and opens **http://127.0.0.1:8765/stratforge/**. Close the window to stop it.

Options: `start-kronos.cmd -Cpu` (force the CPU build), `-Update` (fetch the latest server files and web app),
`-NoStart` (install only).

## Manual setup

```bash
git clone https://github.com/shiyu-coder/Kronos.git
cd Kronos
uv venv --python 3.13 .venv
uv pip install --python .venv/Scripts/python.exe torch --index-url https://download.pytorch.org/whl/cpu
uv pip install --python .venv/Scripts/python.exe "numpy<2.3" pandas==2.2.3 einops==0.8.1 huggingface_hub==0.33.1 safetensors==0.6.2 tqdm
```

Copy the three `.py` files from this folder into the Kronos folder, then start the server:

```bash
.venv/Scripts/python.exe stratforge_server.py
```

The first run downloads Kronos-small (24.7M parameters) and its tokenizer from Hugging Face.
`--model NeoQuasar/Kronos-mini` is smaller and reads up to 2,048 bars.

With an NVIDIA GPU, install PyTorch from `https://download.pytorch.org/whl/cu128` instead (RTX 50-series cards
need CUDA 12.8 or newer). The server uses the GPU automatically when it finds one. Measured on an RTX 5060:
20 paths of 24 bars from 512 bars in about 2.5 s. On a CPU, 5 paths take about 40 s.

## What the chart shows

The **Kronos** button samples 20 future paths. The dashed line is their median, and the two dotted lines hold
the middle 80% of paths (the 10th and 90th percentile of the close at each bar). The status line says how many
paths end above the last close.

## Files

- `stratforge_server.py`: the local HTTP server (`GET /health`, `POST /forecast`).
- `kronos_paths.py`: keeps each sampled path (Kronos averages them internally) and loads Binance candles.
- `eval_btc.py`: the out-of-sample check below.

## Does it work on BTC?

Treat any forecast as one input to test, never as a signal. `eval_btc.py` checks Kronos-small on BTCUSDT from
1 September 2025, after the Kronos paper (August 2025), so the model has not seen these prices.

Setup: Kronos-small, 20 sampled paths per forecast, non-overlapping forecast origins, 400 bars of context.
"Direction" compares the sign of the median path with what happened. The base rate is "always say the more
common direction"; momentum is "the next move repeats the last one". The band should hold the real price 80% of
the time.

| Candles | Ahead | Forecasts | Kronos direction | Base rate | Momentum | Band holds price (target 80%) | Error vs "no change" |
|---|---|---|---|---|---|---|---|
| 1 h | 1 h | 402 | 48.3% | 51.5% | 47.3% | 57% | 0.33% vs 0.29% |
| 1 h | 6 h | 402 | 55.5% | 50.5% | 48.3% | 53% | 0.76% vs 0.69% |
| 1 h | 24 h | 402 | 48.8% | 51.0% | 51.2% | 28% | 2.67% vs 1.58% |
| 4 h | 4 h | 401 | 55.1% (95% CI 50.2-59.9) | 50.1% | 46.9% | 61% | 0.71% vs 0.57% |
| 4 h | 24 h | 401 | 46.4% | 50.9% | 51.1% | 46% | 1.87% vs 1.58% |

- **Direction:** no reliable edge. The only result below p = 0.05 (4 h candles, next bar, p = 0.026) is one of
  about ten comparisons, so it does not survive a correction for multiple tests.
- **Size of the move:** predicting "no change" was more accurate at every horizon.
- **Probability of up:** the share of paths that end up scored worse than the base rate (Brier score) at every
  horizon: the model is too sure of itself.
- **Band:** too narrow, and narrower the further ahead it looks. In a spot check the paths moved about 0.35% per
  hour against 0.57% in the real data. Sampling without the nucleus cut (`--top-p 1.0`, 134 forecasts) barely
  changed it (60%, 59% and 31%).
- **Trading on the sign of the median** (long or short, 0.1% round trip): -55.1% against -23.0% for buy and hold
  (1 h candles, 24 h ahead) and -63.3% against -21.0% (4 h candles, 24 h ahead).

So in StratForge the Kronos line shows what this model expects, not a signal, and its band understates the risk.
Re-run with `eval_btc.py --interval 1h --horizon 24 --samples 20` (results go to `reports/`).
