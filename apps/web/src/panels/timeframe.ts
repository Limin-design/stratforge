// Timeframe switcher for the chart toolbar: reloads the current pair from the same
// public exchange at another candle interval, through the same fetch + cleaning path
// as the Data tab. Keyed vendors and file imports are left to the Data tab.
import { validateCandles } from "@stratforge/data-import";
import { getActiveWorkspaceId, setState } from "../store.js";
import { recordDataset } from "../usage.js";
import { resetTrialCounters } from "../agent/tools.js";
import { CRYPTO_EXCHANGES, DATA_INTERVALS, IV, fetchKlines, type Exchange } from "./dataSources.js";

export interface DatasetRef {
  symbol: string;
  interval: string;
  exchange: Exchange;
}

/** Parse a dataset name written by the Data tab or load_data: "BTCUSDT 1h · Binance". */
export function parseDatasetName(name: string): DatasetRef | null {
  const m = /^(\S+) (\S+) · (.+)$/.exec(name.trim());
  if (!m) return null;
  const [, symbol, interval, exchange] = m;
  if (!(DATA_INTERVALS as readonly string[]).includes(interval)) return null;
  if (!(CRYPTO_EXCHANGES as readonly string[]).includes(exchange)) return null;
  return { symbol, interval, exchange: exchange as Exchange };
}

// With nothing loaded yet, a timeframe click starts on a liquid default pair.
const NO_DATASET = "(no dataset)";
const DEFAULT_PAIR: Omit<DatasetRef, "interval"> = { symbol: "BTCUSDT", exchange: "Binance" };

function resolve(name: string): Omit<DatasetRef, "interval"> | null {
  return parseDatasetName(name) ?? (name === NO_DATASET ? DEFAULT_PAIR : null);
}

/** Intervals the dataset's exchange offers; empty when the dataset can't be reloaded here. */
export function switchableIntervals(name: string): string[] {
  const ref = resolve(name);
  if (!ref) return [];
  return DATA_INTERVALS.filter((iv) => IV[ref.exchange][iv] != null);
}

let loadSeq = 0;

/** Reload the active workspace's dataset at `interval`. Resolves to a status line. */
export async function switchTimeframe(name: string, interval: string): Promise<string> {
  const ref = resolve(name);
  if (!ref) return "load a crypto pair in the Data tab to switch timeframe";
  if (IV[ref.exchange][interval] == null) return `${ref.exchange} doesn't offer the ${interval} timeframe`;
  const workspaceId = getActiveWorkspaceId();
  const seq = ++loadSeq;
  const { candles, report } = validateCandles(await fetchKlines(ref.exchange, ref.symbol, interval, ""));
  if (seq !== loadSeq) return "";
  if (candles.length === 0) return `no ${interval} bars returned for ${ref.symbol}`;
  // Same reset as a manual load: a new dataset clears the old result and testing counters.
  setState({ candles, datasetName: `${ref.symbol} ${interval} · ${ref.exchange}`, result: null, customStats: [], optimization: null }, workspaceId);
  resetTrialCounters(workspaceId);
  recordDataset(report.bars);
  return `loaded ${report.bars} × ${interval} bars — run the backtest again`;
}
