# 14 — System-Design Coverage Audit

> **Source guide:** [ByteByteGo / system-design-101](https://github.com/ByteByteGoHq/system-design-101)
> (visual catalog of system-design topics). It is reference material, not code — its
> value here is as a **checklist** to make sure StratForge's architecture "covers all
> the bases." This doc maps each relevant category onto what StratForge has today and
> what the planned cloud backend ([08-cloud-backend-plan.md](08-cloud-backend-plan.md))
> must add, and flags the real gaps with a concrete next action.

_Created 2026-06-28. Keep current as the cloud backend lands._

## How to read this

StratForge is two systems with very different surface area:

- **Client app (now):** a TS/React app (browser + Tauri) that talks directly to exchanges,
  data vendors, and LLM providers from the user's machine. Most "distributed systems"
  topics (sharding, message queues, service mesh) **do not apply** and saying so explicitly
  is part of covering the bases.
- **Cloud backend (planned):** Supabase (Postgres + Auth + RLS + Edge Functions) + Stripe
  + R2. This is where auth, data, payments, and ops topics become real.

Status legend: ✅ covered · 🟡 partial / needs hardening · 🔴 gap to close · ⚪ deliberately
out of scope (with reason).

---

## Top gaps to close first (the actionable shortlist)

Ordered by risk for a product that holds API keys and is about to take money.
**Items 1, 2 and the XSS half of 5 were done on 2026-06-28** — see "What was done in this pass".

1. **✅ DONE — version control.** Repo initialized; first commit `3bef51b` (123 files, no
   `node_modules`). Add a private remote when ready (`git remote add origin …`).
2. **✅ DONE — CI.** [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) runs
   `pnpm -r typecheck` + the engine & web `smoke` suites + `pnpm --filter @stratforge/web build`
   on push/PR. Verified green locally end-to-end. (Building this surfaced that `tsc` was
   already broken — see the pass notes.)
3. **🟡 PARTIAL — observability / error tracking.** **Client side DONE (2026-06-28):** a
   privacy-first, dependency-free error tracker (`telemetry/`) captures uncaught errors, promise
   rejections, and panel crashes, **scrubs every event** for secrets/PII before it is stored or
   shown, keeps a bounded on-device buffer (surfaced in Profile → Diagnostics), and exposes a
   pluggable sink that is **off by default** (nothing leaves the device). **Still open:** wire the
   sink to a Supabase Edge Function once the backend exists, and add structured Edge-Function logs
   that never include secrets.
4. **🟡 OPEN — payments hardening (before the first charge).** Stripe webhook must verify
   signature **and** be idempotent (replay-safe), with subscription state reconciled to
   `subscriptions`/`profiles`. Decide PCI posture explicitly: use Stripe-hosted Checkout so
   you stay SAQ-A and never touch card data. Plan EU VAT (Stripe Tax) and failed-payment
   dunning. **Action:** spec these into Phase C before going live.
5. **🟡 PARTIAL — web app hardening.** **XSS: verified clean** — no `dangerouslySetInnerHTML`,
   `innerHTML`, `eval`, or `new Function` anywhere in `apps/web/src`; React auto-escapes all
   rendered text (CSV/dataset/strategy names, agent output). **Still open:** add a
   Content-Security-Policy + standard security headers at the host/Tauri layer as defence in
   depth. **Action:** CSP on the host config.

---

## What was done in this pass (2026-06-28)

Verified findings and fixes from acting on the shortlist + the app-improvement review:

- **Version control + CI** shipped (shortlist 1–2).
- **The build was already broken.** `tsc --noEmit` failed with **7 pre-existing type errors**
  (`strategyBuilder.ts`, `StrategyPanel.tsx`) — a discriminated-union narrowing bug where the
  regime-vs-comparison condition union wasn't narrowed in the `else` branch. Since Vite dev
  doesn't typecheck and nothing ran `tsc`, the project's own `build` script (`tsc && vite build`)
  had been silently failing. Fixed with an `isRegimeCond` type guard; all packages now typecheck.
- **A smoke test had been silently failing.** `strategy-optimize-smoke.ts` used a `Builder`
  fixture missing the `event` field added later — it threw the moment it ran. It wasn't caught
  because `scripts/` is outside the `tsc` include and nothing ran the suite. Fixture updated;
  full suite green. **This is the concrete cost of no CI** — now closed.
- **Vault crypto is now regression-locked.** New `smoke:vault` proves round-trip, wrong-passphrase
  rejection, tamper rejection, non-determinism (fresh salt+iv), and no-plaintext-leak. The
  crown-jewel "keys never seen" path was previously the *least*-tested code; it now has a test.
- **XSS surface verified clean** (shortlist 5, first half).
- **Client error tracking shipped** (`telemetry/scrub.ts` + `telemetry/errorTracker.ts`). Captures
  uncaught errors / rejections / panel crashes; **scrubs secrets + PII** (API keys, Bearer/JWT,
  api-key query+JSON values, vault-ciphertext-shaped blobs, emails, and OS-username file paths)
  before anything is stored, shown, or forwarded; bounded on-device buffer shown in
  Profile → Diagnostics; pluggable sink off by default. The scrubber is tested like the vault
  (`smoke:scrub`, end-to-end no-leak assertion).
- **Usage meter fixed.** It under-reported **both** tokens and request count — `recordTokens`
  (which also increments `requests`) only fired when the provider returned a `usage` block. Now
  every request is counted, and when `usage` is absent an honest local estimate is recorded and
  **flagged as estimated** in the Profile panel (no silent under-reporting, no silent overstatement).
- **Noted, not changed:** the LLM client does **not** stream (`res.json()`, blocking) — a UX gap,
  not a correctness bug.

- **Heavy persistence moved off localStorage → IndexedDB (DONE).** `chats.ts` now keeps an
  in-memory cache as the synchronous source of truth (public API unchanged), backs it with
  IndexedDB for full fidelity (`idbStore.ts` — a dependency-free async k/v that degrades
  gracefully when IDB is unavailable), and keeps only a *compacted* localStorage copy for fast
  first paint + fallback. On boot it hydrates from localStorage, then merges in the IDB copy with
  no session loss (`mergeChatsById`: newer-by-`updatedAt` wins, ties favour the fuller IDB copy);
  first run migrates the existing localStorage history into IDB and reclaims quota. A debounced
  write + flush-on-tab-hide avoids losing the last edit. The data-integrity logic is covered by
  `smoke:chats`; the raw IDB I/O is typecheck + defensive-wrapper verified but **not yet
  browser-runtime verified** — do one manual click-through (create chats → reload → confirm
  history + reopen) before relying on it.

Still open and deliberately *not* rushed in this pass (would violate "small, verifiable, don't
destabilize" — §3.10):

- **Live provider tests** (Twelve Data, Polygon, Azure) are **blocked on real API keys** — only the
  owner can run them. The doc-driven `data-sources` shape smoke exists and passes; live runs must be
  done once with real keys and captured as fixtures.
- **Multi-timeframe + stateful DSL** (the §9 expressiveness gaps) are a real architectural change,
  not a hardening task. Tracked in the roadmap; out of scope for an audit-response pass.

---

## Coverage by category

### Communication / protocols (HTTP, WebSocket, gRPC, SSE, webhooks)
- ✅ REST over HTTPS for all outbound calls (exchanges, vendors, LLM providers) via `fetch`
  / `tauri-plugin-http`.
- 🟡 **LLM streaming (SSE).** Confirm `agent/llmClient.ts` streams tokens vs. blocking; a
  per-request timeout guard exists, which is the important reliability piece.
- ✅ **Webhooks** are correctly chosen for Stripe (inbound billing events).
- ⚪ **gRPC / service-to-service** — N/A; no internal service mesh.
- ⚪ **WebSocket live price streaming** — out of scope by decision (no tick/L2 data; §9).
  Revisit only if real-time quotes become a feature.

### API design (versioning, idempotency, pagination, rate limiting, errors)
- ✅ Consumes vendor REST with response-shape checks, timeouts, retries, rate-limit messages
  (§8 data-import notes).
- 🟡 **Own API = Supabase RLS tables + 3 Edge Functions.** Idempotency matters for
  `stripe-webhook` (replay) and `storage-sign`. **Action:** idempotency keys + signature
  verification on the webhook.
- ✅ Rate-limiting signed-URL minting is already called out in the cloud plan.
- ⚪ Pagination — N/A at single-user data volumes (250k-bar client cap).

### Caching & performance (CDN, cache strategy, invalidation)
- 🟡 Client uses `localStorage` as cache (layout, chats, chart micro-state) and caps to 250k
  bars; quota pressure is acknowledged (§8). Cloud sync is the real fix.
- 🔴 **No CDN / cache strategy decided for the web bundle or for R2 dataset reads.**
  **Action:** serve the web app from a CDN (host default is fine) and add conditional/ETag
  fetching against vendors to cut quota burn; cache R2 dataset objects.
- ⚪ Redis / distributed cache — N/A at this scale.

### Data & databases (SQL/NoSQL, indexing, replication, consistency, CAP)
- ✅ Postgres (Supabase) with **RLS owner-only on every table** — the right default.
- ✅ Consistency model is chosen and documented: offline-first, **last-write-wins by
  `updated_at`** (acceptable for single-user-multi-device).
- 🟡 **Indexing + backups not yet specified.** **Action:** index `(user_id, updated_at)`
  per table; confirm Supabase PITR/backups are on before storing real user data.
- ⚪ Sharding / partitioning / multi-region — N/A; revisit only at scale.

### Architecture style
- ✅ Appropriate: **client-heavy app + serverless Edge Functions**, secrets server-side.
  Document this as the deliberate choice — microservices/event-driven are ⚪ N/A.

### Scalability & reliability (LB, failover, retries, timeouts, circuit breaker, backpressure)
- ✅ Timeouts on LLM calls; retries on vendor calls; per-workspace async race-guarding (§8).
- ✅ Managed scaling/failover via Supabase + R2 + the web host.
- ⚪ Load balancers / circuit breakers — N/A (managed platform).
- 🟡 **Abuse / cost control:** rate-limit signed URLs and cap free-tier upload abuse (already
  noted in the plan) — make sure it ships with Phase C, not after.

### Security (authN/Z, OAuth, JWT, secrets, encryption, OWASP, CORS, CSP) — strongest area
- ✅ **Zero-knowledge vault** (Argon2id/PBKDF2 → AES-GCM), masked keys, secrets never logged,
  exchange/data keys in-memory only. This is genuinely ahead of most apps.
- ✅ RLS everywhere; opaque `vaults.ciphertext` is the zero-knowledge guarantee.
- ✅ CORS posture understood (Azure needs the Tauri/desktop path; documented in §7).
- 🟡 **Auth flow** (Supabase Google/Apple OAuth, JWT refresh/expiry) — implement and test the
  session lifecycle; today CloudPanel is a stub.
- 🟡 **Zero-knowledge recovery** — a lost passphrase = unrecoverable vault. Ship the one-time
  recovery code at signup and say so loudly (already a noted risk).
- 🟡 **Web-app OWASP:** **XSS verified clean (2026-06-28)** — no raw HTML injection sink anywhere
  in `apps/web/src`; React escapes all rendered text (CSV headers, dataset/strategy names,
  **agent output**). Still to add: CSP + security headers as defence in depth. Dependency-free
  design already shrinks supply-chain surface — keep it.
- 🟡 **Prompt-injection surface:** market data, CSV content, and strategy names flow into the
  LLM. Tools are deterministic and the engine never trusts model math, which limits blast
  radius — but treat model output as untrusted when rendering (ties to the XSS sweep).
- ✅ **GDPR:** account-delete cascade + data-export from day one is already in the plan (EU user).

### Payments / fintech (Stripe, idempotency, reconciliation, PCI, tax)
- 🟡 Stripe is chosen; plans/quotas defined. Before the first live charge, close:
  webhook **signature verification + idempotency**, subscription-state **reconciliation**,
  **PCI = SAQ-A** via hosted Checkout (never touch card data), **EU VAT** (Stripe Tax), and
  **dunning** for failed payments. **Action:** fold into the Phase C spec.

### DevOps & CI/CD
- 🔴 **No pipeline.** See shortlist #2. Add typecheck + smoke + build on PR; deploy Edge
  Functions and the web app from CI, not by hand.
- ⚪ Blue-green / canary — overkill now; managed-platform rollbacks suffice.

### Observability (logging, metrics, tracing, error tracking, alerting)
- 🟡 **Client error tracking DONE** (secret/PII-scrubbed, on-device, Profile → Diagnostics; see
  shortlist #3). **Still open:** Edge-Function structured logs (no secrets) and a basic alert on
  webhook/auth failures — both land with the cloud backend.

### Computer fundamentals / "how it works" (DNS, TLS, HTTPS)
- ⚪ Handled by the hosting platform and the browser; nothing to build. TLS everywhere is a
  given (HTTPS-only).

---

## Deliberately out of scope (considered and declined)

So the "we covered the bases" claim is honest, these are conscious N/As — not oversights:
message queues, gRPC/service mesh, microservices, DB sharding/partitioning, multi-region,
WebSocket/L2 tick streaming, distributed cache (Redis), and a code-writing cloud agent
(see §9 and `docs/research/09`). Revisit any of these only when a specific feature or scale
demands it.

---

## Wiring back into the project

- The five shortlist items above are the concrete additions; #1 and #2 (git + CI) are
  immediate and independent of the cloud work.
- Security/payments/data/observability items should be folded into the
  [08 cloud-backend-plan](08-cloud-backend-plan.md) phases (A: auth+sync, B: vault sync,
  C: storage+billing) so they ship with the feature, not after.
- Mirror anything that becomes a tracked risk into `PROJECT_STATUS.md` §8.
