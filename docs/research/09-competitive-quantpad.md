# 09 — Competitive teardown: QuantPad

> Source: a 6-part Instagram reel launch series by Thomas Skinner (@deltatrendtrading),
> watched 2026-06-22. QuantPad launches **2026-06-26**. This is the most direct
> competitor seen so far. Written to inform StratForge's roadmap — not to chase them.
> The honest headline: on our core mission (anti-overfit rigor) **we are already ahead**;
> their real advantages are infrastructure (data + cloud agent) we deliberately don't chase.

## What QuantPad is

An AI-native research platform for **retail** quant traders. Built over "421 days" by
Skinner + hired engineers. Founder narrative is pure anti-guru: Columbia physics student,
institutional-quant father, blew a live account at 15 running a YouTube guru strategy →
lesson "you must statistically validate an edge." Brand grew by programmatically
backtesting and exposing gurus (TJR, ICT/SMC). The product productizes his audience's
recurring ask: "can you code/test this strategy?"

**The wedge (their stated problem):**
1. Historical data is too expensive for retail ("hundreds of $/mo").
2. Infra burden — fetch/clean/store data, environments, versioning, API keys.
3. No agentic coding harness *built for trading* (vibe-coding an app ≠ quant research).
4. Generic LLMs fail at trading DSLs — ~99% of frontier-model Pine Script has linter errors.

## The product — three "prongs"

**Prong 1 — QuantPad Agent** (cloud AI coding agent for trading)
- Online coding agent (multi-file, read/write/diff) over a **cloud virtual file system**;
  cross-device "like Google Docs," no GitHub; executes on cloud compute.
- **All-you-can-eat historical data, not metered.** Headline: 16 yrs of 1s NASDAQ bars =
  $1,163.01 on DataBento, free here. Coverage: OHLCV to 1s; last 1yr tick/trade; last 1mo
  L2 order book; all CME futures, US equities, equity options; SEC filings + Fed macro.
  No API keys, no per-use billing.
- **Built-in TradingView Pine Script linter** — agent lints & self-corrects before returning
  code ("ChatGPT/Claude/Cursor can't do this"). Plus a Pine Script skill + semantic search
  over thousands of Pine examples. Multi-language: Python, Pine, NinjaTrader, MultiCharts.

**Prong 2 — QuantCopilot** (validation pipeline — explicitly *not* an agent)
- Ingests a backtest/live trade log → letter-grade **verdict**.
- **Regime analysis** — best/worst-performing market regimes.
- **Monte Carlo** — normal + **regime-aware** → drawdown / max-DD / final-equity distributions.
- **Advanced Insights** — surfaces feature correlations: whether win rate / run-up / return
  is driven by ATR, trend, volatility regime, etc., and shows how (for tuning).
- **Prop Firm Assistant** — models a prop challenge as a **structured product / boundary
  problem** (trailing drawdown, profit splits, withdrawals, e.g. Topstep) via Monte Carlo
  → P(pass), expected days-to-pass / to-first-payout, net EV per account.

**Prong 3 — Community**
- Publish files/projects to a shared library; like / favorite / comment / **clone**
  (clone copies all files into your workspace). Profiles, follows; official QuantPad posts too.

## QuantPad vs StratForge

| Capability | QuantPad | StratForge today | Verdict |
|---|---|---|---|
| Anti-overfit battery (Deflated/PSR, MC permutation, OOS, walk-forward) | Not mentioned | **Shipped** (`robustness.ts`) | **We lead** |
| Correlation / spurious-correlation engine | Not mentioned | **Shipped** (`correlation.ts`) | **We lead** |
| Pairs / cointegration | Not mentioned | **Shipped** (`cointegration.ts`, `pairs.ts`) | **We lead** |
| EV-first stats, entry clustering, path-dependence | — | **Shipped** (`stats.ts`) | **We lead** |
| Regime analysis (per-strategy) | Yes | **Missing** | **Gap — adopt** |
| Feature → performance attribution ("Advanced Insights") | Yes | Partial (correlation engine exists) | **Gap — extend** |
| Synthesized strategy verdict / grade | Letter grade | KPI scorecard only | **Gap — adopt (carefully)** |
| Prop Firm pass/EV simulator | Yes | **Missing** | **Gap — adopt (high value)** |
| AI agent | Cloud coding agent (writes/runs code) | BYO-model analyst using **deterministic tools**, never does math | **Different philosophy — ours is safer; keep it** |
| Strategy authoring | Pine/Python code + linter | **Typed JSON DSL** (safe-by-construction for AI) | **Different — ours is safer for AI gen** |
| Historical data | All-you-can-eat tick/L2, hosted | BYO keys + free crypto + CSV/MT5 | **Their moat; do not chase** |
| Community library (publish/clone) | Yes | Referral panel + planned cloud only | **Gap — Phase 2/3** |
| Hosting | Cloud-only | Local-first, optional E2E cloud sync | **Different positioning** |

## What to adopt (fits our TS-only, local-first, anti-overfit constraints)

1. **Regime analysis** — classify bars into regimes (trend/range, hi/lo vol via ATR or
   realized vol, maybe drawdown state of a benchmark) and report per-regime performance.
   Pure TS, slots into `engine`. Directly on-mission: exposes where an "edge" is really
   just one regime. **High value, low risk.**
2. **Feature → performance attribution** — extend the correlation engine to relate
   per-trade outcomes (return, run-up, MAE/MFE, win) to market features at entry (ATR,
   vol regime, trend strength, time-of-day). Surface only statistically-defensible
   relations (reuse the anti-spurious verdict). **High value; reuses existing rigor.**
3. **Prop Firm Assistant** — Monte Carlo a trade log against a prop-challenge ruleset
   (profit target, max DD, **trailing** DD, daily DD, min days, profit split, payout
   cadence) as a boundary-crossing problem → P(pass), E[days], E[payout], net EV.
   Pure TS over `mathstats.ts` RNG + existing resampling. Standalone, viral, on-mission
   ("don't buy a challenge blind"). **High value, self-contained.**
4. **Robustness verdict (graded, with teeth)** — synthesize the *existing* battery into a
   single honest grade. **Caveat: this cuts against our brand if it implies certainty.**
   Frame as a *robustness* verdict (how likely overfit / how fragile), never a "this will
   make money" score; always show the components and the standing "backtest ≠ live" caveat.
5. **Community publish/clone** — fits the planned Supabase cloud (`docs/research/08`).
   Phase 2/3. Differentiate from QuantPad by sharing *validated, regime-tagged* strategies.

## What NOT to do (deliberately out of scope)

- **All-you-can-eat tick/L2 data.** Capital-intensive infra war; against our local-first,
  BYO-key model. Their moat, not ours.
- **Cloud coding agent that writes/executes arbitrary code.** Our typed JSON DSL + tool-using
  analyst is *safer by construction* and is a genuine differentiator. Don't trade it away.
- **Pine Script generation.** Only revisit if users demand TradingView export; our DSL is the
  authoring surface.

## Positioning takeaways (marketing, not code)

- Their sharpest weapon is a **single concrete cost-shock number** ($1,163.01 vs free).
  Find our equivalent — likely "honest robustness battery others don't have," quantified.
- "Remove the anxiety of X" is their emotional core (data billing). Ours is **"stop fooling
  yourself"** — already our brand; sharpen it.
- They lead with a **founder anti-guru origin story** doing heavy trust work. We compete on
  rigor; make the rigor legible to non-quants (the verdict + regime views help here).
