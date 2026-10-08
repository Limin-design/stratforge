// Client for the optional local Kronos server (tools/kronos-server/stratforge_server.py).
// Kronos is an open foundation model trained only on OHLCV candles; it runs on the user's
// machine and the browser talks to it over 127.0.0.1. Nothing leaves the computer.
import type { Candle } from "@stratforge/engine";

const URL_KEY = "stratforge.kronosUrl";
const DEFAULT_URL = "http://127.0.0.1:8765";

export interface BandPoint {
  time: number;
  p10: number;
  p50: number;
  p90: number;
}

export interface KronosForecast {
  model: string;
  basedOnBars: number;
  predLen: number;
  samples: number;
  device?: string;
  seconds?: number;
  forecast: Candle[]; // median of the sampled paths
  band?: BandPoint[]; // close percentiles across the paths, per bar
  probUp?: number; // share of paths that end above the last close
}

export function kronosUrl(): string {
  // Served by the Kronos server itself (http://127.0.0.1:8765/stratforge/): same origin, no local-network prompt.
  if (typeof location !== "undefined" && location.port === "8765" && /^(127\.0\.0\.1|localhost)$/.test(location.hostname)) {
    return location.origin;
  }
  try {
    return localStorage.getItem(URL_KEY) || DEFAULT_URL;
  } catch {
    return DEFAULT_URL;
  }
}

export async function kronosHealth(): Promise<{ ok: boolean; model?: string }> {
  try {
    const r = await fetch(`${kronosUrl()}/health`, { signal: AbortSignal.timeout(2500) });
    return r.ok ? ((await r.json()) as { ok: boolean; model?: string }) : { ok: false };
  } catch {
    return { ok: false };
  }
}

/** Ask Kronos for the next `predLen` bars after `candles` (the last 512 are used). */
export async function kronosForecast(candles: Candle[], predLen = 24, samples = 20): Promise<KronosForecast> {
  let r: Response;
  try {
    r = await fetch(`${kronosUrl()}/forecast`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ candles: candles.slice(-512), predLen, samples }),
      signal: AbortSignal.timeout(180_000),
    });
  } catch {
    throw new Error(
      `not reachable at ${kronosUrl()}. Start the local server (tools/kronos-server) and open StratForge from it at http://127.0.0.1:8765/stratforge/`
    );
  }
  const body = (await r.json().catch(() => ({}))) as KronosForecast & { error?: string };
  if (!r.ok) throw new Error(body.error ?? `Kronos server error ${r.status}`);
  return body;
}

// The latest forecast is shared so the chart draws it whether the user or the analyst asked for it.
export interface PublishedForecast extends KronosForecast {
  dataset: string;
  workspaceId: string;
}
const forecastListeners = new Set<(f: PublishedForecast) => void>();
export function publishForecast(f: PublishedForecast): void {
  for (const l of forecastListeners) l(f);
}
export function onForecast(l: (f: PublishedForecast) => void): () => void {
  forecastListeners.add(l);
  return () => forecastListeners.delete(l);
}
