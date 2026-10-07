/** Internal normalized OHLCV bar. `time` = unix seconds (UTC). */
export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Trade {
  entryBar: number;
  exitBar: number;
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  /** Units of the asset held */
  size: number;
  pnl: number;
  pnlPct: number;
  exitReason: "signal" | "stopLoss" | "takeProfit" | "endOfData";
}

/** One row per bar — powers chart replay, equity pane, and trade inspection. */
export interface TimelinePoint {
  time: number;
  equity: number;
  position: number; // units held (0 = flat)
  drawdownPct: number;
}

export interface BacktestStats {
  totalReturnPct: number;
  /** Compound annual growth rate (%), annualized from the candle timeframe. */
  cagrPct: number;
  winRate: number;
  trades: number;
  maxDrawdownPct: number;
  /** Longest stretch spent below the prior equity peak, in bars. */
  maxDrawdownDurationBars: number;
  profitFactor: number;
  /** Mean per-bar Sharpe (rf = 0); see annualizedSharpe for the comparable figure. */
  sharpe: number;
  /** Sharpe annualized by the inferred number of bars per year. */
  annualizedSharpe: number;
  /** Downside-risk-adjusted return (annualized; only negative returns penalized). */
  sortino: number;
  /** CAGR / max drawdown. */
  calmar: number;
  /** % of bars holding a position (time in market). */
  exposurePct: number;
  /** Mean profit/loss per trade, in account currency. */
  expectancy: number;
  /** Same as winRate, named explicitly for EV-first displays. */
  winProbability: number;
  /** Mean winning trade PnL, in account currency. */
  avgWin: number;
  /** Mean losing trade PnL as an absolute value, in account currency. */
  avgLoss: number;
  /** Expectancy normalized by initial capital, in percent per trade. */
  expectancyPct: number;
  /** Average winning trade PnL / average losing trade PnL (absolute). */
  payoffRatio: number;
}

export interface BacktestResult {
  stats: BacktestStats;
  trades: Trade[];
  timeline: TimelinePoint[];
  /**
   * Computed indicator output keyed by indicator id, then by line name
   * (e.g. indicatorSeries["macd_1"]["signal"]). Aligned to candles; NaN until warm.
   */
  indicatorSeries: Record<string, Record<string, number[]>>;
}
