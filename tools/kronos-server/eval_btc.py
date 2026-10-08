"""Does Kronos-small know anything about where BTC goes next? An out-of-sample check.

Test period: BTCUSDT from 2025-09-01 to now. The Kronos paper is from August 2025, so the model has not seen it.
At non-overlapping origins (every `horizon` bars) Kronos reads the previous `context` bars and samples
`samples` future paths. Each forecast is scored on what really happened, against simple baselines:

  direction   sign of the median sampled return vs the real return, at several horizons
              baselines: always "up" (or "down", whichever was more common), and momentum
              (the sign of the last `h`-bar return)
  P(up)       share of paths that end up; Brier score vs the base rate (climatology)
  size        MAE of the median return vs predicting "no change"
  band        how often the real close falls inside the 10th-90th percentile of the paths (80% if calibrated)
  trading     long if the median path ends up, short if down, for `horizon` bars, 0.1% round-trip cost,
              vs buy-and-hold over the same windows

Usage:  .venv\\Scripts\\python.exe eval_btc.py --interval 1h --horizon 24 --samples 20
"""
import argparse
import json
import math
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import torch

from kronos_paths import binance_klines, sample_paths
from model import Kronos, KronosPredictor, KronosTokenizer

START = "2025-09-01"
COST = 0.001  # round trip


def wilson(k, n, z=1.96):
    if n == 0:
        return (float("nan"), float("nan"))
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (c - h, c + h)


def binom_p_greater(k, n, p0):
    """One-sided exact binomial p-value P(X >= k | n, p0)."""
    return float(sum(math.comb(n, i) * p0 ** i * (1 - p0) ** (n - i) for i in range(k, n + 1)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--symbol", default="BTCUSDT")
    ap.add_argument("--interval", default="1h")
    ap.add_argument("--context", type=int, default=400)
    ap.add_argument("--horizon", type=int, default=24)
    ap.add_argument("--samples", type=int, default=20)
    ap.add_argument("--model", default="NeoQuasar/Kronos-small")
    ap.add_argument("--top-p", type=float, default=0.9, help="nucleus sampling; 1.0 keeps the tails")
    ap.add_argument("--every", type=int, default=0, help="bars between origins (default: the horizon)")
    a = ap.parse_args()

    device = "cuda:0" if torch.cuda.is_available() else "cpu"
    start_ms = int(pd.Timestamp(START, tz="UTC").timestamp() * 1000)
    bar_s = {"15m": 900, "1h": 3600, "4h": 14400, "1d": 86400}[a.interval]
    df = binance_klines(a.symbol, a.interval, start_ms - a.context * bar_s * 1000)
    print(f"{len(df)} closed {a.interval} bars, {datetime.fromtimestamp(df.time.iloc[0], timezone.utc):%Y-%m-%d} "
          f"to {datetime.fromtimestamp(df.time.iloc[-1], timezone.utc):%Y-%m-%d}, device {device}")

    tok = KronosTokenizer.from_pretrained("NeoQuasar/Kronos-Tokenizer-base")
    pred = KronosPredictor(Kronos.from_pretrained(a.model), tok, device=device, max_context=512)

    ts = pd.to_datetime(df.time, unit="s")
    first = int(np.searchsorted(df.time.to_numpy(), start_ms // 1000))
    first = max(first, a.context)
    origins = list(range(first, len(df) - a.horizon, a.every or a.horizon))
    frames = [(df.iloc[o - a.context:o], ts.iloc[o - a.context:o], ts.iloc[o:o + a.horizon]) for o in origins]
    t0 = time.time()
    paths = sample_paths(pred, frames, a.horizon, a.samples, top_p=a.top_p, progress=True)  # (origins, samples, horizon, 5)
    secs = time.time() - t0
    print(f"{len(origins)} origins x {a.samples} paths x {a.horizon} bars in {secs:.0f}s")

    close = df.close.to_numpy()
    last = np.array([close[o - 1] for o in origins])
    checks = sorted({1, max(1, a.horizon // 4), a.horizon})
    res = {"symbol": a.symbol, "interval": a.interval, "model": a.model, "context": a.context, "horizon": a.horizon,
           "samples": a.samples, "topP": a.top_p, "origins": len(origins), "device": device, "seconds": round(secs),
           "testFrom": str(datetime.fromtimestamp(df.time.iloc[first], timezone.utc).date()),
           "testTo": str(datetime.fromtimestamp(df.time.iloc[-1], timezone.utc).date()), "byHorizon": {}}
    for h in checks:
        real = np.array([close[o + h - 1] for o in origins]) / last - 1
        samp = paths[:, :, h - 1, 3] / last[:, None] - 1
        med = np.median(samp, axis=1)
        p_up = (samp > 0).mean(axis=1)
        p10, p90 = np.percentile(samp, 10, axis=1), np.percentile(samp, 90, axis=1)
        n = len(real)
        up_rate = float((real > 0).mean())
        hits = int(((med > 0) == (real > 0)).sum())
        majority = max(up_rate, 1 - up_rate)
        mom = np.array([close[o - 1] / close[o - 1 - h] - 1 for o in origins])
        mom_hits = int(((mom > 0) == (real > 0)).sum())
        brier = float(np.mean((p_up - (real > 0)) ** 2))
        brier_clim = float(np.mean((up_rate - (real > 0)) ** 2))
        res["byHorizon"][str(h)] = {
            "n": n,
            "kronosHitRate": round(hits / n, 4),
            "kronosHitCI95": [round(x, 4) for x in wilson(hits, n)],
            "pValueVsMajority": round(binom_p_greater(hits, n, majority), 4),
            "majorityBaseline": round(majority, 4),
            "momentumHitRate": round(mom_hits / n, 4),
            "brier": round(brier, 5), "brierClimatology": round(brier_clim, 5),
            "maeKronos": round(float(np.mean(np.abs(med - real))), 5),
            "maeNoChange": round(float(np.mean(np.abs(real))), 5),
            "bandCoverage10to90": round(float(((real >= p10) & (real <= p90)).mean()), 4),
        }
    real_h = np.array([close[o + a.horizon - 1] for o in origins]) / last - 1
    med_h = np.median(paths[:, :, -1, 3] / last[:, None] - 1, axis=1)
    strat = np.sign(med_h) * real_h - COST * (med_h != 0)
    res["trading"] = {
        "windows": len(origins),
        "kronosLongShortTotalPct": round(float(np.prod(1 + strat) - 1) * 100, 2),
        "buyHoldTotalPct": round(float(np.prod(1 + real_h) - 1) * 100, 2),
        "kronosMeanPerWindowPct": round(float(strat.mean()) * 100, 4),
        "costRoundTripPct": COST * 100,
    }
    out = Path("reports")
    out.mkdir(exist_ok=True)
    name = f"btc_eval_{a.interval}_h{a.horizon}" + ("" if a.top_p == 0.9 else f"_topp{a.top_p:g}")
    (out / f"{name}.json").write_text(json.dumps(res, indent=2))
    print(json.dumps(res, indent=2))


if __name__ == "__main__":
    main()
