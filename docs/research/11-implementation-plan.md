# 11 — Implementation plan

> Turns the methodology harvest ([[10-quant-methodology-deltatrend]]) and the competitive
> teardown ([[09-competitive-quantpad]]) into a sequenced, file-level engineering plan.
> Regime *attribution* (`engine/regimes.ts`) already shipped; everything below builds on the
> existing pure-TS engine and the event-first DSL.
>
> Source of truth for status stays `PROJECT_STATUS.md §9`; this doc is the detailed how.

## Principles (apply to every phase)

- **TS-only, pure-TS engine, dependency-free.** No Python/TA-Lib. Determinism via
  `mathstats.mulberry32` (seeded) for anything stochastic.
- **Honesty is the feature.** Every new number ships with its caveat and, where relevant, a
  baseline (random / buy-&-hold / drift). Never imply certainty.
- **Small, verifiable changes.** Each phase = engine module + smoke test + surface wiring, in
  that order. Verify with `pnpm --filter @stratforge/engine typecheck` and a
  `scripts/*-smoke.ts` run (`tsx`); typecheck web with `pnpm --filter @stratforge/web typecheck`.
- **Keep `PROJECT_STATUS.md` current** in the same change (rule §9).
- **Three surfaces per feature:** (1) engine function, (2) agent tool in `agent/tools.ts` +
  persona note, (3) StatsPanel (or a new panel) section.

Existing contracts to build on: `Candle/Trade/TimelinePoint/BacktestStats/BacktestResult`
(`types.ts`), `runBacktest` (`backtest.ts`), `computeStats`/`analyzeEntryEvents` (`stats.ts`),
`assessRobustness` + battery (`robustness.ts`), `analyzeRegimes` (`regimes.ts`),
`mulberry32/normalCdf/normalPpf` (`mathstats.ts`), DSL `process.{thesis,trigger,context,outcome}`.

---

## Phase 1 — Buy-and-hold benchmark + Sharpe rubric  *(smallest; do first)*

**Why:** doc-10's most intuitive honesty check — a "107% strategy" that lost to 311% buy-&-hold.
We don't surface this at all today.

**Engine** — extend `stats.ts`:
- `buyAndHoldStats(candles: Candle[], initialCapital): { totalReturnPct, cagrPct, annualizedSharpe, maxDrawdownPct }` — synthesize a long-only timeline holding 1 unit from bar 0, reuse the existing return/Sharpe/DD math.
- `relativeVerdict(strategy: BacktestStats, benchmark)` → `{ beatsBuyHold: boolean, excessReturnPct, note }`.
- Add a small Sharpe rubric helper: `sharpeLabel(annualizedSharpe)` → `"uninvestable (<0.5)" | "weak (<1)" | "decent (<2)" | "strong"`.

**Surfaces:**
- StatsPanel: a "vs. buy & hold" row in the Performance box (return, CAGR, Sharpe, maxDD side by
  side) + a banner when the strategy underperforms passive holding.
- `backtest_and_validate` tool result: add `benchmark` + `beatsBuyHold` so the agent must address
  it; persona: "if the strategy doesn't beat buy-and-hold of the same asset/window, say so first."

**Verify:** `scripts/benchmark-smoke.ts` — on synthetic uptrend, buy-&-hold return ≈ close[-1]/close[0]−1; a flat strategy underperforms; verdict flips correctly.

**DoD:** typecheck (engine+web) green; smoke green; STATUS updated.

---

## Phase 2 — Outcome-label diagnostics (triple-barrier + EV/CI)

**Why:** QP02 + "Make Money?". Makes `process.outcome` *executable* instead of metadata (the gap
STATUS §8 already flags). Answers "edge or luck?" at the event level.

**Engine** — new `engine/src/outcomes.ts`:
- `tripleBarrier(candles, eventBars: number[], opts: { atrPeriod=14, tpAtrMult, slAtrMult, maxHoldBars }) : OutcomeLabel[]` where `OutcomeLabel = { eventBar, exitBar, hit: "tp"|"sl"|"time", returnPct, label: 1|-1|0 }`. ATR-based barriers (reuse `indicators.atr`), no look-ahead (scan forward from `eventBar+1`).
- `expectancyWithCI(returnsPct: number[], { iterations=2000, seed }) : { ev, ciLow, ciHigh, excludesZero }` — **bootstrap CI** on mean (resample with replacement via `mulberry32`).
- `outcomeReport(candles, eventBars, opts) : { byCase: { bullish, bearish }, baseline: { random, drift }, crossPeriod: { firstHalf, secondHalf } }` — EV/CI per case, vs. a random-entry and buy-&-hold-drift baseline, plus in-sample vs. later-window stability (does the CI still exclude 0?).

**Event source:** start with the strategy's `process.trigger` evaluated over candles (reuse the
condition evaluator from `backtest.ts` — extract `evalCondition` into a shared helper). Later the
feature lab (Phase 6) and a CUSUM detector can feed `eventBars` too.

**Surfaces:** `assess_outcomes` agent tool; StatsPanel "Event outcomes" section (EV ± 95% CI per
case, baseline columns, stability check, with the "CI spans 0 → indistinguishable from no edge"
warning). Persona: report the CI verdict before any praise.

**Verify:** `scripts/outcomes-smoke.ts` — engineered event with known forward drift → +label EV CI excludes 0; pure-noise events → CI straddles 0; barrier logic has no look-ahead (exit ≥ event+1).

**DoD:** as Phase 1. Refactor note: extract the shared `evalCondition` without changing `runBacktest` behavior (lock with the existing demo).

---

## Phase 3 — Regime entry filter + regime-aware (Markov) Monte Carlo

**Why:** Powell capstone — regime *filtering* was the single highest-impact optimization (OOS
max-DD −$16k → −$2k). Monte Carlo video — IID bootstrap ignores clustering; regime-switching MC
fixes it. Markov video — the transition-matrix math.

**3a. Regime as a DSL filter (entry context):**
- DSL: add a `regime` operand/condition kind, e.g. `{ kind: "regime", axis: "trend"|"volatility", in: ["up","range",…] }`, validated by Zod; allowed inside `process.context`/`entry`.
- Engine: in `backtest.ts`, precompute the per-bar regime via `classifyRegimes` and evaluate the regime condition like any other. Keeps the no-look-ahead discipline (regime at bar close).
- Surface: builder UI control "only enter in regime …"; agent can emit it as a context filter.

**3b. Regime-aware Markov Monte Carlo** — extend `regimes.ts` / `robustness.ts`:
- `regimeTransitionMatrix(perTradeRegimeLabels: string[]) : { states, P }` — count trade-to-trade transitions, row-normalize.
- `steadyState(P) : Record<state, number>` — solve via power-iteration (iterate a uniform vector through `P` to convergence); show "long-run % time per regime."
- `regimeSwitchingMonteCarlo(tradesByRegime, P, { iterations, seed }) : DistributionResult` — walk the chain, draw from the per-regime PnL distribution, build equity paths; report drawdown / final-equity / runup percentiles. Sits beside the existing `tradePathDependence` (IID) as the clustering-aware variant.
- Honesty cross-check: compare observed regime mix vs. steady state → "sample is regime-skewed" flag (complements the shipped concentration warnings).

**Surfaces:** extend `assess_regimes` output with the transition matrix + steady state; StatsPanel
regime section gains "long-run mix" and a regime-aware MC toggle. Persona: prefer regime-aware MC
when ≥2 regimes have enough trades.

**Verify:** `scripts/regime-mc-smoke.ts` — two-regime synthetic with strong clustering: regime-aware
MC drawdown dispersion ≠ IID dispersion; transition matrix rows sum to 1; steady state sums to 1
and matches a long-run simulation.

**DoD:** as above; DSL change covered by a parse/round-trip smoke (`specToBuilder` invariants).

---

## Phase 4 — Prop-firm assistant upgrade

**Why:** "stop trading like an idiot" + Powell — the convex-payoff model and the full report.
Replaces the basic pass-rate MC in StatsPanel.

**Engine** — new `engine/src/propfirm.ts`:
- `PropFirmRuleset = { startingBalance, profitTargetPct, maxDrawdownPct, trailing: boolean, dailyDrawdownPct?, minTradingDays?, profitSplitPct, payoutCadenceDays, challengeFee, activationFee }`.
- `simulatePropFirm(trades: Trade[], ruleset, { iterations, seed, regimeAware?, tradesPerDay? }) : PropFirmReport` where the report has `{ pPass, eChallengesToFund, eDaysToPass, eDaysToFirstPayout, ePayoutGivenFunded, netEvPerAccount, outcomeBuckets: { pass, fail, timeout } }`.
- Model the **challenge phase and funded phase separately** (different rulesets allowed), a
  **trailing-drawdown-aware barrier**, and an explicit **timeout** bucket (ran out of days). Net EV
  sign convention: positive = profitable to attempt = `ePayoutGivenFunded·pFund − eChallengesToFund·challengeFee − activationFee`.
- `riskGeometry(trades) : { winRatePct, avgRR, pnlStdDev }` + guidance text (lower PnL variance / higher win rate → higher pass odds) **with the caveat** that this exploits payoff convexity, not edge.

**Surfaces:** dedicated "Prop Firm" panel (ruleset presets: Topstep/Apex/etc.) or expand the
StatsPanel MC box; `assess_prop_firm` agent tool. Persona: always state net EV *and* the "this is
convexity, not edge" caveat; flag the timeout bucket.

**Verify:** `scripts/propfirm-smoke.ts` — zero-EV high-win/low-RR vs low-win/high-RR toy trade sets reproduce the doc-10 finding (higher win rate / lower PnL stddev → higher pass rate); buckets sum to 1; trailing vs static DD changes pPass.

**DoD:** as above.

---

## Phase 5 — Graded robustness verdict  *(synthesizes Phases 1–4 + the shipped battery)*

**Why:** doc-09 gap #4. One honest grade, components shown, never a returns promise.

**Engine** — new `engine/src/verdict.ts`:
- `robustnessVerdict(inputs: { robustness: RobustnessReport, benchmark, outcomeReport?, regimeAnalysis?, propFirm? }) : { grade: "A".."F" | score 0–100, components: {label, value, weight, note}[], caveats: string[] }`.
- Components (all already computed elsewhere): deflated Sharpe / PSR, permutation p-value, OOS
  degradation, walk-forward consistency, path-dependence, **beats-buy-&-hold**, **EV-CI-excludes-zero**, regime concentration. Weighted, transparent.
- **Guardrail:** it grades *robustness/fragility*, not profitability; every render shows the
  component breakdown + the standing "backtest ≠ live" caveat. Wording uses the Sharpe rubric.

**Surfaces:** replace/augment the StatsPanel `readinessScore` with the real verdict; fold into the
`backtest_and_validate` tool result. Persona: lead with the verdict-with-a-number (already the
rule), now backed by a real composite.

**Verify:** `scripts/verdict-smoke.ts` — an overfit synthetic (great in-sample, collapses OOS, loses to buy-&-hold) grades low; a robust one grades high; components are present and weights sum correctly.

**DoD:** as above.

---

## Phase 6 — Feature lab + transforms  *(largest; new surface)*

**Why:** QP01–03 — his step 0–1 (validate a *feature's* predictive power before building a
strategy) is not a first-class flow for us. This is the deepest differentiator but the biggest
build, hence last.

**Engine** — new `engine/src/features.ts`:
- Transform toolkit: `normalizePct`, `ratio(a,b)`, `difference`, `zscore(series, window)`, plus a
  **CUSUM event detector** `cusumEvents(candles, { atrMult }) : number[]` (volatility-normalized
  cumulative-move events — the doc-10 sampler).
- Feature value-types (continuous / binary / ordinal) + a small spec so features are declarative
  and AI-generatable (mirror the DSL's safe-by-construction approach).
- `featureAttribution(trades|outcomeLabels, features) : AttributionReport` — relate per-trade/
  per-event outcomes to entry-time features, **reusing `correlation.ts`'s anti-spurious verdict** so
  only defensible relationships surface. (= doc-09 gap #2.)

**Surfaces:** a new "Feature Lab" panel — define a feature + an event, see its forward-return /
triple-barrier relationship (Phase 2 machinery), with the anti-spurious verdict; an `assess_feature`
agent tool. Gated *before* strategy construction in the workflow narrative.

**Verify:** `scripts/features-smoke.ts` — transforms are scale-invariant where intended (normalized SMA-slope range stable across price levels); CUSUM event frequency tracks the ATR-mult knob; attribution flags a planted feature↔outcome relationship and rejects a spurious one.

**DoD:** as above.

---

## Sequencing, dependencies, and what to ship when

```
Phase 1 (benchmark)      ── tiny, independent ── SHIP FIRST
Phase 2 (outcome labels) ── needs shared evalCondition extract
Phase 3 (regime filter+MC) ── builds on shipped regimes.ts
Phase 4 (prop-firm)      ── independent; can run parallel to 2/3
Phase 5 (verdict)        ── DEPENDS on 1,2,3,(4); do after them
Phase 6 (feature lab)    ── reuses Phase 2 machinery; biggest; last
```

Recommended order: **1 → 2 → 3 → 4 → 5 → 6.** Phases 1–2 are the highest honesty-per-effort; 5 is
the satisfying synthesis once its inputs exist; 6 is the moonshot.

## Roadmap notes (flagged, not scheduled)

- **Cost-sensitivity readout** (how much EV fees/slippage eat) — small; fold into Phase 1 or 5.
- **Multi-timeframe + stateful DSL** — real expressiveness gaps (Powell needed a bias state machine
  across 1d/5m/1m). Advanced users will hit this. Larger architectural change; log, don't chase yet.

## Explicitly out of scope (per docs 09 & 10)

All-you-can-eat tick/L2 data infrastructure; a code-writing cloud agent; Pine Script generation.
Our typed-DSL + tool-using analyst + local-first model is the safer, differentiated design.
