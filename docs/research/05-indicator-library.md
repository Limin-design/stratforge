# 05 — The Indicator Library: Implementing It Without Flaws

Your question was whether we can implement the indicator world inside the agent brain so it "runs and implements them without flaws." The answer is yes — but the way you get "without flaws" is architectural, not a matter of the model being smart.

---

## 1. The core decision: the agent does NOT compute indicators

This is the single most important rule. **An LLM must never calculate an indicator value.** Language models are unreliable at multi-step arithmetic over long series; ask one to compute a 200-bar EMA and it will quietly produce wrong numbers. "Without flaws" is impossible on that path.

Instead — and this is exactly what the current architecture already enforces — indicators are computed by **deterministic, unit-tested engine functions**. Strategies are *data* (the DSL): the agent emits a spec that *references* indicators by name and params; the engine computes them. The division of labor:

- **The agent decides WHICH indicators and WHY** (the reasoning, where LLMs are strong).
- **The engine guarantees HOW they are computed** (the math, where determinism is required).

Everything below serves that split: build a vetted indicator registry, expose it through the DSL, and let the agent compose — never compute.

---

## 2. The indicator universe (what "complete" looks like)

For scale: **TA-Lib** ships 200+ functions; **pandas-ta** exposes ~192 indicators + ~62 candlestick patterns (~252 total). You do not need all of them — there's heavy redundancy (a dozen moving-average variants). Target full *category coverage* with the most-used members of each.

| Category | Core members to cover | Have today |
|---|---|---|
| **Trend / overlap** | SMA, EMA, WMA, DEMA, TEMA, HMA, KAMA, VWMA, MACD, Ichimoku, SuperTrend, Parabolic SAR, ADX/DMI, Aroon | SMA, EMA, MACD, ADX ✓ |
| **Momentum / oscillators** | RSI, Stochastic, Stoch RSI, CCI, Williams %R, ROC, TSI, Ultimate Osc, Awesome Osc | RSI, Stochastic ✓ |
| **Volatility** | Bollinger Bands, ATR, Keltner, Donchian, rolling stdev, historical vol | Bollinger, ATR ✓ |
| **Volume** | OBV, VWAP, A/D line, Chaikin Money Flow, MFI, Force Index, Ease of Movement | — |
| **Statistical** | linear-regression slope, z-score, correlation, Hurst exponent, beta | — |
| **Candlestick patterns** | engulfing, doji, hammer, stars, etc. (~60) | — |

Current engine: 8 indicators across 4 categories — a solid base. The gaps that matter next: **volume** (OBV/VWAP/MFI), a few more **momentum** (CCI, Williams %R, Stoch RSI), and **statistical** (z-score, Hurst — Hurst also feeds regime detection).

---

## 3. Reference implementations — don't invent, cross-validate

The way to be "flawless" is to match an accepted reference, then lock it with tests. Options:

- **TA-Lib** — the de-facto canonical C library (200+); the numbers everyone benchmarks against.
- **pandas-ta** — Python, ~252, readable source.
- **TypeScript/JS libraries** (relevant to our TS-only stack):
  - **@ixjb94/indicators** — fastest, **zero-dependency**, 100+ indicators, explicitly tested against TradingView and other libs. Strong candidate to depend on or to benchmark against.
  - **trading-signals** (bennycode) — production-tested, streaming, good test coverage.
  - **technicalindicators** (anandanand84) — TS, includes candlestick pattern recognition.
  - **@debut/Indicators** — streaming, allocation-light (`nextValue()` per bar) — nice for live data.

**Recommendation:** keep hand-rolling the core (we did, and it's tested — it keeps the engine dependency-free and fully understood), and for breadth either (a) adopt a vetted library like `@ixjb94/indicators` behind our `computeIndicator` adapter, or (b) port what we need and **pin golden values from TA-Lib/TradingView in unit tests**. Either way, every indicator ships with reference-value tests. We already validate against known values in the engine test suite.

---

## 4. The flaw catalog — and how the architecture prevents each

These are the ways indicators actually go wrong. Each has a structural defense.

### Look-ahead bias (the expensive one)
Using data not yet available at decision time. It quietly inflates backtests **5–10% per year**. Defense: every indicator function must be **causal** — `output[i]` depends only on `input[0..i]`, never `i+1`. Our engine already fills signals at the *next* bar's open, so the execution side is safe; the indicator side must hold the same line.

### Repainting
An indicator whose **past** values change as new bars arrive. Disastrous for backtests because the historical signal you "saw" never actually existed. Defense: deterministic, append-only computation; signals evaluated only on **closed** bars, never the forming bar. Flag/avoid known repainters (ZigZag, fractal/pivot indicators that reference future pivots).

### Warm-up / NaN handling
Every indicator needs N bars before it's valid. Defense: emit `NaN` until warm (we do), and conditions treat `NaN` as false (we do). Document each indicator's warm-up length so the agent knows when a signal is real.

### Degenerate inputs
Flat ranges → divide-by-zero (e.g., Stochastic when high==low). Defense: explicit guards (we return 50/100 in those cases).

### Convention drift
EMA seeding, Wilder vs simple smoothing, ATR's first value — libraries legitimately differ. Defense: pick a convention, **document it**, and pin it with tests. Don't chase another library to the 8th decimal; chase *internal consistency* and reference agreement on the parts that matter.

### Non-determinism
No randomness, no wall-clock, no locale-dependent parsing inside indicators. Same input → identical output, always.

---

## 5. The killer test: a causality / no-repaint harness

This is the concrete thing that proves "no look-ahead, no repaint" for *every* indicator automatically:

```
for each indicator:
  full   = compute(indicator, series[0..n])
  prefix = compute(indicator, series[0..k])      # truncate the future away
  assert full[0..k] == prefix[0..k]               # past must not change
```

If truncating future bars ever changes a past value, the indicator looks ahead or repaints — the test fails. Run it across all indicators on random series in CI. Combined with golden-value tests (vs TA-Lib/TradingView) and property tests (RSI∈[0,100], Bollinger symmetric, +DI/−DI bounds), this gives a hard, automated "flawless" guarantee. We already have golden-value + property tests; the causality harness is the missing piece and is cheap to add.

---

## 6. How the agent uses indicators safely

- The agent selects from a **registry** of vetted indicators, each with typed params and known output lines (the DSL discriminated union we just built).
- It **cannot invent** a computation — anything not in the registry doesn't exist to it.
- Invalid params or unknown output lines are **rejected at parse time** (we added line validation in `parseStrategy`).
- So the agent operates entirely in the safe space: it reasons about *which* indicators express its hypothesis and *why*, and the engine does the rest, identically every time.

That is the whole answer to "implement them without flaws": **deterministic engine + reference-validated tests + causal-by-construction + a registry the agent composes but never computes.**

---

## 7. Roadmap

1. **Volume tier** — OBV, VWAP, MFI, Chaikin Money Flow (most-requested gap).
2. **Momentum fill-ins** — CCI, Williams %R, Stoch RSI, ROC.
3. **Statistical** — z-score, linear-regression slope, Hurst exponent (also powers regime detection in [01](01-agent-brain.md)).
4. **Add the causality/no-repaint harness** to CI.
5. **Optional:** adopt `@ixjb94/indicators` behind the `computeIndicator` adapter for instant breadth, keeping our tests as the contract.
6. **Later:** candlestick pattern recognition (its own category; `technicalindicators` covers it).

---

## Sources

- TA-Lib / pandas-ta scope — https://github.com/xgboosted/pandas-ta-classic ; https://www.slingacademy.com/article/comparing-ta-lib-to-pandas-ta-which-one-to-choose/
- TypeScript indicator libraries — https://github.com/ixjb94/indicators ; https://github.com/bennycode/trading-signals ; https://github.com/anandanand84/technicalindicators ; https://github.com/debut-js/Indicators
- Repainting & look-ahead bias — https://www.luxalgo.com/blog/backtesting-traps-common-errors-to-avoid/ ; https://www.freqtrade.io/en/stable/lookahead-analysis/ ; https://fastercapital.com/content/Exploring-the-Dangers-of-Lookahead-Bias-in-Financial-Trading.html
