"""Local Kronos forecast server for StratForge.

Keeps Kronos loaded and answers forecast requests from the StratForge app running in the browser.
Binds to 127.0.0.1 only and answers CORS requests only from the StratForge origins listed below.

    .venv\\Scripts\\python.exe stratforge_server.py            # Kronos-small on CPU, port 8765
    .venv\\Scripts\\python.exe stratforge_server.py --model NeoQuasar/Kronos-mini --port 8765

GET  /health    -> {"ok": true, "model": ..., "maxContext": ...}
POST /forecast  {"candles": [{"time", "open", "high", "low", "close", "volume"}...], "predLen": 24, "samples": 20}
                -> {"model", "basedOnBars", "predLen", "samples", "device",
                    "forecast": [{"time", "open", "high", "low", "close", "volume"}...]   median of the sampled paths,
                    "band": [{"time", "p10", "p50", "p90"}...]                              close percentiles per bar,
                    "probUp": share of paths that end above the last close}
"""
import argparse
import json
import mimetypes
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pandas as pd

# The Kronos code (its `model` package) comes from https://github.com/shiyu-coder/Kronos.
# Run this file from inside that clone, or point KRONOS_DIR at it.
sys.path.insert(0, os.environ.get("KRONOS_DIR", os.path.dirname(os.path.abspath(__file__))))
from model import Kronos, KronosPredictor, KronosTokenizer  # noqa: E402
import numpy as np  # noqa: E402
import torch  # noqa: E402
from kronos_paths import sample_paths  # noqa: E402

ALLOWED_ORIGINS = {
    "https://limin-design.github.io",
    "http://127.0.0.1:8765",
    "http://localhost:8765",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "tauri://localhost",
    "http://tauri.localhost",
}
TOKENIZERS = {"NeoQuasar/Kronos-mini": "NeoQuasar/Kronos-Tokenizer-2k"}
MAX_PRED = 120
MAX_SAMPLES = 50


class Forecaster:
    def __init__(self, model_id: str, device: str):
        tok_id = TOKENIZERS.get(model_id, "NeoQuasar/Kronos-Tokenizer-base")
        self.model_id = model_id
        self.max_context = 2048 if model_id.endswith("mini") else 512
        self.device = device
        self.predictor = KronosPredictor(Kronos.from_pretrained(model_id), KronosTokenizer.from_pretrained(tok_id),
                                         device=device, max_context=self.max_context)
        self.lock = threading.Lock()  # one forecast at a time; the model is not re-entrant

    def forecast(self, candles: list, pred_len: int, samples: int) -> dict:
        df = pd.DataFrame(candles)[["time", "open", "high", "low", "close", "volume"]].astype(float)
        df = df.sort_values("time").drop_duplicates("time").tail(self.max_context)
        if len(df) < 32:
            raise ValueError(f"need at least 32 candles, got {len(df)}")
        step = int(df.time.diff().dropna().median())  # bar length in seconds
        x_ts = pd.Series(pd.to_datetime(df.time, unit="s"))
        last = int(df.time.iloc[-1])
        future = [last + step * (i + 1) for i in range(pred_len)]
        y_ts = pd.Series(pd.to_datetime(future, unit="s"))
        with self.lock:
            paths = sample_paths(self.predictor, [(df.reset_index(drop=True), x_ts.reset_index(drop=True), y_ts)],
                                 pred_len, samples)[0]  # (samples, pred_len, 5)
        med = np.median(paths, axis=0)
        p10, p50, p90 = np.percentile(paths[:, :, 3], [10, 50, 90], axis=0)
        r = lambda v: round(float(v), 6)  # noqa: E731
        rows = [{"time": t, **{k: r(med[i, j]) for j, k in enumerate(("open", "high", "low", "close", "volume"))}}
                for i, t in enumerate(future)]
        band = [{"time": t, "p10": r(p10[i]), "p50": r(p50[i]), "p90": r(p90[i])} for i, t in enumerate(future)]
        prob_up = float((paths[:, -1, 3] > df.close.iloc[-1]).mean())
        return {"model": self.model_id, "basedOnBars": len(df), "predLen": pred_len, "samples": samples,
                "device": self.device, "forecast": rows, "band": band, "probUp": round(prob_up, 3)}


def make_handler(fc: Forecaster, app_dir: str):
    app_root = os.path.realpath(app_dir)

    class Handler(BaseHTTPRequestHandler):
        def _cors(self):
            origin = self.headers.get("Origin", "")
            if origin in ALLOWED_ORIGINS:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")
                self.send_header("Access-Control-Allow-Headers", "Content-Type")
                self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
                # Chrome's Private Network Access: a public https page asking for 127.0.0.1.
                self.send_header("Access-Control-Allow-Private-Network", "true")

        def _json(self, code: int, body: dict):
            data = json.dumps(body).encode()
            self.send_response(code)
            self._cors()
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_OPTIONS(self):
            self.send_response(204)
            self._cors()
            self.end_headers()

        def _static(self):
            # Serve the StratForge build at /stratforge/ so the app and Kronos share one origin
            # (no browser prompt for local network access).
            rel = self.path.split("?", 1)[0][len("/stratforge"):].lstrip("/") or "index.html"
            full = os.path.realpath(os.path.join(app_root, rel))
            if not full.startswith(app_root + os.sep) or not os.path.isfile(full):
                return self._json(404, {"error": "not found"})
            with open(full, "rb") as f:
                data = f.read()
            self.send_response(200)
            self.send_header("Content-Type", mimetypes.guess_type(full)[0] or "application/octet-stream")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            path = self.path.split("?", 1)[0]
            if path.rstrip("/") == "/health":
                return self._json(200, {"ok": True, "model": fc.model_id, "maxContext": fc.max_context})
            if path in ("/", "/stratforge"):
                self.send_response(302)
                self.send_header("Location", "/stratforge/")
                self.end_headers()
                return
            if path.startswith("/stratforge/") and os.path.isdir(app_root):
                return self._static()
            self._json(404, {"error": "not found"})

        def do_POST(self):
            if self.path.rstrip("/") != "/forecast":
                return self._json(404, {"error": "not found"})
            try:
                n = int(self.headers.get("Content-Length", "0"))
                if n > 5_000_000:
                    return self._json(413, {"error": "request too large"})
                req = json.loads(self.rfile.read(n) or b"{}")
                pred_len = max(1, min(MAX_PRED, int(req.get("predLen", 24))))
                samples = max(1, min(MAX_SAMPLES, int(req.get("samples", 20))))
                t0 = time.time()
                res = fc.forecast(req.get("candles") or [], pred_len, samples)
                res["seconds"] = round(time.time() - t0, 1)
                self._json(200, res)
            except (ValueError, KeyError, TypeError) as e:
                self._json(400, {"error": str(e)})
            except Exception as e:  # noqa: BLE001 - report, keep serving
                self._json(500, {"error": f"{type(e).__name__}: {e}"})

        def log_message(self, fmt, *args):
            print(f"{self.address_string()} {fmt % args}")

    return Handler


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="NeoQuasar/Kronos-small")
    ap.add_argument("--device", default="cuda:0" if torch.cuda.is_available() else "cpu")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--app-dir", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "stratforge-app"),
                    help="a StratForge web build (vite build --base=/stratforge/) to serve at /stratforge/")
    a = ap.parse_args()
    fc = Forecaster(a.model, a.device)
    print(f"Kronos ready: {a.model} on {a.device}, http://127.0.0.1:{a.port}")
    if os.path.isdir(a.app_dir):
        print(f"StratForge with Kronos: http://127.0.0.1:{a.port}/stratforge/")
    ThreadingHTTPServer(("127.0.0.1", a.port), make_handler(fc, a.app_dir)).serve_forever()


if __name__ == "__main__":
    main()
