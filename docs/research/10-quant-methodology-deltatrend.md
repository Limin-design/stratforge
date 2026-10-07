# 10 — Quant methodology notes (DeltaTrend / Thomas Skinner)

> Knowledge harvested from the @deltatrendtrading YouTube catalog (watched June 2026)
> to sharpen StratForge's testing methodology. He teaches the *process* of building and
> honestly validating an algo — which is exactly our brand. This doc captures the method;
> [[09-competitive-quantpad]] captures the product teardown.
>
> Source channel: https://www.youtube.com/@deltatrendtrading
> Status: COMPLETE — all 11 videos processed (watched June 2026). See the prioritized build
> order in "Cross-cutting summary" at the end.

## Videos (processing checklist)

- [x] The Quant Process 01 — How Trading Is Actually Done (13:41) — https://youtu.be/M3-0LfZMsz4
- [x] The Quant Process 02 — Turning Data Into Meaning (27:45) — https://youtu.be/TEVRiSNxs50
- [x] The Quant Process 03 — STOP Sampling EVERY CANDLE (9:48) — https://youtu.be/Zu4sL5u-WyU
- [x] Will Your Trading Strategy MAKE MONEY? (8:24) — https://youtu.be/MCnFrUxZARU
- [x] How To: Monte Carlo Simulation (14:19) — https://youtu.be/jGhk-uSrtII
- [x] Quant Trading: Markov Chains & Steady States (8:29) — https://youtu.be/vQ9n4SaFxHE
- [x] The One Idea Behind All Options Pricing (8:34) — https://youtu.be/AR1CQUCMgnE
- [x] "Build Your Own Trading Strategy" — Ivy League Quant (7:18) — https://youtu.be/fIEwVmJJ06s
- [x] stop trading like an idiot. (9:08) — https://youtu.be/BiTqwX-4rNw
- [x] I Coded Powell Trades' Strategy Pt. 1 (32:16) — https://youtu.be/u8zyK0p3Jek
- [x] I Coded This Daytrading Guru's Strategy — Here's the Truth (10:09) — https://youtu.be/QhGoLgWyUrw

---

## Methodology notes

_(Filled in as each video is processed. Each section ends with **→ StratForge:** implications.)_

### The core thesis — the "institutional workflow" (Quant Process 01)

His whole framework, and the spine of the series. Retail was sold a broken workflow
(buy a public strategy → manual backtest citing only P&L / avg RR / win rate → "fix your
psychology" → "be consistent"). The real, institutional workflow is the inverse:

0. **Idea / feature first — never a public strategy.** A *feature* is anything that might
   have predictive power (volatility, volume, trend, a fair-value gap, even weather).
   **Alpha decay:** once an edge is public it stops working, so a strategy you can buy or
   learn cannot be a winning one. You start where institutions start: with a hypothesis.
1. **Test the feature's predictive power BEFORE building any strategy.** Pull data, compute
   the feature, and measure whether it actually relates to future market behaviour — how
   strong, and *under what conditions it breaks down or thrives*. ML optional. Only if an
   idea shows statistical evidence of edge do you proceed.
2. **Build** an executable strategy around the validated idea.
3. **Validate the edge** — and this is the step retail skips. Bootstrapping + Monte Carlo
   resampling to build the *distribution of possible outcomes* and "alternate timelines" of
   the backtest, then stress-test. The question is not "is backtest P&L positive" but
   "how statistically confident am I, and is this true edge or luck that gets me rinsed live?"
4. **Feature attribution / explainability.** Compute hundreds of features in the background
   and surface the ones statistically correlated with **drawdown, run-up, and P&L** — the
   "invisible factors" (regime, volume, trend, volatility, …) driving trade performance.
5. **Deploy** only with a quantified understanding of risk and expected performance. For
   funded/prop accounts, treat them like institutions do — **structured products with
   probabilistic payoffs** — and Monte-Carlo the pass odds, drawdowns, resets, fees, and EV
   before risking a dollar. (He passed Topstep first try, min days, off a 93%-pass strategy.)

Tone/positioning he hammers: "no prolonged, inexplicable losing — if you're losing, you're
trading something you haven't validated"; hypothesis testing + statistical validation +
data-driven decisions over psychology and guru courses.

**→ StratForge:** This is *our exact thesis*, articulated as a teachable pipeline. Two gaps it
exposes in our current product framing:
- We start at his **step 2** (build a strategy in the DSL). His **step 0–1** — validate a
  *feature's* predictive power before you ever build a strategy — is not a first-class flow
  for us yet. Worth a "feature/idea lab": test an operand/signal's relationship to forward
  returns with the anti-spurious rigor we already have in `correlation.ts`, gated *before*
  strategy construction. Strong differentiator and on-brand.
- His steps 3, 4, 5 map 1:1 onto our roadmap (`docs/research/09`): validation battery (have),
  feature→performance attribution (#2, planned), regime analysis (#1, **shipped**), prop-firm
  EV (#3, basic version exists). Confirms the priority order is right.

### Feature engineering — the full taxonomy (Quant Process 02)

The most StratForge-relevant video. "The appropriate place to start is feature engineering."
A **feature** = raw data collapsed into an idea you care about (a transform of OHLCV: trend
slope, ATR, RSI, distance-to-level, wick %). Goal of trading = use current/past info to find
relationships where *one distribution of future outcomes differs from another under specific
conditions*. Raw OHLCV → bad model; engineered features make the relationship extractable.
"Discretion" is just **mental feature engineering + multidimensional pattern recognition that
was never quantified** — so it's programmable.

**Feature types by VALUE:**
- **Continuous** — ATR, realized vol, RSI, distance-to-SMA/level, VWAP. Usually must be
  **normalized** (see below).
- **Binary / boolean** — flags/events: in RTH? regime mean-reverting? news today? new
  high-of-day? bar > 2×ATR(14)? liquidity swept? FVG tapped? Used to label events.
- **Ordinal** — bucketed ranks: volatility regime 1–5, trend strength weak→strong, news
  impact 1–3. Discrete, >2 levels.

**Feature types by PURPOSE** (this maps directly onto our DSL `process`):
- **Event-defining** → defines which bars are part of the experiment (breakout, earnings,
  session-high sweep). = our `process.trigger`.
- **Contextual** → explains *why the same event behaves differently across situations*
  (volatility regime, trend strength, time-of-day). = our `process.context`. This is also
  exactly what regime analysis + feature attribution surface.
- **Reference** → prior session high/low, 6-mo low, ATH; not fed to the model, used to
  *derive* other features (you can't compute "distance to prev-session low" without it).
- **Outcomes / labels** → what happened after the event; the prediction target. Options:
  **barrier-based** (double/triple-barrier: which of an upper/lower barrier — like TP/SL,
  often ATR-based — is hit first, plus a time barrier), **forward returns** (next N bars),
  or **forward volatility**. = our `process.outcome` (currently metadata-only).

**Build-a-feature logic tree:**
1. What do you care about? (urgency, rejection, regime, distance, imbalance…)
2. What raw data carries traces of it? (price-only vs. needs volume/time/econ/news)
3. What value type? (continuous / binary / ordinal — iterate; e.g. trend as continuous
   slope, or binary trending/mean-reverting, or ordinal −2…+2)
4. What transformation makes the concept explicit?
   - **Normalize** to %/relative so price scale doesn't dominate (raw SMA-slope in $ gets
     wilder as the asset gets more expensive though the *idea* — steepness — is unchanged).
   - **Ratio** — short-ATR / long-ATR captures a "violent breakout" better than two separate
     ATRs (a ratio collapses the relationship you actually care about).
   - **Difference** — price − SMA (then normalize to %).
   - **Encoding** — combine transforms, e.g. a **z-score** of the normalized price−SMA
     distance captures *rarity* (z≈3 → almost never happens; z≈0 → normal).
   - **Always visualize/validate a feature** before trusting it — plot examples, confirm it
     means what you intended.

**The worked validation example (the part we should copy almost verbatim):**
Event = sweep of previous session high/low (wick through, come back). Outcome = ATR-based
**double barrier** (which hit first). Then per case (bullish/bearish):
- Compute **expected value** per case — but "that's just what we observed, could be luck."
- Put a **95% confidence interval** on the true EV. If the CI straddles 0 → "statistically
  indistinguishable from zero." If the CI is entirely negative → significant negative edge.
- **Cross-period stability:** 2023-only made the bearish EV significantly negative; expanding
  to 2022–2025 (512 events) the CI no longer excluded 0. *Same event, different outcomes by
  period* → "that's exactly what contextual features are for." Condition on context (prev-day
  range, wick/body size, regime…) → stats/ML to find the multidimensional relationship → only
  then does real strategy development begin.

**→ StratForge:** This validates our whole direction and hands us a concrete next build.
- **Strong validation of the event-first DSL** (`process.trigger/context/outcome`). His three
  purpose-types ARE our three process fields. Keep that design; it's institutionally correct.
- **Concrete next feature — outcome-label diagnostics** (the gap PROJECT_STATUS §9 itself flags:
  "forward outcome-label analysis remains the next missing piece"). Implement triple-barrier
  labeling (ATR-based TP/SL + time barrier) in `engine`, then report **EV per case with a 95%
  CI** and a **cross-period stability** check (does the CI exclude 0 in-sample vs. on a later
  window?). This is pure TS, deeply on-brand (it's literally "is this edge real or luck?"),
  and it makes `process.outcome` executable instead of metadata.
- **Feature taxonomy for the builder/feature-lab:** offer continuous/binary/ordinal value
  types and the transform toolkit (normalize %, ratio, difference, z-score/rarity) as
  first-class operand transforms. Normalization-by-default for price-scaled operands prevents
  a subtle, common bug (scale drift across time/assets).
- **Feature attribution (#2)** is his "condition on contextual features to explain outcome
  variability" — same thing. Prioritize after outcome-labeling, since labels define the
  outcome that attribution explains.

### Event-defining features & sampling (Quant Process 03)

"STOP sampling every candle." If you try to forecast an outcome at *every bar*, you're
forecasting noise → low accuracy. Define **events** (decision points) so you model something
with a *learnable* outcome. Tread the line: too-frequent events = noise; too-rare events = no
sample size. Event examples: breakout candle, prev-session H/L sweep, opening gaps, volatility
spike / compression→expansion, microstructure (L3) anomalies, cross-asset spread deviations,
news (earnings/CPI/FOMC).

Retail edge comes from one of two things (HFT adds execution): **better data (harder to get)**
or **better interpretation** of common data. Don't chase the most niche event — build a better
*model* (better context features or better-extracted relationship) around a sound one.

**CUSUM event filter (the technique he demos):** classic quant event detector. Accumulate
returns into an up-bucket and a down-bucket; when a bucket exceeds a threshold, mark an event
and reset — a "movement detector." Use an **ATR/volatility-normalized threshold** so you aren't
spammed with events in high-vol regimes (events come out evenly distributed). The threshold is a
sensitivity knob (parameter sweep ↔ event frequency). Crucial framing he repeats: **event flags
are NOT trade signals** — green/red ≠ long/short — they're just timestamps "in scope" for the
study.

Checking *raw* predictive value: forward returns (1/5/20-day) after up/down events as box plots,
**compared against random**. Small samples make medians/shape swing on randomness; and a
trending asset (BTC 2024) makes everything drift positive — so "medians shifted positive" proves
nothing. Averaging all event outcomes together is the naive **univariate** mistake (like
predicting a person's height from country alone, ignoring age/gender/parents' height). The fix is
**contextual/multivariate** conditioning — the next step.

**→ StratForge:**
- **Add a CUSUM event trigger to the engine/DSL.** Today our `process.trigger` events are
  condition-crossings; a volatility-normalized CUSUM "significant move" event is a standard,
  high-value primitive and pairs naturally with the outcome-labeling feature above. Pure TS.
- **Reinforces our event-first guardrail** — `parseStrategy()`/`eventDesignWarnings` already
  reject threshold-only entries with no event trigger. His "don't forecast every bar" is the
  exact rationale; we can cite it in the agent's explanation.
- **Forward-return-by-horizon diagnostics vs. a random/drift baseline** belong in the
  outcome-label feature: when reporting EV/CI per case, always show a random (and
  buy-&-hold/drift) baseline so a bull-market drift can't masquerade as edge.

### EV vs. path dependence — what actually answers "will it make money?" (Will Your Strategy MAKE MONEY?)

Win rate and average RR are the wrong sole metrics — they're collapsed proxies. Two things
actually matter:
- **Expected value** answers "do I make money?" in one number:
  `EV = P(win)·avg_win − P(loss)·avg_loss`, **net of fees**. The mean of the return
  distribution. Positive → profit over many trades; zero/negative → no. But EV alone says
  nothing about the *path* (coin-flip streaks make EV=0 look like profit/loss temporarily).
- **Monte Carlo on the return distribution** answers everything path-dependent that EV and
  win rate can't: equity-path volatility, expected/▸worst drawdown, P(net negative after 40
  trades), P(drawdown > 15% over 1000 trades), the distribution of final balances over a
  year, and barrier problems — P(hit prop DD limit before profit target).

Method: the return distribution is the **uncollapsed source of truth**; win rate (counts each
side) and EV (the mean) are collapses of it. To recover path info, **resample trades with
replacement** to build thousands–millions of alternate equity paths, then read off
probabilities (ending-balance distribution, drawdown/runup probabilities, P(pass) for a
barrier/prop challenge). He also flags **bootstrapping a confidence interval on EV** (ties back
to QP02's "EV per case ± 95% CI").

(Second half of the video is a QuantPad product update — all-in-one workflow, virtual file
system, online AI IDE + community library, ~5–6 wk timeline. Minor; already in [[09-competitive-quantpad]].)

**→ StratForge:** Direct confirmation our core is right and points at small upgrades.
- We already ship EV-first stats (`expectancy`/`expectancyPct`), `tradePathDependence`, and a
  bootstrap Monte Carlo prop-firm pass rate in StatsPanel. His EV formula == our stats. Good.
- **Add a bootstrap confidence interval on expectancy** (we have Sharpe CI, not EV CI). One
  number + its CI is the cleanest honest headline, and it's the same machinery as the
  outcome-label EV/CI from QP02 — build once, reuse.
- **Expand the Monte Carlo report** beyond pass-rate to the full question set he lists:
  P(net-negative after N trades), P(maxDD > X%), final-balance distribution percentiles. This
  is the upgrade path for prop-firm feature #3 and feeds the graded verdict #4.

### Three Monte Carlo methods (How To: Monte Carlo Simulation)

The thesis: "a single backtest is one realization of a stochastic process" — never validate or
reject a strategy on it alone. He motivates with a real case: a backtest up 8.5% whose
per-trade EV has a **90% CI of −0.26% to +0.47% → spans zero**, i.e. statistically
indistinguishable from no edge; MC would have caught it before going live. Three methods, each
with a use/avoid:

1. **Reshuffling (bootstrap) MC.** Draw trade returns from the backtest distribution **with
   replacement**, build thousands of alternate equity paths, read percentiles of
   drawdown/final-equity/runup. Same win-rate/variance/mean, wildly different paths (ordering).
   *Shortcoming:* assumes IID — ignores that trade returns **cluster**.
2. **Regime-switching MC (the important one for us).** Trades aren't independent — clustering
   comes from regime dependence, so ordering carries information. Method:
   a. **Tag each trade with a regime** (one extra column) via a regime algorithm.
   b. Split the trade-return distribution **per regime** (e.g. calm vs. volatile).
   c. Count regime-to-regime transitions across the backtest → build a **Markov transition
      matrix** (P(calm→calm), P(calm→vol), …).
   d. Resample: pick a starting regime, draw a trade from that regime's distribution, then use
      the transition matrix to choose the next regime, draw again, … → a **regime-aware** path
      that **preserves the clustering structure**. (Transition matrix can be estimated from a
      longer history of the same asset.)
3. **Parametric MC.** Fit a continuous distribution (normal / Student-t) to the trade returns
   to capture **fat tails / extremes not observed in the backtest** → probability of ruin, tail
   max-DD/runup. *Avoid for most retail:* stops/targets cap outliers, so you'd never realize an
   unobserved extreme; and don't use if the discrete distribution can't be represented by a
   continuous one.

**→ StratForge:** This is the explicit build plan for our regime feature's next step.
- We already have method 1 (`tradePathDependence`, StatsPanel `monteCarlo`).
- **Method 2 is the natural follow-on to the shipped `regimes.ts`.** We already tag each trade
  with an entry regime. Add: (a) a **Markov transition matrix** over those regime tags, and (b)
  **regime-conditional resampling** that walks the chain and draws from per-regime return
  distributions. This makes our Monte Carlo *clustering-aware* — a real accuracy upgrade over
  IID bootstrap, and it directly connects the regime feature to the robustness battery. (Markov
  chains get their own video, #6 — cross-reference when building.)
- **Method 3 (parametric/Student-t tail MC)** is optional and he himself flags it's usually
  wrong for stop/target retail strategies — low priority, but a "probability of ruin" readout
  using a fitted-t could be a labeled advanced option with his exact caveat shown.
- Reinforces the **graded verdict (#4)**: the headline honesty check is "does the per-trade EV
  CI exclude zero?" — cheap, and the single most damning/clearing number.

### Markov chains & steady states (Quant Trading: Markov Chains & Steady States)

The math behind regime-switching MC. A **Markov chain** = next-state probability depends only on
the current state. Encode it as a **transition matrix** P (rows = current state, entries =
P(→next), each row sums to 1). A **state vector** s (probabilities over states) evolves by
repeated multiplication sₙ₊₁ = P·sₙ. The **steady-state vector** solves (I − P)·s = 0 with
Σs = 1 — where the distribution settles after many transitions; in market-regime terms, the
**long-run fraction of time spent in each regime**, usable for base exposure / portfolio design.

**→ StratForge:** This is the engine for the regime-switching MC (#5 build) and a small,
independently useful readout for the shipped `regimes.ts`:
- Build the **regime transition matrix** from the per-trade (or per-bar) regime tags we already
  produce, then compute its **steady-state vector** and show "long-run % of time in each regime"
  next to the regime breakdown. Cheap pure-TS linear algebra (3–9 states; solve the small
  singular system with the Σ=1 constraint, or just iterate P until convergence).
- Sanity-check signal: if the backtest's *observed* regime mix diverges sharply from the
  steady-state mix, the sample is regime-skewed → another honest "your result may not generalize"
  flag, complementing the concentration warnings already shipped.

### Options pricing (The One Idea Behind All Options Pricing)

Tangential to StratForge but reinforces the through-line. Intuition via the Cybertruck-
reservation analogy: an option's fair value = the **discounted expected value of its payoff over
the distribution of the underlying's future prices**. For a call, payoff = max(0, S − K); fair
value = ∫ P(S)·payoff(S) dS, discounted. Buy when market price < model fair value, sell when >.
"Edge = your distribution estimate is more accurate than the market's."

**→ StratForge:** No options module today, so no immediate action. The transferable principle —
*value is EV over a distribution of outcomes* — is the same idea behind our Monte Carlo and the
prop-firm "structured product" framing. File for if/when options support is ever scoped.

### Build Your Own Trading Strategy (Ivy League Quant)

Mostly reinforces the QP01 thesis with history and one concrete point. Alpha decay told as a
story: pairs trading (Morgan Stanley, 1987, a Columbia CS student, ~$50M; alumni later founded
D.E. Shaw / Two Sigma; the edge got crowded and evaporated). Trading a real edge pushes price
toward fair value, so edges self-destruct as they crowd — markets trend to efficiency. Cites a
paper estimating published edges' returns **decline ~25% after publication** (plus ~10%
statistical bias in such papers). The actionable nugget: **naive analysis finds fake edges by
ignoring slippage and transaction costs**; for public/obvious trades the real moat is *latency*
(HFT). Public-or-for-sale strategy = scam; the only honest path is build-it-yourself from data →
features → test → deploy.

**→ StratForge:** Validates our **execution-realism** stance — we already model fees + slippage
+ spread + carry in `runBacktest`. Sharpen the messaging: "an edge that only survives with zero
costs isn't an edge," and consider surfacing a **cost-sensitivity readout** (how much of the
backtest's EV is eaten by fees/slippage; how the edge degrades as costs rise) — cheap, and a
concrete honesty feature straight from his critique. The ~25% post-publication-decay framing is
good copy for our positioning.

### Prop-firm risk geometry — the detailed model (stop trading like an idiot)

Despite the title, this is the deepest prop-firm methodology video and a direct spec upgrade for
feature #3. Core idea: a prop challenge is a **convex payoff structure** — like a long call.
Your **downside is capped** at sunk fees (challenge fee + activation, e.g. Topstep 50K ≈ $49 +
activation), because a blown account loses *fees, not the notional drawdown*; your **upside
(payouts) is realized**. Consequence: you can have **positive net EV on the prop account even
with a zero- or negative-EV strategy**, by exploiting the payoff shape over many attempts.

**Risk geometry** = win rate × RR (stop tightness vs. take-profit width). Holding **EV per trade
at exactly zero** and varying geometry via Monte Carlo on the challenge barrier problem:
- **Higher win rate + lower RR (wider stop, tighter TP) → higher pass rate.** As the **std dev
  of trade PnL rises, pass rate falls.** Consistent small wins with the occasional larger loss
  beats top-/bottom-ticking (tight stop, wide TP, low win rate — 4:1 RR / 20% win ≈ 37% pass).
- A non-viable zero-EV strategy with the right geometry hit ~40% pass; a slightly +EV opening-
  range-breakout ≈ 50%; his real strategy >90%. Context: **Topstep's 2024 real pass rate ≈
  12.4%** — so geometry alone can 3–4× the average trader.
- **Challenge phase and funded phase need different geometry** — the geometry that passes best
  isn't the one that maximizes payout once funded. **Net EV per account** = E[challenges to
  pass]·challenge_fee + activation_fee, netted against average payout once funded (his example:
  ~$8,900 gross payout, ~$8,600 net).

**→ StratForge:** This is the blueprint to upgrade prop-firm feature #3 well past the current
trade-bootstrap pass-rate in StatsPanel. Build the assistant to report, per challenge ruleset:
- **P(pass)**, **E[challenges-to-fund]**, **E[days-to-pass / to-first-payout]**, and a **net EV
  per account** = `E[challenges]·challengeFee + activationFee − E[payout | funded]` (sign such
  that positive = profitable to attempt).
- Model **challenge phase and funded phase separately** (different rulesets and, ideally,
  different risk geometry), as he does.
- Surface the **risk-geometry diagnostic**: win rate, RR, and **trade-PnL std dev**, with the
  explicit guidance that lower PnL variance / higher win rate improves pass odds — and the honest
  caveat that this is *exploiting payoff convexity, not proof of edge* (a zero-EV strategy still
  makes nothing in a normal account). That caveat keeps it on-brand rather than guru-adjacent.
- Use a **trailing-drawdown-aware barrier simulation** (already noted in `docs/research/09`),
  since Topstep-style trailing DD changes the boundary problem materially.

### Applied capstone: reverse-engineering a guru strategy (I Coded Powell Trades' Strategy Pt. 1)

A 32-min worked example of the whole pipeline on an ICT-style discretionary strategy. Method
worth noting:
- **Good-faith quantification of a discretionary strategy into an explicit decision tree**,
  narrating every assumption forced by ambiguous rules. Quantifying exposed **hindsight bias** —
  the guru re-anchored his Fib inconsistently in replay mode (knowing the future); a rule that
  can't be reproduced live. Structurally, an executable spec forbids that cheat.
- **Modular stateful build**: HTF bias as an emitted **state** (+1 / 0 / −1 from PD-array taps),
  built and tested one module at a time ("saves so much debugging"). Multi-timeframe: 1d bias →
  5m structure → 1m/5m entry trigger.
- **The full pipeline, end to end:** build → initial backtest → optimize → **apply a regime
  filter** → out-of-sample check → reshuffling Monte Carlo → prop-firm barrier simulation →
  verdict. Concrete numbers: the **regime filter cut OOS max drawdown from ≈ −$16k to ≈ −$2k**
  and added ≈ +$4k net PnL (+~1% win rate). On a Topstep $150k account: **22.4% pass**, ~25%
  payout-given-pass, **$206 net EV per account** (net of fees), mean payout ≈ $1,100, ≈10 days
  to payout, and **~55% most-likely outcome = timing out** (low win rate, large winners → slow
  to hit the run-up). Verdict: technically +EV on funded accounts, but "definitely not" worth
  trading live.

**→ StratForge:** Two strong, concrete implications.
- **Regime should be an entry FILTER, not just a diagnostic.** His single most impactful
  optimization was filtering trades by regime, and it slashed OOS drawdown. We shipped regime
  *attribution* (`regimes.ts`); the high-value follow-on is letting a strategy **condition entries
  on regime** — i.e. promote the regime classifier into a DSL `process.context` operand
  (e.g. "only enter when regime ∈ {trending-up}"). That turns our diagnostic into an actionable
  lever and closes the loop with feature-attribution (#2).
- **DSL expressiveness gap surfaced:** his strategy needs **multi-timeframe** inputs and
  **stateful** logic (a bias state machine). Our DSL/engine are single-timeframe and
  largely stateless condition-groups. Worth logging as a roadmap item — advanced users will hit
  this ceiling. (Not urgent; note it, don't chase it yet.)
- Reinforces the **prop-firm report fields** from the previous video (pass %, payout %, net EV,
  time-to-payout, and crucially a **"timeout" outcome bucket** — many strategies neither pass nor
  blow but run out the clock; our sim must model that explicitly).

### Applied capstone 2: the four-pillar build & the buy-and-hold reckoning (I Coded This Daytrading Guru's Strategy)

Reverse-engineers a Justin Worlin (ICT-style) strategy. Two things worth keeping:
- **The four-pillar framework for a programmatic strategy:** (1) **data preprocessing / feature
  derivation** (what features from the raw OHLCV; quantify "nearby" as e.g. within X% of the
  14-day ATR); (2) **signal generation** (the trade-setup attributes / event); (3) **signal
  processing & execution** (when/how to act on the signal); (4) **risk protocol** (TP/SL, enforce
  an RR floor, ATR-based stop buffer). Step zero is *deciphering conversational English into
  pseudo-code* — quantify every qualitative term.
- **The honesty punchline — benchmark against buy-and-hold.** The strategy returned **107%
  (2018–2025)** which "sounds good," but **NASDAQ-100 buy-and-hold returned 311%** — ~3× for
  doing nothing — at **Sharpe 0.165** (his rule of thumb: <1 weak, <0.5 uninvestable) and Sortino
  0.33. 3,500 trades over 7 years (large sample), and he gave the guru a free pass with **no
  commission/slippage**. Cherry-picked clips hide long-run performance.

**→ StratForge:** One cheap, high-impact honesty feature jumps out.
- **Show a buy-and-hold benchmark next to every backtest** — same asset, same window: total
  return, CAGR, Sharpe, max-DD — and a one-line verdict when the strategy underperforms passive
  holding ("you beat nothing — buy-and-hold returned 311% vs your 107%"). This is the single most
  damning, most intuitive honesty check and we don't surface it yet. Pure TS, trivial to add to
  `stats.ts`/StatsPanel, and it feeds the graded verdict (#4). Pair with the **Sharpe rubric**
  (<0.5 uninvestable, <1 weak) for the verdict's wording.
- The **four-pillar framework** is a clean mental model for the Strategy builder's structure and
  for the agent's strategy-design explanations; it aligns with our DSL (features → event/signal →
  execution → `risk`).

---

## Cross-cutting summary — what to build (priority order)

Synthesizing all 11 videos against `docs/research/09` (the QuantPad teardown) and current code:

1. **Outcome-label diagnostics (triple-barrier + EV/CI per case)** — make `process.outcome`
   executable; report EV with a 95% CI and cross-period stability, vs. random/drift baselines.
   (QP02, "Make Money?") — *highest methodological leverage; the core "is it edge or luck?" test.*
2. **Buy-and-hold benchmark + Sharpe rubric in the verdict** — cheapest honesty win; the most
   intuitive damning check. (Daytrading Guru exposé) — *do this first, it's tiny.*
3. **Regime as an entry FILTER + regime-aware (Markov) Monte Carlo** — promote the shipped
   `regimes.ts` classifier into a DSL `process.context` operand, and add a transition-matrix /
   regime-conditional resampling MC + steady-state regime mix. (Powell capstone, Monte Carlo,
   Markov) — *turns the shipped diagnostic into an actionable lever.*
4. **Prop-firm assistant upgrade** — convex-payoff framing; P(pass)/E[challenges]/E[days]/net EV;
   separate challenge vs funded phases; trailing-DD barrier; timeout outcome bucket; risk-geometry
   diagnostic (win-rate / RR / PnL-stddev). (stop trading like an idiot, Powell, Monte Carlo)
5. **Feature lab (pre-strategy idea validation)** + richer feature transforms (normalize/ratio/
   z-score/CUSUM events) and feature→performance attribution. (QP01–03) — *bigger, but it's his
   step 0–1 that we don't have as a first-class flow.*
6. **Cost-sensitivity readout** (EV eaten by fees/slippage) and **roadmap notes**: multi-timeframe
   + stateful DSL are real expressiveness gaps advanced users will hit. (Build Your Own, Powell)

Out of scope, same as `docs/research/09`: all-you-can-eat data infra, a code-writing cloud agent,
Pine Script generation.

