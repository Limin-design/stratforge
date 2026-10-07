# 04 — The Statistical Toolkit

The full set of statistics the agent needs to judge a strategy with high accuracy. This expands the anti-overfitting section of [01-agent-brain.md](01-agent-brain.md) into an implementable spec.

**The governing principle (same as indicators): the agent does not compute statistics by "reasoning."** LLMs are unreliable at arithmetic. Every number here is produced by a deterministic, unit-tested engine function the agent calls as a tool. The agent's job is to *choose* the right test, *read* the output, and *explain* it. The engine guarantees the math.

Four tiers, in rough build order. Tiers 1–2 are the priority — they are what make the product honest.

---

## Tier 1 — Performance & risk metrics (descriptive)

Mostly built already (see `stats.ts`); this is the complete target list. All are pure functions over the trade list and the per-bar equity curve.

| Metric | Formula / definition | Notes |
|---|---|---|
| CAGR | `(finalEq/initialEq)^(1/years) − 1` | annualize from candle timestamps ✓ built |
| Sharpe | `mean(r) / std(r)`, annualized `× √(periods/yr)` | rf≈0 for intraday ✓ built |
| Sortino | `mean(r) / downsideDev(r)` | downsideDev penalizes only `r<0` ✓ built |
| Calmar | `CAGR / maxDrawdown` | ✓ built |
| Omega(θ) | `Σ max(r−θ,0) / Σ max(θ−r,0)` | probability-weighted gain/loss ratio above threshold θ |
| Max drawdown | peak-to-trough of equity | ✓ built |
| DD duration | longest stretch below prior peak | ✓ built |
| Ulcer Index | `√(mean(drawdown%²))` | penalizes depth *and* duration of drawdowns |
| VaR(α) | α-quantile of return distribution | historical (empirical) or parametric |
| CVaR / Expected Shortfall | `mean(r | r ≤ VaR(α))` | **preferred over VaR** — convex, captures the tail magnitude. Basel FRTB uses ES at 97.5%. |
| Tail ratio | `|p95(r)| / |p5(r)|` | >1 = fat right tail |
| Exposure | % of bars in market | ✓ built |
| Expectancy / payoff / profit factor | per-trade stats | ✓ built |

Implementation: trivial pure TS. Add Omega, Ulcer, VaR, CVaR, tail ratio to `stats.ts`.

---

## Tier 2 — Significance & robustness (the anti-overfitting core)

This is the differentiator. Each answers a version of "is this edge real, or did we mine it?"

### 2.1 Sharpe standard error & confidence interval (Lo, 2002)

A Sharpe ratio is an *estimate* with error bars. For IID returns:

```
SE(SR) ≈ √( (1 + 0.5·SR²) / T )        # T = number of periods
95% CI ≈ SR ± 1.96·SE(SR)
```

If returns are autocorrelated (most strategies), the naive `√T` annualization overstates Sharpe — Lo's autocorrelation-adjusted SE (serial correlation to ~lag 5) corrects it, and a **block/stationary bootstrap** (resample blocks 10,000×, take 2.5/97.5 percentiles) makes the fewest assumptions. Report the CI, not just the point estimate. (A naive Sharpe of 1.82 can be 1.64 Lo-adjusted, 1.58 bootstrap-median.)

### 2.2 Probabilistic Sharpe Ratio (PSR)

Probability the true SR exceeds a benchmark `SR0` (often 0), correcting for sample length and non-normality:

```
PSR(SR0) = Φ( (SR_hat − SR0)·√(T − 1) / √(1 − γ3·SR_hat + ((γ4 − 1)/4)·SR_hat²) )
```

- `SR_hat`, `SR0` in **per-period** units (not annualized).
- `γ3` = skewness, `γ4` = **raw (non-excess) kurtosis** — normal = 3. *Common bug: using excess kurtosis here. With γ3=0, γ4=3 the denominator collapses to `√(1 + 0.5·SR²)`, matching Lo's SE.*
- `Φ` = standard normal CDF.

### 2.3 Deflated Sharpe Ratio (DSR) — the headline number

PSR where `SR0` is the **expected maximum Sharpe across N trials** (so it accounts for how many variants you tried). This is what the agent should report instead of raw Sharpe.

```
SR0 = √Var[SR_n] · ( (1−γ)·Z⁻¹(1 − 1/N) + γ·Z⁻¹(1 − 1/(N·e)) )
DSR = PSR(SR0)   # using the PSR formula above
```

- `N` = number of independent strategy configurations tried.
- `Var[SR_n]` = variance of the Sharpe ratios across those N trials.
- `γ` = Euler–Mascheroni constant ≈ 0.5772156649; `e` = Euler's number; `Z⁻¹` = inverse normal CDF (ppf).

Reference implementation (Bailey & López de Prado), directly portable to TS:

```python
gamma = 0.5772156649015328606
def expected_max_sharpe(mean_sr, var_sr, N):
    return mean_sr + sqrt(var_sr)*((1-gamma)*norm.ppf(1-1/N) + gamma*norm.ppf(1-1/(N*e)))
def DSR(sr, var_sr, N, T, skew, kurt):     # sr, var_sr per-period
    SR0 = expected_max_sharpe(0, var_sr, N)
    return norm.cdf((sr - SR0)*sqrt(T-1) / sqrt(1 - skew*sr + ((kurt-1)/4)*sr**2))
```

Worked example from the literature: a 2.5 annual Sharpe, chosen from 100 trials, 1250 days, skew −3, kurt 10 → DSR ≈ **0.90**, i.e. a 10% chance the strategy makes no money at all *despite the 2.5 Sharpe*. This is the number that keeps users honest.

**The agent must track `N` (configs tried this session) and feed it into DSR.** That single discipline defeats most overfitting.

### 2.4 Minimum Backtest Length (MinBTL)

Given N trials, the minimum sample length before a high in-sample Sharpe is even *plausibly* real. Lets the agent say "you don't have enough data to claim this." Cheap to compute from the same inputs.

### 2.5 Multiple-testing haircut (Harvey & Liu)

When many strategies/factors are tested, the best one's Sharpe must be discounted. The haircut is **nonlinear** — the rule-of-thumb "50% haircut" is wrong; top Sharpes are penalized lightly, marginal ones heavily. Implement via Bonferroni, Holm, and Benjamini–Hochberg–Yekutieli (FDR) adjustments to the p-value of the Sharpe.

### 2.6 Probability of Backtest Overfitting (PBO)

Via Combinatorially-Symmetric Cross-Validation (CSCV): split the timeline into S chunks, form all in-sample/out-of-sample combinations, and measure how often the in-sample-best config underperforms the OOS median. PBO is that frequency. >50% ≈ the selection process is overfitting.

### 2.7 Combinatorial Purged Cross-Validation (CPCV)

The gold standard for OOS estimation on time series (López de Prado). Generates **many** train/test paths with:
- **Purging:** drop training samples whose labels overlap the test window.
- **Embargo:** drop a gap of samples right after each test window.

Yields a *distribution* of OOS performance, not a single number — lower PBO and better DSR than walk-forward.

### 2.8 Walk-forward analysis

Rolling re-optimization (optimize window → test next window → roll). The historical standard, intuitive, but a single path and still overfittable. Build it (users expect it) but rank CPCV above it.

### 2.9 Monte Carlo permutation test

Cheap, powerful, and easy to explain. Shuffle the bar/return order (or the strategy's signal vector) many times, re-run, and compute how often the permuted version beats the real one. If the real strategy beats 990/1000 permutations, p ≈ 0.01. Directly answers "is this luck?"

### 2.10 White's Reality Check / Hansen's SPA

When choosing the best of a family of rules, tests whether the best is significant *after* accounting for the full set searched. Best-in-class against data snooping; pairs with the haircut.

---

## Tier 3 — Time-series diagnostics

Characterize the instrument and validate assumptions.

- **Stationarity — ADF & KPSS (use both).** ADF null = unit root (non-stationary); KPSS null = stationary. They have *opposite* nulls; agreement is strong evidence, disagreement is itself information (e.g., deterministic trend). Critical for any mean-reversion strategy. ADF/KPSS need MacKinnon/critical-value tables.
- **Variance Ratio (Lo–MacKinlay).** `VR(k)=1` random walk, `<1` mean-reverting, `>1` trending. Compute across horizons `k` for a visual signature of the instrument's character.
- **Autocorrelation — Ljung–Box.** Tests whether returns/residuals have serial structure (predictability or, in residuals, leftover signal).
- **Normality — Jarque–Bera** plus reported skew/kurtosis (these feed PSR/DSR anyway).
- **Structural breaks / regime shifts.** CUSUM and CUSUM-of-squares (mean/variance breaks), Bai–Perron (multiple endogenous breakpoints), Bayesian changepoint, and HMM for latent regimes (see [01](01-agent-brain.md) §3). Lets the agent say "the strategy's edge died after the 2024 regime break."

---

## Tier 4 — Position sizing & money management

Turns an edge into a survivable bet.

- **Kelly criterion.** Continuous form `f* = μ/σ²` (fraction of capital ∝ Sharpe/vol); discrete form `f* = (b·p − q)/b`. Maximizes long-run growth.
- **Fractional Kelly (use this).** Full Kelly is too aggressive and assumes you *know* μ and σ — you only have noisy estimates. Half-Kelly cuts volatility ~25% while giving up only ~25% of growth; the growth curve is flat near the optimum, so betting under Kelly is cheap insurance. Default to ½ or ¼ Kelly.
- **Volatility targeting / ATR-based sizing.** Scale position to a target volatility (or to N×ATR risk per trade) so risk is constant across regimes. Pairs naturally with the regime detector.
- **Risk of ruin.** Probability of hitting a capital floor given edge, variance, and bet size — the agent should surface it.

---

## TypeScript implementation notes

Everything above is implementable in pure TS. The only non-trivial dependencies:

- **Distributions:** normal CDF and inverse-CDF (ppf) are needed everywhere (PSR/DSR/haircut). Hand-roll the normal ppf (Acklam's algorithm) or pull a small stats lib (`jstat`, `simple-statistics`). You also want t, chi-square (Ljung-Box, Jarque-Bera), and F (Bai-Perron).
- **Bootstrap:** stationary/block bootstrap is a short loop; no library needed.
- **ADF/KPSS:** the only awkward ones — they need critical-value tables (MacKinnon). Port from a vetted source and pin test values.
- **HMM:** needs Baum-Welch/EM; defer to Tier-3 v2 or use a small library.

**Suggested build order:** (1) finish Tier-1 metrics → (2) Sharpe SE/CI + PSR + DSR + Monte Carlo permutation + OOS split + walk-forward (this is the honest-MVP) → (3) CPCV + PBO + haircut → (4) diagnostics + sizing. Each engine function becomes an agent tool: `sharpeCI`, `deflatedSharpe`, `monteCarloPValue`, `walkForward`, `cpcv`, `pbo`, `regimeBreaks`, `kellyFraction`.

---

## Sources

- Deflated / Probabilistic Sharpe Ratio (formulas + code) — https://gmarti.gitlab.io/qfin/2018/05/30/deflated-sharpe-ratio.html ; Bailey & López de Prado, https://www.davidhbailey.com/dhbpapers/deflated-sharpe.pdf ; https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2460551
- Multiple-testing haircut — Harvey & Liu, *Backtesting*, https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2345489 ; https://www.cmegroup.com/education/files/backtesting.pdf
- Sharpe statistics / CI — Lo (2002) *The Statistics of Sharpe Ratios*, https://www.twosigma.com/wp-content/uploads/sharpe-tr-1.pdf
- Stationarity / variance ratio / Ljung-Box — https://www.interactivebrokers.com/campus/ibkr-quant-news/statistical-tests-for-mean-reversion-stationarity/
- Risk metrics (CVaR/ES) — https://www.man.com/insights/covering-your-tail-expected-shortfall
- Position sizing / Kelly — https://coriva.eu.org/en/kelly-criterion-position-sizing/
- Structural breaks — Bai-Perron / CUSUM, https://towardsdatascience.com/understanding-time-series-structural-changes-f6a4c44cb13c/
