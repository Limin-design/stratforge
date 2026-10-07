import type { StrategySpec } from "@stratforge/dsl";
import { computeIndicator, primaryLine } from "./indicators.js";
import { evalCondition } from "./conditions.js";
import { classifyRegimes } from "./regimes.js";
import { computeStats } from "./stats.js";
import type { BacktestResult, Candle, TimelinePoint, Trade } from "./types.js";

export interface BacktestOptions {
  initialCapital?: number; // default 10_000
  feePct?: number; // taker fee per side, % (e.g. 0.1 Binance spot). default 0.1
  slippagePct?: number; // adverse price move per fill, % (e.g. 0.05). default 0
  spreadPct?: number; // bid/ask spread, % — half charged on each side. default 0
  carryCostAnnualPct?: number; // annual holding cost (borrow/funding), per bar held. default 0
  /** External factor series, aligned 1:1 to candles, referenced by `factor` operands. */
  factors?: Record<string, number[]>;
}

const SECONDS_PER_YEAR = 365.25 * 24 * 3600;

function hasRegimeCondition(spec: StrategySpec): boolean {
  return [...spec.entry, ...(spec.exit ?? [])].some((c) => "kind" in c && c.kind === "regime");
}

/**
 * Long-only bar-by-bar backtest.
 * Signals are evaluated on bar close; fills happen at the NEXT bar's open
 * (no look-ahead bias). Stop-loss / take-profit are checked intrabar against
 * high/low, stop first (conservative). Fills include slippage + half the
 * spread, and holding a position incurs an optional carry/borrow cost.
 */
export function runBacktest(
  spec: StrategySpec,
  candles: Candle[],
  opts: BacktestOptions = {}
): BacktestResult {
  const initialCapital = opts.initialCapital ?? 10_000;
  const fee = (opts.feePct ?? 0.1) / 100;
  const slip = (opts.slippagePct ?? 0) / 100;
  const halfSpread = (opts.spreadPct ?? 0) / 100 / 2;
  const carryRate = (opts.carryCostAnnualPct ?? 0) / 100;
  const factors = opts.factors ?? {};
  // Adverse fills: buys pay up, sells receive less (slippage + half the spread).
  const buyFill = (price: number) => price * (1 + slip + halfSpread);
  const sellFill = (price: number) => price * (1 - slip - halfSpread);
  // Bar duration (seconds) to pro-rate carry; falls back to the first interval at bar 0.
  const firstBarDt = candles.length > 1 ? candles[1].time - candles[0].time : 0;

  const indicatorSeries: Record<string, Record<string, number[]>> = {};
  const idDefaultLine: Record<string, string> = {};
  for (const ind of spec.indicators) {
    indicatorSeries[ind.id] = computeIndicator(ind, candles);
    idDefaultLine[ind.id] = primaryLine(ind);
  }
  const regimes = hasRegimeCondition(spec) ? classifyRegimes(candles) : undefined;

  let cash = initialCapital;
  let position = 0; // units held
  let entryPrice = 0;
  let entryBar = -1;
  let pendingEntry = false;
  let pendingExit: Trade["exitReason"] | null = null;

  const trades: Trade[] = [];
  const timeline: TimelinePoint[] = [];
  let peakEquity = initialCapital;

  // `refPrice` is the price level reached (e.g. the stop/target); the actual
  // fill is worse by slippage + half-spread — stops do NOT fill at the stop.
  const closeTrade = (bar: number, refPrice: number, reason: Trade["exitReason"]) => {
    const exitPrice = sellFill(refPrice);
    const proceeds = position * exitPrice * (1 - fee);
    const cost = position * entryPrice * (1 + fee);
    trades.push({
      entryBar,
      exitBar: bar,
      entryTime: candles[entryBar].time,
      exitTime: candles[bar].time,
      entryPrice,
      exitPrice,
      size: position,
      pnl: proceeds - cost,
      pnlPct: ((proceeds - cost) / cost) * 100,
      exitReason: reason,
    });
    cash += proceeds;
    position = 0;
  };

  for (let bar = 0; bar < candles.length; bar++) {
    const c = candles[bar];

    // 1. Execute orders queued on the previous bar's close, at this bar's open.
    if (pendingExit && position > 0) {
      closeTrade(bar, c.open, pendingExit);
    }
    pendingExit = null;
    if (pendingEntry && position === 0) {
      const alloc = cash * (spec.risk.positionSizePct / 100);
      const fill = buyFill(c.open);
      position = alloc / (fill * (1 + fee));
      cash -= alloc;
      entryPrice = fill;
      entryBar = bar;
    }
    pendingEntry = false;

    // 2. Intrabar risk exits (stop checked before target — conservative).
    if (position > 0 && spec.risk.stopLossPct !== undefined) {
      const stop = entryPrice * (1 - spec.risk.stopLossPct / 100);
      if (c.low <= stop) closeTrade(bar, stop, "stopLoss");
    }
    if (position > 0 && spec.risk.takeProfitPct !== undefined) {
      const target = entryPrice * (1 + spec.risk.takeProfitPct / 100);
      if (c.high >= target) closeTrade(bar, target, "takeProfit");
    }

    // 3. Evaluate signals on this bar's close → queue for next bar's open.
    if (position === 0) {
      if (spec.entry.every((cond) => evalCondition(cond, bar, candles, indicatorSeries, idDefaultLine, factors, regimes))) {
        pendingEntry = true;
      }
    } else if (spec.exit && spec.exit.length > 0) {
      if (spec.exit.every((cond) => evalCondition(cond, bar, candles, indicatorSeries, idDefaultLine, factors, regimes))) {
        pendingExit = "signal";
      }
    }

    // 4. Carry/borrow/funding cost for holding through this bar, then record.
    if (position > 0 && carryRate > 0) {
      const dt = bar > 0 ? c.time - candles[bar - 1].time : firstBarDt;
      cash -= position * c.close * carryRate * (dt / SECONDS_PER_YEAR);
    }
    const equity = cash + position * c.close;
    peakEquity = Math.max(peakEquity, equity);
    timeline.push({
      time: c.time,
      equity,
      position,
      drawdownPct: peakEquity > 0 ? ((peakEquity - equity) / peakEquity) * 100 : 0,
    });
  }

  // Force-close any open position on the last bar for clean accounting.
  if (position > 0) {
    closeTrade(candles.length - 1, candles[candles.length - 1].close, "endOfData");
    const last = timeline[timeline.length - 1];
    last.equity = cash;
    last.position = 0;
  }

  return {
    stats: computeStats(trades, timeline, initialCapital),
    trades,
    timeline,
    indicatorSeries,
  };
}
