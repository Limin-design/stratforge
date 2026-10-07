# 06 — Master Catalog & Roadmap (Tests + Indicators)

The full statistical-test and indicator spec, consolidated into one backlog, tagged by **status**, **phase**, and **TS feasibility**. This is the build list. Method details live in [04-statistical-toolkit.md](04-statistical-toolkit.md) and [05-indicator-library.md](05-indicator-library.md).

Phases: **P1** = core single-asset validation, usable now · **P2** = pairs/multi-asset, regime, advanced indicators · **P3** = regression/ML pricing layer, dimension reduction, forecast calibration.

---

## 0. One architecture correction first (read this)

The source spec ends with: *"build your Python backend using Pandas-TA or TA-Lib… vectorized C extensions… without placing a computational bottleneck on your servers."*

**That recommendation does not fit StratForge, and adopting it would be a mistake here.** Reasons:

1. **The stack is TypeScript-only and the engine runs client-side** (browser / Tauri). There is no Python backend, and there shouldn't be one — it contradicts the established architecture and the solo/no-entity constraint.
2. **There is no server bottleneck to avoid, because there is no server doing the compute.** Backtests run on the *user's* machine. The Python rec is solving a problem (server-side vectorization cost) that our architecture doesn't have. Client-side compute is the cheaper and more scalable model for us — every user brings their own CPU.
3. **It breaks the privacy model.** "Users bring their own data" + client-side compute means their data never has to leave the device. Routing candles to a Python server to run TA-Lib throws that away.

**Do instead** (already the plan in [05](05-indicator-library.md)): hand-roll the core in TS (done, and unit-tested) and, for breadth, adopt or cross-validate against a vetted TS library (`@ixjb94/indicators`, `trading-signals`) behind the `computeIndicator` adapter. Pin golden values from TA-Lib/TradingView in tests. Same institutional accuracy, no Python, no server.

The heavier econometric tests (Johansen, PCA, ARCH) do need numerical libraries — but TS ones (`ml-matrix`, etc.), still client-side. Flagged per-row below.

---

## A. Statistical & econometric tests

### A1. Stationarity & unit root
| Test | Purpose | Phase | TS feasibility | Status |
|---|---|---|---|---|
| Augmented Dickey-Fuller (ADF) | unit-root / non-stationarity | P1 | medium — needs MacKinnon critical-value tables | planned |
| KPSS | stationarity (opposite null to ADF; use both) | P1 | medium — crit tables | planned |
| Phillips-Perron (PP) | unit root, robust to heteroskedasticity/serial corr | P1–P2 | medium — crit tables + Newey-West | planned |
| Zivot-Andrews | stationarity allowing one endogenous structural break | P2 | hard — break search + crit values | planned |
| Variance Ratio (Lo-MacKinlay) | random-walk test; VR<1 mean-revert, >1 trend | P1 | easy — pure TS | planned |

### A2. Cointegration & causality (pairs / multi-asset)
| Test | Purpose | Phase | TS feasibility | Status |
|---|---|---|---|---|
| Engle-Granger (2-step) | pairwise cointegration (simplest entry point) | P2 | medium — regression + ADF on residual | planned |
| Johansen | multi-asset cointegration vectors | P2 | hard — eigen-decomposition (`ml-matrix`) + crit tables | planned |
| Granger causality | does asset A's past predict asset B | P2 | medium — VAR + F-test | planned |
| Cross-Correlation Function (CCF) | lead-lag between two series (e.g. alt-data → equity) | P2 | easy — pure TS | planned |

> **Scope note:** the entire engine today is **single-asset, long-only**. Cointegration/Granger/CCF only become meaningful after a multi-asset / pairs-trading capability exists. Treat A2 as gated on that feature, not standalone.

### A3. Overfitting & backtest validation (the priority)
| Test | Purpose | Phase | TS feasibility | Status |
|---|---|---|---|---|
| Deflated Sharpe Ratio (DSR) | multiple-testing + non-normality correction | P1 | easy — needs normal CDF/ppf (see [04](04-statistical-toolkit.md) §2.3) | spec'd |
| Probabilistic Sharpe Ratio (PSR) | P(true SR > benchmark) | P1 | easy | spec'd |
| Monte Carlo permutation | ruleset vs random positioning | P1 | easy — pure TS | planned |
| Walk-forward analysis | rolling re-optimization | P1 | easy | planned |
| White's Reality Check | best-of-pool vs luck (bootstrap) | P1–P2 | medium — stationary bootstrap | planned |
| Hansen's SPA | RC successor, robust to poor candidates | P2 | medium — bootstrap | planned |
| Combinatorial Purged CV (CPCV) + PBO | OOS distribution + overfit probability | P2 | medium — purge/embargo logic | planned |

### A4. Model diagnostics & residual tests (need a regression/ML layer first)
| Test | Purpose | Phase | TS feasibility | Status |
|---|---|---|---|---|
| Breusch-Pagan | heteroskedasticity in regression residuals | P3 | easy once regression exists | planned |
| White test | heteroskedasticity, general form | P3 | medium | planned |
| ARCH / Engle LM | volatility clustering | P2–P3 | medium — useful for vol modeling too | planned |
| Variance Inflation Factor (VIF) | multicollinearity of predictors | P3 | easy | planned |
| Cook's distance | influential outliers skewing a fit | P3 | easy | planned |

> **Scope note:** A4 presumes the platform fits **regressions / ML models** to price assets. The current DSL engine does not — strategies are rule-based, not fitted. These tests are dead weight until a modeling layer is added. Park them in P3.

### A5. Dimension reduction & model selection (P3, with the modeling layer)
| Test | Purpose | Phase | TS feasibility | Status |
|---|---|---|---|---|
| PCA | compress many correlated features | P3 | hard — SVD (`ml-matrix` / `ml-pca`) | planned |
| AIC / BIC | model fit with complexity penalty (BIC stricter) | P3 | easy | planned |
| Likelihood Ratio test | significance of added parameters (nested models) | P3 | easy | planned |

### A6. Distribution & classification verification
| Test | Purpose | Phase | TS feasibility | Status |
|---|---|---|---|---|
| Kolmogorov-Smirnov (K-S) | sample vs theoretical distribution | P1–P2 | easy | planned |
| Anderson-Darling | like K-S but tail-weighted (better for fat tails) | P1–P2 | medium | planned |
| QQ / PP plot | visual fat-tail / distribution diagnostic | P1 | easy — charting | planned (UI) |
| Jarque-Bera | normality via skew/kurtosis | P1 | easy | planned |
| Brier score | calibration of probabilistic forecasts | P3 | easy | planned |
| Population Stability Index (PSI) | feature-distribution drift over time | P2–P3 | easy | planned |

> **Note:** Brier/PSI are for **probabilistic prediction** (e.g. a prediction-market / binary-event feature, which the source hints at with Polymarket). They presuppose a forecasting model that outputs probabilities — another P3 capability, not relevant to rule-based backtests.

---

## B. Indicators

Built today (8): SMA, EMA, RSI, MACD, Bollinger, ATR, Stochastic, ADX. Full method/flaw discussion in [05](05-indicator-library.md).

### B1. Trend / overlap
| Indicator | Phase | TS notes | Status |
|---|---|---|---|
| SMA, EMA | — | — | built |
| WMA, DEMA, TEMA | P2 | easy (compose EMAs) | planned |
| HMA (Hull) | P2 | easy (WMA of WMAs) | planned |
| KAMA / VWMA | P2 | easy | planned |
| Bollinger Bands | — | — | built |
| Parabolic SAR | P2 | easy; careful causal accel-factor state | planned |
| Ichimoku | P2 | easy; some lines are *displaced* — keep forward shift out of signals (look-ahead trap) | planned |

### B2. Momentum / oscillators
| Indicator | Phase | TS notes | Status |
|---|---|---|---|
| RSI, MACD, Stochastic, ADX | — | — | built |
| Williams %R | P1 | trivial | planned |
| CCI | P2 | easy | planned |
| Stoch RSI, ROC, TSI, Ultimate/Awesome Osc | P2 | easy | planned |

### B3. Volatility
| Indicator | Phase | TS notes | Status |
|---|---|---|---|
| ATR | — | — | built |
| NATR (normalized ATR) | P1 | trivial (ATR/close·100) | planned |
| StdDev | P1 | trivial (have `rollingStd` internally) | planned |
| Keltner, Donchian | P2 | easy | planned |
| Squeeze (BB vs Keltner) | P2 | easy; composite | planned |

### B4. Volume
| Indicator | Phase | TS notes | Status |
|---|---|---|---|
| OBV | P1 | easy | planned |
| VWAP | P1 | easy; define session reset explicitly | planned |
| A/D line | P2 | easy | planned |
| Chaikin Oscillator (ADOSC) | P2 | easy (MACD of A/D) | planned |
| MFI, CMF, Force Index | P2 | easy | planned |

### B5. Market structure / "smart money" — handle with care
| Indicator | Phase | TS notes | Status |
|---|---|---|---|
| Fair Value Gap (FVG) | P2 | **repaint risk** — define strictly on *closed* 3-candle sequences; must pass the causality harness | planned |
| Order Block | P3 | **subjective + repaint risk** — many definitions look back from a *later* move (implicit look-ahead). Needs a precise causal definition or it inflates backtests | planned |
| Waddah Attar Explosion (WAE) | P3 | composite (MACD + BB); easy once components exist | planned |

> **Two honest flags on B5:** (1) These are **OHLC-derived**, not true *market microstructure* — real microstructure needs order-book/tick data, which the BYO-data model (Binance/MT5 bars) doesn't provide. Labeling matters so users aren't misled. (2) FVG and especially Order Blocks are the classic **repainting** offenders. They are implementable, but only with a strict point-in-time definition validated by the causality test in [05](05-indicator-library.md) §5. Without that, they're exactly the "too good to be true" backtest trap the product exists to prevent.

---

## C. Recommended build order

1. **P1 validation MVP** (the honesty engine): finish Tier-1 metrics → Sharpe CI + PSR + DSR + Monte Carlo permutation + walk-forward + K-S/Jarque-Bera/QQ. Plus the stationarity trio (ADF/KPSS/variance-ratio) for instrument characterization.
2. **P1 indicators**: Williams %R, NATR, StdDev, OBV, VWAP — fast wins filling the obvious gaps. Add the **causality/no-repaint harness** to CI now, before the trickier indicators.
3. **P2**: White's RC/SPA, CPCV+PBO; regime detection (ARCH, structural breaks, HMM); trend/momentum/volatility indicator breadth; **then** the multi-asset layer that unlocks cointegration/Granger/CCF and pairs trading.
4. **P3**: a regression/ML pricing layer — only then do the model-diagnostic tests (Breusch-Pagan, White, VIF, Cook's), dimension reduction (PCA, AIC/BIC, LR), and forecast calibration (Brier, PSI) earn their place. This is also where a prediction-market/binary-event feature would live.

**Bottom line:** the spec is excellent and almost entirely worth building — but ~half of it (A2, A4, A5, A6-forecasting, B5) is gated on capabilities the engine doesn't have yet (multi-asset, fitted models, probabilistic forecasts). Build the P1 validation core first; it's what makes every later number trustworthy.

---

## Sources

Methods and formulas are sourced in [04-statistical-toolkit.md](04-statistical-toolkit.md) and [05-indicator-library.md](05-indicator-library.md). TS library and look-ahead/repaint references are in [05](05-indicator-library.md).
