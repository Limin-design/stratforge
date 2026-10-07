# StratForge — Project Status & Handoff

> Read this first. It is the single source of truth for what StratForge is, how it
> is built, the rules you must follow, how to run it, and what is left to do.
> Keep it updated as the project evolves.

_Last updated: 2026-06-23 · Owner: Pedro (solo)_

---

## 1. What StratForge is

A **professional desktop trading-strategy terminal**. It lets a trader design,
backtest, and **honestly stress-test** trading strategies, then analyze them with
the help of a bring-your-own-model AI quant analyst.

Core pillars:

- **Data hub** — load OHLCV from crypto exchanges, keyed multi-asset vendors
  (stocks/forex/crypto), MetaTrader, or any CSV.
- **Strategy builder** — a visual builder (no raw JSON required) over a typed
  strategy DSL.
- **Backtest engine** — realistic costs (fees + slippage) and a full statistical
  **robustness battery** (Deflated/Probabilistic Sharpe, Monte Carlo permutation,
  out-of-sample, walk-forward) so users see whether an edge is real or overfit.
- **Correlation engine** — tests cross-domain factor ideas (e.g. "oil supply vs
  BTC") and flags spurious/coincidental correlations.
- **Pairs / cointegration** — Engle-Granger + spread backtest.
- **AI quant analyst** — multi-provider, analytical (not sycophantic), uses the
  deterministic engine via tools; never does the math itself.
- **Charting** — candles, indicators, drawing tools, trade markers, equity curve,
  and a risk/reward box.

The guiding value: **honesty about overfitting is non-negotiable.** The product
exists to stop traders fooling themselves.

---

## 2. Stack & repo layout

pnpm monorepo, **TypeScript only** (see rule in §3).

```
apps/
  web/        Vite + React 18 + TS — the entire UI. Runs in a browser (dev) OR
              inside the Tauri webview (desktop). All panels live here.
  desktop/    Tauri 2 (Rust shell) → packages the web app as a Windows .exe.
packages/
  dsl/        zod strategy schema. Exports StrategySpec, parseStrategy, INDICATOR_LINES.
  engine/     pure-TS quant engine (no UI). See §6.
  data-import/  kline + CSV parsing and candle validation.
docs/research/  the deep-dive research that informed the build (read for rationale).
```

Key web source files (`apps/web/src/`):

| File | Purpose |
|---|---|
| `store.ts` | **Workspace-scoped pub/sub store** shared by every panel/pop-out. State is isolated per workspace/chat id (`candles`, `datasetName`, `result`, `spec`, `customStats`) while all tabs in that workspace stay in sync. |
| `App.tsx` | App shell: left icon rail + dockview tabs + topbar + statusbar + layout persistence. Registers all panels. |
| `theme.ts` / `theme.css` | CSS-variable theming. Default palette = **Slate**. Presets switchable in Settings. |
| `components/PanelErrorBoundary.tsx` | Panel-level crash isolation so one panel runtime error doesn't blank the whole workspace. |
| `chats.ts` | Multi-chat history (localStorage), kept in sync between the Agent tab and Profile. Includes quota-recovery compaction + warning, plus targeted per-chat saves for async-safe agent writes. |
| `usage.ts` | Token + data-volume meter for the Profile dashboard. |
| `csv.ts` | Generic OHLCV CSV importer (see §5). Includes sync + async-yield parsing paths. |
| `agent/llmClient.ts` | Dependency-free OpenAI-compatible agentic loop. Multi-provider + Azure adapter. Routes through Tauri HTTP in desktop, browser `fetch` otherwise. Per-request timeout guard added to avoid hangs. |
| `agent/config.ts` | Workspace-scoped agent provider/model preferences (`baseUrl`, `model`) with legacy migration from the old global key and `storage`-event bridging for cross-tab updates. |
| `agent/tools.ts` | Agent tools: `get_context`, `load_data`, `backtest_and_validate`, `optimize_strategy`, `assess_regimes`, `assess_outcomes`, `assess_correlation`, `assess_prop_firm`, `add_stat`. `get_context` returns the **full input contract** (indicators+lines, operand kinds, condition ops, the event-trigger rule, risk constraints) so the model builds valid specs first-try; `backtest_and_validate`/`optimize_strategy` **enforce the event-trigger rule** (≥1 crossing) via `requireEventTrigger`, returning an actionable error the model self-corrects from — mirroring the builder. |
| `agent/persona.ts` | The analyst's system prompt (analytical, blunt, anti-overfit, flags illegal activity). |
| `agent/vault.ts` | Zero-knowledge key vault (Web Crypto, PBKDF2 + AES-GCM), persisted per workspace/chat with legacy migration and cross-tab subscription updates. |
| `cloud/supabase.ts` | Dependency-free Supabase REST client (auth + layout/vault sync). |
| `panels/rrBox.ts` | lightweight-charts series primitive that draws the risk/reward box. |
| `panels/ChartPanel.tsx` | Chart workbench with per-workspace micro-state persistence (manual indicators, drawing tools, drawings) and keyboard-first shortcuts. |

Panels (`apps/web/src/panels/`): Chart, Strategy, Stats, Data, Agent,
Correlation, Pairs, Cloud, Referral, Profile, Settings.

---

## 3. Non-negotiable conventions (do not break these)

1. **TypeScript-only stack.** Do **not** add Python services or TA-Lib/Pandas
   backends. The engine is pure TS. (Pedro's own "Python backend" suggestion was
   declined for this reason.)
2. **Key security.** API keys are masked the instant they're typed and never shown
   again; only the currently-selected source is displayed. The **AI key** is stored
   zero-knowledge (encrypted on-device via the vault; passphrase never stored).
   Exchange/data keys are in-memory only. **Never log secrets.**
3. **No moralizing about legal trading,** but the agent **must** flag illegal
   activity (insider trading, market manipulation). It must be analytical and
   **never sycophantic**; it gives advice at the end, straight to the point.
4. **Honesty about overfitting is mandatory** in any analysis or copy.
5. **Never expose internal/scratch file paths** to the user.
6. **Communication style:** Pedro wants blunt, direct, analytical pushback over
   validation. Keep responses concise.
7. **Flag anything not good enough (Pedro's standing rule).** Every time you notice
   something weak, fragile, confusing, or improvable — report it and propose a
   concrete fix — **as long as raising or doing it doesn't break or destabilize
   anything else.** Never let mediocrity pass silently. Record it in §8.
8. **Verify before you claim "done."** Run `pnpm --filter @stratforge/web typecheck`;
   test pure logic with `node --experimental-strip-types`. State plainly what you
   verified and what you could not — much of the UI is written without a compiler in
   the loop, so don't assert something works when you couldn't check it.
9. **Keep this doc current.** When you change architecture, add a feature, fix a
   listed bug, or remove a constraint, update `PROJECT_STATUS.md` in the same change.
10. **Small, verifiable changes; stay dependency-free.** Preserve the existing
    dependency-free patterns; don't add heavy deps without a clear reason. Keep the
    workspace-store contract (§2): tabs/pop-outs inside one workspace stay synced,
    while different chat workspaces stay isolated.

---

## 4. How to run

**Dev (the working path today): run the web app in a browser.**

```
pnpm install
pnpm --filter @stratforge/web dev      # open the printed localhost URL
```

**Desktop (Tauri):**

```
pnpm --filter @stratforge/desktop dev:desktop      # dev window
pnpm --filter @stratforge/desktop build:desktop    # NSIS .exe
```

⚠️ The desktop build compiles Rust and **requires Visual Studio Build Tools with
the "Desktop development with C++" workload** (provides `link.exe`). That is **not
installed on the dev machine yet**, so `tauri dev`/`build` fails with
`linker 'link.exe' not found`. Until it's installed, develop via the web path
above. Azure and the other providers are reachable from the browser, so this is
fine for development.

---

## 5. Data sources (DataPanel)

- **Crypto exchanges** (public klines, key optional): Binance, Bybit, OKX, Coinbase.
- **Keyed multi-asset vendors** (one key unlocks stocks + forex + crypto):
  Twelve Data (`/time_series`), Polygon (`/v2/aggs`). Polygon symbols are
  auto-normalized (`EUR/USD`→`C:EURUSD`, `BTC/USD`→`X:BTCUSD`).
- **MT5 file** — MetaTrader "Export Bars".
- **CSV file** — generic OHLCV auto-detector (`csv.ts`). Handles: comma/semicolon/
  tab/pipe; named, MetaTrader bracketed (`<DATE>`), or no header; epoch s/ms/µs/ns,
  ISO, `YYYY.MM.DD`, `DD.MM.YYYY`, compact `YYYYMMDD[HHMMSS]`, and **split
  date+time columns**; decimal point or comma. Verified against Binance dumps,
  MT4/5, NinjaTrader, Dukascopy, Yahoo.

All loads normalize time to **UTC seconds** and cap to the most recent **250k bars**
to stay responsive. Not yet supported: JSON klines, tick/quote data, binary formats.

The API-key UI is intentionally **generic** (no provider-specific names, "required"
tags, or signup links) — the goal is the broadest, simplest experience.

---

## 6. Engine (`packages/engine/src/`)

| Module | What it does |
|---|---|
| `indicators.ts` | 11 indicators (SMA, EMA, RSI, MACD, Bollinger, ATR, Stochastic, ADX, OBV, VWAP, MFI), multi-line aware. |
| `backtest.ts` | Execution-realism backtest (fees, slippage, position sizing, stop/target). Returns `{ stats, trades, timeline }`. |
| `stats.ts` | Performance metrics (return, CAGR, win-rate, max-DD, profit factor, payoff, Sharpe, Sortino, Calmar, expectancy, exposure) plus entry-event diagnostics (clustering, loss streaks, single-trade dominance). Also `buyAndHoldStats` + `relativeVerdict` + `sharpeLabel` — the buy-and-hold benchmark honesty check. |
| `mathstats.ts` | normalCdf/normalPpf + `mulberry32` seeded RNG. |
| `robustness.ts` | Deflated/Probabilistic Sharpe, Monte Carlo permutation, out-of-sample, walk-forward, and trade-path drawdown dependence. |
| `regimes.ts` | Regime classification (trend × volatility) + per-regime trade attribution, with profit/loss-concentration warnings. Also `buildRegimeTransitionModel`/`steadyStateVector`/`regimeAwareMonteCarlo` — a Markov transition matrix over per-trade regime tags + clustering-aware Monte Carlo (vs. the IID `tradePathDependence`). Surfaces regime-dependent (overfit) edges. |
| `conditions.ts` | Shared condition evaluator (`evalCondition`/`operandSeries`/`buildIndicatorContext`/`triggerEventBars`) extracted from `backtest.ts` so a trigger can be evaluated over candles without a full backtest. Also evaluates executable regime context filters (`kind:"regime"`) using the same classifier as `regimes.ts`. |
| `outcomes.ts` | Outcome-label diagnostics: `tripleBarrier` (ATR-based TP/SL/time, no look-ahead), `expectancyWithCI` (bootstrap 95% CI on EV/event), and `outcomeReport` (EV/CI vs. random-entry + market-drift baselines + first/second-half stability). The "edge or luck?" test. |
| `propfirm.ts` | Prop-firm challenge/funded-account simulator: seeded trade bootstrap or regime-aware Markov sampling, static/trailing/daily drawdown barriers, timeout bucket, expected days/challenges, first-payout estimate, net EV after fees, and risk-geometry diagnostics. Caveat is explicit: pass odds exploit payout/risk convexity, not proof of live edge. |
| `verdict.ts` | Composite robustness verdict: weighted grade A–F / score 0–100 over Deflated/Probabilistic Sharpe, permutation p-value, OOS degradation, walk-forward consistency, path-dependence, buy-and-hold, event EV CI, regime concentration, and low-weight prop geometry. Guardrail: grades robustness/fragility, not future returns. |
| `features.ts` | Feature Lab primitives: normalized transforms (`normalizePct`, `ratio`, `difference`, `zscore`), volatility-normalized `cusumEvents`, declarative `FeatureSpec`/`featureSeries`, and `featureAttribution` over triple-barrier outcome labels using the anti-spurious correlation verdict. |
| `tradelog.ts` | Bring-your-own trade-log analyzer: parses CSV trades, aligns entries/exits to loaded candles, attributes PnL by entry regime/session/tag/feature bucket, exposes engine-compatible trades for prop-firm Monte Carlo, and keeps the caveat that this diagnoses execution history rather than proving an edge. |
| `correlation.ts` | Anti-coincidence correlation verdict (real / weak / likely-spurious / insufficient-data). |
| `optimize.ts` | Walk-forward optimization. |
| `cointegration.ts` | Engle-Granger (1% critical value −3.9) + half-life sanity. |
| `pairs.ts` | Spread/pairs backtest. |
| `factors.ts` | Factor operand parsing + alignment. |

Honest caveat baked into the docs: **no single statistical test eliminates false
positives** — the robustness battery reduces, not removes, the risk.

---

## 7. Known gotchas

- **Desktop build needs MSVC Build Tools** (see §4).
- **Azure (three surfaces, all handled by `resolveChatEndpoint` in `llmClient.ts`):**
  classic Azure OpenAI `/openai/deployments/<name>` → `api-version=2024-10-21` (`model` =
  deployment name); new Azure OpenAI `/openai/v1` → `api-version=preview`; **Azure AI Foundry
  model-inference** `https://<res>.services.ai.azure.com/models/chat/completions` →
  `api-version=2024-05-01-preview` (`model` = the served model, e.g. a DeepSeek deployment). All
  authenticate with the `api-key` header (not Bearer). An explicit `?api-version=` in the URL
  wins; the resolver never double-appends `/chat/completions`. Detection matches both
  `*.openai.azure.com` and `*.services.ai.azure.com`. Verified by `smoke:llm-endpoint`.
- **CORS:** OpenRouter, local servers (Ollama/LM Studio), Twelve Data and Polygon work from the
  browser. **Azure does NOT** — its data-plane endpoints (classic OpenAI and the
  `services.ai.azure.com` Foundry inference surface) don't return `Access-Control-Allow-Origin`
  for a `localhost` origin, so under `pnpm dev` (`window.fetch`) an Azure chat fails with
  "Failed to fetch". For providers that don't send CORS headers, the **desktop build** routes
  through `tauri-plugin-http` (Rust side, CORS-free) via `pickFetch()`. Until the desktop build
  exists (blocked on MSVC Build Tools, §4), browser-dev Azure needs a Vite dev proxy
  (same-origin → server-side forward). Not yet added.
- **Sandbox testing of engine code:** pnpm workspace symlinks don't resolve in the
  sandbox and the bash mount can serve stale copies of just-edited files. Verify
  pure-TS logic by running `node --experimental-strip-types` on a copied/heredoc'd
  standalone version (that's how `csv.ts` was validated against 10 formats).
- **Vite dev does not typecheck** (esbuild strips types). A TS type error won't
  block the running app; run `pnpm --filter @stratforge/web typecheck` to catch them.
- **Web Crypto + TS 5.7+/6.x:** `Uint8Array` is now generic; a plain `Uint8Array`
  (`<ArrayBufferLike>`) is **not** a `BufferSource`. Pass ArrayBuffer-backed arrays
  or cast (`x as BufferSource`) when calling `crypto.subtle.*`. (Was the `vault.ts` bug.)

---

## 8. Known flaws, risks & open bugs

> Honest list — keep it current: move fixed items out, add new risks in.
> **Standing rule (Pedro):** if you spot something not good enough, surface it here
> and in your reply with a concrete fix, whenever doing so won't break anything else.

**Infra / process** _(from the §10 doc-14 system-design audit; updated 2026-06-28)_
- **Version control: DONE.** Repo initialized (first commit `3bef51b`). Add a private remote
  when ready.
- **CI: DONE.** `.github/workflows/ci.yml` runs `pnpm -r typecheck` + engine & web `smoke`
  suites + web `build` on push/PR; verified green locally. Building it surfaced two latent
  failures that had been invisible (below).
- **`tsc` was already broken (now fixed).** 7 pre-existing type errors (regime/comparison
  condition union not narrowed in the `else` branch) meant `tsc --noEmit` — and therefore the
  `build` script — was silently failing. Fixed via an `isRegimeCond` type guard in
  `strategyBuilder.ts`. Lesson: Vite dev not typechecking means **only CI catches this** —
  keep it green.
- **A smoke test was silently failing (now fixed).** `strategy-optimize-smoke.ts` used a
  `Builder` fixture missing the later-added `event` field; it threw on run but nobody ran it.
  Fixture updated. (`scripts/` sits outside the `tsc` include, so the compiler didn't flag it.)
- **Vault is now regression-locked.** New `pnpm --filter @stratforge/web smoke:vault` proves
  encrypt/decrypt round-trip, wrong-passphrase + tamper rejection, non-determinism, and
  no-plaintext-leak. The zero-knowledge path was the least-tested code; no longer.
- **Usage meter under-reporting fixed.** `recordTokens` (which also counts requests) only fired
  when the provider returned `usage`, so tokens **and** request count were under-counted. Now
  every request is counted; absent-usage requests record an honest estimate flagged as estimated
  (`Usage.estimatedTokens`, surfaced in ProfilePanel).
- **XSS: verified clean.** No `dangerouslySetInnerHTML`/`innerHTML`/`eval`/`new Function` in
  `apps/web/src`; React escapes all rendered text. CSP headers still worth adding as defence in depth.
- **Observability — client side DONE.** `apps/web/src/telemetry/` adds a dependency-free,
  privacy-first error tracker: global handlers + panel-boundary capture, mandatory secret/PII
  scrubbing (`scrub.ts`) before any store/show/forward, a bounded on-device buffer shown in
  Profile → Diagnostics, and a pluggable sink that is **off by default** (nothing leaves the
  device). Scrubber tested like the vault (`smoke:scrub`). **Still open:** point the sink at a
  Supabase Edge Function + secret-free server logs once the backend is deployed.
- **Heavy persistence → IndexedDB: DONE.** `chats.ts` now caches in memory (sync API unchanged),
  stores full fidelity in IndexedDB (`idbStore.ts`), and keeps only a compacted localStorage copy
  for fast boot + fallback. Boot merges the two with no session loss (`mergeChatsById` in
  `chatsMerge.ts`); first run migrates existing localStorage history into IDB. Covered by
  `smoke:chats`. **Caveat:** the raw IDB I/O is typecheck + defensive-wrapper verified but not yet
  browser-runtime verified — do one manual click-through before fully relying on it.

**Verification debt**
- The web/UI layer still has limited automated tests and Vite dev does not typecheck,
  so regressions can slip in silently. Much of the UI was written without a compiler in
  the loop — run `typecheck`/`build` to surface latent type errors.
- Targeted web smoke checks exist now for CSV parsing, workspace/chat isolation, and
  chart-drawing geometry (`pnpm --filter @stratforge/web smoke:csv`,
  `smoke:isolation`, `smoke:chart-drawings`), but broader UI behavior remains mostly
  untested.
- `panels/rrBox.ts` (risk/reward box) was built against the lightweight-charts
  primitive typings, **not runtime-verified**. It's wrapped defensively (won't crash
  the chart) but could silently not render if the API contract differs.

**Chart drawing subsystem (`panels/ChartPanel.tsx` + `panels/chartDrawingUtils.ts`)**
- All pure geometry/transform logic is centralized in `chartDrawingUtils.ts` and
  unit-tested by `scripts/chart-drawings-smoke.ts`: clamp, ray-step, hit-tolerance,
  rect-loop, segment-order, move-translate, ray builder, no-op-rollback, and the
  endpoint-resize orchestration (via injected coordinate converters). Preview↔commit
  geometry parity is **structural** for rect and trend (both paths share one builder)
  and was already structural for rays. The panel holds only thin chart-bindings over
  this tested layer.
- Two real bugs were fixed here and are regression-locked by smoke: (1) hit tolerance
  spiked to its max at the chart's right edge when adjacent-candle coords collapsed to
  the same pixel — now guarded by `measuredCandleSpacingPx`; (2) a no-op drag wiped the
  redo stack (the speculative `pushUndoSnapshot` cleared redo, and only undo was popped)
  — now restored via `rollbackNoopDrawingDrag` with a captured pre-drag redo snapshot.
- The endpoint-resize rect-corner clamp is covered by passing stub `toCoord`/`fromCoord`
  converters to `clampRectCornerWithCoords`, exercising the null-coord guards and the
  pixel-clamp round-trip without a live chart. Remaining chart-coupled surface (live
  pointer→commit event wiring) is integration-level and still only typecheck-verified.

**Architecture / data**
- **Workspace-scoped store isolation is now live.** Runtime state is separated by
  workspace/chat id (`candles`/`result`/`spec`/`customStats`), and switching chats swaps
  workspace state across Chart/Strategy/Stats/Data.
  (Recent improvements: dataset loads still clear stale custom stats and reset
  agent multiple-testing counters per workspace; DataPanel loads are now sequence-guarded
  per workspace to prevent stale async overwrites.)
- **Multi-chat history now persists to IndexedDB** (full fidelity, including large tool-result
  JSON), with a compacted localStorage copy kept only for fast boot + fallback — so the ~5MB
  localStorage quota is no longer the binding constraint. `chats.ts` caches in memory (sync API
  unchanged), merges the localStorage + IDB copies on boot with no session loss, and migrates
  existing localStorage history into IDB on first run. AgentPanel still writes by explicit chat id
  during async runs to avoid cross-chat races; cross-device sync remains the cloud follow-up.
  **Chart micro-state persistence still uses localStorage** (`stratforge.chartui.workspaces`) — a
  candidate to move to IDB next if it grows. IDB I/O itself is not yet browser-runtime verified
  (see Infra/process above).
- **Data-source keys are in-memory only** (cleared on reload); the AI key is vaulted and now scoped per workspace/chat.
- **Layout persistence** isn't hardened against panel-id changes.
- Panel-level error boundaries are now in place (`components/PanelErrorBoundary.tsx`),
  so one panel crash no longer takes out the full workspace. Recovery is currently
  app reload (per-panel retry can be added later).

**Data import / providers**
- CSV import now has an async yielding path (`parseCsvCandlesAsync`) used by the UI,
  so long parses no longer hard-freeze the app as badly. It still reads whole files
  into memory first (no streaming/worker yet). Slash dates (`MM/DD` vs `DD/MM`) are
  resolved by heuristic and can misparse genuinely ambiguous cases.
- Twelve Data / Polygon integrations are written from docs, **not live-tested**.
  They now have stricter response-shape checks, request timeout/retry handling,
  and explicit rate-limit messages, but live vendor quirks can still surface.
  Polygon's free tier is delayed/limited and uses a fixed lookback window.
- **CORS:** in browser dev some providers may block; the CORS-free path needs the
  desktop build (blocked on MSVC Build Tools).
- Token usage is only counted when the provider returns a `usage` block, so the
  Profile meter can under-report.

**Misuse-resistance / quant workflow**
- Stats and Strategy now surface EV-first metrics (`expectancy`, `expectancyPct`,
  win probability, payoff), trade-path drawdown dependence, entry clustering, loss
  streaks, and single-trade dominance. The agent tool injects the same warnings and
  always reminds users that fresh-data validation is still required.
- Event-first workflow is now first-class in the DSL and builder: `StrategySpec.process`
  carries a plain-English thesis, an explicit sampled event trigger, optional context
  filters, and an optional forward outcome horizon. The visual builder edits that
  process directly and generates executable `entry = process.trigger + process.context`.
  `parseStrategy()` rejects specs where `entry` diverges from the declared process.
- Regime filters are now executable context. DSL conditions can include
  `{kind:"regime", axis:"trend", in:["up"|"down"|"range"]}` or
  `{kind:"regime", axis:"volatility", in:["low"|"normal"|"high"]}`; `runBacktest`
  evaluates them at bar close with the same classifier used by regime attribution, and the
  Strategy builder exposes a simple regime-filter row. This is a tradeable context filter,
  not an event trigger, so the crossing-event rule still stands.
- Prop-firm simulation now replaces the old simplistic pass-rate box. `engine/propfirm.ts`
  models challenge pass/fail/timeout separately from first funded payout, supports static vs.
  trailing drawdown and daily drawdown, reports net EV after fees, and surfaces risk geometry
  (win rate, avg RR, PnL stddev). It also supports regime-aware sampling: trades are bucketed
  by entry regime, a Markov transition matrix is learned from historical regime order, and each
  simulated prop path walks that chain instead of pretending trades are IID. StatsPanel and the
  `assess_prop_firm` agent tool both show the standing caveat: this is convex payout/risk geometry,
  not evidence of live edge.
- A composite robustness verdict now exists in `engine/verdict.ts` and is surfaced in both
  `backtest_and_validate` and StatsPanel. It replaces the old heuristic readiness banner with a
  transparent grade + score + component breakdown. It explicitly grades fragility evidence, not
  profitability or future returns, and always carries the backtest/live caveat.
- Feature Lab now exists as a pre-strategy research flow. `engine/features.ts` supplies safe,
  declarative feature transforms, CUSUM event sampling, and feature→outcome attribution using the
  anti-spurious correlation verdict. `assess_feature` exposes the same workflow to the analyst, and
  `FeatureLabPanel` gives users a direct UI to sample CUSUM events, triple-barrier label them, and
  inspect which default features have defensible forward-outcome relationships. Guardrail: a real
  feature is only a research lead, not a tradable edge until it survives OOS validation.
- Trade Log Analyzer now exists for the BYO-data workflow. Users import their own executed-trade CSV
  after loading matching candles; `engine/tradelog.ts` aligns trades to candles and reports PnL by
  regime, session, setup/tag, and feature bucket, plus a prop-firm read from the imported trade list.
  This is deliberately data-license-light: IAQ supplies math/context, not broker/vendor data.
- The engine executor still runs the combined `entry` condition group, and `process.outcome` is
  not used to *drive execution*. But **outcome-label diagnostics now exist** as a separate research
  pass (`engine/outcomes.ts` / `assess_outcomes` / StatsPanel "Event outcomes"): the trigger is
  evaluated over candles and labelled with a triple barrier to test EV/CI vs. baselines. Wiring
  `process.outcome.horizonBars` into those diagnostics as the default horizon is a small follow-up.
  Agent/tool warnings still flag missing thesis/context/stops and threshold-only triggers.
- Trade-path dependence permutes realized trade PnL order to stress drawdown sequence
  risk. Final return is invariant under pure reordering, so the score intentionally
  focuses on drawdown dispersion, not return dispersion.

**Behavioural**
- `specToBuilder` round-trips agent strategies structurally; an unexpected operand
  shape could render oddly or lose data on re-save — verify when touching the DSL.
- A strategy with many non-overlay indicators creates many chart panes (cramped).
- Adding a new data source means also updating the `isCrypto`/`isVendor` sets in
  `DataPanel`, or the wrong controls render.
- Cointegration/correlation verdicts are heuristic — **no test removes false
  positives**; don't let the UI imply certainty.

---

## 9. Pending / roadmap

- **Competitor-driven features** (from `docs/research/09`, QuantPad teardown). Four gaps
  that fit our TS-only / anti-overfit constraints, in priority order:
  1. **Regime analysis** — ✅ SHIPPED. `engine/regimes.ts` classifies bars (trend × vol),
     attributes trades to entry-regime, and warns on profit/loss concentration. Wired to the
     `assess_regimes` agent tool and a Stats-panel "Regime breakdown" section; analyst persona
     instructed to call it after a promising backtest. Verified: engine typecheck +
     `scripts/regimes-smoke.ts` (two engineered regimes). Next on this feature: optional
     regime-aware Monte Carlo (re-use the classifier in `robustness.ts`).
    2. **Feature → performance attribution** — ✅ SHIPPED. `engine/features.ts` relates event outcome
      labels to entry-time market features and reuses the anti-spurious correlation verdict.
    3. **Prop Firm Assistant** — ✅ SHIPPED. Monte Carlo a trade log vs a prop-challenge ruleset
      (target, max/trailing/daily DD, payout split) → P(pass), E[days], net EV; upgraded with
      regime-aware Markov sampling.
    4. **Graded robustness verdict** — ✅ SHIPPED. Synthesizes the existing battery into one honest
      grade (robustness/fragility, never a returns promise; always show components + caveat).
  Deliberately out of scope: all-you-can-eat tick/L2 data and a code-writing cloud agent.
- **Methodology-driven build order** (from `docs/research/10`, the DeltaTrend YouTube harvest —
  re-ranks the gaps above against the actual quant workflow). Highest leverage first:
  1. **Buy-and-hold benchmark + Sharpe rubric** — ✅ SHIPPED. `engine/stats.ts` adds
     `buyAndHoldStats` / `relativeVerdict` / `sharpeLabel`; `backtest_and_validate` returns a
     `benchmark` block (beatsBuyHold + excess return/Sharpe) and pushes the underperformance note
     into warnings; StatsPanel shows a strategy-vs-buy&hold table + verdict banner; persona leads
     with it when the strategy loses to passive holding. Verified: engine+web typecheck +
     `scripts/benchmark-smoke.ts`.
  2. **Outcome-label diagnostics** — ✅ SHIPPED. `engine/outcomes.ts` (triple-barrier + bootstrap
     EV/CI + random/drift baselines + first/second-half stability), fed by the trigger evaluated via
     the extracted `engine/conditions.ts`. Surfaced as the `assess_outcomes` agent tool + a StatsPanel
     "Event outcomes" box; persona calls it for the event-level "edge or luck?" check. Verified:
     engine+web typecheck, `scripts/outcomes-smoke.ts` (planted edge → CI excludes 0; noise → spans
     0; no look-ahead), and `scripts/demo.ts` confirms the `backtest.ts` refactor is behavior-neutral.
  3. **Regime as an entry filter + regime-aware (Markov) Monte Carlo** —
     • **3a SHIPPED:** DSL regime context filters now execute in `backtest.ts` via the shared
       condition evaluator and `classifyRegimes`; Strategy builder can add a regime filter; agent
       tool contract documents the regime filter shape. Verified: engine+web typecheck,
       `scripts/regime-filter-smoke.ts`, and `scripts/demo.ts` behavior sanity.
     • **3b SHIPPED:** `regimes.ts` `buildRegimeTransitionModel`/`steadyStateVector`/
       `regimeAwareMonteCarlo` (Markov matrix over per-trade regime tags + regime-conditional
       resampling + steady-state), surfaced in the `assess_regimes` tool. Verified: engine+web
       typecheck, `scripts/regime-mc-smoke.ts` (rows sum to 1, known 2×2 steady state ≈ [⅔,⅓],
       percentiles ordered).
      4. **Prop-firm assistant upgrade — ✅ SHIPPED** — `engine/propfirm.ts` adds the convex-payoff
        simulator with challenge vs. funded first-payout phases, static/trailing/daily DD barriers,
        timeout bucket, P(pass), E[days/challenges], net EV after fees, and risk-geometry diagnostic.
        Follow-up shipped real regime-aware prop sampling: when candles are supplied, it classifies
        trade entry regimes, learns the Markov transition matrix, and samples regime-conditioned PnL
        buckets along that chain. Surfaced in StatsPanel and the `assess_prop_firm` agent tool; persona
        must lead with net EV, pass probability, timeout risk, and the convexity-not-edge caveat.
        Verified: engine+web typecheck and `scripts/propfirm-smoke.ts` (high-win/lower-variance zero-EV
        toy beats lumpy zero-EV toy; buckets sum to 100; trailing DD changes pass odds; regime-aware
        sampling enables on classified multi-regime trades and changes pass odds vs IID bootstrap).
     5. **Graded robustness verdict — ✅ SHIPPED** — `engine/verdict.ts` exposes
       `robustnessVerdict()` returning grade A–F, score 0–100, weighted component breakdown, and
       caveats. `backtest_and_validate` returns this composite verdict and the analyst persona must
       lead with it. StatsPanel now shows the same verdict instead of the old heuristic readiness
       score. Verified by `scripts/verdict-smoke.ts` once validation is run.
     6. **Feature lab — ✅ SHIPPED** — `engine/features.ts` adds normalized transforms,
       volatility-normalized CUSUM events, declarative feature specs, and `featureAttribution()`
       over triple-barrier labels using the anti-spurious correlation verdict. Surfaced as the
       `assess_feature` agent tool and a new Feature Lab panel. Verified: engine+web typecheck and
       `scripts/features-smoke.ts`.
      7. **Trade Log Analyzer — ✅ SHIPPED** — `engine/tradelog.ts` parses user CSV trade logs,
       aligns them to loaded candles, attributes execution by market context (regime/session/tag/
       feature bucket), and reuses the prop-firm simulator on imported real trades. Surfaced as a
       Trade Log panel. Verified by `scripts/tradelog-smoke.ts` once validation is run.
    Roadmap notes from the same harvest: multi-timeframe + stateful DSL are real expressiveness gaps.
  - **BYO-data market context roadmap** (Pedro's licensing constraint): IAQ should avoid becoming a
    licensed data vendor. Build importers/math around user-provided data instead.
    1. **Private Strategy Library / project templates — NEXT.** Save/clone strategies with validation
      snapshots (verdict, benchmark, OOS, regime concentration, feature report). This is needed before
      a public community space.
    2. **Public community space requirements.** Needs cloud backend, accounts/profiles, project schema,
      versioned strategy artifacts, moderation/reporting, abuse controls, license/visibility settings,
      fork/clone lineage, comments/likes/favorites, search/tags, and clear risk disclaimers. Do not ship
      public sharing before security, moderation, and IP/licensing rules are explicit.
    3. **Market Data Context Layer.** BYO FRED macro CSV/import, BYO SEC/XBRL facts importer, futures
      continuous-contract tooling, exchange/session calendars, and instrument metadata (asset class,
      exchange, session hours, tick size, point value). No paid redistribution obligation.
    4. **Multi-DSL export/linting — MUST.** Keep IAQ DSL as source of truth, then export supported subsets
      to PineScript first, later NinjaScript/EasyLanguage/PowerLanguage. Add lint/static checks where
      possible and warn that venue execution can differ.
    5. **BYO options analytics.** Users provide option-chain data; IAQ supplies the math/graphs only:
      IV surface, term structure, skew/smile, put/call ratio, expected move, IV rank/percentile, and
      payoff/Greek visualizers. Avoid full options backtesting until data quality and contract metadata
      are reliable.
- **Cloud backend** (Supabase + Stripe + R2): full plan in `docs/research/08`. A
  Phase-A scaffold exists (auth + layout/vault sync in `cloud/`), not deployed.
  Multi-chat history + usage will sync here later.
- **Persist data-source keys** in the vault (currently in-memory, cleared on reload).
- **More importers:** JSON klines, and a tick→bar aggregator.
- **P0 state isolation shipped:** `store.ts` now scopes runtime state by
  workspace/chat id, agent tools run against explicit workspace context, and
  switching chats swaps workspace state across Chart/Strategy/Stats/Data.
  This pass also adds chart micro-state persistence per workspace in `ChartPanel`
  (manual overlays, selected drawing tool, and drawings), plus async race hardening:
  DataPanel dataset loads are sequence-guarded per workspace, AgentPanel persists
  run output to explicit chat ids during long runs, provider/model preferences
  are now workspace-scoped (`agent/config.ts`) instead of one global setting,
  and vaulted AI keys are stored per workspace/chat (`agent/vault.ts`).
  Agent provider/vault metadata now propagates across browser tabs via
  `storage`-event subscriptions (Agent + Profile stay coherent).
- **UI polish** toward institutional workflows: this batch added Strategy quick-start
  presets + stronger input guards and a KPI scorecard in Stats, then phase-1
  keyboard-first shortcuts in Chart (V/H/T/I/Delete), Strategy (Ctrl/Cmd+Enter,
  Alt+J), Data (Ctrl/Cmd+Enter), and Agent (Ctrl/Cmd+K, Ctrl/Cmd+Enter).
  Follow-up pass now standardizes shortcut microcopy (`.cli-shortcuts`) and adds
  focus-visible affordances (`.cli-panel-focusable`, stronger button/rail action
  focus rings) so keyboard navigation is clearer across core panels.
- **Misuse-resistant strategy workflow:** EV is now the headline metric, Strategy/Stats
  show path-dependence and entry-clustering diagnostics, agent tool output includes
  these warnings, and the persona is instructed to call out non-positive EV,
  path-dependent drawdowns, clustered entries, single-trade dominance, and the need
  for fresh-data validation. Event definitions are now first-class (`process.thesis`,
  `process.trigger`, `process.context`), regime context filters execute in the backtest,
  and forward outcome-label analysis now ships too (triple-barrier EV/CI vs. baselines via
  `engine/outcomes.ts` + `assess_outcomes`).

---

## 10. Background research

`docs/research/` holds the deep-dives that justify the design — read for rationale:
agent brain (01), universal providers (02), secure keys + cloud (03), statistical
toolkit (04), indicator library (05), catalog + roadmap (06), platform + correlation
engine vision (07), cloud backend plan (08), competitive teardown (09), quant
methodology (10), implementation plan (11), session handoff (12), productization (13),
**system-design coverage audit (14)** — ByteByteGo system-design-101 mapped onto
StratForge; flags the cross-cutting gaps (no VCS, no CI, no observability, payments +
web-security hardening). New cross-cutting risks from (14) belong in §8.
