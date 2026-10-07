# StratForge — Agent & Platform Research

Research foundation for building the four layers of the "agent brain" and the platform features around it. Written June 2026. Read this overview first, then the three deep-dive docs.

Status today: the agent (`apps/web/src/panels/AgentPanel.tsx`) is a stub with canned replies. No model, no tools, no knowledge layer. What exists and is solid: the strategy DSL (validated JSON, safe by construction), the backtest engine, and basic stats. This research is the blueprint for turning that foundation into a competent quant analyst.

## The three honest headlines

**1. Overfitting is the whole game.** With enough tweaking, any backtest looks brilliant; the probability of selecting an overfit strategy grows fast with the number of variants tried. The agent's credibility — and our users' actual results — depend on building anti-overfitting honesty into the core, not bolting it on. There is a concrete, well-established statistical battery for this (Deflated Sharpe Ratio, Combinatorial Purged Cross-Validation, Monte Carlo permutation tests). See [01-agent-brain.md](01-agent-brain.md).

**2. "Use the subscription they already pay for" is mostly a myth — with one real exception.** A ChatGPT Plus or Claude Pro subscription is *not* API access; those are billed separately per token. The exception, confirmed on Anthropic's support site: from **June 15, 2026**, Claude Pro/Max/Team/Enterprise plans get a monthly **Agent SDK credit** that explicitly covers *third-party apps that authenticate with the user's Claude subscription through the Agent SDK* (Pro $20, Max 5x $100, Max 20x $200/mo). So the design is: a **universal API-key layer** for every provider, **plus** provider-native subscription sign-in where it actually exists (Claude today). See [02-universal-providers.md](02-universal-providers.md).

**3. "Never seen by anyone, even in verification" = zero-knowledge encryption.** That is a specific, achievable architecture: keys are encrypted on the user's device and only ciphertext is ever stored or synced; the server (and we) literally cannot read them. Store locally in the OS keychain (note: Tauri's Stronghold plugin is being deprecated for v3 — don't build on it), and sync cross-device as an end-to-end-encrypted blob, the same way 1Password/Bitwarden work. See [03-secure-keys-cloud.md](03-secure-keys-cloud.md).

## Recommended build sequence

This matches the order you set:

1. **Agent brain (layers 1–3 + the engine work in 4).** The knowledge, the statistical robustness tools, the persona. This is the product's actual moat. Start here.
2. **Universal provider support.** Unified TypeScript layer + OpenAI-compatible custom endpoints + Claude subscription sign-in.
3. **Secure vault → login-synced keys → resellable cloud storage.** Ship local-encrypted first, add E2E cloud sync, then the storage business on top.

## Documents

- [01-agent-brain.md](01-agent-brain.md) — anti-overfitting doctrine, the statistical test battery, market regimes, the indicator/DSL/metrics roadmap, and a concrete analytical-persona spec.
- [04-statistical-toolkit.md](04-statistical-toolkit.md) — **deep dive:** the full statistics stack with formulas — performance/risk metrics, the significance & robustness battery (Sharpe CI, PSR, Deflated Sharpe, PBO, CPCV, Monte Carlo permutation, haircuts), time-series diagnostics, and position sizing. Implementable in TS.
- [05-indicator-library.md](05-indicator-library.md) — **deep dive:** the indicator universe, reference libraries to validate against, the flaw catalog (look-ahead, repainting, warm-up) with structural defenses, and the causality test harness that proves correctness.
- [02-universal-providers.md](02-universal-providers.md) — the API-key-vs-subscription reality per provider, and a unified multi-provider architecture for a TS-only app.
- [03-secure-keys-cloud.md](03-secure-keys-cloud.md) — zero-knowledge key vault, keyless/biometric unlock, E2E cloud sync, and the cloud-storage resale model.
- [06-catalog-and-roadmap.md](06-catalog-and-roadmap.md) — **the build backlog:** every statistical test and indicator (from the full platform spec), tagged by status, phase, and TS-feasibility, with honest scope flags (single-asset vs pairs, regression prerequisites, repaint risk) and a phased build order. Start here for "what do we build and in what order."
- [07-platform-and-correlation-engine.md](07-platform-and-correlation-engine.md) — **vision:** what makes StratForge the go-to for algo/power users (rigor, openness, execution realism, sweep-aware overfitting guards), and the architecture for the bring-your-own-factor correlation engine (oil↔dollar, births↔crops) with the anti-spurious-correlation rigor that turns a p-hacking trap into the brand.
- [09-competitive-quantpad.md](09-competitive-quantpad.md) — **competitive teardown:** QuantPad (launching 2026-06-26). Where we already lead (the robustness battery), the four gaps worth closing (regime analysis, feature→performance attribution, prop-firm pass/EV simulator, a graded robustness verdict), and what to deliberately *not* chase (their data/cloud-agent moat).
- [13-productization-plan.md](13-productization-plan.md) — **productization / GTM plan:** the path from current state to a secure, polished, monetized consumer platform — six readiness pillars (security, UX, features, reliability, monetization, market-intel), an M1→M4 milestone sequence, and a weekly competitive-research radar baked into the process.
- [14-system-design-coverage.md](14-system-design-coverage.md) — **system-design coverage audit:** maps the [ByteByteGo system-design-101](https://github.com/ByteByteGoHq/system-design-101) checklist onto StratForge (client app now + planned cloud backend), flagging real gaps with concrete actions. Top gaps today: no VCS, no CI, no observability, plus payments/web-security hardening. Start here for "are we covering all the bases?"
- [12-session-handoff.md](12-session-handoff.md) — **session handoff:** consolidated "what shipped (Phases 1, 2, 3b + fixes), what's missing (3a, 4, 5, 6 + roadmap), and how to resume." Start here after a session break.
- [11-implementation-plan.md](11-implementation-plan.md) — **the build plan:** six phased, file-level engineering tasks (buy-&-hold benchmark → outcome labels → regime filter + Markov MC → prop-firm → graded verdict → feature lab), each with engine module, agent/UI surfaces, smoke-test, and definition-of-done. Start here for "how do we build the next thing."
- [10-quant-methodology-deltatrend.md](10-quant-methodology-deltatrend.md) — **methodology harvest:** all 11 DeltaTrend (Thomas Skinner) YouTube videos distilled — the institutional workflow (feature-first → validate → attribute → deploy), the full feature taxonomy (maps onto our `process` DSL), event sampling + CUSUM, EV/path-dependence, the three Monte Carlo methods (incl. regime-switching via a Markov matrix), Markov steady states, prop-firm risk geometry, and two applied capstones. Ends with a **prioritized build order** that re-ranks the doc-09 gaps. Start here for "what does the methodology say we should build next."

## A standing caveat (bake it into the product)

Even with all of this built, a backtested edge is not a live edge. Our value is disciplined, transparent tooling that stops users from fooling themselves — not an AI that promises returns. Every surface should distinguish in-sample from out-of-sample, show regime-dependence, and refuse to celebrate untested results. That honesty is the brand.
