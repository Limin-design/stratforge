# 13 — Productization plan: StratForge → consumer-ready platform

> How we take the engine + analyst we've built to a secure, polished, monetized product for
> retail algo/strategy developers — ASAP, with continuous competitive research baked into the
> process. Complements the *feature* build plan ([[11-implementation-plan]]) and the cloud/
> security research ([[03-secure-keys-cloud]], [[08-cloud-backend-plan]]). Status: PROJECT_STATUS.md.

## Positioning (the wedge we defend)

**The honest quant terminal for retail algo developers.** Four moats, none of which the
competition (QuantPad, TradingView, NinjaTrader, QuantConnect, Composer) combine:
1. **Anti-overfit rigor as the brand** — deflated Sharpe, MC permutation, OOS/walk-forward,
   outcome-CI, regime attribution, buy-&-hold honesty. We tell users when their edge is fake.
2. **Local-first + bring-your-own-key privacy** — your data and model key never leave your
   device unless you opt into E2E-encrypted sync.
3. **Typed, safe-for-AI DSL** — strategies are validated JSON, so the analyst can author them
   without arbitrary code execution.
4. **A blunt, analytical AI quant** — multi-provider, tool-driven, never sycophantic.

## What "consumer-ready" means — six readiness pillars

| Pillar | Bar to clear |
|---|---|
| **Security & privacy** | Auth, E2E key vault sync, RLS, no secret leakage, CSP/headers, dep audit, security review |
| **UX polish ("sexy")** | First-run onboarding, design system, light+dark, non-blocking heavy compute, premium chart/strategy/stats workbenches |
| **Feature completeness** | Everything an algo dev needs: data → author → validate → optimize → (paper) deploy → collaborate |
| **Reliability/perf** | CI (typecheck+smokes+build), broader tests, error telemetry, 250k-bar smoothness |
| **Monetization** | Free / Pro / Team tiers, Stripe, usage metering, optional data resale |
| **Continuous market intel** | A recurring radar that tells us what to build next, better than competitors |

## Milestone sequence (ASAP, solo-dev-scoped)

> Ruthless scoping: lean on the existing dependency-free, local-first ethos to keep infra tiny.
> The Phase 3a→6 feature work (doc 11) runs in parallel and feeds M1.

**M1 — Functional core complete.** Finish the engine/analyst feature set: Phase 3a (regime entry
filter) → 4 (prop-firm) → 5 (graded verdict) → 6 (feature lab). Persist data-source keys in the
vault. JSON/tick importers. *Exit: a developer can go data → idea → validated strategy end-to-end.*

**M2 — Beta-hardened (security + deploy).** Deploy the cloud backend (Supabase + RLS + Stripe + R2
per doc 08); Google/Apple auth; **E2E-encrypted vault & layout sync** (doc 03); move Monte Carlo +
optimization into **Web Workers** so the UI never blocks; CI pipeline; first-run **onboarding**
(sample dataset + sample strategy + guided "read the verdict"); run the **/security-review** skill.
*Exit: invite-only beta, safe to hand strangers a login.*

**M3 — Sexy + monetized public beta.** Design-system pass (tokens exist in `theme.css`; add a
refined default + **light mode**, consistent type/spacing/motion, empty states, tooltips);
**landing page** + brand (finalize the name — "StratForge" is a working title); Stripe **tiers
live**; **community v1** (publish/clone strategies, profiles) differentiated by sharing only
*validated, regime-tagged* strategies. *Exit: open signups, paid plans.*

**M4 — GA.** Signed **desktop** build (unblock MSVC Build Tools, then code-sign); **paper/live
deploy** connectors (broker / prop-firm APIs); **mobile** via Tauri iOS; **data partnerships**
(affiliate/resale, doc 08 Phase 3). *Exit: 1.0.*

**Continuous from M1:** the market-radar routine (below) runs weekly and reprioritizes the backlog.

## Pillar detail (concrete workstreams)

### Security & privacy
- **Deploy the cloud backend** (scaffold exists in `cloud/`, not deployed): Supabase auth + Postgres
  with **row-level security** on every table; R2 for blobs; Stripe webhooks server-side only.
- **Zero-knowledge vault → E2E cloud sync**: local encryption already shipped (Web Crypto, PBKDF2 +
  AES-GCM, passphrase never stored). Sync only ciphertext. Use the OS keychain on desktop — **not**
  Tauri Stronghold (deprecated, doc 03). Exchange/data keys stay in-memory; AI key vaulted.
- **No secret leakage** — audit logs/telemetry; CSP + secure headers + SRI; HTTPS only; `pnpm audit`
  in CI; keep the dependency-free ethos (small supply-chain surface).
- **Abuse control** — rate-limit any server endpoints (auth, data proxy); captcha on signup.
- **Security review** before each public milestone (the `/security-review` skill); 3rd-party pen
  test before GA. Code-sign the desktop binary.

### UX polish ("sexy")
- **Onboarding**: 60-second first-run — load a bundled dataset, run a sample strategy, land on the
  Stats verdict with callouts. Empty states everywhere; inline tooltips on the rigor metrics.
- **Design system**: refine the Slate palette into a premium default + a light theme; consistent
  spacing/typography scale; subtle motion; polished `kpi`/`cli` components already in use.
- **Workbench polish**: Chart (drawing tools + indicators are solid — make them feel TradingView-
  grade), Strategy builder (lead users through trigger→context→outcome), Stats (the verdict +
  benchmark + outcome/regime boxes are the "wow" — make them the centerpiece).
- **Never block the UI**: run Monte Carlo / optimization / outcome bootstraps in **Web Workers**;
  keep the 250k-bar cap smooth; virtualize long lists.
- **Accessibility/perf**: focus rings exist; add ARIA + contrast checks; Lighthouse budget.

### Feature completeness (for algo developers)
- **Author**: finish 3a–6; add **multi-timeframe + stateful DSL** (the real expressiveness gaps —
  Powell-style strategies need a bias state machine across 1d/5m/1m); strategy templates/presets.
- **Data**: persist keys in vault; JSON klines + tick→bar aggregator; more vendors as demanded.
- **Validate/optimize**: battery + verdict + prop-firm + feature lab (doc 11); multiple-testing
  guard already wired.
- **AI analyst**: add provider-native **subscription sign-in** where it exists (Claude Agent SDK
  credit, doc 02) alongside BYO-key.
- **Collaborate**: community publish/clone (M3); export results (CSV/JSON). *Pine Script export
  stays out unless demand says otherwise (let the radar decide).*
- **Deploy**: paper-trading first, then broker/prop-firm live connectors (M4).

### Reliability
- **CI** (GitHub Actions): `pnpm -r typecheck` + all engine/web smokes + `vite build` on every PR.
- Broaden tests: Playwright e2e for the core flow; keep the pure-engine smoke discipline.
- Opt-in crash/telemetry (privacy-respecting), behind the same consent as cloud sync.

### Monetization
- **Free**: fully local, BYO-key, full engine. **Pro**: cloud sync, hosted data quota, community.
  **Team**: shared workspaces. Stripe + the existing `usage.ts` meter. Optional **data resale**
  (doc 08) once partnerships land.

## Continuous competitive intelligence — the "always be searching" loop

A standing **market-radar routine** so we build what people actually want, better than rivals.

**Cadence:** weekly during active build (a cloud `/schedule` routine so it survives sessions).

**Each run:**
1. **Scan demand** — Reddit (r/algotrading, r/quant), Discord/X/YouTube comments, app reviews:
   what features are people asking for, what are they frustrated by? (WebSearch + the `watch`
   skill for competitor video content, as we did for QuantPad.)
2. **Scan competitors** — changelogs/launches of QuantPad, TradingView, NinjaTrader, QuantConnect,
   Composer, etc.: what shipped, what's the gap.
3. **Synthesize** — append a dated entry to a living `docs/research/MARKET-RADAR.md`: top requested
   features, competitor moves, and for each a **"how we do it better"** note tied to our four moats
   (rigor / privacy / safe-DSL / honest-AI).
4. **Triage** — fold the highest-signal items into the doc-11 backlog with a priority + rationale,
   so the next build increment reflects live demand, not just our prior plan.

**Guardrail:** every candidate feature must pass "does it strengthen a moat or close a must-have
gap?" — we don't chase parity features that dilute the honest-rigor positioning (e.g. we still skip
all-you-can-eat data infra and a code-writing cloud agent).

*To instantiate:* run `/schedule` for a weekly cloud agent with the routine above (kept separate
from the in-session build `/loop`, which is session-bound).

## Risks & dependencies
- **MSVC Build Tools** not installed → desktop build blocked (web path works for everything else).
- **CORS** for some hosted LLM/data providers → desktop build or a Vite dev proxy.
- **Solo developer** → scope hard; prefer features that compound the moats; the radar prevents
  building the wrong thing.

## North-star sequencing summary
M1 functional core → M2 secure beta → M3 sexy + paid public beta → M4 GA, with the market-radar
running weekly throughout to keep the backlog honest and ahead of competitors.
