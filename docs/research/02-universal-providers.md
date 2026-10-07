# 02 — Universal AI Provider Support

Goal: let a user plug in *any* AI provider so the app rides on what they already have. This is achievable, but one assumption needs correcting up front, because it changes the design.

---

## 1. The reality: subscription ≠ API (with one exception)

A consumer **subscription** (ChatGPT Plus, Claude Pro, Gemini Advanced) generally only works inside that vendor's *own* apps. It is **not** the same as **API access**, which is a separate account billed pay-as-you-go per token. A third-party app like ours normally cannot ride on someone's ChatGPT Plus plan — it needs an API key.

**The one real exception today (verified, Anthropic support):** starting **June 15, 2026**, Claude **Pro / Max / Team / Enterprise** plans receive a monthly **Agent SDK credit** that explicitly covers *"third-party apps that authenticate with your Claude subscription through the Agent SDK."* Amounts: Pro $20, Max 5x $100, Max 20x $200 per month, per user, refreshing each cycle, drains before pay-as-you-go. This is exactly the "use the plan you already pay for" experience — but only for Claude, capped at the credit, and routed through the Agent SDK's subscription auth (OAuth-style sign-in), not an API key.

**Design consequence:** build two parallel on-ramps.

- **On-ramp A — API key (universal).** Works for every provider. The baseline.
- **On-ramp B — subscription sign-in (where it exists).** Claude today via Agent SDK auth. Add others if/when they offer equivalent programmatic-subscription access. Market this as the "no API key, just log in with the plan you have" path — it's the most alluring, and right now Claude is the one that delivers it.

Be honest in the UI about which is which, and about token costs on the API path. Users discovering mid-strategy that "free" calls are billing their card is the fastest way to lose trust.

---

## 2. The unified layer (TypeScript-native)

Don't hand-roll an adapter per provider. Three mature options, all of which collapse "every provider" into one interface:

**Vercel AI SDK — recommended as the in-app core.** TypeScript-first (built for Node/React/Svelte/Vue), which fits the TS-only stack exactly. One unified API across 16+ providers and 100+ models (OpenAI, Anthropic, Google, Mistral, Meta, xAI, DeepSeek, Cohere, Perplexity, Amazon Bedrock, Alibaba, and more), with first-class **tool calling**, **streaming**, **structured object generation**, **agent primitives**, and **built-in fallbacks**. Define the agent's tools once; the SDK normalizes the provider differences.

**OpenAI-compatible endpoint field — the "every provider on earth" lever.** Most providers, and both gateways below, expose an OpenAI-compatible REST API. If the settings screen has a "custom base URL + key" option, a single adapter instantly covers hundreds of providers and self-hosted models. This is the cheapest way to claim universality.

**A gateway, for breadth without per-provider setup:**
- **OpenRouter** — managed SaaS gateway; one key, one endpoint, ~341 text models (plus image/embedding/audio) as of June 2026. Zero infra. Best for "one key for everything." Takes a small margin.
- **LiteLLM** — open-source, self-hostable, single OpenAI-compatible interface across 100+ providers, with routing, fallbacks, budgets, logging. Best if you want control and no third-party margin. Many teams run both (LiteLLM for governance, OpenRouter for reach).

---

## 3. Recommended architecture

```
Agent core (tools defined once: proposeStrategy, runBacktest, validateRobustness, detectRegime, …)
        │
   Vercel AI SDK  ── unified tool-calling / streaming / structured output
        │
   ┌────┴───────────────────────────────────────────────┐
   │ Provider resolver (per user, from secure settings)   │
   ├──────────────────────────────────────────────────────┤
   │ A. Direct API key:  OpenAI · Anthropic · Google · …  │
   │ B. OpenAI-compatible custom endpoint (base URL+key)  │  → self-host / LiteLLM / niche providers
   │ C. Gateway: OpenRouter (one key → 300+ models)       │
   │ D. Subscription sign-in: Claude Agent SDK (OAuth)    │  → uses the monthly Agent SDK credit
   └──────────────────────────────────────────────────────┘
```

Settings UX per user: **pick provider → choose "API key", "custom endpoint", or "sign in with subscription"** (the last shown only for providers that support it, Claude today). Store the credential via the secure vault in [03-secure-keys-cloud.md](03-secure-keys-cloud.md). Show a live token-usage / cost meter on the API paths.

### v1 cut

Vercel AI SDK + (A) direct keys for the big three + (B) the OpenAI-compatible custom-endpoint field. That already covers the overwhelming majority of providers on day one. Add (C) OpenRouter as a one-click "use one key for everything" convenience, and (D) Claude subscription sign-in as the headline "no API key needed" feature, right after.

### Cross-provider gotchas the SDK mostly handles, but watch

- **Tool-calling formats** differ (OpenAI tools vs Anthropic tool-use vs Gemini function-calling). The AI SDK normalizes these — define tools once. Test each provider's tool path anyway.
- **Structured output / JSON-mode** reliability varies by model; keep Zod validation on every `StrategySpec` the model emits (you already do).
- **Context windows and pricing** vary wildly; surface model choice and cost to the user.
- **Streaming** semantics differ; the SDK abstracts them.

---

## Sources

- Vercel AI SDK — providers, tool calling, gateway — https://ai-sdk.dev/docs/introduction ; https://ai-sdk.dev/providers/ai-sdk-providers/ai-gateway ; https://github.com/vercel/ai ; https://vercel.com/docs/ai-gateway/models-and-providers
- OpenRouter vs LiteLLM (2026) — https://www.truefoundry.com/blog/litellm-vs-openrouter ; https://deploybase.ai/articles/best-llm-gateway-and-router-tools-litellm-vs-openrouter ; https://inworld.ai/resources/best-llm-router-ai-gateway
- Claude subscription / API distinction & Agent SDK credit — https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan ; https://aionx.co/claude-ai-reviews/claude-pro-api-access/ ; https://automationatlas.io/answers/claude-code-pricing-explained-2026/
