# 07 — Becoming the Go-To Platform + the Cross-Domain Correlation Engine

Two linked questions: what makes StratForge the tool serious algo traders actually reach for, and how do we support the "bring me any factor — oil supply vs the dollar, births vs a crop price — and tell me if it's real" workflow. They're the same answer: **rigor as a product**.

---

## Part A — What makes power users switch

Algo traders and quants are a skeptical, burned audience. Most retail tools optimize for *pretty backtests*; that's exactly why serious users distrust them. The wedge is the opposite of pretty: be the tool that tells them the truth and lets them do anything.

### 1. Trust through rigor (the moat we're already building)
Power users have all been fooled by a great backtest that died live. A platform where overfitting detection is *default, not opt-in* — Deflated Sharpe, Monte Carlo permutation, out-of-sample, walk-forward on every result — is a category difference. The P1 engine we just built is the foundation. Lean into it as the brand: "the backtester that argues with you."

### 2. Openness — never box them in
The thing that makes power users leave: hitting a wall. Defenses:
- **Bring your own data** (already core) — any instrument, any source.
- **Bring your own indicators/factors** — a safe expression layer so advanced users define custom signals without us shipping every indicator (keep it sandboxed: a typed formula DSL, not arbitrary code).
- **Programmatic access** — export, an API, and a path to run strategies headless. Quants want to script.
- **No lock-in** — strategies are portable JSON (already true).

### 3. Realistic execution (a huge credibility lever)
Frictionless backtests are an instant tell. Model slippage, realistic fees, partial fills, funding/borrow costs for shorts, and latency/next-bar fills (we already do next-bar). A backtest that includes costs power users *believe*; one that doesn't, they discard. This alone separates serious tools from toys.

### 4. Speed and scale
Client-side TS is the right call (privacy + zero server cost), but make it fast: vectorized indicator math, **Web Workers / WASM** for heavy backtests and Monte Carlo, incremental/streaming indicators for live data, and multi-asset/portfolio backtests. A power user running 10,000 permutations shouldn't watch a spinner.

### 5. The iteration loop and workflow
- Multi-monitor / pop-out windows (done).
- **Parameter sweeps with the overfitting guardrails baked in** — when a user grid-searches, we automatically track the trial count and feed it into the Deflated Sharpe. The optimizer can't lie to itself.
- Walk-forward *optimization* (not just testing), strategy versioning/journal, and a portfolio layer (combine strategies, see correlation between them).
- A **paper/live bridge** later — the credibility capstone.

### 6. The agent as a real quant co-pilot
Not a chatbot bolted on. It proposes a spec, runs the battery, and critiques its own idea with the numbers — in the analytical, non-sycophantic voice from [01](01-agent-brain.md). For power users the agent's value isn't hand-holding; it's a tireless second analyst that always runs the robustness checks they'd skip at 2am.

### 7. Later: a verified marketplace
Shareable strategies/indicators — but with **verified out-of-sample track records**, not vanity backtests. The rigor makes a trustworthy marketplace possible where others can't.

**Priority:** execution realism (#3) and sweep-aware overfitting guards (#5) are the highest-leverage near-term wins after P1. They're what convert a skeptic.

---

## Part B — The cross-domain correlation / factor engine

Traders will arrive with ideas far outside price history: *"does oil supply lead the dollar?"*, *"do births in a region predict a soft-commodity price months later?"*, and stranger. We should absolutely support this — it's a genuine differentiator — **and it's also the single most dangerous feature we could build**, because it's a spurious-correlation generator unless we wrap it in exactly the rigor that is our brand.

### B1. The capability
Let any external time series become a first-class **factor** the engine and agent can analyze and trade on:
1. **Ingest any series** — `(timestamp, value)` at any frequency (monthly macro, weekly inventory, daily prices, event-based prediction-market odds).
2. **Align & resample** to the instrument's timeframe — explicit rules for forward-fill, interpolation, and **release-lag** (macro data is published *after* the period it describes; using it on the period date is look-ahead bias — a classic killer). The agent must respect publication lag.
3. **Factor as a DSL operand** — generalize the operand model (already `indicator | price | value`) to add `factor`, so a condition can read `oil_supply z-score < −1` exactly like an indicator. This is a natural extension of what we built, not a rewrite.
4. **The relationship toolkit** (catalogued in [06](06-catalog-and-roadmap.md) A2): Pearson/Spearman correlation, **Cross-Correlation Function** for lead-lag ("oil leads the dollar by 3 months"), **Granger causality** (does X help predict Y), **cointegration** (Engle-Granger/Johansen) for long-run equilibria, and regression with the diagnostic suite.

### B2. Why this is mostly a trap — and how we make it a strength
The moth-births example is the perfect teaching case. If we let users test "any correlation that comes to mind," we have built a **p-hacking firehose**: with enough unrelated series, some *will* correlate by pure chance. (See the famous *Spurious Correlations* catalogue — US cheese consumption vs. deaths by bedsheet entanglement, etc.) The honest platform must fight this on every axis:

- **Multiple-testing correction, always.** Track how many factor/lag combinations the user has tried this session and deflate significance accordingly (Bonferroni / Benjamini-Hochberg) — the same discipline as the Deflated Sharpe, applied to factor discovery. The 30th correlation you test needs a far higher bar than the 1st.
- **Spurious-regression guard.** Two unrelated *trending* (non-stationary) series correlate spuriously (Granger-Newbold). Require stationarity checks (ADF/KPSS) before trusting a correlation/regression, and prefer **cointegration** over raw correlation for level series.
- **Out-of-sample is mandatory for factors too.** A factor relationship must survive on data it wasn't discovered on, or it doesn't count. The whole P1 battery applies to factor-based signals.
- **Effective sample size honesty.** "Oil vs dollar, monthly, 10 years" is *120 points*; with a hand-picked lag that's almost no evidence. Surface the real N and the resulting confidence, loudly.
- **Mechanism prompt, not a gate.** The agent should ask "what's the plausible causal mechanism?" — not to refuse (we don't moralize or gatekeep legal ideas), but because a relationship with no mechanism and a marginal, multiple-testing-corrected p-value is almost certainly noise, and saying so is the honest, useful move.

The product win is precisely here: anyone can compute a correlation in Excel. The tool that says *"yes, oil supply and the dollar correlate at lag 3 — but after correcting for the 40 factors you tested, the non-stationarity in both series, and an effective N of 120, this is not significant; here's the honest read and what would change my mind"* is the one a serious quant trusts and pays for. The moth idea isn't something to reject — it's something to **test fairly and report honestly**, which is the entire brand.

### B3. Scope & sequencing
This is a **P2/P3** capability: it needs multi-series alignment, the factor-DSL extension, and the cointegration/causality tests (some needing a TS linear-algebra lib). But two cheap things to do **now** so we build toward it cleanly:
1. Keep the operand model general (an external `factor` should slot in beside `indicator`).
2. Make the multiple-testing / trial-counting infrastructure from P1 reusable for factor discovery, not just parameter sweeps.

Data sourcing follows the BYO model (CSV first; later connectors to macro/alt-data and prediction markets like Polymarket).

---

## Bottom line

Both halves reduce to one thesis: **in a market full of tools that flatter the user's backtest, the winning move is ruthless, transparent honesty** — about overfitting, about execution costs, and about spurious correlations. That's what makes power users switch, and it's the only safe way to give them the "correlate anything" superpower they'll ask for.

See also: [04 statistical toolkit](04-statistical-toolkit.md) · [06 catalog & roadmap](06-catalog-and-roadmap.md) · [01 agent brain & persona](01-agent-brain.md).
