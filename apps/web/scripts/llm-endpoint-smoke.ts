/**
 * Smoke test for resolveChatEndpoint — the LLM base-URL → chat-completions resolver.
 * Run with: pnpm --filter @stratforge/web smoke:llm-endpoint
 */
import { resolveChatEndpoint } from "../src/agent/llmClient.js";

const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error("FAIL:", msg);
    throw new Error(msg);
  }
};
const eq = (got: string, want: string, label: string) => assert(got === want, `${label}: got "${got}", want "${want}"`);

// Generic OpenAI-compatible providers — not Azure, just append /chat/completions.
let r = resolveChatEndpoint("https://openrouter.ai/api/v1");
assert(!r.isAzure, "openrouter not azure");
eq(r.url, "https://openrouter.ai/api/v1/chat/completions", "openrouter");

eq(resolveChatEndpoint("https://api.openai.com/v1/").url, "https://api.openai.com/v1/chat/completions", "openai trailing slash trimmed");

// Classic Azure OpenAI (deployments) — api-key, dated GA version.
r = resolveChatEndpoint("https://my-res.openai.azure.com/openai/deployments/gpt4");
assert(r.isAzure, "classic azure detected");
eq(r.url, "https://my-res.openai.azure.com/openai/deployments/gpt4/chat/completions?api-version=2024-10-21", "classic azure");

// New Azure OpenAI v1 surface — api-version=preview.
eq(
  resolveChatEndpoint("https://my-res.openai.azure.com/openai/v1").url,
  "https://my-res.openai.azure.com/openai/v1/chat/completions?api-version=preview",
  "azure v1"
);

// Azure AI Foundry model-inference surface (the user's case) — detected, no double-append, version preserved.
r = resolveChatEndpoint("https://video-logic-engine.services.ai.azure.com/models/chat/completions?api-version=2024-05-01-preview");
assert(r.isAzure, "foundry detected as azure");
eq(
  r.url,
  "https://video-logic-engine.services.ai.azure.com/models/chat/completions?api-version=2024-05-01-preview",
  "foundry preserves explicit version, no double /chat/completions"
);

// Foundry without an explicit version → sensible fallback.
eq(
  resolveChatEndpoint("https://x.services.ai.azure.com/models/chat/completions").url,
  "https://x.services.ai.azure.com/models/chat/completions?api-version=2024-05-01-preview",
  "foundry version fallback (already has /chat/completions)"
);
// Foundry base without /chat/completions → append exactly once.
eq(
  resolveChatEndpoint("https://x.services.ai.azure.com/models").url,
  "https://x.services.ai.azure.com/models/chat/completions?api-version=2024-05-01-preview",
  "foundry appends /chat/completions once"
);

console.log("=== resolveChatEndpoint smoke ===");
console.log("All LLM endpoint smoke checks passed.");
