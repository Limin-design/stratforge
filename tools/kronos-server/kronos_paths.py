"""Individual Kronos sample paths, plus a small Binance loader, shared by the StratForge server and the evaluation.

KronosPredictor averages its samples internally. To keep each path, the same series is put in the batch n times with
sample_count=1: every row is sampled independently, so n rows are n paths. Several series (for example several
forecast origins in a backtest) can share one batch as long as they have the same length.
"""
import json
import time
import urllib.request

import numpy as np
import pandas as pd

COLS = ["open", "high", "low", "close", "volume"]


def sample_paths(predictor, frames, pred_len, n_samples, T=1.0, top_p=0.9, max_batch=64, progress=False):
    """frames: list of (df with COLS, x_timestamps, y_timestamps). Returns an array (len(frames), n_samples, pred_len, 5)."""
    jobs = [(i, f) for i, f in enumerate(frames) for _ in range(n_samples)]
    out = np.empty((len(frames), n_samples, pred_len, len(COLS)), dtype=np.float64)
    filled = [0] * len(frames)
    for start in range(0, len(jobs), max_batch):
        chunk = jobs[start:start + max_batch]
        preds = predictor.predict_batch(
            df_list=[f[0][COLS].reset_index(drop=True) for _, f in chunk],
            x_timestamp_list=[pd.Series(f[1]).reset_index(drop=True) for _, f in chunk],
            y_timestamp_list=[pd.Series(f[2]).reset_index(drop=True) for _, f in chunk],
            pred_len=pred_len, T=T, top_p=top_p, sample_count=1, verbose=False)
        for (i, _), p in zip(chunk, preds):
            out[i, filled[i]] = p[COLS].to_numpy()
            filled[i] += 1
        if progress:
            print(f"  {min(start + max_batch, len(jobs))}/{len(jobs)} paths", flush=True)
    return out


def binance_klines(symbol, interval, start_ms, end_ms=None):
    """All klines in [start_ms, end_ms) from Binance's public market-data API, as a DataFrame with time in seconds."""
    rows, cursor = [], start_ms
    end_ms = end_ms or int(time.time() * 1000)
    while cursor < end_ms:
        url = (f"https://data-api.binance.vision/api/v3/klines?symbol={symbol}&interval={interval}"
               f"&startTime={cursor}&endTime={end_ms}&limit=1000")
        batch = json.load(urllib.request.urlopen(url, timeout=30))
        if not batch:
            break
        rows += batch
        cursor = batch[-1][0] + 1
        time.sleep(0.2)
    df = pd.DataFrame([[r[0] // 1000, *map(float, r[1:6]), r[6]] for r in rows],
                      columns=["time", *COLS, "close_time"])
    df = df.drop_duplicates("time").sort_values("time").reset_index(drop=True)
    return df[df.close_time < end_ms].drop(columns="close_time").reset_index(drop=True)  # closed bars only
