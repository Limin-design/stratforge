/**
 * The tools the agent can call. Each is the bridge between the LLM (which
 * reasons) and the deterministic engine (which computes). The model never does
 * math — it calls these, which run vetted, unit-tested code.
 */
import { INDICATOR_LINES, parseStrategy } from "@stratforge/dsl";
import type { StrategySpec } from "@stratforge/dsl";
import {
  analyzeEntryEvents,
  analyzeRegimes,
  assessCorrelation,
  assessRobustness,
  buildIndicatorContext,
  buyAndHoldStats,
  cusumEvents,
  DEFAULT_PROP_FIRM_RULESET,
  factorFromCsv,
  featureAttribution,
  featureSeries,
  DEFAULT_FEATURE_SPECS,
  outcomeReport,
  tripleBarrier,
  regimeAwareMonteCarlo,
  relativeVerdict,
  robustnessVerdict,
  runBacktest,
  simulatePropFirm,
  triggerEventBars,
  trimLeadingNaN,
} from "@stratforge/engine";
import { validateCandles } from "@stratforge/data-import";
import { addCustomStat, getActiveWorkspaceId, getState, setState, type WorkspaceId } from "../store.js";
import { runOptimization, summarizeOptimization } from "../panels/strategyOptimize.js";
import { fetchKlines, validateLoadRequest } from "../panels/dataSources.js";
import { recordDataset } from "../usage.js";

const SECONDS_PER_YEAR = 365.25 * 24 * 3600;

export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** OpenAI-compatible tool definitions advertised to the model. */
export const TOOL_DEFS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "get_context",
      description:
        "Get the currently loaded dataset (instrument, bar count, date range) and the list of indicators you may use with their parameters. Call this first so you never reference data or indicators that don't exist.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "backtest_and_validate",
      description:
        "Validate a strategy (StrategySpec JSON DSL), backtest it on the loaded dataset with realistic costs, and run the full robustness battery (Deflated Sharpe, Monte Carlo permutation, out-of-sample, walk-forward). Returns performance stats, a buy-and-hold benchmark comparison (beatsBuyHold + excess return/Sharpe), AND an honest robustness verdict with warnings. This is your main tool — propose a spec, call this, read the verdict honestly. If the strategy does not beat buy-and-hold of the same asset over the same window, say that first.",
      parameters: {
        type: "object",
        properties: {
          strategy: {
            type: "object",
            description:
              "A StrategySpec. Required event-first shape: { name, indicators:[{id,type,params}], process:{ thesis, trigger:[conditions], context?:[conditions], outcome?:{horizonBars}}, entry:[...trigger,...context], exit?:[conditions], risk:{positionSizePct, stopLossPct?, takeProfitPct?} }. Comparison conditions are { left, op, right } where op ∈ crossesAbove|crossesBelow|greaterThan|lessThan and operands are {kind:'indicator',id,line?} | {kind:'price',source} | {kind:'value',value} | {kind:'factor',id}. Regime context filters are {kind:'regime', axis:'trend', in:['up'|'down'|'range']} or {kind:'regime', axis:'volatility', in:['low'|'normal'|'high']}. The process trigger is the sampled event; context filters explain when that event is allowed. Do not submit indicator-only strategies without a thesis and event trigger. The trigger MUST include at least one crossing condition (crossesAbove/crossesBelow) — threshold-only triggers (greaterThan/lessThan) are rejected because they describe a state, not an event; put thresholds and regime filters in process.context. Call get_context first for the full input contract (indicators, operand kinds, condition ops, trigger rule).",
          },
          notes: {
            type: "string",
            description: "Optional one-line note on what you're testing and why.",
          },
        },
        required: ["strategy"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "load_data",
      description:
        "Load OHLCV candles for an instrument from a public crypto exchange (no API key needed) into the active workspace, so you can then backtest, optimize, or correlate on it. Supports Binance, Bybit, OKX, Coinbase. Keyed vendors (stocks/forex via Twelve Data/Polygon) and file imports (CSV/MT5) are user-only — you cannot load those; ask the user to load them in the Data tab. Loading REPLACES the current dataset and resets the session trial counters (a fresh dataset is a fresh testing context).",
      parameters: {
        type: "object",
        properties: {
          exchange: {
            type: "string",
            description: "Public crypto exchange to fetch from. Default Binance.",
            enum: ["Binance", "Bybit", "OKX", "Coinbase"],
          },
          symbol: {
            type: "string",
            description: "The trading pair, e.g. BTCUSDT or ETHUSDT (Binance/Bybit style). Uppercased automatically.",
          },
          interval: {
            type: "string",
            description: "Timeframe. Default 1h. Note: Coinbase does not offer 4h or 1w.",
            enum: ["1m", "5m", "15m", "1h", "4h", "1d", "1w"],
          },
        },
        required: ["symbol"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "optimize_strategy",
      description:
        "Walk-forward optimize a strategy's numeric parameters HONESTLY: for each rolling window it re-fits the best params on PRIOR data only, measures them out-of-sample, then deflates the result by the total number of grid trials. Use this instead of eyeballing or hand-tuning parameters. Returns an OOS Sharpe, a Deflated Sharpe over all trials, per-window best params, and a plain verdict (overfit | weak | robust). WARNING: a parameter grid IS multiple testing — every combination counts against the session trial count and raises the deflation bar for ALL later results, so keep grids small and justified.",
      parameters: {
        type: "object",
        properties: {
          strategy: {
            type: "object",
            description:
              "The base StrategySpec (same shape as backtest_and_validate). Its numeric fields are the optimization targets.",
          },
          grid: {
            type: "object",
            description:
              "The parameter sweep: a map of address → array of values to try. Indicator params use 'ind:<indicatorId>:<paramKey>' (e.g. 'ind:fast:period'); risk params use 'risk:<field>' where field ∈ positionSizePct|stopLossPct|takeProfitPct. Example: { \"ind:fast:period\": [5,10,20], \"ind:slow:period\": [30,50] }. Only existing numeric params are valid addresses.",
          },
          windows: {
            type: "number",
            description: "Number of anchored walk-forward windows (2–8, default 4). More windows is more honest but needs more data.",
          },
        },
        required: ["strategy", "grid"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "assess_regimes",
      description:
        "Break down the MOST RECENT backtest's performance by market regime (trend direction × volatility bucket) and attribute each trade to the regime at its entry. Use this to check whether an 'edge' is real or just an artifact of one regime: it returns per-regime win rate, PnL, and PnL share, plus honest warnings when profits or losses are concentrated in a single regime. Run backtest_and_validate first — this reads that result and does not re-run or count as a new trial.",
      parameters: {
        type: "object",
        properties: {
          trendThreshold: {
            type: "number",
            description: "ADX level above which a bar counts as trending (else 'range'). Default 25.",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "assess_outcomes",
      description:
        "Label what happens after the current strategy's TRIGGER event using a triple barrier (ATR-based take-profit / stop-loss / time barrier), and report expected value per event with a bootstrap 95% confidence interval — versus a random-entry baseline and the market's drift over the same horizon, plus a first-half/second-half stability check. This is the 'edge or luck?' test at the event level. Run backtest_and_validate first so there is a trigger. Key reads: expectancy.excludesZero (CI entirely above/below 0 = a real signed edge), whether expectancy.ev beats baseline.driftPct, and whether the first-half edge survives into the second half.",
      parameters: {
        type: "object",
        properties: {
          tpAtrMult: { type: "number", description: "Take-profit distance in ATRs. Default 2." },
          slAtrMult: { type: "number", description: "Stop-loss distance in ATRs. Default 2." },
          maxHoldBars: { type: "number", description: "Time-barrier horizon in bars. Default 20." },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "assess_correlation",
      description:
        "Test whether an external time series (oil supply, FX, births, prediction-market odds, …) is really correlated with the instrument's price — or whether it's a coincidence, a shared trend, or a multiple-testing artifact. Returns a verdict (real | weak | likely-spurious | insufficient-data) with reasons. Use this for any cross-domain factor idea.",
      parameters: {
        type: "object",
        properties: {
          factorCsv: {
            type: "string",
            description:
              "The external series as CSV: 'date,value' or 'epoch,value' per line (or bare values one per line).",
          },
        },
        required: ["factorCsv"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "assess_feature",
      description:
        "Pre-strategy feature validation. Builds declarative market features (return %, SMA slope %, RSI, z-score, volume z-score), samples CUSUM events, labels forward outcomes with triple barriers, and reports whether each feature is defensibly related to forward returns using the anti-spurious correlation verdict. Use this BEFORE proposing a strategy when testing whether an idea has predictive power.",
      parameters: {
        type: "object",
        properties: {
          features: {
            type: "array",
            description:
              "Optional feature specs. Defaults to a small built-in set. Each item: {id,label,valueType:'continuous'|'binary'|'ordinal',kind:'returnPct'|'smaSlopePct'|'rsi'|'zscoreClose'|'volumeZscore'|'cusumDirection', window?, period?, lag?, atrMult?}.",
          },
          atrMult: { type: "number", description: "CUSUM event threshold in ATR multiples. Default 1.5. Lower = more events." },
          tpAtrMult: { type: "number", description: "Triple-barrier take-profit distance in ATRs. Default 2." },
          slAtrMult: { type: "number", description: "Triple-barrier stop-loss distance in ATRs. Default 2." },
          maxHoldBars: { type: "number", description: "Triple-barrier time horizon. Default 20 bars." },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "assess_prop_firm",
      description:
        "Run a deterministic prop-firm challenge/funded-account simulation on the MOST RECENT backtest trades. Returns pass probability, fail/timeout buckets, expected challenges/days, first-payout EV, net EV after fees, and payoff geometry. Use this only after validating the strategy; prop pass odds exploit convex payout/risk rules and are not proof of live edge.",
      parameters: {
        type: "object",
        properties: {
          startingBalance: { type: "number", description: "Challenge account balance. Default 50000." },
          profitTargetPct: { type: "number", description: "Profit target percent. Default 8." },
          maxDrawdownPct: { type: "number", description: "Maximum drawdown percent. Default 6." },
          trailing: { type: "boolean", description: "Whether max drawdown trails the high-water mark. Default true." },
          dailyDrawdownPct: { type: "number", description: "Optional daily drawdown limit percent. Default 3." },
          challengeFee: { type: "number", description: "Challenge fee. Default 150." },
          activationFee: { type: "number", description: "Optional activation fee. Default 0." },
          profitSplitPct: { type: "number", description: "Trader payout share percent. Default 80." },
          payoutCadenceDays: { type: "number", description: "Days to first payout after funding. Default 14." },
          maxTradingDays: { type: "number", description: "Challenge timeout in trading days. Default 30." },
          regimeAware: { type: "boolean", description: "If true, sample trades through a Markov chain of entry regimes instead of IID bootstrap. Default true." },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_stat",
      description:
        "Post a custom statistic or test result to the user's Strategy Stats tab so it stays visible alongside the standard metrics. Use this when the user asks for a specific test that isn't in the standard battery (e.g. a tail ratio, a CVaR, a seasonality stat, a custom Sharpe variant, a prop-firm pass estimate). Compute the value first (via backtest_and_validate or by reasoning over returned stats), then label it clearly. Never fabricate a number — only post what you actually computed.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Short label for the stat, e.g. 'Tail ratio (95/5)' or 'CVaR 5%'." },
          value: { type: "string", description: "The computed value as a display string, e.g. '1.84' or '-3.2%'." },
        },
        required: ["name", "value"],
      },
    },
  },
];

interface TrialCounters {
  backtestTrials: number;
  correlationHypotheses: number;
}

const counters = new Map<WorkspaceId, TrialCounters>();

function workspaceCounters(workspaceId: WorkspaceId): TrialCounters {
  const existing = counters.get(workspaceId);
  if (existing) return existing;
  const fresh: TrialCounters = { backtestTrials: 0, correlationHypotheses: 0 };
  counters.set(workspaceId, fresh);
  return fresh;
}

function isoDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

function eventDesignWarnings(spec: StrategySpec): string[] {
  const warnings: string[] = [];
  const trigger = spec.process?.trigger ?? spec.entry;
  const hasCrossTrigger = trigger.some((c) => "op" in c && (c.op === "crossesAbove" || c.op === "crossesBelow"));
  if (!spec.process?.thesis?.trim()) {
    warnings.push("No event thesis stated. This is indicator hunting, not a research process.");
  }
  if (!hasCrossTrigger) {
    warnings.push("Entry design has no crossing/event trigger. Threshold-only entries can stay true across many bars; treat them as regime filters plus an explicit event trigger, not a complete strategy.");
  }
  if ((spec.process?.context.length ?? 0) === 0) {
    warnings.push("No contextual filters. Test regimes/time/volatility context before trusting this event.");
  }
  if (!spec.risk.stopLossPct) {
    warnings.push("No stop-loss defined. This backtest can hide tail risk and gap risk.");
  }
  return warnings;
}

/**
 * Hard rule (mirrors the Strategy builder): a process trigger MUST contain at least one
 * crossing event. Returns an actionable error the model can self-correct from, or null.
 */
function requireEventTrigger(spec: StrategySpec): string | null {
  const trigger = spec.process?.trigger?.length ? spec.process.trigger : spec.entry;
  const hasCross = trigger.some((c) => "op" in c && (c.op === "crossesAbove" || c.op === "crossesBelow"));
  if (hasCross) return null;
  return (
    "Invalid event trigger: it must include at least one CROSSING condition (crossesAbove or crossesBelow). " +
    "A threshold like 'rsi lessThan 35' or 'price lessThan bb.lower' stays true across many consecutive bars — that's a STATE, not an event, so it samples noise rather than a decision point. " +
    "Fix: keep thresholds as process.context filters and use a crossing as the trigger — e.g. trigger 'price crossesBelow bb.lower' (the break) or 'rsi crossesBelow 35', with 'rsi lessThan 50' as context. Then resubmit."
  );
}

export interface ToolExecContext {
  workspaceId?: WorkspaceId;
}

/** Execute a tool call and return a JSON-serializable result for the model. */
export async function executeTool(name: string, args: Record<string, unknown>, ctx?: ToolExecContext): Promise<unknown> {
  const workspaceId = ctx?.workspaceId ?? getActiveWorkspaceId();
  const trials = workspaceCounters(workspaceId);

  switch (name) {
    case "get_context": {
      const { candles, datasetName } = getState(workspaceId);
      const indicators = Object.fromEntries(
        Object.entries(INDICATOR_LINES).map(([type, lines]) => [type, { lines }])
      );
      return {
        dataset: datasetName,
        bars: candles.length,
        range:
          candles.length > 0
            ? { from: isoDate(candles[0].time), to: isoDate(candles[candles.length - 1].time) }
            : null,
        indicatorsAvailable: indicators,
        // The full input contract for a StrategySpec, so specs are valid on the first try.
        conditionOps: ["crossesAbove", "crossesBelow", "greaterThan", "lessThan"],
        operandKinds: {
          indicator: "{ kind:'indicator', id, line? } — references an indicator you declared in indicators[]; line is optional and defaults to that indicator's primary line",
          price: "{ kind:'price', source } — source ∈ open|high|low|close",
          value: "{ kind:'value', value } — a constant number",
          factor: "{ kind:'factor', id } — an external aligned series (rare)",
        },
        regimeCondition:
          "Use only in process.context/entry as a filter: {kind:'regime', axis:'trend', in:['up'|'down'|'range']} or {kind:'regime', axis:'volatility', in:['low'|'normal'|'high']}. Regime is evaluated at bar close from the same classifier used by assess_regimes; it is not a trigger.",
        triggerRule:
          "process.trigger MUST contain at least one crossing condition (crossesAbove or crossesBelow). A threshold (greaterThan/lessThan) stays true across many bars — it is a STATE, so put thresholds in process.context and use a crossing as the event. backtest_and_validate and optimize_strategy reject a threshold-only trigger.",
        riskConstraints: "risk.positionSizePct must be in (0,100]; stopLossPct / takeProfitPct are optional positive percents. Always include a stopLossPct unless the user opts out.",
        note:
          candles.length === 0
            ? "No dataset loaded — tell the user to load data in the data-hub tab before backtesting."
            : "Use only these indicator types and output lines. Follow triggerRule and operandKinds exactly so the spec validates on the first submission.",
      };
    }

    case "backtest_and_validate": {
      const { candles } = getState(workspaceId);
      if (candles.length === 0) {
        return { error: "No dataset loaded. Ask the user to load data in the data-hub tab first." };
      }
      let spec;
      try {
        spec = parseStrategy(args.strategy);
      } catch (e) {
        return { error: `Invalid strategy: ${e instanceof Error ? e.message : String(e)}` };
      }
      const triggerError = requireEventTrigger(spec);
      if (triggerError) return { error: triggerError };
      const result = runBacktest(spec, candles, {
        initialCapital: 10_000,
        feePct: 0.1,
        slippagePct: 0.05,
      });
      setState({ result, spec }, workspaceId); // updates the chart (indicators + R:R box) + strategy panel live
      trials.backtestTrials += 1;
      const dt = candles.length > 1 ? candles[1].time - candles[0].time : 3600;
      const robustness = assessRobustness(result.timeline, candles, {
        trials: trials.backtestTrials,
        periodsPerYear: SECONDS_PER_YEAR / dt,
        iterations: 500,
        trades: result.trades,
        initialCapital: 10_000,
      });
      const entryDiagnostics = analyzeEntryEvents(result.trades, candles.length);
      const benchmark = buyAndHoldStats(candles);
      const benchmarkVerdict = relativeVerdict(result.stats, benchmark);
      const regimeAnalysis = result.trades.length > 0 ? analyzeRegimes(candles, result.trades) : null;
      let eventOutcomes = null;
      const conds = spec.process?.trigger?.length ? spec.process.trigger : spec.entry;
      const indicatorCtx = buildIndicatorContext(spec, candles);
      const eventBars = triggerEventBars(conds, candles, indicatorCtx);
      if (eventBars.length > 0) eventOutcomes = outcomeReport(candles, eventBars, { iterations: 500 });
      const verdict = robustnessVerdict({
        robustness,
        benchmark: benchmarkVerdict,
        outcomeReport: eventOutcomes,
        regimeAnalysis,
      });
      const warnings = [
        ...verdict.caveats,
        ...robustness.warnings,
        ...entryDiagnostics.warnings,
        ...(eventOutcomes?.warnings ?? []),
        ...(regimeAnalysis?.warnings ?? []),
        ...eventDesignWarnings(spec),
        ...(benchmarkVerdict.beatsBuyHold ? [] : [benchmarkVerdict.note]),
        "Retest on fresh data before risking capital. This result is still in-sample until proven otherwise.",
      ];
      return {
        stats: result.stats,
        benchmark: {
          buyAndHold: benchmark,
          beatsBuyHold: benchmarkVerdict.beatsBuyHold,
          excessReturnPct: benchmarkVerdict.excessReturnPct,
          excessSharpe: benchmarkVerdict.excessSharpe,
          note: benchmarkVerdict.note,
        },
        verdict,
        robustness: {
          probabilisticSharpe: robustness.sharpe.probabilisticSharpe,
          deflatedSharpe: robustness.sharpe.deflatedSharpe,
          trials: robustness.sharpe.trials,
          timingPValue: robustness.permutation.pValue,
          pathDependence: robustness.pathDependence,
          oosSharpeInSample: robustness.outOfSample.inSample.sharpe,
          oosSharpeOutOfSample: robustness.outOfSample.outOfSample.sharpe,
          walkForwardProfitableFraction: robustness.walkForward.profitableFraction,
          entryDiagnostics,
          warnings,
        },
      };
    }

    case "load_data": {
      const req = validateLoadRequest(String(args.exchange ?? "Binance"), String(args.symbol ?? ""), String(args.interval ?? "1h"));
      if ("error" in req) return req;
      try {
        const { candles, report } = validateCandles(await fetchKlines(req.exchange, req.symbol, req.interval, ""));
        if (candles.length === 0) return { error: `No bars returned — does ${req.symbol} trade on ${req.exchange}?` };
        const datasetName = `${req.symbol} ${req.interval} · ${req.exchange}`;
        // Mirror the Data tab's manual load: new dataset clears the old result/stats/
        // optimization and resets the multiple-testing counters (fresh testing context).
        setState({ candles, datasetName, result: null, customStats: [], optimization: null }, workspaceId);
        resetTrialCounters(workspaceId);
        recordDataset(report.bars);
        return {
          ok: true,
          dataset: datasetName,
          bars: report.bars,
          range: { from: isoDate(candles[0].time), to: isoDate(candles[candles.length - 1].time) },
          cleaning: { duplicatesRemoved: report.duplicatesRemoved, gaps: report.gaps.length, issues: report.issues },
          note: "Dataset loaded; session trial counters reset. You can now backtest_and_validate or optimize_strategy on it.",
        };
      } catch (e) {
        return { error: `Failed to load ${req.symbol} ${req.interval} from ${req.exchange}: ${e instanceof Error ? e.message : String(e)}` };
      }
    }

    case "optimize_strategy": {
      const { candles } = getState(workspaceId);
      if (candles.length < 40) {
        return { error: `Need ≥ 40 bars for walk-forward optimization (loaded: ${candles.length}). Ask the user to load more data.` };
      }
      let baseSpec;
      try {
        baseSpec = parseStrategy(args.strategy);
      } catch (e) {
        return { error: `Invalid base strategy: ${e instanceof Error ? e.message : String(e)}` };
      }
      const baseTriggerError = requireEventTrigger(baseSpec);
      if (baseTriggerError) return { error: baseTriggerError };
      const ranges = (args.grid && typeof args.grid === "object" ? args.grid : {}) as Record<string, number[]>;
      const windows = typeof args.windows === "number" ? args.windows : undefined;
      const outcome = runOptimization(baseSpec, ranges, candles, windows);
      if ("error" in outcome) return outcome; // { error, validAddresses? } — surfaces the valid addresses to the model

      // Optimization is multiple testing: fold its trial count into the session
      // counter so every subsequent backtest_and_validate deflates for these too.
      trials.backtestTrials += outcome.trialsRun;
      // Publish to the Strategy tab so the run is visible to the user, not just the model.
      setState({ optimization: summarizeOptimization(outcome, baseSpec.name) }, workspaceId);
      const r = outcome.result;
      return {
        verdict: r.verdict,
        oosSharpe: r.oosSharpe,
        deflatedSharpe: r.deflatedSharpe,
        oosTotalReturnPct: r.oosTotalReturnPct,
        profitableWindowFraction: r.profitableWindowFraction,
        gridSize: outcome.gridSize,
        windows: outcome.windows,
        trialsRun: outcome.trialsRun,
        perWindow: r.windows.map((w) => ({
          trainBars: w.trainBars,
          testBars: w.testBars,
          bestParams: w.bestParams,
          oosReturnPct: w.oosReturnPct,
        })),
        multipleTesting: {
          sessionBacktestTrials: trials.backtestTrials,
          note: `This search added ${outcome.trialsRun} backtests to your session trial count (now ${trials.backtestTrials}); all later results are deflated for them.`,
        },
      };
    }

    case "assess_regimes": {
      const { candles, result } = getState(workspaceId);
      if (candles.length === 0) {
        return { error: "No dataset loaded. Ask the user to load data first." };
      }
      if (!result || result.trades.length === 0) {
        return { error: "No backtest with trades available. Run backtest_and_validate first, then call this." };
      }
      const trendThreshold = typeof args.trendThreshold === "number" ? args.trendThreshold : undefined;
      const analysis = analyzeRegimes(candles, result.trades, { trendThreshold });
      const mc = regimeAwareMonteCarlo(candles, result.trades, { trendThreshold, iterations: 500 });
      return {
        regimeAwareMonteCarlo: {
          steadyStatePct: mc.steadyStatePct,
          tradesUsed: mc.tradesUsed,
          iterations: mc.iterations,
          maxDrawdownPct: { worst: mc.worstMaxDrawdownPct, median: mc.medianMaxDrawdownPct, best: mc.bestMaxDrawdownPct },
          returnPct: { worst: mc.worstReturnPct, median: mc.medianReturnPct, best: mc.bestReturnPct },
          warning: mc.warning,
          note: "Clustering-aware Monte Carlo: resamples equity paths along the regime Markov chain (vs. the IID path-dependence test). steadyStatePct = long-run time-in-regime. Compare the worst-case drawdown here to the IID one — a much wider regime-aware drawdown means the IID test understates risk.",
        },
        regimes: analysis.regimes.map((r) => ({
          regime: r.label,
          barPct: r.barPct,
          trades: r.trades,
          winRatePct: r.winRatePct,
          totalPnl: r.totalPnl,
          pnlSharePct: r.pnlSharePct,
          profitFactor: Number.isFinite(r.profitFactor) ? r.profitFactor : null,
        })),
        tradesClassified: analysis.tradesClassified,
        tradesUnclassified: analysis.tradesUnclassified,
        concentrationPct: analysis.concentrationPct,
        lossConcentrationPct: analysis.lossConcentrationPct,
        worstRegimeLabel: analysis.worstRegimeLabel,
        profitableRegimes: analysis.profitableRegimes,
        warnings: [
          ...analysis.warnings,
          "Regime labels are descriptive post-hoc groupings, not tradeable signals. A regime-specific edge still needs fresh-data validation.",
        ],
      };
    }

    case "assess_outcomes": {
      const { candles, spec } = getState(workspaceId);
      if (candles.length === 0) return { error: "No dataset loaded. Ask the user to load data first." };
      if (!spec) return { error: "No strategy yet. Run backtest_and_validate first so there's a trigger to analyze." };
      const conds = spec.process?.trigger?.length ? spec.process.trigger : spec.entry;
      const ctx = buildIndicatorContext(spec, candles);
      const eventBars = triggerEventBars(conds, candles, ctx);
      if (eventBars.length === 0) {
        return { error: "The strategy's trigger never fired on this dataset — no events to analyze." };
      }
      const report = outcomeReport(candles, eventBars, {
        tpAtrMult: typeof args.tpAtrMult === "number" ? args.tpAtrMult : undefined,
        slAtrMult: typeof args.slAtrMult === "number" ? args.slAtrMult : undefined,
        maxHoldBars: typeof args.maxHoldBars === "number" ? args.maxHoldBars : undefined,
      });
      return {
        ...report,
        note: "Long-direction triple-barrier outcomes of the strategy's trigger event. expectancy.excludesZero = a statistically real signed edge; it must also beat baseline.driftPct and survive into the second half. Still requires fresh-data validation.",
      };
    }

    case "assess_correlation": {
      const { candles, datasetName } = getState(workspaceId);
      if (candles.length < 30) {
        return { error: "Load a dataset (≥30 bars) before testing correlations." };
      }
      const aligned = factorFromCsv(
        String(args.factorCsv ?? ""),
        candles.map((c) => c.time)
      );
      const { a: factor, b: price } = trimLeadingNaN(
        aligned,
        candles.map((c) => c.close)
      );
      if (factor.length < 30) {
        return { error: `Only ${factor.length} overlapping points after aligning to ${datasetName} — need ≥ 30.` };
      }
      trials.correlationHypotheses += 1;
      return assessCorrelation(factor, price, { priorHypotheses: trials.correlationHypotheses });
    }

    case "assess_feature": {
      const { candles } = getState(workspaceId);
      if (candles.length < 80) return { error: "Load a dataset with at least 80 bars before running Feature Lab." };
      const featureSpecs = Array.isArray(args.features) && args.features.length > 0
        ? args.features as typeof DEFAULT_FEATURE_SPECS
        : DEFAULT_FEATURE_SPECS;
      const atrMult = typeof args.atrMult === "number" ? args.atrMult : 1.5;
      const eventBars = cusumEvents(candles, { atrMult });
      if (eventBars.length === 0) return { error: "CUSUM detector found no events. Lower atrMult or load more volatile data." };
      const labels = tripleBarrier(candles, eventBars, {
        tpAtrMult: typeof args.tpAtrMult === "number" ? args.tpAtrMult : undefined,
        slAtrMult: typeof args.slAtrMult === "number" ? args.slAtrMult : undefined,
        maxHoldBars: typeof args.maxHoldBars === "number" ? args.maxHoldBars : undefined,
      });
      if (labels.length === 0) return { error: "CUSUM events could not be labelled — not enough forward bars or ATR warm-up." };
      trials.correlationHypotheses += featureSpecs.length;
      const report = featureAttribution(labels, featureSpecs.map((s) => featureSeries(s, candles)));
      return {
        ...report,
        eventSampler: { type: "CUSUM", atrMult, detectedEvents: eventBars.length, labelledEvents: labels.length },
        note: "Feature Lab tests whether features explain forward triple-barrier outcomes before strategy construction. A 'real' feature is a research lead, not a tradable edge until it survives OOS validation.",
      };
    }

    case "assess_prop_firm": {
      const { candles, result } = getState(workspaceId);
      if (!result || result.trades.length === 0) {
        return { error: "No backtest with trades available. Run backtest_and_validate first, then call this." };
      }
      const ruleset = {
        ...DEFAULT_PROP_FIRM_RULESET,
        startingBalance: typeof args.startingBalance === "number" ? args.startingBalance : DEFAULT_PROP_FIRM_RULESET.startingBalance,
        profitTargetPct: typeof args.profitTargetPct === "number" ? args.profitTargetPct : DEFAULT_PROP_FIRM_RULESET.profitTargetPct,
        maxDrawdownPct: typeof args.maxDrawdownPct === "number" ? args.maxDrawdownPct : DEFAULT_PROP_FIRM_RULESET.maxDrawdownPct,
        trailing: typeof args.trailing === "boolean" ? args.trailing : DEFAULT_PROP_FIRM_RULESET.trailing,
        dailyDrawdownPct: typeof args.dailyDrawdownPct === "number" ? args.dailyDrawdownPct : DEFAULT_PROP_FIRM_RULESET.dailyDrawdownPct,
        challengeFee: typeof args.challengeFee === "number" ? args.challengeFee : DEFAULT_PROP_FIRM_RULESET.challengeFee,
        activationFee: typeof args.activationFee === "number" ? args.activationFee : DEFAULT_PROP_FIRM_RULESET.activationFee,
        profitSplitPct: typeof args.profitSplitPct === "number" ? args.profitSplitPct : DEFAULT_PROP_FIRM_RULESET.profitSplitPct,
        payoutCadenceDays: typeof args.payoutCadenceDays === "number" ? args.payoutCadenceDays : DEFAULT_PROP_FIRM_RULESET.payoutCadenceDays,
        maxTradingDays: typeof args.maxTradingDays === "number" ? args.maxTradingDays : DEFAULT_PROP_FIRM_RULESET.maxTradingDays,
      };
      const regimeAware = typeof args.regimeAware === "boolean" ? args.regimeAware : true;
      const report = simulatePropFirm(result.trades, ruleset, { iterations: 2000, regimeAware, candles });
      return {
        ...report,
        caveat: "This estimates prop-rule convexity, not market edge. Lead with netEvPerAccount, pPass, and the timeout bucket; if regimeAware.enabled is true, note that trade sampling preserved entry-regime clustering via a Markov chain. Still require out-of-sample validation before risking fees.",
      };
    }

    case "add_stat": {
      const statName = String(args.name ?? "").trim();
      const statValue = String(args.value ?? "").trim();
      if (!statName || !statValue) return { error: "add_stat needs both 'name' and 'value'." };
      addCustomStat(statName, statValue, workspaceId);
      return { ok: true, posted: { name: statName, value: statValue }, note: "Now shown on the Strategy Stats tab." };
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

/** Reset the multiple-testing counters (e.g., when starting a fresh analysis). */
export function resetTrialCounters(workspaceId?: WorkspaceId): void {
  const id = workspaceId ?? getActiveWorkspaceId();
  counters.set(id, { backtestTrials: 0, correlationHypotheses: 0 });
}
